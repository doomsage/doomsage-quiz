// POST /api/convert - converts an exam paper PDF (+ optional answer key / hint sheet)
// into a structured quiz set using Gemini multimodal extraction.
// Body: { files: [{ name: string, kind: "paper"|"key", data: base64pdf }] }
// Returns: { ok: true, set: {...} } or { ok: false, error: "..." }

const MAX_RAW_BYTES = 3.2 * 1024 * 1024; // ~4.3MB base64, under Vercel's 4.5MB body cap
const MODEL = "gemini-2.5-flash";

// best-effort per-IP throttle (resets when the instance does)
const hits = new Map();
function throttled(ip) {
  const now = Date.now();
  const rec = hits.get(ip) || { n: 0, t: now };
  if (now - rec.t > 3600e3) { rec.n = 0; rec.t = now; }
  rec.n++; hits.set(ip, rec);
  return rec.n > 12;
}

const PROMPT = `You are converting exam paper PDFs into a structured quiz. The PDFs are an Indian JEE-style coaching test (subjects: Physics, Chemistry, Mathematics). One file is usually the question paper; another may be the answer key and/or hint (solutions) sheet.

TASK: extract EVERY question from the question paper, in printed order, and segment precisely where each question starts and ends. For each question output:
- num: question number as printed (string)
- subject: "Physics", "Chemistry" or "Mathematics" (infer from section headings; if unknown use "General")
- type: "mcq" (options A-D, one correct) or "numeric" (answer is a number, no options)
- q: the complete question text, clean and self-contained. ALL math must be LaTeX: inline $...$, display $$...$$. Do not omit conditions, data or units. If the question relies on a diagram/figure/graph/circuit, set figure=true and end q with "[See figure on original page N]".
- options: for mcq, exactly 4 strings, options A-D in order, math in LaTeX. For numeric, null.
- answer_index: for mcq, 0-3 (0=A). For numeric, null.
- answer_value: for numeric, the answer as a plain number string (e.g. "3.00"). For mcq, null.
- explain: a clear step-by-step explanation in 2-6 sentences, teaching style, LaTeX for math. If a hint/solutions sheet is provided, base this on it (cleaned up); otherwise solve the question yourself.
- page: 1-based page number of the question-paper file where this question appears.
- figure: true only if the question genuinely needs a diagram.

ANSWERS: use the answer key tables (grids of Q./A. rows) and/or solutions sheet when present. When the key is a single letter for an mcq, map A->0, B->1, C->2, D->3. If no key is provided, solve each question yourself as a JEE expert; never leave an answer null.

Also output:
- paper_found: false if none of the files contains actual questions (e.g. only an answer key or solutions sheet was uploaded). In that case questions must be [] and note must explain what was found.
- title: short paper title, e.g. "ALLEN Part Test - 06 Nov 2026", or null.

Output only JSON matching the schema.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    paper_found: { type: "BOOLEAN" },
    title: { type: "STRING", nullable: true },
    note: { type: "STRING", nullable: true },
    questions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          num: { type: "STRING" },
          subject: { type: "STRING" },
          type: { type: "STRING" },
          q: { type: "STRING" },
          options: { type: "ARRAY", items: { type: "STRING" }, nullable: true },
          answer_index: { type: "INTEGER", nullable: true },
          answer_value: { type: "STRING", nullable: true },
          explain: { type: "STRING" },
          page: { type: "INTEGER", nullable: true },
          figure: { type: "BOOLEAN", nullable: true }
        },
        required: ["num", "subject", "type", "q", "explain"]
      }
    }
  },
  required: ["paper_found", "questions"]
};

function normalize(raw) {
  const out = [];
  for (const q of raw.questions || []) {
    if (!q || !q.q) continue;
    const subj = /phys/i.test(q.subject) ? "Physics" : /chem/i.test(q.subject) ? "Chemistry" : /math/i.test(q.subject) ? "Mathematics" : (q.subject || "General");
    const badge = `${subj} - Q${q.num}`;
    const base = { badge, q: String(q.q), explain: String(q.explain || ""), page: q.page || null, figure: !!q.figure };
    if (q.type === "mcq" && Array.isArray(q.options) && q.options.length >= 2) {
      const opts = q.options.slice(0, 4).map(String);
      let a = q.answer_index;
      if (typeof a !== "number" || a < 0 || a >= opts.length) a = 0;
      out.push({ ...base, options: opts, answer: a });
    } else {
      const v = q.answer_value != null ? String(q.answer_value).trim() : "";
      if (!v) continue; // unusable numeric question
      out.push({ ...base, numeric: true, answer_value: v });
    }
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ ok: false, error: "Converter is not configured yet. Try again later." });

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0] || "unknown";
  if (throttled(ip)) return res.status(429).json({ ok: false, error: "Too many conversions from this connection. Wait an hour and retry." });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  const files = body && Array.isArray(body.files) ? body.files.slice(0, 2) : [];
  if (!files.length) return res.status(400).json({ ok: false, error: "No PDF received." });

  const parts = [];
  let total = 0;
  for (const f of files) {
    if (!f || !f.data) continue;
    const bytes = Buffer.from(f.data, "base64");
    total += bytes.length;
    if (total > MAX_RAW_BYTES) return res.status(413).json({ ok: false, error: "PDF is too large for the free converter (over ~3 MB). Split it into smaller PDFs and try again." });
    parts.push({ inline_data: { mime_type: "application/pdf", data: f.data } });
  }
  if (!parts.length) return res.status(400).json({ ok: false, error: "No PDF received." });
  parts.push({ text: PROMPT });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 52000); // stay inside the 60s function cap
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      signal: ctrl.signal,
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: SCHEMA,
          temperature: 0.2,
          maxOutputTokens: 60000
        }
      })
    });
    clearTimeout(timer);
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      const msg = (j && j.error && j.error.message) || `Gemini error ${r.status}`;
      const nice = r.status === 429 ? "The free AI quota is busy right now. Wait a minute and retry." : msg;
      return res.status(r.status === 429 ? 429 : 502).json({ ok: false, error: nice });
    }
    let parsed = null;
    try { parsed = JSON.parse(j.candidates[0].content.parts.map(p => p.text || "").join("")); }
    catch { return res.status(502).json({ ok: false, error: "The AI reply was unreadable. Try again." }); }

    if (!parsed.paper_found) {
      return res.status(200).json({ ok: false, no_paper: true, error: parsed.note || "This PDF looks like an answer key / solutions sheet, not a question paper. Upload the question paper PDF (you can add the key PDF as the second file)." });
    }
    const questions = normalize(parsed);
    if (!questions.length) return res.status(200).json({ ok: false, error: "No questions could be read from this PDF. Is it the question paper?" });

    const subs = [...new Set(questions.map(q => q.badge.split(" - ")[0]))];
    return res.status(200).json({
      ok: true,
      set: {
        id: "paper-" + Date.now().toString(36),
        title: parsed.title || "My paper",
        subtitle: subs.join(" + "),
        latex: true,
        count: questions.length,
        questions
      }
    });
  } catch (e) {
    clearTimeout(timer);
    const msg = e.name === "AbortError"
      ? "This paper took too long to read. Split it into fewer pages and try again."
      : "Conversion failed: " + (e.message || e);
    return res.status(504).json({ ok: false, error: msg });
  }
}

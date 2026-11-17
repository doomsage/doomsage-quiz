const V='dq-v1';
const SHELL=['./','index.html','convert.html','catalog.json'];
const K='https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/';
const CDN=[K+'katex.min.css',K+'katex.min.js',K+'contrib/auto-render.min.js','https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js','https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'];
self.addEventListener('install',e=>{e.waitUntil((async()=>{
  const c=await caches.open(V);
  await Promise.all(SHELL.map(u=>c.add(new Request(u,{cache:'reload'})).catch(()=>{})));
  try{const cat=await (await c.match('catalog.json')).json();await Promise.all(cat.flatMap(s=>[].concat(s.file)).map(f=>c.add(f).catch(()=>{})))}catch(_){}
  await Promise.all(CDN.map(u=>c.add(u).catch(()=>{})));
  try{const css=await (await c.match(CDN[0])).text();const fonts=[...css.matchAll(/url\(([^)]+?\.woff2)\)/g)].map(m=>new URL(m[1].replace(/['"]/g,''),K).href);await Promise.all(fonts.map(u=>c.add(u).catch(()=>{})))}catch(_){}
  self.skipWaiting();
})())});
self.addEventListener('activate',e=>{e.waitUntil((async()=>{
  for(const k of await caches.keys())if(k!==V)await caches.delete(k);
  await self.clients.claim();
})())});
self.addEventListener('fetch',e=>{
  const r=e.request;if(r.method!=='GET')return;
  const u=new URL(r.url);
  if(u.origin===location.origin){
    if(u.pathname.startsWith('/api/'))return;
    e.respondWith((async()=>{
      const c=await caches.open(V);
      try{
        const res=await Promise.race([fetch(r),new Promise((_,rej)=>setTimeout(()=>rej(0),4000))]);
        if(res&&res.ok)c.put(r,res.clone());
        return res;
      }catch(_){
        const hit=await c.match(r,{ignoreSearch:true});
        if(hit)return hit;
        if(r.mode==='navigate')return (await c.match('index.html'))||Response.error();
        return Response.error();
      }
    })());
  }else if(u.hostname==='cdn.jsdelivr.net'||u.hostname==='cdnjs.cloudflare.com'){
    e.respondWith((async()=>{
      const c=await caches.open(V);
      const hit=await c.match(r);
      if(hit)return hit;
      const res=await fetch(r);
      if(res&&res.ok)c.put(r,res.clone());
      return res;
    })());
  }
});

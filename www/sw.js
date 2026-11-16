// Cache básico para que la app abra sin cobertura (el mapa necesita datos).
const C='rondas-v12', SHELL=['./','index.html','app.js','config.js','manifest.webmanifest','icon.svg','vendor/jspdf.umd.min.js','vendor/jspdf.plugin.autotable.min.js','vendor/xlsx.mini.min.js','https://unpkg.com/leaflet@1.9.4/dist/leaflet.css','https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.hostname.includes('googleapis')||u.hostname.includes('gstatic'))return;
  // red primero para la app, caché como respaldo; teselas: caché primero
  const tile=/arcgisonline|tile\.openstreetmap/.test(u.hostname);
  e.respondWith(tile
    ? caches.match(e.request).then(r=>r||fetch(e.request).then(res=>{const cp=res.clone();caches.open(C+'-tiles').then(c=>c.put(e.request,cp));return res}))
    : fetch(e.request).then(res=>{const cp=res.clone();caches.open(C).then(c=>c.put(e.request,cp));return res}).catch(()=>caches.match(e.request)));
});

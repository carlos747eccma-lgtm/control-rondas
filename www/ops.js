/* ============================================================
   Registro de operativas (integrado en Control de Rondas)
   Cabecera · Registrar · Puestos · Informe · Consultar
   Cada registro guarda la hora y la posición GPS del momento,
   sale en el informe diario (texto) y en el PDF/Excel del turno.
   ============================================================ */
const RO = {
  head: LS.get('ro_head', { vig: '', cod: '', centro: '', jefe: '', fecha: '' }),
  recs: LS.get('ro_recs', []),          // {id, t, txt, note, lat, lng, k}
  post: LS.get('ro_post', null),        // {name, t0}
  hist: LS.get('ro_phist', []),         // {name, from, to}
  stats: LS.get('ro_stats', {}),        // name -> {ms, n}
  undo: [],
  note: ''
};
if (!RO.head.fecha) RO.head.fecha = new Date().toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
function roSave() { LS.set('ro_head', RO.head); LS.set('ro_recs', RO.recs); LS.set('ro_post', RO.post); LS.set('ro_phist', RO.hist.slice(-200)); LS.set('ro_stats', RO.stats); }
const hm = t => { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const hDur = ms => { const m = Math.round(ms / 60000); return Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') + ' min'; };
function roPos() { const p = (run && run.last) || LS.get('rp_lastpos', null); return p ? { lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6) } : {}; }

/* ---------- Catálogo ---------- */
const POSTS = ['SOC', 'control', 'patrulla', 'oficinas'];
const RELEVOS = ['ligeros', 'SOC', 'control', 'puerta 2', 'Llovera'];
const NUM = { label: 'Matrícula (opcional)', id: 'mat' };
// Operativas con formulario propio; el resto: Inicio / Finalizó + nota
const OPS = [
  { n: '01 APERTURA PUERTA DE RESIDUOS O ALMACÉN', f: [{ id: 'det', label: 'Detalle', ph: 'Ej.: apertura puerta 4 y 5' }] },
  { n: '01 REGISTRO LLAVES RODI', f: [{ id: 'nom', label: 'Nombre de la persona', pre: 'persona ' }, { id: 'dni', label: 'DNI o NIE', upper: 1, pre: 'DNI ' }] },
  { n: '02 REGISTRO LLAVES NAUTIC', f: [{ id: 'nom', label: 'Nombre de la persona', pre: 'persona ' }, { id: 'dni', label: 'DNI o NIE', upper: 1, pre: 'DNI ' }] },
  { n: '03 OPERATIVA REVISIONES DE VEHÍCULOS', f: [NUM] },
  { n: '04 CONTENEDORES CORRALITO', f: [{ id: 'cont', label: 'Nº de contenedor (opcional)', ph: '4 letras + 7 cifras' }] },
  { n: '04 REVISIONES Y REGISTROS DE CABINAS Y ANULACIONES', f: [NUM] },
  { n: '05 RELEVO OFICINAS' },
  { n: '07 ACOMPAÑAMIENTO PROVISIONISTAS', f: [{ id: 'buque', label: '¿A qué buque?', ph: 'Nombre del buque', req: 1 }] },
  { n: '10 PASO POR LA VÍA DEL TREN CCE' },
  { n: '11 RONDAS EN TERMINAL POR ZONAS', f: [{ id: 'zonas', label: 'Zonas', ph: 'Ej.: 1, 2, 3…' }] },
  { n: '12 OPERATIVA ALUMBRADO' },
  { n: '13 OPERATIVA VALLADO PERIMETRAL' },
  { n: '15 INCIDENCIA PRECINTOS', form: 'precintos' },
  { n: '19.01 OPERATIVA CONDUCTOR CON ACOMPAÑANTE', form: 'conductor' },
  { n: '20 CONTROL ACCESOS LLOVERA' },
  { n: '21 PROCEDIMIENTO APERTURA DE CONTENEDORES EN TERMINAL', f: [{ id: 'cont', label: 'Matrícula del contenedor', ph: '4 letras + 7 cifras' }] },
  { n: '22 PRÁCTICAS INSEGURAS', f: [{ id: 'det', label: 'Detalle', ph: 'Qué se ha visto, dónde, quién' }] },
  { n: 'ACOMPAÑAMIENTO DE TRANSPORTE ESPECIAL', f: [NUM] },
  { n: 'ANULACIONES DE CARGA', form: 'anulacion' },
  { n: 'Accede la visita (nombre) para (quien la creó)', form: 'visita', cls: 'alt' },
  { n: '+ Otra anotación (escribir texto)', form: 'otra', cls: 'alt' }
];

/* ---------- Registro ---------- */
function roAdd(txt, k, extra) {
  const r = Object.assign({ id: Date.now() + Math.floor(Math.random() * 1000), t: Date.now(), txt, note: RO.note.trim(), k: k || '' }, roPos(), extra || {});
  RO.recs.push(r); RO.recs.sort((a, b) => a.t - b.t);
  RO.undo.push({ id: r.id, post: RO.post ? Object.assign({}, RO.post) : null, prevPost: extra && extra._prevPost });
  delete r._prevPost;
  RO.note = ''; const ni = document.getElementById('roNote'); if (ni) ni.value = '';
  // también al registro del turno (sale en la pestaña Registro y en el PDF)
  if (typeof logEv === 'function' && run && !run.end) { logEv('Operativa: ' + txt + (r.note ? ' · ' + r.note : ''), r.lat != null ? r : null, 'acc'); persist && persist(true); }
  roSave(); roRender(); banner('Registrado ' + hm(r.t) + ' h · ' + txt.slice(0, 60), '', 2500);
  return r;
}
function roUndo() {
  const u = RO.undo.pop(); if (!u) { banner('No hay nada que deshacer', 'warn', 2500); return; }
  RO.recs = RO.recs.filter(r => r.id !== u.id);
  if (u.prevPost !== undefined) { RO.post = u.prevPost; }
  roSave(); roRender(); banner('Deshecho', '', 2000);
}
function closePost(t) {
  if (!RO.post) return;
  const ms = Math.max(0, t - RO.post.t0), s = RO.stats[RO.post.name] || (RO.stats[RO.post.name] = { ms: 0, n: 0 });
  s.ms += ms; s.n++; RO.hist.push({ name: RO.post.name, from: RO.post.t0, to: t }); RO.post = null;
}
// Me sitúo en ... (puesto): cuenta el tiempo; en puesto fijo se silencia la alarma de parado (modo relevo)
function setPost(name) {
  if (RO.post && RO.post.name === name) { banner('Ya estás en ' + name, 'warn', 2500); return; }
  const prev = RO.post ? Object.assign({}, RO.post) : null, t = Date.now();
  closePost(t); RO.post = { name, t0: t };
  roAdd('Me sitúo en ' + name + '.', 'post', { _prevPost: prev });
  if (typeof setRelevo === 'function' && run && !run.end) setRelevo(name !== 'patrulla');
}
function stopPost() { if (!RO.post) { banner('Ningún puesto en marcha', 'warn', 2500); return; } closePost(Date.now()); roSave(); roRender(); banner('Cronómetro parado', '', 2000); }

/* ---------- Formularios ---------- */
function roForm(title, fields, onOk, opts) {
  opts = opts || {};
  const box = document.getElementById('roSheetBox');
  box.innerHTML = '<h3 style="margin-top:0">' + esc(title) + '</h3>' +
    fields.map(f => f.choice ? '<label>' + esc(f.label) + '</label><div class="row" data-choice="' + f.id + '">' + f.choice.map((c, i) => '<button type="button" class="btn sm' + (i === 0 ? ' pri' : '') + '" data-v="' + esc(c) + '">' + esc(c) + '</button>').join('') + '</div>'
      : '<label>' + esc(f.label) + (f.req ? '' : '') + '</label>' + (f.area ? '<textarea id="rf_' + f.id + '" rows="3" placeholder="' + esc(f.ph || '') + '">' + esc(f.v || '') + '</textarea>' : '<input id="rf_' + f.id + '" type="' + (f.type || 'text') + '" placeholder="' + esc(f.ph || '') + '" value="' + esc(f.v || '') + '"' + (f.upper ? ' style="text-transform:uppercase"' : '') + '>')).join('') +
    '<p class="mut">' + esc(opts.hint || 'Se guarda con la hora actual.') + '</p>' +
    '<div class="row">' + (opts.del ? '<button class="btn sm" id="rfDel" style="color:var(--bad);border-color:var(--bad)">Borrar</button>' : '') + '<button class="btn grow" id="rfCancel">Cancelar</button><button class="btn pri grow" id="rfOk">' + (opts.ok || 'Guardar') + '</button></div>';
  const sel = {};
  box.querySelectorAll('[data-choice]').forEach(row => { const id = row.dataset.choice; sel[id] = row.querySelector('button').dataset.v; row.onclick = e => { const b = e.target.closest('button'); if (!b) return; sel[id] = b.dataset.v; row.querySelectorAll('button').forEach(x => x.classList.toggle('pri', x === b)); }; });
  const sheet = document.getElementById('roSheet'); sheet.style.display = 'flex';
  const close = () => { sheet.style.display = 'none'; };
  document.getElementById('rfCancel').onclick = close;
  if (opts.del) document.getElementById('rfDel').onclick = () => { if (confirm('¿Borrar este registro?')) { opts.del(); close(); } };
  document.getElementById('rfOk').onclick = () => {
    const v = Object.assign({}, sel); fields.forEach(f => { if (!f.choice) { let x = document.getElementById('rf_' + f.id).value.trim(); if (f.upper) x = x.toUpperCase(); v[f.id] = x; } });
    const miss = fields.find(f => f.req && !v[f.id]); if (miss) { banner(miss.reqMsg || ('Falta: ' + miss.label), 'warn', 3000); return; }
    if (onOk(v) !== false) close();
  };
  const first = box.querySelector('input,textarea'); if (first) setTimeout(() => first.focus(), 100);
}
const IF = { id: 'fase', label: '¿Inicio o fin?', choice: ['Inicio', 'Finalizó'] };
function roOp(op) {
  const n = op.n;
  if (op.form === 'otra') return roForm('Otra anotación', [{ id: 'txt', label: 'Texto de la anotación', area: 1, req: 1 }], v => { roAdd(v.txt, 'otra'); });
  if (op.form === 'visita') return roForm('Accede la visita', [{ id: 'nom', label: 'Nombre de la visita', req: 1, reqMsg: 'Falta el nombre de la visita' }, { id: 'para', label: '¿A quién? Nombre de quien creó la visita', ph: 'Para (quien la creó)' }],
    v => { roAdd('Accede la visita ' + v.nom + (v.para ? ' para ' + v.para : '') + '.', 'visita'); });
  if (op.form === 'precintos') return roForm(n, [{ id: 'ord', label: 'Nº del precinto de orden' }, { id: 'fis', label: 'Nº del precinto físico' }, { id: 'cont', label: 'Matrícula del contenedor', ph: '4 letras + 7 cifras', upper: 1 }],
    v => { roAdd(n + ': ' + [v.ord && 'precinto de orden ' + v.ord, v.fis && 'precinto físico ' + v.fis, v.cont && 'matrícula contenedor ' + v.cont].filter(Boolean).join(', ') + '.', 'op'); });
  if (op.form === 'anulacion') return roForm('Anulación de carga (entrada / salida)', [
    { id: 'es', label: 'Tipo', choice: ['Entrada', 'Salida'] }, { id: 'pta', label: 'Nº de puerta (de la entrada o de la salida)', type: 'number', req: 1, reqMsg: 'Pon el número de la puerta de entrada o salida' },
    { id: 'cn', label: 'Nombre del conductor', req: 1, reqMsg: 'Falta el nombre del conductor' }, { id: 'cd', label: 'DNI / NIE del conductor', upper: 1, req: 1, reqMsg: 'Falta el DNI / NIE del conductor' },
    { id: 'emp', label: 'Empresa / transportista', v: LS.get('last_anul_empresa', '') }, { id: 'mat', label: 'Matrícula', upper: 1 },
    { id: 'cont', label: 'Nº de contenedor (opcional)', upper: 1, ph: '4 letras + 7 cifras' },
    { id: 'mot', label: 'Motivo', choice: ['Avería', 'Cliente anula', 'Contenedor roto', 'Empresa anula', 'Plataforma incorrecta', 'Se acaba el disco', 'Otro'] }, { id: 'motx', label: 'Escribe el motivo (si es otro)' }],
    v => {
      const mot = v.mot === 'Otro' ? (v.motx || 'otro') : v.mot; if (v.emp) LS.set('last_anul_empresa', v.emp);
      roAdd('Anulación de carga (' + v.es.toLowerCase() + ' por puerta ' + v.pta + '). Conductor ' + v.cn + ', DNI ' + v.cd + (v.emp ? ', empresa ' + v.emp : '') + (v.mat ? ', matrícula ' + v.mat : '') + (v.cont ? ', contenedor ' + v.cont : '') + ', motivo: ' + mot + '.', 'op');
    });
  if (op.form === 'conductor') return roForm(n, [
    { id: 'cn', label: 'Nombre del conductor' }, { id: 'cd', label: 'DNI / NIE del conductor', upper: 1 },
    { id: 'an', label: 'Nombre del acompañante' }, { id: 'ad', label: 'DNI / NIE del acompañante', upper: 1 },
    { id: 'emp', label: 'Empresa / transportista' }, { id: 'mat', label: 'Matrícula', upper: 1 },
    { id: 'pe', label: 'Puerta de entrada (nº)', type: 'number' }, { id: 'he', label: 'Hora de entrada', type: 'time', v: hm(Date.now()) },
    { id: 'ps', label: 'Puerta de salida (nº)', type: 'number' }, { id: 'hs', label: 'Hora de salida', type: 'time' }],
    v => {
      if (!v.pe && !v.ps) { banner('Pon la puerta de entrada o la de salida', 'warn', 3000); return false; }
      const p = [n + '. Conductor ' + (v.cn || '—') + (v.cd ? ', DNI ' + v.cd : '')];
      if (v.an) p.push('Acompañante ' + v.an + (v.ad ? ', DNI ' + v.ad : ''));
      const q = []; if (v.emp) q.push('empresa ' + v.emp); if (v.mat) q.push('matrícula ' + v.mat);
      if (v.pe) q.push('entrada por puerta ' + v.pe + (v.he ? ' a las ' + v.he + ' h' : '')); if (v.ps) q.push('salida por puerta ' + v.ps + (v.hs ? ' a las ' + v.hs + ' h' : ''));
      roAdd(p.join('. ') + (q.length ? ', ' + q.join(', ') : '') + '.', 'op');
    }, { hint: 'Pon la de entrada, la de salida o las dos.' });
  // genérica: Inicio / Finalizó + campos opcionales
  roForm(n, [IF].concat(op.f || []), v => {
    const extra = (op.f || []).map(f => v[f.id] ? (f.pre !== undefined ? f.pre : f.id === 'buque' ? 'buque ' : f.id === 'mat' ? 'matrícula ' : f.id === 'cont' ? 'contenedor ' : f.id === 'zonas' ? 'zonas ' : '') + v[f.id] : '').filter(Boolean).join(', ');
    roAdd((v.fase === 'Inicio' ? 'Inicio ' : 'Finalizó ') + n + (extra ? ', ' + extra : '') + '.', 'op');
  }, { hint: 'Se guarda con la hora actual. Elige Inicio o Finalizó.' });
}
function roEdit(id) {
  const r = RO.recs.find(x => x.id === id); if (!r) return;
  roForm('Editar registro', [{ id: 'h', label: 'Hora (automática, se puede cambiar)', type: 'time', v: hm(r.t) }, { id: 'txt', label: 'Operativa / texto', area: 1, v: r.txt, req: 1 }, { id: 'note', label: 'Nota (opcional)', v: r.note || '' }], v => {
    const [H, M] = (v.h || hm(r.t)).split(':').map(Number), d = new Date(r.t); d.setHours(H, M, 0, 0); r.t = d.getTime(); r.txt = v.txt; r.note = v.note;
    RO.recs.sort((a, b) => a.t - b.t); roSave(); roRender();
  }, { ok: 'Guardar cambios', hint: 'Toca Guardar para aplicar.', del: () => { RO.recs = RO.recs.filter(x => x.id !== id); roSave(); roRender(); } });
}

/* ---------- Informe diario (texto) ---------- */
function roReport() {
  const h = RO.head, L = ['INFORME DIARIO DE SERVICIOS', ''];
  L.push('Fecha: ' + (h.fecha || '')); if (h.centro) L.push('Centro de trabajo: ' + h.centro);
  L.push('Vigilante de seguridad: ' + (h.vig || '—') + (h.cod ? ' · Código empleado: ' + h.cod : '')); if (h.jefe) L.push('Jefe de equipo: ' + h.jefe);
  L.push('', 'DESCRIPCIÓN DEL SERVICIO', '');
  if (!RO.recs.length) L.push('Sin registros todavía');
  RO.recs.forEach(r => L.push(hm(r.t) + ' h. ' + r.txt + (r.note ? ' (' + r.note + ')' : '')));
  return L.join('\n');
}
async function roShare() {
  const txt = roReport();
  try { if (window.Capacitor && Capacitor.Plugins.Share) { await Capacitor.Plugins.Share.share({ title: 'Informe diario de servicios', text: txt }); return; } } catch (e) { }
  try { if (navigator.share) { await navigator.share({ title: 'Informe diario de servicios', text: txt }); return; } } catch (e) { return; }
  roCopy();
}
function roCopy() { const txt = roReport(); (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => banner('Informe copiado', '', 2000)).catch(() => { const t = document.createElement('textarea'); t.value = txt; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); banner('Informe copiado', '', 2000); } catch (e) { } t.remove(); }); }
// registros dentro de un turno (para el PDF/Excel del turno)
function roRecsFor(r) { const a = r.start, b = r.end || Date.now(); return RO.recs.filter(x => x.t >= a && x.t <= b).concat((r.ops || []).filter(x => !RO.recs.some(y => y.id === x.id))).sort((x, y) => x.t - y.t); }

/* ---------- Consultar: buscar en mis PDF (sin internet) ---------- */
const DOCDB = { db: null };
function docDb() { return DOCDB.db || (DOCDB.db = new Promise((res, rej) => { const q = indexedDB.open('ro_docs', 1); q.onupgradeneeded = () => q.result.createObjectStore('docs', { keyPath: 'name' }); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); })); }
async function docAll() { const db = await docDb(); return new Promise(res => { const out = [], c = db.transaction('docs').objectStore('docs').openCursor(); c.onsuccess = () => { const k = c.result; if (k) { out.push(k.value); k.continue(); } else res(out); }; c.onerror = () => res(out); }); }
async function docPut(d) { const db = await docDb(); return new Promise(res => { const tx = db.transaction('docs', 'readwrite'); tx.objectStore('docs').put(d); tx.oncomplete = res; tx.onerror = res; }); }
async function docDel(name) { const db = await docDb(); return new Promise(res => { const tx = db.transaction('docs', 'readwrite'); tx.objectStore('docs').delete(name); tx.oncomplete = res; }); }
let docBusy = false;
async function docAdd(files) {
  if (docBusy) { banner('Espera, aún estoy leyendo el PDF anterior', 'warn', 3000); return; }
  if (!window.pdfjsLib) { banner('No se pudo cargar el lector de PDF', 'bad', 4000); return; }
  docBusy = true; pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  for (const f of files) {
    try {
      banner('Leyendo ' + f.name + '…', '', 60000);
      const pdf = await pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise, pages = [];
      let empty = 0;
      for (let i = 1; i <= pdf.numPages; i++) { const tc = await (await pdf.getPage(i)).getTextContent(); let s = ''; tc.items.forEach(it => { s += it.str + (it.hasEOL ? '\n' : ' '); }); s = s.replace(/[ \t]+/g, ' ').trim(); if (!s) empty++; pages.push(s); }
      if (empty === pages.length) { banner(f.name + ': no tiene texto (parece un escaneo o una foto). No se ha añadido.', 'warn', 6000); continue; }
      await docPut({ name: f.name, pages, added: Date.now() });
      banner(f.name + (empty ? ': añadido, pero ' + empty + ' páginas no tienen texto.' : ': PDF añadido'), '', 4000);
    } catch (e) { banner(f.name + ': no se pudo leer (' + e.message + ')', 'bad', 5000); }
  }
  docBusy = false; roRenderDocs();
}
const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
async function docSearch(q) {
  const words = (norm(q).match(/[\p{L}\p{N}]+/gu) || []).filter(w => w.length > 2);
  const out = document.getElementById('roHits');
  if (!words.length) { out.innerHTML = '<p class="mut">Escribe qué quieres buscar</p>'; return; }
  const docs = await docAll(); if (!docs.length) { out.innerHTML = '<p class="mut">Primero añade algún PDF (abajo)</p>'; return; }
  const hits = [];
  docs.forEach(d => d.pages.forEach((p, pi) => {
    // fragmentos de ~2 frases
    const parts = p.split(/(?<=[.:;])\s+|\n+/).filter(x => x.trim().length > 20);
    for (let i = 0; i < parts.length; i++) {
      const frag = (parts[i] + ' ' + (parts[i + 1] || '')).trim(), nf = norm(frag);
      let sc = 0; words.forEach(w => { if (nf.includes(w)) sc += 2; else if (w.length > 5 && nf.includes(w.slice(0, w.length - 2))) sc += 1; });
      if (sc) hits.push({ sc: sc / words.length, frag: frag.slice(0, 500), doc: d.name, pg: pi + 1 });
    }
  }));
  hits.sort((a, b) => b.sc - a.sc);
  const top = hits.slice(0, 25);
  out.innerHTML = top.length ? '<p class="mut">' + top.length + ' fragmentos, del más al menos parecido · toca uno para copiarlo</p>' + top.map(h => '<div class="rohit" data-copy="' + esc(h.frag) + '"><b>' + esc(h.doc) + '</b> · pág. ' + h.pg + '<br>' + esc(h.frag) + '</div>').join('')
    : '<p class="mut">No he encontrado nada parecido. Prueba con otras palabras (por ejemplo «puerta», «llaves» o «precinto»).</p>';
}
async function roRenderDocs() {
  const docs = await docAll(), el = document.getElementById('roDocs'); if (!el) return;
  el.innerHTML = docs.length ? '<p class="mut">' + docs.length + (docs.length === 1 ? ' documento cargado' : ' documentos cargados') + '</p>' + docs.map(d => '<div class="rorow"><span>' + esc(d.name) + ' · ' + d.pages.length + ' pág.</span><button class="btn sm" data-deldoc="' + esc(d.name) + '">Borrar</button></div>').join('')
    : '<p class="mut">Aún no hay PDF. Pulsa «Añadir PDF» y elige uno o varios; puedes añadir más cuando quieras. Si subes uno con el mismo nombre, se sustituye.</p>';
}

/* ---------- Pintado ---------- */
function roRender() {
  const last = RO.recs[RO.recs.length - 1];
  document.getElementById('roLast').textContent = last ? 'Último: ' + hm(last.t) + 'h · ' + last.txt : 'Sin registros todavía';
  document.getElementById('roCur').textContent = RO.post ? 'Puesto actual: ' + RO.post.name + ' desde las ' + hm(RO.post.t0) + ' (' + hDur(Date.now() - RO.post.t0) + ')' : 'Ningún puesto en marcha';
  // informe
  document.getElementById('roRep').innerHTML = RO.recs.length ? RO.recs.map(r => '<li data-ro="' + r.id + '"><b>' + hm(r.t) + ' h</b> ' + esc(r.txt) + (r.note ? ' <i>(' + esc(r.note) + ')</i>' : '') + '</li>').join('') : '<li class="mut">Aún no hay registros. Ve a «Registrar» y pulsa una operativa.</li>';
  document.getElementById('roRepN').textContent = RO.recs.length + (RO.recs.length === 1 ? ' registro' : ' registros') + ' · toca uno para editarlo';
  // puestos
  const total = Object.values(RO.stats).reduce((a, s) => a + s.ms, 0);
  document.getElementById('roStats').innerHTML = Object.keys(RO.stats).length ? '<table class="rotab"><tr><th>Puesto</th><th>Total</th><th>%</th><th>Veces</th><th>Media</th></tr>' + Object.entries(RO.stats).sort((a, b) => b[1].ms - a[1].ms).map(([k, s]) => '<tr><td>' + esc(k) + '</td><td>' + hDur(s.ms) + '</td><td>' + (total ? Math.round(100 * s.ms / total) : 0) + '%</td><td>' + s.n + '</td><td>' + hDur(s.ms / s.n) + '</td></tr>').join('') + '</table>'
    : '<p class="mut">Todavía no hay tiempos. Cuando pulses un puesto y cambies a otro, aparecerán aquí.</p>';
  document.getElementById('roHist').innerHTML = RO.hist.slice(-12).reverse().map(h => '<li><b>' + esc(h.name) + '</b> · ' + hm(h.from) + '–' + hm(h.to) + ' · ' + hDur(h.to - h.from) + '</li>').join('') || '<li class="mut">—</li>';
  // cabecera
  ['vig', 'cod', 'centro', 'jefe', 'fecha'].forEach(k => { const el = document.getElementById('roh_' + k); if (el && document.activeElement !== el) el.value = RO.head[k] || ''; });
}
function roBuild() {
  const sec = (t, items) => '<h3>' + t + '</h3>' + items;
  const btn = (txt, act, cls) => '<button class="robtn ' + (cls || '') + '" data-act="' + esc(act) + '">' + esc(txt) + '</button>';
  document.getElementById('roReg').innerHTML =
    '<label>Nota para el próximo registro (opcional)</label><input id="roNote" placeholder="Ej.: matrícula, nombre, detalle…">' +
    '<div class="rorow"><span id="roLast" class="mut"></span><button class="btn sm" id="roUndo">Deshacer</button></div>' +
    sec('Servicio / puesto', btn('Inicio de servicio (relevo)', 'ini') + POSTS.map(p => btn('Me sitúo en ' + p, 'post:' + p)).join('') + btn('Fin de servicio (relevo)', 'fin')) +
    '<p class="mut">Pulsa el puesto donde te sitúas. Se anota en el informe y empieza a contar el tiempo; al cambiar de puesto se cierra el anterior. En un puesto fijo no suena la alarma de parado; en patrulla sí.</p>' +
    sec('Relevos y fin de relevo', RELEVOS.map(p => btn('Relevo en ' + p, 'rel:' + p, 'org')).join('') + RELEVOS.map(p => btn('Fin de relevo en ' + p, 'frel:' + p, 'org2')).join('')) +
    sec('Registros y otros', OPS.map((o, i) => btn(o.n, 'op:' + i, o.cls === 'alt' ? 'alt' : 'blu')).join(''));
}
function roTab(id) { document.querySelectorAll('#roTabs button').forEach(b => b.classList.toggle('on', b.dataset.t === id)); document.querySelectorAll('.ropane').forEach(p => p.style.display = p.id === id ? 'block' : 'none'); if (id === 'roDocsP') roRenderDocs(); }
function roBind() {
  roBuild();
  document.getElementById('roTabs').onclick = e => { const b = e.target.closest('button'); if (b) roTab(b.dataset.t); };
  document.getElementById('roNote').oninput = e => { RO.note = e.target.value; };
  document.getElementById('roUndo').onclick = roUndo;
  document.getElementById('roReg').addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b) return; const [a, v] = b.dataset.act.split(/:(.*)/s);
    if (a === 'ini') {
      const prev = RO.post ? Object.assign({}, RO.post) : null; closePost(Date.now());
      roAdd('Inicia servicio el V.S. ' + (RO.head.vig || '—') + (RO.head.centro ? ' en ' + RO.head.centro : '') + ', efectuando el relevo y siendo informado de las novedades. Sin novedad.', 'ini', { _prevPost: prev });
    } else if (a === 'fin') { const prev = RO.post ? Object.assign({}, RO.post) : null; closePost(Date.now()); roAdd('Finalizo servicio, siendo relevado e informando de las novedades.', 'fin', { _prevPost: prev }); }
    else if (a === 'post') setPost(v);
    else if (a === 'rel') { roAdd('Relevo en ' + v + '.', 'rel'); if (typeof setRelevo === 'function' && run && !run.end) setRelevo(true); }
    else if (a === 'frel') roAdd('Fin de relevo en ' + v + '.', 'rel');
    else if (a === 'op') roOp(OPS[+v]);
  });
  document.getElementById('roStop').onclick = stopPost;
  document.getElementById('roClrStats').onclick = () => { if (confirm('Se borra todo el historial de tiempos por puesto. No se puede deshacer.')) { RO.stats = {}; RO.hist = []; roSave(); roRender(); } };
  document.getElementById('roRep').onclick = e => { const li = e.target.closest('[data-ro]'); if (li) roEdit(+li.dataset.ro); };
  document.getElementById('roShare').onclick = roShare;
  document.getElementById('roPdf').onclick = () => opsPdf().catch(e => banner('No se pudo crear el PDF: ' + e.message, 'bad', 5000));
  document.getElementById('roMail').onclick = () => { if (!cfg.mails) { banner('Primero pon los correos en Configurar (con contraseña)', 'warn', 5000); return; } const r = run || LS.get('rp_hist', [])[0]; if (!r) { banner('No hay turno', 'warn', 3000); return; } mailReports(r).catch(e => banner('No se pudo preparar el correo: ' + e.message, 'bad', 6000)); };
  document.getElementById('roCopy').onclick = roCopy;
  document.getElementById('roNewDay').onclick = () => { if (!confirm('Se borrarán todos los registros y la fecha pasará a ser hoy. La cabecera se mantiene.')) return; RO.recs = []; RO.undo = []; RO.head.fecha = new Date().toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }); roSave(); roRender(); };
  ['vig', 'cod', 'centro', 'jefe', 'fecha'].forEach(k => { document.getElementById('roh_' + k).oninput = e => { RO.head[k] = e.target.value; roSave(); if (k === 'vig' && e.target.value.trim()) { LS.set('rp_guard', e.target.value.trim()); const g = document.getElementById('guard'); if (g) g.value = e.target.value.trim(); if (run && !run.end) { run.guard = e.target.value.trim(); persist && persist(true); } } }; });
  document.getElementById('roAddPdf').onclick = () => document.getElementById('roFile').click();
  document.getElementById('roFile').onchange = e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) docAdd(f); };
  document.getElementById('roDocs').onclick = async e => { const b = e.target.closest('[data-deldoc]'); if (b && confirm('¿Borrar «' + b.dataset.deldoc + '» de la app?')) { await docDel(b.dataset.deldoc); roRenderDocs(); } };
  document.getElementById('roQ').onkeydown = e => { if (e.key === 'Enter') docSearch(e.target.value); };
  document.getElementById('roGo').onclick = () => docSearch(document.getElementById('roQ').value);
  document.getElementById('roHits').onclick = e => { const h = e.target.closest('[data-copy]'); if (h) { (navigator.clipboard ? navigator.clipboard.writeText(h.dataset.copy) : Promise.resolve()).then(() => banner('Fragmento copiado', '', 2000)); } };
  if (!RO.head.vig && LS.get('rp_guard', '')) { RO.head.vig = LS.get('rp_guard', ''); roSave(); }
  roRender(); roTab('roRegP');
  setInterval(() => { if (RO.post && document.getElementById('pOps').classList.contains('on')) roRender(); }, 30000);
}
document.addEventListener('DOMContentLoaded', roBind);
if (document.readyState !== 'loading') roBind();

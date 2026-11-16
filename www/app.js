/* Rondas Patio — seguimiento GPS de rondas de seguridad en patio de contenedores. */
'use strict';
const $ = id => document.getElementById(id);
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('storage', e); } }
};

const DEF_CFG = { gkey: (window.RONDAS_GOOGLE_KEY || ''), maxAcc: 25, jumpSpd: 90, speedLimit: 25, stopSec: 30, stopRad: 8, stopAlarm: 10, cellSize: 15, covRad: 10, presets: '06-14, 14-22, 22-06', freqMin: 60, cpRad: 15 };
let cfg = Object.assign({}, DEF_CFG, LS.get('rp_cfg', {}));
if (!LS.get('rp_mig10')) { LS.set('rp_mig10', 1); if (cfg.stopAlarm === 5) { cfg.stopAlarm = 10; LS.set('rp_cfg', Object.assign(LS.get('rp_cfg', {}), { stopAlarm: 10 })); } } // alarma de parado: 5 → 10 min
// parada larga = incidencia (las paradas en modo relevo no cuentan)
function isLong(s) { return !!cfg.stopAlarm && s.dur >= cfg.stopAlarm * 60000 && !s.relevo; }
cfg.gkey = window.RONDAS_GOOGLE_KEY || ''; // la clave solo se define en config.js, no se puede cambiar desde la app
let yard = LS.get('rp_yard', { boundary: [], points: [] });
// migra las salidas de la versión anterior a puntos de control
if (!yard.points) { yard.points = (yard.exits || []).map((e, k) => ({ id: 'x' + k, name: e.name, type: 'salida', lat: e.lat, lng: e.lng })); delete yard.exits; }
// Limpieza: quita el patio y los puntos de ejemplo de versiones anteriores
if (yard.points.some(p => /^d/.test(p.id))) { yard = { boundary: [], points: [] }; LS.set('rp_yard', yard); }
try { const h0 = LS.get('rp_hist', []); if (h0.some(r => r.sim)) LS.set('rp_hist', h0.filter(r => !r.sim)); } catch (e) { }
let run = null;            // ronda en curso
let cells = [];            // zonas de la cuadrícula
let cellIdx = new Map();   // "i,j" -> celda
let proj = null;           // proyección local en metros
let watchId = null, wakeLock = null, simTimer = null;
let editMode = null;       // 'boundary' | 'punto' | 'salida' | null
let draft = [];
let lastFixAt = Date.now(), lastValidAt = Date.now(), lastRawAcc = null, noFixBanner = false;
let simClock = null; // reloj acelerado durante la simulación
const nowT = () => simClock != null ? simClock : Date.now();
// Centro por defecto: Puerto de Valencia (zona de APM Terminals). El límite exacto se dibuja en la pestaña Patio.
const VLC = { lat: 39.4325, lng: -0.3185 };

/* ---------- Geometría ---------- */
function makeProj(lat0, lng0) {
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  return {
    lat0, lng0,
    xy: p => ({ x: (p.lng - lng0) * kx, y: (p.lat - lat0) * ky }),
    ll: (x, y) => ({ lat: lat0 + y / ky, lng: lng0 + x / kx })
  };
}
function hav(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function inPoly(pt, poly) { // pt {x,y}, poly [{x,y}]
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
function polyArea(poly) { let s = 0; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y); return Math.abs(s / 2); }

/* ---------- Cuadrícula de zonas ---------- */
function buildGrid() {
  cells = []; cellIdx = new Map();
  if (yard.boundary.length < 3) { proj = null; return; }
  const b = yard.boundary;
  proj = makeProj(b.reduce((s, p) => s + p.lat, 0) / b.length, b.reduce((s, p) => s + p.lng, 0) / b.length);
  const poly = b.map(proj.xy);
  const xs = poly.map(p => p.x), ys = poly.map(p => p.y);
  const s = cfg.cellSize, minX = Math.min(...xs), minY = Math.min(...ys);
  const nx = Math.ceil((Math.max(...xs) - minX) / s), ny = Math.ceil((Math.max(...ys) - minY) / s);
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const x0 = minX + i * s, y0 = minY + j * s, cx = x0 + s / 2, cy = y0 + s / 2;
    // la zona entra si su centro o alguna esquina cae dentro del límite
    const pts = [{ x: cx, y: cy }, { x: x0 + 1, y: y0 + 1 }, { x: x0 + s - 1, y: y0 + 1 }, { x: x0 + 1, y: y0 + s - 1 }, { x: x0 + s - 1, y: y0 + s - 1 }];
    if (!inPoly(pts[0], poly) && pts.filter(p => inPoly(p, poly)).length < 2) continue;
    const c = { i, j, x0, y0, cx, cy, covered: false, at: null,
      corners: [proj.ll(x0, y0), proj.ll(x0 + s, y0), proj.ll(x0 + s, y0 + s), proj.ll(x0, y0 + s)] };
    cells.push(c); cellIdx.set(i + ',' + j, c);
  }
  proj.minX = minX; proj.minY = minY; proj.poly = poly;
}
function coverAt(p, t) {
  if (!proj) return 0;
  const { x, y } = proj.xy(p), r = cfg.covRad, s = cfg.cellSize;
  let n = 0;
  const i0 = Math.floor((x - r - proj.minX) / s), i1 = Math.floor((x + r - proj.minX) / s);
  const j0 = Math.floor((y - r - proj.minY) / s), j1 = Math.floor((y + r - proj.minY) / s);
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const c = cellIdx.get(i + ',' + j); if (!c || c.covered) continue;
    const dx = Math.max(c.x0 - x, 0, x - (c.x0 + s)), dy = Math.max(c.y0 - y, 0, y - (c.y0 + s));
    if (dx * dx + dy * dy <= r * r) { c.covered = true; c.at = t; map.cell(c); n++; }
  }
  return n;
}
function covPct() { return cells.length ? Math.round(100 * cells.filter(c => c.covered).length / cells.length) : null; }
function insideYard(p) { return proj ? inPoly(proj.xy(p), proj.poly) : true; }

/* ---------- Filtro Kalman simple (lat/lng con varianza en metros) ---------- */
function Kalman(qMs) {
  let lat, lng, v = -1, t0;
  return {
    step(p, acc, t) {
      acc = Math.max(acc, 1);
      if (v < 0) { lat = p.lat; lng = p.lng; v = acc * acc; t0 = t; return { lat, lng }; }
      const dt = Math.max(0, (t - t0) / 1000); t0 = t;
      v += dt * qMs * qMs;
      const k = v / (v + acc * acc);
      lat += k * (p.lat - lat); lng += k * (p.lng - lng); v = (1 - k) * v;
      return { lat, lng };
    },
    reset() { v = -1; }
  };
}

/* ---------- Mapas: Leaflet (sin clave) y Google Maps (con clave) ---------- */
const COL = { red: '#ef4444', grn: '#22c55e', amb: '#f59e0b', blu: '#3b82f6', wht: '#ffffff' };
const STC = { ok: '#16a34a', warn: '#d97706', bad: '#dc2626', idle: '#475569' };
function spSecs(o) { return o.secs != null ? o.secs : Math.max(1, Math.round((o.to - o.from) / 1000) + 1); }
function fmtSec(n) { n = Math.round(n); return n < 60 ? n + ' s' : Math.floor(n / 60) + ' min ' + String(n % 60).padStart(2, '0') + ' s'; }
/* ---------- Barcos (AIS) ---------- */
const SHIP_T = t => t >= 70 && t <= 79 ? ['Carga', '#22c55e'] : t >= 80 && t <= 89 ? ['Petrolero / tanque', '#ef4444'] : t >= 60 && t <= 69 ? ['Pasaje', '#3b82f6'] : t === 52 ? ['Remolcador', '#06b6d4'] : t === 50 ? ['Práctico', '#06b6d4'] : t === 31 || t === 32 ? ['Remolque', '#06b6d4'] : t === 30 ? ['Pesca', '#eab308'] : t === 35 ? ['Militar', '#a3a3a3'] : t === 36 || t === 37 ? ['Recreo', '#d946ef'] : t >= 40 && t <= 49 ? ['Alta velocidad', '#f97316'] : ['Barco', '#cbd5e1'];
const NAV_ST = { 0: 'Navegando', 1: 'Fondeado', 2: 'Sin gobierno', 3: 'Maniobra restringida', 5: 'Atracado', 7: 'Pescando', 8: 'Navegando a vela' };
function shipHdg(s) { return s.hdg != null && s.hdg !== 511 ? s.hdg : s.cog != null && s.cog < 360 ? s.cog : null; }
// dibuja el casco a escala (metros → píxeles) girado según el rumbo; si no hay medidas, un triángulo
function shipHtml(s, pxm) {
  const [, col] = SHIP_T(s.type || 0), h = shipHdg(s), A = s.a || 0, B = s.b || 0, C = s.c || 0, D = s.d || 0;
  let L = (A + B) * pxm, W = (C + D) * pxm, svg;
  if (L >= 14 && W >= 3) {
    const pad = 4, R = Math.hypot(Math.max(A, B), Math.max(C, D)) * pxm + pad, S = 2 * R;
    const x = v => (R + v * pxm).toFixed(1), y = v => (R + v * pxm).toFixed(1), bw = Math.min((C + D) * 0.9, (A + B) * 0.2);
    const pts = [[(D - C) / 2, -A], [D, -A + bw], [D, B], [-C, B], [-C, -A + bw]].map(([px, py]) => x(px) + ',' + y(py)).join(' ');
    svg = '<svg width="' + S + '" height="' + S + '" style="position:absolute;left:' + (-R) + 'px;top:' + (-R) + 'px;transform:rotate(' + (h || 0) + 'deg);overflow:visible"><polygon points="' + pts + '" fill="' + col + '" fill-opacity=".85" stroke="#fff" stroke-width="1.5"/></svg>';
  } else {
    svg = h == null ? '<div style="position:absolute;left:-6px;top:-6px;width:12px;height:12px;border-radius:50%;background:' + col + ';border:2px solid #fff"></div>'
      : '<svg width="22" height="22" style="position:absolute;left:-11px;top:-11px;transform:rotate(' + h + 'deg)"><polygon points="11,1 18,20 11,15 4,20" fill="' + col + '" stroke="#fff" stroke-width="1.5"/></svg>';
  }
  const name = s.name ? '<div style="position:absolute;left:0;top:' + Math.max(12, L / 2 + 4) + 'px;transform:translateX(-50%);font:700 10px system-ui;color:#fff;text-shadow:0 0 3px #000,0 0 3px #000;white-space:nowrap;pointer-events:none">' + esc(s.name) + '</div>' : '';
  return '<div data-mmsi="' + s.mmsi + '" style="position:relative;width:0;height:0;cursor:pointer">' + svg + name + '</div>';
}
function shipInfo(mmsi) {
  const s = ships[mmsi]; if (!s) return;
  const [tipo] = SHIP_T(s.type || 0), st = NAV_ST[s.nav], L = (s.a || 0) + (s.b || 0);
  banner((s.name || 'MMSI ' + s.mmsi) + ' · ' + tipo + (L ? ' · ' + L + ' m' : '') + ' · ' + (st || (s.sog > 0.5 ? 'En movimiento' : 'Parado')) + (s.sog > 0.5 ? ' ' + s.sog.toFixed(1) + ' nudos' : '') + (s.dest ? ' · Destino ' + s.dest : '') + ' · visto ' + fmtHM(s.t), '', 7000);
}
function spHtml(o) { return '<div style="transform:translate(-50%,-50%);background:#dc2626;color:#fff;font:700 11px system-ui;padding:2px 6px;border-radius:6px;border:2px solid #fff;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.5)">⚡ ' + o.max + ' km/h · ' + spSecs(o) + ' s · ' + fmtHM(o.from) + '</div>'; }
function cpHtml(e) {
  const r = e.type === 'salida' ? '4px' : '50%';
  return '<div style="transform:translate(-12px,-12px);display:flex;align-items:center;gap:4px;white-space:nowrap"><span style="display:grid;place-items:center;width:24px;height:24px;border-radius:' + r + ';background:' + STC[e.k] + ';border:2px solid #fff;color:#fff;font:700 11px system-ui;box-shadow:0 1px 4px rgba(0,0,0,.5)">' + esc(e.short) + '</span><span style="background:rgba(11,18,32,.85);color:#fff;font:600 11px system-ui;padding:1px 5px;border-radius:4px">' + esc(e.name) + '</span></div>';
}

/* Pinta en rojo el patio y "borra" el rojo a lo largo del recorrido (ancho = distancia de visión) */
function drawCoverage(ctx, toPx, w, h, trackArg) {
  ctx.clearRect(0, 0, w, h);
  if (yard.boundary.length < 3) return;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = 'rgba(239,68,68,0.42)'; ctx.strokeStyle = 'rgba(239,68,68,0.9)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); yard.boundary.forEach((p, i) => { const q = toPx(p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }); ctx.closePath(); ctx.fill();
  const tr = trackArg || (run && run.track);
  if (!tr || !tr.length) return;
  const a = toPx(tr[0]), b = toPx({ lat: tr[0].lat + cfg.covRad / 110540, lng: tr[0].lng }), r = Math.max(1, Math.abs(a.y - b.y));
  ctx.globalCompositeOperation = 'destination-out';
  ctx.lineWidth = 2 * r; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#000';
  ctx.beginPath(); let prev = null;
  for (const p of tr) {
    const q = toPx(p);
    if (prev && p.t - prev.t < 90000 && hav(prev, p) < 60) ctx.lineTo(q.x, q.y); else { ctx.moveTo(q.x, q.y); ctx.lineTo(q.x + 0.1, q.y); }
    prev = p;
  }
  ctx.stroke();
  ctx.globalCompositeOperation = 'source-over';
}

function LeafletAdapter() {
  let m, gStops, gExits, gDraft, boundary, track, me, meAcc, canvas, covT = 0;
  function paint() {
    covT = 0; if (!m || !canvas) return;
    const s = m.getSize(); canvas.width = s.x; canvas.height = s.y;
    L.DomUtil.setPosition(canvas, m.containerPointToLayerPoint([0, 0]));
    drawCoverage(canvas.getContext('2d'), p => m.latLngToContainerPoint([p.lat, p.lng]), s.x, s.y);
  }
  let gShips = null, shipList = [];
  function cov() { if (!covT) covT = setTimeout(paint, 300); }
  return {
    name: 'leaflet',
    async init(el, center, zoom, onClick) {
      m = L.map(el, { preferCanvas: true, zoomControl: true }).setView([center.lat, center.lng], zoom);
      const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 21, maxNativeZoom: 19, attribution: 'Imágenes © Esri' });
      const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 21, maxNativeZoom: 19, attribution: '© OpenStreetMap' });
      sat.addTo(m); L.control.layers({ 'Satélite': sat, 'Calles': osm }, null, { position: 'topright' }).addTo(m);
      canvas = L.DomUtil.create('canvas', 'leaflet-zoom-hide'); canvas.style.pointerEvents = 'none';
      m.createPane('cov').style.zIndex = 390; m.getPane('cov').appendChild(canvas);
      m.on('moveend zoomend resize viewreset', paint);
      gStops = L.layerGroup().addTo(m); gExits = L.layerGroup().addTo(m); gDraft = L.layerGroup().addTo(m);
      track = L.polyline([], { color: COL.blu, weight: 4, opacity: .9 }).addTo(m);
      m.on('click', e => onClick({ lat: e.latlng.lat, lng: e.latlng.lng }));
    },
    center(p, z) { m.setView([p.lat, p.lng], z || m.getZoom()); },
    fit(pts) { if (pts.length) m.fitBounds(L.latLngBounds(pts.map(p => [p.lat, p.lng])), { padding: [20, 20] }); },
    boundary(pts) { if (boundary) boundary.remove(); boundary = pts.length >= 3 ? L.polygon(pts.map(p => [p.lat, p.lng]), { color: COL.wht, weight: 2, fill: false, dashArray: '6 4', interactive: false }).addTo(m) : null; },
    cells() { cov(); }, cell() { cov(); },
    track(pts) { track.setLatLngs(pts.map(p => [p.lat, p.lng])); cov(); },
    trackAdd(p) { track.addLatLng([p.lat, p.lng]); cov(); },
    me(p, acc) {
      if (!p) { if (me) { me.remove(); meAcc.remove(); me = meAcc = null; } return; }
      if (!me) { meAcc = L.circle([p.lat, p.lng], { radius: acc, color: COL.blu, weight: 1, fillOpacity: .12, interactive: false }).addTo(m); me = L.circleMarker([p.lat, p.lng], { radius: 8, color: '#fff', weight: 2, fillColor: COL.blu, fillOpacity: 1, interactive: false }).addTo(m); }
      else { me.setLatLng([p.lat, p.lng]); meAcc.setLatLng([p.lat, p.lng]).setRadius(acc); }
    },
    stops(list) { gStops.clearLayers(); list.forEach(s => s.sp ? L.marker([s.lat, s.lng], { icon: L.divIcon({ className: '', iconSize: null, html: spHtml(s) }) }).addTo(gStops) : L.circleMarker([s.lat, s.lng], { radius: 6 + Math.min(10, s.dur / 60000), color: '#000', weight: 1, fillColor: COL.amb, fillOpacity: .95 }).bindTooltip(fmtDur(s.dur) + ' parado').addTo(gStops)); },
    points(list) { gExits.clearLayers(); list.forEach(e => L.marker([e.lat, e.lng], { icon: L.divIcon({ className: '', iconSize: null, html: cpHtml(e) }) }).on('click', () => focusPoint(e.id)).addTo(gExits)); },
    draft(pts) { gDraft.clearLayers(); if (pts.length) { L.polyline(pts.map(p => [p.lat, p.lng]), { color: COL.amb, weight: 3 }).addTo(gDraft); pts.forEach(p => L.circleMarker([p.lat, p.lng], { radius: 5, color: COL.amb, fillOpacity: 1 }).addTo(gDraft)); } },
    ships(list) {
      if (!gShips) { gShips = L.layerGroup().addTo(m); m.on('zoomend', () => this.ships(shipList)); } shipList = list; gShips.clearLayers();
      const c = m.getCenter(), pxm = Math.pow(2, m.getZoom()) / (156543.03 * Math.cos(c.lat * Math.PI / 180));
      list.forEach(s => L.marker([s.lat, s.lng], { icon: L.divIcon({ className: '', iconSize: null, html: shipHtml(s, pxm) }), zIndexOffset: -100 }).on('click', () => shipInfo(s.mmsi)).addTo(gShips));
    }
  };
}

function GoogleAdapter(key) {
  let m, boundary, track, me, meAcc, stopsList = [], draftArr = [], ov, ptsOv, ptsList = [], covT = 0, shipOv, shipList = [];
  function cov() { if (!covT) covT = setTimeout(() => { covT = 0; ov && ov.draw(); }, 300); }
  const LL = p => ({ lat: p.lat, lng: p.lng });
  return {
    name: 'google',
    init(el, center, zoom, onClick) {
      return new Promise((res, rej) => {
        window.gm_authFailure = () => rej(new Error('Clave de Google rechazada'));
        window.__gmReady = () => {
          m = new google.maps.Map(el, { center, zoom, mapTypeId: 'hybrid', tilt: 0, gestureHandling: 'greedy', streetViewControl: false, mapTypeControl: true, mapTypeControlOptions: { mapTypeIds: ['roadmap', 'hybrid'], position: google.maps.ControlPosition.TOP_RIGHT, style: google.maps.MapTypeControlStyle.DROPDOWN_MENU }, fullscreenControl: false, clickableIcons: false });
          track = new google.maps.Polyline({ map: m, path: [], strokeColor: COL.blu, strokeWeight: 4, clickable: false, zIndex: 5 });
          m.addListener('click', e => onClick({ lat: e.latLng.lat(), lng: e.latLng.lng() }));
          // capa de cobertura: lienzo que cubre la vista con margen
          ov = new google.maps.OverlayView();
          ov.onAdd = function () { this.c = document.createElement('canvas'); this.c.style.cssText = 'position:absolute;pointer-events:none'; this.getPanes().overlayLayer.appendChild(this.c); };
          ov.draw = function () {
            const pr = this.getProjection(), b = m.getBounds(); if (!pr || !b || !this.c) return;
            const ne = pr.fromLatLngToDivPixel(b.getNorthEast()), sw = pr.fromLatLngToDivPixel(b.getSouthWest());
            const w = ne.x - sw.x, h = sw.y - ne.y, x0 = sw.x - w / 2, y0 = ne.y - h / 2, W = Math.round(w * 2), H = Math.round(h * 2);
            const c = this.c; c.width = W; c.height = H; c.style.left = x0 + 'px'; c.style.top = y0 + 'px';
            drawCoverage(c.getContext('2d'), p => { const q = pr.fromLatLngToDivPixel(new google.maps.LatLng(p.lat, p.lng)); return { x: q.x - x0, y: q.y - y0 }; }, W, H);
          };
          ov.setMap(m);
          // puntos de control como etiquetas HTML (mismo aspecto que sin Google)
          ptsOv = new google.maps.OverlayView();
          ptsOv.onAdd = function () { this.d = document.createElement('div'); this.d.style.cssText = 'position:absolute;left:0;top:0'; this.d.onclick = e => { const el = e.target.closest('[data-pid]'); if (el) { e.stopPropagation(); focusPoint(el.dataset.pid); } }; this.getPanes().overlayMouseTarget.appendChild(this.d); };
          ptsOv.draw = function () {
            const pr = this.getProjection(); if (!pr || !this.d) return;
            this.d.innerHTML = stopsList.map(s => { if (s.sp) { const q = pr.fromLatLngToDivPixel(new google.maps.LatLng(s.lat, s.lng)); return '<div style="position:absolute;left:' + q.x + 'px;top:' + q.y + 'px">' + spHtml(s) + '</div>'; } const q = pr.fromLatLngToDivPixel(new google.maps.LatLng(s.lat, s.lng)), r = 6 + Math.min(10, s.dur / 60000); return '<div title="' + fmtDur(s.dur) + ' parado" style="position:absolute;left:' + (q.x - r) + 'px;top:' + (q.y - r) + 'px;width:' + 2 * r + 'px;height:' + 2 * r + 'px;border-radius:50%;background:#f59e0b;border:1px solid #000;opacity:.95"></div>'; }).join('') + ptsList.map(e => { const q = pr.fromLatLngToDivPixel(new google.maps.LatLng(e.lat, e.lng)); return '<div data-pid="' + e.id + '" style="position:absolute;left:' + q.x + 'px;top:' + q.y + 'px;cursor:pointer">' + cpHtml(e) + '</div>'; }).join('');
          };
          ptsOv.setMap(m);
          // barcos (AIS) debajo del recorrido y de los avisos
          shipOv = new google.maps.OverlayView();
          shipOv.onAdd = function () { this.d = document.createElement('div'); this.d.style.cssText = 'position:absolute;left:0;top:0'; this.d.onclick = e => { const el = e.target.closest('[data-mmsi]'); if (el) { e.stopPropagation(); shipInfo(el.dataset.mmsi); } }; this.getPanes().overlayMouseTarget.prepend(this.d); };
          shipOv.draw = function () {
            const pr = this.getProjection(); if (!pr || !this.d) return;
            const c = m.getCenter(), a = pr.fromLatLngToDivPixel(c), b = pr.fromLatLngToDivPixel(new google.maps.LatLng(c.lat() + 100 / 111320, c.lng())), pxm = Math.abs(a.y - b.y) / 100;
            this.d.innerHTML = shipList.map(s => { const q = pr.fromLatLngToDivPixel(new google.maps.LatLng(s.lat, s.lng)); return '<div style="position:absolute;left:' + q.x + 'px;top:' + q.y + 'px">' + shipHtml(s, pxm) + '</div>'; }).join('');
          };
          shipOv.setMap(m);
          m.addListener('idle', () => ov.draw());
          res();
        };
        const s = document.createElement('script');
        s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) + '&callback=__gmReady&loading=async&language=es&region=ES';
        s.onerror = () => rej(new Error('No se pudo cargar Google Maps'));
        document.head.appendChild(s);
        setTimeout(() => rej(new Error('Google Maps tarda demasiado')), 15000);
      });
    },
    center(p, z) { m.setCenter(LL(p)); if (z) m.setZoom(z); },
    fit(pts) { if (!pts.length) return; const b = new google.maps.LatLngBounds(); pts.forEach(p => b.extend(LL(p))); m.fitBounds(b, 20); },
    boundary(pts) { if (boundary) boundary.setMap(null); boundary = pts.length >= 3 ? new google.maps.Polygon({ map: m, paths: pts.map(LL), strokeColor: COL.wht, strokeWeight: 2, fillOpacity: 0, clickable: false }) : null; },
    cells() { cov(); }, cell() { cov(); },
    track(pts) { track.setPath(pts.map(LL)); cov(); },
    trackAdd(p) { track.getPath().push(new google.maps.LatLng(p.lat, p.lng)); cov(); },
    me(p, acc) {
      if (!p) { if (me) { me.setMap(null); meAcc.setMap(null); me = meAcc = null; } return; }
      if (!me) {
        meAcc = new google.maps.Circle({ map: m, center: LL(p), radius: acc, strokeColor: COL.blu, strokeWeight: 1, fillColor: COL.blu, fillOpacity: .12, clickable: false });
        me = new google.maps.Marker({ map: m, position: LL(p), zIndex: 10, optimized: false, icon: { path: google.maps.SymbolPath.CIRCLE, scale: 8, fillColor: COL.blu, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 } });
      } else { me.setPosition(LL(p)); meAcc.setCenter(LL(p)); meAcc.setRadius(acc); }
    },
    stops(list) { stopsList = list; if (ptsOv) ptsOv.draw(); },
    points(list) { ptsList = list; if (ptsOv) ptsOv.draw(); },
    ships(list) { shipList = list; if (shipOv) shipOv.draw(); },
    draft(pts) { draftArr.forEach(x => x.setMap(null)); draftArr = []; if (pts.length) { draftArr.push(new google.maps.Polyline({ map: m, path: pts.map(LL), strokeColor: COL.amb, strokeWeight: 3, clickable: false })); pts.forEach(p => draftArr.push(new google.maps.Marker({ map: m, position: LL(p), clickable: false, icon: { path: google.maps.SymbolPath.CIRCLE, scale: 5, fillColor: COL.amb, fillOpacity: 1, strokeWeight: 0 } }))); } }
  };
}

/* Fuente AIS: en la APK por el servicio nativo (aisstream.io); en navegador, WebSocket directo */
const AIS_KEY = window.RONDAS_AIS_KEY || '';
let ships = {}, shipsOn = LS.get('rp_ships', true), shipWs = null, shipPoll = null;
function aisBox() {
  const b = yard.boundary; let la0 = 39.425, la1 = 39.452, ln0 = -0.335, ln1 = -0.300; // zona de APM / muelle Príncipe Felipe
  if (b && b.length >= 3) { la0 = Math.min(...b.map(p => p.lat)); la1 = Math.max(...b.map(p => p.lat)); ln0 = Math.min(...b.map(p => p.lng)); ln1 = Math.max(...b.map(p => p.lng)); }
  const m = 0.012; return [[la0 - m, ln0 - m], [la1 + m, ln1 + m]];
}
function shipMsg(o) {
  const md = o.MetaData || {}, id = String(md.MMSI || ''); if (!id) return;
  const s = ships[id] || (ships[id] = { mmsi: id });
  if (md.ShipName && md.ShipName.trim()) s.name = md.ShipName.trim();
  const m = o.Message || {}, pr = m.PositionReport || m.StandardClassBPositionReport || m.ExtendedClassBPositionReport, sd = m.ShipStaticData || (m.StaticDataReport && m.StaticDataReport.ReportB);
  if (pr) { s.lat = pr.Latitude; s.lng = pr.Longitude; s.sog = pr.Sog; s.cog = pr.Cog; s.hdg = pr.TrueHeading; if (pr.NavigationalStatus != null) s.nav = pr.NavigationalStatus; s.t = Date.now(); }
  else if (md.latitude != null && s.lat == null) { s.lat = md.latitude; s.lng = md.longitude; s.t = Date.now(); }
  if (sd) { if (sd.Type != null || sd.ShipType != null) s.type = sd.Type != null ? sd.Type : sd.ShipType; const d = sd.Dimension; if (d) { s.a = d.A; s.b = d.B; s.c = d.C; s.d = d.D; } if (sd.Destination) s.dest = String(sd.Destination).trim(); if (sd.Name && sd.Name.trim()) s.name = sd.Name.trim(); }
}
function drawShips() {
  const now = Date.now(); Object.keys(ships).forEach(k => { if (!ships[k].t || now - ships[k].t > 40 * 60000) delete ships[k]; });
  const list = shipsOn ? Object.values(ships).filter(s => s.lat != null && Math.abs(s.lat) <= 90) : [];
  if (map && map.ships) map.ships(list);
  $('shipsN').textContent = shipsOn && list.length ? ' ' + list.length : '';
}
function startShips() {
  if (!AIS_KEY || !shipsOn) return;
  if (RN && RN.shipsStart) {
    RN.shipsStart({ key: AIS_KEY, box: aisBox() }).catch(() => { });
    if (!shipPoll) shipPoll = setInterval(async () => { try { const r = await RN.ships(); (r.msgs || []).forEach(t => { try { shipMsg(JSON.parse(t)); } catch (e) { } }); drawShips(); } catch (e) { } }, 4000);
    return;
  }
  if (shipWs) return;
  try {
    shipWs = new WebSocket('wss://stream.aisstream.io/v0/stream');
    shipWs.onopen = () => shipWs.send(JSON.stringify({ APIKey: AIS_KEY, BoundingBoxes: [aisBox()] }));
    shipWs.onmessage = async e => { try { shipMsg(JSON.parse(typeof e.data === 'string' ? e.data : await e.data.text())); } catch (x) { } };
    shipWs.onclose = () => { shipWs = null; if (shipsOn) setTimeout(startShips, 15000); };
  } catch (e) { shipWs = null; }
  if (!shipPoll) shipPoll = setInterval(drawShips, 4000);
}
function stopShips() {
  if (RN && RN.shipsStop) RN.shipsStop().catch(() => { });
  if (shipWs) { const w = shipWs; shipWs = null; w.onclose = null; w.close(); }
  clearInterval(shipPoll); shipPoll = null; drawShips();
}
document.addEventListener('visibilitychange', () => { if (!AIS_KEY) return; if (document.visibilityState === 'visible') startShips(); else if (RN) RN.shipsStop && RN.shipsStop().catch(() => { }); });

let map;
async function initMap() {
  const center = yard.boundary[0] || LS.get('rp_lastpos', VLC);
  const zoom = yard.boundary.length ? 17 : 16;
  const el = $('map');
  if (cfg.gkey) {
    try { map = GoogleAdapter(cfg.gkey); await map.init(el, center, zoom, onMapClick); }
    catch (e) { banner('Google Maps no disponible (' + e.message + '). Usando mapa alternativo.', 'warn', 8000); el.innerHTML = ''; map = null; }
  }
  if (!map) { map = LeafletAdapter(); await map.init(el, center, zoom, onMapClick); }
  redrawYard();
  if (yard.boundary.length >= 3) map.fit(yard.boundary);
}

/* ---------- Utilidades UI ---------- */
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtDur(ms) { const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + String(ss).padStart(2, '0'); }
function fmtAgo(ms) { const m = Math.floor(ms / 60000); return m < 1 ? 'hace <1 min' : m < 60 ? 'hace ' + m + ' min' : 'hace ' + Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; }
function fmtMin(ms) { const m = Math.round(ms / 60000); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; }
function fmtDist(m) { return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(2) + ' km'; }
function fmtTime(t) { return new Date(t).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function fmtHM(t) { return new Date(t).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }); }
function fmtDate(t) { return new Date(t).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
let bannerT;
function banner(msg, kind, ms) { const b = $('banner'); b.textContent = msg; b.className = kind || ''; b.style.display = msg ? 'block' : 'none'; clearTimeout(bannerT); if (ms) bannerT = setTimeout(() => { b.style.display = 'none'; }, ms); }
/* ---------- Pitidos de alarma (Web Audio, volumen multimedia) ---------- */
let actx = null;
function audio() { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch (e) { } return actx; }
['touchstart', 'click'].forEach(ev => document.addEventListener(ev, () => audio(), { passive: true }));
function beep(seq) { if (RN) return; // seq: [[frecuencia Hz, duración ms], ...] ; frecuencia 0 = silencio
  const c = audio(); if (!c) return; let t = c.currentTime + 0.02;
  seq.forEach(([f, d]) => { if (f) { const o = c.createOscillator(), g = c.createGain(); o.type = 'square'; o.frequency.value = f; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.9, t + 0.01); g.gain.setValueAtTime(0.9, t + d / 1000 - 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d / 1000); o.connect(g).connect(c.destination); o.start(t); o.stop(t + d / 1000 + 0.02); } t += d / 1000; });
}
const SND = {
  warn: () => { beep([[2000, 180], [0, 120], [2000, 180], [0, 120], [2000, 180]]); vibrate([200, 100, 200, 100, 200]); },
  alarm: () => { const s = []; for (let i = 0; i < 6; i++) s.push([2900, 220], [1900, 220]); beep(s); vibrate([800, 200, 800, 200, 800]); },
  speed: () => { beep([[2400, 120], [0, 80], [2400, 120], [0, 80], [2400, 120], [0, 80], [2400, 120]]); vibrate([150, 80, 150, 80, 150]); },
};
// vigila la parada en curso aunque no lleguen posiciones nuevas: aviso 1 min antes y alarma repetida cada 30 s
setInterval(() => {
  if (!run || run.end || !run.inStop || !run.anchor || !(cfg.stopAlarm > 0) || run.relevo) return;
  const dt = nowT() - run.anchor.t, lim = cfg.stopAlarm * 60000;
  if (dt >= lim) {
    if (!run.alarmed) { run.alarmed = true; logEv('Parado más de ' + cfg.stopAlarm + ' min', run.anchor, 'bad'); }
    if (!run.lastAlarm || Date.now() - run.lastAlarm >= 30000) { run.lastAlarm = Date.now(); if (!run.stopNotif) SND.alarm(); banner('PARADO MÁS DE ' + cfg.stopAlarm + ' MIN: muévete, queda registrado como incidencia', 'bad', 8000); }
  } else if (cfg.stopAlarm >= 2 && dt >= lim - 60000 && !run.prewarned) {
    run.prewarned = true; if (!run.stopNotif) SND.warn(); banner('Llevas ' + fmtMin(dt) + ' parado: en 1 min salta la alarma', 'warn', 6000);
  }
}, 3000);
function vibrate(p) { try { navigator.vibrate && navigator.vibrate(p); } catch (e) { } }
function setKpi(id, val, sub, cls, label) { const el = $(id); if (label) el.querySelector('span').textContent = label; el.querySelector('b').textContent = val; el.querySelector('em').textContent = sub || ' '; el.className = 'kpi' + (el.classList.contains('xl') ? ' xl' : '') + (cls ? ' ' + cls : ''); }

/* ---------- Patio: límite y puntos de control ---------- */
function shortName(cp, k) { return cp.type === 'salida' ? 'S' + (yard.points.filter((c, i) => c.type === 'salida' && i <= k).length) : 'P' + (yard.points.filter((c, i) => c.type !== 'salida' && i <= k).length); }
function redrawYard() {
  buildGrid();
  if (run) cells.forEach(c => { if (run.covered && run.covered[c.i + ',' + c.j]) { c.covered = true; c.at = run.covered[c.i + ',' + c.j]; } });
  map.boundary(yard.boundary); map.cells(cells); map.draft(draft);
  const info = $('yardInfo');
  const np = yard.points.filter(p => p.type !== 'salida').length, ns = yard.points.length - np;
  info.textContent = (yard.boundary.length < 3 ? 'Sin límite del patio: pulsa "Dibujar límite" y toca cada esquina del recinto. ' : 'Patio de ' + Math.round(polyArea(proj.poly)).toLocaleString('es-ES') + ' m². ') +
    np + ' puntos de control y ' + ns + ' salidas. Una ronda está completa cuando el vigilante pasa por todos.';
  $('cpEdit').innerHTML = yard.points.map((c, k) => '<div class="cpe"><span class="pill ' + (c.type === 'salida' ? 'acc' : 'idle') + '">' + shortName(c, k) + '</span><span class="grow">' + esc(c.name) + '</span><button class="btn sm" data-ren="' + k + '">Renombrar</button><button class="btn sm" data-del="' + k + '">Quitar</button></div>').join('');
  lastSig = ''; renderAll();
}
function saveYard() { LS.set('rp_yard', yard); redrawYard(); }
function onMapClick(p) {
  if (editMode === 'boundary') { draft.push(p); map.draft(draft); }
  else if (editMode === 'punto' || editMode === 'salida') {
    const type = editMode, n = yard.points.filter(c => c.type === type).length + 1;
    const name = prompt(type === 'salida' ? 'Nombre de la salida' : 'Nombre del punto de control', type === 'salida' ? 'Salida ' + n : 'Punto ' + n);
    endEdit();
    if (name) { yard.points.push({ id: 'c' + Date.now().toString(36), name, type, lat: p.lat, lng: p.lng }); saveYard(); }
  }
}
function demoYard() {
  const c = run && run.last ? run.last : LS.get('rp_lastpos', null) || mapCenter();
  const P = makeProj(c.lat, c.lng);
  yard.boundary = [P.ll(-120, -80), P.ll(120, -80), P.ll(120, 80), P.ll(-120, 80)];
  const pt = (x, y, name, type) => ({ id: 'd' + name.replace(/\W/g, ''), name, type: type || 'punto', ...P.ll(x, y) });
  yard.points = [];
  saveYard(); map.fit(yard.boundary);
}
function mapCenter() { return yard.boundary[0] || LS.get('rp_lastpos', VLC); }
function focusPoint(id) { const c = yard.points.find(x => x.id === id); if (c) { map.center(c, 19); switchTab('pControl'); } }

/* ---------- Turno ---------- */
function newRun() {
  return { id: Date.now(), guard: $('guard').value.trim() || LS.get('rp_guard', ''), start: Date.now(), end: null, paused: false, pausedMs: 0, pauseAt: null,
    track: [], dist: 0, maxSpeed: 0, speed: 0, stops: [], events: [], covered: {}, rejected: 0, fixes: 0,
    noSignalMs: 0, outside: false, anchor: null, inStop: false, alarmed: false, last: null, lastAcceptT: null,
    passes: [], lastPass: {}, rounds: [], roundStart: null, roundVisited: {}, near: {}, overdue: {}, gaps: [] };
}
let kf = Kalman(3);
const hhmm = m => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
function parsePresets() {
  return String(cfg.presets || '').split(/[,;]+/).map(x => x.trim()).map(x => {
    const m = x.match(/^(\d{1,2})(?:[:.h](\d{2}))?\s*[-–a]\s*(\d{1,2})(?:[:.h](\d{2}))?$/);
    if (!m) return null;
    const s0 = (+m[1]) * 60 + (+m[2] || 0), e0 = (+m[3]) * 60 + (+m[4] || 0);
    return s0 < 1440 && e0 <= 1440 && s0 !== e0 ? { s: s0, e: e0 % 1440, label: hhmm(s0) + '–' + hhmm(e0) } : null;
  }).filter(Boolean);
}
// siguiente hora (en minutos del día) después de t
function nextAt(t, min) { const d = new Date(t); let c = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(min / 60), min % 60, 0).getTime(); if (c <= t) c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, Math.floor(min / 60), min % 60, 0).getTime(); return c; }
// cambio de turno automático: el siguiente inicio o fin de cualquier turno disponible
function nextShift(t) {
  const marks = []; parsePresets().forEach(p => { marks.push(p.s, p.e); });
  if (!marks.length) return Infinity;
  return Math.min(...marks.map(m => nextAt(t, m)));
}
function openShiftSheet() {
  if (viewing) backToLive();
  const ps = parsePresets(), cur = run && run.shiftLabel;
  $('sGuard').value = (run && run.guard) || LS.get('rp_guard', '');
  $('presetBtns').innerHTML = ps.map((p, k) => '<button class="preset' + (cur === p.label ? ' on' : '') + '" data-k="' + k + '">' + p.label + '</button>').join('');
  const best = ps.find(p => cur === p.label) || ps[0];
  $('sStart').value = best ? hhmm(best.s) : ''; $('sEnd').value = best ? hhmm(best.e) : '';
  $('shiftSheet').style.display = 'flex';
}
function chooseShift() {
  const st = $('sStart').value, en = $('sEnd').value;
  if (!en) { banner('Indica la hora de salida', 'warn', 2500); return; }
  const toMin = v => { const [a, b] = v.split(':').map(Number); return a * 60 + b; };
  const endTs = nextAt(Date.now(), toMin(en)), label = (st || hhmm(new Date().getHours() * 60 + new Date().getMinutes())) + '–' + en;
  const guard = $('sGuard').value.trim(); LS.set('rp_guard', guard); $('guard').value = guard;
  $('shiftSheet').style.display = 'none';
  if (simTimer) return;
  // el turno anterior se guarda si tenía actividad; si estaba recién empezado se descarta
  // si el seguimiento automático acaba de empezar (sin turno elegido, < 15 min), se incorpora al turno elegido en vez de crear un turno aparte
  const adopt = run && !run.end && !run.sim && !run.shiftLabel && elapsed(run) < 15 * 60000;
  if (!adopt) {
    if (run && !run.end) { if (elapsed(run) > 2 * 60000 || run.track.length > 5) finishRun(); else { stopGps(); run = null; LS.set('rp_run', null); } }
    run = null; startRun(); run.events = [];
  }
  run.periodEnd = endTs; run.shiftLabel = label; run.guard = guard;
  logEv('Inicio de turno ' + label + (guard ? ' · ' + guard : ''), null, 'acc');
  persist(true); renderEvents(); renderAll();
  banner('Turno ' + label + ' empezado', '', 2500);
}
function startRun(sim) {
  if (run && !run.end) return;
  run = newRun(); run.start = run.roundStart = nowT(); run.periodEnd = sim === true ? Infinity : nextShift(run.start); run.sim = sim === true; kf = Kalman(3);
  cells.forEach(c => { c.covered = false; c.at = null; }); map.cells(cells); map.track([]); map.stops([]);
  logEv('Inicio de turno' + (run.guard ? ' · ' + run.guard : '') + (run.sim ? ' (simulación)' : ''), null, 'acc');
  if (sim !== true) startGps(); keepAwake(); persist(true); lastSig = ''; renderAll();
}
function finishRun() {
  const t = nowT();
  if (run.paused) { run.pausedMs += t - run.pauseAt; run.paused = false; }
  closeStop(t); closeSpeed();
  if (run.lastAcceptT && t - run.lastAcceptT > GAP_MS) logGap(run.lastAcceptT, t);
  else if (!run.lastAcceptT && !run.sim && t - run.start > GAP_MS) logGap(run.start, t);
  run.end = t;
  run.coverage = covPct(); run.cellsTotal = cells.length;
  run.points = yard.points.map(c => ({ id: c.id, name: c.name, type: c.type }));
  run.expected = expectedRounds(run); run.compliance = compliance(run);
  logEv('Fin de turno · ' + run.rounds.length + ' rondas · cumplimiento ' + (run.compliance ?? '–') + '%', null, 'acc');
  stopGps(); stopSim(); simClock = null; releaseAwake();
  const h = LS.get('rp_hist', []); h.unshift(slim(run)); LS.set('rp_hist', h.slice(0, 60));
  LS.set('rp_run', null); renderHist();
}
function slim(r) { const o = Object.assign({}, r); delete o.anchor; delete o.near; delete o.overdue; return o; }
let persistT = 0;
function persist(force) { if (!run || run.end || viewing) return; const t = Date.now(); if (!force && t - persistT < 5000) return; persistT = t; LS.set('rp_run', run); }
function elapsed(r) { const end = r.end || nowT(); return end - r.start - r.pausedMs - (r.paused ? end - r.pauseAt : 0); }
function stoppedMs(r) { let s = r.stops.reduce((a, x) => a + x.dur, 0); if (r.inStop && r.anchor && !r.end) s += nowT() - r.anchor.t; return s; }
let evT = null; // hora de la posición que se está procesando (las recogidas del servicio nativo llegan con retraso)
function logEv(txt, p, kind) { if (!run) return; run.events.push({ t: evT != null ? evT : nowT(), txt, k: kind || '', lat: p && p.lat, lng: p && p.lng }); renderEvents(); }
function expectedRounds(r) { const pts = r.points || yard.points; if (!pts.length) return null; return Math.max(1, Math.floor(elapsed(r) / (cfg.freqMin * 60000))); }
function compliance(r) { const e = expectedRounds(r); return e == null ? null : Math.min(100, Math.round(100 * r.rounds.length / e)); }
function cpStatus(cp, r) {
  const now = r.end || nowT(), due = cfg.freqMin * 60000, last = r.lastPass[cp.id];
  if (last == null) return now - r.start >= due ? { k: 'bad', txt: 'Sin pasar' } : { k: 'idle', txt: 'Pendiente', left: due - (now - r.start) };
  const s = now - last;
  if (s >= due) return { k: 'bad', txt: 'Atrasado', since: s };
  if (s >= due * 0.8) return { k: 'warn', txt: 'Toca pasar', since: s, left: due - s };
  return { k: 'ok', txt: 'Al día', since: s, left: due - s };
}
function gapMs(r) { return (r.gaps || []).reduce((a, g) => a + g.dur, 0); }
function maxGap(cp, r) {
  const ts = r.passes.filter(p => p.id === cp.id).map(p => p.t), end = r.end || nowT();
  const all = [r.start, ...ts, end]; let g = 0;
  for (let i = 1; i < all.length; i++) g = Math.max(g, all[i] - all[i - 1]);
  return g;
}

/* Procesa cada posición del GPS (real o simulada) */
let fixBatch = false;
function onFix(raw) {
  const t = raw.t, acc = raw.acc;
  lastFixAt = Date.now(); lastRawAcc = acc;
  LS.set('rp_lastpos', { lat: raw.lat, lng: raw.lng });
  gpsBadge(acc);
  if (viewing) backToLive();
  if (!run || run.end) { map.me(raw, acc); return; }
  run.fixes++;
  // 1) Descarta posiciones poco precisas (rebotes entre pilas de contenedores)
  if (acc > cfg.maxAcc) { run.rejected++; return; }
  // 2) Descarta saltos imposibles
  if (run.last) {
    const dt = (t - run.lastAcceptT) / 1000, d = hav(run.last, raw);
    if (dt > 0 && d > Math.max(acc, 5) && d / dt * 3.6 > cfg.jumpSpd) { run.rejected++; return; }
    if (dt > 20) run.noSignalMs += (dt - 20) * 1000;
  }
  // Hueco sin señal válida (app cerrada, móvil apagado o dentro de un contenedor)
  if (run.lastAcceptT && t - run.lastAcceptT > GAP_MS) logGap(run.lastAcceptT, t);
  lastValidAt = Date.now();
  if (noFixBanner) { noFixBanner = false; banner(''); }
  // 3) Suavizado
  const p = kf.step(raw, acc, t); p.t = t; p.acc = acc;
  if (!fixBatch) map.me(p, acc);
  let spd = 0;
  if (run.last) {
    const dt = (t - run.lastAcceptT) / 1000, d = hav(run.last, p);
    spd = raw.speed != null && raw.speed >= 0 && acc <= 15 ? raw.speed * 3.6 : (dt > 0 ? d / dt * 3.6 : 0);
    if (d < Math.min(acc * 0.4, 3)) spd = 0;
  }
  run.speed = run.speed * 0.5 + spd * 0.5;
  // velocidad para el control de excesos: la del GPS si la da; si no, entre posiciones sin suavizar
  let vRaw = raw.speed != null && raw.speed >= 0 ? raw.speed * 3.6 : null;
  if (vRaw == null && run.lastRaw) { const dt = (t - run.lastRaw.t) / 1000; vRaw = dt > 0 ? hav(run.lastRaw, raw) / dt * 3.6 : 0; }
  run.lastRaw = { lat: raw.lat, lng: raw.lng, t };
  checkSpeed(vRaw || 0, raw, t, acc);
  // 4) Recorrido (ignora el temblor del GPS)
  const lp = run.track[run.track.length - 1];
  const step = lp ? hav(lp, p) : Infinity;
  if (step >= Math.max(2.5, acc * 0.3)) {
    if (lp) run.dist += step;
    run.track.push({ lat: +p.lat.toFixed(7), lng: +p.lng.toFixed(7), t, a: Math.round(acc) });
    if (!fixBatch) map.trackAdd(p);
    if (run.speed > run.maxSpeed && run.speed < cfg.jumpSpd) run.maxSpeed = run.speed;
  }
  // 5) Patio vigilado
  if (coverAt(p, t)) cells.forEach(c => { if (c.covered) run.covered[c.i + ',' + c.j] = c.at; });
  // 6) Paradas
  detectStop(p, t);
  // 7) Control de paso por puntos y salidas
  checkPoints(p, t, acc);
  // 8) Fuera del recinto
  if (proj) {
    const ins = insideYard(p);
    if (!ins && !run.outside && acc < 20) { run.outside = true; logEv('Sale del recinto', p, 'warn'); vibrate([200, 100, 200]); }
    if (ins && run.outside) { run.outside = false; logEv('Vuelve al recinto', p, ''); }
  }
  run.last = { lat: p.lat, lng: p.lng }; run.lastAcceptT = t;
  if (!fixBatch) { renderAll(); persist(); }
}
/* Exceso de velocidad: 3 posiciones seguidas por encima del límite con buena precisión */
function checkSpeed(spd, p, t, acc) {
  run.speeding = run.speeding || [];
  const lim = cfg.speedLimit;
  if (!lim) return;
  if (spd > lim && acc <= 20) {
    run.osN = (run.osN || 0) + 1; run.osLow = 0;
    if (run.osN === 1) run.osPre = { t, max: spd, lat: p.lat, lng: p.lng };
    else if (run.osPre && spd > run.osPre.max) Object.assign(run.osPre, { max: spd, lat: p.lat, lng: p.lng });
    if (run.os) run.os.end = null;
    if (!run.os && run.osN >= 3) { const q = run.osPre || { t, max: spd, lat: p.lat, lng: p.lng }; run.os = { from: q.t, to: t, max: q.max, lat: q.lat, lng: q.lng }; SND.speed(); notify([{ id: 9100 + (run.speeding.length % 50), title: '⚠ Más de ' + lim + ' km/h', body: Math.round(spd) + ' km/h a las ' + fmtHM(t) + ': queda registrado' }]); banner('Más de ' + lim + ' km/h: queda registrado', 'bad', 5000); }
    else if (run.os) { run.os.to = t; if (spd > run.os.max) { run.os.max = spd; run.os.lat = p.lat; run.os.lng = p.lng; } }
  } else {
    run.osN = 0;
    if (run.os && !run.osLow) run.os.end = t; // primer momento por debajo del límite
    if (run.os && ++run.osLow >= 2) closeSpeed();
  }
}
function closeSpeed() {
  const o = run && run.os; if (!o) return;
  o.max = Math.round(o.max); o.secs = Math.max(1, Math.round(((o.end || o.to) - o.from) / 1000)); delete o.end; run.speeding.push(o); run.os = null; run.osLow = 0;
  run.events.push({ t: o.from, txt: 'Exceso de velocidad: ' + o.max + ' km/h (límite ' + cfg.speedLimit + ') a las ' + fmtHM(o.from) + ', durante ' + fmtSec(spSecs(o)), k: 'bad', lat: o.lat, lng: o.lng });
  run.events.sort((a, b) => a.t - b.t);
  map.stops(markList(run)); renderEvents();
}
function markList(r) { return (r.stops || []).concat((r.speeding || []).map(o => ({ ...o, sp: true }))); }
const GAP_MS = 2 * 60000;
function logGap(from, to) {
  const g = { from, to, dur: to - from, lat: run.last && run.last.lat, lng: run.last && run.last.lng };
  run.gaps = run.gaps || []; run.gaps.push(g);
  run.events.push({ t: to, txt: 'Sin señal GPS ' + fmtMin(g.dur) + ' (de ' + fmtHM(from) + ' a ' + fmtHM(to) + '): app en segundo plano o cerrada, móvil apagado o GPS sin precisión', k: 'bad', lat: g.lat, lng: g.lng });
  renderEvents();
}
function checkPoints(p, t, acc) {
  if (!yard.points.length) return;
  const R = cfg.cpRad + Math.min(acc * 0.5, 10);
  yard.points.forEach(cp => {
    const d = hav(cp, p), near = d <= R;
    if (near && !run.near[cp.id]) {
      run.near[cp.id] = true;
      const prev = run.lastPass[cp.id];
      run.lastPass[cp.id] = t; run.overdue[cp.id] = false;
      run.passes.push({ id: cp.id, name: cp.name, t, lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6) });
      logEv('Paso por ' + cp.name + (prev ? ' (anterior ' + fmtAgo(t - prev) + ')' : ''), cp, 'ok');
      vibrate(80);
      if (!run.roundVisited[cp.id]) {
        run.roundVisited[cp.id] = true;
        if (yard.points.every(c => run.roundVisited[c.id])) {
          const n = run.rounds.length + 1;
          run.rounds.push({ n, start: run.roundStart, end: t, dur: t - run.roundStart });
          logEv('Ronda ' + n + ' completa en ' + fmtMin(t - run.roundStart), cp, 'acc');
          vibrate([120, 80, 120]);
          run.roundVisited = { [cp.id]: true }; run.roundStart = t;
        }
      }
    }
    if (!near && d > R + 15) run.near[cp.id] = false;
  });
}
function checkOverdue() {
  if (!run || run.end || viewing) return;
  yard.points.forEach(cp => {
    const s = cpStatus(cp, run);
    if (s.k === 'bad' && !run.overdue[cp.id]) { run.overdue[cp.id] = true; logEv('Sin pasar por ' + cp.name + ' en ' + cfg.freqMin + ' min', cp, 'bad'); vibrate([300, 100, 300]); }
  });
}
/* Modo relevo: silencia la alarma de parado; se apaga solo al alejarse 20 m */
const RELEVO_M = 20;
function setRelevo(on, why) {
  if (!run || run.end || !!run.relevo === on) return;
  if (on) { run.relevo = { t: nowT(), lat: run.last && run.last.lat, lng: run.last && run.last.lng }; if (run.anchor) run.anchor.relevo = true; cancelStopAlarm(); logEv('Modo relevo activado', run.last, 'acc'); banner('Modo relevo: la alarma de parado no suena. Se quita sola al moverte.', '', 5000); }
  else { const d = nowT() - run.relevo.t; run.relevo = null; logEv('Modo relevo terminado' + (why ? ' (' + why + ')' : '') + ' tras ' + fmtMin(d), run.last, 'acc'); banner('Modo relevo desactivado' + (why ? ': ' + why : ''), '', 4000); }
  if (RN && RN.relevo) RN.relevo({ on }).catch(() => { });
  renderRelevo(); persist(true);
}
function renderRelevo() { const b = $('bRelevo'); if (!b) return; const on = !!(run && run.relevo); b.classList.toggle('on', on); b.textContent = on ? '🔕 Relevo ON' : 'Modo relevo'; }
function detectStop(p, t) {
  if (run.relevo) {
    if (run.relevo.lat == null) { run.relevo.lat = p.lat; run.relevo.lng = p.lng; }
    else if (hav(run.relevo, p) > RELEVO_M) { const e0 = evT; if (e0 == null) evT = t; setRelevo(false, 'movimiento detectado'); evT = e0; }
  }
  const a = run.anchor;
  if (!a) { run.anchor = { lat: p.lat, lng: p.lng, t, n: 1 }; return; }
  const d = hav(a, p);
  if (d <= cfg.stopRad + Math.min(p.acc * 0.3, 6)) {
    a.lat = (a.lat * a.n + p.lat) / (a.n + 1); a.lng = (a.lng * a.n + p.lng) / (a.n + 1); a.n++;
    if (!run.inStop && t - a.t >= cfg.stopSec * 1000) { run.inStop = true; run.speed = 0; scheduleStopAlarm(); }
    if (run.inStop && cfg.stopAlarm > 0 && !run.alarmed && !run.relevo && t - a.t >= cfg.stopAlarm * 60000) {
      run.alarmed = true; run.lastAlarm = Date.now(); if (!run.stopNotif) SND.alarm(); logEv('Parado más de ' + cfg.stopAlarm + ' min', a, 'bad');
    }
  } else {
    closeStop(t);
    run.anchor = { lat: p.lat, lng: p.lng, t, n: 1 };
  }
}
function closeStop(t) {
  if (run && run.inStop && run.anchor) {
    const s = { lat: run.anchor.lat, lng: run.anchor.lng, from: run.anchor.t, to: t, dur: t - run.anchor.t };
    if (run.relevo || run.anchor.relevo) s.relevo = true;
    run.stops.push(s); map.stops(markList(run));
    logEv('Parada de ' + fmtMin(s.dur) + ' (desde ' + fmtHM(s.from) + ')' + (s.relevo ? ' · relevo' : ''), s, isLong(s) ? 'bad' : 'warn');
  }
  if (run) { cancelStopAlarm(); run.inStop = false; run.alarmed = false; run.prewarned = false; run.lastAlarm = 0; }
}

/* ---------- GPS ---------- */
/* ---------- Nativo (APK): GPS en segundo plano y alarmas como notificación ---------- */
const CAP = window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform() ? window.Capacitor.Plugins : null;
const RN = CAP && CAP.RondasNative; // servicio nativo propio: GPS + alarmas con la pantalla apagada
const BG = !RN && CAP && CAP.BackgroundGeolocation, LN = !RN && CAP && CAP.LocalNotifications;
let rnListen = false, rnBusy = false, rnLastT = 0;
// recoge las posiciones que el servicio nativo guardó (también las de pantalla bloqueada) y las procesa en orden
async function rnDrain() {
  if (rnBusy) return; rnBusy = true;
  try {
    for (let k = 0; k < 40; k++) {
      const since = +(LS.get('rp_rnsince') || 0) || Date.now() - 5000;
      const r = await RN.drain({ since }); const list = (r && r.fixes) || [];
      if (!list.length) { if (!LS.get('rp_rnsince')) LS.set('rp_rnsince', since); break; }
      const many = list.length > 5; fixBatch = many;
      list.forEach(f => {
        if (f[4] <= rnLastT) return; rnLastT = f[4]; // nunca procesar dos veces ni hacia atrás
        if (!run || run.end || f[4] >= (run.start || 0) - 1000) { evT = f[4]; try { onFix({ lat: f[0], lng: f[1], acc: f[2], speed: f[3] < 0 ? null : f[3], t: f[4] }); } finally { evT = null; } }
      });
      LS.set('rp_rnsince', list[list.length - 1][4]);
      if (many) { fixBatch = false; if (run) { run.events.sort((a, b) => a.t - b.t); map.track(run.track); map.stops(markList(run)); renderEvents(); renderAll(); persist(true); } }
      if (list.length < 5000) break;
    }
  } catch (e) { fixBatch = false; }
  rnBusy = false;
}
function nativeCfg() { return { speedLimit: +cfg.speedLimit || 0, stopAlarm: +cfg.stopAlarm || 0, stopRad: +cfg.stopRad, stopSec: +cfg.stopSec, maxAcc: +cfg.maxAcc, jumpSpd: +cfg.jumpSpd }; }
let bgWatch = null, lnReady = null;
function notifReady() {
  if (!LN) return Promise.resolve(false);
  return lnReady = lnReady || (async () => {
    try {
      const p = await LN.requestPermissions(); if (p.display !== 'granted') return false;
      await LN.createChannel({ id: 'alarma', name: 'Alarmas de ronda', description: 'Paradas largas y excesos de velocidad', importance: 5, visibility: 1, sound: 'alarma.wav', vibration: true, lights: true, lightColor: '#FF0000' });
      return true;
    } catch (e) { return false; }
  })();
}
async function notify(items) { // items: [{id, title, body, at?}]
  if (!(await notifReady())) return;
  try { await LN.schedule({ notifications: items.map(n => ({ id: n.id, title: n.title, body: n.body, channelId: 'alarma', smallIcon: 'ic_stat_alarm', schedule: n.at ? { at: new Date(n.at), allowWhileIdle: true } : undefined })) }); } catch (e) { }
}
const STOP_IDS = Array.from({ length: 22 }, (_, i) => 9000 + i);
// al empezar una parada se programan el aviso y la alarma en el sistema: suenan aunque la pantalla esté apagada
function scheduleStopAlarm() {
  if (!LN || !run || run.sim || !run.anchor || !(cfg.stopAlarm > 0) || run.relevo) return;
  const at0 = run.anchor.t + cfg.stopAlarm * 60000, now = Date.now(), list = [];
  if (cfg.stopAlarm >= 2) list.push({ id: STOP_IDS[0], at: at0 - 60000, title: 'Llevas ' + (cfg.stopAlarm - 1) + ' min parado', body: 'Muévete: en 1 minuto salta la alarma' });
  for (let k = 0; k < 20; k++) list.push({ id: STOP_IDS[k + 1], at: at0 + k * 30000, title: '⚠ PARADO MÁS DE ' + (cfg.stopAlarm + Math.floor(k / 2)) + ' MIN', body: 'Queda registrado como incidencia. Muévete para que pare la alarma.' });
  run.stopNotif = true; notify(list.filter(n => n.at > now - 5000).map(n => ({ ...n, at: Math.max(n.at, now + 1000) })));
}
function cancelStopAlarm() { if (!LN || !run || !run.stopNotif) return; run.stopNotif = false; LN.cancel({ notifications: STOP_IDS.map(id => ({ id })) }).catch(() => { }); }
function startGps() {
  if (RN) {
    if (!rnListen) { rnListen = true; setInterval(rnDrain, 1500); document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') rnDrain(); }); }
    RN.start(nativeCfg()).catch(e => { banner(/NOT_AUTHORIZED|denegado/.test(e.code + e.message) ? 'Permiso de ubicación denegado. Actívalo en Ajustes > Apps > Control de Rondas.' : 'No se pudo iniciar el GPS: ' + e.message, 'bad', 8000); });
    return;
  }
  if (BG) {
    if (bgWatch != null) return; bgWatch = 'pending'; notifReady();
    BG.addWatcher({ backgroundTitle: 'Control de Rondas', backgroundMessage: 'Vigilancia GPS activa', requestPermissions: true, stale: false, distanceFilter: 0 }, (loc, err) => {
      if (err) { banner(err.code === 'NOT_AUTHORIZED' ? 'Permiso de ubicación denegado. Actívalo en Ajustes para registrar las rondas.' : 'Sin señal GPS (' + err.message + ')', err.code === 'NOT_AUTHORIZED' ? 'bad' : 'warn', 6000); if (err.code === 'NOT_AUTHORIZED') setTimeout(() => BG.openSettings(), 2500); return; }
      if (loc) onFix({ lat: loc.latitude, lng: loc.longitude, acc: loc.accuracy, speed: loc.speed, t: loc.time || Date.now() });
    }).then(id => { bgWatch = id; }).catch(e => { bgWatch = null; banner('No se pudo iniciar el GPS: ' + e.message, 'bad', 6000); });
    return;
  }
  if (!navigator.geolocation) { banner('Este dispositivo no tiene GPS disponible.', 'bad'); return; }
  if (watchId != null) return;
  watchId = navigator.geolocation.watchPosition(
    pos => onFix({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy, speed: pos.coords.speed, t: pos.timestamp || Date.now() }),
    err => { banner(err.code === 1 ? 'Permiso de ubicación denegado. Actívalo para registrar las rondas.' : 'Sin señal GPS (' + err.message + ')', err.code === 1 ? 'bad' : 'warn', 6000); },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
}
function stopGps() { if (RN) return; // el servicio nativo es permanente
 if (BG && bgWatch != null && bgWatch !== 'pending') { BG.removeWatcher({ id: bgWatch }).catch(() => { }); } if (BG) bgWatch = null; if (watchId != null) navigator.geolocation.clearWatch(watchId); watchId = null; }
function gpsBadge(acc) {
  const el = $('gpsdot');
  if (acc == null) { el.textContent = 'GPS —'; el.style.color = ''; return; }
  el.textContent = 'GPS ±' + Math.round(acc) + ' m';
  el.style.color = acc <= Math.min(10, cfg.maxAcc) ? COL.grn : acc <= cfg.maxAcc ? COL.amb : COL.red;
}
async function keepAwake() { if (CAP) return; try { if ('wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); } } catch (e) { } }
function releaseAwake() { try { wakeLock && wakeLock.release(); } catch (e) { } wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && run && !run.end) { keepAwake(); }
  if (document.visibilityState === 'hidden' && run && !run.end) persist(true);
});
window.addEventListener('pagehide', () => { if (run && !run.end && !viewing) persist(true); });

/* ---------- Simulación ---------- */
function stopSim() { if (simTimer) clearInterval(simTimer); simTimer = null; }
function simulate(speedMs) {
  if (yard.boundary.length < 3) demoYard();
  if (viewing) backToLive();
  if (run && !run.end) finishRun();
  stopGps(); simClock = Date.now(); startRun(true);
  const P = proj, xs = P.poly.map(p => p.x), ys = P.poly.map(p => p.y);
  const minX = Math.min(...xs) + 8, maxX = Math.max(...xs) - 8, minY = Math.min(...ys) + 8, maxY = Math.max(...ys) - 8;
  // 3 vueltas por los pasillos; en la primera se salta la Puerta Este
  const wp = [];
  for (let lap = 0; lap < 3; lap++) {
    let dir = 1;
    for (let y = minY, row = 0; y <= maxY; y += 40, row++) {
      if (row === 1 && lap > 0) wp.push([maxX - 2, -4]);
      wp.push(dir > 0 ? [minX, y] : [maxX, y]); wp.push(dir > 0 ? [maxX * 0.6, y] : [minX * 0.4, y]); dir = -dir;
    }
    wp.push([minX, minY]);
  }
  let k = 0, x = wp[0][0], y = wp[0][1], t = nowT(), pause = 0, stopsDone = 0, hide = 0, hid = false;
  let v = 1.3;
  simTimer = setInterval(() => {
    for (let r = 0; r < 6; r++) {
      t += 1000; simClock = t;
      if (pause > 0) { pause--; } else {
        v = k === 4 ? 9 : 1.3; // un tramo en vehículo (~32 km/h)
        const [tx, ty] = wp[k]; const dx = tx - x, dy = ty - y, d = Math.hypot(dx, dy);
        if (d < v) {
          k++;
          if (k >= wp.length) { finishRun(); simClock = null; startRun(); banner('Simulación guardada en Turnos. Vuelve el seguimiento real.', '', 6000); return; }
          if (k % 5 === 0 && stopsDone < 3) { pause = 60 + stopsDone * 200; stopsDone++; }
        } else { x += dx / d * v; y += dy / d * v; }
      }
      if (!hid && k === 9) { hid = true; hide = 240; } // simula 4 min sin señal (escondido entre contenedores)
      if (hide > 0) { hide--; continue; }
      const bad = Math.random() < 0.06;
      const n = bad ? 40 : 3, acc = bad ? 35 + Math.random() * 30 : 4 + Math.random() * 6;
      const p = P.ll(x + (Math.random() - .5) * n, y + (Math.random() - .5) * n);
      onFix({ lat: p.lat, lng: p.lng, acc, speed: null, t });
    }
  }, speedMs || 100);
}

/* ---------- Render ---------- */
let lastSig = '';
function renderAll() { renderHeader(); renderControl(); renderInfo(); }
function renderHeader() {
  const r = run, now = nowT();
  $('clock').textContent = fmtHM(now);
  const st = $('status');
  let txt = '—', k = 'idle';
  if (viewing) { txt = 'TURNO GUARDADO'; k = 'idle'; }
  else if (r && !r.end) {
    if (!simTimer && Date.now() - lastValidAt > 60000) { txt = 'SIN SEÑAL'; k = 'bad'; }
    else if (r.outside) { txt = 'FUERA DEL RECINTO'; k = 'warn'; }
    else if (r.inStop) { txt = 'PARADO ' + fmtMin(now - r.anchor.t); k = r.alarmed ? 'bad' : 'warn'; }
    else { txt = 'EN RONDA'; k = 'ok'; }
  }
  st.textContent = txt; st.className = 'pill ' + k;
  if (!r) return;
  const end = isFinite(r.periodEnd) ? r.periodEnd : null;
  $('shiftLbl').textContent = r.sim ? 'Simulación ' + fmtHM(r.start) : r.shiftLabel ? 'Turno ' + r.shiftLabel : 'Elegir turno · ' + fmtHM(r.start) + (end ? '–' + fmtHM(end) : r.end ? '–' + fmtHM(r.end) : '');
  $('bShift').classList.toggle('ask', !viewing && !r.end && !r.sim && !r.shiftLabel);
  $('shiftBar').style.width = (end ? Math.min(100, 100 * (now - r.start) / (end - r.start)) : r.end ? 100 : 0) + '%';
  $('guardLbl').textContent = r.guard ? '👤 ' + r.guard : '';
  // KPIs
  const exp = expectedRounds(r), comp = compliance(r);
  const pts = yard.points, sts = pts.map(c => cpStatus(c, r));
  const okN = sts.filter(s => s.k === 'ok' || s.k === 'warn').length, badN = sts.filter(s => s.k === 'bad').length;
  if (pts.length) {
    setKpi('kRounds', String(r.rounds.length), 'de ' + exp + ' exigidas', comp >= 100 ? 'ok' : comp >= 60 ? 'warn' : 'bad', 'Rondas');
    setKpi('kComp', okN + '/' + pts.length, badN ? badN + ' atrasados' : 'todo en orden', badN ? 'bad' : sts.some(s => s.k === 'warn') ? 'warn' : 'ok', 'Puntos OK');
  } else {
    setKpi('kRounds', fmtDist(r.dist), 'recorridos', '', 'Recorrido');
    const g = (r.gaps || []).length;
    setKpi('kComp', g ? fmtMin(gapMs(r)) : '0 min', g ? g + (g === 1 ? ' corte' : ' cortes') : 'sin cortes', g ? 'bad' : 'ok', 'Sin señal');
  }
  const c = covPct();
  setKpi('kCov', c == null ? '–' : c + '%', c == null ? 'sin límite' : 'del patio', c == null ? '' : c >= 80 ? 'ok' : c >= 50 ? 'warn' : 'bad');
  setKpi('kStop', fmtDur(stoppedMs(r)), r.stops.length + (r.stops.length === 1 ? ' parada' : ' paradas'), r.inStop ? 'warn' : '');
  setKpi('kDist', fmtDist(r.dist), fmtDur(elapsed(r)) + ' de turno');
  setKpi('kSpeed', (!r.end && !r.inStop ? r.speed : 0).toFixed(1), 'km/h · máx ' + r.maxSpeed.toFixed(1));
  const bc = $('badCnt'); bc.textContent = badN; bc.style.display = badN ? '' : 'none';
}
function renderControl() {
  const r = run;
  if (!r) return;
  const pts = yard.points;
  const box = $('roundBox');
  $('cpHead').style.display = pts.length ? '' : 'none';
  if (!pts.length) {
    const c = covPct(), longS = r.stops.filter(s => isLong(s)).length, g = (r.gaps || []).length;
    box.innerHTML = yard.boundary.length < 3
      ? '<div class="hd">Falta el límite de la zona APM</div><div class="sub">El responsable debe dibujarlo en Configurar (con contraseña). Mientras, se registra el recorrido, las paradas y los cortes de señal.</div>'
      : '<div class="hd"><span>Vigilancia de la zona APM</span><span class="num">' + c + '%</span></div><div class="prog"><i style="width:' + c + '%;background:' + (c >= 80 ? 'var(--ok)' : c >= 50 ? 'var(--warn)' : 'var(--bad)') + '"></i></div>' +
        '<div class="sub">' + (c >= 100 ? 'Toda la zona recorrida.' : 'Quedan en rojo las zonas entre contenedores por las que aún no se ha pasado (' + (100 - c) + '%).') + '</div>';
    $('cpList').innerHTML = '<div class="kv" style="margin-top:12px">' +
      '<div>Paradas</div><div>' + r.stops.length + ' · ' + fmtDur(stoppedMs(r)) + '</div>' +
      '<div>Paradas largas (más de ' + cfg.stopAlarm + ' min)</div><div style="color:' + (longS ? 'var(--bad)' : 'var(--ok)') + '">' + longS + '</div>' +
      '<div>Excesos de velocidad (más de ' + cfg.speedLimit + ' km/h)</div><div style="color:' + ((r.speeding || []).length ? 'var(--bad)' : 'var(--ok)') + '">' + (r.speeding || []).length + '</div>' +
      '<div>Cortes de señal GPS</div><div style="color:' + (g ? 'var(--bad)' : 'var(--ok)') + '">' + g + (g ? ' · ' + fmtMin(gapMs(r)) : '') + '</div>' +
      '<div>Última posición válida</div><div>' + (r.lastAcceptT ? fmtAgo(nowT() - r.lastAcceptT) : '—') + '</div></div>';
    if (lastSig !== 'none') { lastSig = 'none'; map.points([]); }
    return;
  } else {
    const done = pts.filter(c => r.roundVisited[c.id]).length, miss = pts.filter(c => !r.roundVisited[c.id]);
    const last = r.rounds[r.rounds.length - 1];
    box.innerHTML = '<div class="hd"><span>Ronda ' + (r.rounds.length + 1) + (r.end ? ' (sin terminar)' : ' en curso') + '</span><span class="num">' + done + ' / ' + pts.length + '</span></div>' +
      '<div class="prog"><i style="width:' + (100 * done / pts.length) + '%"></i></div>' +
      '<div class="sub">' + (miss.length ? 'Falta: ' + miss.map(c => esc(c.name)).join(', ') : 'Completa') + ' · ' + fmtMin((r.end || nowT()) - r.roundStart) + ' en esta ronda' + (last ? ' · última completa ' + fmtHM(last.end) + ' (' + fmtMin(last.dur) + ')' : '') + '</div>';
  }
  const rows = pts.map((c, k) => ({ c, k, s: cpStatus(c, r), n: r.passes.filter(p => p.id === c.id).length }));
  const order = { bad: 0, warn: 1, idle: 2, ok: 3 };
  rows.sort((a, b) => order[a.s.k] - order[b.s.k] || a.k - b.k);
  $('cpList').innerHTML = rows.length ? rows.map(({ c, k, s, n }) => '<div class="cp ' + s.k + '" data-id="' + c.id + '"><div class="dot">' + shortName(c, k) + '</div><div class="nm">' + esc(c.name) + '</div>' +
    '<div class="st"><b>' + s.txt + '</b><small>' + (s.since != null ? fmtAgo(s.since) : s.left != null ? 'quedan ' + fmtMin(s.left) : '') + '</small></div>' +
    '<div class="sub">' + (c.type === 'salida' ? 'Salida · ' : '') + n + (n === 1 ? ' paso' : ' pasos') + (r.lastPass[c.id] ? ' · último ' + fmtHM(r.lastPass[c.id]) : '') + '</div></div>').join('')
    : '<div class="empty">No hay puntos de control. Ve a Configurar → "+ Punto de control" y toca el mapa donde estén.</div>';
  // marcadores con color de estado (solo si cambia algo)
  const marks = pts.map((c, k) => ({ ...c, short: shortName(c, k), k: cpStatus(c, r).k }));
  const sig = marks.map(m => m.id + m.k + m.name).join('|');
  if (sig !== lastSig) { lastSig = sig; map.points(marks); }
}
function renderInfo() {
  const r = run; if (!r) return;
  const moving = Math.max(1, elapsed(r) - stoppedMs(r));
  const rows = [
    ['Vigilante', r.guard || '—'],
    ['Inicio', fmtDate(r.start)],
    ['Duración', fmtDur(elapsed(r))],
    ['Recorrido', fmtDist(r.dist)],
    ['Velocidad media en movimiento', (r.dist / moving * 3600).toFixed(1) + ' km/h'],
    ['Velocidad máxima', r.maxSpeed.toFixed(1) + ' km/h'],
    ['Rondas completas', r.rounds.length + (r.rounds.length ? ' (media ' + fmtMin(r.rounds.reduce((a, x) => a + x.dur, 0) / r.rounds.length) + ')' : '')],
    ['Pasos por puntos', r.passes.length],
    ['Paradas', r.stops.length + ' · ' + fmtDur(stoppedMs(r))],
    ['Patio vigilado', (covPct() ?? '–') + '%'],
    ['Posiciones GPS descartadas', r.rejected + ' de ' + r.fixes],
    ['Tiempo sin señal válida', fmtDur(gapMs(r)) + ((r.gaps || []).length ? ' (' + r.gaps.length + ' cortes)' : '')]
  ];
  $('runInfo').innerHTML = rows.map(([a, b]) => '<div>' + a + '</div><div>' + esc(b) + '</div>').join('');
}
function renderEvents() {
  const l = run ? run.events.slice().reverse().slice(0, 300) : [];
  $('evList').innerHTML = l.map(e => '<li class="' + (e.k || '') + '"' + (e.lat ? ' data-go="' + e.lat + ',' + e.lng + '"' : '') + '><time class="num">' + fmtTime(e.t) + '</time><span class="b"></span><span>' + esc(e.txt) + '</span></li>').join('');
}
function renderHist() {
  const h = LS.get('rp_hist', []);
  $('histList').innerHTML = h.length ? h.map((r, k) => {
    const c = r.compliance != null ? r.compliance : r.coverage, cls = c == null ? 'idle' : c >= (r.compliance != null ? 100 : 80) ? 'ok' : c >= 50 ? 'warn' : 'bad';
    return '<div class="card hist"><div class="score ' + cls + '" style="background:var(--' + (cls === 'idle' ? 'idle' : cls) + '-bg);color:var(--' + (cls === 'idle' ? 'mut' : cls) + ')">' + (c == null ? '–' : c + '%') + '</div>' +
      '<div class="grow"><b>' + (r.shiftLabel ? 'Turno ' + r.shiftLabel + ' · ' : '') + fmtDate(r.start) + ' – ' + fmtHM(r.end) + '</b>' + (r.sim ? ' <span class="pill idle">prueba</span>' : '') +
      '<div class="mut">' + (r.guard ? esc(r.guard) + ' · ' : '') + (r.expected != null ? r.rounds.length + '/' + r.expected + ' rondas · ' : '') + fmtDist(r.dist) + ' · ' + r.stops.length + ' paradas · ' + (r.coverage ?? '–') + '% patio' + ((r.gaps || []).length ? ' · <span style="color:var(--bad)">' + r.gaps.length + ' cortes de señal</span>' : '') + '</div>' +
      '<div class="row" style="margin:6px 0 0"><button class="btn sm" data-view="' + k + '">Ver en mapa</button><button class="btn sm pri" data-pdf="' + k + '">PDF de este turno</button><button class="btn sm pri" data-xls="' + k + '">Excel de este turno</button></div></div></div>';
  }).join('') : '<div class="empty">Aún no hay turnos guardados. Cada turno se guarda solo al cambiar de turno.</div>';
}
let viewing = null;
function viewRun(r) {
  if (viewing) backToLive();
  viewing = { live: run }; run = r; redrawYard();
  map.track(r.track); map.stops(markList(r)); map.me(null);
  if (r.track.length) map.fit(r.track);
  renderEvents(); renderAll(); switchTab('pControl');
  banner('Viendo el turno del ' + fmtDate(r.start) + '. Toca aquí para volver al turno en vivo.', 'warn');
  $('banner').onclick = backToLive;
}
function backToLive() {
  if (!viewing) return;
  run = viewing.live; viewing = null; $('banner').onclick = null; banner('');
  redrawYard(); map.track(run.track); map.stops(markList(run)); renderEvents(); renderAll();
}

/* ---------- Informe imprimible (PDF) ---------- */
function report(r) {
  const pts = (r.points && r.end ? r.points : yard.points);
  const end = r.end || nowT(), due = cfg.freqMin * 60000;
  const cov = r.end ? r.coverage : covPct(), exp = r.end ? r.expected : expectedRounds(r), comp = r.end ? r.compliance : compliance(r);
  const cls = v => v == null ? '' : v >= 100 ? 'g' : v >= 60 ? 'a' : 'r';
  const ptRows = pts.map(c => { const n = r.passes.filter(p => p.id === c.id).length, g = maxGap(c, r), last = r.lastPass[c.id];
    return '<tr><td>' + esc(c.name) + (c.type === 'salida' ? ' (salida)' : '') + '</td><td>' + n + '</td><td>' + (last ? fmtTime(last) : '<span class="r">nunca</span>') + '</td><td class="' + (g > due ? 'r' : 'g') + '">' + fmtMin(g) + '</td></tr>'; }).join('');
  const rRows = r.rounds.map(x => '<tr><td>' + x.n + '</td><td>' + fmtTime(x.start) + '</td><td>' + fmtTime(x.end) + '</td><td>' + fmtMin(x.dur) + '</td></tr>').join('');
  const sRows = r.stops.map((s, k) => '<tr><td>' + (k + 1) + '</td><td>' + fmtTime(s.from) + '</td><td>' + fmtTime(s.to) + '</td><td class="' + (isLong(s) ? 'r' : '') + '">' + fmtMin(s.dur) + '</td><td>' + s.lat.toFixed(5) + ', ' + s.lng.toFixed(5) + '</td></tr>').join('');
  const eRows = r.events.filter(e => e.k === 'bad' || e.k === 'warn').map(e => '<tr><td>' + fmtTime(e.t) + '</td><td>' + esc(e.txt) + '</td></tr>').join('');
  $('report').innerHTML =
    '<h1>Informe de rondas de vigilancia</h1><div>' + esc($('siteName').textContent) + ' · ' + (r.sim ? 'SIMULACIÓN · ' : '') + fmtDate(r.start) + ' – ' + fmtDate(end) + '</div>' +
    '<div>Vigilante: <b>' + esc(r.guard || '—') + '</b> · Paso exigido cada ' + cfg.freqMin + ' min por ' + pts.length + ' puntos</div>' +
    '<div class="kp"><div>Rondas completas<b class="' + cls(comp) + '">' + r.rounds.length + ' / ' + (exp ?? '–') + '</b></div><div>Cumplimiento<b class="' + cls(comp) + '">' + (comp ?? '–') + '%</b></div><div>Patio vigilado<b>' + (cov ?? '–') + '%</b></div><div>Tiempo parado<b>' + fmtDur(stoppedMs(r)) + '</b></div></div>' +
    '<div class="kp"><div>Recorrido<b>' + fmtDist(r.dist) + '</b></div><div>Duración<b>' + fmtDur(elapsed(r)) + '</b></div><div>Paradas<b>' + r.stops.length + '</b></div><div>Sin señal GPS<b>' + fmtDur(gapMs(r)) + '</b></div></div>' +
    '<h2>Control de paso por puntos</h2><table><tr><th>Punto</th><th>Pasos</th><th>Último paso</th><th>Mayor tiempo sin pasar</th></tr>' + (ptRows || '<tr><td colspan=4>Sin puntos definidos</td></tr>') + '</table>' +
    '<h2>Rondas completas</h2><table><tr><th>Nº</th><th>Inicio</th><th>Fin</th><th>Duración</th></tr>' + (rRows || '<tr><td colspan=4 class="r">Ninguna ronda completa</td></tr>') + '</table>' +
    '<h2>Paradas</h2><table><tr><th>Nº</th><th>Desde</th><th>Hasta</th><th>Duración</th><th>Posición</th></tr>' + (sRows || '<tr><td colspan=5>Sin paradas</td></tr>') + '</table>' +
    '<h2>Incidencias</h2><table><tr><th>Hora</th><th>Detalle</th></tr>' + (eRows || '<tr><td colspan=2>Sin incidencias</td></tr>') + '</table>' +
    '<div class="sig"><div>Firma del vigilante</div><div>Firma del supervisor</div></div>';
  setTimeout(() => window.print(), 50);
}

/* ---------- Mapa para el informe (satélite + recorrido + paradas + velocidad) ---------- */
function loadTile(url) {
  return new Promise(res => { const im = new Image(); im.crossOrigin = 'anonymous'; const to = setTimeout(() => res(null), 8000); im.onload = () => { clearTimeout(to); res(im); }; im.onerror = () => { clearTimeout(to); res(null); }; im.src = url; });
}
async function reportMap(r, W, H) {
  const pts = [].concat(yard.boundary, r.track || [], r.stops || [], r.speeding || []);
  if (!pts.length) return null;
  const lat2y = (lat, z) => { const s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * Math.pow(2, z); };
  const lng2x = (lng, z) => (lng + 180) / 360 * 256 * Math.pow(2, z);
  const minLat = Math.min(...pts.map(p => p.lat)), maxLat = Math.max(...pts.map(p => p.lat)), minLng = Math.min(...pts.map(p => p.lng)), maxLng = Math.max(...pts.map(p => p.lng));
  let z = 19;
  while (z > 3 && (lng2x(maxLng, z) - lng2x(minLng, z) > W * 0.86 || lat2y(minLat, z) - lat2y(maxLat, z) > H * 0.86)) z--;
  // ampliación fina (entre 1x y 2x) para que la zona llene el mapa
  const spanX = Math.max(1, lng2x(maxLng, z) - lng2x(minLng, z)), spanY = Math.max(1, lat2y(minLat, z) - lat2y(maxLat, z));
  const sc = Math.max(1, Math.min(2, W * 0.88 / spanX, H * 0.88 / spanY)), w0 = Math.ceil(W / sc), h0 = Math.ceil(H / sc);
  const cx = (lng2x(minLng, z) + lng2x(maxLng, z)) / 2, cy = (lat2y(minLat, z) + lat2y(maxLat, z)) / 2, ox = cx - w0 / 2, oy = cy - h0 / 2;
  const toP0 = p => ({ x: lng2x(p.lng, z) - ox, y: lat2y(p.lat, z) - oy });
  const toPx = p => { const q = toP0(p); return { x: q.x * sc, y: q.y * sc }; };
  const base = document.createElement('canvas'); base.width = w0; base.height = h0; const bx = base.getContext('2d');
  bx.fillStyle = '#1e293b'; bx.fillRect(0, 0, w0, h0);
  // teselas de satélite (Esri World Imagery)
  const t0x = Math.floor(ox / 256), t1x = Math.floor((ox + w0) / 256), t0y = Math.floor(oy / 256), t1y = Math.floor((oy + h0) / 256), jobs = [];
  for (let tx = t0x; tx <= t1x; tx++) for (let ty = t0y; ty <= t1y; ty++)
    jobs.push(loadTile('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/' + z + '/' + ty + '/' + tx).then(im => { if (im) bx.drawImage(im, tx * 256 - ox, ty * 256 - oy); }));
  await Promise.all(jobs);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const ctx = cv.getContext('2d');
  ctx.imageSmoothingQuality = 'high'; ctx.drawImage(base, 0, 0, w0 * sc, h0 * sc);
  // zona sin vigilar en rojo
  const cov = document.createElement('canvas'); cov.width = W; cov.height = H;
  drawCoverage(cov.getContext('2d'), toPx, W, H, r.track || []); ctx.drawImage(cov, 0, 0);
  // límite
  if (yard.boundary.length >= 3) { ctx.setLineDash([10, 6]); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.beginPath(); yard.boundary.forEach((p, i) => { const q = toPx(p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }); ctx.closePath(); ctx.stroke(); ctx.setLineDash([]); }
  // recorrido
  ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 4; ctx.lineJoin = ctx.lineCap = 'round'; ctx.beginPath(); let prev = null;
  (r.track || []).forEach(p => { const q = toPx(p); if (prev && p.t - prev.t < 90000) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); prev = p; });
  ctx.stroke();
  const label = (q, txt, bg) => { ctx.font = 'bold 22px system-ui,sans-serif'; const w = ctx.measureText(txt).width + 14; ctx.fillStyle = bg; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(q.x - w / 2, q.y - 17, w, 34, 8) : ctx.rect(q.x - w / 2, q.y - 17, w, 34); ctx.fill(); ctx.stroke(); ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(txt, q.x, q.y + 1); };
  const dot = (q, rad, fill, txt) => { ctx.beginPath(); ctx.arc(q.x, q.y, rad, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke(); ctx.fillStyle = '#000'; ctx.font = 'bold ' + Math.round(rad * 1.1) + 'px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(txt, q.x, q.y + 1); };
  (r.gaps || []).forEach((g, k) => { if (g.lat != null) label(toPx(g), 'C' + (k + 1) + ' sin señal', '#7c3aed'); });
  (r.stops || []).forEach((s, k) => dot(toPx(s), 15 + Math.min(10, s.dur / 60000), isLong(s) ? '#ef4444' : '#f59e0b', String(k + 1)));
  (r.speeding || []).forEach((o, k) => label(toPx(o), 'V' + (k + 1) + ' ' + o.max + ' km/h · ' + spSecs(o) + ' s', '#dc2626'));
  // leyenda
  const items = [['#ef4444', 'Sin vigilar'], ['#3b82f6', 'Recorrido'], ['#f59e0b', 'Parada (nº)'], ['#dc2626', 'V = exceso velocidad'], ['#7c3aed', 'C = corte de señal']];
  ctx.font = '600 19px system-ui,sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  const lw = Math.max(...items.map(i => ctx.measureText(i[1]).width)) + 48;
  ctx.fillStyle = 'rgba(15,23,42,.85)'; ctx.fillRect(12, H - 12 - items.length * 30 - 12, lw, items.length * 30 + 12);
  items.forEach(([c, t], i) => { const y = H - 12 - items.length * 30 + i * 30 + 9; ctx.fillStyle = c; ctx.fillRect(24, y - 8, 16, 16); ctx.fillStyle = '#fff'; ctx.fillText(t, 48, y); });
  ctx.fillStyle = 'rgba(255,255,255,.8)'; ctx.font = '14px system-ui,sans-serif'; ctx.textAlign = 'right'; ctx.fillText('Imágenes © Esri', W - 10, H - 10);
  try { return cv.toDataURL('image/jpeg', 0.85); } catch (e) { return null; } // si las teselas no permiten exportar
}

/* ---------- Compartir PDF / Excel ---------- */
function loadScript(src) { return new Promise((res, rej) => { if (document.querySelector('script[src="' + src + '"]')) return res(); const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('No se pudo cargar ' + src)); document.head.appendChild(s); }); }
function blobToB64(blob) { return new Promise(res => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); }); }
async function shareFile(name, blob, title) {
  const Cap = window.Capacitor;
  try {
    if (Cap && Cap.isNativePlatform && Cap.isNativePlatform() && Cap.Plugins.Filesystem && Cap.Plugins.Share) {
      const w = await Cap.Plugins.Filesystem.writeFile({ path: name, data: await blobToB64(blob), directory: 'CACHE' });
      await Cap.Plugins.Share.share({ title, text: title, files: [w.uri], dialogTitle: 'Enviar ' + name });
      return;
    }
    const f = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [f] })) { await navigator.share({ files: [f], title }); return; }
  } catch (e) { if (e && (e.name === 'AbortError' || /cancel/i.test(e.message || ''))) return; console.warn(e); }
  download(name, blob);
}
const mapsUrl = (lat, lng) => lat != null ? 'https://maps.google.com/?q=' + (+lat).toFixed(6) + ',' + (+lng).toFixed(6) : '';
function runPoints(r) { return r.end && r.points ? r.points : yard.points; }
function runSummary(r) {
  const exp = r.end ? r.expected : expectedRounds(r), comp = r.end ? r.compliance : compliance(r);
  const longStops = r.stops.filter(s => isLong(s));
  return { exp, comp, cov: r.end ? r.coverage : covPct(), longStops, late: runPoints(r).filter(c => maxGap(c, r) > cfg.freqMin * 60000) };
}
async function sharePdf(r) {
  banner('Preparando PDF…', '', 2000);
  await loadScript('vendor/jspdf.umd.min.js'); await loadScript('vendor/jspdf.plugin.autotable.min.js');
  const { jsPDF } = window.jspdf, doc = new jsPDF({ unit: 'mm', format: 'a4' }), S = runSummary(r), due = cfg.freqMin * 60000, end = r.end || nowT();
  const RED = [185, 28, 28], GRN = [21, 128, 61], AMB = [180, 83, 9];
  doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.text('Informe de rondas de vigilancia', 14, 16);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5);
  doc.text($('siteName').textContent + (r.sim ? '  ·  SIMULACIÓN' : '') + (r.shiftLabel ? '  ·  Turno ' + r.shiftLabel : '') + '  ·  ' + fmtDate(r.start) + ' – ' + fmtDate(end), 14, 22);
  doc.text('Vigilante: ' + (r.guard || '—') + (runPoints(r).length ? '  ·  Paso exigido cada ' + cfg.freqMin + ' min por ' + runPoints(r).length + ' puntos' : '  ·  Vigilancia de la zona APM entre contenedores'), 14, 27);
  const gaps = (r.gaps || []).length;
  const lowCov = S.cov != null && S.cov < 80;
  const spN = (r.speeding || []).length;
  const ok = (S.comp == null || S.comp >= 100) && !S.longStops.length && !gaps && !lowCov && !spN;
  doc.setFillColor(...(ok ? [220, 252, 231] : [254, 226, 226])); doc.roundedRect(14, 31, 182, 10, 2, 2, 'F');
  doc.setFont('helvetica', 'bold'); doc.setTextColor(...(ok ? GRN : RED));
  doc.text(ok ? 'TURNO CORRECTO: zona recorrida, sin paradas largas, cortes de señal ni excesos de velocidad' : 'REVISAR: ' + [S.comp != null && S.comp < 100 ? 'faltan rondas' : '', S.longStops.length ? S.longStops.length + ' paradas largas' : '', gaps ? gaps + ' cortes de señal' : '', spN ? spN + ' excesos de velocidad' : '', S.late.length ? S.late.length + ' puntos con retraso' : '', lowCov ? 'zona vigilada solo ' + S.cov + '%' : ''].filter(Boolean).join(' · '), 17, 37.5);
  doc.setTextColor(0);
  const kp = [S.exp != null ? ['Rondas', r.rounds.length + ' / ' + S.exp] : ['Cortes de señal', String(gaps)], S.comp != null ? ['Cumplimiento', S.comp + '%'] : ['Paradas largas', String(S.longStops.length)], ['Patio vigilado', (S.cov ?? '–') + '%'], ['Tiempo parado', fmtDur(stoppedMs(r))], ['Recorrido', fmtDist(r.dist)], ['Duración', fmtDur(elapsed(r))], ['Paradas', String(r.stops.length)], ['Sin señal GPS', fmtDur(gapMs(r))]];
  kp.forEach(([k, v], i) => { const x = 14 + (i % 4) * 46, y = 45 + Math.floor(i / 4) * 15; doc.setDrawColor(200); doc.roundedRect(x, y, 44, 13, 1.5, 1.5); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.text(k, x + 2.5, y + 4.5); doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text(v, x + 2.5, y + 10.5); });
  let y = 80;
  const img = await reportMap(r, 1400, 930);
  if (img) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text('Mapa del turno', 14, y);
    doc.addImage(img, 'JPEG', 14, y + 2, 182, 121); doc.setDrawColor(150); doc.rect(14, y + 2, 182, 121);
    y += 130;
  }
  const tbl = (title, head, body, colorCol) => {
    if (y > 250) { doc.addPage(); y = 18; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(title, 14, y);
    doc.autoTable({ startY: y + 2, head: [head], body: body.length ? body : [[{ content: 'Sin datos', colSpan: head.length }]], theme: 'striped', styles: { fontSize: 8.5, cellPadding: 1.6 }, headStyles: { fillColor: [30, 41, 59] }, margin: { left: 14, right: 14 },
      didParseCell: d => { if (d.section === 'body' && colorCol != null && d.row.raw && d.row.raw._c && d.column.index === colorCol) { d.cell.styles.textColor = d.row.raw._c; d.cell.styles.fontStyle = 'bold'; } } });
    y = doc.lastAutoTable.finalY + 8;
  };
  const row = (arr, c) => { arr._c = c; return arr; };
  if (runPoints(r).length) tbl('Control de paso por puntos', ['Punto', 'Pasos', 'Último paso', 'Mayor tiempo sin pasar'], runPoints(r).map(c => { const g = maxGap(c, r), last = r.lastPass[c.id]; return row([c.name + (c.type === 'salida' ? ' (salida)' : ''), String(r.passes.filter(p => p.id === c.id).length), last ? fmtTime(last) : 'nunca', fmtMin(g)], g > due ? RED : GRN); }), 3);
  tbl('Incidencias', ['Hora', 'Detalle'], r.events.filter(e => e.k === 'bad' || e.k === 'warn').map(e => row([fmtTime(e.t), e.txt], e.k === 'bad' ? RED : AMB)), 1);
  if ((r.speeding || []).length) tbl('Excesos de velocidad', ['Nº', 'Hora', 'Duración', 'Velocidad máx.', 'Posición'], r.speeding.map((o, k) => row(['V' + (k + 1), fmtTime(o.from), fmtSec(spSecs(o)), o.max + ' km/h', o.lat.toFixed(5) + ', ' + o.lng.toFixed(5)], RED)), 3);
  if ((r.gaps || []).length) tbl('Cortes de señal GPS', ['Nº', 'Desde', 'Hasta', 'Duración', 'Última posición'], r.gaps.map((g, k) => row(['C' + (k + 1), fmtTime(g.from), fmtTime(g.to), fmtMin(g.dur), g.lat != null ? g.lat.toFixed(5) + ', ' + g.lng.toFixed(5) : '—'], RED)), 3);
  tbl('Paradas', ['Nº', 'Desde', 'Hasta', 'Duración', 'Posición'], r.stops.map((s, k) => row([String(k + 1), fmtTime(s.from), fmtTime(s.to), fmtMin(s.dur), s.lat.toFixed(5) + ', ' + s.lng.toFixed(5)], isLong(s) ? RED : null)), 3);
  if (runPoints(r).length) tbl('Rondas completas', ['Nº', 'Inicio', 'Fin', 'Duración'], r.rounds.map(x => [String(x.n), fmtTime(x.start), fmtTime(x.end), fmtMin(x.dur)]));
  if (y > 262) { doc.addPage(); y = 20; }
  doc.setDrawColor(0); doc.line(14, y + 16, 90, y + 16); doc.line(120, y + 16, 196, y + 16); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.text('Firma del vigilante', 14, y + 21); doc.text('Firma del supervisor', 120, y + 21);
  const n = doc.getNumberOfPages(); for (let i = 1; i <= n; i++) { doc.setPage(i); doc.setFontSize(7.5); doc.setTextColor(120); doc.text('Control de Rondas · generado ' + fmtDate(Date.now()) + ' · página ' + i + ' de ' + n, 14, 290); }
  await shareFile('informe-turno-' + (r.shiftLabel ? r.shiftLabel.replace(/[^0-9]+/g, '-') + '_' : '') + stamp(r.start) + '.pdf', doc.output('blob'), 'Informe de rondas ' + fmtDate(r.start));
}
function sheet(rows, widths) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  if (widths) ws['!cols'] = widths.map(w => ({ wch: w }));
  if (rows.length > 1) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: rows[0].length - 1 } }) };
  return ws;
}
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
async function shareXlsx(r) {
  banner('Preparando Excel…', '', 2000);
  await loadScript('vendor/xlsx.mini.min.js');
  const S = runSummary(r), due = cfg.freqMin * 60000, end = r.end || nowT(), wb = XLSX.utils.book_new(), mins = ms => Math.round(ms / 6000) / 10;
  XLSX.utils.book_append_sheet(wb, sheet([
    ['Concepto', 'Valor'], ['Instalación', $('siteName').textContent], ['Vigilante', r.guard || ''], ['Turno', r.shiftLabel || 'automático'], ['Inicio', fmtDate(r.start)], ['Fin', fmtDate(end)], ['Simulación', r.sim ? 'Sí' : 'No'],
    ['Rondas completas', r.rounds.length], ['Rondas exigidas', S.exp ?? ''], ['Cumplimiento %', S.comp ?? ''], ['Paso exigido cada (min)', cfg.freqMin],
    ['Puntos con retraso', S.late.map(c => c.name).join(', ')], ['Patio vigilado %', S.cov ?? ''], ['Recorrido (m)', Math.round(r.dist)], ['Duración (min)', mins(elapsed(r))],
    ['Paradas', r.stops.length], ['Tiempo parado (min)', mins(stoppedMs(r))], ['Paradas largas (> ' + cfg.stopAlarm + ' min)', S.longStops.length], ['Cortes de señal', (r.gaps || []).length], ['Tiempo sin señal (min)', mins(gapMs(r))], ['Excesos de velocidad (> ' + cfg.speedLimit + ' km/h)', (r.speeding || []).length], ['Tiempo con exceso (s)', (r.speeding || []).reduce((a, o) => a + spSecs(o), 0)], ['Velocidad máxima (km/h)', Math.round(r.maxSpeed)]
  ], [28, 40]), 'Resumen');
  XLSX.utils.book_append_sheet(wb, sheet([['Punto', 'Tipo', 'Pasos', 'Último paso', 'Mayor tiempo sin pasar (min)', 'Estado'], ...runPoints(r).map(c => { const g = maxGap(c, r); return [c.name, c.type === 'salida' ? 'Salida' : 'Punto', r.passes.filter(p => p.id === c.id).length, r.lastPass[c.id] ? fmtTime(r.lastPass[c.id]) : 'nunca', mins(g), g > due ? 'RETRASO' : 'OK']; })], [22, 8, 7, 12, 26, 10]), 'Puntos');
  XLSX.utils.book_append_sheet(wb, sheet([['Hora', 'Gravedad', 'Detalle', 'Mapa'], ...r.events.filter(e => e.k === 'bad' || e.k === 'warn').map(e => [fmtTime(e.t), e.k === 'bad' ? 'Alta' : 'Media', e.txt, mapsUrl(e.lat, e.lng)])], [10, 9, 60, 45]), 'Incidencias');
  XLSX.utils.book_append_sheet(wb, sheet([['Nº', 'Desde', 'Hasta', 'Duración (min)', 'Larga', 'Mapa'], ...r.stops.map((s, k) => [k + 1, fmtTime(s.from), fmtTime(s.to), mins(s.dur), isLong(s) ? 'SÍ' : '', mapsUrl(s.lat, s.lng)])], [5, 10, 10, 14, 7, 45]), 'Paradas');
  XLSX.utils.book_append_sheet(wb, sheet([['Hora', 'Duración (s)', 'Velocidad máx. (km/h)', 'Mapa'], ...(r.speeding || []).map(o => [fmtTime(o.from), spSecs(o), o.max, mapsUrl(o.lat, o.lng)])], [10, 13, 20, 45]), 'Velocidad');
  XLSX.utils.book_append_sheet(wb, sheet([['Hora', 'Punto', 'Mapa'], ...r.passes.map(p => [fmtTime(p.t), p.name, mapsUrl(p.lat, p.lng)])], [10, 22, 45]), 'Pasos');
  XLSX.utils.book_append_sheet(wb, sheet([['Nº', 'Inicio', 'Fin', 'Duración (min)'], ...r.rounds.map(x => [x.n, fmtTime(x.start), fmtTime(x.end), mins(x.dur)])], [5, 10, 10, 14]), 'Rondas');
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  await shareFile('turno-' + stamp(r.start) + '.xlsx', new Blob([out], { type: XLSX_TYPE }), 'Turno ' + fmtDate(r.start));
}
async function shareAllXlsx() {
  const h = LS.get('rp_hist', []).filter(r => !r.sim);
  if (!h.length) { banner('Aún no hay turnos reales guardados.', 'warn', 3000); return; }
  await loadScript('vendor/xlsx.mini.min.js');
  const mins = ms => Math.round(ms / 6000) / 10, wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet([['Turno', 'Inicio', 'Fin', 'Vigilante', 'Rondas', 'Exigidas', 'Cumplimiento %', 'Paradas', 'Paradas largas', 'Tiempo parado (min)', 'Cortes de señal', 'Sin señal (min)', 'Excesos velocidad', 'Patio %', 'Recorrido (m)', 'Revisar'],
    ...h.map(r => { const longS = r.stops.filter(s => isLong(s)).length, gaps = (r.gaps || []).length; return [r.shiftLabel || '', fmtDate(r.start), fmtDate(r.end), r.guard || '', r.rounds.length, r.expected ?? '', r.compliance ?? '', r.stops.length, longS, mins(stoppedMs(r)), gaps, mins(gapMs(r)), (r.speeding || []).length, r.coverage ?? '', Math.round(r.dist), (r.compliance != null && r.compliance < 100) || longS || gaps || (r.speeding || []).length ? 'SÍ' : '']; })],
    [12, 17, 17, 16, 8, 9, 14, 8, 13, 18, 14, 14, 16, 8, 13, 8]), 'Turnos');
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  await shareFile('resumen-turnos-' + stamp(Date.now()) + '.xlsx', new Blob([out], { type: XLSX_TYPE }), 'Resumen de turnos');
}

/* ---------- Exportar ---------- */
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(text instanceof Blob ? text : new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); }
function stamp(t) { return new Date(t).toISOString().slice(0, 16).replace(/[:T]/g, '-'); }
function toGpx(r) {
  const pts = r.track.map(p => '<trkpt lat="' + p.lat + '" lon="' + p.lng + '"><time>' + new Date(p.t).toISOString() + '</time></trkpt>').join('\n');
  const wps = r.stops.map((s, k) => '<wpt lat="' + s.lat + '" lon="' + s.lng + '"><time>' + new Date(s.from).toISOString() + '</time><name>Parada ' + (k + 1) + ' (' + fmtDur(s.dur) + ')</name></wpt>').join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Control de Rondas" xmlns="http://www.topografix.com/GPX/1/1">\n' + wps + '\n<trk><name>Turno ' + esc(r.guard || '') + ' ' + fmtDate(r.start) + '</name><trkseg>\n' + pts + '\n</trkseg></trk>\n</gpx>';
}
function toCsv(r) {
  const q = s => '"' + String(s).replace(/"/g, "'") + '"';
  const L = ['tipo;hora;hasta;duracion_min;punto;lat;lng;detalle'];
  r.passes.forEach(p => L.push(['paso', fmtTime(p.t), '', '', q(p.name), p.lat, p.lng, ''].join(';')));
  r.rounds.forEach(x => L.push(['ronda', fmtTime(x.start), fmtTime(x.end), Math.round(x.dur / 60000), '', '', '', 'Ronda ' + x.n].join(';')));
  r.stops.forEach((s, k) => L.push(['parada', fmtTime(s.from), fmtTime(s.to), Math.round(s.dur / 60000), '', s.lat.toFixed(6), s.lng.toFixed(6), 'Parada ' + (k + 1)].join(';')));
  r.events.filter(e => e.k === 'bad' || e.k === 'warn').forEach(e => L.push(['incidencia', fmtTime(e.t), '', '', '', e.lat ? e.lat.toFixed(6) : '', e.lng ? e.lng.toFixed(6) : '', q(e.txt)].join(';')));
  L.push(['resumen', fmtDate(r.start), r.end ? fmtDate(r.end) : '', Math.round(elapsed(r) / 60000), '', '', '', q(r.rounds.length + '/' + (r.expected ?? '-') + ' rondas, ' + fmtDist(r.dist) + ', ' + (r.coverage ?? '-') + '% patio, vigilante ' + (r.guard || '-'))].join(';'));
  return '﻿' + L.join('\n');
}

/* ---------- Pestañas y eventos ---------- */
const PIN = '1490';
function setLocked(v) { $('lockBox').style.display = v ? '' : 'none'; $('cfgBody').style.display = v ? 'none' : ''; if (v && editMode) { draft = []; endEdit(); map.draft([]); } }
function switchTab(id) {
  if (id !== 'pConfig') setLocked(true); document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.p === id)); document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.id === id)); }
function startEdit(mode, msg) { editMode = mode; document.body.classList.add('mode-edit'); banner(msg, 'warn'); }
function endEdit() { editMode = null; document.body.classList.remove('mode-edit'); $('drawRow').style.display = 'none'; banner(''); }
function bind() {
  document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => switchTab(b.dataset.p));
  $('guard').onchange = () => { const g = $('guard').value.trim(); LS.set('rp_guard', g); if (run && !run.end && !viewing) { run.guard = g; logEv('Vigilante: ' + (g || '—'), null, 'acc'); persist(true); renderAll(); } };
  $('locate').onclick = () => { const p = viewing ? null : (run && run.last) || LS.get('rp_lastpos', null); if (p) map.center(p, 18); else if (viewing) backToLive(); else banner('Buscando señal GPS…', '', 3000); };
  $('bDraw').onclick = () => { draft = []; $('drawRow').style.display = 'flex'; startEdit('boundary', 'Toca el mapa en cada esquina del patio y pulsa "Terminar límite".'); };
  $('bUndo').onclick = () => { draft.pop(); map.draft(draft); };
  $('bDone').onclick = () => { if (draft.length < 3) { banner('Hacen falta al menos 3 puntos.', 'warn', 3000); return; } yard.boundary = draft; draft = []; endEdit(); saveYard(); };
  $('bCancel').onclick = () => { draft = []; endEdit(); map.draft([]); };
  $('bPoint').onclick = () => startEdit('punto', 'Toca en el mapa dónde está el punto de control.');
  $('bExit').onclick = () => startEdit('salida', 'Toca en el mapa la salida al exterior.');
  $('bShift').onclick = openShiftSheet;
  $('bShiftCancel').onclick = () => { $('shiftSheet').style.display = 'none'; };
  $('bShiftGo').onclick = chooseShift;
  $('presetBtns').onclick = e => { const b = e.target.closest('[data-k]'); if (!b) return; const p = parsePresets()[+b.dataset.k]; $('sStart').value = hhmm(p.s); $('sEnd').value = hhmm(p.e); document.querySelectorAll('.preset').forEach(x => x.classList.toggle('on', x === b)); };
  $('bUnlock').onclick = () => { if ($('pin').value === PIN) { $('pin').value = ''; setLocked(false); } else { $('pin').value = ''; banner('Contraseña incorrecta', 'bad', 2500); vibrate(200); } };
  $('pin').onkeydown = e => { if (e.key === 'Enter') $('bUnlock').click(); };
  $('bLock').onclick = () => setLocked(true);
  $('bClearYard').onclick = () => { if (confirm('¿Borrar el límite y todos los puntos de control?')) { yard = { boundary: [], points: [] }; saveYard(); } };
  $('bExportYard').onclick = () => download('patio.json', JSON.stringify(yard, null, 1), 'application/json');
  $('bImportYard').onclick = () => $('fileYard').click();
  $('fileYard').onchange = e => { const f = e.target.files[0]; if (!f) return; f.text().then(t => { const y = JSON.parse(t); if (!Array.isArray(y.boundary)) throw 0; yard = { boundary: y.boundary, points: y.points || (y.exits || []).map((x, k) => ({ id: 'x' + k, name: x.name, type: 'salida', lat: x.lat, lng: x.lng })) }; saveYard(); map.fit(yard.boundary); }).catch(() => banner('Archivo de patio no válido', 'bad', 4000)); };
  $('cpEdit').onclick = e => {
    const d = e.target.dataset;
    if (d.del != null && confirm('¿Quitar "' + yard.points[+d.del].name + '"?')) { yard.points.splice(+d.del, 1); saveYard(); }
    if (d.ren != null) { const n = prompt('Nuevo nombre', yard.points[+d.ren].name); if (n) { yard.points[+d.ren].name = n; saveYard(); } }
  };
  $('cpList').onclick = e => { const el = e.target.closest('[data-id]'); if (el) focusPoint(el.dataset.id); };
  $('bSave').onclick = () => {
    ['maxAcc', 'jumpSpd', 'speedLimit', 'stopSec', 'stopRad', 'stopAlarm', 'covRad', 'freqMin', 'cpRad'].forEach(k => { const v = +$(k).value; cfg[k] = isFinite(v) && $(k).value !== '' && v >= 0 ? v : DEF_CFG[k]; }); if (RN) RN.start(nativeCfg()).catch(() => { });
    cfg.presets = $('presets').value.trim() || DEF_CFG.presets;
    if (run && !run.end && isFinite(run.periodEnd)) run.periodEnd = nextShift(run.start);
    const { gkey, ...save } = cfg; LS.set('rp_cfg', save); fillCfg(); redrawYard();
    banner('Configuración guardada', '', 2000);
  };
  $('evList').onclick = e => { const li = e.target.closest('[data-go]'); if (li) { const [lat, lng] = li.dataset.go.split(',').map(Number); map.center({ lat, lng }, 19); } };
  const cur = () => viewing ? viewing.live : run;
  if (AIS_KEY) { $('ships').hidden = false; $('ships').classList.toggle('on', shipsOn); }
  $('ships').onclick = () => { shipsOn = !shipsOn; LS.set('rp_ships', shipsOn); $('ships').classList.toggle('on', shipsOn); if (shipsOn) { startShips(); banner('Barcos en tiempo real activados (pueden tardar unos minutos en aparecer)', '', 4000); } else stopShips(); };
  $('bRelevo').onclick = () => setRelevo(!(run && run.relevo));
  $('bBeep').onclick = () => { if (RN) { RN.test(); banner('Apaga la pantalla: en 10 s suena la alarma de prueba', '', 8000); return; } SND.alarm(); notify([{ id: 9199, at: Date.now() + 10000, title: 'Prueba de alarma', body: 'Así suena la alarma con la pantalla apagada' }]); if (LN) banner('Apaga la pantalla: en 10 s suena la alarma de prueba', '', 8000); };
  $('bReportNow').onclick = () => sharePdf(cur()).catch(err => banner('No se pudo crear el PDF: ' + err.message, 'bad', 5000));
  $('bXlsNow').onclick = () => shareXlsx(cur()).catch(err => banner('No se pudo crear el Excel: ' + err.message, 'bad', 5000));
  $('bXlsAll').onclick = () => shareAllXlsx().catch(err => banner('No se pudo crear el Excel: ' + err.message, 'bad', 5000));
  $('histList').onclick = e => {
    const h = LS.get('rp_hist', []), d = e.target.dataset;
    if (d.view != null) viewRun(h[+d.view]);
    if (d.pdf != null) sharePdf(h[+d.pdf]).catch(err => banner('No se pudo crear el PDF: ' + err.message, 'bad', 5000));
    if (d.xls != null) shareXlsx(h[+d.xls]).catch(err => banner('No se pudo crear el Excel: ' + err.message, 'bad', 5000));
  };
}
function fillCfg() { Object.keys(DEF_CFG).forEach(k => { if ($(k)) $(k).value = cfg[k]; }); }

/* ---------- Arranque ---------- */
(async function main() {
  bind(); fillCfg();
  $('guard').value = LS.get('rp_guard', '');
  await initMap();
  const saved = LS.get('rp_run', null);
  if (saved && !saved.end && !saved.sim && Date.now() < (saved.periodEnd || nextShift(saved.start))) {
    run = Object.assign(newRun(), saved); run.anchor = null; run.inStop = false; run.near = {}; run.overdue = run.overdue || {};
    run.periodEnd = saved.periodEnd || nextShift(saved.start);
    if (RN && !LS.get('rp_fix15')) { // v1.0.14 repetía posiciones: se rehace el turno desde las posiciones guardadas en el móvil
      LS.set('rp_fix15', 1);
      const keep = { id: run.id, start: run.start, roundStart: run.roundStart, periodEnd: run.periodEnd, shiftLabel: run.shiftLabel, guard: run.guard };
      run = Object.assign(newRun(), keep); cells.forEach(c => { c.covered = false; c.at = null; });
      evT = run.start; logEv('Inicio de turno' + (run.shiftLabel ? ' ' + run.shiftLabel : '') + (run.guard ? ' · ' + run.guard : '') + ' (recalculado)', null, 'acc'); evT = null;
      LS.set('rp_rnsince', run.start - 1); persist(true);
    }
    redrawYard(); map.track(run.track); map.stops(markList(run));
    startGps(); keepAwake();
  } else {
    if (saved && !saved.end) { run = Object.assign(newRun(), saved); redrawYard(); finishRun(); }
    run = null; startRun();
  }
  renderEvents(); renderHist(); renderAll(); startShips(); renderRelevo(); if (RN && RN.relevo && run && run.relevo) RN.relevo({ on: true }).catch(() => { });
  setInterval(() => {
    if (run && !run.end && !viewing && !simTimer && nowT() >= run.periodEnd) { finishRun(); startRun(); renderEvents(); }
    checkOverdue(); renderAll();
    const noFix = Date.now() - lastValidAt;
    if (run && !run.end && !viewing && !simTimer && watchId != null && noFix > 60000) {
      noFixBanner = true;
      banner('Sin posición GPS válida desde hace ' + fmtDur(noFix) + (lastRawAcc != null && lastRawAcc > cfg.maxAcc && Date.now() - lastFixAt < 15000 ? ' (precisión actual ±' + Math.round(lastRawAcc) + ' m, demasiado baja)' : '') + '. Sal de entre los contenedores para recuperarla.', 'warn');
    } else if (noFixBanner) { noFixBanner = false; banner(''); }
  }, 1000);
  if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !window.Capacitor) navigator.serviceWorker.register('sw.js').catch(() => { });
})();

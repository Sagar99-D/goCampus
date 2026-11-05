(async function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LEVEL_TEXT = { many: 'Plenty of seats', some: 'Some seats left', few: 'Almost full', full: 'Full' };

  let cfg;
  try { cfg = await (await fetch('/api/config')).json(); }
  catch (e) { $('statusText').textContent = 'Cannot reach the server'; $('status').className = 'status bad'; return; }

  document.title = cfg.name;
  $('campusName').textContent = cfg.name;
  const stopsById = Object.fromEntries(cfg.stops.map((s) => [s.id, s]));
  const routesById = Object.fromEntries(cfg.routes.map((r) => [r.id, r]));

  /* ---------- map projection ---------- */
  const W = 1000, H = 640, PADX = 120, PADY = 60;
  const allPts = [...cfg.stops, ...cfg.routes.flatMap((r) => r.path)];
  const lat0 = allPts.reduce((a, p) => a + p.lat, 0) / allPts.length;
  const lng0 = allPts.reduce((a, p) => a + p.lng, 0) / allPts.length;
  const kx = Math.cos((lat0 * Math.PI) / 180);
  const raw = (p) => ({ x: (p.lng - lng0) * kx, y: -(p.lat - lat0) });
  const rs = allPts.map(raw);
  const minX = Math.min(...rs.map((p) => p.x)), maxX = Math.max(...rs.map((p) => p.x));
  const minY = Math.min(...rs.map((p) => p.y)), maxY = Math.max(...rs.map((p) => p.y));
  const scale = Math.min((W - 2 * PADX) / (maxX - minX || 1), (H - 2 * PADY) / (maxY - minY || 1));
  const offX = (W - (maxX - minX) * scale) / 2 - minX * scale;
  const offY = (H - (maxY - minY) * scale) / 2 - minY * scale;
  const xy = (p) => { const r = raw(p); return { x: r.x * scale + offX, y: r.y * scale + offY }; };

  const svg = $('map');
  function el(name, attrs, parent) {
    const n = document.createElementNS(NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  const gRoutes = el('g', {}, svg), gStops = el('g', {}, svg), gBuses = el('g', {}, svg);

  cfg.routes.forEach((r, idx) => {
    const d = r.path.map((p, i) => { const q = xy(p); return (i ? 'L' : 'M') + q.x.toFixed(1) + ' ' + q.y.toFixed(1); }).join(' ') + ' Z';
    const w = Math.max(4, 12 - idx * 5);
    el('path', { d, class: 'route-casing', 'stroke-width': w + 6 }, gRoutes);
    el('path', { d, class: 'route-line', stroke: r.color, 'stroke-width': w }, gRoutes);
  });

  const stopEls = {};
  for (const s of cfg.stops) {
    const q = xy(s), right = q.x < W * 0.65;
    const g = el('g', { class: 'stop', tabindex: 0, role: 'button', 'aria-label': 'Select stop ' + s.name }, gStops);
    el('circle', { class: 'halo', cx: q.x, cy: q.y, r: 20 }, g);
    el('circle', { class: 'dotc', cx: q.x, cy: q.y, r: 8 }, g);
    const t = el('text', { x: q.x + (right ? 14 : -14), y: q.y + 5, 'text-anchor': right ? 'start' : 'end' }, g);
    t.textContent = s.name;
    g.addEventListener('click', () => selectStop(s.id));
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectStop(s.id); } });
    stopEls[s.id] = g;
  }

  const busEls = {};
  function updateBus(b) {
    let e = busEls[b.id];
    const q = xy(b), route = routesById[b.routeId];
    if (!e) {
      const g = el('g', { class: 'bus lvl-' + b.level }, gBuses);
      el('circle', { class: 'ring', r: 20 }, g);
      el('circle', { class: 'body', r: 14, fill: route.color }, g);
      const t = el('text', {}, g);
      t.textContent = (b.name.match(/\d+/) || [b.name[0]])[0];
      const title = el('title', {}, g);
      e = busEls[b.id] = { g, title };
      g.style.transform = `translate(${q.x}px, ${q.y}px)`;
      requestAnimationFrame(() => requestAnimationFrame(() => g.classList.add('ready')));
    }
    e.g.style.transform = `translate(${q.x}px, ${q.y}px)`;
    e.g.setAttribute('class', `bus ready lvl-${b.level}${b.source === 'offline' ? ' offline' : ''}`);
    e.title.textContent = `${b.name} (${route.name}): ${b.seatsFree} of ${b.capacity} seats free`;
  }

  /* ---------- stop picker ---------- */
  const sel = $('stopSelect');
  sel.innerHTML = cfg.stops.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  try { const saved = localStorage.getItem('stop'); if (saved && stopsById[saved]) sel.value = saved; } catch (e) {}
  function selectStop(id) {
    sel.value = id;
    try { localStorage.setItem('stop', id); } catch (e) {}
    if (last) render(last);
  }
  sel.addEventListener('change', () => selectStop(sel.value));
  $('nearBtn').addEventListener('click', () => {
    const btn = $('nearBtn');
    if (!navigator.geolocation) { btn.textContent = 'Location not available'; return; }
    btn.textContent = 'Locating...';
    navigator.geolocation.getCurrentPosition((pos) => {
      let best = null, bd = Infinity;
      for (const s of cfg.stops) {
        const d = Math.hypot((s.lat - pos.coords.latitude), (s.lng - pos.coords.longitude) * kx);
        if (d < bd) { bd = d; best = s; }
      }
      selectStop(best.id);
      btn.textContent = 'Nearest stop: ' + best.name;
    }, () => { btn.textContent = 'Could not get your location'; }, { timeout: 8000 });
  });

  /* ---------- rendering ---------- */
  function pips(b) {
    return `<div class="pips" aria-hidden="true">${'<i class="on"></i>'.repeat(b.occupancy)}${'<i></i>'.repeat(b.seatsFree)}</div>`;
  }
  function seatText(b) {
    return b.seatsFree > 0 ? `${LEVEL_TEXT[b.level]}: ${b.seatsFree} of ${b.capacity} free` : 'Full: no seats free';
  }
  function eta(sec) {
    if (sec == null) return { big: '–', unit: '' };
    if (sec < 30) return { big: 'Now', unit: '' };
    return { big: String(Math.max(1, Math.round(sec / 60))), unit: 'min' };
  }
  function where(b) {
    if (b.source === 'offline') return 'No GPS signal';
    const tag = b.source === 'sim' ? ' (demo)' : '';
    if (b.atStop) return `At ${stopsById[b.atStop].name}${tag}`;
    return `Next stop: ${stopsById[b.nextStop].name}${tag}`;
  }

  let last = null;
  function render(snap) {
    last = snap;
    const live = snap.buses.some((b) => b.source === 'gps');
    $('status').className = 'status ' + (live ? 'live' : snap.simulate ? 'demo' : 'bad');
    $('statusText').textContent = live ? 'Live GPS' : snap.simulate ? 'Demo data' : 'Waiting for buses';

    snap.buses.forEach(updateBus);
    for (const id in stopEls) stopEls[id].classList.toggle('sel', id === sel.value);

    const stopId = sel.value, stop = stopsById[stopId];
    $('arrivalsTitle').textContent = 'Next shuttles at ' + stop.name;
    const rows = snap.buses
      .filter((b) => b.etas && b.etas[stopId] !== undefined)
      .sort((a, b) => a.etas[stopId] - b.etas[stopId]).slice(0, 4);
    if (!rows.length) {
      const serving = cfg.routes.filter((r) => r.stopIds.includes(stopId));
      $('arrivals').innerHTML = `<li class="empty">${serving.length
        ? 'Waiting for a GPS signal from ' + esc(serving.map((r) => r.name).join(' or ')) + '. Check back shortly.'
        : 'No shuttle route serves this stop.'}</li>`;
    } else {
      $('arrivals').innerHTML = rows.map((b, i) => {
        const r = routesById[b.routeId], p = eta(b.etas[stopId]);
        return `<li class="arrival${i === 0 ? ' first' : ''} lvl-${b.level}" style="--rc:${esc(r.color)}">
          <div><div class="rt">${esc(r.name)}<span class="bn">${esc(b.name)}</span></div>
            <div class="where">${esc(where(b))}</div>${pips(b)}<div class="seatTxt">${esc(seatText(b))}</div></div>
          <div class="eta"><span class="big">${p.big}</span><span class="unit">${p.unit}</span></div></li>`;
      }).join('');
    }

    $('fleet').innerHTML = snap.buses.map((b) => {
      const r = routesById[b.routeId];
      return `<li class="fleetItem lvl-${b.level}" style="--rc:${esc(r.color)}"><span class="swatch"></span>
        <div><strong>${esc(b.name)}</strong><span class="rn">${esc(r.name)}</span>
        <div class="where">${esc(where(b))}${b.offRoute ? ', off route' : ''}</div></div>
        <div class="free">${b.seatsFree}<small>seats free</small></div></li>`;
    }).join('');
  }

  /* ---------- live connection ---------- */
  let lastMsg = 0;
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => { lastMsg = Date.now(); render(JSON.parse(e.data)); };
  es.onerror = () => { $('status').className = 'status bad'; $('statusText').textContent = 'Reconnecting...'; };
  setInterval(() => {
    if (lastMsg && Date.now() - lastMsg > 5000) { $('status').className = 'status bad'; $('statusText').textContent = 'Connection lost'; }
  }, 2000);
})();

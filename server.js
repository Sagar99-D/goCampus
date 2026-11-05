'use strict';
/**
 * Campus Shuttle Tracker - backend (zero dependencies, Node 16+)
 *
 *  GET  /api/config                    campus, stops, routes, buses
 *  GET  /api/state                     one snapshot of all buses (live position, ETAs, seats)
 *  GET  /api/stream                    Server-Sent Events: a snapshot every second
 *  POST /api/buses/:id/location        {lat, lng, speed?}   <- driver phone / GPS tracker
 *  POST /api/buses/:id/door            {event:"in"|"out", count?}  <- IR door sensor (ESP32)
 *  POST /api/buses/:id/occupancy       {count}              <- manual correction
 *
 * Env: PORT (3000), SIMULATE (true|false), DEVICE_KEY (shared secret for POST routes)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = +process.env.PORT || 3000;
const SIMULATE = process.env.SIMULATE !== 'false';
const DEVICE_KEY = process.env.DEVICE_KEY || '';
const GPS_TIMEOUT_MS = 15000;     // after this, a bus is no longer "live GPS"
const DOOR_TIMEOUT_MS = 60000;    // simulator stays out of the way while a real sensor reports
const DWELL_SECONDS = 15;         // average time a shuttle waits at each stop (for ETA)
const MIN_SPEED = 3;              // m/s floor used in ETA so a stopped bus never gives infinite ETA
const PUBLIC = path.join(__dirname, 'public');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'campus.json'), 'utf8'));
const stopsById = Object.fromEntries(cfg.stops.map((s) => [s.id, s]));

/* ---------- geometry (local flat projection in metres) ---------- */
const lat0 = cfg.stops[0].lat, lng0 = cfg.stops[0].lng;
const KX = Math.cos((lat0 * Math.PI) / 180) * 111320, KY = 110540;
const toM = (lat, lng) => ({ x: (lng - lng0) * KX, y: (lat - lat0) * KY });

function buildRoute(r) {
  const pts = [], stopAt = {};
  for (const item of r.path) {
    if (typeof item === 'string') {
      if (!stopsById[item]) throw new Error(`Route ${r.id}: unknown stop "${item}"`);
      stopAt[item] = pts.length;
    }
    const [lat, lng] = typeof item === 'string' ? [stopsById[item].lat, stopsById[item].lng] : item;
    pts.push({ lat, lng, ...toM(lat, lng) });
  }
  pts.push({ ...pts[0] }); // close the loop
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  const stopDist = {};
  for (const id in stopAt) stopDist[id] = cum[stopAt[id]];
  return { id: r.id, name: r.name, color: r.color, pts, cum, length: cum[cum.length - 1], stopDist, stopIds: r.path.filter((x) => typeof x === 'string') };
}
const routes = Object.fromEntries(cfg.routes.map((r) => [r.id, buildRoute(r)]));

/** Snap a GPS fix to the route; returns distance along the loop (s) and off-route distance (d). */
function project(route, lat, lng) {
  const p = toM(lat, lng);
  let best = { d: Infinity, s: 0 };
  for (let i = 0; i < route.pts.length - 1; i++) {
    const a = route.pts[i], b = route.pts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    if (d < best.d) best = { d, s: route.cum[i] + t * Math.sqrt(l2) };
  }
  return best;
}
function pointAt(route, s) {
  s = ((s % route.length) + route.length) % route.length;
  let i = 1;
  while (i < route.cum.length - 1 && route.cum[i] < s) i++;
  const a = route.pts[i - 1], b = route.pts[i];
  const t = (s - route.cum[i - 1]) / (route.cum[i] - route.cum[i - 1] || 1);
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

/* ---------- bus state ---------- */
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const buses = cfg.buses.map((b) => {
  const r = routes[b.routeId];
  if (!r) throw new Error(`Bus ${b.id}: unknown route "${b.routeId}"`);
  const s = (b.startOffset || 0) * r.length;
  return {
    id: b.id, name: b.name, routeId: b.routeId, capacity: b.capacity,
    occupancy: rand(0, Math.floor(b.capacity * 0.6)),
    s, ...pointAt(r, s), speed: 0, avgSpeed: 6, simSpeed: 5.5 + Math.random() * 1.5,
    lastGps: 0, lastDoor: 0, dwellUntil: 0, totalIn: 0, totalOut: 0, offRoute: false
  };
});
const busById = Object.fromEntries(buses.map((b) => [b.id, b]));

function changeOccupancy(b, delta) {
  b.occupancy = Math.max(0, Math.min(b.capacity, b.occupancy + delta));
}
function applyDoor(b, event, count) {
  changeOccupancy(b, event === 'in' ? count : -count);
  if (event === 'in') b.totalIn += count; else b.totalOut += count;
  b.lastDoor = Date.now();
}
function updateGps(b, lat, lng, speed) {
  const r = routes[b.routeId], now = Date.now();
  const pr = project(r, lat, lng);
  let v = speed;
  if (!(v >= 0) && b.lastGps) {
    const dt = (now - b.lastGps) / 1000, ds = (pr.s - b.s + r.length) % r.length;
    if (dt > 0 && ds < r.length / 2) v = ds / dt;
  }
  if (v > 0.5) b.avgSpeed = b.avgSpeed * 0.8 + Math.min(v, 20) * 0.2;
  b.lat = lat; b.lng = lng; b.s = pr.s; b.speed = v >= 0 ? v : 0;
  b.offRoute = pr.d > 60;
  b.lastGps = now;
}

/* ---------- simulator (demo mode) ---------- */
function simPassengers(b) {
  if (Date.now() - b.lastDoor < DOOR_TIMEOUT_MS) return; // real IR sensor is reporting
  changeOccupancy(b, -rand(0, Math.min(b.occupancy, 8)));
  changeOccupancy(b, rand(0, 9));
}
function simTick(dt) {
  if (!SIMULATE) return;
  const now = Date.now();
  for (const b of buses) {
    if (now - b.lastGps < GPS_TIMEOUT_MS) continue; // real GPS wins
    if (now < b.dwellUntil) { b.speed = 0; continue; }
    const r = routes[b.routeId], prev = b.s;
    let next = (prev + b.simSpeed * dt) % r.length;
    for (const id of r.stopIds) {
      const sd = r.stopDist[id];
      const crossed = prev <= next ? prev < sd && sd <= next : sd > prev || sd <= next;
      if (crossed) { next = sd; b.dwellUntil = now + 7000; simPassengers(b); break; }
    }
    b.s = next; b.speed = b.simSpeed;
    b.avgSpeed = b.avgSpeed * 0.95 + b.simSpeed * 0.05;
    Object.assign(b, pointAt(r, b.s));
  }
}

/* ---------- snapshot with ETAs ---------- */
function snapshot() {
  const now = Date.now();
  return {
    time: now, simulate: SIMULATE,
    buses: buses.map((b) => {
      const r = routes[b.routeId];
      const source = now - b.lastGps < GPS_TIMEOUT_MS ? 'gps' : SIMULATE ? 'sim' : 'offline';
      const free = b.capacity - b.occupancy, ratio = free / b.capacity;
      const level = free <= 0 ? 'full' : ratio < 0.2 ? 'few' : ratio < 0.5 ? 'some' : 'many';
      let etas = null, nextStop = null, atStop = null;
      if (source !== 'offline') {
        etas = {};
        const v = Math.max(b.avgSpeed, MIN_SPEED);
        const list = r.stopIds
          .map((id) => ({ id, dist: (r.stopDist[id] - b.s + r.length) % r.length }))
          .sort((x, y) => x.dist - y.dist);
        let between = 0;
        for (const it of list) {
          if (it.dist < 15) { etas[it.id] = 0; atStop = it.id; continue; }
          if (!nextStop) nextStop = it.id;
          etas[it.id] = Math.round(it.dist / v + between * DWELL_SECONDS);
          between++;
        }
      }
      return {
        id: b.id, name: b.name, routeId: b.routeId, source, lat: b.lat, lng: b.lng,
        speedKmh: Math.round(b.speed * 3.6), offRoute: b.offRoute,
        capacity: b.capacity, occupancy: b.occupancy, seatsFree: free, level,
        etas, nextStop, atStop
      };
    })
  };
}

/* ---------- HTTP ---------- */
const publicConfig = {
  name: cfg.name, stops: cfg.stops,
  routes: Object.values(routes).map((r) => ({
    id: r.id, name: r.name, color: r.color, stopIds: r.stopIds,
    path: r.pts.slice(0, -1).map((p) => ({ lat: p.lat, lng: p.lng }))
  })),
  buses: cfg.buses.map((b) => ({ id: b.id, name: b.name, routeId: b.routeId, capacity: b.capacity }))
};
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const clients = new Set();

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 10000) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type,x-api-key' });
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/api/config') return send(res, 200, publicConfig);
    if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, snapshot());
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    const m = url.pathname.match(/^\/api\/buses\/([\w-]+)\/(location|door|occupancy)$/);
    if (req.method === 'POST' && m) {
      if (DEVICE_KEY && req.headers['x-api-key'] !== DEVICE_KEY) return send(res, 401, { error: 'Invalid or missing x-api-key' });
      const bus = busById[m[1]];
      if (!bus) return send(res, 404, { error: `Unknown bus "${m[1]}"` });
      const body = await readJson(req);
      if (m[2] === 'location') {
        const lat = Number(body.lat), lng = Number(body.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return send(res, 400, { error: 'lat and lng must be valid numbers' });
        updateGps(bus, lat, lng, body.speed == null ? NaN : Number(body.speed));
        return send(res, 200, { ok: true });
      }
      if (m[2] === 'door') {
        if (body.event !== 'in' && body.event !== 'out') return send(res, 400, { error: 'event must be "in" or "out"' });
        const count = Math.max(1, Math.min(10, parseInt(body.count, 10) || 1));
        applyDoor(bus, body.event, count);
        return send(res, 200, { ok: true, occupancy: bus.occupancy, seatsFree: bus.capacity - bus.occupancy });
      }
      const n = parseInt(body.count, 10);
      if (!Number.isInteger(n) || n < 0 || n > bus.capacity) return send(res, 400, { error: `count must be 0-${bus.capacity}` });
      bus.occupancy = n; bus.lastDoor = Date.now();
      return send(res, 200, { ok: true, occupancy: bus.occupancy });
    }

    if (req.method !== 'GET') return send(res, 404, { error: 'Not found' });
    let p = path.normalize(decodeURIComponent(url.pathname));
    if (p === path.sep || p === '.') p = path.sep + 'index.html';
    const file = path.join(PUBLIC, p);
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'Forbidden' });
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

setInterval(() => simTick(0.5), 500);
setInterval(() => {
  if (!clients.size) return;
  const msg = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const c of clients) c.write(msg);
}, 1000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nCampus Shuttle Tracker running (${SIMULATE ? 'demo simulation ON' : 'live data only'})`);
  console.log(`  Passengers : http://localhost:${PORT}/`);
  console.log(`  Driver app : http://localhost:${PORT}/driver.html`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list) if (i.family === 'IPv4' && !i.internal) console.log(`  On network : http://${i.address}:${PORT}/`);
  if (!DEVICE_KEY) console.log('  Note: DEVICE_KEY not set - anyone on the network can post bus data.');
});

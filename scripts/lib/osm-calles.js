/**
 * osm-calles.js — Motor de geometría real de calles (OpenStreetMap / Nominatim)
 * ---------------------------------------------------------------------------
 * Resuelve NOMBRES de calles de una noticia a su geometría real en OSM y calcula
 * intersecciones exactas entre calles. Sin API key, sin hardcodeos.
 *
 *   const osm = require('./lib/osm-calles');
 *   const ctx = { centro: [lat, lon] };   // centroide de la ciudad (georef)
 *   const seg = await osm.segmentoEntre('Corrientes','La Paz','Colón','Paraná','Entre Ríos', ctx);
 *   // → { puntos: [[lat,lon],...], desde:[lat,lon], hasta:[lat,lon], largo_m }
 *
 * Reglas:
 *   - Nunca inventa coordenadas: si la calle no existe en OSM → null.
 *   - TODA consulta se acota a una caja alrededor del centro de la ciudad, para
 *     que "Santa Fe" (provincia) no devuelva calles de Rosario.
 *   - Cache en disco (data/.cache-osm.json).
 *   - Rate limit: 1 request/segundo (política de Nominatim).
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const UA = 'vxl-widgets-transito/2.0 (https://github.com/tet4s/vxl-widgets)';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const CACHE_FILE = path.join(__dirname, '../../data/.cache-osm.json');
const MIN_INTERVAL_MS = 1100;    // política Nominatim: máx 1 req/s
const MAX_CORTE_M = 5000;        // un tramo entre 2 esquinas > 5km es sospechoso
const TOLERANCIA_CRUCE_M = 40;   // distancia máx para considerar que 2 calles se cruzan
const RADIO_CIUDAD_LAT = 0.10;   // ~11 km desde el centroide de la ciudad
const RADIO_CIUDAD_LON = 0.14;   // ~13-17 km según latitud

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── cache en disco ─────────────────────────────────────────────────────── */
let cache = null;
let lastCall = 0;

function loadCache() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch (_) { cache = {}; }
  return cache;
}
function saveCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8');
  } catch (_) { /* cache no es crítico */ }
}

function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}
function clave(nombre, ciudad, provincia, box) {
  return [nombre, ciudad, provincia].map(norm).join('|') +
    (box ? '|' + box.map(v => v.toFixed(2)).join(',') : '');
}

async function throttle() {
  const dt = Date.now() - lastCall;
  if (dt < MIN_INTERVAL_MS) await sleep(MIN_INTERVAL_MS - dt);
  lastCall = Date.now();
}

/** Caja de la ciudad a partir de su centroide: [minLon,minLat,maxLon,maxLat] */
function cajaCiudad(centro) {
  if (!centro || centro.length < 2) return null;
  const [lat, lon] = centro;
  return [lon - RADIO_CIUDAD_LON, lat - RADIO_CIUDAD_LAT, lon + RADIO_CIUDAD_LON, lat + RADIO_CIUDAD_LAT];
}

function intersectarCajas(a, b) {
  if (!a) return b;
  if (!b) return a;
  const r = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return (r[0] < r[2] && r[1] < r[3]) ? r : b; // si no se tocan, usar la más específica
}

/* ── consulta a Nominatim ───────────────────────────────────────────────── */
/**
 * Polilíneas reales de una calle. Cada polilínea es un array de [lat, lon].
 * @param {object} [opts] { centro: [lat,lon], viewbox: [minLon,minLat,maxLon,maxLat] }
 * @returns {Promise<Array<Array<[number,number]>>>}
 */
async function calles(nombre, ciudad, provincia, opts) {
  if (!nombre || !ciudad) return [];
  opts = opts || {};
  loadCache();

  const box = intersectarCajas(cajaCiudad(opts.centro), opts.viewbox || null);
  const k = clave(nombre, ciudad, provincia, box);
  if (k in cache) return cache[k];

  const out = [];
  try {
    await throttle();
    const params = {
      street: nombre,
      city: ciudad,
      state: provincia,
      country: 'Argentina',
      format: 'json',
      polygon_geojson: 1,
      limit: 50,
      dedupe: 0,
      addressdetails: 0,
    };
    if (box) {
      // Nominatim: viewbox = left,top,right,bottom
      params.viewbox = [box[0], box[3], box[2], box[1]].map(v => v.toFixed(5)).join(',');
      params.bounded = 1;
    }
    const res = await axios.get(NOMINATIM, {
      params,
      headers: { 'User-Agent': UA, 'Accept-Language': 'es' },
      timeout: 25000,
    });

    for (const r of (res.data || [])) {
      if (r.class !== 'highway' || !r.geojson) continue;
      const g = r.geojson;
      const lineas = g.type === 'LineString' ? [g.coordinates]
        : g.type === 'MultiLineString' ? g.coordinates
        : [];
      for (const l of lineas) {
        if (!l || l.length < 2) continue;
        out.push(l.map(c => [+c[1], +c[0]])); // GeoJSON [lon,lat] → [lat,lon]
      }
    }
  } catch (e) {
    if (process.env.OSM_DEBUG) console.error('[osm] error ' + nombre + ': ' + (e.code || e.message));
  }

  cache[k] = out;
  saveCache();
  return out;
}

/** Bounding box [minLon,minLat,maxLon,maxLat] de una lista de polilíneas. */
function bboxPolys(polys) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const poly of polys) for (const [lat, lon] of poly) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  if (!isFinite(minLat)) return null;
  return [minLon, minLat, maxLon, maxLat];
}

/* ── geometría ──────────────────────────────────────────────────────────── */
function distM(a, b) {
  const R = 6371000;
  const la = (a[0] + b[0]) / 2 * Math.PI / 180;
  const dy = (b[0] - a[0]) * Math.PI / 180 * R;
  const dx = (b[1] - a[1]) * Math.PI / 180 * R * Math.cos(la);
  return Math.hypot(dx, dy);
}

/** Punto de A más cercano a cualquier punto de B. */
function puntoMasCercano(polysA, polysB) {
  let best = { d: Infinity, a: null, b: null };
  for (const A of polysA) {
    for (const pa of A) {
      for (const B of polysB) {
        for (const pb of B) {
          const d = distM(pa, pb);
          if (d < best.d) best = { d, a: pa, b: pb };
        }
      }
    }
  }
  return best;
}

/** Intersección exacta entre dos calles (o null si no se cruzan). */
async function interseccion(calleA, calleB, ciudad, provincia, opts) {
  opts = opts || {};
  const A = await calles(calleA, ciudad, provincia, opts);
  if (!A.length) return null;

  const box = bboxPolys(A);
  const pad = 0.012; // ~1.3 km de margen
  const vb = box ? [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad] : null;

  let B = vb ? await calles(calleB, ciudad, provincia, { centro: opts.centro, viewbox: vb }) : [];
  if (!B.length) B = await calles(calleB, ciudad, provincia, { centro: opts.centro });
  if (!B.length) return null;

  const c = puntoMasCercano(A, B);
  if (!isFinite(c.d) || c.d > TOLERANCIA_CRUCE_M) return null;
  return [(c.a[0] + c.b[0]) / 2, (c.a[1] + c.b[1]) / 2];
}

/**
 * Construye el grafo de la calle (todas sus vías) y devuelve el camino
 * más corto entre dos puntos: la polilínea REAL de la calle.
 */
function caminoEntre(polys, p1, p2) {
  const nodos = [];
  const idx = new Map();
  const adj = [];
  const keyOf = p => p[0].toFixed(5) + ',' + p[1].toFixed(5);

  const addNodo = p => {
    const k = keyOf(p);
    if (idx.has(k)) return idx.get(k);
    const i = nodos.length;
    nodos.push([p[0], p[1]]);
    adj.push([]);
    idx.set(k, i);
    return i;
  };

  for (const poly of polys) {
    let prev = -1;
    for (const p of poly) {
      const i = addNodo(p);
      if (prev >= 0 && prev !== i) {
        const w = distM(nodos[prev], nodos[i]);
        adj[prev].push([i, w]);
        adj[i].push([prev, w]);
      }
      prev = i;
    }
  }
  if (nodos.length < 2) return null;

  const nearest = p => {
    let bi = -1, bd = Infinity;
    for (let i = 0; i < nodos.length; i++) {
      const d = distM(nodos[i], p);
      if (d < bd) { bd = d; bi = i; }
    }
    return { i: bi, d: bd };
  };
  const n1 = nearest(p1);
  const n2 = nearest(p2);
  if (n1.i < 0 || n2.i < 0) return null;
  if (n1.d > TOLERANCIA_CRUCE_M || n2.d > TOLERANCIA_CRUCE_M) return null;
  if (n1.i === n2.i) return null;

  // Dijkstra (grafo chico)
  const N = nodos.length;
  const dist = new Array(N).fill(Infinity);
  const prev = new Array(N).fill(-1);
  const done = new Array(N).fill(false);
  dist[n1.i] = 0;

  for (let iter = 0; iter < N; iter++) {
    let u = -1, best = Infinity;
    for (let i = 0; i < N; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
    if (u < 0) break;
    if (u === n2.i) break;
    done[u] = true;
    for (const [v, w] of adj[u]) {
      const nd = dist[u] + w;
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; }
    }
  }
  if (!isFinite(dist[n2.i])) return null;

  const camino = [];
  for (let v = n2.i; v >= 0; v = prev[v]) {
    camino.push(nodos[v]);
    if (v === n1.i) break;
  }
  camino.reverse();

  // Reemplazar los extremos por las coordenadas exactas del cruce
  if (camino.length >= 2) {
    camino[0] = [p1[0], p1[1]];
    camino[camino.length - 1] = [p2[0], p2[1]];
  }
  return camino;
}

function largoM(poly) {
  let t = 0;
  for (let i = 1; i < poly.length; i++) t += distM(poly[i - 1], poly[i]);
  return t;
}

/* ── API principal ──────────────────────────────────────────────────────── */
/**
 * Tramo de `calle` entre las esquinas `desde` y `hasta`.
 * @returns {Promise<null|{puntos:Array, desde:Array, hasta:Array, largo_m:number}>}
 */
async function segmentoEntre(calle, desde, hasta, ciudad, provincia, opts) {
  if (!calle || !desde || !hasta) return null;
  opts = opts || {};

  const p1 = await interseccion(calle, desde, ciudad, provincia, opts);
  if (!p1) return null;
  const p2 = await interseccion(calle, hasta, ciudad, provincia, opts);
  if (!p2) return null;
  if (distM(p1, p2) < 15) return null;

  // Traer solo el trozo de la calle entre las dos esquinas
  const minLat = Math.min(p1[0], p2[0]), maxLat = Math.max(p1[0], p2[0]);
  const minLon = Math.min(p1[1], p2[1]), maxLon = Math.max(p1[1], p2[1]);
  const pad = 0.006;
  const vb = [minLon - pad, minLat - pad, maxLon + pad, maxLat + pad];

  let polys = await calles(calle, ciudad, provincia, { centro: opts.centro, viewbox: vb });
  if (!polys.length) polys = await calles(calle, ciudad, provincia, opts);
  if (!polys.length) return null;

  const camino = caminoEntre(polys, p1, p2);
  const puntos = camino && camino.length >= 2 ? camino : [p1, p2];
  const largo = largoM(puntos);
  if (largo > MAX_CORTE_M) return null;

  return { puntos, desde: p1, hasta: p2, largo_m: Math.round(largo) };
}

/** Punto exacto donde se cruzan dos calles. */
async function esquina(calleA, calleB, ciudad, provincia, opts) {
  return interseccion(calleA, calleB, ciudad, provincia, opts);
}

/** Punto medio real de una calle (sobre su propia geometría). */
async function puntoCalle(calle, ciudad, provincia, opts) {
  const polys = await calles(calle, ciudad, provincia, opts);
  if (!polys.length) return null;
  const orden = polys.slice().sort((a, b) => largoM(b) - largoM(a));
  const poly = orden[0];
  if (poly.length < 2) return poly[0] ? [poly[0][0], poly[0][1]] : null;
  const total = largoM(poly);
  let acc = 0;
  for (let i = 1; i < poly.length; i++) {
    const d = distM(poly[i - 1], poly[i]);
    if (acc + d >= total / 2) {
      const t = d > 0 ? (total / 2 - acc) / d : 0;
      return [
        poly[i - 1][0] + (poly[i][0] - poly[i - 1][0]) * t,
        poly[i - 1][1] + (poly[i][1] - poly[i - 1][1]) * t,
      ];
    }
    acc += d;
  }
  return [poly[poly.length - 1][0], poly[poly.length - 1][1]];
}

module.exports = {
  calles,
  interseccion,
  esquina,
  segmentoEntre,
  puntoCalle,
  caminoEntre,
  bboxPolys,
  distM,
  norm,
  MAX_CORTE_M,
};

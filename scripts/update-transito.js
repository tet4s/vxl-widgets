/**
 * Scraper de alertas de tránsito — Litoral AR (Paraná + Santa Fe)
 * ---------------------------------------------------------------------------
 * Output: data/transito.json (schema compatible con widgets/mapa-alertas)
 *
 * items[].{ id, titulo, categoria, tipo, fecha, fecha_raw, horario, resumen,
 *            descripcion, enlace, lat, lon, localidad, provincia, via,
 *            km_desde, km_hasta, vigente_hasta, puntos }
 *
 * REGLA (estricta): NUNCA coords inventadas.
 *   - lat/lon provienen de georef-ar-api (oficial, gratuito).
 *   - Si no se resuelve → se DESCARTA la alerta.
 *   - Sin radios ni polígonos inventados.
 *   - Zonas amplias = línea entre puntos reales geocodificados.
 *
 * Fuentes:
 *   EL LITORAL   https://www.ellitoral.com/temas/estado-del-transito (Santa Fe)
 *   RUTA0        https://www.ruta0.com/estado-de-rutas/litoral/ (litoral)
 *   APSV         https://www.santafe.gob.ar/noticias/noticia/279907 (Santa Fe)
 *   APFDIGITAL   https://www.apfdigital.com.ar/rss/municipales/ (Paraná)
 *                https://www.apfdigital.com.ar/rss/noticias/ (Paraná)
 *
 * Cron: .github/workflows/update-transito.yml
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const osm = require('./lib/osm-calles');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Rutas de salida. Por defecto, ../data/ al lado del scraper (repo o VPS con data/).
// Se pueden pisar por variable de entorno para instalar el paquete en cualquier lado:
//   TRANSITO_OUT=/var/www/sitio/data/transito.json
const DIR_DATOS = process.env.TRANSITO_DIR
  ? path.resolve(process.env.TRANSITO_DIR)
  : path.join(__dirname, '../data');
const OUTPUT = path.join(DIR_DATOS, 'transito.json');
const PROVS_OK = ['Santa Fe', 'Entre Ríos'];
const MAX = 30;
const DIST_MAX_CIUDAD = 0.5; // grados (~50km) — máxima distancia del centroide de la ciudad
const GEO_CACHE = {}; // cache de georef para no repetir consultas (evita 429)
const GEO_DELAY = 200; // ms entre consultas a georef

const log = m => console.log('[scraper] ' + m);
const pad = n => String(n).padStart(2, '0');

function clean(t){ return (t||'').replace(/<script[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/window\.googletag[\s\S]*?;\s*/g,' ').replace(/\s+/g,' ').trim(); }
function short(t,m=180){ t=clean(t); return t.length<=m?t:t.slice(0,m).trim()+'…'; }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function fetch(url, tries=3){
  for(let i=0;i<tries;i++){ try{ return (await axios.get(url,{headers:{'User-Agent':UA,'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9','Accept-Language':'es-ES,es;q=0.9','sec-ch-ua':'"Chromium";v="120", "Not_A Brand";v="20", "Brave";v="120"','sec-ch-ua-mobile':'?0','sec-ch-ua-platform':'"Windows"','sec-fetch-dest':'document','sec-fetch-mode':'navigate','sec-fetch-site':'none','sec-fetch-user':'?1','upgrade-insecure-requests':'1'},timeout:25000})).data; }catch(e){ if(i===tries-1) throw e; await sleep(1200*(i+1)); } }
}

/* ════════════════════════════════════════════════════════════════════════════
   GEOREF (apis.datos.gob.ar — gratuito, oficial)
   NUNCA invento coords: si devuelve cantidad 0 / no resuelve → null.
   ════════════════════════════════════════════════════════════════════════════ */

async function georefCiudad(localidad, provincia){
  if(!localidad) return null;
  const key = 'ciudad:' + (localidad||'') + ':' + (provincia||'');
  if(key in GEO_CACHE) return GEO_CACHE[key];
  try{
    await sleep(GEO_DELAY);
    const params = { nombre: localidad, max: 5 };
    if(provincia) params.provincia = provincia;
    const res = await axios.get('https://apis.datos.gob.ar/georef/api/localidades', { params, headers:{'User-Agent':UA}, timeout:8000 });
    const locs = res.data && res.data.localidades;
    if(!locs || !locs.length){ GEO_CACHE[key] = null; return null; }
    // Preferir la que matchea exacto el nombre y la provincia
    const exacta = locs.find(l => (l.nombre||'').toLowerCase() === (localidad||'').toLowerCase() && (!provincia || (l.provincia&&l.provincia.nombre===provincia)));
    const loc = exacta || locs[0];
    if(loc && loc.centroide && loc.centroide.lat!=null && loc.centroide.lon!=null){
      const result = { lat: loc.centroide.lat, lon: loc.centroide.lon,
               provincia: (loc.provincia&&loc.provincia.nombre)||provincia,
               localidad: loc.nombre||localidad };
      GEO_CACHE[key] = result;
      return result;
    }
  }catch(e){ log('   ⚠ georefCiudad: '+(e.message||e)); }
  GEO_CACHE[key] = null;
  return null;
}

async function georefDireccion(direccion, provincia, localidad){
  if(!direccion) return null;
  const dir = clean(direccion);
  const key = 'dir:' + dir + ':' + (provincia||'') + ':' + (localidad||'');
  if(key in GEO_CACHE) return GEO_CACHE[key];
  try{
    await sleep(GEO_DELAY);
    const params = { direccion: dir };
    if(provincia) params.provincia = provincia;
    if(localidad && localidad !== provincia) params.localidad = localidad;
    const res = await axios.get('https://apis.datos.gob.ar/georef/api/direcciones', { params, headers:{'User-Agent':UA}, timeout:8000 });
    const r = res.data && res.data.direcciones && res.data.direcciones[0];
    if(r && r.ubicacion && r.ubicacion.lat!=null && r.ubicacion.lon!=null){
      const result = { lat:r.ubicacion.lat, lon:r.ubicacion.lon,
               provincia: (r.provincia&&r.provincia.nombre)||provincia,
               localidad: (r.localidad&&r.localidad.nombre)||(r.localidad_censal&&r.localidad_censal.nombre)||localidad };
      GEO_CACHE[key] = result;
      return result;
    }
  }catch(e){ log('   ⚠ georefDireccion: '+(e.message||e)); }
  GEO_CACHE[key] = null;
  return null;
}

function validarPunto(punto, provinciaEsperada, centroCiudad){
  if(!punto || punto.lat==null || punto.lon==null) return false;
  if(provinciaEsperada && punto.provincia && punto.provincia !== provinciaEsperada) return false;
  if(centroCiudad && centroCiudad.lat!=null){
    const dist = Math.abs(punto.lat - centroCiudad.lat) + Math.abs(punto.lon - centroCiudad.lon);
    if(dist > DIST_MAX_CIUDAD) return false;
  }
  return true;
}

/* ════════════════════════════════════════════════════════════════════════════
   PARSERS
   ════════════════════════════════════════════════════════════════════════════ */
const RE_TS = /(\d{1,2}:\d{2})\s*\/\s*([A-Z][a-z]{2})\s*\.\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/;
function tsToISO(ts){ if(!ts) return ''; const m=String(ts).match(RE_TS); if(m) return `${m[5]}-${pad(m[4])}-${pad(m[3])}T${m[1]}:00-03:00`; const d=new Date(ts); return isNaN(+d)?'':d.toISOString(); }

function parseFecha(txt, url){
  if(!txt) txt='';
  // Formato El Litoral: "10:00 / Vie. 30.10.2026"
  const mTS = txt.match(RE_TS);
  if(mTS) return tsToISO(mTS[0]);
  // Formato: "28 de Octubre de 2026"
  const mTxt = txt.match(/(\d{1,2})\s+de\s+([A-Za-z]+)\s+de\s+(\d{4})/);
  if(mTxt){
    const meses = {enero:'01',febrero:'02',marzo:'03',abril:'04',mayo:'05',junio:'06',julio:'07',agosto:'08',septiembre:'09',octubre:'10',noviembre:'11',diciembre:'12'};
    const mes = meses[mTxt[2].toLowerCase()] || '01';
    return `${mTxt[3]}-${mes}-${pad(mTxt[1])}T00:00:00-03:00`;
  }
  // Formato URL: /YYYY/MM/DD/
  if(url){ const mU = url.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//); if(mU) return `${mU[1]}-${mU[2]}-${mU[3]}T00:00:00-03:00`; }
  return '';
}

function parseHorario(txt){
  let m=String(txt).match(/de\s+(\d{1,2}:?\d{0,2})\s+a\s+(?:las\s*)?(\d{1,2}:?\d{0,2})/i);
  if(m) return 'de '+m[1]+' a '+m[2];
  m=String(txt).match(/desde\s+(\d{1,2}:?\d{0,2})\s+a\s+(\d{1,2}:?\d{0,2})/i);
  if(m) return 'de '+m[1]+' a '+m[2];
  m=String(txt).match(/hasta\s+(?:las\s*)?(\d{1,2}:?\d{0,2})/i);
  if(m) return 'hasta '+m[1];
  return null;
}

function vigenteHasta(horario, fechaISO){
  if(!horario||!fechaISO) return null;
  const m=String(horario).match(/de\s+(\d{1,2})(?::(\d{2}))?\s+a\s+(\d{1,2})(?::(\d{2}))?/i);
  if(m){
    const d=new Date(fechaISO); if(isNaN(+d)) return null;
    const o=new Date(d);
    o.setHours(parseInt(m[3]),parseInt(m[4]||'0'),0,0);
    return o.toISOString();
  }
  return null;
}

function parseKm(txt){
  let m=String(txt).match(/k(?:m|il[oó]metro)?\s*(\d+(?:[.\d]+)?)\s*(?:hasta|–|-)\s*k(?:m|il[oó]metro)?\s*(\d+(?:[.\d]+)?)/i);
  if(m) return{from:m[1],to:m[2]};
  m=String(txt).match(/(?:desde|entre)\s+(\d+(?:[.\d]+)?)\s*(?:y|hasta|–)\s*(\d+(?:[.\d]+)?)/i);
  if(m) return{from:m[1],to:m[2]};
  m=String(txt).match(/k(?:m|il[oó]metro)?\s*(\d+(?:[.\d]+)?)/i);
  if(m) return{from:m[1],to:null};
  return{from:null,to:null};
}

function parseTipo(t,tt){
  const s=(tt||'')+' '+(t||'');
  if(/corte\s*total|acceso\s*cerrado|interrupci[oó]n/i.test(s)) return 'corte_total';
  if(/corte\s*parcial/i.test(s)) return 'corte_parcial';
  if(/reducci[oó]n|menos\s*un\s*carril|entre\s*2\s*carriles/i.test(s)) return 'reduccion';
  if(/obra|reparaci[oó]n|construcci[oó]n/i.test(s)) return 'obra';
  if(/choque|colisi[oó]n|vuelco|accidente/i.test(s)) return 'choque';
  return 'corte_total';
}
function parseCat(t){ if(t==='choque') return 'accidentes'; if(t==='obra') return 'obras'; return 'cortes'; }

// Extrae la vía principal (calle/avenida/bulevar/ruta) sin frases largas
function extraerVia(txt){
  const s = clean(txt);
  let m = s.match(/\b(calle|avenida|bulevar)\s+([A-ZÁÉÍÓÚÑ][\wáéíóúñ]*)/i);
  if(m && !/^(y|de|en|por|la|el|los|las|con|para|del|es|al)$/i.test(m[2])) return (m[1] + ' ' + m[2]).slice(0, 90);
  m = s.match(/\b(ruta(?:\s+(?:provincial|nacional))?\s*\d+(?:-\w+)?|rn\s*\d+|rp\s*\d+|autopista\s+[\wáéíóúñ]+(?:\s+[\wáéíóúñ]+){0,3}(?:\s*[-–]\s*[\wáéíóúñ]+)?)\b/i);
  if(m) return m[1].slice(0, 90);
  return '';
}

// Extrae un título corto: primera oración completa (hasta 100 chars)
function extraerTitulo(txt){
  const s = clean(txt).replace(/…$/, '').trim();
  const m = s.match(/^(.{20,120}?[.!?])\s+[A-ZÁÉÍÓÚÑ0-9]/);
  if(m) return short(m[1], 110);
  return short(s, 110);
}

/* ════════════════════════════════════════════════════════════════════════════
   EXTRACCIÓN DE CALLES + GEOCODIFICACIÓN DE PUNTOS
   Devuelve array de [lat, lon] (puntos reales) o null si no se puede.
   ════════════════════════════════════════════════════════════════════════════ */

/* ── extracción de calles ────────────────────────────────────────────────── */
// Palabras que NO son nombres de calle (evitan falsos positivos tipo
// "Entre trabajos de bacheo y reparaciones").
const PALABRAS_GENERICAS = new Set([
  'trabajos','obras','reparaciones','cortes','desvios','desvio','bacheo','intervenciones',
  'tareas','labores','colectivos','transito','calzada','transporte','zona','sector',
  'ciudad','barrio','provincia','pais','servicio','servicios','reduccion','restriccion',
  'carril','carriles','mano','sentido','altura','acceso',
]);

function limpiarNombre(n){
  if(!n) return null;
  let x = String(n).replace(/\s+/g,' ').trim().replace(/[.,;:]+$/,'').trim();
  x = x.replace(/^calle\s+/i,'').trim();
  // quitar conectores colgando al final ("25 de Mayo de" → "25 de Mayo")
  for(let i = 0; i < 3; i++) x = x.replace(/\s+(de|del|la|las|los|y|entre|en|por)$/i,'').trim();
  if(!x || x.length > 42) return null;
  if(/^\d+$/.test(x)) return null;            // solo un número: no es calle
  if(/\by\b/i.test(x)) return null;           // capturó de más
  // número suelto al final ("Valentín Torra 19"): es ruido de fecha/hora
  x = x.replace(/\s+\d{1,2}$/,'').trim();
  if(!x) return null;
  // Cada palabra debe ser nombre propio (mayúscula/dígito) o conector válido
  const CONECTORES = new Set(['de','del','la','las','los','y']);
  for(const t of x.split(' ')){
    if(!t) continue;
    if(CONECTORES.has(t.toLowerCase())) continue;
    if(!/^[A-ZÁÉÍÓÚÑÜ0-9°]/.test(t)) return null;
  }
  const tokens = osm.norm(x).split(' ');
  if(tokens.some(t => PALABRAS_GENERICAS.has(t))) return null;
  return x;
}

/**
 * Extrae calles/esquinas mencionadas en el texto.
 * Soporta los formatos que usan los medios:
 *   A) "calle Corrientes, en el tramo entre calles La Paz y Colón"
 *   B) "Güemes, entre Ruperto Godoy y Santiago Derqui: corte total"
 *   C) "9 de Julio y Bulevar Pellegrini (cantero central): corte"
 * Trabaja oración por oración: un nombre de calle nunca cruza un punto.
 */
function extraerSegmentos(txt){
  const out = [];
  const visto = new Set();

  const push = (calle, desde, hasta, ctx) => {
    const c = limpiarNombre(calle);
    if(!c) return;
    const d = limpiarNombre(desde);
    const h = limpiarNombre(hasta);
    if((desde && !d) || (hasta && !h)) return;
    const k = [c, d, h].map(x => x ? osm.norm(x) : '').join('|');
    if(visto.has(k)) return;
    visto.add(k);
    out.push({ calle: c, desde: d, hasta: h, ctx: ctx || '' });
  };

  const PAL = '(?:[A-ZÁÉÍÓÚÑÜ0-9][\\wáéíóúñüÁÉÍÓÚÑÜ°.]*|de|del|la|las|los)';
  const NOM = '([A-ZÁÉÍÓÚÑÜ0-9][\\wáéíóúñüÁÉÍÓÚÑÜ°.]*(?:\\s+' + PAL + '){0,4})';
  const reTramo = new RegExp('\\b' + NOM + '\\s*,\\s*entre\\s+(?:calles?\\s+|la\\s+calle\\s+)?' + NOM + '\\s+(?:y|e)\\s+' + NOM + '(?=[\\s,;:()]|$)', 'g');
  const reEsquina = new RegExp('\\b' + NOM + '\\s+(?:y|e)\\s+' + NOM + '\\s*(?=[:(])', 'g');

  // Oración por oración, sin cortar en iniciales tipo "F. Leloir"
  const oraciones = clean(txt).split(/(?<=[.:;!?])(?<!\b[A-ZÁÉÍÓÚÑ]\.)\s+(?=[A-ZÁÉÍÓÚÑÜ0-9])/);

  for(const s of oraciones){
    if(!s || s.length < 8) continue;

    // ── A) "calle X ... entre Y y Z" (ventana corta) ──────────────────────
    const reCalle = /\bcalle\s+([A-ZÁÉÍÓÚÑÜ0-9][\wáéíóúñü]*(?:\s+(?:[A-ZÁÉÍÓÚÑÜ][\wáéíóúñü]*|\d+|de|la|del|las|los)){0,3})/gi;
    let m;
    while((m = reCalle.exec(s)) !== null){
      const calle = m[1].trim();
      let resto = s.slice(m.index + m[0].length, m.index + m[0].length + 140);
      const corte = resto.search(/\bcalle\s/);
      if(corte > 0) resto = resto.slice(0, corte);
      const mEntre = resto.match(/entre\s+(?:calles?\s+)?([A-ZÁÉÍÓÚÑÜ][\wáéíóúñü]*(?:\s+(?:[A-ZÁÉÍÓÚÑÜ][\wáéíóúñü]*|\d+|de|la|del|las|los)){0,2})\s+(?:y|e)\s+(?:calles?\s+)?([A-ZÁÉÍÓÚÑÜ][\wáéíóúñü]*(?:\s+(?:[A-ZÁÉÍÓÚÑÜ][\wáéíóúñü]*|\d+|de|la|del|las|los)){0,2})/i);
      if(mEntre) push(calle, mEntre[1], mEntre[2], s);
      else push(calle, null, null, s);
    }

    // ── B) "X, entre Y y Z" (sin la palabra "calle") ──────────────────────
    const spans = [];
    while((m = reTramo.exec(s)) !== null){
      push(m[1], m[2], m[3], s);
      spans.push([m.index, m.index + m[0].length]);
    }

    // ── C) "X y Y:" / "X y Y (" (esquina explícita), sin los tramos ya vistos
    let s2 = s.split('');
    for(const [a, b] of spans) for(let i = a; i < b; i++) s2[i] = ' ';
    s2 = s2.join('');
    while((m = reEsquina.exec(s2)) !== null){
      push(m[1], m[2], null, s);
    }

    // ── D) "calles X y Y" ─────────────────────────────────────────────────
    const reCalles = /\bcalles\s+([A-ZÁÉÍÓÚÑÜ][\wáéíóúñü]*(?:\s+(?:[A-ZÁÉÍÓÚÑÜ][\wáéíóúñü]*|\d+|de|la|del|las|los)){0,2})\s+(?:y|e)\s+(?:calles?\s+)?([A-ZÁÉÍÓÚÑÜ][\wáéíóúñü]*(?:\s+(?:[A-ZÁÉÍÓÚÑÜ][\wáéíóúñü]*|\d+|de|la|del|las|los)){0,2})/gi;
    while((m = reCalles.exec(s)) !== null){
      push(m[1], null, null, s);
      push(m[2], null, null, s);
    }
  }

  return out;
}

function extraerRutas(txt){
  const rutas = [];
  const s = clean(txt);
  const reRuta = /(r(?:uta?)?\s*\d+(?:-\w+)?|rn\s*\d+|rp\s*\d+|autopista\s+\w+(?:\s*\d+)?)/gi;
  let m;
  while((m = reRuta.exec(s)) !== null){
    const r = m[1].trim();
    if(!rutas.find(x => x.toLowerCase() === r.toLowerCase())) rutas.push(r);
  }
  return rutas;
}

/* ── motivo y franja horaria (texto corto para las cards) ───────────────── */
// Vocabulario controlado: la card muestra 2-4 palabras, no una frase entera.
const MOTIVOS = [
  [/redes?\s+de\s+agua|agua\s+potable|ca[ñn]er[ií]a\s+de\s+agua/i, 'Mantenimiento de red de agua'],
  [/colector/i,                                                    'Obras en colector cloacal'],
  [/cloaca|cloacal|desag[üu]e/i,                                   'Mantenimiento de red cloacal'],
  [/bacheo|baches/i,                                               'Bacheo'],
  [/repaviment|paviment/i,                                         'Repavimentación'],
  [/sem[aá]foro/i,                                                 'Semáforo fuera de servicio'],
  [/choque|colisi[oó]n|vuelco/i,                                   'Choque'],
  [/desv[ií]o\s+de\s+(colectivo|transporte)/i,                     'Desvío de colectivos'],
  [/desv[ií]o/i,                                                   'Desvío de tránsito'],
  [/obra|intervenci[oó]n|vial/i,                                   'Obra en la vía pública'],
];

function capitalizar(t){
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/** Motivo corto y consistente: "Bacheo", "Mantenimiento de red de agua", ... */
function motivoCorto(txt){
  const t = clean(txt);
  if(!t) return '';
  let mejor = '', pos = Infinity;
  for(const [re, label] of MOTIVOS){
    const m = t.match(re);
    if(m && m.index < pos){ pos = m.index; mejor = label; }
  }
  return mejor;
}

/** Franja horaria, solo si la noticia la menciona. */
function franjaCorta(txt){
  const t = clean(txt);
  if(!t) return '';
  const p2 = n => String(n).padStart(2,'0');
  const hhmm = (h, m) => p2(h) + ':' + (m || '00');

  // "a partir de las 22 ... hasta las 6"
  let m = t.match(/a\s+partir\s+de\s+las\s+(\d{1,2})(?::(\d{2}))?[\s\S]{0,80}?hasta\s+(?:las\s+)?(\d{1,2})(?::(\d{2}))?/i);
  if(m) return hhmm(m[1], m[2]) + ' a ' + hhmm(m[3], m[4]);

  // "de 17 a 22" / "desde las 8 hasta las 18"
  m = t.match(/(?:de|desde)\s+(?:las\s+)?(\d{1,2})(?::(\d{2}))?\s*(?:hs?|horas)?\s*(?:a|hasta)\s+(?:las\s+)?(\d{1,2})(?::(\d{2}))?/i);
  if(m) return hhmm(m[1], m[2]) + ' a ' + hhmm(m[3], m[4]);

  // "a partir de las 22"
  m = t.match(/a\s+partir\s+de\s+las\s+(\d{1,2})(?::(\d{2}))?/i);
  if(m) return parseInt(m[1], 10) === 0 ? 'Todo el día' : 'desde ' + hhmm(m[1], m[2]);

  if(/todo el d[ií]a|toda la jornada|las 24 horas|permanente/i.test(t)) return 'Todo el día';
  return '';
}

async function resolverSegmentos(txt, localidad, provincia, centroCiudad){
  if(!localidad || !provincia) return null;
  const segs = extraerSegmentos(txt);
  if(!segs.length) return null;

  // Contexto geográfico: sin centroide no hay forma de acotar la búsqueda
  const ctx = centroCiudad && centroCiudad.lat != null
    ? { centro: [centroCiudad.lat, centroCiudad.lon] }
    : null;

  const segmentos = [];
  const claves = new Set();
  const puntosUsados = [];
  const callesConTramo = new Set();
  const MAX_SEGMENTOS = 6;

  const lejos = p => !puntosUsados.some(q => osm.distM(p, q) < 30);
  const agregar = (pts, meta) => {
    if(segmentos.length >= MAX_SEGMENTOS) return false;
    if(!pts || !pts.length) return false;
    const k = pts.map(p => p[0].toFixed(4) + ',' + p[1].toFixed(4)).join('|');
    if(claves.has(k)) return false;
    if(pts.length === 1 && !lejos(pts[0])) return false;
    claves.add(k);
    segmentos.push({
      puntos: pts,
      calle: meta.calle,
      desde: meta.desde || null,
      hasta: meta.hasta || null,
      motivo: motivoCorto(meta.ctx || ''),
      franja: franjaCorta(meta.ctx || ''),
      ctx: (meta.ctx || '').slice(0, 400)
    });
    pts.forEach(p => puntosUsados.push(p));
    return true;
  };

  // 1) Tramos "calle X entre Y y Z" → geometría REAL de la calle en OSM
  for(const s of segs){
    if(!s.calle || !s.desde || !s.hasta) continue;
    const r = await osm.segmentoEntre(s.calle, s.desde, s.hasta, localidad, provincia, ctx);
    if(r && r.puntos.length >= 2 && agregar(r.puntos, s)){
      callesConTramo.add(osm.norm(s.calle));
    }
  }

  // 2) Esquinas simples ("calle X y Y") → punto exacto del cruce
  for(const s of segs){
    if(!s.calle) continue;
    const otra = s.desde || s.hasta;
    if(!otra) continue;
    if(callesConTramo.has(osm.norm(s.calle))) continue;
    const p = await osm.esquina(s.calle, otra, localidad, provincia, ctx);
    if(p) agregar([p], { calle: s.calle, desde: otra, hasta: null, ctx: s.ctx });
  }

  // 3) Si la nota no dio ninguna esquina, marcar la calle nombrada (punto real
  //    sobre la propia calle). Solo cuando no hay nada más preciso y como
  //    máximo 2 calles, para no llenar el mapa de puntos.
  if(segmentos.length === 0){
    let puestas = 0;
    const nombres = [];
    for(const s of segs){
      if(puestas >= 2) break;
      if(!s.calle || s.desde || s.hasta) continue;
      // "25 de Mayo Seguí" es la misma calle capturada con su esquina: se descarta
      if(nombres.some(n => osm.norm(s.calle).startsWith(n + ' '))) continue;
      const p = await osm.puntoCalle(s.calle, localidad, provincia, ctx);
      if(p && agregar([p], { calle: s.calle, desde: null, hasta: null, ctx: s.ctx })){
        nombres.push(osm.norm(s.calle)); puestas++;
      }
    }
  }

  return segmentos.length ? segmentos : null;
}

/* ════════════════════════════════════════════════════════════════════════════
   BUILD ITEM
   ════════════════════════════════════════════════════════════════════════════ */
// Extrae el contenido del artículo (no el menú ni scripts).
// Elonce, por ejemplo, pone un <article> de 95 caracteres y el texto real en el body:
// se elige el contenedor MÁS LARGO, no el primero que aparezca.
function extraerContenido($){
  const selectores = ['article', 'main', '.page-noticia', '.article-content', '.nota-content', '.entry-content', '.post-content', '.content', '#content', '.node-content', '.field--name-body', '.story-body', '.article__body', '.newspack-article'];
  let mejor = '';
  for(const sel of selectores){
    const el = $(sel).first();
    if(!el.length) continue;
    const t = clean(el.text()).trim();
    if(t.length > mejor.length) mejor = t;
  }
  const body = clean($('body').text()).trim();
  if(mejor.length >= 400 && mejor.length >= body.length * 0.5) return mejor;
  return body.length > mejor.length ? body : mejor;
}

function dedupSegmentos(segmentos){
  const out = [];
  const keys = new Set();
  for(const seg of segmentos){
    const pts = Array.isArray(seg) ? seg : (seg && seg.puntos);
    if(!pts || !pts.length) continue;
    const key = pts.map(p => (p[0]||0).toFixed(4) + ',' + (p[1]||0).toFixed(4)).join('|');
    if(keys.has(key)) continue;
    keys.add(key);
    out.push(Array.isArray(seg) ? { puntos: pts } : seg);
  }
  return out;
}

// Quita el título repetido al inicio del resumen (solo si arranca con él)
function limpiarResumen(txt, titulo){
  let t = clean(txt);
  if(!t) return '';
  const needle = (titulo||'').slice(0, 40).toLowerCase().trim();
  const limpiarBorde = s => s.replace(/^[\s|·:,\-–—»]+/, '').trim();
  if(needle.length > 12){
    for(let k = 0; k < 2; k++){
      if(t.toLowerCase().indexOf(needle) === 0) t = limpiarBorde(t.slice(needle.length));
      else break;
    }
  }
  return t;
}

// Primer párrafo real del artículo (el lead, no el menú)
function extraerLead($){
  const sels = ['article p', 'main p', '.page-noticia p', '.entry-content p', '.nota-content p', '.post-content p', '.content p', 'p'];
  for(const s of sels){
    const el = $(s).first();
    if(el.length){
      const t = clean(el.text()).trim();
      if(t.length > 60) return t;
    }
  }
  return '';
}

// Texto corto de ubicación de un tramo: "Corrientes entre La Paz y Colón"
function textoUbicacion(seg){
  if(!seg || !seg.calle) return '';
  if(seg.desde && seg.hasta) return seg.calle + ' entre ' + seg.desde + ' y ' + seg.hasta;
  if(seg.desde) return seg.calle + ' y ' + seg.desde;
  return seg.calle;
}

function buildItem(o){
  let segmentos = dedupSegmentos(o.segmentos || (o.puntos && o.puntos.length ? [o.puntos] : null) || []);
  const habiaSegmentos = segmentos.length > 0;
  const titulo = tituloLimpio(o.titulo || '') || 'Alerta de tránsito';
  const AHORA = Date.now();

  // ── Vigencia por tramo: cada corte de la nota tiene su propio plazo ──────
  // Solo se usa la vigencia explícita/diaria del tramo; si no tiene, hereda la del ítem.
  const vivos = [];
  for(const seg of segmentos){
    if(seg.ctx){
      const v = calcularVigencia(
        { titulo, resumen: seg.ctx, descripcion: '', fecha: o.fecha },
        {}
      );
      if(v.tipo !== 'estimada'){
        seg.vence = v.hasta;
        seg.vigencia = v.tipo;
        if(new Date(v.hasta).getTime() <= AHORA) continue;   // este corte ya terminó
      }
    }
    vivos.push(seg);
  }
  segmentos = vivos;
  // Si tenía ubicaciones y todas vencieron, la alerta ya no existe
  if(habiaSegmentos && segmentos.length === 0) return null;

  const conUbicacion = segmentos.length > 0;
  const primero = conUbicacion ? segmentos[0].puntos[0] : null;
  const lat = primero ? primero[0] : null;
  const lon = primero ? primero[1] : null;

  // Motivo y franja a nivel alerta (los tramos heredan el motivo si no tienen)
  const motivo = motivoCorto((o.titulo || '') + ' ' + (o.resumen || '') + ' ' + (o.descripcion || ''));
  const franjas = [...new Set(segmentos.map(s => s.franja).filter(Boolean))];
  // La franja a nivel alerta solo si es la misma para todos los tramos
  const franja = franjas.length === 1 ? franjas[0] : '';

  // Completar motivo por tramo y armar la lista corta de calles
  const calles = [];
  for(const seg of segmentos){
    if(!seg.motivo) seg.motivo = motivo;
    seg.entre = seg.desde && seg.hasta ? seg.desde + ' y ' + seg.hasta
               : (seg.desde || seg.hasta || '');
    seg.texto = textoUbicacion(seg);   // "Corrientes entre La Paz y Colón" / "Güemes y Ruperto Godoy"
    const u = seg.texto;
    if(u && !calles.includes(u)) calles.push(u);
  }

  // Vigencia: cuándo deja de mostrarse
  let vig = calcularVigencia(
    { titulo, resumen: o.resumen, descripcion: o.descripcion, fecha: o.fecha },
    { diario: !!o.diario }
  );
  // Si los tramos tienen final explícito, el ítem vive hasta el último que termina
  const fines = segmentos.map(s => s.vence).filter(Boolean)
    .map(t => new Date(t).getTime()).filter(t => !isNaN(t));
  if(fines.length){
    const hastaTramos = Math.max(...fines);
    const hastaItem = vig.tipo === 'explicita'
      ? Math.max(hastaTramos, new Date(vig.hasta).getTime())
      : hastaTramos;
    if(hastaItem !== new Date(vig.hasta).getTime()){
      vig = { hasta: new Date(hastaItem).toISOString(), tipo: vig.tipo === 'explicita' ? 'explicita' : 'diaria',
              detalle: 'hasta el ' + fmtCorto(new Date(hastaItem)) };
    }
  }

  return {
    id: o.id,
    titulo: titulo,
    categoria: o.categoria || parseCat(o.tipo),
    tipo: o.tipo || 'corte_total',
    fecha: o.fecha || '',
    fecha_raw: o.fecha_raw || o.fecha || '',
    horario: o.horario || null,
    motivo: motivo,
    franja: franja,
    calles: calles,
    resumen: short(calles.join(' · '), 140),
    descripcion: short(calles.join(' · '), 160),
    enlace: o.enlace || '',
    lat, lon,
    sin_ubicacion: !conUbicacion,
    localidad: o.localidad || '',
    provincia: o.provincia || '',
    via: (o.via || '').trim().slice(0, 90),
    km_desde: o.kmDesde || null,
    km_hasta: o.kmHasta || null,
    vigencia: vig,
    vigente_hasta: vig.hasta,
    fuente_tipo: o.fuenteTipo || 'noticia',
    segmentos: segmentos,
    puntos: conUbicacion ? segmentos[0].puntos : null
  };
}

/* ── vigencia: cuándo deja de mostrarse una alerta ──────────────────────────
   Capas, de la más confiable a la más gruesa:
   1. EXPLÍCITA — la nota dice "hasta el 11 a las 6", "durante 32 horas", "3 meses".
   2. DIARIA   — boletín del día ("el tránsito de este lunes") → vence a fin del día.
   3. ESTIMADA — no dice nada: TTL por tipo (obra 30 d, accidente 6 h, ruta 24 h…).
   Nunca se inventa una hora exacta: si es estimada, el JSON lo declara.
   ─────────────────────────────────────────────────────────────────────────── */
const MESES = { enero:0, febrero:1, marzo:2, abril:3, mayo:4, junio:5, julio:6, agosto:7, septiembre:8, setiembre:8, octubre:9, noviembre:10, diciembre:11 };
const NUMEROS = { un:1, una:1, uno:1, dos:2, tres:3, cuatro:4, cinco:5, seis:6, siete:7, ocho:8, nueve:9, diez:10, once:11, doce:12, quince:15, veinte:20, treinta:30 };
const DIASEM = { domingo:0, lunes:1, martes:2, miercoles:3, jueves:4, viernes:5, sabado:6 };

function sinAcentos(s){ return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }
function aNumero(s){
  if(s == null) return null;
  const n = parseInt(s, 10);
  if(!isNaN(n)) return n;
  const w = NUMEROS[sinAcentos(s)];
  return w === undefined ? null : w;
}
function fmtCorto(d){
  const p = n => String(n).padStart(2,'0');
  return p(d.getDate()) + '/' + p(d.getMonth()+1) + (d.getHours() || d.getMinutes() ? ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) : '');
}

/** Fecha ART (UTC-3) a partir de día/mes/hora. `ref` = fecha de la nota (define el año). */
function fechaART(dia, mesNombre, anio, hora, min, ref){
  const mes = MESES[sinAcentos(mesNombre)];
  if(mes === undefined || !dia) return null;
  const H = hora != null ? +hora : 23;
  const M = min != null ? +min : (hora != null ? 0 : 59);

  // El año se toma de la nota, no de "hoy": una nota del 9/11 que dice
  // "hasta el 11 de noviembre" es de 2026 aunque ya estemos en diciembre.
  const refD = ref && !isNaN(+new Date(ref)) ? new Date(ref) : new Date();
  let year = anio ? +anio : refD.getUTCFullYear();
  let d = new Date(Date.UTC(year, mes, +dia, H + 3, M, 0));

  // Si la fecha quedó MUY antes que la nota, el año implícito era el siguiente
  if(!anio && d.getTime() < refD.getTime() - 60*24*3600e3){
    d = new Date(Date.UTC(year + 1, mes, +dia, H + 3, M, 0));
  }
  return isNaN(+d) ? null : d;
}

/** Fecha "corrida" a hora Argentina (para comparar días sin depender del TZ del runner). */
function diaART(d){ return new Date(((d || new Date()).getTime()) - 3*3600e3); }
/** Fin del día argentino (23:59 ART) del día al que pertenece `d`. */
function finDelDiaART(d){
  const a = diaART(d);
  return new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate(), 26, 59, 0));
}

/** Próximo día de la semana indicado, a las 23:59 ART. */
function proximoDiaSem(nombre){
  const target = DIASEM[sinAcentos(nombre)];
  if(target === undefined) return null;
  const a = diaART();
  const diff = (target - a.getUTCDay() + 7) % 7 || 7;
  return new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate() + diff, 26, 59, 0));
}

const UNIDAD_MS = { hora: 3600e3, dia: 24*3600e3, semana: 7*24*3600e3, mes: 30*24*3600e3 };
function sumarUnidad(n, unidad, desde){
  const u = sinAcentos(unidad);
  const key = u.startsWith('hora') ? 'hora'
            : u.startsWith('dia') ? 'dia'
            : u.startsWith('semana') ? 'semana'
            : u.startsWith('mes') ? 'mes' : null;
  const ms = key ? UNIDAD_MS[key] : null;
  if(!ms || !n) return null;
  return new Date((desde ? desde.getTime() : Date.now()) + n*ms);
}

/** TTL por tipo cuando la nota no dice nada. */
function ttlPorTipo(item){
  const t = sinAcentos((item.titulo||'') + ' ' + (item.resumen||'') + ' ' + (item.descripcion||''));
  if(/choque|colision|vuelco|siniestro/.test(t)) return { dias: 0.25, detalle: 'estimado: accidente (6 h)' };
  if(/ruta|autopista|\bkm\b|\brn\b|\brp\b/.test(t)) return { dias: 1, detalle: 'estimado: ruta (24 h)' };
  if(/obra|bacheo|repaviment|cloaca|colector|redes? de agua|caneria|vial|zanja/.test(t)) return { dias: 30, detalle: 'estimado: obra (30 días)' };
  return { dias: 2, detalle: 'estimado: corte (48 h)' };
}

/** "este sábado" y la fecha de la nota cae ese día → boletín diario. */
function esBoletinDelDia(txt, base){
  const t = sinAcentos(txt);
  const m = t.match(/\beste\s+(domingo|lunes|martes|miercoles|jueves|viernes|sabado)\b/);
  if(!m) return false;
  const target = DIASEM[m[1]];
  const art = new Date(base.getTime() - 3*3600e3);   // fecha en hora argentina
  return target !== undefined && art.getUTCDay() === target;
}

/**
 * Devuelve { hasta, tipo, detalle } para una alerta.
 * tipo: 'explicita' | 'diaria' | 'estimada'
 */
function calcularVigencia(item, opciones){
  opciones = opciones || {};
  const txt = clean((item.titulo||'') + '. ' + (item.resumen||'') + ' ' + (item.descripcion||''));
  const base = item.fecha && !isNaN(+new Date(item.fecha)) ? new Date(item.fecha) : new Date();
  const MAX = base.getTime() + 180*24*3600e3;   // techo absoluto

  // 1) "hasta las 6 del miércoles 11 de noviembre"
  let m = txt.match(/hasta\s+(?:las?\s+)?(\d{1,2})(?::(\d{2}))?\s*(?:hs?\.?)?\s*del?\s+(?:[a-záéíóúñ]+\s+)?(\d{1,2})\s+de\s+([a-záéíóúñ]+)(?:\s+de\s+(\d{4}))?/i);
  if(m){
    const d = fechaART(m[3], m[4], m[5], m[1], m[2], base);
    if(d) return { hasta: d.toISOString(), tipo: 'explicita', detalle: 'hasta el ' + fmtCorto(d) };
  }

  // 2) "hasta el 11 de noviembre (a las 6)"
  m = txt.match(/hasta\s+el\s+(?:d[ií]a\s+)?(?:[a-záéíóúñ]+\s+)?(\d{1,2})\s+de\s+([a-záéíóúñ]+)(?:\s+de\s+(\d{4}))?(?:\s+a\s+las?\s+(\d{1,2})(?::(\d{2}))?)?/i);
  if(m){
    const d = fechaART(m[1], m[2], m[3], m[4], m[5], base);
    if(d) return { hasta: d.toISOString(), tipo: 'explicita', detalle: 'hasta el ' + fmtCorto(d) };
  }

  // 3) "hasta el miércoles"
  m = txt.match(/hasta\s+el\s+(domingo|lunes|martes|mi[eé]rcoles|jueves|viernes|s[áa]bado)\b/i);
  if(m){
    const d = proximoDiaSem(m[1]);
    if(d) return { hasta: d.toISOString(), tipo: 'explicita', detalle: 'hasta el ' + fmtCorto(d) };
  }

  // 4) "durante toda la jornada" / "todo el día"
  if(/toda\s+la\s+jornada|todo\s+el\s+d[ií]a/i.test(txt)){
    return { hasta: finDelDiaART(base).toISOString(), tipo: 'diaria', detalle: 'solo ese día' };
  }

  // 5) "durante 32 horas", "plazo estimado de ejecución de tres meses", "por 48 horas"
  m = txt.match(/(?:durante|por|plazo\s+(?:estimado\s+)?(?:de\s+)?(?:ejecuci[oó]n\s+)?(?:de\s+)?|duraci[oó]n\s+de|aproximadamente|ser[áa]n)\s*(?:un[ao]?\s+)?([a-z0-9]+)\s+(horas?|d[ií]as?|semanas?|meses?)/i);
  if(!m) m = txt.match(/(\d+|[a-záéíóúñ]+)\s+(horas?|d[ií]as?|semanas?|meses?)\s+(?:de\s+)?(?:labor|trabajo|obra)/i);
  if(m){
    const n = aNumero(m[1]);
    const d = sumarUnidad(n, m[2], base);
    if(d) return { hasta: d.toISOString(), tipo: 'explicita', detalle: m[1] + ' ' + m[2] + ' desde el ' + fmtCorto(base) };
  }

  // 6) "hasta nuevo aviso" / "hasta que finalicen" / "permanente" → sin plazo → estimada
  const explicitaIndefinida = /hasta\s+nuevo\s+aviso|hasta\s+que\s+(finalicen|terminen|concluyan)|permanente/i.test(txt);

  // 6b) Boletín del día: "este sábado" (y la fecha de la nota coincide)
  if(!explicitaIndefinida && esBoletinDelDia(txt, base)){
    return { hasta: finDelDiaART(base).toISOString(), tipo: 'diaria', detalle: 'solo ese día' };
  }

  // 7) Boletín del día (marcado por la fuente)
  if(opciones.diario){
    return { hasta: finDelDiaART(base).toISOString(), tipo: 'diaria', detalle: 'boletín del día' };
  }

  // 8) Estimada por tipo
  const ttl = ttlPorTipo(item);
  let hasta = base.getTime() + ttl.dias*24*3600e3;
  if(hasta > MAX) hasta = MAX;
  return { hasta: new Date(hasta).toISOString(), tipo: 'estimada', detalle: ttl.detalle + (explicitaIndefinida ? ' (sin plazo en la nota)' : '') };
}

/* ── historial: silencio ≠ liberado ────────────────────────────────────────
   Un corte publicado por un medio no deja de existir porque el buscador
   deje de devolver la nota. Los ítems de fuentes de NOTICIA se conservan
   hasta su vigencia declarada; los de fuentes de ESTADO (boletín diario,
   estado de rutas) sí desaparecen cuando la fuente deja de listarlos.
   ─────────────────────────────────────────────────────────────────────── */
const HISTORIAL = path.join(DIR_DATOS, 'transito-historial.json');

function cargarHistorial(){
  try{ return JSON.parse(fs.readFileSync(HISTORIAL, 'utf8')); }
  catch(e){
    // Primera corrida con historial: sembrar desde el JSON anterior
    try{
      const prev = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
      const seed = { actualizado: null, items: {} };
      for(const it of (prev.items || [])){
        // Se recalcula siempre: el JSON pudo generarse con otra versión
        it.vigencia = calcularVigencia(it, {});
        it.vigente_hasta = it.vigencia.hasta;
        if(!it.fuente_tipo) it.fuente_tipo = 'noticia';
        seed.items[idEstable(it)] = {
          item: it,
          fuente_tipo: it.fuente_tipo || 'noticia',
          primera_vez: it.fecha || null,
          ultima_vez_vista: prev.timestamp || null
        };
      }
      return seed;
    }catch(e2){ return { items: {} }; }
  }
}
function guardarHistorial(h){
  try{ fs.writeFileSync(HISTORIAL, JSON.stringify(h, null, 2), 'utf8'); }catch(e){}
}
// Clave estable: mismo lugar + mismo motivo = misma alerta entre corridas
function idEstable(i){
  return [osm.norm(i.localidad||''), (i.calles||[]).map(osm.norm).sort().join('~'), osm.norm(i.motivo||'')].join('|');
}

function fusionarHistorial(items){
  const h = cargarHistorial();
  const ahora = Date.now();
  const previos = (h && h.items) ? h.items : {};
  const vistosAhora = new Set();
  const finales = [];

  for(const it of items){
    const k = idEstable(it);
    vistosAhora.add(k);
    finales.push(it);
  }

  // Recuperar alertas de noticia que siguen vigentes aunque hoy no aparezcan
  let recuperados = 0;
  for(const [k, prev] of Object.entries(previos)){
    if(vistosAhora.has(k)) continue;
    const it = prev && prev.item;
    if(!it || !it.vigencia) continue;
    if(new Date(it.vigencia.hasta).getTime() <= ahora) continue;
    if((prev.fuente_tipo || 'noticia') === 'estado') continue;   // el estado ya no lo lista
    if(!it.segmentos || !it.segmentos.length) continue;
    if(!it.fuente_tipo) it.fuente_tipo = prev.fuente_tipo || 'noticia';
    finales.push(it);
    vistosAhora.add(k);
    recuperados++;
  }

  // Guardar historial depurado
  const nuevo = { actualizado: new Date().toISOString(), items: {} };
  for(const it of finales){
    const k = idEstable(it);
    const prev = previos[k];
    nuevo.items[k] = {
      item: it,
      fuente_tipo: it.fuente_tipo || 'noticia',
      primera_vez: prev ? prev.primera_vez : new Date().toISOString(),
      ultima_vez_vista: vistosAhora.has(k) && !prev ? new Date().toISOString()
        : (prev && prev.ultima_vez_vista) || new Date().toISOString(),
      recuperada: !items.includes(it)
    };
  }
  guardarHistorial(nuevo);
  if(recuperados) log(`  ${recuperados} alerta(s) recuperada(s) del historial (seguían vigentes)`);
  return finales;
}

/* ── limpieza de títulos ─────────────────────────────────────────────────── */
function tituloLimpio(t){
  let x = clean(t);
  // quitar emojis, viñetas y símbolos al inicio (deja la primera letra/número)
  x = x.replace(/^[^\p{L}\p{N}]+/u, '').trim();
  // cortar en separadores típicos de notas
  const cortes = [' * ', ' | ', ' – ', ' — '];
  for(const c of cortes){ const i = x.indexOf(c); if(i > 20){ x = x.slice(0, i).trim(); break; } }
  x = x.replace(/\s+/g,' ').trim();
  if(x.length > 130) x = x.slice(0,127).trim() + '…';
  return x;
}

const RE_TEMA_TRANSITO = /corte|tr[aá]nsito|desv[ií]|obra|calle|ruta|autopista|acceso|calzada|reducci|paso|restric|bacheo|repaviment|colectivo|circulaci|sem[aá]foro|siniestro|accidente|cloaca|ca[ñn]er|colector|vial|zanja|paviment|agua/i;

// Noticias policiales / de color que NO son alertas operativas
const RE_NO_ES_ALERTA = /atrincher|detenid|demorad|huy[oó]|robo|asalto|homicidio|femicidio|abuso|allanamiento|muri[oó]|falleci|herid[oa]|trasladad[oa] al hospital|gr[uú]a|aprehendid|imputad|condenad/iu;

// Centroide de toda la geometría de una alerta (para reconocer el mismo evento)
function centroGeom(i){
  const pts = [];
  for(const seg of (i.segmentos||[])) for(const p of (seg.puntos||seg)) pts.push(p);
  if(!pts.length) return null;
  let la=0, lo=0;
  for(const p of pts){ la += p[0]; lo += p[1]; }
  return [la/pts.length, lo/pts.length];
}

function puntosDe(seg){ return Array.isArray(seg) ? seg : (seg.puntos || []); }

function claveSegmentos(i){
  return new Set((i.segmentos||[])
    .map(puntosDe)
    .filter(s => s && s.length)
    .map(s => s[0][0].toFixed(4)+','+s[0][1].toFixed(4)+'>'+s[s.length-1][0].toFixed(4)+','+s[s.length-1][1].toFixed(4)));
}

function totalPuntos(i){
  return (i.segmentos||[]).reduce((a,s)=>a + puntosDe(s).length, 0);
}

// Si la geometría de una alerta está contenida en otra (mismo evento publicado
// por dos medios), se queda la que tiene más tramos.
function dedupPorGeometria(items){
  const out = [];
  for(const i of items){
    const ki = claveSegmentos(i);
    if(!ki.size){ out.push(i); continue; }
    let idx = -1;
    for(let j = 0; j < out.length; j++){
      if(osm.norm(out[j].localidad) !== osm.norm(i.localidad)) continue;
      const kj = claveSegmentos(out[j]);
      if(!kj.size) continue;
      const [chico, grande] = ki.size <= kj.size ? [ki, kj] : [kj, ki];
      let contenida = true;
      for(const k of chico){ if(!grande.has(k)){ contenida = false; break; } }
      if(contenida){ idx = j; break; }
    }
    if(idx < 0){ out.push(i); continue; }
    if(totalPuntos(i) > totalPuntos(out[idx])) out[idx] = i;
  }
  return out;
}

function uniqById(items){ const v={}; const out=[]; for(const i of items){ if(i&&i.id&&!v[i.id]){v[i.id]=true; out.push(i);} } return out; }

// Deduplica alertas con títulos muy similares (mismo evento en distintos medios)
function similitud(a, b){
  const na = (a||'').toLowerCase().replace(/[^a-z0-9áéíóúñ]/gi,'');
  const nb = (b||'').toLowerCase().replace(/[^a-z0-9áéíóúñ]/gi,'');
  if(!na || !nb) return 0;
  const big = s => { const set = new Set(); for(let k=0;k<s.length-1;k++) set.add(s.slice(k,k+2)); return set; };
  const A = big(na), B = big(nb);
  let inter = 0; for(const x of A) if(B.has(x)) inter++;
  return inter / (A.size + B.size - inter || 1);
}
function dedupSimilares(items, umbral){
  const out = [];
  for(const i of items){
    const esDup = out.find(o => similitud(o.titulo, i.titulo) > (umbral || 0.72));
    if(!esDup) out.push(i);
  }
  return out;
}

/* ════════════════════════════════════════════════════════════════════════════
   1. EL LITORAL (Santa Fe) — nota diaria "Estado del tránsito"
   ════════════════════════════════════════════════════════════════════════════ */
async function scrapElLitoral(){
  log('El Litoral (SF): indexando estado-del-transito...');
  const out=[];
  try{
    const idx = await fetch('https://www.ellitoral.com/temas/estado-del-transito');
    const $ = cheerio.load(idx);
    let nota='';
    $('a[href]').each((_,a)=>{ const h=$(a).attr('href')||''; const href=h.startsWith('http')?h:'https://www.ellitoral.com'+h;
      if(!nota && /\/area-metropolitana\/transito-santafe.*_0_[A-Za-z0-9]+\.html/.test(href)) nota=href; });
    if(!nota){ log('  (sin nota diaria, skip)'); return out; }
    log('  nota: '+nota.replace(/.*\//,''));
    const nhtml = await fetch(nota); const $$ = cheerio.load(nhtml);
    const bloques = $$.html().replace(/<\/h3>/gi,'</h3>@@SPLIT@@').replace(/<\/h2>/gi,'</h2>@@SPLIT@@').split('@@SPLIT@@')
      .map(seg => clean(seg)).filter(seg => seg.length>40 && !/#HOY:/i.test(seg) && !/Maximiliano Pullaro|Javier Milei|Imagen ilustrativa|Cr[eé]ditos?:|Redacci[oó]n EL|Conoc[eé] la informaci[oó]n vinculada al tr[aá]nsito del [aá]rea metropolitana/i.test(seg) && /acceso\s*cerrado|corte\s*(total|de\s*tr|del\s*tr)|reducci[oó]n\s*(del)?\s*tr|km\s*\d|autopista|r(?:uta?)?\s*\d|obra|vial|\d{1,2}:\d{2}\s*\/|desv[ií]o|congesti[oó]n|siniestro|accidente/i.test(seg));
    log('  bloques: '+bloques.length);
    const h1 = clean($$('h1').first().text()).trim();
    const grupos = new Map();   // localidad → { segs, textos, horarios, vias, kms }

    for(const b of bloques){
      const loc = detectarLocalidad(b, nota);
      const localidad = loc ? loc.localidad : 'Santa Fe';
      const centro = await georefCiudad(localidad, 'Santa Fe');
      const segs = await resolverSegmentos(b, localidad, 'Santa Fe', centro);

      const g = grupos.get(localidad) || { segs: [], textos: [], horarios: [], vias: [], kms: [] };
      if(segs) g.segs.push(...segs);
      g.textos.push(b);
      const h = parseHorario(b); if(h) g.horarios.push(h);
      const v = extraerVia(b); if(v) g.vias.push(v);
      const k = parseKm(b); if(k.from != null) g.kms.push(k);
      grupos.set(localidad, g);
      await sleep(80);
    }

    // Una sola alerta por ciudad (la nota diaria tiene muchos tramos)
    for(const [localidad, g] of grupos){
      const fecha = parseFecha(g.textos.join(' '), nota);
      const km = g.kms[0] || {};
      const item = buildItem({
        id: 'ellitoral:' + localidad + ':' + (fecha||'').slice(0,10),
        titulo: h1 || 'Estado del tránsito en Santa Fe',
        tipo: parseTipo(g.textos.join(' '), h1),
        categoria: 'cortes',
        fecha, fecha_raw: fecha,
        descripcion: g.textos[0],
        resumen: extraerLead($) || g.textos[0],
        enlace: nota,
        via: [...new Set(g.vias)].join(' · '),
        kmDesde: km.from ?? null, kmHasta: km.to ?? null,
        localidad, provincia: 'Santa Fe',
        horario: g.horarios[0] || null,
        diario: true,           // boletín del día: vence a fin de ese día
        fuenteTipo: 'estado',   // si la fuente deja de listarlo, se liberó
        segmentos: g.segs
      });
      if(item) out.push(item);
    }
  }catch(e){ log('  ✗ El Litoral: '+(e.message||e)); }
  return out;
}

/* ════════════════════════════════════════════════════════════════════════════
   2. RUTA0 (litoral rutas) — road + km + localidad
   ════════════════════════════════════════════════════════════════════════════ */
async function scrapRuta0(){
  log('Ruta0 (litoral rutas): indexando...');
  const out=[];
  try{
    const html = await fetch('https://www.ruta0.com/estado-de-rutas/litoral/');
    const $ = cheerio.load(html);
    const bloques=[];
    $('.nota, .card, .item, p, li').each((_,el)=>{ const t=clean($(el).text());
      if(/corte|restricci[oó]n|desv[ií]o|obra/i.test(t) && /r(?:uta?)?\s*\d+|km\s*\d+/i.test(t)) bloques.push(t); });
    for(const txt of bloques.slice(0,12)){
      const via = extraerVia(txt);
      const km = parseKm(txt);
      const localidad = (txt.match(/(?:altura|en|sobre)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i)||['',null])[1] || (txt.match(/entre\s+([A-Z][a-z]+)/i)||['',null])[1] || '';
      const horario = parseHorario(txt);
      const prov = /Santa Fe/i.test(txt) ? 'Santa Fe' : (/Paran[aá]/i.test(txt) ? 'Entre Ríos' : '');
      const locForGeo = localidad || (prov==='Santa Fe' ? 'Santa Fe' : prov==='Entre Ríos' ? 'Paraná' : '');
      const centro = await georefCiudad(locForGeo, prov || undefined);
      const puntos = await resolverSegmentos(txt, locForGeo, prov, centro);
      const item = buildItem({ id:'ruta0:'+short(txt,40), titulo:extraerTitulo(txt), tipo:parseTipo(txt,txt), categoria:parseCat(parseTipo(txt,txt)), fecha:new Date().toISOString(), fecha_raw:new Date().toISOString(), descripcion:txt, resumen:txt, enlace:'https://www.ruta0.com/estado-de-rutas/litoral/', fuenteTipo:'estado', via, kmDesde:km.from, kmHasta:km.to, localidad:localidad||(prov||'Litoral'), provincia:prov||'', horario, segmentos: puntos });
      if(item && PROVS_OK.indexOf(item.provincia)!==-1) out.push(item);
      await sleep(100);
    }
  }catch(e){ log('  ✗ Ruta0: '+(e.message||e)); }
  return out;
}

/* ════════════════════════════════════════════════════════════════════════════
   3. APSV (Santa Fe) — Estado de rutas oficial
   ════════════════════════════════════════════════════════════════════════════ */
async function scrapApsv(){
  log('APSV (Santa Fe): Estado de rutas...');
  const out=[];
  try{
    const html = await fetch('https://www.santafe.gob.ar/noticias/noticia/279907/');
    const $ = cheerio.load(html);
    const txt = clean($('body').text());
    const via = extraerVia(txt);
    const km = parseKm(txt);
    const localidad = (txt.match(/altura\s+([A-Z][a-z]+)/i)||['',null])[1] || 'Santa Fe';
    const horario = parseHorario(txt);
    const centro = await georefCiudad(localidad, 'Santa Fe');
    const puntos = await resolverSegmentos(txt, localidad, 'Santa Fe', centro);
    const item = buildItem({ id:'apsv:279907', titulo:extraerTitulo(txt), tipo:parseTipo(txt,txt), categoria:parseCat(parseTipo(txt,txt)), fecha:new Date().toISOString(), fecha_raw:new Date().toISOString(), descripcion:txt, resumen:txt, enlace:'https://www.santafe.gob.ar/noticias/noticia/279907/', fuenteTipo:'estado', via, kmDesde:km.from, kmHasta:km.to, localidad, provincia:'Santa Fe', horario, segmentos: puntos });
    if(item) out.push(item);
  }catch(e){ log('  ✗ APSV: '+(e.message||e)); }
  return out;
}

/* ════════════════════════════════════════════════════════════════════════════
   4. APFDIGITAL RSS (Paraná) — noticias municipales + generales
   ════════════════════════════════════════════════════════════════════════════ */
// Solo alertas que AFECTAN la circulación (no fibra óptica, veredas, shows, clima)
const RE_ALERTA = /corte\s*(total|parcial)?\s*(de\s*)?(tr[aá]nsito|circulaci[oó]n|calzada|ruta)|interrupci[oó]n\s*(de\s*)?(tr[aá]nsito|circulaci[oó]n|calzada)|desv[ií]o\s*(de\s*)?(tr[aá]nsito|circulaci[oó]n|calzada)|reducci[oó]n\s*(de\s*)?calzada|restricci[oó]n\s*(de\s*)?(tr[aá]nsito|circulaci[oó]n)|corte\s+total|corte\s+parcial|recorridos?\s+(de\s+)?(colectivo|l[ií]nea)|cortes?\s+de\s+tr[aá]nsito|tr[aá]nsito\s+(cortado|interrumpido|demora)|corte\s+de\s+tr[aá]nsito/i;
const RE_EXCLUIR = /fibra\s+[oó]ptica|espect[aá]culo|feria|concierto|show|m[uú]sica|clima|pron[oó]stico|salud|hospital|escuela|educaci[oó]n|policial|denuncia|detenido|robo|asalto|homicidio|incendio|deporte/i;

function esAlertaTransito(titulo, desc){
  const texto = (titulo||'') + ' ' + (desc||'');
  if(!RE_ALERTA.test(texto)) return false;
  // Excluir si el título es claramente de otro tema (salvo que mencione tránsito)
  if(RE_EXCLUIR.test(titulo) && !/tr[aá]nsito|circulaci[oó]n|calzada|corte|ruta|desv[ií]o/i.test(titulo)) return false;
  return true;
}

/* ── Fuentes confiables: dominio → provincia/ciudad por defecto ──────────── */
// Solo se publican alertas de medios locales del Litoral. Un medio de otra
// provincia (ej. "San Juan 8" hablando de "calle Santa Fe") no entra.
const DOMINIOS = [
  ['apfdigital.com.ar',  'Entre Ríos', 'Paraná'],
  ['parana.gob.ar',      'Entre Ríos', 'Paraná'],
  ['elonce.com',         'Entre Ríos', 'Paraná'],
  ['viapais.com.ar',     'Entre Ríos', 'Paraná'],
  ['unoentrerios.com.ar','Entre Ríos', 'Paraná'],
  ['ahora.com.ar',       'Entre Ríos', 'Paraná'],
  ['ellitoral.com',      'Santa Fe',   'Santa Fe'],
  ['unosantafe.com.ar',  'Santa Fe',   'Santa Fe'],
  ['airedesantafe.com.ar','Santa Fe',  'Santa Fe'],
  ['radioeme.com',       'Santa Fe',   'Santa Fe'],
  ['santafe.gob.ar',     'Santa Fe',   'Santa Fe'],
  ['veonoticias.com',    'Santa Fe',   'Santa Fe'],
  ['ruta0.com',          null,         null], // rutas: la provincia sale del texto
];

function dominioDe(url){
  try{ return new URL(url).hostname.replace(/^www\./,'').toLowerCase(); }catch(_){ return ''; }
}

function ciudadPorDominio(url){
  const host = dominioDe(url);
  if(!host) return null;
  const hit = DOMINIOS.find(([d]) => host === d || host.endsWith('.' + d));
  if(!hit) return null;
  return hit[1] ? { provincia: hit[1], localidad: hit[2], dominio: hit[0] } : { provincia: null, localidad: null, dominio: hit[0] };
}

// ¿El texto menciona la ciudad como lugar (y no como nombre de calle)?
function mencionValida(normTxt, nombreNorm){
  const reCalle = new RegExp('(calle|avenida|av\\.|bulevar|bv\\.|ruta|puente|colectora|acceso|barrio|club|estadio|hospital|escuela)\\s+(?:[a-z0-9]+\\s+){0,2}' + nombreNorm + '\\b', 'g');
  const total = (normTxt.match(new RegExp('\\b' + nombreNorm + '\\b','g')) || []).length;
  const comoCalle = (normTxt.match(reCalle) || []).length;
  return total > comoCalle;
}

const CIUDADES_ORDEN = [
  ['parana',    'Paraná',       'Entre Ríos'],
  ['concordia', 'Concordia',    'Entre Ríos'],
  ['santa fe',  'Santa Fe',     'Santa Fe'],
  ['rosario',   'Rosario',      'Santa Fe'],
  ['santo tome','Santo Tomé',   'Santa Fe'],
  ['reconquista','Reconquista', 'Santa Fe'],
  ['venado tuerto','Venado Tuerto','Santa Fe'],
  ['rafaela',   'Rafaela',      'Santa Fe'],
];

function detectarLocalidad(texto, url){
  const dom = ciudadPorDominio(url);
  const normTxt = ' ' + osm.norm(texto) + ' ';
  for(const [key, loc, prov] of CIUDADES_ORDEN){
    if(dom && dom.provincia && dom.provincia !== prov) continue;
    if(mencionValida(normTxt, key)) return { localidad: loc, provincia: prov };
  }
  if(dom && dom.localidad) return { localidad: dom.localidad, provincia: dom.provincia };
  return null;
}

async function scrapApfRss(url, tag){
  const out=[];
  try{
    const xml = await fetch(url);
    const $ = cheerio.load(xml, { xmlMode: true });
    const items = [];
    $('item').each((_,el)=>{
      const title = clean($(el).find('title').text()).trim();
      const link = clean($(el).find('link').text()).trim();
      const pubDate = clean($(el).find('pubDate').text()).trim();
      const desc = clean($(el).find('description').text()).trim();
      if(!title || !link) return;
      items.push({ title, link, pubDate, desc });
    });
    log('  items: '+items.length);
    for(const it of items.slice(0, 40)){
      if(!esAlertaTransito(it.title, it.desc)) continue;
      // Solo Paraná
      if(!/paran[aá]|entre r[ií]os|direcci[oó]n de tr[aá]nsito municipal|municipalidad de paran[aá]/i.test(it.title + ' ' + it.desc)) continue;
      const fecha = parseFecha(it.desc || it.title, it.link) || (()=>{ try{ const d=new Date(it.pubDate); return isNaN(+d)?'':d.toISOString(); }catch(e){ return ''; } })();
      if(!fecha) continue;
      const horario = parseHorario(it.desc || it.title);
      const centro = await georefCiudad('Paraná', 'Entre Ríos');
      let puntos = await resolverSegmentos(it.desc || it.title, 'Paraná', 'Entre Ríos', centro);
      const esRuta = /ruta|rn\s*\d|rp\s*\d|autopista/i.test(it.title + ' ' + it.desc);
      if(!puntos) continue;
      let via = '';
      const vm = (it.desc || it.title).match(/(?:calle|avenida|bulevar)\s+[^,.;()]+/i); if(vm) via = vm[0];
      const item = buildItem({ id: tag+':'+short(it.title,50), titulo: it.title, tipo:parseTipo(it.desc, it.title), categoria:parseCat(parseTipo(it.desc, it.title)), fecha, fecha_raw: fecha, descripcion: it.desc || it.title, resumen: it.desc || it.title, enlace: it.link, via, kmDesde:null, kmHasta:null, localidad:'Paraná', provincia:'Entre Ríos', horario, segmentos: puntos });
      if(item) out.push(item);
      await sleep(120);
    }
  }catch(e){ log('  ✗ APFDigital RSS: '+(e.message||e)); }
  return out;
}

/* ════════════════════════════════════════════════════════════════════════════
   6. APFDIGITAL NOTICIAS (Paraná) — RSS + fetch de noticia original (calles reales)
   ════════════════════════════════════════════════════════════════════════════ */
async function scrapApfNoticias(){
  log('APFDigital noticias (Paraná): RSS + fetch...');
  const out=[];
  try{
    const xml = await fetch('https://www.apfdigital.com.ar/rss/noticias/');
    const items = xml.split('<item>').slice(1).map(it => {
      const title = clean(((it.match(/<title>([\s\S]*?)<\/title>/)||[])[1]||''));
      const link = clean(((it.match(/<link>([\s\S]*?)<\/link>/)||[])[1]||''));
      const pubDate = clean(((it.match(/<pubDate>([\s\S]*?)<\/pubDate>/)||[])[1]||''));
      return { title, link, pubDate };
    }).filter(i => i.title && i.link);
    log('  items: '+items.length);
    for(const it of items.slice(0, 25)){
      if(!esAlertaTransito(it.title, '')) continue;
      if(!/paran[aá]|entre r[ií]os|municipalidad de paran[aá]/i.test(it.title)) continue;
      try{
        const html = await fetch(it.link);
        const $ = cheerio.load(html);
        $('script, style, noscript, iframe').remove();
        const txt = extraerContenido($);
        if(!txt || txt.length < 80) continue;
        if(!/corte|tr[aá]nsito|desv[ií]o|calzada|circulaci[oó]n/i.test(txt)) continue;
        const fecha = parseFecha(txt, it.link) || (()=>{ try{ const d=new Date(it.pubDate); return isNaN(+d)?'':d.toISOString(); }catch(e){ return ''; } })();
        if(!fecha) continue;
        if(Date.now() - new Date(fecha).getTime() > 60*24*60*60*1000) continue;
        const horario = parseHorario(txt);
        const centro = await georefCiudad('Paraná', 'Entre Ríos');
        const puntos = await resolverSegmentos(txt, 'Paraná', 'Entre Ríos', centro);
        if(!puntos) continue;
        const via = extraerVia(txt);
        const item = buildItem({ id:'apfnoticia:'+short(it.title,50), titulo: it.title, tipo:parseTipo(txt, it.title), categoria:parseCat(parseTipo(txt, it.title)), fecha, fecha_raw: fecha, descripcion: txt, resumen: extraerLead($) || txt, enlace: it.link, via, kmDesde:null, kmHasta:null, localidad:'Paraná', provincia:'Entre Ríos', horario, segmentos: puntos });
        if(item) out.push(item);
        else if(process.env.DEBUG_TRANSITO) console.error('[bing] item-null ' + original.slice(0,60));
      }catch(e){ if(process.env.DEBUG_TRANSITO) console.error('[item] ' + (e && e.message ? e.message : e)); }
      await sleep(200);
    }
  }catch(e){ log('  ✗ APFDigital noticias: '+(e.message||e)); }
  return out;
}

/* ════════════════════════════════════════════════════════════════════════════
   7. ELONCE SITEMAP (Paraná) — sitemap + fetch de noticia original (calles reales)
   ════════════════════════════════════════════════════════════════════════════ */
async function scrapElonceSitemap(){
  log('Elonce (Paraná): sitemap...');
  const out=[];
  try{
    const xml = await fetch('https://www.elonce.com/sitemap.xml');
    const $ = cheerio.load(xml, { xmlMode: true });
    const urls = [];
    $('loc').each((_,el)=>{ const u = $(el).text().trim(); if(u) urls.push(u); });
    log('  urls: '+urls.length);
    const candidatas = urls.filter(u => /\/parana\//.test(u) || /transito|corte|calle|agua|cloaca|desvio|vial|circulacion/i.test(u));
    log('  candidatas: '+candidatas.length);
    for(const url of candidatas.slice(0, 12)){
      try{
        const html = await fetch(url);
        const $ = cheerio.load(html);
        $('script, style, noscript, iframe').remove();
        const txt = extraerContenido($);
        if(!txt || txt.length < 80) continue;
        if(!/corte|tr[aá]nsito|desv[ií]o|calzada|circulaci[oó]n/i.test(txt)) continue;
        const titulo = clean($('h1').first().text()).trim() || clean($('title').text());
        const fecha = parseFecha(txt, url);
        if(!fecha) continue;
        if(Date.now() - new Date(fecha).getTime() > 60*24*60*60*1000) continue;
        const horario = parseHorario(txt);
        const centro = await georefCiudad('Paraná', 'Entre Ríos');
        const puntos = await resolverSegmentos(txt, 'Paraná', 'Entre Ríos', centro);
        if(!puntos) continue;
        const via = extraerVia(txt);
        const item = buildItem({ id:'elonce:'+short(titulo,50), titulo, tipo:parseTipo(txt, titulo), categoria:parseCat(parseTipo(txt, titulo)), fecha, fecha_raw: fecha, descripcion: txt, resumen: extraerLead($) || txt, enlace: url, via, kmDesde:null, kmHasta:null, localidad:'Paraná', provincia:'Entre Ríos', horario, segmentos: puntos });
        if(item) out.push(item);
        else if(process.env.DEBUG_TRANSITO) console.error('[bing] item-null ' + original.slice(0,60));
      }catch(e){ if(process.env.DEBUG_TRANSITO) console.error('[item] ' + (e && e.message ? e.message : e)); }
      await sleep(200);
    }
  }catch(e){ log('  ✗ Elonce sitemap: '+(e.message||e)); }
  return out;
}

/* ════════════════════════════════════════════════════════════════════════════
   5. GOOGLE NEWS RSS (Paraná + Santa Fe) — titulares reales de múltiples medios
   ════════════════════════════════════════════════════════════════════════════ */
async function scrapGoogleNews(query, tag){
  const out=[];
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=es-AR&gl=AR&ceid=AR:es-419`;
  try{
    const xml = await fetch(url);
    const $ = cheerio.load(xml, { xmlMode: true });
    const items = [];
    $('item').each((_,el)=>{
      const title = clean($(el).find('title').text()).trim();
      const link = clean($(el).find('link').text()).trim();
      const pubDate = clean($(el).find('pubDate').text()).trim();
      const source = clean($(el).find('source').text()).trim();
      items.push({ title, link, pubDate, source });
    });
    log(`  items: ${items.length}`);
    for(const it of items.slice(0, 15)){
      let titulo = it.title;
      let medio = it.source;
      const idx = titulo.lastIndexOf(' - ');
      if(idx > 0){ medio = titulo.slice(idx+3).trim(); titulo = titulo.slice(0, idx).trim(); }
      titulo = titulo.replace(/…$/, '').trim();
      if(!titulo || !esAlertaTransito(titulo, '')) continue;
      const loc = detectarLocalidad(titulo + ' ' + medio);
      if(!loc) continue;
      let fecha = '';
      try{ const d = new Date(it.pubDate); if(!isNaN(+d)) fecha = d.toISOString(); }catch(e){}
      if(!fecha) continue;
      // Solo últimas 7 días
      if(Date.now() - new Date(fecha).getTime() > 60*24*60*60*1000) continue;
      const centro = await georefCiudad(loc.localidad, loc.provincia);
      let puntos = await resolverSegmentos(titulo, loc.localidad, loc.provincia, centro);
      const esRuta = /ruta|rn\s*\d|rp\s*\d|autopista/i.test(titulo);
      if(!puntos) continue;
      const via = extraerVia(titulo);
      const item = buildItem({ id: tag+':'+short(titulo,50), titulo, tipo:parseTipo(titulo, titulo), categoria:parseCat(parseTipo(titulo, titulo)), fecha, fecha_raw: fecha, descripcion: titulo, resumen: titulo, enlace: it.link, via, kmDesde:null, kmHasta:null, localidad: loc.localidad, provincia: loc.provincia, horario: parseHorario(titulo), segmentos: puntos });
      if(item) out.push(item);
      await sleep(100);
    }
  }catch(e){ log('  ✗ Google News RSS: '+(e.message||e)); }
  return out;
}

/* ════════════════════════════════════════════════════════════════════════════
   6. BING NEWS RSS (Paraná + Santa Fe) — links a noticias originales + fetch
   ════════════════════════════════════════════════════════════════════════════ */
async function scrapBingNews(query, tag){
  log('Bing News: ' + query);
  const out=[];
  const url = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`;
  try{
    const xml = await fetch(url);
    const items = xml.split('<item>').slice(1).map(it => {
      const title = clean(((it.match(/<title>([\s\S]*?)<\/title>/)||[])[1]||''));
      const link = clean(((it.match(/<link>([\s\S]*?)<\/link>/)||[])[1]||''));
      const desc = clean(((it.match(/<description>([\s\S]*?)<\/description>/)||[])[1]||''));
      return { title, link, desc };
    }).filter(i => i.title && i.link);
    log('  items: '+items.length);
    for(const it of items.slice(0, 10)){
      const m = it.link.match(/[?&]url=([^&]+)/);
      const original = m ? decodeURIComponent(m[1]) : '';
      if(!original) continue;
      // Filtro previo permisivo (el título del RSS a veces no menciona "corte")
      if(!/corte|tr[aá]nsito|desv[ií]o|calzada|circulaci[oó]n|agua|cloaca|obra|calle|ruta|acceso|reparaci[oó]n|baches|paviment/i.test(it.title + ' ' + it.desc)) { if(process.env.DEBUG_TRANSITO) console.error('[bing] pre-filtro: ' + it.title.slice(0,50)); continue; }
      const loc = detectarLocalidad(it.title + ' ' + it.desc + ' ' + original, original);
      if(!loc) { if(process.env.DEBUG_TRANSITO) console.error('[bing] sin-localidad: ' + original.slice(0,60)); continue; }
      try{
        const html = await fetch(original);
        const $ = cheerio.load(html);
        $('script, style, noscript, iframe').remove();
        const txt = extraerContenido($);
        if(!txt || txt.length < 80) continue;
        // Filtro estricto sobre el contenido real de la noticia
        if(!/corte|tr[aá]nsito|desv[ií]o|calzada|circulaci[oó]n/i.test(txt)) { if(process.env.DEBUG_TRANSITO) console.error('[bing] sin-tema ' + original.slice(0,60)); continue; }
        const fecha = parseFecha(txt, original);
        if(!fecha) { if(process.env.DEBUG_TRANSITO) console.error('[bing] sin-fecha'); continue; }
        if(Date.now() - new Date(fecha).getTime() > 60*24*60*60*1000) { if(process.env.DEBUG_TRANSITO) console.error('[bing] vieja ' + fecha); continue; }
        const horario = parseHorario(txt);
        const centro = await georefCiudad(loc.localidad, loc.provincia);
        let puntos = await resolverSegmentos(txt, loc.localidad, loc.provincia, centro);
        if(!puntos) { if(process.env.DEBUG_TRANSITO) console.error('[bing] sin-geometria ' + original.slice(0,60)); continue; }
        const via = extraerVia(txt);
        const titulo = clean($('h1').first().text()).trim() || it.title;
        const item = buildItem({ id: tag+':'+short(titulo,50), titulo, tipo:parseTipo(txt, titulo), categoria:parseCat(parseTipo(txt, titulo)), fecha, fecha_raw: fecha, descripcion: txt, resumen: extraerLead($) || txt, enlace: original, via, kmDesde:null, kmHasta:null, localidad: loc.localidad, provincia: loc.provincia, horario, segmentos: puntos });
        if(item) out.push(item);
        else if(process.env.DEBUG_TRANSITO) console.error('[bing] item-null ' + original.slice(0,60));
      }catch(e){ if(process.env.DEBUG_TRANSITO) console.error('[item] ' + (e && e.message ? e.message : e)); }
      await sleep(200);
    }
  }catch(e){ log('  ✗ Bing News: '+(e.message||e)); }
  return out;
}

/* ════════════════════════════════════════════════════════════════════════════
   8. LISTADOS DE NOTAS (Elonce temas / Municipalidad de Paraná)
   ════════════════════════════════════════════════════════════════════════════ */
const MESES_ARR = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

function diasDesde(iso){
  const t = new Date(iso).getTime();
  return isNaN(t) ? 1e9 : (Date.now() - t) / 86400000;
}

/** Fecha de publicación: meta og, "18 de Noviembre de 2026" en el texto, o la URL. */
function fechaDeArticulo($, txt, url){
  const meta = $('meta[property="article:published_time"]').attr('content')
            || $('meta[property="og:updated_time"]').attr('content');
  if(meta && !isNaN(+new Date(meta))) return new Date(meta).toISOString();

  const m = clean(txt).match(/\b(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})\b/i);
  if(m){
    const d = fechaART(m[1], m[2], m[3], 12);
    if(d) return d.toISOString();
  }
  return parseFecha(txt, url) || null;
}

/**
 * Scrapea un listado de notas y devuelve alertas.
 * cfg: { nombre, indice, base, tag, filtroLink (regex), max }
 */
async function scrapListadoDeNotas(cfg){
  log(cfg.nombre + ': indexando...');
  const out = [];
  try{
    const idx = await fetch(cfg.indice);
    const $ = cheerio.load(idx);
    const links = [];
    $('a[href]').each((_, a) => {
      const h = $(a).attr('href') || '';
      const t = clean($(a).text());
      if(t.length < 25 || t.length > 160) return;
      if(!RE_TEMA_TRANSITO.test(t)) return;
      const abs = h.startsWith('http') ? h : cfg.base + h;
      if(cfg.filtroLink && !cfg.filtroLink.test(abs)) return;
      if(links.find(x => x.url === abs)) return;
      links.push({ url: abs, titulo: t });
    });
    log('  links: ' + links.length);

    for(const l of links.slice(0, cfg.max || 8)){
      try{
        const html = await fetch(l.url);
        const $h = cheerio.load(html);
        $h('script, style, noscript, iframe').remove();
        const txt = extraerContenido($h);
        if(!txt || txt.length < 120) continue;
        if(!RE_TEMA_TRANSITO.test(txt)) continue;

        const fecha = fechaDeArticulo($h, txt, l.url);
        if(!fecha || diasDesde(fecha) > 21) continue;

        const loc = detectarLocalidad(l.titulo + ' ' + txt, l.url);
        if(!loc) continue;

        const centro = await georefCiudad(loc.localidad, loc.provincia);
        const titulo = clean($h('h1').first().text()).trim() || l.titulo;
        // El título suele nombrar la calle ("Avenida Almafuerte"): se antepone
        const puntos = await resolverSegmentos(titulo + '. ' + txt, loc.localidad, loc.provincia, centro);
        if(!puntos) continue;

        const item = buildItem({
          id: cfg.tag + ':' + short(titulo, 50), titulo,
          tipo: parseTipo(txt, titulo), categoria: parseCat(parseTipo(txt, titulo)),
          fecha, fecha_raw: fecha,
          descripcion: txt, resumen: extraerLead($h) || txt,
          enlace: l.url, via: extraerVia(txt),
          kmDesde: null, kmHasta: null,
          localidad: loc.localidad, provincia: loc.provincia,
          horario: parseHorario(txt), segmentos: puntos
        });
        if(item) out.push(item);
      }catch(e){}
      await sleep(150);
    }
  }catch(e){ log('  ✗ ' + cfg.nombre + ': ' + (e.message || e)); }
  log('  → ' + out.length + ' alerta(s)');
  return out;
}
async function main(){
  log('🚦 Iniciando extracción de alertas de tránsito (Litoral AR)...');
  let items=[];

  // ── Paraná: listados con notas actuales (antes no se usaban) ─────────────
  for(const cfg of [
    { nombre: 'Elonce temas/transito', indice: 'https://www.elonce.com/temas/transito', base: 'https://www.elonce.com', tag: 'elonce-transito', filtroLink: /^https:\/\/www\.elonce\.com\/parana\//, max: 6 },
    { nombre: 'Elonce temas/obras',    indice: 'https://www.elonce.com/temas/obras',    base: 'https://www.elonce.com', tag: 'elonce-obras',    filtroLink: /^https:\/\/www\.elonce\.com\/parana\//, max: 6 },
    { nombre: 'Municipalidad de Paraná', indice: 'https://www.parana.gob.ar/noticias', base: 'https://www.parana.gob.ar', tag: 'municipio-parana', filtroLink: /\/noticias\//, max: 6 },
  ]){
    try{ items = items.concat(await scrapListadoDeNotas(cfg)); }catch(e){ log(cfg.nombre + ': ' + (e.message||e)); }
  }
  try{ items = items.concat(await scrapElLitoral()); }catch(e){log('El Litoral: '+(e.message||e));}
  try{ items = items.concat(await scrapRuta0()); }catch(e){log('Ruta0: '+(e.message||e));}
  try{ items = items.concat(await scrapApsv()); }catch(e){log('APSV: '+(e.message||e));}
  try{ items = items.concat(await scrapApfRss('https://www.apfdigital.com.ar/rss/municipales/', 'apfmunicipales')); }catch(e){log('APF municipales: '+(e.message||e));}
  try{ items = items.concat(await scrapApfRss('https://www.apfdigital.com.ar/rss/noticias/', 'apfnoticias')); }catch(e){log('APF noticias: '+(e.message||e));}
  try{ items = items.concat(await scrapApfNoticias()); }catch(e){log('APF noticias full: '+(e.message||e));}
  try{ items = items.concat(await scrapElonceSitemap()); }catch(e){log('Elonce: '+(e.message||e));}

  // Google News RSS — alertas reales de múltiples medios (Paraná + Santa Fe)
  const QUERIES = [
    ['cortes de transito Parana', 'gn-parana-cortes'],
    ['transito Parana Entre Rios', 'gn-parana-transito'],
    ['corte transito Santa Fe', 'gn-santafe-cortes'],
    ['transito Santa Fe rutas', 'gn-santafe-rutas'],
  ];
  for(const [q, tag] of QUERIES){
    try{ items = items.concat(await scrapGoogleNews(q, tag)); }catch(e){log('GoogleNews: '+(e.message||e));}
  }

  // Bing News RSS — links a noticias originales + fetch del contenido completo
  const BING_QUERIES = [
    ['site:apfdigital.com.ar corte transito', 'bing-apf-cortes'],
    ['site:apfdigital.com.ar obras agua cloacas corte', 'bing-apf-obras'],
    ['site:elonce.com corte transito parana', 'bing-elonce-cortes'],
    ['site:elonce.com cortes de transito parana', 'bing-elonce-cortes2'],
    ['site:elonce.com desvio transito parana', 'bing-elonce-desvio'],
    ['site:apfdigital.com.ar corrientes la paz colon', 'bing-apf-corrientes'],
    ['cortes transito Santa Fe', 'bing-santafe'],
    ['corte calle Santa Fe', 'bing-santafe-calle'],
  ];
  for(const [q, tag] of BING_QUERIES){
    try{ items = items.concat(await scrapBingNews(q, tag)); }catch(e){log('BingNews: '+(e.message||e));}
  }

  // ── 1) Solo medios locales del Litoral (evita noticias de otras provincias) ─
  const descartados = {};
  items = items.filter(i => {
    if(!i || !i.enlace) return false;
    const conf = ciudadPorDominio(i.enlace);
    if(!conf){ const h = dominioDe(i.enlace) || '(sin dominio)'; descartados[h] = (descartados[h]||0)+1; return false; }
    // El dominio manda la provincia; si el texto no dio ciudad, se usa la del medio
    if(conf.provincia && i.provincia !== conf.provincia){
      i.provincia = conf.provincia;
      i.localidad = conf.localidad;
    }
    return true;
  });
  const topDesc = Object.entries(descartados).sort((a,b)=>b[1]-a[1]).slice(0,8);
  if(topDesc.length) log('  descartados por dominio: ' + topDesc.map(([d,n])=>d+'('+n+')').join(', '));

  // ── 2) Calidad: provincia válida, tema de tránsito, vigente y ubicable ────
  const AHORA = Date.now();
  const antesDeFiltro = items.length;
  items = items.filter(i => {
    if(!i) return false;
    const razones = [];
    if(PROVS_OK.indexOf(i.provincia) === -1) razones.push('provincia:' + i.provincia);
    if(!RE_TEMA_TRANSITO.test((i.titulo||'') + ' ' + (i.resumen||''))) razones.push('tema');
    if(RE_NO_ES_ALERTA.test(i.titulo || '')) razones.push('policial');
    if(!(i.sin_ubicacion || (i.lat != null && i.lon != null))) razones.push('sin-coords');
    if(i.lat != null && i.lat > -34.0 && i.lon > -58.5) razones.push('caba');
    if(i.lat != null && i.lat < -32.0 && i.lon < -62.0) razones.push('sur');
    if(!i.vigencia || !(new Date(i.vigencia.hasta).getTime() > AHORA)) razones.push('vencida:' + (i.vigencia ? i.vigencia.hasta : 'sin-dato'));
    if(i.fecha && !isNaN(+new Date(i.fecha)) && AHORA - new Date(i.fecha).getTime() > 180*24*60*60*1000) razones.push('muy-vieja');
    if(razones.length){
      if(process.env.DEBUG_TRANSITO) console.error('[drop] ' + (i.titulo||'').slice(0,60) + ' → ' + razones.join(', '));
      return false;
    }
    return true;
  });
  log(`  ${antesDeFiltro - items.length} descartada(s) por vencidas/fuera de zona`);

  // ── 3) Alertas sin ubicación: solo si el título es un titular real ────────
  const sinUbi = {};
  items = items.filter(i => {
    if(!i.sin_ubicacion) return true;
    const t = i.titulo || '';
    const esTitular = t.length >= 40 && /^[A-ZÁÉÍÓÚÑ¿¡]/.test(t) && RE_TEMA_TRANSITO.test(t);
    if(!esTitular) return false;
    const k = i.localidad + '|' + i.provincia;
    sinUbi[k] = (sinUbi[k]||0) + 1;
    return sinUbi[k] <= 2;
  });

  // ── 4) Dedup y orden: primero las que tienen ubicación, luego por fecha ───
  items = uniqById(items);
  items = dedupSimilares(items);
  items = dedupPorGeometria(items);
  items.sort((a,b) => {
    if(!!a.sin_ubicacion !== !!b.sin_ubicacion) return a.sin_ubicacion ? 1 : -1;
    return (new Date(b.fecha||0)) - (new Date(a.fecha||0));
  });
  items = items.slice(0, MAX);

  // Recuperar lo que sigue vigente aunque hoy no haya aparecido
  items = fusionarHistorial(items);
  // Dedup OTRA VEZ: lo recuperado puede duplicar lo recién raspado (misma obra
  // publicada por el municipio y por el diario)
  items = dedupSimilares(items);
  items = dedupPorGeometria(items);
  items.sort((a,b) => {
    if(!!a.sin_ubicacion !== !!b.sin_ubicacion) return a.sin_ubicacion ? 1 : -1;
    return (new Date(b.fecha||0)) - (new Date(a.fecha||0));
  });
  items = items.slice(0, MAX);

  const payload = { timestamp:new Date().toISOString(), timestamp_epoch:Math.floor(Date.now()/1000), source:'vxl-transito-ar', cantidad:items.length, items:items };
  fs.mkdirSync(DIR_DATOS, { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(payload,null,2), 'utf-8');
  log(`💾 data/transito.json OK — ${items.length} alerta(s). Provincias: `+[...new Set(items.map(i=>i.provincia))].join(', '));
  if(items.length === 0) log('⚠ Sin alertas georreferenciables.');
  process.exit(0);
}
if(require.main === module){
  main().catch(e=>{ log('FATAL: '+(e&&e.message?e.message:e)); process.exit(1); });
}

// Exportado para tests (no se ejecuta al importar)
module.exports = { extraerSegmentos, resolverSegmentos, limpiarNombre, parseHorario, parseFecha, parseTipo, calcularVigencia, motivoCorto, franjaCorta };

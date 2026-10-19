// /scripts/update-bolsillo.js
// Corre en GitHub Actions cada 10 minutos.
// Obtiene noticias haciendo scraping directo de páginas de noticias argentinas
// y las clasifica en 4 categorías: PODER ADQUISITIVO, SERVICIOS Y HOGAR,
// CONSUMO MASIVO, GOBIERNO. La categoría GOBIERNO es opcional.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');

const CATEGORIAS = [
  {
    id: 'poder_adquisitivo',
    nombre: 'PODER ADQUISITIVO',
    keywords: ['paritaria', 'sueldo', 'salario', 'ipc', 'inflación', 'inflacion', 'salario mínimo', 'jubilación', 'jubilacion', 'pensión', 'pension', 'anses', 'asignación', 'asignacion', 'auh', 'potenciar trabajo']
  },
  {
    id: 'servicios_hogar',
    nombre: 'SERVICIOS Y HOGAR',
    keywords: ['tarifa', 'luz', 'gas', 'agua', 'combustible', 'transporte', 'nafta', 'gnc', 'subte', 'tren', 'colectivo', 'peaje', 'autopista', 'telefonía', 'telefonia', 'internet', 'cable', 'alquiler', 'alquileres', 'expensas', 'prepagas', 'obra social', 'medicina prepaga']
  },
  {
    id: 'consumo_masivo',
    nombre: 'CONSUMO MASIVO',
    keywords: ['canasta', 'góndola', 'gondola', 'supermercado', 'hipermercado', 'desabastecimiento', 'ofertas', 'descuentos', 'tarjeta de crédito', 'tarjeta de credito', 'cuotas', 'consumo', 'ventas', 'comercio', 'pymes']
  },
  {
    id: 'gobierno',
    nombre: 'GOBIERNO',
    keywords: ['gobierno', 'presupuesto', 'impuestos', 'ingresos brutos', 'monotributo', 'afip', 'banco central', 'bcra', 'dólar', 'dolar', 'tipo de cambio', 'reservas', 'fmi', 'fondo monetario', 'deuda', 'bonos', 'leliq', 'tasa de interés', 'tasa de interes', 'política económica', 'politica economica', 'ministro de economía', 'ministro de economia', 'congreso', 'senado', 'diputados', 'decreto', 'dnu']
  }
];

const FUENTES = [
  { nombre: 'Clarín', url: 'https://www.clarin.com/economia/', selector: 'article h2, article h3, .title, [class*="title"]' },
  { nombre: 'La Nación', url: 'https://www.lanacion.com.ar/economia/', selector: 'h2 a, h3 a, [class*="title"] a, .com-title a' },
  { nombre: 'Página/12', url: 'https://www.pagina12.com.ar/secciones/economia', selector: '.title, h2, h3, h4' },
  { nombre: 'Infobae', url: 'https://www.infobae.com/economia/', selector: '[class*="headline"], h2, h3' },
  { nombre: 'El Litoral (Santa Fe)', url: 'https://www.ellitoral.com/seccion/economia', selector: '[class*="titulo"], h2' },
  { nombre: 'El Entre Ríos', url: 'https://www.elentrerios.com/', selector: 'h2, h3, [class*="title"], [class*="titulo"]' }
];

function normalizarTexto(texto) {
  return (texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function clasificarNoticia(titulo) {
  const texto = normalizarTexto(titulo);
  const categorias = [];
  for (const cat of CATEGORIAS) {
    if (cat.keywords.some(kw => texto.includes(normalizarTexto(kw)))) {
      categorias.push(cat.id);
    }
  }
  return categorias;
}

function formatearFecha(fechaISO) {
  try {
    const fecha = new Date(fechaISO);
    const ahora = new Date();
    const diffMs = ahora - fecha;
    const diffMin = Math.floor(diffMs / 60000);
    const diffHs = Math.floor(diffMs / 3600000);
    const diffDias = Math.floor(diffMs / 86400000);
    if (diffMin < 1) return 'Ahora';
    if (diffMin < 60) return 'Hace ' + diffMin + ' min';
    if (diffHs < 24) return 'Hace ' + diffHs + ' hs';
    if (diffDias < 7) return 'Hace ' + diffDias + ' día' + (diffDias > 1 ? 's' : '');
    return fecha.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });
  } catch { return ''; }
}

function esGancho(t) {
  var n = normalizarTexto(t);
  var g = ['viral','se hizo viral','lleno su','hizo viral','tendr','vas a','no creer','sorpres','imposible','asqueroso','increible','escandal','te vas a','no vas a','haz click','haga click','click aqui','ver video','este video','trending','sabias que','sabia que','esto del','esto de','mira esto','top 10','lista de','10 cosas','curiosidad','dato curioso'];
  for (var i = 0; i < g.length; i++) { if (n.indexOf(g[i]) !== -1) return true; }
  if (/[!]{2,}/.test(t)) return true;
  if (/[\u{1F300}-\u{1FAFF}]/u.test(t)) return true;
  return false;
}
function extraerFecha($el, fuente) {
  var cand = $el.closest('time[datetime]');
  if (!cand || !cand.attr('datetime')) cand = $el.parents('article').find('time[datetime]').first();
  if (!cand || !cand.attr('datetime')) cand = $el.siblings('time[datetime]').first();
  var raw = cand && cand.attr('datetime');
  if (raw) { var d = new Date(raw); if (!isNaN(d.getTime())) return d.toISOString(); }
  return new Date().toISOString();
}
function reescribirTitulo(t) {
  var n = t;
  n = n.replace(/[\u{1F300}-\u{1FAFF}]/gu, '');
  n = n.replace(/\b(en vivo|live)\b/gi, '');
  n = n.replace(/minuto a minuto/gi, '');
  n = n.replace(/,\s*d\u00f3lar hoy:/gi, ': ');
  n = n.replace(/a cu\u00e1nto cotizan el /gi, 'cotizaci\u00f3n del ');
  n = n.replace(/\s+/g, ' ').trim();
  n = n.replace(/,\s*:/g, ': ');
  n = n.replace(/^[\s.,;:¡?\-_|'"()+«»*]+/, '').trim();
  n = n.replace(/[\s.,;:¡?\-_|'"()+«»*]+$/, '').trim();
  if (!n) return t;
  n = n.charAt(0).toUpperCase() + n.slice(1);
  if (n.length > 130) n = n.slice(0, 127) + '\u2026';
  return n;
}

async function procesarFuente(fuente) {
  try {
    const response = await axios.get(fuente.url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const $ = cheerio.load(response.data);
    const noticias = [];
    const titulosVistos = new Set();
    $(fuente.selector).each((i, el) => {
      const $el = $(el);
      const tituloRaw = $el.text().trim();
      const titulo = reescribirTitulo(tituloRaw);
      const link = $el.attr('href') || $el.closest('a').attr('href') || '';
      if (tituloRaw.length > 15 && !titulosVistos.has(tituloRaw) && !esGancho(tituloRaw) && !esOffTopic(tituloRaw)) {
        titulosVistos.add(tituloRaw);
        const categorias = clasificarNoticia(titulo);
        if (categorias.length > 0) {
          noticias.push({
            titulo: titulo,
            descripcion: '',
            url: link.startsWith('http') ? link : fuente.url.replace(/\/$/, '') + '/' + link.replace(/^\//, ''),
            fecha: extraerFecha($el, fuente),
            fuente: fuente.nombre,
            categorias
          });
        }
      }
    });
    console.log('[SCRAPING] ' + fuente.nombre + ': ' + noticias.length + ' noticias relevantes');
    return noticias;
  } catch (e) {
    console.warn('[SCRAPING] Error en ' + fuente.nombre + ': ' + e.message);
    return [];
  }
}

function parseFechaIso(f) {
  var d = Date.parse(f);
  return isNaN(d) ? 0 : d;
}

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash-8b:generateContent?key=' + encodeURIComponent(process.env.GEMINI_API_KEY || '');
const OFF_TOPIC = ['policia','policial','droga','drogadicc','narc','narcotr','confisc','detenc','detenido','allanamiento','homicid','victim','victima','violencia','tiroteo','accidente','accidental','fallec','muerte','omicid','delito','delincuencia','cauta','inyectable','prisión','prision','incendio','incendiado'];
function esOffTopic(t) {
  var n = normalizarTexto(t);
  for (var i = 0; i < OFF_TOPIC.length; i++) { if (n.indexOf(OFF_TOPIC[i]) !== -1) return true; }
  return false;
}
var STOP = new Set(['de','el','la','los','las','en','por','un','una','unas','unos','para','con','y','o','del','al','se','que','más','hoy','ayer','horas','min','hs','fecha','cotiz','precio','valor','subió','bajó','alza','caída']);
function simTokens(t) {
  return normalizarTexto(t).replace(/[\d.,;%$()+]/g, '').split(/[^a-záéíóúñü]+/i).filter(function(w) { return w.length > 3 && !STOP.has(w); });
}
function jaccard(a, b) {
  var sa = new Set(simTokens(a));
  var sb = new Set(simTokens(b));
  if (!sa.size && !sb.size) return 0;
  var inter = 0;
  sa.forEach(function(x) { if (sb.has(x)) inter++; });
  return inter / (sa.size + sb.size - inter);
}
function tokensDe(t) {
  return String(t || '').toLowerCase().replace(/[^a-záéíóñü0-9]+/gi, ' ').split(/\s+/).filter(function (w) { return w.length > 3; });
}
function nuevasEn(llm, orig) {
  var base = {}; var to = tokensDe(orig);
  for (var i = 0; i < to.length; i++) base[to[i]] = true;
  var dif = 0; var tl = tokensDe(llm);
  for (var j = 0; j < tl.length; j++) { if (!base[tl[j]]) dif++; }
  return dif;
}
// guardrail "no inventar": el LLM solo puede reordenar/sinonimizar el titular original.
// Si el rewrite introduce >2 tokens novedosos (no en el original) => se rechaza
// y se conserva el rewrite heurístico. Así "a nuestra manera" sí, pero NUNCA inventa.
function aplicarGuardrail(rewrites, orig) {
  return rewrites.map(function (r, i) {
    if (!r || typeof r !== 'string') return null;
    var base = new Set(simTokens(orig[i] || ''));
    var dif = 0;
    var tl = simTokens(r);
    for (var j = 0; j < tl.length; j++) { if (!base.has(tl[j])) dif++; }
    return dif <= 1 ? r : null; // <=1 content-word novedoso (sinónimo) ok; >1 = posible invención -> conserva heurístico
  });
}
function delay(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
async function reescribirLote(titulos) {
  if (!process.env.GEMINI_API_KEY) return titulos;
  var prompt = 'Reescribí los siguientes titulares en español rioplatense, tono VXL (informal pero respetuoso, como hablás con un amigo al coffee): descriptivo y de interés para una persona normal, conservando TODA la información del titular original sin inventar ni agregar datos. Sin clickbait, sin ganchos, sin emojis, sin jerga policial ni temas drogas/accidentes/violencia (el filtro esOffTopic los descarta). Devolvé SOLO un JSON válido con la forma {"rewrites":["título 1","título 2",...]} con exactamente la misma cantidad de ítems recibidos y en el mismo orden. NO agregues numeración ni texto extra. Titulares: ' + JSON.stringify(titulos);
  var body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 200 } };
  for (var attempt = 0; attempt < 3; attempt++) {
    try {
      await delay(4000);
      var r = await axios.post(GEMINI_URL, body, { timeout: 20000, headers: { 'Content-Type': 'application/json' } });
      var cand = (r.data && r.data.candidates && r.data.candidates[0]);
      var txt = (cand && cand.content && cand.content.parts && cand.content.parts[0] && cand.content.parts[0].text) || '';
      var m = txt.match(/\{[\s\S]*\}/);
      if (m) {
        try { var parsed = JSON.parse(m[0]); if (Array.isArray(parsed.rewrites) && parsed.rewrites.length === titulos.length) return aplicarGuardrail(parsed.rewrites, titulos); } catch (e) {}
        try { var p2 = JSON.parse(txt.trim()); if (Array.isArray(p2.rewrites) && p2.rewrites.length === titulos.length) return aplicarGuardrail(p2.rewrites, titulos); } catch (e2) {}
      }
    } catch (e) {
      if (attempt < 2) await delay(2000);
    }
  }
  return titulos;
}
async function reescribirConLLM(items) {
  if (!process.env.GEMINI_API_KEY || !items.length) return;
  var aplicados = 0, rechazados = 0;
  for (var i = 0; i < items.length; i += 25) {
    var chunk = items.slice(i, i + 25);
    var rw = await reescribirLote(chunk.map(function(c) { return c.titulo; }));
    for (var j = 0; j < chunk.length; j++) {
      if (rw[j] && rw[j].length) { chunk[j].titulo = rw[j]; aplicados++; }
      else { rechazados++; }
    }
  }
  console.log('[bolsillo] rewrites LLM aplicados:', aplicados, '| rechazados por invención (conserva heurístico):', rechazados);
  return items;
}

async function main() {
  // --- hoy ---
  const resultados = await Promise.all(FUENTES.map(f => procesarFuente(f)));
  const nuevas = [];
  const titulosVistos = new Set();
  for (const noticias of resultados) {
    for (const n of noticias) {
      const key = normalizarTexto(n.titulo);
      if (!titulosVistos.has(key)) { titulosVistos.add(key); nuevas.push(n); }
    }
  }

  // --- acumular histórico previo (últimos ~7 días) ---
  const dataFile = path.join(__dirname, '../data/bolsillo.json');
  let historico = [];
  if (fs.existsSync(dataFile)) {
    try {
      const prev = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      if (Array.isArray(prev.noticias)) historico = prev.noticias.slice();
      else {
        for (const cat of (prev.categorias || [])) {
          for (const n of (cat.noticias || [])) {
            historico.push({
              titulo: n.titulo, descripcion: n.descripcion || '', url: n.url,
              fecha: n.fecha || new Date().toISOString(),
              fuente: n.fuente,
              categorias: cat.id ? [cat.id] : clasificarNoticia(n.titulo)
            });
          }
        }
      }
    } catch (e) { console.warn('[WARN] no se pudo leer el histórico previo:', e.message); }
  }

  // --- merge + dedupe conservando la fecha más nueva ---
  const merged = {};
  let cntGancho = 0, cntOffTopic = 0;
  const add = (n) => {
    n.titulo = reescribirTitulo(n.titulo);
    const k = normalizarTexto(n.titulo);
    if (!k || !n.titulo) return;
    if (esGancho(n.titulo)) { cntGancho++; return; }
    if (esOffTopic(n.titulo)) { cntOffTopic++; return; }
    if (!n.categorias || !n.categorias.length) n.categorias = clasificarNoticia(n.titulo);
    if (merged[k]) { if (parseFechaIso(n.fecha) > parseFechaIso(merged[k].fecha)) merged[k] = n; }
    else { merged[k] = n; }
  };
  for (const n of nuevas) add(n);
  for (const n of historico) add(n);
  console.log('[bolsillo] filtrados gancho:', cntGancho, '| off-topic (policiales/drogas/etc):', cntOffTopic);
  const todas = Object.values(merged);

  // --- ventana 7 días (más recientes) ---
  const AHORA = Date.now();
  const CORTE_MS = 7 * 24 * 60 * 60 * 1000;
  let recientes = todas.filter(n => {
    const t = parseFechaIso(n.fecha);
    return t > 0 && t >= AHORA - CORTE_MS && t <= AHORA + 60000;
  });
  recientes.sort((a, b) => parseFechaIso(b.fecha) - parseFechaIso(a.fecha)); /* más reciente primero */
  await reescribirConLLM(recientes); /* a voz VXL vía Gemini (gratis); fallback al heurístico */

  // --- dedupe post-LLM (misma noticia, distinto título/fuente → LLM la unifica → título idéntico → dup) ---
  const sinDup = [];
  for (const n of recientes) {
    if (!sinDup.some(k => jaccard(n.titulo, k.titulo) > 0.85)) sinDup.push(n);
  }
  recientes = sinDup;

  // --- categorías completas (sin recortar a 5) ---
  const porCategoria = {};
  for (const cat of CATEGORIAS) porCategoria[cat.id] = { id: cat.id, nombre: cat.nombre, noticias: [] };
  for (const n of recientes) {
    for (const catId of n.categorias) {
      if (porCategoria[catId]) {
        porCategoria[catId].noticias.push({
          titulo: n.titulo, descripcion: n.descripcion || '', url: n.url,
          fecha: n.fecha, fechaFormateada: formatearFecha(n.fecha), fuente: n.fuente
        });
      }
    }
  }
  const categoriasOutput = [];
  for (const cat of CATEGORIAS) { const not = porCategoria[cat.id].noticias; if (not.length) categoriasOutput.push({ id: cat.id, nombre: cat.nombre, noticias: not }); }

  // --- alertas (destacada: la más reciente de cada categoría) ---
  const alertas = [];
  for (const cat of CATEGORIAS) { const not = porCategoria[cat.id].noticias; if (not.length) { const top = not[0]; alertas.push({ titulo: top.titulo, impacto: cat.nombre, tiempo: top.fechaFormateada, fuente: top.fuente }); } }

  const payload = {
    last_updated: new Date().toISOString(),
    timestamp_epoch: Math.floor(Date.now() / 1000),
    total_noticias: recientes.length,
    window_days: 7,
    categorias: categoriasOutput,
    noticias: recientes,          /* archivo plano completo (7d), más reciente primero */
    alertas: alertas
  };
  const outputDir = path.join(__dirname, '../data');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'bolsillo.json'), JSON.stringify(payload, null, 2));
  console.log('[OK] bolsillo.json guardado — ' + recientes.length + ' noticias (ventana 7d), ' + categoriasOutput.length + ' categorías activas');
  for (const cat of categoriasOutput) console.log('  ' + cat.nombre + ': ' + cat.noticias.length + ' noticias');
}

main().catch(e => {
  console.error('[ERROR] Falló el pipeline de bolsillo:', e.message);
  process.exit(1);
});

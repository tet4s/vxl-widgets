// /scripts/update-bolsillo.js
// Corre en GitHub Actions cada 10 minutos.
// Obtiene noticias haciendo scraping directo de páginas de noticias argentinas
// y las clasifica en 4 categorías: PODER ADQUISITIVO, SERVICIOS Y HOGAR,
// CONSUMO MASIVO, GOBIERNO. La categoría GOBIERNO es opcional.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const ia = require('./lib/gemini');
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
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// match por palabra: los términos cortos (gas, auto, luz, cer, uva...) se buscan
// con límite de palabra inicial para no matchear dentro de otra palabra
// (ej. "Las Vegas" no debe contar como "gas").
function matchTermino(texto, termino) {
  const t = normalizarTexto(termino);
  if (t.length <= 4) return new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(texto);
  return texto.includes(t);
}

function clasificarNoticia(titulo) {
  const texto = normalizarTexto(titulo);
  const categorias = [];
  for (const cat of CATEGORIAS) {
    if (cat.keywords.some(kw => matchTermino(texto, kw))) {
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
  var g = ['viral','se hizo viral','lleno su','hizo viral','tendr','vas a','no creer','sorpres','imposible','asqueroso','increible','escandal','te vas a','no vas a','haz click','haga click','click aqui','ver video','este video','trending','sabias que','sabia que','esto del','esto de','mira esto','top 10','lista de','10 cosas','curiosidad','dato curioso','no es cuento','no es un cuento','no es real','más que un cuento','más que una historia','el secreto de','todo cambió','no es casualidad','minuto a minuto','triunfo que llev','en vivo','live'];
  for (var i = 0; i < g.length; i++) { if (n.indexOf(g[i]) !== -1) return true; }
  if (/[!]{2,}/.test(t)) return true;
  if (/tiene \d+ años/i.test(t)) return true;
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
async function extraerDescripcion(link, timeout = 4000) {
  if (!link || !/^https?:\/\//i.test(link)) return '';
  try {
    // curl bypassa CF (fingerprint CLI != axios Node); async para concurrencia real en los batches
    const { execFile } = require('child_process');
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
    let html = '';
    try {
      html = await new Promise((resolve, reject) => {
        execFile('curl', ['-sL', '--max-time', '8', '-A', UA, '-w', '\n__HTTP__%{http_code}', link], { maxBuffer: 1024 * 1024 }, function (err, stdout) { if (err) reject(err); else resolve(stdout); });
      });
      const m = html && html.match(/__HTTP__(\d{3})$/);
      if (m) {
        const status = Number(m[1]);
        html = html.slice(0, m.index);
        if ([401, 403, 404, 429, 500, 502, 503].includes(status)) return '';
      }
    } catch { return ''; }
    const $ = cheerio.load(typeof html === 'string' ? html : '');
    let desc = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '';
    if (!desc) {
      const $p = $('article p, .nota p, .contenido p, .entry-content p, .cuerpo-nota p, .cuerpo p, .story-content p, [itemprop="articleBody"] p, main p, .text p, .lead p').filter(function () {
        return $(this).text().trim().length > 60;
      });
      desc = $p.first().text().trim();
    }
    return String(desc || '').slice(0, 320).replace(/\s+/g, ' ').trim();
  } catch { return ''; }
}

// titular descriptivo (path sin key / fallback): si el headline es vago/gancho usa el lead
function tituloDescriptivo(t, desc) {
  let n = reescribirTitulo(t);
  if (!desc) return repararPorcentaje(n, t);
  if (/[%$\d]|(subir|bajar|aumentar|anunciar|elevar|reducir|crecer|decir|señalar|confirmar|presentar|publicar|registrar)/i.test(n)) return repararPorcentaje(n, t);
  let d = String(desc || '').replace(/\s+/g, ' ').trim();
  if (d.length > 130) d = d.slice(0, 127) + '\u2026';
  return repararPorcentaje(d || n, t);
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
      if (tituloRaw.length > 15 && !titulosVistos.has(tituloRaw) && !esGancho(tituloRaw) && !esOffTopic(tituloRaw) && !esCotizacionDolar(tituloRaw)) {
        titulosVistos.add(tituloRaw);
        const categorias = clasificarNoticia(titulo);
        if (categorias.length > 0) {
          // teaser de la página de sección (CF-safe): <p> del card, o hermano del headline
          let teaser = '';
          const $card = $el.closest('article, figure, [class*="card"], [class*="item"], [class*="news"]');
          const $p = $card.find('p').filter(function () { const t = $(this).text().trim(); return t.length > 60 && t.length < 340; });
          teaser = $p.first().text().trim();
          if (!teaser) teaser = ($el.siblings('p').first().text() || '').trim();
          if (!teaser) teaser = ($el.parent().siblings('p').first().text() || '').trim();
          noticias.push({
            titulo: titulo,
            descripcion: teaser.slice(0, 320),
            url: (function () { if (link.startsWith('http')) return link; let L = link; if (!L.startsWith('/')) L = '/' + L; try { return new URL(L, fuente.url).href; } catch { return link; } })(),
            fecha: extraerFecha($el, fuente),
            fuente: fuente.nombre,
            categorias
          });
        }
      }
    });
    // fallback: nota sin teaser de sección -> intenta el lead de la nota (CF-puede-bloquear)
    const sinTeaser = noticias.filter(c => !c.descripcion);
    for (let i = 0; i < sinTeaser.length; i += 8) {
      const batch = sinTeaser.slice(i, i + 8);
      await Promise.all(batch.map(c => extraerDescripcion(c.url).then(d => { if (d) c.descripcion = d; })));
    }
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

const OFF_TOPIC = ['policia','policial','droga','drogadicc','narc','narcotr','confisc','detenc','detenido','allanamiento','homicid','victim','victima','violencia','tiroteo','accidente','accidental','fallec','muerte','omicid','delito','delincuencia','cauta','inyectable','prisión','prision','incendio','incendiado','enriquecimien','patrimoni','acusacion','corrupcion','fiscalia','fiscales','elecc','reelecc','voto','macrista','kirchner','bullrich','candidat','ballotage','peronism','macrism','oposicion','campana electoral','formula 1','gran premio','colapinto','futbol','fútbol','jugadores','tenis','rugby','basquet','básquet','olimpic','deportiv','mundial','libertadores','espectaculo','farandula','famosos','television'];
function esOffTopic(t) {
  var n = normalizarTexto(t);
  for (var i = 0; i < OFF_TOPIC.length; i++) { if (n.indexOf(OFF_TOPIC[i]) !== -1) return true; }
  return false;
}

// El widget de bolsillo NO muestra cotizaciones del dólar: hay un widget dedicado
// (flipboard-dolares-bolsa). Se descarta el reporte de cotización, pero SÍ se deja
// pasar una noticia económica que mencione el dólar como causa (inflación, reservas...).
function esCotizacionDolar(t) {
  var n = normalizarTexto(t);
  if (n.indexOf('dolar') === -1 && n.indexOf('dólar') === -1) return false;
  var esReporte = /(cotizaci[oó]n|a cu[aá]nto|cierre|cerr[oó]|abri[oó]|precio del d[oó]lar|valor del d[oó]lar|d[oó]lar hoy|d[oó]lar blue hoy)/.test(n);
  if (!esReporte) return false;
  var esEconomico = /(inflaci[oó]n|salario|sueldo|tarifa|presupuesto|reserva|deuda|fmi|impuesto|paritaria|empleo|desempleo|aumento|suba|impacto|medida|anuncio)/.test(n);
  return !esEconomico;
}

// WHITELIST temático (filtro primario, pre-LLM): un titular entra SOLO si menciona
// algún concepto de consumo-masiva / poder adquisitivo. MÁS RIGUROSO que OFF_TOPIC:
// no deja pasar lo desconocido (ej "fiscalía expuso viajes y consumos de la familia").
// Matching accent-foldeado (NFD) para que "DÓLAR"/"dolar" matcheen.
const ECONOMIA = ['dolar','inflacion','precio','precios','supermercado','super','salario','sueldo','tasa','interes','hipoteca','credito','prestamo','bolsa','merval','accion','tarifa','luz','agua','gas','internet','celular','combustible','nafta','empleo','desempleo','afip','impuesto','ganancia','capital','bcra','bcr','alquiler','vivienda','auto','seguro','pension','jubilacion','prevision','cepo','uva','cer','retail','pasaje','transporte','banco','bancario','ahorro','deposito','plazo fijo','descuento','importacion','exportacion','empresa','empresas','pyme','pymes','mercado','costo','consumo','gasto','remuneracion','nomina','subsidio','arancel','licitacion','obra publica','infraestructura','logistica','suministro','inversion','inversiones','produccion','mano de obra','mayorista','comercio','gremio','mercantil','industria','industrial','paritaria','servicio'];
function esNoticiaEconomica(t) {
  var n = String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u0306\u0308\u0303]/g, '');
  for (var i = 0; i < ECONOMIA.length; i++) { if (n.indexOf(ECONOMIA[i]) !== -1) return true; }
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
// Reparación determinística: si el original trae "N% " y el rewrite dejó el número
// sin el símbolo (ej. "1,6 en octubre" en vez de "1,6% en octubre"), se re-inserta.
function repararPorcentaje(rw, orig) {
  if (!rw || !orig) return rw;
  var out = String(rw);
  var m; var re = /(\d+(?:[.,]\d+)?)\s*%/g;
  while ((m = re.exec(String(orig))) !== null) {
    var num = m[1];
    if (out.indexOf(num + '%') !== -1) continue;
    var reNum = new RegExp('(' + num.replace(/\./g, '\\.') + ')(?![0-9])(\\s+)(?!(%|por ciento))', 'g');
    if (reNum.test(out)) out = out.replace(reNum, '$1%$2');
  }
  return out;
}
function aplicarGuardrail(rewrites, items) {
  return rewrites.map(function (r, i) {
    const item = items[i] || {};
    const ok = ia.validarTitular(r, { titulo: item.titulo, resumen: item.descripcion }, { max: 160, min: 35 });
    return ok ? repararPorcentaje(ok, item.titulo) : null;
  });
}
function delay(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
async function reescribirLote(items) {
  if (!process.env.GEMINI_API_KEY) return items.map(i => tituloDescriptivo(i.titulo, i.descripcion));
  const prompt = 'Reescribí los siguientes titulares en español rioplatense. Para CADA uno escribí un titular DESCRIPTIVO (máximo 2 líneas) que cuente la NOTICIA EN SÍ: un resumen del hecho, usando el titular original y el "resumen" (lead) del artículo como fuente. Tono VXL: informal, como hablás con un amigo al coffee, interés para una persona normal. Prioridad: el título debe ser un DATO económico concreto (precio, %, monto, medida). Conservá EXACTAMENTE los símbolos y unidades del dato tal como aparecen en el original (%, $, u$s, /Tn, puntos, millones): nunca los elimines ni reformatees los números. Si el titular lleva encuadre político-partidista o gancho metafórico (ej. triunfo de, tiene N años, minuto a minuto) y el lead tiene el dato, reescribilo priorizando el DATO económico y sacando el encuadre político. NO inventes, NO ganchos, NO clickbait, NO emojis, NO jergla policial/judicial. Si el resumen está vacío, devolvés el titular original limpio (no inventes). Devolvé SOLO JSON {"rewrites":["título 1","título 2",...]} con la misma cantidad de ítems y orden. Entradas: ' + JSON.stringify(items.map(i => ({ titulo: i.titulo, resumen: i.descripcion })));
  var txt = await ia.pedir(prompt, { maxTokens: 200, temperature: 0.2, timeout: 20000 });
  if (txt) {
    var m = txt.match(/\{[\s\S]*\}/);
    if (m) {
      try { var parsed = JSON.parse(m[0]); if (Array.isArray(parsed.rewrites) && parsed.rewrites.length === items.length) return aplicarGuardrail(parsed.rewrites, items); } catch (e) {}
    }
    try { var p2 = JSON.parse(txt.trim()); if (Array.isArray(p2.rewrites) && p2.rewrites.length === items.length) return aplicarGuardrail(p2.rewrites, items); } catch (e2) {}
  }
  console.warn('[bolsillo] sin reescritura válida (cuota, error o parse): conserva el titular descriptivo');
  return items.map(function () { return null; });
}
// Cache de reescrituras: cada título se reescribe UNA sola vez y se reutiliza.
// Evita quemar la cuota gratuita de Gemini en cada corrida (cron cada 10 min).
const CACHE_FILE = path.join(__dirname, '../data/rewrites-cache.json');
function cargarCacheRewrites() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {}; } catch (e) { return {}; }
}
// Regla de publicación: una noticia sale SOLO con titular reescrito y validado
// (desde cache o por el LLM en esta corrida). Si no hay reescritura (sin key,
// 429, cuota agotada o rechazo del guardarraíl) la noticia se descarta. Nunca
// se publica el titular original de la fuente.
async function reescribirConLLM(items) {
  if (!items.length) return items;
  var cache = cargarCacheRewrites();
  var usados = new Set();
  var validos = new Set();
  var aplicados = 0, rechazados = 0, filtPost = 0, desdeCache = 0;
  var pendientes = [];
  for (var i = 0; i < items.length; i++) {
    // Las que ya vienen del JSON previo con titular reescrito se conservan tal cual.
    if (items[i].titulo_src === 'llm') { validos.add(items[i]); desdeCache++; continue; }
    var k = normalizarTexto(items[i].titulo);
    if (cache[k] && typeof cache[k] === 'string') { items[i].titulo = cache[k]; items[i].titulo_src = 'llm'; usados.add(k); validos.add(items[i]); desdeCache++; }
    else pendientes.push(items[i]);
  }
  if (pendientes.length && !process.env.GEMINI_API_KEY) {
    console.log('[bolsillo] sin GEMINI_API_KEY: no se publican las ' + pendientes.length + ' noticias nuevas');
  }
  for (var b = 0; b < pendientes.length && process.env.GEMINI_API_KEY; b += 25) {
    if (ia.estado().abierto) break;
    var chunk = pendientes.slice(b, b + 25);
    var claves = chunk.map(function (it) { return normalizarTexto(it.titulo); });
    var rw = await reescribirLote(chunk);   // chunk: {titulo, descripcion, ...} -> orig con lead
    for (var j = 0; j < chunk.length; j++) {
      if (rw[j] && typeof rw[j] === 'string' && rw[j].length && !esOffTopic(rw[j])) {
        chunk[j].titulo = rw[j];
        chunk[j].titulo_src = 'llm';
        cache[claves[j]] = rw[j];
        usados.add(claves[j]);
        validos.add(chunk[j]);
        aplicados++;
      } else if (rw[j] && esOffTopic(rw[j])) { filtPost++; }
      else { rechazados++; }
    }
  }
  // podar el cache a las claves vigentes
  var podado = {};
  usados.forEach(function (k) { if (cache[k]) podado[k] = cache[k]; });
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(podado, null, 2));
  } catch (e) { console.warn('[bolsillo] no se pudo guardar cache de rewrites:', e.message); }
  var publicables = items.filter(function (it) { return validos.has(it); });
  console.log('[bolsillo] rewrites LLM nuevos:', aplicados, '| desde cache:', desdeCache, '| rechazados por invención:', rechazados,
    '| filtrados judiciales/post-LLM:', filtPost, '| publicables:', publicables.length, '| total:', items.length);
  return publicables;
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
  let cntGancho = 0, cntOffTopic = 0, cntNoEcon = 0, cntDolar = 0;
  // Lo ya publicado en el JSON anterior cuenta como titular validado, aunque
  // hoy vuelva a aparecer en el feed con otro título o con la misma URL.
  const yaPublicadasTit = new Set(historico.map(n => normalizarTexto(n.titulo)).filter(Boolean));
  const yaPublicadasUrl = new Set(historico.map(n => n.url).filter(Boolean));
  const add = (n) => {
    n.titulo = tituloDescriptivo(n.titulo, n.descripcion);   // <-- usa lead si el headline es vago/gancho
    const k = normalizarTexto(n.titulo);
    if (!n.titulo_src && ((n.url && yaPublicadasUrl.has(n.url)) || yaPublicadasTit.has(k))) n.titulo_src = 'llm';
    if (!k || !n.titulo) return;
    if (esGancho(n.titulo)) { cntGancho++; return; }
    if (esOffTopic(n.titulo)) { cntOffTopic++; return; }
    if (esCotizacionDolar(n.titulo)) { cntDolar++; return; }   // widget de dólar aparte
    if (!esNoticiaEconomica(n.titulo)) { cntNoEcon++; return; }   // whitelist: debe mencionar consumo-masiva
    if (!n.categorias || !n.categorias.length) n.categorias = clasificarNoticia(n.titulo);
    if (merged[k]) { if (parseFechaIso(n.fecha) > parseFechaIso(merged[k].fecha)) merged[k] = n; }
    else { merged[k] = n; }
  };
  for (const n of nuevas) add(n);
  // Los ítems que ya estaban publicados se consideran titulares validados:
  // no se reescriben de nuevo ni se descartan por no tener marca.
  for (const n of historico) { if (!n.titulo_src) n.titulo_src = 'llm'; add(n); }
  console.log('[bolsillo] filtrados gancho:', cntGancho, '| off-topic (policiales/drogas/etc):', cntOffTopic, '| cotización dólar (widget aparte):', cntDolar, '| no-econ (sin término consumo-masiva):', cntNoEcon);
  const todas = Object.values(merged);

  // --- ventana 7 días (más recientes) ---
  const AHORA = Date.now();
  const CORTE_MS = 7 * 24 * 60 * 60 * 1000;
  let recientes = todas.filter(n => {
    const t = parseFechaIso(n.fecha);
    return t > 0 && t >= AHORA - CORTE_MS && t <= AHORA + 60000;
  });
  recientes.sort((a, b) => parseFechaIso(b.fecha) - parseFechaIso(a.fecha)); /* más reciente primero */

  // --- tope por categoría: máx 10 noticias por tag (evita acumulación) ---
  // Se recorre de más reciente a más viejo; una noticia entra si al menos una de
  // sus categorías todavía tiene lugar. Se le quitan los tags ya llenos para que
  // no aparezca en filtros que ya no le corresponden. Se aplica ANTES del LLM
  // para no reescribir noticias que después se van a descartar.
  const MAX_POR_CATEGORIA = 10;
  const conteoCat = {};
  const recortadas = [];
  for (const n of recientes) {
    const disponibles = (n.categorias || []).filter(id => (conteoCat[id] || 0) < MAX_POR_CATEGORIA);
    if (!disponibles.length) continue;
    n.categorias = disponibles;
    disponibles.forEach(id => { conteoCat[id] = (conteoCat[id] || 0) + 1; });
    recortadas.push(n);
  }
  recientes = recortadas;
  console.log('[bolsillo] tope por categoría (máx ' + MAX_POR_CATEGORIA + '): ' + recientes.length + ' noticias — ' + Object.keys(conteoCat).map(id => id + ':' + conteoCat[id]).join(', '));

  recientes = await reescribirConLLM(recientes); /* a voz VXL vía Gemini; sin reescritura no se publica */
  if (!recientes.length) {
    console.warn('[bolsillo] ninguna noticia con titular reescrito: se conserva el JSON anterior');
    return;
  }

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

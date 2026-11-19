// /scripts/update-policial.js
// Corre en GitHub Actions cada 10 minutos.
// Scrapea SOLO noticias policiales del Litoral (Santa Fe + Entre Ríos):
// allanamientos, detenciones, causas judiciales, accidentes y hechos delictivos.
// Nada de política ni economía: eso ya lo cubren otros widgets del sitio.
//
// Salida: data/policial.json  (flat noticias[] dedupeado + categorias[])

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const Parser = require('rss-parser');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const WINDOW_DAYS = 5;
const MAX_ITEMS = 60;

// ---------------------------------------------------------------- categorías
// Orden = prioridad de la etiqueta primaria (la primera que matchea manda).
const CATEGORIAS = [
  {
    id: 'accidentes',
    nombre: 'ACCIDENTES',
    keywords: ['accidente', 'choque', 'colision', 'colisiono', 'vuelco', 'volco', 'siniestro', 'atropell', 'embistio', 'embestido', 'despiste', 'derrape', 'impacto', 'motociclista', 'peatón', 'peaton', 'herido grave', 'fallecio en el acto']
  },
  {
    id: 'allanamientos',
    nombre: 'ALLANAMIENTOS',
    keywords: ['allanamiento', 'allanaron', 'allano', 'secuestraron', 'secuestro de', 'incautaron', 'incautacion', 'decomisaron', 'decomiso', 'procedimiento policial', 'requisa', 'rastrillaje', 'operativo antidroga', 'bunker', 'cocaina', 'marihuana', 'estupefaciente', 'narco', 'droga']
  },
  {
    id: 'detenciones',
    nombre: 'DETENCIONES',
    keywords: ['detuvieron', 'detenido', 'detenida', 'detencion', 'aprehendido', 'aprehendieron', 'capturaron', 'capturado', 'imputado', 'imputaron', 'arrestado', 'arresto domiciliario', 'profugo', 'prision preventiva']
  },
  {
    id: 'causas',
    nombre: 'CAUSAS',
    keywords: ['causa judicial', 'causa penal', 'fiscalia', 'fiscal', 'juicio', 'condena', 'condenado', 'sentencia', 'sobreseimiento', 'sobreseido', 'procesamiento', 'formulacion de cargos', 'elevaron a juicio', 'debate oral', 'investigan', 'investigacion judicial', 'expediente', 'tribunal']
  },
  {
    id: 'hechos',
    nombre: 'HECHOS',
    keywords: ['robo', 'robaron', 'robar', 'asalto', 'asaltaron', 'hurto', 'sustajo', 'agresion', 'agredieron', 'atacaron', 'ataco', 'disparo', 'dispararon', 'balazo', 'crimen', 'homicidio', 'asesinato', 'femicidio', 'abuso', 'violencia de genero', 'amenaza', 'amenazas', 'estafa', 'estafador', 'incendio', 'incendiaron', 'explosion', 'rescate', 'rescataron', 'ahogo', 'ahogado', 'desaparecid', 'buscaban', 'búsqueda', 'arma blanca', 'cuchillo', 'policia', 'policial', 'comisaria', 'movil policial', 'patrulla', 'gendarme', 'prefectura', 'guardia urbana', 'delito', 'delincuente', 'ladron', 'ladrones', 'contrabando', 'trata de personas']
  }
];

// Si el titular es de política o economía, se descarta aunque mencione un delito.
// Estos términos casi nunca aparecen en una crónica policial real.
const POLITICA_ECONOMIA = [
  'elecciones', 'electoral', 'candidato', 'candidata', 'campana electoral', 'diputado', 'diputada', 'senador', 'senadora',
  'concejal', 'concejala', 'legislador', 'legisladora', 'intendente', 'gobernador', 'gobernadora', 'ministro', 'ministra',
  'gobierno', 'pullaro', 'secretario de estado', 'funcionario provincial', 'funcionaria provincial',
  'paritaria', 'aumento salarial', 'inflacion', 'cotizacion del dolar', 'dolar blue', 'valor del dolar', 'tarifas de',
  'impuesto', 'impuestos', 'presupuesto', 'gremio', 'sindicato', 'sindical', 'exportacion', 'exportaciones', 'importacion',
  'importaciones', 'merval', 'pbi', 'deuda externa', 'fmi', 'monotributo', 'jubilacion', 'jubilados', 'pymes',
  'recaudacion', 'coparticipacion', 'canasta basica', 'comercio exterior', 'tipo de cambio'
];

// Notas institucionales de la fuerza (no son noticias policiales de hechos)
const INSTITUCIONAL = [
  'aniversario', 'egresados', 'egresaron', 'cadetes', 'ascensos', 'ascendieron', 'juramento', 'jura de la bandera',
  'capacitacion', 'capacitaron', 'homenaje', 'distincion', 'condecoracion', 'retiro policial', 'cumpleanos de la policia',
  'muestra anual', 'donacion de sangre', 'colecta solidaria', 'campaña de vacunacion'
];

// Otras jurisdicciones: el widget es del Litoral, no un feed nacional de policiales.
// Se buscan como "en <lugar>" / "de <lugar>" para no confundir calles (Bv. Córdoba).
const OTRAS_ZONAS = ['mendoza', 'c[oó]rdoba', 'tucum[aá]n', 'salta', 'jujuy', 'chaco', 'misiones', 'formosa', 'santiago del estero', 'san juan', 'la rioja', 'catamarca', 'neuqu[eé]n', 'r[ií]o negro', 'chubut', 'santa cruz', 'tierra del fuego', 'la pampa', 'san luis', 'mar del plata', 'buenos aires', 'caba', 'capital federal'];
const OTRAS_ZONAS_RX = new RegExp('\\b(?:en|de|desde|hacia)\\s+(?:la\\s+(?:provincia|ciudad)\\s+de\\s+)?(?:' + OTRAS_ZONAS.join('|') + ')\\b', 'i');
// Nombres que no se confunden con calles del Litoral: si aparecen, la nota no es de acá.
const OTRAS_ZONAS_PLAIN = ['mendoza', 'tucuman', 'neuquen', 'bariloche', 'mar del plata', 'la matanza', 'quilmes', 'avellaneda', 'lanus', 'moron', 'san isidro', 'vicente lopez', 'capital federal', 'buenos aires', 'remedios de escalada', 'santiago del estero', 'misiones', 'formosa', 'catamarca', 'la rioja', 'san juan', 'san luis', 'tierra del fuego', 'chubut', 'rio negro', 'la pampa'];
function esOtraZona(t) {
  if (OTRAS_ZONAS_RX.test(t)) return true;
  const n = normalizarTexto(t);
  return OTRAS_ZONAS_PLAIN.some(z => n.indexOf(z) !== -1);
}

const GANCHO = ['viral', 'se hizo viral', 'lleno su', 'hizo viral', 'no creer', 'sorpres', 'imposible', 'increible', 'escandal', 'te vas a', 'no vas a', 'haz click', 'click aqui', 'ver video', 'este video', 'trending', 'sabias que', 'mira esto', 'top 10', 'lista de', 'curiosidad', 'dato curioso', 'no es cuento', 'el secreto de', 'todo cambio', 'minuto a minuto', 'en vivo', 'live', 'impactante', 'estremecedor', 'escalofriante'];

function normalizarTexto(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function limpiarTitulo(t) {
  let n = String(t || '');
  n = n.replace(/[\u{1F300}-\u{1FAFF}]/gu, '');
  n = n.replace(/^\s*(video|mir[aá] el video|video exclusivo|audio)\s*:\s*/i, '');
  n = n.replace(/\s*[-|–]\s*(Elonce\.com|Elonce|El Litoral|An[aá]lisis Digital|APFDigital|APF Digital|Uno Santa Fe|La Capital)\s*$/i, '');
  n = n.replace(/\b(en vivo|live)\b/gi, '');
  n = n.replace(/minuto a minuto/gi, '');
  n = n.replace(/&quot;/g, '"');
  n = n.replace(/\s+/g, ' ').trim();
  n = n.replace(/^[\s.,;:¡?\-_|'"()+«»*]+/, '').trim();
  n = n.replace(/[\s.,;:¡?\-_|'"()+«»*]+$/, '').trim();
  // comillas desbalanceadas por el recorte del HTML
  if ((n.match(/"/g) || []).length % 2 === 1) n = n.replace(/"(?=[^"]*$)/, '').replace(/\s+/g, ' ').trim();
  if (!n) return '';
  n = n.charAt(0).toUpperCase() + n.slice(1);
  if (n.length > 150) n = n.slice(0, 147) + '\u2026';
  return n;
}

function esGancho(t) {
  const n = normalizarTexto(t);
  if (ganchoMatch(n)) return true;
  if (/[!]{2,}/.test(t)) return true;
  return false;
}
function ganchoMatch(n) {
  for (let i = 0; i < GANCHO.length; i++) { if (n.indexOf(GANCHO[i]) !== -1) return true; }
  return false;
}
function esInstitucional(n) {
  for (let i = 0; i < INSTITUCIONAL.length; i++) { if (n.indexOf(normalizarTexto(INSTITUCIONAL[i])) !== -1) return true; }
  return false;
}
function esPoliticaOEconomia(n) {
  for (let i = 0; i < POLITICA_ECONOMIA.length; i++) { if (n.indexOf(normalizarTexto(POLITICA_ECONOMIA[i])) !== -1) return true; }
  return false;
}

// Devuelve los ids de categoría que matchean, en orden de prioridad.
// Cada noticia va a UNA sola categoría (la primera que matchea en el orden de
// CATEGORIAS: accidentes > allanamientos > detenciones > causas > hechos).
// Así los filtros del widget no repiten la misma noticia en dos solapas.
function clasificar(titulo) {
  const n = normalizarTexto(titulo);
  for (const cat of CATEGORIAS) {
    if (cat.keywords.some(kw => n.indexOf(normalizarTexto(kw)) !== -1)) return [cat.id];
  }
  return [];
}

// Localidad mencionada en el titular (sólo el Litoral), para el chip de lugar.
const LUGARES = [
  'Paraná', 'Santa Fe', 'Rosario', 'Concordia', 'Gualeguaychú', 'Colón', 'La Paz', 'Villaguay', 'Victoria', 'Nogoyá',
  'Diamante', 'Crespo', 'Rafaela', 'Reconquista', 'Santo Tomé', 'Esperanza', 'Venado Tuerto', 'San Lorenzo',
  'Gualeguay', 'Federación', 'Chajarí', 'Federal', 'Feliciano', 'Bovril', 'Hasenkamp', 'Seguí', 'María Grande',
  'Cerrito', 'San José', 'Viale', 'Maciá', 'Urdinarrain', 'Ibicuy', 'Ramírez', 'Hernandarias', 'Santa Elena',
  'Villa Elisa', 'Aldea Brasilera', 'San Benito', 'Oro Verde', 'Sauce Montrull', 'Colonia Avellaneda', 'Recreo'
];
function detectarLugar(titulo) {
  const n = normalizarTexto(titulo);
  let mejor = '';
  for (const l of LUGARES) {
    const ln = normalizarTexto(l);
    if (n.indexOf(ln) !== -1 && ln.length > normalizarTexto(mejor).length) mejor = l;
  }
  return mejor;
}

// ---------------------------------------------------------------- scraping
async function get(url) {
  return axios.get(url, {
    timeout: 20000,
    maxRedirects: 5,
    headers: { 'User-Agent': UA, 'Accept-Language': 'es-AR,es;q=0.9', 'Accept': 'text/html,application/xhtml+xml' },
    validateStatus: s => s >= 200 && s < 400
  });
}

function fechaDeUrl(url) {
  const m = String(url || '').match(/\/(20\d{2})\/(\d{2})\/(\d{2})\//);
  if (!m) return null;
  const d = new Date(m[1] + '-' + m[2] + '-' + m[3] + 'T12:00:00-03:00');
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function recortar(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '\u2026' : s; }

function descripcionDeCard($, $card, titulo) {
  let t = $card.find('p, .article__bajada, .bajada, .resumen, .volanta-descripcion')
    .map((i, el) => $(el).text().replace(/\s+/g, ' ').trim())
    .get()
    .filter(x => x.length > 45)
    .join(' ');
  t = t.replace(titulo, '').replace(/\s+/g, ' ').trim();
  return recortar(t, 280);
}

async function scrapeHtml(fuente) {
  const r = await get(fuente.url);
  const $ = cheerio.load(r.data);
  const out = [];
  const vistos = new Set();
  const ahora = new Date().toISOString();
  $('a[href]').each((i, el) => {
    const $a = $(el);
    const href = String($a.attr('href') || '').trim();
    if (!fuente.match.test(href)) return;
    const url = /^https?:/.test(href) ? href : new URL(href, fuente.url).href;
    if (vistos.has(url)) return;
    const $card = $a.closest('article, .card, .listcard, .listcard2, [class*="nota"], [class*="item"]');
    let titulo = ($card.find('h2, h3').first().text() || $a.find('h2, h3').first().text() || $a.attr('aria-label') || '').replace(/\s+/g, ' ').trim();
    if (titulo.length < 25) titulo = $a.text().replace(/\s+/g, ' ').trim();
    if (titulo.length < 25) return;
    if (titulo.length > 200) titulo = titulo.split(/(?<=[.!?])\s/)[0];
    vistos.add(url);
    out.push({
      titulo: limpiarTitulo(titulo),
      descripcion: descripcionDeCard($, $card, titulo),
      url,
      fecha: fechaDeUrl(url) || ahora,
      fuente: fuente.nombre
    });
  });
  return out;
}

async function scrapeElLitoral(fuente) {
  const parser = new Parser({ timeout: 20000 });
  const feed = await parser.parseURL(fuente.url);
  const ahora = new Date().toISOString();
  return (feed.items || []).map(it => ({
    titulo: limpiarTitulo(it.title || ''),
    descripcion: recortar((it.contentSnippet || it.summary || it.content || '').replace(/<[^>]+>/g, ' '), 280),
    url: it.link || '',
    fecha: it.isoDate || (it.pubDate ? new Date(it.pubDate).toISOString() : ahora),
    fuente: fuente.nombre
  })).filter(n => n.titulo.length > 20);
}

const FUENTES = [
  { nombre: 'El Litoral', tipo: 'rss', url: 'https://www.ellitoral.com/rss/sucesos' },
  { nombre: 'Elonce', tipo: 'html', url: 'https://www.elonce.com/secciones/policiales/', match: /^\/policiales\/[a-z0-9-]+\.htm$/i },
  { nombre: 'Análisis Digital', tipo: 'html', url: 'https://www.analisisdigital.com.ar/policiales', match: /^\/(policiales|judiciales)\/20\d{2}\/\d{2}\/\d{2}\/./i },
  { nombre: 'APF Digital', tipo: 'html', url: 'https://www.apfdigital.com.ar/policiales', match: /^\/noticias\/20\d{2}\/\d{2}\/\d{2}\/./i }
];

async function procesarFuente(fuente) {
  try {
    const noticias = fuente.tipo === 'rss' ? await scrapeElLitoral(fuente) : await scrapeHtml(fuente);
    console.log('[POLICIAL] ' + fuente.nombre + ': ' + noticias.length + ' items crudos');
    return noticias;
  } catch (e) {
    console.warn('[POLICIAL] Error en ' + fuente.nombre + ': ' + e.message);
    return [];
  }
}

// ---------------------------------------------------------------- dedupe
const STOP = new Set(['para', 'como', 'sobre', 'entre', 'desde', 'hasta', 'cuando', 'donde', 'tras', 'luego', 'este', 'esta', 'estos', 'estas', 'otro', 'otra', 'habia', 'sera', 'fueron', 'fue', 'son', 'con', 'por', 'del', 'los', 'las', 'una', 'unos', 'unas', 'que', 'sus', 'mas', 'the']);
function tokens(t) {
  return normalizarTexto(t).replace(/[^a-z0-9ñü ]+/g, ' ').split(/\s+/).filter(w => w.length > 3 && !STOP.has(w));
}
function jaccard(a, b) {
  const sa = new Set(tokens(a)); const sb = new Set(tokens(b));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  sa.forEach(x => { if (sb.has(x)) inter++; });
  return inter / (sa.size + sb.size - inter);
}
// Qué tanto de la nota más corta está contenida en la otra: la misma noticia
// publicada por dos medios cambia el titular pero repite los mismos datos.
function containment(a, b) {
  const sa = new Set(tokens(a)); const sb = new Set(tokens(b));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  sa.forEach(x => { if (sb.has(x)) inter++; });
  return inter / Math.min(sa.size, sb.size);
}
// Compara sin números: la misma noticia suele aparecer con cifras distintas
// ("mil metros" vs "1500 metros") en cada portal.
function sinNumeros(t) { return String(t || '').replace(/\d+([.,]\d+)?/g, ' '); }

// Verbos y palabras de acción que cambian entre medios pero no cambian el hecho.
const VERBOS_RUIDO = new Set(['detuvieron','detienen','detuvo','detenido','detenida','aprehendieron','aprehendido',
  'investigan','investiga','investigacion','robaron','robo','robó','asaltaron','atacaron','hirieron','mataron',
  'murio','murió','fallecio','falleció','encontro','encontraron','hallaron','informaron','confirmaron','denunciaron',
  'trasladaron','llevaron','secuestraron','allanaron','imputaron','condenaron','sobreseyeron','ordenaron','salvaron']);
function sustantivos(t) {
  return new Set(tokens(sinNumeros(t)).filter(w => w.length > 4 && !VERBOS_RUIDO.has(w)));
}
// Misma noticia contada distinto: los medios cambian el verbo y la sintaxis, pero
// repiten los mismos sustantivos propios (Copnaf, Concordia, violencia, género).
function sonDuplicadas(a, b) {
  const ta = sinNumeros(a.titulo), tb = sinNumeros(b.titulo);
  if (jaccard(ta, tb) > 0.72) return true;
  const mismoLugar = !a.lugar || !b.lugar || a.lugar === b.lugar;
  if (!mismoLugar) return false;
  const sa = new Set(tokens(ta)), sb = new Set(tokens(tb));
  let inter = 0;
  sa.forEach(x => { if (sb.has(x)) inter++; });
  if (Math.min(sa.size, sb.size) < 4) return false;
  if (inter >= 4 && containment(ta, tb) >= 0.8) return true;
  // segunda pasada: mismos sustantivos (>=3 compartidos, 60% del más corto)
  const na = sustantivos(ta), nb = sustantivos(tb);
  let ni = 0; na.forEach(x => { if (nb.has(x)) ni++; });
  if (ni >= 3 && ni / Math.min(na.size, nb.size) >= 0.4) return true;
  return false;
}

// ---------------------------------------------------------------- reescritura LLM
const GEMINI_MODELOS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'];
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// El presupuesto de salida tiene que alcanzar para TODOS los titulares del lote:
// con maxOutputTokens chico la respuesta se corta, el JSON no parsea y se pierde la reescritura.
async function geminiTexto(prompt, maxTokens) {
  const key = process.env.GEMINI_API_KEY || '';
  if (!key) { console.warn('[policial] GEMINI_API_KEY ausente o vacía (len ' + key.length + ')'); return null; }
  for (const modelo of GEMINI_MODELOS) {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + modelo + ':generateContent?key=' + encodeURIComponent(key);
    try {
      const generationConfig = { temperature: 0.25, maxOutputTokens: maxTokens };
      // 2.5 "piensa" y se come el presupuesto de salida antes de escribir el JSON
      if (modelo.indexOf('2.5') === 0) generationConfig.thinkingConfig = { thinkingBudget: 0 };
      const r = await axios.post(url, {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig
      }, { timeout: 30000, headers: { 'Content-Type': 'application/json' } });
      const t = (r.data && r.data.candidates && r.data.candidates[0] && r.data.candidates[0].content
        && r.data.candidates[0].content.parts && r.data.candidates[0].content.parts[0]
        && r.data.candidates[0].content.parts[0].text) || '';
      console.log('[policial] Gemini ' + modelo + ' OK (' + t.length + ' chars)');
      if (t) return t;
      console.log('[policial] Gemini ' + modelo + ': respuesta vacía (finishReason ' + (r.data && r.data.candidates && r.data.candidates[0] && r.data.candidates[0].finishReason) + ')');
    } catch (e) {
      const detalle = e.response ? (e.response.status + ' ' + JSON.stringify(e.response.data).slice(0, 140)) : e.message;
      console.log('[policial] Gemini ' + modelo + ' falló: ' + detalle);
    }
    await delay(1000);
  }
  return null;
}

// El LLM sólo puede reformular: no puede inventar datos.
// Reglas: (1) todo número del titular reescrito tiene que existir en la fuente;
// (2) como mucho 40% de palabras nuevas (conectores, sinónimos, orden);
// (3) ningún nombre propio nuevo (mayúscula que no esté en la fuente).
function guardrail(rewrites, items) {
  return rewrites.map((r, i) => {
    if (!r || typeof r !== 'string') return null;
    const src = ((items[i] && items[i].titulo) || '') + ' ' + ((items[i] && items[i].descripcion) || '');
    const base = new Set(tokens(src));
    const tl = tokens(r);
    if (!tl.length) return null;
    let dif = 0;
    for (const w of tl) if (!base.has(w)) dif++;
    if (dif / tl.length > 0.4) return null;
    // números inventados (fechas, edades, montos, cantidades)
    const numsSrc = new Set((src.match(/\d+/g) || []));
    for (const num of (r.match(/\d+/g) || [])) if (!numsSrc.has(num)) return null;
    // nombres propios nuevos (se ignoran la primera palabra y las mayúsculas de la fuente)
    const srcWords = new Set(src.split(/\s+/).map(w => w.toLowerCase()));
    const rWords = r.split(/\s+/);
    for (let k = 1; k < rWords.length; k++) {
      const w = rWords[k].replace(/^[¿¡"“«(]+/, '');
      if (/^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}/.test(w) && !srcWords.has(w.toLowerCase())) return null;
    }
    return r;
  });
}

async function reescribirLote(items) {
  if (!process.env.GEMINI_API_KEY) return items.map(() => null);
  const prompt = 'Sos el editor de la sección Policiales de un portal del Litoral argentino. Reescribí cada titular en español rioplatense, claro y directo, como se lo contarías a un amigo: qué pasó, dónde y quién, sin sensacionalismo, sin jerga judicial innecesaria, sin adjetivos grandilocuentes y sin emojis. Usá el titular y el resumen (lead) como única fuente: NO inventes datos, nombres, edades ni cifras. Máximo 110 caracteres por titular, una sola línea, sin punto final. Si el resumen está vacío, devolvé el titular limpio. Devolvé SOLO JSON {"rewrites":["titular 1","titular 2",...]} con la misma cantidad y orden. Entradas: '
    + JSON.stringify(items.map(i => ({ titular: i.titulo, resumen: i.descripcion })));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await delay(4000);
      // presupuesto: ~120 tokens por titular + margen para el JSON
      const txt = await geminiTexto(prompt, 120 * items.length + 300);
      const parsed = extraerJSON(txt);
      if (parsed && Array.isArray(parsed.rewrites) && parsed.rewrites.length === items.length) {
        return guardrail(parsed.rewrites, items);
      }
      if (txt && !parsed) console.log('[policial] LLM texto sin JSON: ' + txt.slice(0, 220));
    } catch (e) {
      if (attempt < 2) await delay(2000);
    }
  }
  console.warn('[policial] LLM sin respuesta válida para un lote de ' + items.length + ' (queda el titular limpio)');
  return items.map(() => null);
}

// Solo se reescriben titulares NUEVOS (los que ya están en el JSON previo conservan
// su versión): así no se quema la cuota gratuita de Gemini en cada corrida de 10 min.
async function reescribirConLLM(items, conocidos) {
  if (!process.env.GEMINI_API_KEY || !items.length) return items;
  const pendientes = items.filter(n => !conocidos.has(normalizarTexto(n.titulo)));
  if (!pendientes.length) { console.log('[policial] LLM: sin titulares nuevos para reescribir'); return items; }
  let aplicados = 0, rechazados = 0;
  for (let i = 0; i < pendientes.length; i += 10) {
    const chunk = pendientes.slice(i, i + 10);
    const rw = await reescribirLote(chunk);
    for (let j = 0; j < chunk.length; j++) {
      const n = limpiarTitulo(rw[j] || '');
      const nn = normalizarTexto(n);
      if (n && !esGancho(n) && !esPoliticaOEconomia(nn) && !esInstitucional(nn)) { chunk[j].titulo = n; aplicados++; }
      else rechazados++;
    }
  }
  console.log('[policial] titulares reescritos con LLM:', aplicados, '| rechazados:', rechazados, '| pendientes:', pendientes.length, '| total:', items.length);
  return items;
}

// El modelo a veces envuelve el JSON en ```json ... ``` o agrega texto alrededor.
// Se limpia y se parsea el primer objeto completo; si no hay, null.
function extraerJSON(txt) {
  if (!txt) return null;
  const t = String(txt).replace(/```json/gi, '').replace(/```/g, '').trim();
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  if (i === -1 || j === -1 || j < i) return null;
  try { return JSON.parse(t.slice(i, j + 1)); } catch (e) { return null; }
}

// ---------------------------------------------------------------- dedupe semántico
// Los portales cuentan el mismo hecho con títulos muy distintos ("Crimen de peón
// rural en Diamante" vs "Caso Jorge Wolf: extorsión, asesinato..."). El parecido
// por palabras no alcanza, así que se le pide al LLM que agrupe los que son el
// mismo hecho. Si falla (sin key, 429, JSON roto), no toca nada: quedan los
// heurísticos de sonDuplicadas().
async function agruparDuplicados(items) {
  if (!process.env.GEMINI_API_KEY || items.length < 2) return items;
  const fmtDia = (f) => String(f || '').slice(0, 10);
  const lista = items.map((n, i) =>
    (i + 1) + '. [' + (n.lugar || 'sin lugar') + ' | ' + fmtDia(n.fecha) + '] ' + n.titulo
  ).join(String.fromCharCode(10));
  const prompt = 'Sos editor de la sección Policiales de un portal del Litoral argentino. '
    + 'Recibís una lista numerada de titulares con [lugar | fecha]. Algunos describen el MISMO hecho con palabras distintas. '
    + 'Agrupá SOLO los que son el mismo hecho: misma localidad (o una sin dato), misma fecha o día siguiente, y mismos protagonistas. '
    + 'Si el lugar o la fecha no coinciden, NO son duplicados. Si dudás, no agrupes. '
    + 'Devolvé SOLO JSON: {"grupos":[[1,5],[2,3]]}. Si no hay duplicados: {"grupos":[]}. '
    + 'Titulares:' + String.fromCharCode(10) + lista;
  const txt = await geminiTexto(prompt, 900);
  const parsed = extraerJSON(txt);
  if (!parsed) { console.log('[policial] dedupe LLM: respuesta sin JSON valido'); return items; }
  const grupos = parsed.grupos;
  if (!Array.isArray(grupos)) return items;

  const descartar = new Set();
  const DIST_MAX_MS = 36 * 60 * 60 * 1000;   // mismo día o al día siguiente
  for (const g of grupos) {
    if (!Array.isArray(g) || g.length < 2 || g.length > 3) continue;
    const idx = g.map(n => parseInt(n, 10) - 1).filter(n => n >= 0 && n < items.length);
    if (idx.length < 2) continue;
    const grupo = idx.map(i => items[i]);
    // guardas: lugar compatible y fechas cercanas
    const lugares = grupo.map(n => n.lugar || '').filter(Boolean);
    if (new Set(lugares).size > 1) continue;
    const fechas = grupo.map(n => parseIso(n.fecha)).filter(t => t > 0);
    if (fechas.length && (Math.max(...fechas) - Math.min(...fechas)) > DIST_MAX_MS) continue;
    // se queda el más reciente (items viene ordenado por fecha)
    for (let k = 1; k < idx.length; k++) descartar.add(idx[k]);
  }
  if (!descartar.size) return items;
  // cordura: si el modelo quiere borrar más de un tercio, se descarta la pasada
  if (descartar.size > Math.ceil(items.length / 3)) {
    console.log('[policial] dedupe LLM descartado por exceso (' + descartar.size + ' de ' + items.length + ')');
    return items;
  }
  const filtrados = items.filter((_, i) => !descartar.has(i));
  console.log('[policial] dedupe LLM: ' + descartar.size + ' repetidos quitados (' + items.length + ' -> ' + filtrados.length + ')');
  return filtrados;
}

// ---------------------------------------------------------------- main
function parseIso(f) { const d = Date.parse(f); return isNaN(d) ? 0 : d; }

async function main() {
  const resultados = await Promise.all(FUENTES.map(procesarFuente));

  const dataFile = path.join(__dirname, '../data/policial.json');
  let historico = [];
  if (fs.existsSync(dataFile)) {
    try {
      const prev = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      if (Array.isArray(prev.noticias)) historico = prev.noticias.slice();
    } catch (e) { console.warn('[policial] no se pudo leer el histórico:', e.message); }
  }

  const merged = {};
  const stats = { gancho: 0, politica: 0, institucional: 0, sinCategoria: 0, ok: 0 };

  const add = (n) => {
    let titulo = limpiarTitulo(n.titulo);
    if (!titulo || titulo.length < 20) return;
    const nn = normalizarTexto(titulo);
    if (esGancho(titulo)) { stats.gancho++; return; }
    if (esInstitucional(nn)) { stats.institucional++; return; }
    if (esOtraZona(titulo)) { stats.otraZona = (stats.otraZona || 0) + 1; return; }
    if (esPoliticaOEconomia(nn)) { stats.politica++; return; }
    let cats = clasificar(titulo);
    if (!cats.length) { stats.sinCategoria++; return; }   // whitelist: sólo policiales
    const item = {
      titulo,
      descripcion: n.descripcion || '',
      url: n.url || '',
      fecha: n.fecha || new Date().toISOString(),
      fuente: n.fuente || '',
      lugar: detectarLugar(titulo),
      categorias: cats
    };
    const k = normalizarTexto(titulo);
    const prev = merged[k];
    if (prev) {
      // misma noticia: conserva la fecha más nueva y la etiqueta más completa
      if (parseIso(item.fecha) > parseIso(prev.fecha)) { merged[k] = Object.assign({}, item, { categorias: Array.from(new Set([].concat(prev.categorias, item.categorias))) }); }
      else prev.categorias = Array.from(new Set([].concat(prev.categorias, item.categorias)));
    } else {
      merged[k] = item;
      stats.ok++;
    }
  };

  for (const lista of resultados) for (const n of lista) add(n);
  for (const n of historico) add(n);

  console.log('[policial] filtrados -> gancho:', stats.gancho, '| política/economía:', stats.politica, '| institucional:', stats.institucional, '| sin tema policial:', stats.sinCategoria, '| válidos nuevos:', stats.ok);

  const ahora = Date.now();
  const corte = WINDOW_DAYS * 24 * 60 * 60 * 1000;
  let items = Object.values(merged).filter(n => {
    const t = parseIso(n.fecha);
    return t > 0 && t >= ahora - corte && t <= ahora + 60 * 60 * 1000;
  });
  items.sort((a, b) => parseIso(b.fecha) - parseIso(a.fecha));

  const conocidos = new Set(historico.map(n => normalizarTexto(n.titulo)));
  await reescribirConLLM(items, conocidos);

  // dedupe semántico vía LLM (solo si entraron titulares nuevos: no gastar cuota
  // en cada corrida de 10 min) + dedupe heurístico final
  const nuevos = items.filter(n => !conocidos.has(normalizarTexto(n.titulo)));
  if (nuevos.length) items = await agruparDuplicados(items);
  const sinDup = [];
  for (const n of items) {
    if (!sinDup.some(k => sonDuplicadas(n, k))) sinDup.push(n);
  }
  items = sinDup.slice(0, MAX_ITEMS);

  // fecha "humana" para debug (el widget calcula el relativo en el cliente)
  for (const n of items) n.lugar = n.lugar || detectarLugar(n.titulo);

  const porCategoria = {};
  for (const cat of CATEGORIAS) porCategoria[cat.id] = { id: cat.id, nombre: cat.nombre, noticias: [] };
  for (const n of items) {
    const prim = n.categorias[0];
    if (porCategoria[prim]) porCategoria[prim].noticias.push({ titulo: n.titulo, fecha: n.fecha, lugar: n.lugar });
  }
  const categoriasOutput = CATEGORIAS
    .map(c => porCategoria[c.id])
    .filter(c => c.noticias.length)
    .map(c => ({ id: c.id, nombre: c.nombre, total: c.noticias.length }));

  const payload = {
    last_updated: new Date().toISOString(),
    timestamp_epoch: Math.floor(Date.now() / 1000),
    total_noticias: items.length,
    window_days: WINDOW_DAYS,
    categorias: categoriasOutput,
    noticias: items
  };

  const outputDir = path.join(__dirname, '../data');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // Nunca dejar el JSON vacío: si el scrape falló, preservar lo que ya había.
  if (!items.length && historico.length) {
    console.warn('[policial] sin noticias nuevas; se conserva el JSON anterior');
    return;
  }
  fs.writeFileSync(path.join(outputDir, 'policial.json'), JSON.stringify(payload, null, 2));
  console.log('[OK] policial.json guardado — ' + items.length + ' noticias (ventana ' + WINDOW_DAYS + 'd)');
  for (const c of categoriasOutput) console.log('  ' + c.nombre + ': ' + c.total);
}

main().catch(e => {
  console.error('[ERROR] Falló el pipeline policial:', e.message);
  process.exit(1);
});

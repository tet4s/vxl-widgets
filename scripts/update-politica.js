// /scripts/update-politica.js
// Corre en GitHub Actions cada 20 minutos.
// Scrapea noticias de POLÍTICA del Litoral + Nación y las clasifica por
// jurisdicción (nacional / santa_fe / entre_rios / corrientes / misiones /
// chaco / formosa) y por categoría (LEYES, OBRAS, GOBIERNO, ELECCIONES).
//
// Salida: data/politica.json  (flat noticias[] dedupeado + categorias[] + jurisdicciones[])
//
// Reglas:
//  - Ningún dato inventado: todo sale del scrape. Si una fuente falla, se
//    conserva el histórico previo de esa jurisdicción (nunca se vacía el JSON).
//  - Fechas: si la fuente expone fecha (RSS/time) se usa; si no, scrape-time.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const Parser = require('rss-parser');
const https = require('https');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const WINDOW_DAYS = 7;
const MAX_ITEMS = 120;

// ---------------------------------------------------------------- jurisdicciones
const JURISDICCIONES = [
  { id: 'nacional',    nombre: 'NACIONAL',    aliases: ['nacion', 'nacional', 'argentina', 'caba', 'capital federal', 'buenos aires', 'congreso', 'senado de la nacion', 'diputados de la nacion'] },
  { id: 'santa_fe',    nombre: 'SANTA FE',    aliases: ['santa fe', 'rosario', 'rafaela', 'reconquista', 'venado tuerto', 'santo tome'] },
  { id: 'entre_rios',  nombre: 'ENTRE RÍOS',  aliases: ['entre rios', 'parana', 'concordia', 'gualeguaychu', 'colon', 'villaguay', 'concepcion del uruguay'] },
  { id: 'corrientes',  nombre: 'CORRIENTES',  aliases: ['corrientes', 'capital correntina', 'goya', 'paso de la patria', 'curuzu cuatia', 'mercedes corrientes'] },
  { id: 'misiones',    nombre: 'MISIONES',    aliases: ['misiones', 'posadas', 'obera', 'eldorado', 'puerto iguazu', 'apostoles'] },
  { id: 'chaco',       nombre: 'CHACO',       aliases: ['chaco', 'resistencia', 'saenz pena', 'presidencia roque'] },
  { id: 'formosa',     nombre: 'FORMOSA',     aliases: ['formosa', 'clorinda', 'pirane', 'el colorado formosa'] }
];

// ---------------------------------------------------------------- categorías
// Orden = prioridad de la etiqueta primaria.
const CATEGORIAS = [
  {
    id: 'leyes',
    nombre: 'LEYES',
    keywords: ['ley', 'leyes', 'ley provincial', 'ley nacional', 'sanciono', 'sancion', 'sancionada', 'sancionado',
      'media sancion', 'proyecto de ley', 'camara de diputados', 'camara de senadores', 'diputados aprobo',
      'senadores aprobo', 'decreto', 'dnu', 'ordenanza', 'reforma constitucional', 'codigo penal', 'codigo procesal',
      'comision de legislacion', 'dictamen', 'promulgo', 'promulgada', 'boletin oficial', 'normativa', 'expediente']
  },
  {
    id: 'obras',
    nombre: 'OBRAS',
    keywords: ['obra publica', 'obras publicas', 'obras viales', 'obras hidricas', 'plan de obras', 'licitacion',
      'licitaciones', 'adjudicacion', 'inauguro', 'inauguraron', 'inauguracion', 'repavimentacion', 'pavimento',
      'asfalto', 'asfaltado', 'acueducto', 'desague', 'cloacas', 'agua potable', 'red de agua', 'hospital',
      'centro de salud', 'viviendas', 'plan de viviendas', 'puente', 'ruta provincial', 'ruta nacional',
      'autovia', 'autopista', 'defensa costera', 'gasoducto', 'dragado', 'nuevo edificio',
      'marcha de obras', 'avanzan las obras', 'ejecuta obras', 'obras en', 'obras de agua', 'obras escolares',
      'obras de saneamiento', 'final de obras', 'bacheo', 'cordón cuneta', 'saneamiento', 'potabilizadora',
      'infraestructura', 'ampliación de escuela', 'nueva escuela', 'jardín de infantes', 'iluminación led'],
    excluir: ['obra de arte', 'obras de arte', 'obras teatrales', 'obra teatral', 'obras literarias', 'obra social',
      'obras sociales', 'mano de obra', 'registro de obras', 'obras musicales']
  },
  {
    id: 'gobierno',
    nombre: 'GOBIERNO',
    keywords: ['gobernador', 'gobernadora', 'vicegobernador', 'intendente', 'intendenta', 'ministro', 'ministra',
      'secretario de estado', 'gabinete', 'jefe de gabinete', 'presupuesto', 'partida', 'coparticipacion',
      'recaudacion', 'alivio fiscal', 'convenio', 'acuerdo con', 'designacion', 'asumio', 'renuncio',
      'consejo provincial', 'paritaria', 'legislatura', 'casa de gobierno', 'sesion ordinaria',
      'apertura de sesiones', 'politica provincial']
  },
  {
    id: 'elecciones',
    nombre: 'ELECCIONES',
    keywords: ['elecciones', 'electoral', 'candidato', 'candidata', 'candidatura', 'campana electoral',
      'interna partidaria', 'sufragio', 'padron electoral', 'boleta unica', 'junta electoral',
      'tribunal electoral', 'precandidato', 'coalicion', 'alianza electoral', 'lista de unidad', 'comicio']
  }
];

// Descarta contenido que no es de política (policiales, deportes, clima, etc.)
const OFF_TOPIC = ['detuvieron', 'allanamiento', 'asesinato', 'homicidio', 'femicidio', 'robo', 'robaron', 'asalto',
  'choque', 'accidente fatal', 'muerto', 'muerte', 'fallecio', 'condena', 'imputado', 'narco', 'droga',
  'futbol', 'liga profesional', 'torneo', 'club atletico', 'superclasico', 'seleccion argentina', 'basquet',
  'rugby', 'tenis', 'clima', 'lluvia', 'temporal', 'sismo', 'incendio', 'horoscopo', 'receta', 'turismo',
  'espectaculo', 'farandula', 'videojuego', 'gta', 'netflix', 'pelicula', 'concierto', 'riesgo pais',
  'merval', 'inflacion', 'supermercado', 'criptomoneda', 'grammy', 'musicos', 'cantante', 'recital'];

const GANCHO = ['viral', 'se hizo viral', 'no creer', 'increible', 'impactante', 'en vivo', 'minuto a minuto',
  'mira', 'te vas a', 'polémico', 'escandalo sexual', 'video', 'encuesta: quien gana', 'sabias que'];
// Títulos-pregunta: no sirven como notificación (no hay nada para clickear).
const PREGUNTA_RX = /^(¿|cu[aá]ndo\b|qui[eé]n\b|d[oó]nde\b|c[oó]mo\b|qu[eé]\b|cu[aá]l\b)/i;

function norm(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function limpiar(t) {
  let n = String(t || '').replace(/\s+/g, ' ').trim();
  // Markdown del proxy: "![Image 12: Titular real](url)" o "Image 12: Titular".
  n = n.replace(/^!?\s*\[?\s*image\s*\d+\s*:\s*/i, '').replace(/^!\[/i, '');
  n = n.replace(/[\u{1F300}-\u{1FAFF}]/gu, '');
  n = n.replace(/\s*[|–-]\s*(El Litoral|Elonce|UNO|La Capital|Diario Época|Territorio Digital|DataChaco|APFDigital|Análisis Digital)\s*$/i, '');
  n = n.replace(/\s+/g, ' ').trim();
  n = n.replace(/^[\s.,;:¡?¿\-_|'"()«»*]+/, '').replace(/[\s.,;:¡?¿\-_|'"()«»*]+$/, '');
  if (!n) return '';
  n = n.charAt(0).toUpperCase() + n.slice(1);
  if (n.length > 170) n = n.slice(0, 167) + '…';
  return n;
}

// ---------------------------------------------------------------- fuentes
// tipo:
//   rss    -> feed RSS/Atom
//   heads  -> h2/h3/h4 de un listado HTML (portales de gobierno y legislaturas)
//   links  -> anchors que matchean `match` (portales de noticias)
const FUENTES = [
  // ---------- NACIONAL
  { nombre: 'Diputados Nación', jur: 'nacional', tipo: 'heads', url: 'https://www.diputados.gob.ar/prensa' },
  { nombre: 'Clarín Política', jur: 'nacional', tipo: 'heads', url: 'https://www.clarin.com/politica/' },
  { nombre: 'La Nación Política', jur: 'nacional', tipo: 'heads', url: 'https://www.lanacion.com.ar/politica/' },
  { nombre: 'Página/12 El País', jur: 'nacional', tipo: 'heads', url: 'https://www.pagina12.com.ar/secciones/el-pais' },

  // ---------- SANTA FE
  { nombre: 'Gobierno de Santa Fe', jur: 'santa_fe', tipo: 'heads', url: 'https://www.santafe.gob.ar/noticias' },
  { nombre: 'El Litoral Política', jur: 'santa_fe', tipo: 'rss', url: 'https://www.ellitoral.com/rss/politica' },

  // ---------- ENTRE RÍOS
  { nombre: 'Diputados Entre Ríos', jur: 'entre_rios', tipo: 'heads', url: 'https://www.hcder.gov.ar/' },
  { nombre: 'Elonce Política', jur: 'entre_rios', tipo: 'links', url: 'https://www.elonce.com/secciones/politica/', match: /^\/politica\/[a-z0-9-]+\.htm$/i },
  { nombre: 'Análisis Digital', jur: 'entre_rios', tipo: 'links', url: 'https://www.analisisdigital.com.ar/', match: /^\/(locales|provinciales|politica)\/20\d{2}\/\d{2}\/\d{2}\/./i },
  { nombre: 'APF Digital', jur: 'entre_rios', tipo: 'links', url: 'https://www.apfdigital.com.ar/', match: /^\/noticias\/20\d{2}\/\d{2}\/\d{2}\/./i },

  // ---------- CORRIENTES
  { nombre: 'Gobierno de Corrientes', jur: 'corrientes', tipo: 'heads', url: 'https://www.corrientes.gob.ar/noticias' },
  { nombre: 'Diputados Corrientes', jur: 'corrientes', tipo: 'heads', url: 'https://www.hcdcorrientes.gov.ar/' },
  { nombre: 'Diario Época', jur: 'corrientes', tipo: 'heads', url: 'https://www.diarioepoca.com/' },

  // ---------- MISIONES
  { nombre: 'Gobierno de Misiones', jur: 'misiones', tipo: 'heads', url: 'https://misiones.gob.ar/noticias/' },
  { nombre: 'Territorio Digital', jur: 'misiones', tipo: 'heads', url: 'https://www.territoriodigital.com/' },
  { nombre: 'El Territorio', jur: 'misiones', tipo: 'heads', url: 'https://www.elterritorio.com.ar/' },

  // ---------- CHACO
  { nombre: 'Gobierno del Chaco', jur: 'chaco', tipo: 'heads', url: 'https://www.chaco.gob.ar/noticias' },
  { nombre: 'Legislatura Chaco', jur: 'chaco', tipo: 'heads', url: 'https://www.legislaturachaco.gov.ar/' },
  { nombre: 'DataChaco', jur: 'chaco', tipo: 'heads', url: 'https://www.datachaco.com/' },

  // ---------- FORMOSA
  { nombre: 'Legislatura Formosa', jur: 'formosa', tipo: 'heads', url: 'https://www.legislaturaformosa.gob.ar/' }
];

// ---------------------------------------------------------------- fetch helpers
const OPCIONES = {
  timeout: 35000,
  maxRedirects: 5,
  responseType: 'text',
  transformResponse: [(d) => d],
  headers: {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'es-AR,es;q=0.9'
  }
};

async function bajar(url) {
  let ultimo;
  for (let intento = 0; intento < 2; intento++) {
    try {
      const res = await axios.get(url, OPCIONES);
      return res.data;
    } catch (e) {
      ultimo = e;
      // Cadena de certificados mal armada en portales de gobierno: un reintento
      // sin verificar TLS (fuente pública, solo lectura).
      if (/certificate|CERT|self.signed/i.test(e.message)) {
        const res = await axios.get(url, { ...OPCIONES, httpsAgent: new https.Agent({ rejectUnauthorized: false }) });
        return res.data;
      }
      // Los runners de Actions están lejos de los servidores argentinos: un
      // timeout suelto no significa fuente caída. Un reintento y listo.
      if (intento === 0) await new Promise(r => setTimeout(r, 2500));
    }
  }
  throw ultimo;
}

// Texto relativo en castellano ("Hace cuatro horas", "Hace más de un día") a fecha ISO.
const NUM_PALABRA = { una: 1, un: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12 };
function fechaRelativa(txt, ahoraMs) {
  const t = norm(txt);
  const m = t.match(/hace\s+(?:m[aá]s de\s+)?(\d{1,2}|[a-z]+)\s*(minutos?|min|horas?|d[ií]as?|semanas?)/i);
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : NUM_PALABRA[m[1]];
  if (!n) return null;
  const u = m[2];
  let ms = n * 60000;
  if (/hora/.test(u)) ms = n * 3600000;
  else if (/d[ií]a/.test(u)) ms = n * 86400000;
  else if (/semana/.test(u)) ms = n * 7 * 86400000;
  return new Date(ahoraMs - ms).toISOString();
}

// Fallback para cuando la fuente bloquea al runner (403 de Cloudflare) o tarda
// demasiado: se pide el texto a r.jina.ai (proxy de lectura, sin API key) y se
// extraen los titulares del markdown. Sólo se usa si el fetch directo falló.
async function bajarViaProxy(url) {
  const res = await axios.get('https://r.jina.ai/' + url, {
    timeout: 50000,
    responseType: 'text',
    transformResponse: [(d) => d],
    headers: { 'User-Agent': UA, 'Accept': 'text/plain' }
  });
  if (typeof res.data !== 'string' || res.data.length < 200) throw new Error('proxy sin contenido');
  return res.data;
}

function parrafoDespues(md, desde) {
  const resto = md.slice(desde, desde + 900).split('\n');
  for (let i = 1; i < resto.length; i++) {
    let l = resto[i].trim();
    if (!l || /^[#*\->|]|^!\[|^\*   \[|^\[/.test(l)) continue;
    l = limpiarResumen(l);
    if (l.length >= 60) return l;
  }
  return '';
}

function scrapeMarkdown(md) {
  const ahoraMs = Date.now();
  const out = [];
  const vistos = new Set();
  const rx = /\[([^\]\n]{25,190})\]\((https?:\/\/[^)\s]+)\)([^\n]*)/g;
  let m;
  while ((m = rx.exec(md)) !== null) {
    const titulo = limpiar(m[1].replace(/[*_]/g, ''));
    if (!titulo || /https?:\/\//i.test(titulo) || /^www\./i.test(titulo)) continue;
    const key = norm(titulo);
    if (vistos.has(key)) continue;
    vistos.add(key);
    const cerca = md.slice(m.index, m.index + 400);
    const fecha = fechaRelativa(m[3], ahoraMs) || fechaRelativa(cerca, ahoraMs) || new Date(ahoraMs).toISOString();
    out.push({ titulo, resumen: parrafoDespues(md, m.index + m[0].length), fecha, url: m[2] });
  }
  return out;
}

function fechaValida(s) {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  const ahora = Date.now();
  if (d.getTime() > ahora + 36 * 3600 * 1000) return null; // fecha futura absurda
  return d.toISOString();
}

const MESES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
function fechaTexto(txt) {
  const t = norm(txt).replace(/[°º]/g, '');
  let m = t.match(/(\d{1,2})\s*(?:\/|-|\s)\s*(\d{1,2})\s*(?:\/|-|\s)\s*(20\d{2})/);
  if (m) return fechaValida(m[3] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0') + 'T12:00:00-03:00');
  m = t.match(/(\d{1,2})\s+de\s+([a-z]+)(?:\s+de|\s+del)?\s+(20\d{2})/);
  if (m && MESES[m[2]]) return fechaValida(m[3] + '-' + String(MESES[m[2]]).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0') + 'T12:00:00-03:00');
  m = t.match(/(\d{1,2})\s+de\s+([a-z]+)/);
  if (m && MESES[m[2]]) {
    const hoy = new Date();
    const d = new Date(hoy.getFullYear() + '-' + String(MESES[m[2]]).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0') + 'T12:00:00-03:00');
    if (d.getTime() > Date.now() + 86400000) d.setFullYear(d.getFullYear() - 1);
    return fechaValida(d.toISOString());
  }
  return null;
}

function limpiarResumen(txt) {
  let n = String(txt || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
  n = n.replace(/\s*(?:leer m[áa]s|ver nota|seguir leyendo|compartir|fuente:.*)$/i, '').trim();
  if (n.length > 400) n = n.slice(0, 397) + '…';
  return n;
}

// ---------------------------------------------------------------- scrapers
async function scrapeRss(fuente) {
  const xml = await bajar(fuente.url);
  if (/^\s*<!doctype html|<html/i.test(xml.slice(0, 200))) throw new Error('la URL devolvió HTML, no RSS');
  const parser = new Parser();
  const feed = await parser.parseString(xml);
  return (feed.items || []).slice(0, 25).map(it => ({
    titulo: limpiar(it.title),
    resumen: limpiarResumen(it.contentSnippet || it.summary || it.description),
    fecha: fechaValida(it.isoDate || it.pubDate) || new Date().toISOString(),
    url: it.link || ''
  }));
}

// Primer párrafo del bloque (el "copete" de la tarjeta). Es lo que permite
// escribir un titular informativo sin salir a buscar cada nota.
function resumenDeBloque($, cont, titulo) {
  let out = '';
  cont.find('p').each((_, p) => {
    if (out) return;
    const t = limpiarResumen($(p).text());
    if (t.length >= 40 && norm(t) !== norm(titulo) && t.length > titulo.length * 0.5) out = t;
  });
  return out;
}

async function scrapeHeads(fuente) {
  const html = await bajar(fuente.url);
  const $ = cheerio.load(html);
  const ahora = new Date().toISOString();
  const out = [];
  $('h1,h2,h3,h4').each((_, el) => {
    const $el = $(el);
    const texto = limpiar($el.text());
    if (texto.length < 30 || texto.length > 190) return;
    const cont = $el.closest('article, li, div');
    const fecha = fechaTexto(cont.find('time, .date, .fecha, .fecha-noticia').first().text() || cont.text().slice(0, 400));
    let url = $el.find('a').attr('href') || $el.closest('a').attr('href') || cont.find('a').first().attr('href') || '';
    if (url && !/^https?:/i.test(url)) {
      try { url = new URL(url, fuente.url).href; } catch (e) { url = ''; }
    }
    out.push({ titulo: texto, resumen: resumenDeBloque($, cont, texto), fecha: fecha || ahora, url });
  });
  return out;
}

async function scrapeLinks(fuente) {
  const html = await bajar(fuente.url);
  const $ = cheerio.load(html);
  const ahora = new Date().toISOString();
  const out = [];
  const vistos = new Set();
  $('a[href]').each((_, el) => {
    const $a = $(el);
    const href = ($a.attr('href') || '').trim();
    if (!fuente.match.test(href)) return;
    const titulo = limpiar($a.text() || $a.attr('title') || $a.find('h2,h3').text());
    if (titulo.length < 30 || titulo.length > 190) return;
    const key = norm(titulo);
    if (vistos.has(key)) return;
    vistos.add(key);
    const cont = $a.closest('article, li, div');
    const fecha = fechaTexto(cont.find('time').first().text() || cont.text().slice(0, 300));
    out.push({ titulo, resumen: resumenDeBloque($, cont, titulo), fecha: fecha || ahora, url: href });
  });
  return out;
}

function mapearFuente(fuente, items) {
  const host = (() => { try { return new URL(fuente.url).hostname; } catch (e) { return ''; } })();
  const oficial = /(^|\.)(gob|gov)\.ar$/.test(host);
  return items.map(it => ({ ...it, jur: fuente.jur, fuente: fuente.nombre, oficial }));
}

async function procesarFuente(fuente) {
  const SOLO_PROXY = process.argv.includes('--proxy-todo');
  try {
    if (SOLO_PROXY) throw new Error('modo --proxy-todo');
    let items = [];
    if (fuente.tipo === 'rss') items = await scrapeRss(fuente);
    else if (fuente.tipo === 'links') items = await scrapeLinks(fuente);
    else items = await scrapeHeads(fuente);
    console.log('[politica] ' + fuente.nombre + ': ' + items.length + ' crudos');
    return mapearFuente(fuente, items);
  } catch (e) {
    // Reintento vía proxy de lectura: resuelve los 403 de Cloudflare contra las
    // IPs de Actions y los hosts argentinos que no responden desde afuera.
    try {
      const md = await bajarViaProxy(fuente.url);
      const items = scrapeMarkdown(md);
      console.log('[politica] ' + fuente.nombre + ' vía proxy: ' + items.length + ' crudos (' + e.message + ')');
      return mapearFuente(fuente, items);
    } catch (e2) {
      console.warn('[politica] ERROR ' + fuente.nombre + ': ' + e.message + ' | proxy: ' + e2.message);
      return [];
    }
  }
}

// ---------------------------------------------------------------- clasificación
// Match por palabra completa: "hospital" ya no matchea "hospitalizada".
const RX_CACHE = new Map();
function coincide(n, kw) {
  const k = norm(kw).trim();
  if (!k) return false;
  let rx = RX_CACHE.get(k);
  if (!rx) {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    rx = new RegExp('(^|[^a-z0-9ñ])' + esc + '(?=$|[^a-z0-9ñ])');
    RX_CACHE.set(k, rx);
  }
  return rx.test(n);
}

function clasificar(titulo) {
  const n = norm(titulo);
  const out = [];
  for (const cat of CATEGORIAS) {
    if (cat.excluir && cat.excluir.some(kw => coincide(n, kw))) continue;
    if (cat.keywords.some(kw => coincide(n, kw))) out.push(cat.id);
  }
  return out;
}

function esOffTopic(n) {
  return OFF_TOPIC.some(kw => coincide(n, kw));
}

// Ruido que no entra ni aunque el título mencione "decreto" o "ley".
const OFF_TOPIC_DURO = ['gta', 'videojuego', 'grammy', 'netflix', 'horoscopo', 'recital', 'futbol'];
function esOffTopicDuro(n) {
  return OFF_TOPIC_DURO.some(kw => coincide(n, kw));
}
function esGancho(n) {
  return GANCHO.some(kw => coincide(n, kw)) || /[!]{2,}/.test(n);
}
// Título que no es una noticia sino el nombre de un documento ("Reglamento de
// Concursos", "Acta Paritaria"): va sin verbo y sin contexto.
function esNombreDeDocumento(titulo) {
  const t = String(titulo || '').trim();
  if (t.length > 60) return false;
  return !/(\b(?:aprob|sancion|present|debate|debati|trat|envi|anunci|inaugur|firm|reclama|rechaz|pide|pidi|logr|avanz|suspend|declar|denunci|confirm|entrega|licit|ejecut|invirti|habilit|remov|asumi|renunci|vet|promulg)\w*)/i.test(t);
}

// Señales de que la noticia es nacional aunque la publique un portal provincial.
const SENALES_NACIONAL = ['milei', 'villarruel', 'casa rosada', 'gobierno nacional', 'congreso de la nacion',
  'senado de la nacion', 'camara de diputados de la nacion', 'diputados nacionales', 'boletin oficial',
  'jefatura de gabinete', 'ministerio de economia', 'presidencia de la nacion', 'palacio sorgente',
  'corte suprema', 'banco central', 'fmi', 'cancilleria', 'senado nacional', 'diputados de la nacion'];

// Señales medias: sólo valen si el título no nombra nada local (y la fuente no es oficial).
const SENALES_NACIONAL_DEBIL = ['senado', 'diputados', 'congreso', 'ley nacional', 'ley de bases', 'casa rosada',
  'presupuesto nacional', 'gobierno de la nacion'];

// Provincias/capitales fuera del Litoral: si el título las nombra, no es noticia local.
const FUERA_LITORAL = ['cordoba', 'mendoza', 'tucuman', 'salta', 'jujuy', 'san juan', 'san luis', 'la rioja',
  'catamarca', 'santiago del estero', 'neuquen', 'rio negro', 'chubut', 'santa cruz', 'tierra del fuego',
  'la pampa', 'mar del plata', 'bahia blanca', 'caba', 'capital federal', 'la plata', 'avellaneda'];

function jurPorTitulo(titulo, jurFuente, oficial) {
  const n = norm(titulo);

  // 1) otra provincia del Litoral nombrada con fuerza -> manda el título.
  //    Desde un portal nacional sólo vale el NOMBRE de la provincia (una nota
  //    "en Rosario" sobre un videojuego no es política santafesina).
  const esNacionalFuente = jurFuente === 'nacional';
  for (const j of JURISDICCIONES) {
    if (j.id === 'nacional' || j.id === jurFuente) continue;
    const aliases = esNacionalFuente ? [j.aliases[0]] : j.aliases;
    const fuerte = aliases.some(a =>
      new RegExp('(^|[^a-z0-9ñ])(?:en|de|desde|hacia|para)\\s+(?:la\\s+(?:provincia|ciudad)\\s+de\\s+)?' + norm(a).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[^a-z0-9ñ])').test(n)
    );
    if (fuerte) return j.id;
  }

  // 2) fuente provincial no oficial + señales nacionales + sin mención local -> nacional.
  //    Un portal puede publicar "El Senado rechazó tratar la ley": eso es nacional.
  //    Los sitios oficiales (gob.ar) no se reasignan: su noticia es de su provincia.
  if (jurFuente !== 'nacional' && !oficial) {
    const jur = JURISDICCIONES.find(j => j.id === jurFuente);
    const mencionaLocal = jur.aliases.some(a => coincide(n, a));
    if (!mencionaLocal && SENALES_NACIONAL.some(s => coincide(n, s))) return 'nacional';
    if (!mencionaLocal && FUERA_LITORAL.some(s => coincide(n, s))) return 'nacional';
  }

  return jurFuente;
}

// En Santa Fe y Entre Ríos el widget sigue el gobierno provincial y la capital.
// Las noticias de otras localidades (Concordia, Rosario, Rafaela...) no entran.
const FOCO_PROVINCIAL = {
  entre_rios: {
    capital: ['parana'],
    otras: ['concordia', 'gualeguaychu', 'colon', 'villaguay', 'concepcion del uruguay', 'chajari',
      'federacion', 'diamante', 'crespo', 'nogoya', 'victoria', 'la paz', 'federal', 'gualeguay',
      'san jose', 'feliciano', 'ramirez', 'macia', 'urdinarrain', 'ibicuy', 'santa elena', 'hernandarias',
      'viale', 'segui', 'maria grande', 'cerrito', 'oro verde', 'san benito', 'colonia avellaneda',
      'aldea brasilera', 'bovril', 'hasenkamp', 'santa anita', 'villa elisa', 'villa paranacito',
      'ceibas', 'basavilbaso', 'rosario del tala', 'larroque', 'enrique carbo', 'santa lucia',
      'san salvador', 'general campos', 'san jaime', 'los conquistadores', 'puerto yrigoyen']
  },
  santa_fe: {
    capital: ['santa fe', 'ciudad de santa fe', 'la capital'],
    otras: ['rosario', 'rafaela', 'reconquista', 'venado tuerto', 'santo tome', 'esperanza', 'san lorenzo',
      'villa gobernador galvez', 'granadero baigorria', 'casilda', 'firmat', 'avellaneda', 'san justo',
      'vera', 'tostado', 'ceres', 'sunchales', 'canada de gomez', 'rufino', 'perez', 'funes', 'roldan',
      'carcarana', 'puerto general san martin', 'san cristobal', 'coronda', 'galvez', 'san genaro',
      'pilar', 'teodelina', 'las parejas', 'las rosas', 'totoras', 'serodino', 'sao tome', 'calchaqui',
      'pueblo esther', 'alvear', 'arroyo seco', 'villa constitucion', 'fray luis beltran',
      'capitan bermudez', 'san jerónimo norte', 'monte vera', 'sauce viejo', 'san jose del rincon',
      'laguna paiva', 'san carlos centro', 'humboldt', 'progreso', 'sastre', 'el trebol', 'lehmann',
      'san vicente', 'ramona', 'bella italia', 'maria juana', 'san jorge', 'castellanos', 'susana']
  }
};

function esOtraLocalidad(titulo, jur) {
  const foco = FOCO_PROVINCIAL[jur];
  if (!foco) return false;
  const n = norm(titulo);
  if (foco.capital.some(c => coincide(n, c))) return false;
  for (const loc of foco.otras) {
      const esc = norm(loc).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp('(^|[^a-z0-9ñ])(?:en|de|desde|hacia|para|con|ante)\\s+' + esc + '(?=$|[^a-z0-9ñ])').test(n)) return true;
      if (new RegExp('^' + esc + '(?=$|[^a-z0-9ñ])').test(n)) return true;
    }
  return false;
}

// Se llama después de asignar jurisdicción: devuelve true si la noticia es de
// una localidad que no seguimos.
function fueraDeFoco(titulo, jur) {
  return esOtraLocalidad(titulo, jur);
}
const STOP = new Set(['para', 'como', 'sobre', 'entre', 'desde', 'hasta', 'cuando', 'donde', 'tras', 'luego', 'este', 'esta', 'estos', 'estas', 'otro', 'otra', 'fueron', 'fue', 'son', 'con', 'por', 'del', 'los', 'las', 'una', 'unos', 'unas', 'que', 'sus', 'mas', 'tras', 'sus']);
function tokens(t) {
  return norm(t).replace(/[^a-z0-9ñü ]+/g, ' ').split(/\s+/).filter(w => w.length > 3 && !STOP.has(w));
}
function jaccard(a, b) {
  const sa = new Set(tokens(a)); const sb = new Set(tokens(b));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
}

// ---------------------------------------------------------------- titulares informativos
// El titular del widget no puede ser un gancho: tiene que contar la noticia.
// Fuente: título + copete (lead). Primero se reescribe con LLM; si no hay key o
// falla, sale un titular armado con el copete (nunca queda solo el gancho).
const delay = ms => new Promise(r => setTimeout(r, ms));

async function resumenDeNota(url) {
  try {
    const html = await bajar(url);
    const $ = cheerio.load(html);
    const meta = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '';
    let r = limpiarResumen(meta);
    if (r.length < 60) {
      const p = limpiarResumen($('article p, .article-body p, .nota p, main p').first().text());
      if (p.length > r.length) r = p;
    }
    return r.length >= 60 ? r : '';
  } catch (e) { return ''; }
}

async function enriquecerResumen(noticias) {
  const faltan = noticias.filter(n => (!n.resumen || n.resumen.length < 60) && n.url).slice(0, 45);
  if (!faltan.length) return 0;
  let ok = 0;
  const CONC = 5;
  for (let i = 0; i < faltan.length; i += CONC) {
    const lote = faltan.slice(i, i + CONC);
    const res = await Promise.all(lote.map(n => resumenDeNota(n.url)));
    res.forEach((r, idx) => { if (r) { lote[idx].resumen = r; ok++; } });
  }
  console.log('[politica] copetes recuperados de la nota: ' + ok + '/' + faltan.length);
  return ok;
}

const GEMINI_MODELOS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
async function geminiTexto(prompt, maxTokens) {
  const key = process.env.GEMINI_API_KEY || '';
  if (!key) return null;
  for (const modelo of GEMINI_MODELOS) {
    try {
      const generationConfig = { temperature: 0.25, maxOutputTokens: maxTokens };
      if (modelo.indexOf('2.5') === 0) generationConfig.thinkingConfig = { thinkingBudget: 0 };
      const r = await axios.post(
        'https://generativelanguage.googleapis.com/v1beta/models/' + modelo + ':generateContent?key=' + encodeURIComponent(key),
        { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig },
        { timeout: 45000, headers: { 'Content-Type': 'application/json' } }
      );
      const cand = r.data && r.data.candidates && r.data.candidates[0];
      const txt = cand && cand.content && cand.content.parts && cand.content.parts.map(p => p.text || '').join('') || '';
      if (txt.trim()) return txt;
    } catch (e) {
      console.warn('[politica] gemini ' + modelo + ': ' + e.message);
    }
  }
  return null;
}

const PROMPT_TITULARES = 'Sos editor de la sección Política de un portal del Litoral argentino. ' +
  'Para cada noticia escribí UN titular informativo en español rioplatense que se entienda sin abrir la nota: ' +
  'qué pasó, qué ley/proyecto/obra es, quién lo hizo y en qué estado está (presentado, con dictamen, media sanción, aprobado, promulgado, inaugurado). ' +
  'Nada de ganchos, preguntas, citas sueltas, "mirá", "así fue", "qué dijo", "video" ni suspenso: no hay link para hacer clic. ' +
  'Largo libre entre 70 y 220 caracteres; si el hecho se cuenta en 80, no lo estires. Una sola oración (o dos cortas), sin punto final, sin emojis. ' +
  'Usá SOLO el titular y el copete provistos: no inventes nombres, cifras, fechas ni estados que no estén ahí. ' +
  'Si el copete está vacío, devolvé el titular original limpio, sin agregar nada. ' +
  'Devolvé SOLO JSON {"titulares":["...","..."]} con la misma cantidad y orden. Entradas: ';

function tokensSignificativos(t) {
  return new Set(norm(t).replace(/[^a-z0-9ñ ]+/g, ' ').split(/\s+/).filter(w => w.length > 4));
}

function guardrailTitular(nuevo, item) {
  let n = limpiar(String(nuevo || '').replace(/^["“”']|["“”']$/g, ''));
  if ((n.match(/"/g) || []).length % 2 === 1) n = n.replace(/"/g, '').replace(/\s+/g, ' ').trim();
  if (n.length < 45 || n.length > 260) return null;
  if (/[!?¿¡]{1,}/.test(n)) return null;
  if (/[\u{1F300}-\u{1FAFF}]/u.test(n)) return null;
  if (/(mir[aá]|no te lo pierdas|no vas a creer|as[ií] fue|qu[eé] dijo|video|en vivo|minuto a minuto|imperdible)/i.test(n)) return null;
  if (/\.\.\.|…$/.test(n)) return null;
  // anti-invención: al menos 2 palabras "de contenido" en común con título o copete
  const fuente = tokensSignificativos(item.titulo + ' ' + (item.resumen || ''));
  const propios = Array.from(tokensSignificativos(n));
  const comunes = propios.filter(w => fuente.has(w)).length;
  if (!propios.length || comunes < Math.min(2, Math.max(1, Math.floor(propios.length * 0.2)))) return null;
  return n;
}

async function reescribirLote(items) {
  const prompt = PROMPT_TITULARES + JSON.stringify(items.map(i => ({ titular: i.titulo, copete: (i.resumen || '').slice(0, 400) })));
  for (let attempt = 0; attempt < 3; attempt++) {
    const txt = await geminiTexto(prompt, 160 * items.length + 300);
    if (txt) {
      const m = txt.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          const parsed = JSON.parse(m[0]);
          if (Array.isArray(parsed.titulares) && parsed.titulares.length === items.length) return parsed.titulares;
        } catch (e) { /* sigue */ }
      }
    }
    await delay(2500);
  }
  return items.map(() => null);
}

// Titular sin LLM: si el original es gancho, manda el copete; si no, título + copete.
const ES_GANCHO_TITULAR = /^(¿|"|“)|qu[eé] dijo|as[ií] fue|mir[aá]|en vivo|video|qui[eé]n es|cu[aá]ndo|d[oó]nde|\?$|\.\.\.$|^.{3,60}:\s*[“"]/i;

// Corta sin dejar una frase colgando: prefiere el último punto, después coma.
function recortarOracion(txt, max) {
  const t = String(txt || '').trim();
  if (t.length <= max) return t;
  const corte = t.slice(0, max);
  const p = Math.max(corte.lastIndexOf('. '), corte.lastIndexOf('; '));
  if (p > max * 0.55) return corte.slice(0, p).trim();
  const c = corte.lastIndexOf(', ');
  if (c > max * 0.6) return corte.slice(0, c).trim();
  return corte.replace(/[,;\s]\S*$/, '').trim();
}

function titularHeuristico(titulo, resumen) {
  const t = limpiar(titulo).replace(/\s*[|–-]\s*[^|–-]{2,25}$/, '');
  if (!resumen || resumen.length < 60) return t;
  const oracion = limpiarResumen(resumen.split(/(?<=[.!?])\s+/)[0] || resumen);
  if (oracion.length < 40) return t;
  const nt = norm(t).slice(0, 45);
  const no = norm(oracion).slice(0, 45);
  if (nt && no && (no.indexOf(nt) !== -1 || nt.indexOf(no) !== -1)) return t;
  if (ES_GANCHO_TITULAR.test(t) || t.length < 70) {
    const out = oracion.replace(/^[a-záéíóúñ]/, c => c.toUpperCase());
    return recortarOracion(out, 250);
  }
  return recortarOracion(t.replace(/[.\s]+$/, '') + '. ' + oracion, 250);
}

// Después de reescribir, dos notas de fuentes distintas pueden quedar con el mismo
// titular: se deja la primera (más vieja) y se unen las categorías.
function dedupeTitulosInfo(noticias) {
  const out = [];
  for (const n of noticias) {
    let dup = false;
    for (const o of out) {
      if (!o.titulo_info || !n.titulo_info) continue;
      if (jaccard(o.titulo_info, n.titulo_info) > 0.72) {
        o.categorias = Array.from(new Set([...o.categorias, ...n.categorias]));
        if (new Date(n.fecha) < new Date(o.fecha)) o.fecha = n.fecha;
        dup = true;
        break;
      }
    }
    if (!dup) out.push(n);
  }
  return out;
}

async function reescribirInformativos(noticias, previos) {
  let reusados = 0;
  const pendientes = [];
  for (const n of noticias) {
    const prev = previos.get(norm(n.titulo));
    if (prev && prev.length > 55) { n.titulo_info = prev; n.titulo_info_src = 'llm'; reusados++; }
    else pendientes.push(n);
  }
  console.log('[politica] titulares ya reescritos (reuso): ' + reusados + ' | pendientes: ' + pendientes.length);

  if (pendientes.length && process.env.GEMINI_API_KEY) {
    for (let i = 0; i < pendientes.length; i += 8) {
      const chunk = pendientes.slice(i, i + 8);
      const rw = await reescribirLote(chunk);
      for (let j = 0; j < chunk.length; j++) {
        const ok = guardrailTitular(rw[j], chunk[j]);
        if (ok) { chunk[j].titulo_info = ok; chunk[j].titulo_info_src = 'llm'; }
      }
      await delay(1500);
    }
  } else if (pendientes.length) {
    console.log('[politica] sin GEMINI_API_KEY: titulares armados con el copete');
  }

  let heuristicos = 0;
  for (const n of pendientes) {
    if (!n.titulo_info) { n.titulo_info = titularHeuristico(n.titulo, n.resumen); n.titulo_info_src = 'heuristico'; heuristicos++; }
  }
  console.log('[politica] titulares: ' + (pendientes.length - heuristicos) + ' con LLM, ' + heuristicos + ' heuristicos, ' + reusados + ' reusados');
  return noticias;
}

// ---------------------------------------------------------------- orden
// Las fuentes sin fecha propia comparten el minuto del scrape. Dentro de ese
// minuto se intercala por jurisdicción para que el lateral no muestre 10
// noticias nacionales seguidas antes de la primera provincial.
function mezclarPorMinuto(lista) {
  var out = [];
  var i = 0;
  while (i < lista.length) {
    var minuto = String(lista[i].fecha).slice(0, 16);
    var grupo = [];
    while (i < lista.length && String(lista[i].fecha).slice(0, 16) === minuto) grupo.push(lista[i++]);
    var porJur = {};
    grupo.forEach(function (it) { (porJur[it.jurisdiccion] = porJur[it.jurisdiccion] || []).push(it); });
    var orden = Object.keys(porJur);
    var k = 0;
    var quedan = true;
    while (quedan) {
      quedan = false;
      for (var j = 0; j < orden.length; j++) {
        if (porJur[orden[j]][k]) { out.push(porJur[orden[j]][k]); quedan = true; }
      }
      k++;
    }
  }
  return out;
}

// ---------------------------------------------------------------- main
async function main() {
  const resultados = await Promise.all(FUENTES.map(procesarFuente));
  const crudos = resultados.flat();

  const dataFile = path.join(__dirname, '../data/politica.json');
  let historico = [];
  if (fs.existsSync(dataFile)) {
    try {
      const prev = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      if (Array.isArray(prev.noticias)) historico = prev.noticias.slice();
      console.log('[politica] histórico previo: ' + historico.length);
    } catch (e) { console.warn('[politica] histórico ilegible: ' + e.message); }
  }

  const limite = Date.now() - WINDOW_DAYS * 86400000;
  const stats = { offTopic: 0, gancho: 0, sinCategoria: 0, corto: 0, localidad: 0, ok: 0 };
  const porTitulo = new Map();

  function agregar(item, esNuevo) {
      const titulo = limpiar(item.titulo);
      if (!titulo || titulo.length < 30) { stats.corto++; return; }
      // Algunos listados devuelven la URL como "titular" (pasa con el proxy).
      if (/https?:\/\//i.test(titulo) || /^www\./i.test(titulo)) { stats.corto++; return; }
      const n = norm(titulo);
            if (esGancho(n) || PREGUNTA_RX.test(titulo)) { stats.gancho++; return; }
            if (esNombreDeDocumento(titulo)) { stats.corto++; return; }
    if (esOffTopicDuro(n)) { stats.offTopic++; return; }
    const cats = clasificar(titulo);
    if (!cats.length) { stats.sinCategoria++; return; }
    if (esOffTopic(n) && !cats.includes('leyes') && !cats.includes('obras')) { stats.offTopic++; return; }

    const jur = jurPorTitulo(titulo, item.jurisdiccion || item.jur || 'nacional', item.oficial);
    if (fueraDeFoco(titulo, jur)) { stats.localidad++; return; }
    const fecha = item.fecha || new Date().toISOString();
    if (new Date(fecha).getTime() < limite) return;

    // Noticias viejas colgadas de menús (ej. "Apertura de Sesiones ... 1° de Marzo de 2026")
    const anioActual = new Date().getFullYear();
    const anios = (titulo.match(/\b20\d{2}\b/g) || []).map(Number).filter(y => y < anioActual);
    if (anios.length && !/balance|desde|hace|aniversario|historico|repaso/i.test(n)) return;

    // Fecha explícita en el título: si es vieja, la noticia ya no es novedad.
    const fechaTitulo = fechaTexto(titulo);
    if (fechaTitulo && Date.now() - new Date(fechaTitulo).getTime() > 25 * 86400000) return;

    const plano = n.replace(/[^a-z0-9ñ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const key = plano;
    const previo = porTitulo.get(key);
    if (previo) {
      // La fecha de una notificación es la PRIMERA vez que la vimos:
      // así "hace 3 hs" no se reinicia en cada corrida del scraper.
      previo.categorias = Array.from(new Set([...(previo.categorias || []), ...cats]));
      if (new Date(fecha) < new Date(previo.fecha)) previo.fecha = fecha;
      return;
    }

    // dedupe difuso contra lo ya aceptado
        const prefijo = plano.slice(0, 55);
        for (const otro of porTitulo.values()) {
          const planoOtro = norm(otro.titulo).replace(/[^a-z0-9ñ]+/g, ' ').replace(/\s+/g, ' ').trim();
          const mismoArranque = prefijo.length > 40 && planoOtro.slice(0, 55) === prefijo;
          if (mismoArranque || jaccard(titulo, otro.titulo) > 0.82) {
        otro.categorias = Array.from(new Set([...otro.categorias, ...cats]));
        if (new Date(fecha) < new Date(otro.fecha)) otro.fecha = fecha;
        return;
      }
    }

    porTitulo.set(key, {
          titulo,
          resumen: item.resumen || '',
          titulo_info: item.titulo_info || '',
          titulo_info_src: item.titulo_info_src || '',
          fecha,
          jurisdiccion: jur,
          categorias: cats,
          url: item.url || '',
          fuente: item.fuente || ''
        });
        stats.ok++;
      }

      // 1) primero lo fresco del scrape, 2) después el histórico (para conservar
      //    noticias de fuentes que hoy fallaron)
      crudos.forEach(it => agregar(it, true));
      historico.forEach(it => agregar({ ...it, jurisdiccion: it.jurisdiccion }, false));

      const noticias = mezclarPorMinuto(Array.from(porTitulo.values())
        .sort((a, b) => new Date(b.fecha) - new Date(a.fecha)))
        .slice(0, MAX_ITEMS);

      // Si TODO falló y el histórico tampoco sirve, no se pisa el JSON bueno.
      if (!noticias.length) {
        console.error('[politica] sin noticias: se conserva el JSON anterior');
        process.exit(0);
      }

      // Titulares que se entiendan sin abrir la nota: copete -> LLM -> heurístico.
      await enriquecerResumen(noticias);
      const previos = new Map();
      historico.forEach(h => { if (h.titulo && h.titulo_info && h.titulo_info_src === 'llm') previos.set(norm(h.titulo), h.titulo_info); });
      await reescribirInformativos(noticias, previos);
      const sinDuplicados = dedupeTitulosInfo(noticias);
            noticias.length = 0;
            noticias.push(...sinDuplicados.map(n => ({ ...n })));
            // Saneo final: comillas desparejas en titulares que vienen de versiones viejas
                  for (const n of noticias) {
                    let t = n.titulo_info || n.titulo;
                    if ((t.match(/"/g) || []).length % 2 === 1) t = t.replace(/"/g, '').replace(/\s+/g, ' ').trim();
                    n.titulo_info = t;
                  }
                  // El titular reescrito puede nombrar una localidad que el original no decía
                  // ("Pullaro inauguró un jardín en Pueblo Esther"): se filtra también acá.
                  const enFoco = noticias.filter(n => !fueraDeFoco(n.titulo_info || n.titulo, n.jurisdiccion));
                  if (enFoco.length) {
                    noticias.length = 0;
                    noticias.push(...enFoco);
                  }

  const categorias = CATEGORIAS.map(c => ({
    id: c.id,
    nombre: c.nombre,
    total: noticias.filter(n => n.categorias.includes(c.id)).length
  }));
  const jurisdicciones = JURISDICCIONES.map(j => ({
    id: j.id,
    nombre: j.nombre,
    total: noticias.filter(n => n.jurisdiccion === j.id).length
  }));

  const salida = {
    last_updated: new Date().toISOString(),
    timestamp_epoch: Math.floor(Date.now() / 1000),
    total_noticias: noticias.length,
    window_days: WINDOW_DAYS,
    categorias,
    jurisdicciones,
    noticias
  };

  fs.writeFileSync(dataFile, JSON.stringify(salida, null, 2) + '\n', 'utf8');
  console.log('[politica] OK ' + noticias.length + ' noticias | ' + JSON.stringify(stats));
  console.log('[politica] por jurisdicción: ' + jurisdicciones.map(j => j.id + '=' + j.total).join(', '));
  console.log('[politica] por categoría: ' + categorias.map(c => c.id + '=' + c.total).join(', '));
}

main().catch(e => {
  console.error('[politica] FALLO: ' + e.message);
  process.exit(1);
});
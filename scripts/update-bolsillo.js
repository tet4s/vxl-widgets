// /scripts/update-bolsillo.js
// Corre en GitHub Actions cada 30 minutos.
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
      const titulo = $el.text().trim();
      const link = $el.attr('href') || $el.closest('a').attr('href') || '';
      if (titulo.length > 15 && !titulosVistos.has(titulo)) {
        titulosVistos.add(titulo);
        const categorias = clasificarNoticia(titulo);
        if (categorias.length > 0) {
          noticias.push({
            titulo: titulo,
            descripcion: '',
            url: link.startsWith('http') ? link : fuente.url.replace(/\/$/, '') + '/' + link.replace(/^\//, ''),
            fecha: new Date().toISOString(),
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
  const add = (n) => {
    const k = normalizarTexto(n.titulo);
    if (!k || !n.titulo) return;
    if (!n.categorias || !n.categorias.length) n.categorias = clasificarNoticia(n.titulo);
    if (merged[k]) { if (parseFechaIso(n.fecha) > parseFechaIso(merged[k].fecha)) merged[k] = n; }
    else { merged[k] = n; }
  };
  for (const n of nuevas) add(n);
  for (const n of historico) add(n);
  const todas = Object.values(merged);

  // --- ventana 7 días (más recientes) ---
  const AHORA = Date.now();
  const CORTE_MS = 7 * 24 * 60 * 60 * 1000;
  let recientes = todas.filter(n => {
    const t = parseFechaIso(n.fecha);
    return t > 0 && t >= AHORA - CORTE_MS && t <= AHORA + 60000;
  });
  recientes.sort((a, b) => parseFechaIso(b.fecha) - parseFechaIso(a.fecha)); /* más reciente primero */

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

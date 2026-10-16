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

async function main() {
  const resultados = await Promise.all(FUENTES.map(f => procesarFuente(f)));
  const todasLasNoticias = [];
  const titulosVistos = new Set();
  for (const noticias of resultados) {
    for (const n of noticias) {
      const key = normalizarTexto(n.titulo);
      if (!titulosVistos.has(key)) {
        titulosVistos.add(key);
        todasLasNoticias.push(n);
      }
    }
  }
  const porCategoria = {};
  for (const cat of CATEGORIAS) { porCategoria[cat.id] = []; }
  for (const n of todasLasNoticias) {
    for (const catId of n.categorias) {
      if (porCategoria[catId]) {
        porCategoria[catId].push({
          titulo: n.titulo,
          descripcion: n.descripcion,
          url: n.url,
          fecha: n.fecha,
          fechaFormateada: formatearFecha(n.fecha),
          fuente: n.fuente
        });
      }
    }
  }
  const categoriasOutput = [];
  for (const cat of CATEGORIAS) {
    const noticias = porCategoria[cat.id];
    if (noticias.length > 0) {
      categoriasOutput.push({ id: cat.id, nombre: cat.nombre, noticias: noticias.slice(0, 5) });
    }
  }
  // Formato de salida: alertas (para la maqueta del front)
  // Cada alerta es la noticia más reciente de cada categoría
  const alertas = [];
  for (const cat of CATEGORIAS) {
    const noticias = porCategoria[cat.id];
    if (noticias.length > 0) {
      const n = noticias[0]; // la más reciente
      alertas.push({
        titulo: n.titulo,
        impacto: cat.nombre,
        tiempo: n.fechaFormateada,
        url: n.url,
        fuente: n.fuente
      });
    }
  }

  const payload = {
    last_updated: new Date().toISOString(),
    timestamp_epoch: Math.floor(Date.now() / 1000),
    total_noticias: todasLasNoticias.length,
    categorias: categoriasOutput,
    alertas: alertas
  };
  const outputDir = path.join(__dirname, '../data');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'bolsillo.json'), JSON.stringify(payload, null, 2));
  console.log('[OK] bolsillo.json guardado — ' + todasLasNoticias.length + ' noticias, ' + categoriasOutput.length + ' categorías activas');
  for (const cat of categoriasOutput) {
    console.log('  ' + cat.nombre + ': ' + cat.noticias.length + ' noticias');
  }
}

main().catch(e => {
  console.error('[ERROR] Falló el pipeline de bolsillo:', e.message);
  process.exit(1);
});

// /scripts/update-bolsillo.js
// Corre en GitHub Actions cada 30 minutos.
// Obtiene noticias de RSS feeds de noticias argentinas y las clasifica
// en 4 categorías: PODER ADQUISITIVO, SERVICIOS Y HOGAR, CONSUMO MASIVO, GOBIERNO.
// La categoría GOBIERNO es opcional: solo aparece si hay noticias.

const fs = require('fs');
const path = require('path');
const Parser = require('rss-parser');

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

const FUENTES_RSS = [
  { nombre: 'Clarín', url: 'https://www.clarin.com/rss/' },
  { nombre: 'La Nación', url: 'https://www.lanacion.com.ar/arcio/rss/' },
  { nombre: 'Página/12', url: 'https://www.pagina12.com.ar/rss/' },
  { nombre: 'Infobae', url: 'https://www.infobae.com/feeds/rss/' },
  { nombre: 'El Litoral (Santa Fe)', url: 'https://www.ellitoral.com/rss/' },
  { nombre: 'El Entre Ríos', url: 'https://www.elentrerios.com/rss/' },
  { nombre: 'Rosario3', url: 'https://www.rosario3.com/rss/' },
  { nombre: 'El Día (La Plata)', url: 'https://www.eldia.com/rss/' }
];

function normalizarTexto(texto) {
  return (texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function clasificarNoticia(titulo, descripcion) {
  const texto = normalizarTexto(titulo + ' ' + descripcion);
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
  } catch {
    return '';
  }
}

async function procesarFuente(parser, fuente) {
  try {
    const feed = await parser.parseURL(fuente.url);
    const noticias = [];
    for (const item of feed.items.slice(0, 20)) {
      const titulo = item.title || '';
      const descripcion = item.contentSnippet || item.content || item.summary || '';
      const categorias = clasificarNoticia(titulo, descripcion);
      if (categorias.length > 0) {
        noticias.push({
          titulo: titulo.trim(),
          descripcion: descripcion.trim().slice(0, 200),
          url: item.link || '',
          fecha: item.pubDate || item.isoDate || '',
          fuente: fuente.nombre,
          categorias
        });
      }
    }
    console.log('[RSS] ' + fuente.nombre + ': ' + noticias.length + ' noticias relevantes de ' + feed.items.length);
    return noticias;
  } catch (e) {
    console.warn('[RSS] Error en ' + fuente.nombre + ': ' + e.message);
    return [];
  }
}

async function main() {
  const parser = new Parser({
    timeout: 10000,
    headers: { 'User-Agent': 'VXL-Widgets/1.0' }
  });

  const resultados = await Promise.all(
    FUENTES_RSS.map(f => procesarFuente(parser, f))
  );

  const todasLasNoticias = [];
  const urlsVistas = new Set();
  for (const noticias of resultados) {
    for (const n of noticias) {
      if (!urlsVistas.has(n.url)) {
        urlsVistas.add(n.url);
        todasLasNoticias.push(n);
      }
    }
  }

  todasLasNoticias.sort((a, b) => {
    const fa = new Date(a.fecha).getTime() || 0;
    const fb = new Date(b.fecha).getTime() || 0;
    return fb - fa;
  });

  const porCategoria = {};
  for (const cat of CATEGORIAS) {
    porCategoria[cat.id] = [];
  }
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
      categoriasOutput.push({
        id: cat.id,
        nombre: cat.nombre,
        noticias: noticias.slice(0, 5)
      });
    }
  }

  const payload = {
    last_updated: new Date().toISOString(),
    timestamp_epoch: Math.floor(Date.now() / 1000),
    total_noticias: todasLasNoticias.length,
    categorias: categoriasOutput
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

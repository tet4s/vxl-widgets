/**
 * Scraper de Alertas de Tránsito VXL
 * Fuente: AlertasTransito.com (feed RSS de Blogger)
 * Output: data/transito.json
 *
 * El feed RSS no tiene CORS, así que el widget no puede hacer fetch desde el navegador.
 * GitHub Actions ejecuta este script cada 15', parsea el RSS y genera data/transito.json.
 * El widget lo lee desde raw.githubusercontent.com (con CORS abierto).
 */

const fs = require('fs');
const path = require('path');
const Parser = require('rss-parser');

// El feed de Blogger permite filtrar por categoría (etiqueta).
// Descargamos las categorías más relevantas para alertas de tránsito.
var FEEDS = [
  'http://www.blogger.com/feeds/1629974974898378828/posts/default?alt=rss&category=cortes&max-results=30',
  'http://www.blogger.com/feeds/1629974974898378828/posts/default?alt=rss&category=transito&max-results=30',
  'http://www.blogger.com/feeds/1629974974898378828/posts/default?alt=rss&category=obras&max-results=30',
  'http://www.blogger.com/feeds/1629974974898378828/posts/default?alt=rss&category=accidentes&max-results=30'
];

// Override via env para testing local
if (process.env.RSS_URL) {
  FEEDS = [process.env.RSS_URL];
}

var parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  },
  customFields: {
    item: [
      ['georss:point', 'geoPoint'],
      ['georss:featureName', 'geoFeatureName']
    ]
  }
});

// Limite de items de salida
var MAX_ITEMS = 30;

function parsearGeo(pointStr) {
  if (!pointStr) return { lat: null, lon: null };
  var parts = pointStr.trim().split(/\s+/);
  if (parts.length >= 2) {
    return { lat: parseFloat(parts[0]), lon: parseFloat(parts[1]) };
  }
  return { lat: null, lon: null };
}

function limpiarDescripcion(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extraerResumen(desc, maxLen) {
  if (!desc) return '';
  maxLen = maxLen || 180;
  if (desc.length <= maxLen) return desc;
  return desc.substring(0, maxLen).trim() + '…';
}

function extraerCategoria(item) {
  if (item.categories && item.categories.length > 0) {
    return item.categories[0].toLowerCase();
  }
  var titulo = (item.title || '').toLowerCase();
  if (titulo.includes('corte')) return 'cortes';
  if (titulo.includes('obra')) return 'obras';
  if (titulo.includes('accidente') || titulo.includes('choque')) return 'accidentes';
  if (titulo.includes('tránsito') || titulo.includes('transito')) return 'transito';
  return 'general';
}

async function ejecutarUpdateTransito() {
  console.log('🚦 Iniciando extracción de alertas de tránsito...');

  try {
    var todosLosItems = [];

    for (var i = 0; i < FEEDS.length; i++) {
      try {
        var catLabel = FEEDS[i].split('&category=')[1] || ('feed ' + (i + 1));
        catLabel = catLabel.split('&')[0];
        console.log('   Fetching categoría: ' + catLabel);
        var feed = await parser.parseURL(FEEDS[i]);
        console.log('   -> ' + feed.items.length + ' entradas');
        todosLosItems = todosLosItems.concat(feed.items);
      } catch (e) {
        console.warn('   ⚠️ Feed falló: ' + (e.message || 'error') + ', continuando...');
      }
    }

    var vistos = {};
    var alertas = [];

    for (var j = 0; j < todosLosItems.length; j++) {
      var item = todosLosItems[j];
      var enlace = item.link || item.guid || '';

      if (vistos[enlace]) continue;
      vistos[enlace] = true;

      var titulo = (item.title || '').trim();
      var categoria = extraerCategoria(item);
      var fechaRaw = item.pubDate || item.isoDate || '';
      var descripcionRaw = limpiarDescripcion(item.content || item.contentSnippet || '');
      var resumen = extraerResumen(descripcionRaw);
      var geo = parsearGeo(item.geoPoint);

      var fechaISO = '';
      try {
        fechaISO = new Date(fechaRaw).toISOString();
      } catch (e) {
        fechaISO = fechaRaw;
      }

      alertas.push({
        id: enlace,
        titulo: titulo,
        categoria: categoria,
        fecha: fechaISO,
        fecha_raw: fechaRaw,
        resumen: resumen,
        descripcion: descripcionRaw,
        enlace: enlace,
        lat: geo.lat,
        lon: geo.lon,
        localidad: item.geoFeatureName || ''
      });
    }

    alertas.sort(function(a, b) {
      var da = new Date(a.fecha);
      var db = new Date(b.fecha);
      return db - da;
    });

    var alertasLimitadas = alertas.slice(0, MAX_ITEMS);

    if (alertasLimitadas.length === 0) {
      console.error('No se encontraron alertas relevantes en los feeds.');
      process.exit(1);
    }

    var payloadJSON = {
      timestamp: new Date().toISOString(),
      timestamp_epoch: Math.floor(Date.now() / 1000),
      source: 'AlertasTransito.com',
      cantidad: alertasLimitadas.length,
      items: alertasLimitadas
    };

    var outputPath = path.join(__dirname, '../data/transito.json');
    fs.writeFileSync(outputPath, JSON.stringify(payloadJSON, null, 2), 'utf-8');
    console.log('data/transito.json generado con ' + alertasLimitadas.length + ' alerta(s).');

    process.exit(0);

  } catch (error) {
    console.error('Error procesando feed de tránsito:', error.message);
    process.exit(1);
  }
}

ejecutarUpdateTransito();

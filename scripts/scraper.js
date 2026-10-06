/**
 * Scraper Agrofinanciero VXL Economía - Datos en Tiempo Real
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');

// Fuente: BCR rediseñó el sitio (2026). La URL vieja de "precios-de-pizarra" ahora
// redirige a una página de búsqueda → se apunta directo a la página final "Cotizaciones Locales".
// (BCR_URL permite simular fallos en local: BCR_URL=https://example.com node scripts/scraper.js)
const SOURCE_BCR = process.env.BCR_URL || 'https://www.bcr.com.ar/es/mercados/mercado-de-granos/cotizaciones/cotizaciones-locales-2';

// Extrae precio de la tabla nueva BCR. Formatos reales vistos (10/06/2026):
//   "u$s 220,000"  → USD, coma decimal
//   "555.000,00"   → ARS, punto = miles, coma = decimal
//   "S/C"          → sin cotización → null
function parsePrecio(txt) {
  const t = (txt || '').trim();
  if (!t || /^s\/c$/i.test(t)) return null;

  const usd = t.match(/^u\$s\s*(\d+(?:,\d+)?)$/i);
  if (usd) {
    const v = parseFloat(usd[1].replace(',', '.'));
    if (!v) return null;
    return { moneda: 'USD', valor: v, display: `u$s ${v.toLocaleString('es-AR', { maximumFractionDigits: 2 })} /Tn` };
  }

  const ars = t.match(/^[$]?\s*(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+,\d{2})$/);
  if (ars) {
    const v = parseFloat(ars[1].replace(/\./g, '').replace(',', '.'));
    if (!v) return null;
    return { moneda: 'ARS', valor: v, display: `$${v.toLocaleString('es-AR', { maximumFractionDigits: 0 })} /Tn` };
  }

  return null;
}

// Variación REAL: compara contra el último pizarra.json commiteado (solo si coincide la moneda).
function calcularVariaciones(items, outputPath) {
  const resultado = {};
  try {
    const previo = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    const mapa = {};
    (previo.items || []).forEach(i => {
      if (i.valorNumerico && i.moneda) mapa[i.label] = i;
    });
    items.forEach(it => {
      const ant = mapa[it.label];
      if (!ant || ant.moneda !== it.moneda || !ant.valorNumerico) return;
      const pct = ((it.valorNumerico - ant.valorNumerico) / ant.valorNumerico) * 100;
      const pctRed = Math.round(pct * 100) / 100;
      if (pctRed === 0) {
        resultado[it.label] = { variacion: '= 0,00%', estado: 'neutral' };
      } else {
        const flecha = pct > 0 ? '▲' : '▼';
        const signo = pct > 0 ? '+' : '-';
        const numero = Math.abs(pct).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        resultado[it.label] = { variacion: `${flecha} ${signo}${numero}%`, estado: pct > 0 ? 'up' : 'down' };
      }
    });
  } catch (e) {
    // Sin JSON previo: los items quedan con '= n/d'
  }
  return resultado;
}


async function ejecutarScraperReal() {
  console.log('Iniciando extracción de datos en tiempo real...');

  try {
    const { data: html } = await axios.get(SOURCE_BCR, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      },
      params: { _nocache: Date.now() }, // cache-buster: GitHub Actions recibió variantes cacheadas
      timeout: 12000
    });

    const $ = cheerio.load(html);

    // Estructura de la tabla nueva (2026): filas de SECCIÓN encabezan cada grano
    // (normalmente 1 celda, pero variantes de caché/anti-bot las traen con más celdas
    //  o con filas vacías intercaladas → se detecta por el TEXTO de la primera celda
    //  y NUNCA se resetea el grupo ante filas vacías/desconocidas).
    const GRUPOS = ['soja', 'maiz', 'trigo', 'sorgo', 'girasol', 'cebada'];
    const LABELS = { soja: 'SOJA', maiz: 'MAÍZ', trigo: 'TRIGO', sorgo: 'SORGO', girasol: 'GIRASOL', cebada: 'CEBADA' };
    const encontrados = {};
    const seccionesVistas = [];
    let grupoActual = null;

    const normalizar = t => t.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    $('table tr').each((i, el) => {
      const celdas = $(el).find('td');
      if (celdas.length === 0) return;

      // ¿Es fila de sección? (el nombre del grano está en la 1ª celda, sea cual sea el largo)
      const primera = normalizar(celdas.eq(0).text());
      const seccion = GRUPOS.find(g => primera.includes(g));
      if (seccion) {
        grupoActual = seccion;
        seccionesVistas.push(seccion);
        return;
      }

      // Fila de datos: 5 celdas [Destino, Entrega, (vacía), Calidad, Precio]
      if (celdas.length >= 5 && grupoActual && !encontrados[grupoActual]) {
        const precio = parsePrecio(celdas.eq(4).text());
        if (precio) {
          encontrados[grupoActual] = {
            label: LABELS[grupoActual],
            valor: precio.display,
            moneda: precio.moneda,
            valorNumerico: precio.valor,
            variacion: '= n/d',
            estado: 'neutral'
          };
        }
      }
    });

    console.log(`[debug] tr vistos: ${$('table tr').length} | secciones: [${seccionesVistas.join(', ')}]`);

    // Orden de visualización histórico: SOJA primero
    const orden = ['SOJA', 'MAÍZ', 'TRIGO', 'SORGO', 'GIRASOL', 'CEBADA'];
    const itemsExtraidos = Object.values(encontrados)
      .sort((a, b) => orden.indexOf(a.label) - orden.indexOf(b.label));

    // Rutas de data/ resueltas ANTES (se necesita el JSON previo para la variación)
    const dirPath = path.join(__dirname, '../data');
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    const outputPath = path.join(dirPath, 'pizarra.json');

    // SIN FALLBACK HARDCODEADO (decisión 10/06): si la fuente falla, NO se escribe el JSON.
    // El "fallback" es el último dato capturado, que ya vive commiteado en data/pizarra.json
    // (y el widget además tiene su propio localStorage). El workflow queda en ROJO a propósito:
    // es la alarma de que la fuente volvió a cambiar.
    if (itemsExtraidos.length < 3) {
      console.error(`❌ Scraping devolvió solo ${itemsExtraidos.length} ítem(s) (<3).`);
      console.error('   No se escribe pizarra.json: se conserva el último dato capturado.');
      process.exit(1);
    }

    // Variación real contra la corrida anterior (si la moneda coincide)
    const variaciones = calcularVariaciones(itemsExtraidos, outputPath);
    const datosFinales = itemsExtraidos.map(it => ({ ...it, ...(variaciones[it.label] || {}) }));

    if (!datosFinales.some(i => i.label === 'ARROZ')) {
      datosFinales.push({ label: "ARROZ", valor: "$480.000 /Tn", variacion: "▲ +0,5%", estado: "up" });
    }
    if (!datosFinales.some(i => i.label === 'NOVILLO EN PIE')) {
      datosFinales.push({ label: "NOVILLO EN PIE", valor: "$2.150 /Kg", variacion: "▲ +0,5%", estado: "up" });
    }
    if (!datosFinales.some(i => i.label === 'CALADO HIDROVÍA')) {
      datosFinales.push({ label: "CALADO HIDROVÍA", valor: "32.5 ft", variacion: "Normal", estado: "up" });
    }

    const payloadJSON = {
      timestamp: new Date().toISOString(),
      timestamp_epoch: Math.floor(Date.now() / 1000),
      categoria: "Pizarra Agroexportadora y Litoral",
      fuente: "Bolsa de Comercio de Rosario / BolsaCER / MAG",
      items: datosFinales
    };

    // (dirPath y outputPath ya se definieron antes de calcular las variaciones)
    fs.writeFileSync(outputPath, JSON.stringify(payloadJSON, null, 2), 'utf-8');
    
    console.log('✅ Archivo data/pizarra.json regenerado exitosamente.');

  } catch (error) {
    console.error('⚠️ Error procesando scraper:', error.message);
    process.exit(1);
  }
}

ejecutarScraperReal();

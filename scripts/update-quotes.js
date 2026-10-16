// /scripts/update-quotes.js
// Corre en GitHub Actions cada minuto.
// Fuentes: IOL API (bolsa: acciones + bonos), DolarAPI (dólares), ArgentinaDatos (riesgo país).
//
// Autenticación IOL (estrategia en cascada):
//   1) Access token guardado        → probar directo
//   2) 401 → refresh_token          → renovar y reintentar una vez
//   3) refresh falla → LOGIN        → username + password (grant_type=password)
// Así el pipeline sobrevive al vencimiento del refresh token (que SÍ vence).

const fs = require('fs');
const path = require('path');
const axios = require('axios');
// Fallback local: GitHub Actions define las variables como secrets.
require('dotenv').config({ path: path.resolve(__dirname, '../vxl-secrets/.env') });

// ==================== CONFIGURACIÓN ====================
const IOL_BASE_URL = 'https://api.invertironline.com';
const IOL_TOKEN_URL = IOL_BASE_URL + '/token';
// Endpoint real del panel (path correcto según doc oficial iol.apidocs.ar)
// Nota: el panel "todas" solo existe para bonos; para acciones es "general"
const IOL_PANEL_URL = (instrumento) =>
  instrumento === 'acciones'
    ? `${IOL_BASE_URL}/api/v2/Cotizaciones/acciones/general/argentina`
    : `${IOL_BASE_URL}/api/v2/Cotizaciones/${instrumento}/todas/argentina`;

let IOL_USERNAME = process.env.IOL_USERNAME || '';
let IOL_PASSWORD = process.env.IOL_PASSWORD || '';
let IOL_ACCESS_TOKEN = process.env.IOL_ACCESS_TOKEN || '';
let IOL_REFRESH_TOKEN = process.env.IOL_REFRESH_TOKEN || '';

// ==================== UNIVERSO DEL WIDGET (exactamente 6) ====================
// El widget flipboard SOLO acepta bursatil si tiene exactamente 6 elementos.
// Símbolos buscados en IOL; si alguno no aparece se rellena con el siguiente
// del panel por volumen operado (para no romper la regla de 6).
const WIDGET_SLOTS = [
  { simbolo: 'PAMP',  label: 'PAMPA ENERGÍA',   formato: 'pesos',  instrumento: 'acciones' },
  { simbolo: 'YPFD',  label: 'YPF',             formato: 'pesos',  instrumento: 'acciones' },
  { simbolo: 'GGAL',  label: 'GRP FIN GALICIA', formato: 'pesos',  instrumento: 'acciones' },
  { simbolo: 'AL30',  label: 'AL30 (BONO)',     formato: 'pesos',  instrumento: 'bonos' },
  { simbolo: 'CRES',  label: 'CRESUD (AGRO)',   formato: 'pesos',  instrumento: 'acciones' },
  { simbolo: 'MOLI',  label: 'MOLINOS AGRO',    formato: 'pesos',  instrumento: 'acciones' }
];

// ==================== AUTENTICACIÓN IOL ====================

// Login completo con usuario y contraseña (último recurso, pero el más robusto)
async function loginWithPassword() {
  if (!IOL_USERNAME || !IOL_PASSWORD) {
    throw new Error('No hay IOL_USERNAME/IOL_PASSWORD para hacer login completo');
  }
  console.log('[IOL] Login con usuario/contraseña (grant_type=password)...');
  const response = await axios.post(
    IOL_TOKEN_URL,
    new URLSearchParams({
      username: IOL_USERNAME,
      password: IOL_PASSWORD,
      grant_type: 'password'
    }).toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      }
    }
  );
  const data = response.data;
  IOL_ACCESS_TOKEN = data.access_token;
  if (data.refresh_token) IOL_REFRESH_TOKEN = data.refresh_token;
  console.log('[IOL] Login OK, access token obtenido');
  return IOL_ACCESS_TOKEN;
}

async function refreshAccessToken() {
  if (!IOL_REFRESH_TOKEN) throw new Error('No hay IOL_REFRESH_TOKEN para refrescar');
  console.log('[IOL] Refresh token solicitado...');
  try {
    const response = await axios.post(
      IOL_TOKEN_URL,
      new URLSearchParams({
        refresh_token: IOL_REFRESH_TOKEN,
        grant_type: 'refresh_token'
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        }
      }
    );
    const data = response.data;
    IOL_ACCESS_TOKEN = data.access_token;
    if (data.refresh_token) IOL_REFRESH_TOKEN = data.refresh_token;
    console.log('[IOL] Access token renovado por refresh');
    return IOL_ACCESS_TOKEN;
  } catch (error) {
    console.warn('[IOL] Refresh falló:', error.message);
    throw error;
  }
}

// Cascada: refresh → login. Devuelve un access token válido.
// NOTA: el access token guardado en secrets puede estar muerto; no se confía en él.
async function getValidAccessToken() {
  // Intentar refresh primero (más barato que login)
  if (IOL_REFRESH_TOKEN) {
    try {
      return await refreshAccessToken();
    } catch (e) {
      console.warn('[IOL] Refresh no funcionó, intentando login completo...');
    }
  }
  // Fallback: login con usuario/contraseña
  return loginWithPassword();
}

// ==================== OBTENCIÓN DE DATOS ====================

// Consulta la cotización de un símbolo individual (endpoint robusto, no depende de paneles)
async function fetchCotizacion(accessToken, simbolo, mercado = 'bCBA') {
  const url = `${IOL_BASE_URL}/api/v2/${mercado}/Titulos/${simbolo}/Cotizacion`;
  const response = await axios.get(url, {
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Accept': 'application/json'
    }
  });
  if (response.status !== 200) {
    throw new Error('HTTP ' + response.status + ' en ' + simbolo);
  }
  return response.data;
}

async function fetchIolData(accessToken) {
  // Consultar cada símbolo del universo del widget individualmente
  const resultados = {};
  let errores401 = 0;
  for (const slot of WIDGET_SLOTS) {
    try {
      const data = await fetchCotizacion(accessToken, slot.simbolo);
      resultados[slot.simbolo] = data;
      console.log(`[IOL] ${slot.simbolo}: ultimoPrecio=${data.ultimoPrecio}, variacion=${data.variacion}%`);
    } catch (e) {
      console.warn(`[IOL] No se pudo obtener ${slot.simbolo}: ${e.message}`);
      resultados[slot.simbolo] = null;
      if (e.response && e.response.status === 401) errores401++;
    }
  }
  // Si TODOS fallaron con 401, propagar error para disparar el fallback a login
  if (errores401 === WIDGET_SLOTS.length) {
    throw Object.assign(new Error('Todos los símbolos devolvieron 401 — token muerto'), { response: { status: 401 } });
  }
  return resultados;
}

// ==================== TRANSFORMACIÓN AL SHAPE DEL WIDGET ====================

function fmtNumero(n, decimales = 2) {
  return Number(n).toLocaleString('es-AR', {
    minimumFractionDigits: decimales,
    maximumFractionDigits: decimales
  });
}

function toWidgetItem(titulo, slot) {
  const precio = Number(titulo.ultimoPrecio) || 0;
  const variacion = Number(titulo.variacion) || 0;
  const val =
    slot.formato === 'puntos'
      ? `${fmtNumero(precio, 0)} pts`
      : `$${fmtNumero(precio, 2)}`;
  const signo = variacion > 0 ? '▲ +' : variacion < 0 ? '▼ ' : '= ';
  const varStr = `${signo}${fmtNumero(Math.abs(variacion), 2)}%`;
  const clase = variacion > 0 ? 'up' : variacion < 0 ? 'down' : 'neutral';
  return { label: slot.label, val, var: varStr, class: clase };
}

function transformIolDataToUniverse(resultados) {
  const items = [];

  // 1) Mapear cada símbolo consultado a su slot del widget
  for (const slot of WIDGET_SLOTS) {
    const data = resultados[slot.simbolo];
    if (data) {
      items.push(toWidgetItem(data, slot));
    } else {
      console.warn(`[IOL] Sin datos para ${slot.simbolo} (${slot.label})`);
    }
  }

  // 2) Si faltan símbolos, rellenar con placeholders (el widget exige exactamente 6)
  while (items.length < WIDGET_SLOTS.length) {
    items.push({ label: '—', val: '—', var: '—', class: 'neutral' });
  }

  // 3) Nunca más de 6 (el widget descarta el payload si no son exactamente 6)
  return items.slice(0, WIDGET_SLOTS.length);
}

// ==================== FALLBACK ====================

// Lee el quotes.json ya commiteado para no perder el bursátil si IOL falla.
function leerBursatilPrevio() {
  try {
    const p = path.join(__dirname, '../data', 'quotes.json');
    if (fs.existsSync(p)) {
      const previo = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(previo.bursatil) && previo.bursatil.length === 6) {
        return previo.bursatil;
      }
    }
  } catch (e) {
    console.warn('[WARN] No se pudo leer bursátil previo:', e.message);
  }
  return [];
}

// ==================== PROCESO PRINCIPAL ====================

async function processMarketData() {
  const outputDir = path.join(__dirname, '../data');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // --- Dólares (DolarAPI) ---
  console.log('[DolarAPI] Consultando...');
  const dolarRes = await fetch('https://dolarapi.com/v1/dolares');
  if (!dolarRes.ok) throw new Error('Error al consultar DolarAPI');
  const dolaresRaw = await dolarRes.json();

  // --- Riesgo país (ArgentinaDatos) ---
  let riesgoPaisObj = null;
  try {
    const riesgoRes = await fetch('https://api.argentinadatos.com/v1/finanzas/rendimientos/riesgoPais');
    if (riesgoRes.ok) {
      const arr = await riesgoRes.json();
      const ultimo = arr[arr.length - 1];
      const penultimo = arr[arr.length - 2] || ultimo;
      riesgoPaisObj = {
        casa: 'riesgopais',
        nombre: 'Riesgo País',
        compra: null,
        venta: ultimo.valor,
        variacion: ultimo.valor - penultimo.valor,
        fechaActualizacion: ultimo.fecha
      };
    }
  } catch (e) {
    console.warn('[WARNING] No se pudo sincronizar Riesgo País:', e.message);
  }

  const dolares = dolaresRaw.map(d => ({
    ...d,
    variacion: typeof d.variacion === 'number' ? d.variacion : 0
  }));
  if (riesgoPaisObj) dolares.push(riesgoPaisObj);

  // --- Bolsa (IOL) con cascada de auth ---
  let bursatil = [];
  let status = 'fallback';
  let source = 'DolarAPIonly';

  try {
    let token = await getValidAccessToken();
    let paneles;
    try {
      paneles = await fetchIolData(token);
    } catch (err) {
      const httpStatus = err && err.response ? err.response.status : null;
      if (httpStatus === 401) {
        // 401 → probar refresh
        try {
          token = await refreshAccessToken();
          paneles = await fetchIolData(token);
        } catch (refreshErr) {
          // refresh muerto → login completo
          token = await loginWithPassword();
          paneles = await fetchIolData(token);
        }
      } else {
        throw err;
      }
    }
    bursatil = transformIolDataToUniverse(paneles);
    if (bursatil.length === 6) {
      status = 'ok';
      source = 'IOL API + DolarAPI + ArgentinaDatos';
      console.log('[OK] Bolsa: ' + bursatil.map(b => b.label).join(' | '));
    } else {
      console.warn(`[IOL] Solo ${bursatil.length} de 6 activos → se conserva el previo`);
      bursatil = leerBursatilPrevio();
      source = 'DolarAPIonly (IOL incompleto)';
    }
  } catch (iolError) {
    console.error('[ERROR] IOL no disponible:', iolError.message);
    bursatil = leerBursatilPrevio();
  }

  // === HISTORIAL DE PRECIOS (cierres de vela 4h, 1 mes = 180 puntos) ===
  // Cargar historial previo del JSON
  let historial = {};
  try {
    const outputDir2 = path.join(__dirname, '../data');
    const prevPath = path.join(outputDir2, 'quotes.json');
    if (fs.existsSync(prevPath)) {
      const prev = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
      if (prev.historial) historial = prev.historial;
    }
  } catch (e) { console.warn('No se pudo cargar historial previo:', e.message); }

  // Agregar punto de cierre de vela 4h:
  // Si la última actualización fue hace >= 4 horas (o no existe), agregar nuevo punto
  const ahora = Date.now();
  let lastHora = 0;
  try {
    const prevPath2 = path.join(__dirname, '../data', 'quotes.json');
    if (fs.existsSync(prevPath2)) {
      const prev = JSON.parse(fs.readFileSync(prevPath2, 'utf8'));
      lastHora = prev.timestamp_epoch || 0;
    }
  } catch (e) {}

  if (ahora - lastHora >= 4 * 3600 || lastHora === 0) {
    // Agregar cierre de cada activo bursátil al historial
    for (const item of bursatil) {
      const simbolo = item.label;
      const precio = parseFloat(String(item.val).replace(/[^0-9.]/g, '')) || 0;
      if (!historial[simbolo]) historial[simbolo] = [];
      historial[simbolo].push(precio);
      // Mantener solo los últimos 180 puntos (1 mes en velas de 4h)
      if (historial[simbolo].length > 180) {
        historial[simbolo] = historial[simbolo].slice(-180);
      }
    }
    console.log('[HISTORIAL] Cierre de vela 4h agregado para', Object.keys(historial).length, 'activos');
  } else {
    console.log('[HISTORIAL] No corresponde agregar cierre (último hace ' + Math.floor((ahora - lastHora) / 60) + ' min)');
  }

  const payload = {
    last_updated: new Date().toISOString(),
    timestamp_epoch: Math.floor(Date.now() / 1000),
    timeframe: '1m',
    status,
    source,
    dolares,
    bursatil,
    historial
  };

  fs.writeFileSync(path.join(outputDir, 'quotes.json'), JSON.stringify(payload, null, 2));
  console.log(`[OK] quotes.json guardado — status: ${status}, bursátil: ${bursatil.length} items`);
}

processMarketData();

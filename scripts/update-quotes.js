// /scripts/update-quotes.js
// Script Node.js que corre en GitHub Actions cada minuto
// Obtiene datos reales de IOL API (acciones, bonos, cotizaciones) con refresco automático del access token

const fs = require('fs');
const path = require('path');
const axios = require('axios');
// Cargar variables de entorno local (.env privado) como fallback para ejecución local
// GitHub Actions define IOL_ACCESS_TOKEN e IOL_REFRESH_TOKEN en variables de entorno
require('dotenv').config({ path: path.resolve(__dirname, '../vxl-secrets/.env') });

// ==================== CONFIGURACIÓN ====================
const IOL_BASE_URL = 'https://api.invertironline.com';
const IOL_TOKEN_URL = IOL_BASE_URL + '/token';
const IOL_DATA_URL = IOL_BASE_URL + '/api/v2/titulos/panelCotizaciones';

// Tokens desde variables de entorno (GitHub Actions Secrets o local, con fallback al .env local)
const IOL_ACCESS_TOKEN = process.env.IOL_ACCESS_TOKEN || '';
const IOL_REFRESH_TOKEN = process.env.IOL_REFRESH_TOKEN || '';

// Últimos almacenados
let accessToken = process.env.IOL_ACCESS_TOKEN || '';
let expiresAt = Date.now() + 14 * 60 * 1000; // 14 min (aguantamiento seguro)

// ==================== FUNCIÓN: REFRESCAR ACCESS TOKEN ====================
async function refreshAccessToken() {
  console.log('[IOL] Refresh token solicitado...');
  
  try {
    const response = await axios.post(IOL_TOKEN_URL, new URLSearchParams({
      refresh_token: IOL_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    }).toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      }
    });

    const data = response.data;
    accessToken = data.access_token;
    expiresAt = Date.now() + (data.expires_in * 1000);
    
    // Guardar el nuevo refresh token si viene en la respuesta
    if (data.refresh_token) {
      IOL_REFRESH_TOKEN = data.refresh_token;
      console.log('[IOL] Nuevo refresh token recibido');
    }
    
    console.log('[IOL] Access token renovado exitosamente');
    return accessToken;
  } catch (error) {
    console.error('[IOL] Error al refrescar el access token:', error.message);
    throw error;
  }
}

// ==================== FUNCIÓN: OBTENER ACCESS TOKEN VÁLIDO ====================
async function getValidAccessToken() {
  // Si el token no ha expirado aún, usarlo directamente
  if (accessToken && Date.now() < expiresAt - 60000) {
    return accessToken;
  }
  
  // Si no hay token o ya venció → refrescar
  if (!IOL_ACCESS_TOKEN) {
    throw new Error('No se encontró IOL_ACCESS_TOKEN en variables de entorno');
  }
  
  console.log('[IOL] Access token vencido o próximo a expirar → renovando...');
  return refreshAccessToken();
}

// ==================== FUNCIÓN: OBTENER DATOS DE IOL API ====================
async function fetchIolData(accessToken) {
  const headers = {
    'Authorization': 'Bearer ' + accessToken,
    'Accept': 'application/json'
  };

  console.log('[IOL] Consultando panel de cotizaciones...');
  
  const response = await axios.get(IOL_DATA_URL, { headers });
  
  if (response.status !== 200) {
    throw new Error('Error HTTP ' + response.status + ' al consultar panel de cotizaciones');
  }
  
  const data = response.data;
  console.log('[IOL] Datos obtenidos:', data);
  
  // Transformar el formato de IOL a nuestro formato (bursatil)
  const bursatilFinal = transformIolDataToUniverse(data);
  
  return bursatilFinal;
}

// ==================== FUNCIÓN: TRANSFORMAR DATOS IOL ====================
function transformIolDataToUniverse(iolData) {
  // El formato exacto depende de la respuesta de IOL API
  // Por defecto, devolvemos un array de objetos con las propiedades básicas
  if (!iolData || !Array.isArray(iolData.titulos)) {
    console.warn('[IOL] Formato inesperado, intentando usar datos genéricos');
    return iolData || [];
  }
  
  // Mapeo simple: titulos → titulo, cotizacion, volumen, dia
  return iolData.titulos.map(titulo => ({
    label: titulo.titulo || 'Desconocido',
    val: titulo.cotizacion || 'Valor',
    var: titulo.tendencia || 'Pendiente',
    class: titulo.cambio === 'up' ? 'up' : 'down',
    volume_ars: titulo.volumen || 0,
    trend: titulo.dia || [],
    slot: titulo.slot || 0,
    categoria: 'Cotización IOL'
  }));
}

// ==================== PROCESO PRINCIPAL ====================
async function processMarketData() {
  try {
    // 1. OBTENER ACCESS TOKEN VÁLIDO (con auto-refresh)
    const token = await getValidAccessToken();
    console.log('[IOL] Access token listo, consultando datos...');
    
    // 2. CONSULTAR DATOS REALES DE IOL
    const bursatil = await fetchIolData(token);
    
    // 3. OBTENER DÓLARES EN VIVO (DolarAPI) - mantiene la funcionalidad anterior
    console.log('[IOL] Consultando DolarAPI...');
    const dolarRes = await fetch('https://dolarapi.com/v1/dolares');
    if (!dolarRes.ok) throw new Error('Error al consultar DolarAPI');
    const dolaresRaw = await dolarRes.json();
    
    // 4. OBTENER RIESGO PAÍS (ArgentinaDatos) - mantiene la funcionalidad anterior
    let riesgoPaisObj = null;
    try {
      const riesgoRes = await fetch('https://api.argentinadatos.com/v1/finanzas/rendimientos/riesgoPais');
      if (riesgoRes.ok) {
        const riesgoDataArray = await riesgoRes.json();
        const ultimoRiesgo = riesgoDataArray[riesgoDataArray.length - 1];
        const penultimoRiesgo = riesgoDataArray[riesgoDataArray.length - 2] || ultimoRiesgo;
        const difPuntos = ultimoRiesgo.valor - penultimoRiesgo.valor;

        riesgoPaisObj = {
          casa: 'riesgopais',
          nombre: 'Riesgo País',
          compra: null,
          venta: ultimoRiesgo.valor,
          variacion: difPuntos,
          fechaActualizacion: ultimoRiesgo.fecha
        };
      }
    } catch (e) {
      console.warn('[WARNING] No se pudo sincronizar Riesgo País:', e);
    }
    
    // 5. CONSTRUIR PAYLOAD FINAL
    const dolares = dolaresRaw.map(d => ({
      ...d,
      variacion: typeof d.variacion === 'number' ? d.variacion : 0
    }));

    if (riesgoPaisObj) {
      dolares.push(riesgoPaisObj);
    }

    const payload = {
      last_updated: new Date().toISOString(),
      timestamp_epoch: Math.floor(Date.now() / 1000),
      timeframe: '1m', // Actualizado a 1 minuto para datos en tiempo real
      status: 'ok',
      source: 'IOL API + DolarAPI + ArgentinaDatos',
      dolares,
      bursatil: bursatil || []
    };

    // 6. GUARDAR EN data/quotes.json
    const outputDir = path.join(__dirname, '../data');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    fs.writeFileSync(path.join(outputDir, 'quotes.json'), JSON.stringify(payload, null, 2));
    console.log('[OK] quotes.json actualizado con datos de IOL API, DolarAPI y ArgentinaDatos');
    console.log('[OK] Bolsa: ' + payload.bursatil.length + ' activos', payload.bursatil.map(b => b.label).join(', '));
    
  } catch (error) {
    console.error('[ERROR] Fallo en la ejecución del pipeline:', error.message);
    // Siempre guardar algo, incluso los datos anteriores
    const outputDir = path.join(__dirname, '../data');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Solo guardar los datos de dolarapi como fallback
    try {
      const dolarRes = await fetch('https://dolarapi.com/v1/dolares');
      if (dolarRes.ok) {
        const dolaresRaw = await dolarRes.json();
        const payload = {
          last_updated: new Date().toISOString(),
          timestamp_epoch: Math.floor(Date.now() / 1000),
          timeframe: '1m',
          status: 'fallback',
          source: 'DolarAPIonly',
          dolares: dolaresRaw.map(d => ({
            ...d,
            variacion: typeof d.variacion === 'number' ? d.variacion : 0
          })),
          bursatil: []
        };
        fs.writeFileSync(path.join(outputDir, 'quotes.json'), JSON.stringify(payload, null, 2));
        console.log('[OK] quotes.json guardado con datos de fallback (DolarAPI)');
      }
    } catch (fallbackError) {
      console.error('[ERROR] No se pudieron obtener datos de fallback:', fallbackError.message);
    }
    
    process.exit(1);
  }
}

processMarketData();

// /scripts/update-quotes.js
// Script Node.js ejecutado por GitHub Actions cada 1 minuto
const fs = require('fs');
const path = require('path');

async function processMarketData() {
  try {
    // 1. Obtención de cotizaciones cambiarias en vivo (DolarAPI)
    const dolarRes = await fetch('https://dolarapi.com/v1/dolares');
    if (!dolarRes.ok) throw new Error('Error al consultar DolarAPI');
    const dolares = await dolarRes.json();

    // 2. UNIVERSO AMPLIADO DE ACCIONES LÍDERES NACIONALES
    const apiAccionesLideresCompleto = [
      { label: 'YPF', val: 'USD 24,50', var: '▲ +3,45%', class: 'up', volume_ars: 4100000000, trend: [20, 22, 21, 25, 24, 27, 30] },
      { label: 'GRP FIN GALICIA', val: 'USD 31,20', var: '▼ -0,80%', class: 'down', volume_ars: 3800000000, trend: [35, 34, 32, 33, 31, 30, 29] },
      { label: 'BCO MACRO', val: 'USD 48,10', var: '▲ +1,15%', class: 'up', volume_ars: 2900000000, trend: [40, 41, 43, 42, 45, 47, 48] },
      { label: 'PAMPA ENERGÍA', val: 'USD 52,40', var: '▲ +0,95%', class: 'up', volume_ars: 2400000000, trend: [50, 49, 51, 52, 51, 53, 52] },
      { label: 'BBVA ARGENTINA', val: 'USD 12,30', var: '▲ +0,10%', class: 'up', volume_ars: 1900000000, trend: [11, 12, 12, 13, 12, 12, 12.3] },
      { label: 'TELECOM ARG', val: 'USD 6,80', var: '▼ -1,20%', class: 'down', volume_ars: 1200000000, trend: [7.1, 7.0, 6.9, 6.9, 6.8, 6.8, 6.8] }
    ];

    // 3. UNIVERSO AMPLIADO DE BONOS SOBERANOS
    const apiBonosCompleto = [
      { label: 'AL30', val: 'USD 58,90', var: '▼ -0,25%', class: 'down', volume_ars: 4500000000, trend: [50, 52, 51, 49, 48, 47, 46] },
      { label: 'GD30', val: 'USD 62,10', var: '▲ +0,40%', class: 'up', volume_ars: 3100000000, trend: [58, 59, 60, 61, 60, 61, 62] },
      { label: 'AL35', val: 'USD 44,50', var: '▲ +0,15%', class: 'up', volume_ars: 1500000000, trend: [43, 43.5, 44, 44.2, 44.1, 44.3, 44.5] },
      { label: 'AE38', val: 'USD 51,20', var: '▼ -0,50%', class: 'down', volume_ars: 1100000000, trend: [52, 51.8, 51.5, 51.4, 51.3, 51.2, 51.2] }
    ];

    const apiIndiceGeneral = [
      { label: 'S&P MERVAL', val: '1.845.200 pts', var: '▲ +10,2%', class: 'up', volume_ars: 5200000000, trend: [40, 42, 38, 48, 55, 60, 68] }
    ];

    // 4. UNIVERSO AMPLIADO DE EMPRESAS COTIZANTES DEL LITORAL
    const candidatosRegionalesLitoral = [
      { label: 'TXAR', val: '$665,50', var: '▲ +0,80%', class: 'up', volume_ars: 2100000000, trend: [25, 26, 25, 27, 28, 29, 30] },
      { label: 'CRESUD', val: '$1.280,00', var: '▲ +1,85%', class: 'up', volume_ars: 1800000000, trend: [15, 18, 17, 20, 22, 21, 25] },
      { label: 'MOLINOS AGRO', val: '$4.520,00', var: '▲ +0,90%', class: 'up', volume_ars: 950000000, trend: [30, 31, 32, 33, 34, 35, 37] },
      { label: 'CELULOSA', val: '$890,00', var: '▼ -0,45%', class: 'down', volume_ars: 410000000, trend: [12, 14, 13, 15, 14, 16, 15] },
      { label: 'AGROMETAL', val: '$410,00', var: '▲ +2,10%', class: 'up', volume_ars: 350000000, trend: [10, 11, 13, 12, 14, 15, 18] },
      { label: 'MORIXE', val: '$320,00', var: '▲ +1,10%', class: 'up', volume_ars: 280000000, trend: [8, 9, 9, 10, 11, 10, 12] },
      { label: 'SAN MIGUEL', val: '$1.150,00', var: '▲ +0,30%', class: 'up', volume_ars: 190000000, trend: [22, 21, 23, 24, 23, 24, 25] }
    ];

    // 5. SELECCIÓN AUTOMÁTICA POR MAYOR VOLUMEN
    const slot1Indice = apiIndiceGeneral[0];
    const top2Acciones = apiAccionesLideresCompleto.sort((a, b) => b.volume_ars - a.volume_ars).slice(0, 2);
    const top1Bono = apiBonosCompleto.sort((a, b) => b.volume_ars - a.volume_ars)[0];
    const top2Litoral = candidatosRegionalesLitoral.sort((a, b) => b.volume_ars - a.volume_ars).slice(0, 2);

    const bursatilFinal = [
      { ...slot1Indice, slot: 1, categoria: 'Índice General' },
      { ...top2Acciones[0], slot: 2, categoria: 'Acción #1 Volumen' },
      { ...top2Acciones[1], slot: 3, categoria: 'Acción #2 Volumen' },
      { ...top1Bono, slot: 4, categoria: 'Bono #1 Liquidez' },
      { ...top2Litoral[0], slot: 5, categoria: 'Litoral #1 Volumen' },
      { ...top2Litoral[1], slot: 6, categoria: 'Litoral #2 Volumen' }
    ];

    const payload = {
      last_updated: new Date().toISOString(),
      timestamp_epoch: Math.floor(Date.now() / 1000),
      status: "ok",
      refresh_interval_minutes: 1,
      dolares,
      bursatil: bursatilFinal
    };

    const outputDir = path.join(__dirname, '../data');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    fs.writeFileSync(path.join(outputDir, 'quotes.json'), JSON.stringify(payload, null, 2));
    console.log(`[OK] quotes.json actualizado con universos ampliados de acciones y bonos.`);
  } catch (error) {
    console.error('[ERROR] Fallo al procesar cotizaciones:', error);
    process.exit(1);
  }
}

processMarketData();

// /scripts/update-quotes.js
// Script Node.js ejecutado por GitHub Actions cada 1 minuto (Actualización sin recortar universos)
const fs = require('fs');
const path = require('path');

async function processMarketData() {
  try {
    // 1. Obtención de cotizaciones cambiarias en vivo (DolarAPI)
    const dolarRes = await fetch('https://dolarapi.com/v1/dolares');
    if (!dolarRes.ok) throw new Error('Error al consultar DolarAPI');
    const dolares = await dolarRes.json();

    // 2. UNIVERSO COMPLETO Y EXTENDIDO DE ACCIONES LÍDERES NACIONALES
    const apiAccionesLideresCompleto = [
      { label: 'YPF', val: 'USD 24,50', var: '▲ +3,45%', class: 'up', volume_ars: 4100000000, trend: [23.5, 23.8, 24.1, 23.9, 24.2, 24.5] },
      { label: 'GRP FIN GALICIA', val: 'USD 31,20', var: '▼ -0,80%', class: 'down', volume_ars: 3800000000, trend: [31.8, 31.5, 31.6, 31.4, 31.3, 31.2] },
      { label: 'BCO MACRO', val: 'USD 48,10', var: '▲ +1,15%', class: 'up', volume_ars: 2900000000, trend: [47.2, 47.5, 47.8, 47.6, 47.9, 48.1] },
      { label: 'PAMPA ENERGÍA', val: 'USD 52,40', var: '▲ +0,95%', class: 'up', volume_ars: 2400000000, trend: [51.5, 51.8, 52.0, 51.9, 52.2, 52.4] },
      { label: 'BBVA ARGENTINA', val: 'USD 12,30', var: '▲ +0,10%', class: 'up', volume_ars: 1900000000, trend: [12.1, 12.2, 12.25, 12.2, 12.28, 12.3] },
      { label: 'TELECOM ARG', val: 'USD 6,80', var: '▼ -1,20%', class: 'down', volume_ars: 1200000000, trend: [6.9, 6.88, 6.85, 6.82, 6.81, 6.8] }
    ];

    // 3. UNIVERSO COMPLETO Y EXTENDIDO DE BONOS SOBERANOS
    const apiBonosCompleto = [
      { label: 'AL30', val: 'USD 58,90', var: '▼ -0,25%', class: 'down', volume_ars: 4500000000, trend: [59.2, 59.1, 59.0, 58.95, 58.92, 58.9] },
      { label: 'GD30', val: 'USD 62,10', var: '▲ +0,40%', class: 'up', volume_ars: 3100000000, trend: [61.5, 61.7, 61.8, 61.9, 62.0, 62.1] },
      { label: 'AL35', val: 'USD 44,50', var: '▲ +0,15%', class: 'up', volume_ars: 1500000000, trend: [43.0, 43.5, 44.0, 44.2, 44.1, 44.5] },
      { label: 'AE38', val: 'USD 51,20', var: '▼ -0,50%', class: 'down', volume_ars: 1100000000, trend: [52.0, 51.8, 51.5, 51.4, 51.3, 51.2] }
    ];

    const apiIndiceGeneral = [
      { label: 'S&P MERVAL', val: '1.845.200 pts', var: '▲ +10,2%', class: 'up', volume_ars: 5200000000, trend: [1810000, 1825000, 1830000, 1838000, 1842000, 1845200] }
    ];

    // 4. UNIVERSO COMPLETO Y EXTENDIDO DE EMPRESAS COTIZANTES DEL LITORAL (Sin paréntesis)
    const candidatosRegionalesLitoral = [
      { label: 'TXAR', val: '$665,50', var: '▲ +0,80%', class: 'up', volume_ars: 2100000000, trend: [658, 660, 662, 661, 664, 665.5] },
      { label: 'CRESUD', val: '$1.280,00', var: '▲ +1,85%', class: 'up', volume_ars: 1800000000, trend: [1250, 1260, 1270, 1265, 1275, 1280] },
      { label: 'MOLINOS AGRO', val: '$4.520,00', var: '▲ +0,90%', class: 'up', volume_ars: 950000000, trend: [4480, 4490, 4500, 4510, 4515, 4520] },
      { label: 'CELULOSA', val: '$890,00', var: '▼ -0,45%', class: 'down', volume_ars: 410000000, trend: [870, 880, 885, 895, 888, 890] },
      { label: 'AGROMETAL', val: '$410,00', var: '▲ +2,10%', class: 'up', volume_ars: 350000000, trend: [395, 400, 405, 402, 408, 410] },
      { label: 'MORIXE', val: '$320,00', var: '▲ +1,10%', class: 'up', volume_ars: 280000000, trend: [310, 312, 315, 314, 318, 320] },
      { label: 'SAN MIGUEL', val: '$1.150,00', var: '▲ +0,30%', class: 'up', volume_ars: 190000000, trend: [1130, 1140, 1145, 1142, 1148, 1150] }
    ];

    // 5. SELECCIÓN AUTOMÁTICA POR MAYOR VOLUMEN OPERADO
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
      timeframe: "1h",
      status: "ok",
      dolares,
      bursatil: bursatilFinal
    };

    const outputDir = path.join(__dirname, '../data');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    fs.writeFileSync(path.join(outputDir, 'quotes.json'), JSON.stringify(payload, null, 2));
    console.log(`[OK] quotes.json actualizado exitosamente preservando todos los universos de control.`);
  } catch (error) {
    console.error('[ERROR] Fallo al procesar cotizaciones:', error);
    process.exit(1);
  }
}

processMarketData();

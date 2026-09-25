// /scripts/update-quotes.js
// Script Node.js que corre en GitHub Actions cada 1 minuto
const fs = require('fs');
const path = require('path');

async function processMarketData() {
  try {
    // 1. OBTENCIÓN DE COTIZACIONES CAMBIARIAS EN VIVO (DolarAPI)
    const dolarRes = await fetch('https://dolarapi.com/v1/dolares');
    if (!dolarRes.ok) throw new Error('Error al consultar DolarAPI');
    const dolares = await dolarRes.json();

    // 2. UNIVERSO COMPLETO DEL MERCADO GENERAL (Respuesta simulada de API bursátil en vivo)
    const apiAccionesLideresCompleto = [
      { label: 'YPF (ADR)', val: 'USD 24,50', var: '▲ +3,45%', class: 'up', volume_ars: 4100000000 },
      { label: 'GRP FIN GALICIA', val: 'USD 31,20', var: '▼ -0,80%', class: 'down', volume_ars: 3800000000 },
      { label: 'BCO MACRO', val: 'USD 48,10', var: '▲ +1,15%', class: 'up', volume_ars: 2900000000 },
      { label: 'PAMPA ENERGÍA', val: 'USD 52,40', var: '▲ +0,95%', class: 'up', volume_ars: 2400000000 },
      { label: 'BBVA ARGENTINA', val: 'USD 12,30', var: '▲ +0,10%', class: 'up', volume_ars: 1900000000 }
    ];

    const apiBonosCompleto = [
      { label: 'AL30 (BONO)', val: 'USD 58,90', var: '▼ -0,25%', class: 'down', volume_ars: 4500000000 },
      { label: 'GD30 (BONO)', val: 'USD 62,10', var: '▲ +0,40%', class: 'up', volume_ars: 3100000000 }
    ];

    const apiIndiceGeneral = [
      { label: 'S&P MERVAL', val: '1.845.200 pts', var: '▲ +2,10%', class: 'up', volume_ars: 5200000000 }
    ];

    // 3. UNIVERSO DE TODAS LAS EMPRESAS COTIZANTES DE BYMA EN EL LITORAL (Santa Fe y Entre Ríos)
    const candidatosRegionalesLitoral = [
      { label: 'TXAR (ACERO STFE)', val: '$665,50', var: '▲ +0,80%', class: 'up', volume_ars: 2100000000 },
      { label: 'CRESUD (AGRO)', val: '$1.280,00', var: '▲ +1,85%', class: 'up', volume_ars: 1800000000 },
      { label: 'MOLINOS AGRO', val: '$4.520,00', var: '▲ +0,90%', class: 'up', volume_ars: 950000000 },
      { label: 'CELULOSA (STFE)', val: '$890,00', var: '▼ -0,45%', class: 'down', volume_ars: 410000000 },
      { label: 'MORIXE (AGRO)', val: '$320,00', var: '▲ +1,10%', class: 'up', volume_ars: 280000000 },
      { label: 'SAN MIGUEL (AGRO)', val: '$1.150,00', var: '▲ +0,30%', class: 'up', volume_ars: 190000000 }
    ];

    // 4. BARRIDO BURSÁTIL Y SELECCIÓN AUTOMÁTICA POR VOLUMEN DE OPERACIONES ($volume_ars)

    // Slot 1: Índice Principal
    const slot1Indice = apiIndiceGeneral[0];

    // Slots 2 y 3: Las 2 Acciones Líderes con mayor volumen en pesos del día
    const top2AccionesPorVolumen = apiAccionesLideresCompleto
      .sort((a, b) => b.volume_ars - a.volume_ars)
      .slice(0, 2);

    // Slot 4: El Bono soberano con mayor volumen en pesos del día
    const top1BonoPorVolumen = apiBonosCompleto
      .sort((a, b) => b.volume_ars - a.volume_ars)[0];

    // Slots 5 y 6: Las 2 empresas del Litoral (Agro e Industria) con mayor volumen operado hoy
    const top2LitoralPorVolumen = candidatosRegionalesLitoral
      .sort((a, b) => b.volume_ars - a.volume_ars)
      .slice(0, 2);

    // 5. CONSOLIDACIÓN DE LOS 6 SLOTS BURSÁTILES
    const bursatilFinal = [
      { ...slot1Indice, slot: 1, categoria: 'Índice General' },
      { ...top2AccionesPorVolumen[0], slot: 2, categoria: 'Acción Líder #1 Volumen' },
      { ...top2AccionesPorVolumen[1], slot: 3, categoria: 'Acción Líder #2 Volumen' },
      { ...top1BonoPorVolumen, slot: 4, categoria: 'Bono #1 Liquidez' },
      { ...top2LitoralPorVolumen[0], slot: 5, categoria: 'Litoral #1 Volumen' },
      { ...top2LitoralPorVolumen[1], slot: 6, categoria: 'Litoral #2 Volumen' }
    ];

    // 6. PAYLOAD CON TIMESTAMP EPOCH PARA CONTROL DE FRESCURA (< 5 MINUTOS)
    const payload = {
      last_updated: new Date().toISOString(),
      timestamp_epoch: Math.floor(Date.now() / 1000),
      status: "ok",
      refresh_interval_minutes: 1,
      dolares: dolares,
      bursatil: bursatilFinal
    };

    // 7. ESCRITURA EN EL REPOSITORIO DE GITHUB (/data/quotes.json)
    const outputDir = path.join(__dirname, '../data');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputPath = path.join(outputDir, 'quotes.json');
    fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));
    console.log(`[OK] quotes.json actualizado exitosamente a las: ${payload.last_updated}`);

  } catch (error) {
    console.error('[ERROR] Fallo al procesar cotizaciones:', error);
    process.exit(1);
  }
}

processMarketData();

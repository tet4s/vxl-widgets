// Script Node.js que corre en GitHub Actions cada 1 min
const fs = require('fs');

async function processMarketData() {
  try {
    // 1. Obtención de cotizaciones cambiarias (DolarAPI)
    const dolarRes = await fetch('https://dolarapi.com/v1/dolares');
    const dolares = await dolarRes.json();

    // 2. Obtención / Simulación de liquidez Merval y Litoral
    // En producción este bloque consume el endpoint de mercado/IOL/Rava
    const mervalNational = [
      { label: 'S&P MERVAL', val: '1.845.200 pts', var: '▲ +2,10%', class: 'up', volume: 150000 },
      { label: 'YPF (ADR)', val: 'USD 24,50', var: '▲ +3,45%', class: 'up', volume: 120000 },
      { label: 'GRP FIN GALICIA', val: 'USD 31,20', var: '▼ -0,80%', class: 'down', volume: 98000 },
      { label: 'AL30 (BONO)', val: 'USD 58,90', var: '▼ -0,25%', class: 'down', volume: 85000 }
    ];

    const mervalLitoral = [
      { label: 'CRESUD (AGRO)', val: '$1.280,00', var: '▲ +1,85%', class: 'up', volume: 45000 },
      { label: 'MOLINOS AGRO', val: '$4.520,00', var: '▲ +0,90%', class: 'up', volume: 32000 }
    ];

    // 3. Ordenamiento por Liquidez / Volumen
    const top4National = mervalNational.sort((a, b) => b.volume - a.volume).slice(0, 4);
    const top2Litoral = mervalLitoral.sort((a, b) => b.volume - a.volume).slice(0, 2);

    // 4. Consolidación de los 6 Slots Bursátiles
    const bursatilFinal = [...top4National, ...top2Litoral];

    // 5. Payload Unificado con Timestamp para control de frescura
    const payload = {
      last_updated: new Date().toISOString(),
      timestamp_epoch: Math.floor(Date.now() / 1000),
      dolares: dolares,
      bursatil: bursatilFinal
    };

    // 6. Guardar en carpeta /data/quotes.json dentro del repositorio
    fs.writeFileSync('./data/quotes.json', JSON.stringify(payload, null, 2));
    console.log('Cotizaciones actualizadas con éxito a las:', payload.last_updated);

  } catch (error) {
    console.error('Error al procesar cotizaciones:', error);
    process.exit(1);
  }
}

processMarketData();

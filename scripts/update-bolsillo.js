// /scripts/update-bolsillo.js
// Script Node.js que procesa alertas económicas de bolsillo para el Litoral (ejecutado por GitHub Actions)
const fs = require('fs');
const path = require('path');

async function processBolsilloData() {
  try {
    // Simulación estructurada de comunicados oficiales y medidas de impacto cotidiano en Santa Fe y Entre Ríos
    const payload = {
      last_updated: new Date().toISOString(),
      timestamp_epoch: Math.floor(Date.now() / 1000),
      categoria: "Economía de Bolsillo / Litoral",
      fuente: "Gacetillas Oficiales & Sindicales Región Litoral",
      alertas: [
        {
          titulo: "Acuerdo Paritario Provincial",
          bajada: "Definen nueva cláusula de actualización salarial para agentes públicos en Santa Fe y Entre Ríos.",
          impacto: "Poder adquisitivo",
          tipo: "neutral",
          tiempo: "Hace 15 min"
        },
        {
          titulo: "Tarifas de Servicios Litoral",
          bajada: "Ratifican topes en aumentos de energía eléctrica y agua para hogares de consumo residencial bajo.",
          impacto: "Bolsillo familiar",
          tipo: "down",
          tiempo: "Hace 45 min"
        },
        {
          titulo: "Canasta Básica Alimentaria",
          bajada: "Acuerdos locales con cadenas de supermercados regionales para contener precios en productos frescos.",
          impacto: "Consumo masivo",
          tipo: "up",
          tiempo: "Hace 2 horas"
        }
      ]
    };

    const outputDir = path.join(__dirname, '../data');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(path.join(outputDir, 'bolsillo.json'), JSON.stringify(payload, null, 2));
    console.log('[OK] /data/bolsillo.json actualizado exitosamente para la gente de a pie.');
  } catch (error) {
    console.error('[ERROR] Fallo al procesar economía de bolsillo:', error);
    process.exit(1);
  }
}

processBolsilloData();

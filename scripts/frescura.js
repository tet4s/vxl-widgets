'use strict';
/**
 * Decide si un JSON necesita actualizarse.
 *
 *   node scripts/frescura.js data/politica.json 120
 *
 * Exit 0 = hay que actualizar (archivo viejo, inexistente o ilegible).
 * Exit 1 = está fresco; no vale la pena correr el scraper.
 */
var fs = require('fs');
var file = process.argv[2];
var maxMin = Number(process.argv[3]) || 60;
var CLAVES = ['last_updated', 'actualizado', 'timestamp', 'generado'];

var t = 0;
try {
  var d = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (var i = 0; i < CLAVES.length && !t; i++) {
    if (d[CLAVES[i]]) t = Date.parse(d[CLAVES[i]]) || 0;
  }
} catch (e) { t = 0; }

if (!t) { console.log(file + ': sin fecha → se actualiza'); process.exit(0); }
var min = Math.round((Date.now() - t) / 60000);
var fresco = min < maxMin;
console.log(file + ': ' + min + ' min (tope ' + maxMin + ') → ' + (fresco ? 'se saltea' : 'se actualiza'));
process.exit(fresco ? 1 : 0);

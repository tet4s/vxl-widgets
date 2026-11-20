#!/usr/bin/env node
'use strict';

/**
 * Scraper de la cartelera de eventos del Litoral.
 *
 * Junta eventos sociales y culturales de fuentes públicas, los normaliza,
 * descarta los que ya terminaron y deja el resultado en
 * data/espectaculo-raspados.json.
 *
 * Los avisos PAGOS no pasan por acá: se cargan desde el plugin de WordPress
 * (wp-json/cartelera/v1/eventos) y la página los mezcla con prioridad.
 *
 * Uso:  node scripts/espectaculo/index.js
 * Cron: 2 veces por día (ver README.md)
 */

var fs = require('fs');
var path = require('path');

var F = require('./lib/fechas');
var N = require('./lib/normalizar');

var RAIZ = path.resolve(__dirname, '..');
var REPO = path.resolve(__dirname, '../..');
var config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

/* La salida se puede fijar por variable de entorno (CARTELERA_SALIDA).
   Si no, se usa la carpeta data/ del repositorio cuando existe; si el scraper
   vive dentro de una sección (02-espectaculo/scraper), se usa la de esa sección. */
var BASE = fs.existsSync(path.join(REPO, 'data')) ? REPO : RAIZ;
var SALIDA = process.env.CARTELERA_SALIDA
  ? path.resolve(process.env.CARTELERA_SALIDA)
  : path.resolve(BASE, config.salida);

var ADAPTADORES = {
  santafe: require('./fuentes/santafe'),
  eventbrite: require('./fuentes/eventbrite'),
  parana: require('./fuentes/parana')
};

function log(t) {
  process.stdout.write('[' + new Date().toISOString().slice(11, 19) + '] ' + t + '\n');
}

async function correrFuente(clave) {
  var cfg = config.fuentes[clave];
  var adaptador = ADAPTADORES[clave];
  if (!cfg || !cfg.activa || !adaptador) return { nombre: clave, ok: false, saltada: true, eventos: [], nota: (cfg && cfg.motivo) || 'desactivada' };

  try {
    var r = await adaptador.leer(cfg, config);
    var nota = r.crudo + ' registros leídos, ' + r.eventos.length + ' con fecha y ciudad válida';
    if (r.sinFecha) nota += ', ' + r.sinFecha + ' sin fecha explícita (descartados)';
    log(cfg.nombre + ': ' + nota);
    return { nombre: cfg.nombre, ok: true, eventos: r.eventos, crudo: r.crudo, nota: nota };
  } catch (e) {
    log(cfg.nombre + ': ERROR ' + e.message);
    return { nombre: cfg.nombre, ok: false, eventos: [], nota: 'error: ' + e.message };
  }
}

function claveUnica(e) {
  return (e.titulo + '|' + e.ciudad + '|' + e.fecha)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function vigente(e, ahora) {
  if (!e.fecha) return false;
  var fin = new Date(e.fin || (e.fecha + 'T23:59:00')).getTime();
  if (isNaN(fin) || fin < ahora) return false;

  var inicio = new Date(e.fecha + 'T' + (e.hora || '00:00') + ':00').getTime();
  if (!isNaN(inicio) && inicio > ahora + config.ventana_dias * 86400000) return false;
  return true;
}

async function main() {
  var ahora = Date.now();
  var claves = Object.keys(config.fuentes);
  var resultados = [];

  for (var i = 0; i < claves.length; i++) {
    resultados.push(await correrFuente(claves[i]));
  }

  var todos = [];
  var vistos = {};

  resultados.forEach(function (r) {
    r.eventos.forEach(function (e) {
      if (!vigente(e, ahora)) return;
      var k = claveUnica(e);
      if (vistos[k]) return;
      vistos[k] = true;
      todos.push(e);
    });
  });

  todos.sort(function (a, b) {
    var ta = new Date(a.fecha + 'T' + (a.hora || '00:00')).getTime();
    var tb = new Date(b.fecha + 'T' + (b.hora || '00:00')).getTime();
    if (ta !== tb) return ta - tb;
    return a.titulo.localeCompare(b.titulo, 'es');
  });

  var salida = {
    generado: new Date().toISOString(),
    cantidad: todos.length,
    ventana_dias: config.ventana_dias,
    fuentes: resultados.map(function (r) {
      return { nombre: r.nombre, ok: r.ok, nota: r.nota };
    }),
    items: todos
  };

  /* Si no hay eventos no se toca el archivo: se conserva el último JSON bueno.
     Publicar una agenda vacía borraría la cartelera del sitio. */
  if (!todos.length) {
    log('ATENCIÓN: la salida quedó vacía. No se publica; queda el JSON anterior.');
    process.exitCode = 2;
    return;
  }

  var destino = SALIDA;
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, JSON.stringify(salida, null, 2) + '\n', 'utf8');

  log('Listo: ' + todos.length + ' eventos en ' + destino);
}

main().catch(function (e) {
  console.error('Falló el scraper: ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});

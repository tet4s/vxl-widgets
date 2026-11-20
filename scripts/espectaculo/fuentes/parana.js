'use strict';

/**
 * Fuente: Agenda de la Municipalidad de Paraná.
 *
 * La página lista "landings" de programación cultural (espacios, talleres,
 * muestras permanentes). No todas traen una fecha de evento: se incluyen solo
 * las tarjetas que declaran una fecha concreta y se descartan las galerías.
 * Si la página no trae ninguna fecha, la fuente devuelve 0 y lo informa; no se
 * inventan eventos.
 */

var F = require('../lib/fechas');
var N = require('../lib/normalizar');

var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
var MARCA = '<div class="col-lg-4 mb-3 d-flex align-items-stretch">';

var DESCARTAR = /galer[ií]a de fotos|ver v[ií]deo|mapa de redes/i;

async function leer(fuente) {
  var res = await fetch(fuente.url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('La agenda respondió ' + res.status);
  var html = await res.text();

  var partes = html.split(MARCA);
  var eventos = [];
  var sinFecha = 0;

  for (var i = 1; i < partes.length; i++) {
    var b = partes[i];

    var m = b.match(/class="title-card"[^>]*>\s*<a[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/);
    if (!m) continue;

    var href = m[1];
    var titulo = N.limpiar(m[2]);
    if (!titulo || DESCARTAR.test(titulo)) continue;

    var texto = N.limpiar(b);
    var rango = F.rango(texto);
    if (!rango) { sinFecha++; continue; }

    var h = F.horas(texto);
    var todoElDia = F.esTodoElDia(h.hora, h.horaFin);
    var lugar = (texto.match(/(?: en |, )([A-ZÁÉÍÓÚÑ][^.]{3,45})$/) || [])[1] || '';

    eventos.push({
      id: N.id('pr', href.split('/').pop() || titulo),
      titulo: titulo,
      descripcion: '',
      fecha: rango.inicio,
      hora: todoElDia ? '' : h.hora,
      fin: F.finIso(rango.fin, todoElDia ? '' : h.horaFin),
      lugar: lugar,
      ciudad: 'Paraná',
      categoria: N.categoria('', titulo),
      gratis: true,
      precio: '',
      link: '',
      fuente: 'Municipalidad de Paraná',
      fuente_url: href
    });
  }

  return { eventos: eventos, crudo: partes.length - 1, sinFecha: sinFecha };
}

module.exports = { leer: leer };

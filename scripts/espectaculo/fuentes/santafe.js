'use strict';

/**
 * Fuente: Agenda Cultural de Santa Fe Ciudad.
 *
 * La página pública lista las actividades en tarjetas con clases estables
 * (event-card, event-title, event-date, event-time, event-location,
 * event-category, event-cost). No se usa ninguna API: se lee el HTML.
 *
 * Formato de fecha de la fuente: "2 octubre, 2026 - 2 diciembre, 2026"
 */

var F = require('../lib/fechas');
var N = require('../lib/normalizar');

var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

function campo(bloque, clase, cierre) {
  var m = bloque.match(new RegExp('class="' + clase + '"[^>]*>([\\s\\S]*?)</' + (cierre || 'div') + '>'));
  return m ? N.limpiar(m[1]) : '';
}

async function leer(fuente) {
  var res = await fetch(fuente.url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('La agenda respondió ' + res.status);
  var html = await res.text();

  var partes = html.split('<a class="event-card"');
  var vistos = {};
  var eventos = [];

  for (var i = 1; i < partes.length; i++) {
    var b = partes[i];

    var href = (b.match(/href="([^"]+)"/) || [])[1] || '';
    var aria = (b.match(/aria-label="([^"]*)"/) || [])[1] || '';
    var titulo = campo(b, 'event-title', 'h3') || N.limpiar(aria.split('|')[0]);
    if (!titulo || !href) continue;

    var clave = href.replace(/\/$/, '');
    if (vistos[clave]) continue;
    vistos[clave] = true;

    var rango = F.rango(campo(b, 'event-date'));
    if (!rango) continue;

    var h = F.horas(campo(b, 'event-time'));
    var todoElDia = F.esTodoElDia(h.hora, h.horaFin);
    // "17:00–17:00" es un dato roto de la fuente: se toma solo el inicio.
    if (h.horaFin && h.horaFin <= h.hora) h.horaFin = '';
    var fuenteCat = campo(b, 'event-category');
    var gratis = /event-cost--free/.test(b) || /gratuito/i.test(b);
    var precio = gratis ? '' : N.limpiar((b.match(/event-cost__label"[^>]*>([\s\S]*?)</) || [])[1] || '');

    eventos.push({
      id: N.id('sf', clave.split('/evento/')[1] || titulo),
      titulo: N.tituloLimpio(titulo),
      descripcion: '',
      fecha: rango.inicio,
      hora: todoElDia ? '' : h.hora,
      fin: F.finIso(rango.fin, todoElDia ? '' : h.horaFin),
      lugar: campo(b, 'event-location'),
      ciudad: 'Santa Fe',
      categoria: N.categoria(fuenteCat, titulo),
      gratis: gratis,
      precio: precio,
      link: '',
      fuente: 'Agenda Santa Fe Ciudad',
      fuente_url: href
    });
  }

  return { eventos: eventos, crudo: partes.length - 1 };
}

module.exports = { leer: leer };

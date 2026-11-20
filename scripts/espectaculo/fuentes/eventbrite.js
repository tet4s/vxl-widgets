'use strict';

/**
 * Fuente: Eventbrite (listados públicos de Paraná y Santa Fe).
 *
 * La página incluye un bloque JSON-LD schema.org con un ItemList de eventos
 * (nombre, descripción, startDate, endDate, lugar, dirección, precio, URL).
 * Se lee ese bloque, no se scrapea la grilla visual.
 */

var F = require('../lib/fechas');
var N = require('../lib/normalizar');

var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

function bloquesLd(html) {
  var out = [];
  var re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  var m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

function itemsDeLd(html) {
  var bloques = bloquesLd(html);
  for (var i = 0; i < bloques.length; i++) {
    var d;
    try { d = JSON.parse(bloques[i]); } catch (e) { continue; }
    var lista = Array.isArray(d) ? d : [d];
    for (var j = 0; j < lista.length; j++) {
      if (lista[j] && lista[j]['@type'] === 'ItemList' && Array.isArray(lista[j].itemListElement)) {
        return lista[j].itemListElement;
      }
    }
  }
  return [];
}

async function leer(fuente, config) {
  var eventos = [];
  var crudo = 0;
  var ciudades = config.ciudades || [];

  var entradas = Object.keys(fuente.urls || {});
  for (var k = 0; k < entradas.length; k++) {
    var ciudadListado = entradas[k];
    var url = fuente.urls[ciudadListado];

    var res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) continue;
    var html = await res.text();
    var items = itemsDeLd(html);
    crudo += items.length;

    for (var i = 0; i < items.length; i++) {
      var ev = items[i] && items[i].item;
      if (!ev || !ev.name || !ev.startDate) continue;

      var loc = ev.location || {};
      var dir = loc.address || {};
      var ciudad = N.ciudad(dir.addressLocality || '');
      if (!ciudad || ciudades.indexOf(ciudad) === -1) continue;

      var inicio = String(ev.startDate).slice(0, 10);
      var finFecha = ev.endDate ? String(ev.endDate).slice(0, 10) : inicio;
      var horaInicio = String(ev.startDate).length > 10 ? String(ev.startDate).slice(11, 16) : '';
      var horaFin = ev.endDate && String(ev.endDate).length > 10 ? String(ev.endDate).slice(11, 16) : '';

      var precio = '';
      var gratis = false;
      if (ev.offers) {
        var o = Array.isArray(ev.offers) ? ev.offers[0] : ev.offers;
        if (o && o.price !== undefined && o.price !== null && o.price !== '') {
          gratis = Number(o.price) === 0;
          if (!gratis) precio = (o.priceCurrency === 'ARS' ? '$' : '') + o.price;
        }
      }

      eventos.push({
        id: N.id('eb', (ev.url || ev.name).split('/').pop() || ev.name),
        titulo: N.limpiar(ev.name),
        descripcion: N.limpiar(ev.description || '').slice(0, 160),
        fecha: inicio,
        hora: horaInicio,
        fin: F.finIso(finFecha, horaFin),
        lugar: N.limpiar(loc.name || ''),
        ciudad: ciudad,
        categoria: N.categoria('', ev.name + ' ' + (ev.description || '')),
        gratis: gratis,
        precio: precio,
        link: '',
        fuente: 'Eventbrite',
        fuente_url: ev.url || ''
      });
    }
  }

  return { eventos: eventos, crudo: crudo };
}

module.exports = { leer: leer };

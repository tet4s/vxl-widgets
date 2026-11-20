'use strict';

/**
 * Conversión de fechas en texto castellano a ISO (YYYY-MM-DD).
 * Formatos que aparecen en las fuentes:
 *   "2 octubre, 2026"
 *   "20 de noviembre de 2026"
 *   "21 noviembre, 2026 - 23 noviembre, 2026"
 *   "Del viernes 21 al domingo 23 de noviembre"
 */

var MESES = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10,
  noviembre: 11, diciembre: 12
};

function dos(n) {
  return n < 10 ? '0' + n : '' + n;
}

function iso(anio, mes, dia) {
  if (!mes || !dia) return '';
  return anio + '-' + dos(mes) + '-' + dos(dia);
}

/** Busca "día de mes (de año)" dentro de un texto y devuelve {dia, mes, anio}. */
function unaFecha(texto, anioDefecto) {
  var t = String(texto || '').toLowerCase();
  var m = t.match(/(\d{1,2})\s*(?:de\s+)?([a-záéíóúñ]+)(?:\s*(?:de|,)?\s*(\d{4}))?/);
  if (!m) return null;
  var mes = MESES[m[2]];
  if (!mes) return null;
  return { dia: parseInt(m[1], 10), mes: mes, anio: m[3] ? parseInt(m[3], 10) : anioDefecto };
}

/** Todas las fechas del texto, en orden de aparición. */
function todas(texto, anioDefecto) {
  var t = String(texto || '').toLowerCase();
  var re = /(\d{1,2})\s*(?:de\s+)?([a-záéíóúñ]+)(?:\s*(?:de|,)?\s*(\d{4}))?/g;
  var out = [];
  var m;
  while ((m = re.exec(t)) !== null) {
    var mes = MESES[m[2]];
    if (!mes) continue;
    out.push({ dia: parseInt(m[1], 10), mes: mes, anio: m[3] ? parseInt(m[3], 10) : anioDefecto });
  }
  return out;
}

/**
 * Rango de fechas de un texto tipo "2 octubre, 2026 - 2 diciembre, 2026"
 * o "20 de noviembre de 2026". Devuelve {inicio:'YYYY-MM-DD', fin:'YYYY-MM-DD'}.
 */
function rango(texto, anioDefecto) {
  var anio = anioDefecto || new Date().getFullYear();
  var fs = todas(texto, anio);
  if (!fs.length) return null;

  var ini = fs[0];
  var fin = fs.length > 1 ? fs[fs.length - 1] : fs[0];

  // Si el año no venía en el texto, un rango que "retrocede" cruzó el año.
  var inicio = iso(ini.anio, ini.mes, ini.dia);
  var finIso = iso(fin.anio, fin.mes, fin.dia);
  if (finIso < inicio) {
    finIso = iso(fin.anio + 1, fin.mes, fin.dia);
  }
  return { inicio: inicio, fin: finIso };
}

/** "19:00–23:00" / "21 hs" / "a las 20:30" → {hora:'19:00', horaFin:'23:00'} */
function horas(texto) {
  var t = String(texto || '');
  var m = t.match(/(\d{1,2})[:.](\d{2})\s*(?:[–\-—]|a|hs?|h\b)\s*(\d{1,2})[:.](\d{2})/);
  if (m) {
    return { hora: dos(+m[1]) + ':' + m[2], horaFin: dos(+m[3]) + ':' + m[4] };
  }
  var s = t.match(/(\d{1,2})[:.](\d{2})/);
  if (s) return { hora: dos(+s[1]) + ':' + s[2], horaFin: '' };
  var h = t.match(/(\d{1,2})\s*(?:hs?|horas)\b/);
  if (h) return { hora: dos(+h[1]) + ':00', horaFin: '' };
  return { hora: '', horaFin: '' };
}

/** "00:00–00:00" no es un horario: es un evento de todo el día. */
function esTodoElDia(hora, horaFin) {
  return (!hora || hora === '00:00') && (!horaFin || horaFin === '00:00' || horaFin === '23:59');
}

/** Momento de finalización: si hay hora de fin, ese día y hora; si no, fin del último día. */
function finIso(fechaFin, horaFin) {
  if (!fechaFin) return '';
  if (horaFin && horaFin !== '00:00') return fechaFin + 'T' + horaFin;
  return fechaFin + 'T23:59';
}

function hoyISO() {
  var d = new Date();
  return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function sumarDias(isoFecha, dias) {
  var p = isoFecha.split('-');
  var d = new Date(+p[0], +p[1] - 1, +p[2]);
  d.setDate(d.getDate() + dias);
  return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

module.exports = {
  MESES: MESES,
  unaFecha: unaFecha,
  todas: todas,
  rango: rango,
  horas: horas,
  esTodoElDia: esTodoElDia,
  finIso: finIso,
  hoyISO: hoyISO,
  sumarDias: sumarDias,
  iso: iso,
  dos: dos
};

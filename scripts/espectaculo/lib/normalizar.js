'use strict';

/**
 * Normalización común: categoría, ciudad y limpieza de textos.
 * Las categorías son la lista cerrada del proyecto (sin deportes).
 */

var CATEGORIAS = {
  musica: 'Música',
  teatro: 'Teatro',
  ferias: 'Ferias y artesanos',
  gastronomia: 'Gastronomía',
  charlas: 'Charlas y conferencias',
  muestras: 'Muestras y exposiciones',
  infantiles: 'Infantiles',
  fiestas: 'Fiestas populares',
  talleres: 'Talleres y capacitaciones'
};

/* Palabras que definen la categoría. El orden importa: gana la primera que aparece. */
var REGLAS = [
  ['infantiles', /\b(infantil|niñ[oa]s|para toda la familia|títeres|payaso)/i],
  ['ferias', /\b(feria|artesanos?|mercado|emprendedor)/i],
  ['gastronomia', /\b(gastronom|degustaci|cerveza|vino|food|asado|picada|sabores)/i],
  ['talleres', /\b(taller|curso|capacitaci|clase|jornada de formaci|inscripci)/i],
  ['teatro', /\b(teatro|obra|dramaturg|comedia|circo|danza|ballet|títere)/i],
  ['musica', /\b(música|musica|recital|concierto|banda|jazz|tango|milonga|peña|rock|cumbia|folclore|folklore|sinfónic|orquesta|coral|dj|ensamble)/i],
  ['muestras', /\b(muestra|exposici|galería|galeria|museo|arte|plástic|fotograf)/i],
  ['fiestas', /\b(fiesta|carnaval|aniversario|celebraci|peña|patronal)/i],
  ['charlas', /\b(charla|conferencia|seminario|congreso|coloquio|conversatorio|encuentro|presentaci|jornada|acto|colaci)/i]
];

/* Categorías tal como las publica cada fuente. */
var POR_FUENTE = {
  'feria': 'ferias',
  'cultura': '',
  'cultura, educación': 'charlas',
  'cultura, educacion': 'charlas',
  'música': 'musica',
  'musica': 'musica',
  'teatro': 'teatro',
  'danza': 'teatro',
  'exposición': 'muestras',
  'exposicion': 'muestras',
  'muestra': 'muestras',
  'gastronomía': 'gastronomia',
  'gastronomia': 'gastronomia',
  'infantil': 'infantiles',
  'taller': 'talleres'
};

function limpiar(t) {
  return String(t == null ? '' : t)
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&aacute;/g, 'á')
    .replace(/&eacute;/g, 'é')
    .replace(/&iacute;/g, 'í')
    .replace(/&oacute;/g, 'ó')
    .replace(/&uacute;/g, 'ú')
    .replace(/&ntilde;/g, 'ñ')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function categoria(textoFuente, titulo) {
  var f = limpiar(textoFuente).toLowerCase();
  if (POR_FUENTE.hasOwnProperty(f) && POR_FUENTE[f]) return POR_FUENTE[f];

  var base = limpiar(titulo) + ' ' + f;
  for (var i = 0; i < REGLAS.length; i++) {
    if (REGLAS[i][1].test(base)) return REGLAS[i][0];
  }
  return 'muestras';
}

/* Nombres de ciudad que devuelven las fuentes → nombres del proyecto. */
var CIUDADES = {
  'paraná': 'Paraná',
  'parana': 'Paraná',
  'santa fe': 'Santa Fe',
  'santa fe de la vera cruz': 'Santa Fe',
  'santo tomé': 'Santo Tomé (SF)',
  'santo tome': 'Santo Tomé (SF)',
  'oro verde': 'Oro Verde (ER)',
  'crespo': 'Crespo (ER)',
  'sauce viejo': 'Sauce Viejo (SF)'
};

function ciudad(valor, porDefecto) {
  var v = limpiar(valor).toLowerCase();
  if (CIUDADES[v]) return CIUDADES[v];
  var claves = Object.keys(CIUDADES);
  for (var i = 0; i < claves.length; i++) {
    if (v.indexOf(claves[i]) !== -1) return CIUDADES[claves[i]];
  }
  return porDefecto || '';
}

/** Saca el "| Categoría" que la agenda de Santa Fe pega al final del título. */
function tituloLimpio(t) {
  return limpiar(t).replace(/\s*\|\s*(muestra|teatro|música|musica|feria|danza|exposición|exposicion)\s*$/i, '').trim();
}

function id(prefijo, texto) {
  var base = limpiar(texto)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return prefijo + '-' + base;
}

module.exports = {
  CATEGORIAS: CATEGORIAS,
  limpiar: limpiar,
  categoria: categoria,
  ciudad: ciudad,
  tituloLimpio: tituloLimpio,
  id: id
};

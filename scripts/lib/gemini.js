'use strict';
/**
 * Cliente único de Gemini para los tres scrapers que reescriben titulares
 * (política, policiales y bolsillo).
 *
 * - Espacia las llamadas: 60.000 / GEMINI_RPM ms entre request y request.
 *   Por defecto 8 RPM, por debajo del límite gratuito de Flash (10 RPM).
 * - Cortacircuito: ante un 429 (o cuota agotada) deja de llamar por el resto
 *   de la corrida. Los scrapers publican el titular original.
 * - Validación anti-invención: números y nombres propios del titular reescrito
 *   tienen que existir en la fuente; se rechazan ganchos y clickbait.
 */

const axios = require('axios');

const MODELOS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
const RPM = Math.max(1, parseInt(process.env.GEMINI_RPM, 10) || 8);
const MIN_MS = Math.ceil(60000 / RPM);

let ultimaLlamada = 0;
let abierto = false;
let motivo = '';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function estado() { return { abierto, motivo, rpm: RPM }; }

function abrirCircuito(m) {
  if (!abierto) {
    abierto = true;
    motivo = String(m || '');
    console.warn('[ia] cortacircuito activo (' + motivo + '): no se reescribe más en esta corrida');
  }
}

async function esperarTurno() {
  const falta = MIN_MS - (Date.now() - ultimaLlamada);
  if (falta > 0) await sleep(falta);
  ultimaLlamada = Date.now();
}

async function pedir(prompt, opts) {
  opts = opts || {};
  const key = process.env.GEMINI_API_KEY || '';
  if (!key || abierto) return null;

  const maxTokens = opts.maxTokens || 400;
  for (const modelo of MODELOS) {
    await esperarTurno();
    const generationConfig = {
      temperature: opts.temperature != null ? opts.temperature : 0.25,
      maxOutputTokens: maxTokens
    };
    if (modelo.indexOf('2.5') === 0) generationConfig.thinkingConfig = { thinkingBudget: 0 };
    try {
      const r = await axios.post(
        'https://generativelanguage.googleapis.com/v1beta/models/' + modelo +
        ':generateContent?key=' + encodeURIComponent(key),
        { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig },
        { timeout: opts.timeout || 45000, headers: { 'Content-Type': 'application/json' } }
      );
      const cand = r.data && r.data.candidates && r.data.candidates[0];
      const txt = (cand && cand.content && cand.content.parts || []).map(p => p.text || '').join('');
      if (txt.trim()) return txt;
      console.warn('[ia] ' + modelo + ': respuesta vacía, se prueba el siguiente modelo');
    } catch (e) {
      const st = e.response && e.response.status;
      const det = e.response && e.response.data ? JSON.stringify(e.response.data).slice(0, 160) : e.message;
      if (st === 429) { abrirCircuito('429 cuota'); return null; }
      if (st === 403) { abrirCircuito('403 permiso/cuota'); return null; }
      if ((st === 400 || st === 401) && /api key|invalid_argument|unauthorized/i.test(det)) {
        abrirCircuito(st + ' clave inválida'); return null;
      }
      if (st && st >= 500) { console.warn('[ia] ' + modelo + ': ' + st + ', reintento'); await sleep(3000); continue; }
      console.warn('[ia] ' + modelo + ': ' + (st || e.message) + ' — ' + det);
    }
  }
  return null;
}

/* ------------------------------------------------------------------ validación */

const GANCHO = /\b(no vas a creer|no te lo pierdas|imperdible|incre[ií]ble|ins[oó]lito|impactante|brutal|bomba|esc[aá]ndalo|[uú]ltimo momento|urgente|mir[aá]|mir[aá] esto|as[ií] fue|as[ií] reaccion[oó]|qu[eé] dijo|lo que hay que|esto es lo que|el motivo|la raz[oó]n|por qu[eé]|atenci[oó]n|en vivo|minuto a minuto|video|galer[ií]a de fotos|te contamos|enterate)\b/i;

function limpiar(t) {
  return String(t || '')
    .replace(/[\u201C\u201D\u2018\u2019"]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/[.\s]+$/, '')
    .trim();
}

function numeros(t) {
  return new Set((String(t).match(/\d+(?:[.,]\d+)*/g) || []).map(function (n) {
    return n.replace(/[.,](?=\d)/g, '');
  }));
}

function palabras(t) {
  return String(t).toLowerCase().replace(/[^a-z0-9áéíóúñü ]+/gi, ' ').split(/\s+/).filter(Boolean);
}

function nombresPropios(t) {
  const out = [];
  String(t).split(/\s+/).forEach(function (w, i) {
    const limpio = w.replace(/^[¿¡"“«(]+/, '');
    if (i > 0 && /^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}/.test(limpio)) out.push(limpio.toLowerCase());
  });
  return out;
}

/**
 * Devuelve el titular limpio o null si no pasa el control.
 * item: { titulo, resumen } de la noticia original.
 */
function validarTitular(nuevo, item, opts) {
  opts = opts || {};
  const max = opts.max || 160;
  const min = opts.min || 40;
  const n = limpiar(nuevo);
  if (!n) return null;
  if (n.length < min || n.length > max) return null;

  const fuente = ((item && item.titulo) || '') + ' ' + ((item && (item.resumen || item.descripcion)) || '');
  const fuenteMin = ' ' + limpiar(fuente).toLowerCase() + ' ';

  if (/[!?¿¡]/.test(n)) return null;
  if (/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u.test(n)) return null;
  if (/(\.\.\.|…)$/.test(n)) return null;
  if (GANCHO.test(n)) return null;

  // No inventar cifras: cada número del titular tiene que estar en la fuente.
  const numsFuente = numeros(fuente);
  for (const num of numeros(n)) if (!numsFuente.has(num)) return null;

  // No inventar nombres propios (se saltea la primera palabra, que va en mayúscula).
  const primera = n.split(/\s+/)[0].toLowerCase();
  for (const w of nombresPropios(n)) {
    if (w === primera) continue;
    if (fuenteMin.indexOf(' ' + w) === -1) return null;
  }

  // Tiene que compartir al menos dos palabras de contenido con la fuente.
  const contenido = palabras(fuente).filter(w => w.length > 4);
  const base = new Set(contenido);
  const propias = palabras(n).filter(w => w.length > 4);
  const comunes = propias.filter(w => base.has(w)).length;
  if (!propias.length || comunes < Math.min(2, propias.length)) return null;

  return n;
}

module.exports = { pedir, validarTitular, limpiar, estado };

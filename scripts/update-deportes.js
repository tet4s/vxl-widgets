#!/usr/bin/env node
/**
 * update-deportes.js — datos de deportes para los widgets del Litoral (VXL)
 *
 * Arma `data/deportes.json` con, para cada deporte y cada ciudad:
 *   - las ligas/divisiones disponibles y, por cada una, la tabla de posiciones
 *   - el último partido y los últimos resultados del equipo destacado
 *   - por equipo: su último partido y su próximo partido (para el detalle al hacer clic)
 *   - el movimiento de posiciones (flechas ▲▼) contra el último cambio real
 *
 * Fuentes (todas públicas, sin clave):
 *   Fútbol  → API pública de ESPN (site.api.espn.com)
 *   Básquet → laliganacional.com.ar (AdC, oficial)
 *   Rugby   → usr.org.ar (Unión Santafesina, oficial) con respaldo en Wikipedia
 *
 * Uso:  node scripts/update-deportes.js
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT_FILE = path.join(DATA_DIR, 'deportes.json');
const HIST_FILE = path.join(DATA_DIR, 'deportes-historial.json');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ---------------------------------------------------------------- configuración
// Ciudades del Litoral que atiende el widget. Las coordenadas se usan en el
// front para resolver la ciudad por IP (la más cercana al punto geolocalizado).
const CIUDADES = [
  { id: 'parana', nombre: 'Paraná', provincia: 'Entre Ríos', lat: -31.7333, lon: -60.5294 },
  { id: 'santa_fe', nombre: 'Santa Fe', provincia: 'Santa Fe', lat: -31.6333, lon: -60.7 },
];

// Ligas por ciudad: no "la liga más famosa", sino la del equipo más relevante de
// cada ciudad. `equipos` puede traer alias separados por "|".
const DEPORTES = {
  futbol: {
    id: 'futbol',
    nombre: 'Fútbol',
    metrica: 'PTS',
    ciudades: {
      parana: {
        fuente: 'espn',
        liga: 'arg.2',
        ligaNombre: 'Primera Nacional',
        equipos: ['Patronato'],
      },
      santa_fe: {
        fuente: 'espn',
        liga: 'arg.1',
        ligaNombre: 'Liga Profesional',
        equipos: ['Unión (Santa Fe)|Unión'],
      },
    },
  },
  basquet: {
    id: 'basquet',
    nombre: 'Básquet',
    metrica: 'PTS',
    ciudades: {
      parana: {
        fuente: 'laliga',
        grupo: 'CONFERENCIA SUR',
        ligaNombre: 'Liga Argentina',
        equipos: ['ROCAMORA', 'CENTRAL ENTERRIANO'],
        nota: 'Entre Ríos',
      },
      santa_fe: {
        fuente: 'laliga',
        grupo: 'CONFERENCIA NORTE',
        ligaNombre: 'Liga Argentina',
        equipos: ['UNION (SF)'],
      },
    },
  },
  rugby: {
    id: 'rugby',
    nombre: 'Rugby',
    metrica: 'PTS',
    ciudades: {
      // Los clubes del Litoral se reparten entre el Top 10 y la Segunda División.
      // El widget muestra por defecto la división donde juega la mayoría y deja
      // pestañas para cambiar de división cuando hay datos de más de una.
      parana: {
        fuente: 'rugby',
        ligaNombre: 'Regional del Litoral',
        equipos: ['CAE|Estudiantes de Paraná', 'PARANA ROWING', 'TILCARA'],
        divisiones: [
          { id: 'top10', nombre: 'Top 10', grupo: 'TRL 1 nivel' },
          { id: 'segunda', nombre: 'Segunda', grupo: 'TRL 2 nivel' },
        ],
      },
      santa_fe: {
        fuente: 'rugby',
        ligaNombre: 'Regional del Litoral',
        equipos: ['SANTA FE RC', 'CRAI', 'UNIVERSITARIO (SF)'],
        divisiones: [
          { id: 'top10', nombre: 'Top 10', grupo: 'TRL 1 nivel' },
          { id: 'segunda', nombre: 'Segunda', grupo: 'TRL 2 nivel' },
        ],
      },
    },
  },
};

// ---------------------------------------------------------------- utilidades

const sinAcentos = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

/**
 * Limpia texto de las fuentes: quita caracteres invisibles (zero-width, LRM),
 * normaliza NBSP y colapsa espacios. Sin esto, un nombre con un carácter raro
 * fuerza al navegador a usar otra tipografía y la tabla se ve distinta.
 */
const limpiar = (s) =>
  String(s == null ? '' : s)
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const norm = (s) =>
  sinAcentos(limpiar(s))
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

const tokens = (s) => norm(s).split(' ').filter(Boolean);

/** ¿El nombre del equipo de la fuente corresponde al equipo configurado? */
function coincide(nombreFuente, nombreConfig) {
  if (String(nombreConfig).includes('|')) {
    return String(nombreConfig)
      .split('|')
      .some((alias) => coincide(nombreFuente, alias.trim()));
  }
  const a = tokens(nombreFuente);
  const b = tokens(nombreConfig);
  if (!a.length || !b.length) return false;
  if (a.join(' ') === b.join(' ')) return true;
  let i = 0;
  for (const t of a) {
    if (t === b[i]) i++;
    if (i === b.length) return true;
  }
  return false;
}

const hayEquipo = (nombreFuente, lista) => (lista || []).some((c) => coincide(nombreFuente, c));

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const slug = (s) => norm(s).toLowerCase().replace(/\s+/g, '-');

async function getJson(url, timeout = 25000) {
  const { data } = await axios.get(url, {
    timeout,
    headers: { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*' },
  });
  return data;
}

async function getHtml(url, timeout = 30000) {
  const { data } = await axios.get(url, {
    timeout,
    responseType: 'text',
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'es-AR,es;q=0.9',
    },
  });
  return data;
}

/** Corre `fn` sobre `items` con concurrencia limitada. */
async function enParalelo(items, limite, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limite, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (e) {
        out[idx] = null;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
}

function partidoDesde({ fecha, contexto, local, visitante, gl, gv }) {
  if (!local || !visitante) return null;
  // Un partido con fecha futura nunca está jugado, aunque la fuente muestre 0-0
  // como marcador provisorio (pasa en el fixture de La Liga Argentina).
  const futuro = fecha ? new Date(fecha).getTime() > Date.now() + 2 * 3600 * 1000 : false;
  const jugado = !futuro && gl !== null && gl !== undefined;
  return {
    fecha: fecha || null,
    contexto: limpiar(contexto) || null,
    local: limpiar(local),
    visitante: limpiar(visitante),
    marcador_local: jugado ? gl : null,
    marcador_visitante: jugado ? gv : null,
    estado: jugado ? 'finalizado' : 'programado',
  };
}

/** Le pega los escudos a un partido cuando la fuente los da. */
function conLogos(p, mapa) {
  if (!p) return p;
  p.logo_local = mapa[slug(p.local)] || null;
  p.logo_visitante = mapa[slug(p.visitante)] || null;
  return p;
}

// ---------------------------------------------------------------- fútbol (ESPN)

function statVal(entry, name) {
  const s = (entry.stats || []).find((x) => x.name === name);
  if (!s) return null;
  const v = s.value !== undefined && s.value !== null ? s.value : s.displayValue;
  return num(v);
}

function competitorScore(c) {
  const s = c && c.score;
  if (s === null || s === undefined) return null;
  if (typeof s === 'object') return num(s.displayValue !== undefined ? s.displayValue : s.value);
  return num(s);
}

function limpiarContexto(nombre) {
  if (!nombre) return null;
  return limpiar(
    String(nombre)
      .replace(/\s*-\s*/g, ' · ')
      .replace(/Regular Season/i, 'Fase regular')
      .replace(/Torneo Reducido/i, 'Reducido')
      .replace(/Quarterfinals/i, 'Cuartos de final')
      .replace(/Semifinals/i, 'Semifinales')
      .replace(/First Round/i, 'Primera fase')
      .replace(/Final\b/i, 'Final')
  );
}

function eventoEspn(ev) {
  const c = ev.competitions && ev.competitions[0];
  if (!c) return null;
  const local = c.competitors.find((x) => x.homeAway === 'home') || c.competitors[0];
  const visitante = c.competitors.find((x) => x.homeAway === 'away') || c.competitors[1];
  if (!local || !visitante) return null;
  const completado = !!(c.status && c.status.type && c.status.type.completed);
  return partidoDesde({
    fecha: ev.date,
    contexto: limpiarContexto(ev.seasonType && ev.seasonType.name),
    local: local.team.displayName,
    visitante: visitante.team.displayName,
    gl: completado ? competitorScore(local) : null,
    gv: completado ? competitorScore(visitante) : null,
  });
}

async function desdeEspn(cfg) {
  const base = 'https://site.api.espn.com/apis/v2/sports/soccer';
  const st = await getJson(`${base}/${cfg.liga}/standings`);
  const temporada = String((st.season && st.season.year) || new Date().getFullYear());

  let grupo = null;
  for (const ch of st.children || []) {
    for (const e of (ch.standings && ch.standings.entries) || []) {
      if (hayEquipo(e.team.displayName, cfg.equipos)) {
        grupo = ch;
        break;
      }
    }
    if (grupo) break;
  }
  if (!grupo) throw new Error(`${cfg.ligaNombre}: no encontré a ${cfg.equipos.join(' / ')} en la tabla`);

  const rows = (grupo.standings.entries || []).map((e) => ({
    pos: statVal(e, 'rank'),
    equipo: limpiar(e.team.displayName),
    equipo_id: e.team.id || null,
    logo: (e.team.logos && e.team.logos[0] && e.team.logos[0].href) || null,
    pj: statVal(e, 'gamesPlayed'),
    g: statVal(e, 'wins'),
    e: statVal(e, 'ties'),
    p: statVal(e, 'losses'),
    gf: statVal(e, 'pointsFor'),
    gc: statVal(e, 'pointsAgainst'),
    dg: statVal(e, 'pointDifferential'),
    pts: statVal(e, 'points'),
    cambio_fuente: statVal(e, 'rankChange'),
  }));
  rows.sort((a, b) => (a.pos ?? 999) - (b.pos ?? 999) || (b.pts ?? 0) - (a.pts ?? 0));
  rows.forEach((r, i) => {
    if (r.pos === null || r.pos === undefined) r.pos = i + 1;
  });

  // Fixture por equipo (para el detalle al hacer clic en una fila)
  await enParalelo(rows, 6, async (r) => {
    if (!r.equipo_id) return null;
    try {
      const sch = await getJson(
        `https://site.api.espn.com/apis/site/v2/sports/soccer/${cfg.liga}/teams/${r.equipo_id}/schedule?season=${temporada}`
      );
      const partidos = (sch.events || []).map(eventoEspn).filter(Boolean);
      const jugados = partidos
        .filter((p) => p.estado === 'finalizado')
        .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
      const pendientes = partidos
        .filter((p) => p.estado !== 'finalizado')
        .sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
      r.ultimo = jugados[0] || null;
      r.proximo = pendientes[0] || null;
      return null;
    } catch {
      r.ultimo = null;
      r.proximo = null;
      return null;
    }
  });

  // Equipo destacado: su último partido y sus últimos resultados
  const propio = rows.find((r) => hayEquipo(r.equipo, cfg.equipos));
  let partido = null;
  let ultimos = [];
  if (propio && propio.equipo_id) {
    try {
      const sch = await getJson(
        `https://site.api.espn.com/apis/site/v2/sports/soccer/${cfg.liga}/teams/${propio.equipo_id}/schedule?season=${temporada}`
      );
      const jugados = (sch.events || [])
        .map(eventoEspn)
        .filter((p) => p && p.estado === 'finalizado')
        .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
      ultimos = jugados.slice(0, 6);
      partido = ultimos[0] || null;
    } catch (e) {
      log('  ! sin fixture de', propio.equipo, e.message);
    }
  }

  const zona = grupo.name ? grupo.name.replace(/^Group\s*/i, 'Zona ') : null;

  // Escudos por equipo (salen de la tabla) para la barra y el detalle
  const escudos = {};
  rows.forEach((r) => {
    if (r.logo) escudos[slug(r.equipo)] = r.logo;
    if (r.ultimo) conLogos(r.ultimo, escudos);
    if (r.proximo) conLogos(r.proximo, escudos);
  });
  // Segundo paso: con el mapa completo (los escudos se van llenando arriba)
  rows.forEach((r) => {
    if (r.ultimo) conLogos(r.ultimo, escudos);
    if (r.proximo) conLogos(r.proximo, escudos);
  });
  conLogos(partido, escudos);
  ultimos.forEach((p) => conLogos(p, escudos));

  return {
    ligas: [
      {
        id: 'principal',
        nombre: cfg.ligaNombre,
        zona,
        temporada,
        fuente: 'ESPN',
        url:
          cfg.liga === 'arg.1'
            ? 'https://www.espn.com.ar/futbol/argentina/primera'
            : 'https://www.espn.com.ar/futbol/argentina/segunda',
        tabla: rows,
        partido,
        ultimos,
      },
    ],
  };
}

// ---------------------------------------------------------------- básquet (AdC)

let laligaCache = null;

async function laligaFase() {
  if (laligaCache) return laligaCache;
  const html = await getHtml('https://www.laliganacional.com.ar/laligaargentina/tabla-posiciones');
  const $ = cheerio.load(html);
  let faseId = null;
  $('#select-fase option').each((_, o) => {
    const v = $(o).attr('value');
    if (!faseId && v) faseId = v;
  });
  if (!faseId) throw new Error('No pude leer la fase de La Liga Argentina');
  const grupos = await getJson(`https://www.laliganacional.com.ar/api/clasificacion/${faseId}/grupos`);
  laligaCache = { faseId, grupos };
  return laligaCache;
}

async function desdeLaLiga(cfg) {
  const { faseId, grupos } = await laligaFase();
  const grupo =
    grupos.find((g) => norm(g.nombre) === norm(cfg.grupo)) ||
    grupos.find((g) => norm(g.nombre).includes(norm(cfg.grupo)));
  if (!grupo) throw new Error(`La Liga Argentina: no encontré ${cfg.grupo}`);

  const html = await getHtml(
    `https://www.laliganacional.com.ar/laligaargentina/tabla-posiciones?handler=Clasificacion&faseId=${faseId}&grupoId=${grupo.idGrupo}`
  );
  const $ = cheerio.load(html);
  const rows = [];
  $('tr.datos-estadisticos').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 8) return;
    const txt = (i) => limpiar($(tds[i]).text());
    const logoRel = $(tds[1]).find('img').attr('src') || null;
    rows.push({
      pos: num(txt(0)),
      equipo: txt(1),
      logo: logoRel ? `https://www.laliganacional.com.ar${logoRel}` : null,
      pj: num(txt(2)),
      g: num(txt(3)),
      p: num(txt(4)),
      gf: num(txt(5)),
      gc: num(txt(6)),
      pts: num(txt(7)),
      pct: txt(8) || null,
      ultimo: null,
      proximo: null,
      cambio_fuente: null,
    });
  });
  if (rows.length < 5) throw new Error('La Liga Argentina: tabla vacía');

  const zonaTxt = cfg.grupo
    .toLowerCase()
    .replace('conferencia ', 'Conferencia ')
    .replace(/(^|\s)([a-záéíóú])/g, (m, a, b) => a + b.toUpperCase());

  // Fixture: 60 días atrás y 30 adelante (resultados + próximos partidos)
  const hoy = new Date();
  const desde = new Date(hoy.getTime() - 60 * 24 * 3600 * 1000);
  const hasta = new Date(hoy.getTime() + 30 * 24 * 3600 * 1000);
  const iso = (d) => d.toISOString().slice(0, 10);
  const partidos = [];
  const escudos = {};
  try {
    const fx = await getHtml(
      `https://www.laliganacional.com.ar/laligaargentina/fixture?handler=ProximosPartidos&fechaInicio=${iso(
        desde
      )}&fechaFin=${iso(hasta)}`
    );
    const $$ = cheerio.load(fx);
    $$('tr.fila-tabla-calendarios').each((_, tr) => {
      const local = $$(tr).find('.celda-nombre.text-start .nombre-equipo').first().text();
      const visit = $$(tr).find('.celda-nombre.text-end .nombre-equipo').first().text();
      const marc = $$(tr).find('td.resultados strong');
      const gl = marc.length >= 1 ? num(marc.eq(0).text()) : null;
      const gv = marc.length >= 2 ? num(marc.eq(1).text()) : null;
      const fechaTxt = $$(tr).find('.fecha-campo strong').first().text().trim(); // dd/mm/yyyy HH:MM
      const m = fechaTxt.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
      if (!limpiar(local) || !limpiar(visit) || !m) return;
      const esc = $$(tr).find('.celda-escudo img');
      if (esc.length >= 1 && esc.eq(0).attr('src')) {
        escudos[slug(local)] = `https://www.laliganacional.com.ar${esc.eq(0).attr('src')}`;
      }
      if (esc.length >= 2 && esc.eq(1).attr('src')) {
        escudos[slug(visit)] = `https://www.laliganacional.com.ar${esc.eq(1).attr('src')}`;
      }
      partidos.push(
        partidoDesde({
          fecha: `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00-03:00`,
          contexto: zonaTxt,
          local,
          visitante: visit,
          gl,
          gv,
        })
      );
    });
  } catch (e) {
    log('  ! sin fixture de básquet', e.message);
  }

  const conFecha = (p) => p && p.fecha && !isNaN(new Date(p.fecha));
  const jugados = partidos
    .filter((p) => p && p.estado === 'finalizado' && conFecha(p))
    .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
  const pendientes = partidos
    .filter((p) => p && p.estado !== 'finalizado' && conFecha(p))
    .sort((a, b) => new Date(a.fecha) - new Date(b.fecha));

  const porEquipo = {};
  const tocar = (nombre) => {
    const k = slug(nombre);
    if (!porEquipo[k]) porEquipo[k] = { ultimo: null, proximo: null };
    return porEquipo[k];
  };
  jugados.forEach((p) => {
    [p.local, p.visitante].forEach((n) => {
      const d = tocar(n);
      if (!d.ultimo) d.ultimo = p;
    });
  });
  pendientes.forEach((p) => {
    [p.local, p.visitante].forEach((n) => {
      const d = tocar(n);
      if (!d.proximo) d.proximo = p;
    });
  });

  rows.forEach((r) => {
    const d = porEquipo[slug(r.equipo)];
    r.ultimo = d ? d.ultimo : null;
    r.proximo = d ? d.proximo : null;
  });

  // Escudos: la tabla los tiene todos, el fixture los va completando
  rows.forEach((r) => {
    if (r.logo) escudos[slug(r.equipo)] = r.logo;
  });
  rows.forEach((r) => {
    if (r.ultimo) conLogos(r.ultimo, escudos);
    if (r.proximo) conLogos(r.proximo, escudos);
  });

  const propios = jugados.filter((p) => hayEquipo(p.local, cfg.equipos) || hayEquipo(p.visitante, cfg.equipos));
  const ultimos = (propios.length ? propios : jugados).slice(0, 6);
  const partido = ultimos[0] || null;
  conLogos(partido, escudos);
  ultimos.forEach((p) => conLogos(p, escudos));

  return {
    ligas: [
      {
        id: 'principal',
        nombre: cfg.ligaNombre,
        zona: zonaTxt,
        temporada: String(new Date().getFullYear()),
        fuente: 'AdC',
        url: 'https://www.laliganacional.com.ar/laligaargentina',
        nota: cfg.nota || null,
        tabla: rows,
        partido,
        ultimos,
      },
    ],
  };
}

// ---------------------------------------------------------------- rugby (TRL)

const MESES = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

function fechaDesdeTexto(txt, anio) {
  const m = String(txt || '').match(/(\d{1,2})\s+de\s+([a-záéíóú]+)/i);
  if (!m) return null;
  const dia = Number(m[1]);
  const mes = MESES[sinAcentos(m[2]).toLowerCase()];
  if (!dia || !mes) return null;
  return new Date(Date.UTC(anio, mes - 1, dia, 21, 0, 0)).toISOString();
}

/** Lee todas las tablas de usr.org.ar/tablas-trl/ agrupadas por división. */
async function rugbyUsrTablas() {
  const html = await getHtml('https://usr.org.ar/tablas-trl/');
  const $ = cheerio.load(html);
  let nivel = null;
  let categoria = null;
  const salida = [];

  $('h2, h3, h4, table.gsheet-data-table').each((_, el) => {
    const tag = String(el.tagName || el.name || '').toLowerCase();
    if (tag === 'table') {
      if (!nivel || !/primera/i.test(categoria || '')) return;
      const rows = [];
      $(el)
        .find('tbody tr')
        .each((__, tr) => {
          const tds = $(tr).find('td');
          if (tds.length < 3) return;
          const nombre = limpiar($(tds[1]).text());
          const logoRel = $(tds[0]).find('img').attr('src') || null;
          if (!nombre) return;
          rows.push({
            pos: rows.length + 1,
            equipo: nombre,
            logo: logoRel ? (logoRel.startsWith('http') ? logoRel : `https://usr.org.ar${logoRel}`) : null,
            pj: num($(tds[tds.length - 2]).text()),
            pts: num($(tds[tds.length - 1]).text()),
            g: null,
            e: null,
            p: null,
            dg: null,
            ultimo: null,
            proximo: null,
            cambio_fuente: null,
          });
        });
      if (rows.length >= 4) salida.push({ nivel, categoria, rows });
      return;
    }
    const t = limpiar($(el).text());
    if (/TRL/i.test(t)) {
      nivel = t;
      categoria = null;
    } else if (nivel) {
      categoria = t;
    }
  });

  return salida;
}

async function rugbyWikipedia(anio) {
  const api =
    'https://es.wikipedia.org/w/api.php?action=parse&format=json&formatversion=2&origin=*&page=' +
    encodeURIComponent(`Torneo Regional del Litoral ${anio}`) +
    '&prop=text';
  const data = await getJson(api);
  if (!data.parse || !data.parse.text) throw new Error(`Wikipedia: no hay página del TRL ${anio}`);
  const $ = cheerio.load(data.parse.text);

  let tabla = null;
  $('table').each((_, t) => {
    if (tabla) return;
    const head = $(t).find('tr').first().text().replace(/\s+/g, ' ');
    if (/PJ/.test(head) && /Puntos/i.test(head) && /Equipo/i.test(head)) tabla = t;
  });
  if (!tabla) throw new Error('Wikipedia: no encontré la tabla de posiciones');

  const headCells = $(tabla)
    .find('tr')
    .first()
    .find('th,td')
    .map((_, th) => limpiar($(th).text()))
    .get();
  const idx = (re) => headCells.findIndex((h) => re.test(h));

  const iPj = idx(/^PJ/i);
  const iG = idx(/^PG/i);
  const iE = idx(/^PE/i);
  const iP = idx(/^PP/i);
  const iDif = idx(/^Dif/i);
  const iPts = idx(/^Puntos/i);

  const rows = [];
  $(tabla)
    .find('tbody tr')
    .each((_, tr) => {
      const cells = $(tr).find('td');
      if (cells.length < 5) return;
      const equipo = limpiar($(cells[1]).text());
      if (!equipo) return;
      rows.push({
        pos: rows.length + 1,
        equipo,
        // Las imágenes de la celda son banderas de la unión, no escudos.
        logo: null,
        pj: iPj >= 0 ? num($(cells[iPj]).text()) : null,
        g: iG >= 0 ? num($(cells[iG]).text()) : null,
        e: iE >= 0 ? num($(cells[iE]).text()) : null,
        p: iP >= 0 ? num($(cells[iP]).text()) : null,
        dg: iDif >= 0 ? num($(cells[iDif]).text()) : null,
        pts: iPts >= 0 ? num($(cells[iPts]).text()) : null,
        ultimo: null,
        proximo: null,
        cambio_fuente: null,
      });
    });
  if (rows.length < 8) throw new Error('Wikipedia: tabla incompleta');

  // Partidos de la fase final: filas "fecha | equipo | 23 - 20 | equipo"
  const partidos = [];
  $('table').each((_, t) => {
    $(t)
      .find('tr')
      .each((__, tr) => {
        const c = $(tr).find('td,th');
        if (c.length < 4) return;
        const texto = (i) => limpiar($(c[i]).text());
        const marcador = texto(2).match(/^(\d{1,2})\s*[-–]\s*(\d{1,2})$/);
        if (!marcador) return;
        const fecha = fechaDesdeTexto(texto(0), anio);
        if (!fecha || !texto(1) || !texto(3)) return;
        partidos.push(
          partidoDesde({
            fecha,
            contexto: 'Fase final',
            local: texto(1),
            visitante: texto(3),
            gl: Number(marcador[1]),
            gv: Number(marcador[2]),
          })
        );
      });
  });

  partidos.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
  return { rows, partidos };
}

function completarRugby(rows, partidos) {
  const porEquipo = {};
  partidos.forEach((p) => {
    [p.local, p.visitante].forEach((n) => {
      const k = slug(n);
      if (!porEquipo[k]) porEquipo[k] = { ultimo: p };
    });
  });
  rows.forEach((r) => {
    const d = porEquipo[slug(r.equipo)];
    r.ultimo = d ? d.ultimo : null;
    r.proximo = null;
  });
}

async function desdeRugby(cfg) {
  const anio = new Date().getFullYear();
  const divisiones = cfg.divisiones || [{ id: 'principal', nombre: cfg.ligaNombre, grupo: 'TRL 1 nivel' }];
  const ligas = [];

  // 1) USR (oficial). Puede traer Top 10 y Segunda; si está en cero, no sirve.
  try {
    const tablas = await rugbyUsrTablas();
    for (const d of divisiones) {
      const t = tablas.find((x) => norm(x.nivel) === norm(d.grupo));
      if (!t) continue;
      const jugados = t.rows.filter((r) => (r.pts || 0) > 0).length;
      if (jugados < 4) continue;
      ligas.push({
        id: d.id,
        nombre: cfg.ligaNombre,
        division: d.nombre,
        zona: null,
        temporada: String(anio),
        fuente: 'USR',
        url: 'https://usr.org.ar/tablas-trl/',
        tabla: t.rows,
        partido: null,
        ultimos: [],
      });
    }
  } catch (e) {
    log('  · rugby USR sin datos:', e.message);
  }

  // 2) Respaldo: Wikipedia (tabla del Top 10 + resultados de la fase final)
  if (!ligas.length) {
    for (const a of [anio, anio - 1]) {
      try {
        const w = await rugbyWikipedia(a);
        completarRugby(w.rows, w.partidos);
        const propios = w.partidos.filter((p) => hayEquipo(p.local, cfg.equipos) || hayEquipo(p.visitante, cfg.equipos));
        const ultimos = (propios.length ? propios : w.partidos).slice(0, 6);
        ligas.push({
          id: divisiones[0].id,
          nombre: cfg.ligaNombre,
          division: divisiones[0].nombre,
          zona: null,
          temporada: String(a),
          fuente: 'Wikipedia',
          url: `https://es.wikipedia.org/wiki/Torneo_Regional_del_Litoral_${a}`,
          tabla: w.rows,
          partido: ultimos[0] || null,
          ultimos,
        });
        break;
      } catch (e) {
        log(`  · rugby Wikipedia ${a}:`, e.message);
      }
    }
  }

  if (!ligas.length) throw new Error('Rugby: ninguna fuente devolvió la tabla del TRL');

  // Para las ligas sin resultados (USR todavía no publica), se usa el último
  // partido conocido del equipo destacado si existe.
  ligas.forEach((l) => {
    if (l.partido) return;
    const conUltimo = (l.tabla || []).filter((r) => r.ultimo);
    const delDestacado = conUltimo.find((r) => hayEquipo(r.equipo, cfg.equipos));
    l.partido = delDestacado ? delDestacado.ultimo : null;
    l.ultimos = [];
  });

  return { ligas };
}

// ---------------------------------------------------------------- historial

function leerHistorial() {
  try {
    return JSON.parse(fs.readFileSync(HIST_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function hashTabla(rows) {
  return rows.map((r) => r.pos + ':' + norm(r.equipo)).join('|');
}

/** Anota en cada fila el movimiento vs. el último cambio real de la tabla. */
function aplicarMovimiento(clave, rows, hist) {
  const actual = {};
  rows.forEach((r) => {
    actual[slug(r.equipo)] = r.pos;
  });

  const prev = hist[clave];
  const h = hashTabla(rows);

  if (prev && prev.hash === h) {
    const cambios = prev.cambios || {};
    rows.forEach((r) => {
      const c = cambios[slug(r.equipo)];
      r.cambio = typeof c === 'number' ? c : 0;
    });
    return rows;
  }

  const cambios = {};
  if (prev && prev.posiciones) {
    for (const [k, pos] of Object.entries(actual)) {
      if (prev.posiciones[k] !== undefined) cambios[k] = prev.posiciones[k] - pos; // + subió, - bajó
    }
  }

  hist[clave] = { hash: h, fecha: new Date().toISOString(), posiciones: actual, cambios };
  rows.forEach((r) => {
    const c = cambios[slug(r.equipo)];
    r.cambio = typeof c === 'number' ? c : 0;
  });
  return rows;
}

// ---------------------------------------------------------------- main

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const hist = leerHistorial();
  const salida = { actualizado: new Date().toISOString(), ciudades: CIUDADES, deportes: [] };

  let previo = null;
  try {
    previo = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
  } catch {}

  const previoDeCiudad = (deporteId, ciudadId) => {
    const d = ((previo && previo.deportes) || []).find((x) => x.id === deporteId);
    return (d && d.ciudades && d.ciudades[ciudadId]) || null;
  };

  for (const deporte of Object.values(DEPORTES)) {
    const bloque = { id: deporte.id, nombre: deporte.nombre, metrica: deporte.metrica, ciudades: {} };

    for (const ciudad of CIUDADES) {
      const cfg = deporte.ciudades[ciudad.id];
      if (!cfg) continue;
      log(`→ ${deporte.nombre} · ${ciudad.nombre}`);
      try {
        let datos;
        if (cfg.fuente === 'espn') datos = await desdeEspn(cfg);
        else if (cfg.fuente === 'laliga') datos = await desdeLaLiga(cfg);
        else datos = await desdeRugby(cfg);

        datos.ligas.forEach((l) => {
          l.tabla = aplicarMovimiento(`${deporte.id}:${ciudad.id}:${l.id}`, l.tabla, hist);
          l.tabla.forEach((r) => {
            r.destacado = hayEquipo(r.equipo, cfg.equipos);
          });
        });

        // Liga por defecto: donde juega la mayor cantidad de clubes de la ciudad
        // (si hay empate queda la primera de la config, que es la de más arriba).
        const cuenta = (l) => l.tabla.filter((r) => r.destacado).length;
        const defecto = datos.ligas.slice().sort((a, b) => cuenta(b) - cuenta(a))[0];

        const antC = previoDeCiudad(deporte.id, ciudad.id);
        if (antC) {
          const antLigas = antC.ligas || [];
          datos.ligas.forEach((l) => {
            const ant = antLigas.find((x) => x.id === l.id);
            if (ant && !l.partido && ant.partido) {
              l.partido = ant.partido;
              l.ultimos = l.ultimos && l.ultimos.length ? l.ultimos : ant.ultimos || [];
            }
          });
        }

        bloque.ciudades[ciudad.id] = {
          destacados: cfg.equipos,
          metrica: 'PTS',
          liga_default: defecto ? defecto.id : null,
          ligas: datos.ligas,
        };

        log(
          `  ✓ ${datos.ligas
            .map((l) => `${l.nombre}: ${l.tabla.length} equipos`)
            .join(' / ')} · partido: ${
            defecto && defecto.partido
              ? `${defecto.partido.local} ${defecto.partido.marcador_local}-${defecto.partido.marcador_visitante} ${defecto.partido.visitante}`
              : 'sin dato'
          }`
        );
      } catch (e) {
        log(`  ✗ ${ciudad.nombre}: ${e.message}`);
        const antC = previoDeCiudad(deporte.id, ciudad.id);
        if (antC) {
          bloque.ciudades[ciudad.id] = antC;
          log('    · se conserva el dato anterior');
        }
      }
    }

    salida.deportes.push(bloque);
  }

  const vacio = salida.deportes.every((d) => Object.keys(d.ciudades).length === 0);
  if (vacio) {
    console.error('Ninguna fuente devolvió datos. No se escribe el JSON.');
    process.exit(1);
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(salida, null, 2), 'utf8');
  fs.writeFileSync(HIST_FILE, JSON.stringify(hist, null, 2), 'utf8');
  log('OK →', path.relative(process.cwd(), OUT_FILE));
}

main().catch((e) => {
  console.error('Error fatal:', e);
  process.exit(1);
});
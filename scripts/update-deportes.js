#!/usr/bin/env node
/**
 * update-deportes.js — datos de deportes para los widgets del home (VXL)
 *
 * Arma `data/deportes.json` con, para cada deporte y cada ciudad del Litoral:
 *   - la tabla de posiciones de la liga donde juegan los equipos más relevantes
 *   - el último partido jugado
 *   - los últimos resultados del equipo destacado
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

// Ligas relevantes por ciudad: la liga donde juega el equipo más importante
// de esa ciudad en cada deporte (no "la liga más famosa", sino la del Litoral).
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
        equipos: ['Unión'],
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
      parana: {
        fuente: 'rugby',
        ligaNombre: 'Regional del Litoral',
        grupo: 'TRL 1 nivel',
        equipos: ['CAE|Estudiantes de Paraná', 'PARANA ROWING'],
      },
      santa_fe: {
        fuente: 'rugby',
        ligaNombre: 'Regional del Litoral',
        grupo: 'TRL 1 nivel',
        equipos: ['SANTA FE RC'],
      },
    },
  },
};

// ---------------------------------------------------------------- utilidades

const sinAcentos = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const norm = (s) =>
  sinAcentos(s)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

const tokens = (s) => norm(s).split(' ').filter(Boolean);

/** ¿El nombre del equipo de la fuente corresponde al equipo configurado?
 *  Un equipo configurado puede traer alias separados por "|":
 *  'CAE|Estudiantes de Paraná'. */
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
  // todos los tokens configurados deben aparecer en el nombre de la fuente,
  // en orden (permite "UNION" contra "UNIÓN (SANTA FE)" y evita "UNION" contra
  // "LA UNION (COLON)" porque "LA" y "COLON" no están en el configurado).
  let i = 0;
  for (const t of a) {
    if (t === b[i]) i++;
    if (i === b.length) return true;
  }
  return false;
}

const hayEquipo = (nombreFuente, lista) => lista.some((c) => coincide(nombreFuente, c));

const num = (v) => {
  if (v === null || v === undefined) return null;
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

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
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
  return String(nombre)
    .replace(/\s*-\s*/g, ' · ')
    .replace(/Regular Season/i, 'Fase regular')
    .replace(/Torneo Reducido/i, 'Reducido')
    .replace(/Quarterfinals/i, 'Cuartos de final')
    .replace(/Semifinals/i, 'Semifinales')
    .replace(/First Round/i, 'Primera fase')
    .replace(/Final\b/i, 'Final')
    .trim();
}

async function desdeEspn(cfg) {
  const base = 'https://site.api.espn.com/apis/v2/sports/soccer';
  const st = await getJson(`${base}/${cfg.liga}/standings`);
  const temporada = String((st.season && st.season.year) || new Date().getFullYear());

  const grupos = st.children || [];
  let grupo = null;
  let equipo = null;

  for (const ch of grupos) {
    for (const e of (ch.standings && ch.standings.entries) || []) {
      if (hayEquipo(e.team.displayName, cfg.equipos)) {
        grupo = ch;
        equipo = e;
        break;
      }
    }
    if (grupo) break;
  }

  if (!grupo) throw new Error(`${cfg.ligaNombre}: no encontré a ${cfg.equipos.join(' / ')} en la tabla`);

  const rows = (grupo.standings.entries || []).map((e) => ({
    pos: statVal(e, 'rank'),
    equipo: e.team.displayName,
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

  // ESPN ordena por rank; si no vino, ordenamos por puntos
  rows.sort((a, b) => (a.pos ?? 999) - (b.pos ?? 999) || (b.pts ?? 0) - (a.pts ?? 0));
  rows.forEach((r, i) => {
    if (r.pos === null || r.pos === undefined) r.pos = i + 1;
  });

  // Último partido y últimos resultados del equipo destacado
  let partido = null;
  let ultimos = [];
  try {
    const sch = await getJson(
      `${base.replace('/v2/', '/site/v2/')}/${cfg.liga}/teams/${equipo.team.id}/schedule?season=${temporada}`
    );
    const eventos = (sch.events || [])
      .filter((ev) => {
        const c = ev.competitions && ev.competitions[0];
        return c && c.status && c.status.type && c.status.type.completed;
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    ultimos = eventos.slice(0, 6).map((ev) => {
      const c = ev.competitions[0];
      const local = c.competitors.find((x) => x.homeAway === 'home') || c.competitors[0];
      const visitante = c.competitors.find((x) => x.homeAway === 'away') || c.competitors[1];
      return {
        fecha: ev.date,
        contexto: limpiarContexto(ev.seasonType && ev.seasonType.name),
        local: local.team.displayName,
        visitante: visitante.team.displayName,
        logo_local: (local.team.logos && local.team.logos[0] && local.team.logos[0].href) || null,
        logo_visitante: (visitante.team.logos && visitante.team.logos[0] && visitante.team.logos[0].href) || null,
        goles_local: competitorScore(local),
        goles_visitante: competitorScore(visitante),
      };
    });

    if (ultimos.length) {
      const u = ultimos[0];
      partido = {
        fecha: u.fecha,
        contexto: u.contexto,
        local: u.local,
        visitante: u.visitante,
        logo_local: u.logo_local,
        logo_visitante: u.logo_visitante,
        marcador_local: u.goles_local,
        marcador_visitante: u.goles_visitante,
        estado: 'finalizado',
        destacado: true,
      };
    }
  } catch (e) {
    log('  ! sin fixture de', equipo.team.displayName, e.message);
  }

  const zona = grupo.name && grupo.name !== 'Group A' && grupo.name !== 'Group B' ? grupo.name : grupo.name;
  const zonaTxt = zona ? zona.replace(/^Group\s*/i, 'Zona ') : null;

  return {
    liga: {
      nombre: cfg.ligaNombre,
      zona: zonaTxt,
      temporada,
      fuente: 'ESPN',
      url: cfg.liga === 'arg.1' ? 'https://www.espn.com.ar/futbol/argentina/primera' : 'https://www.espn.com.ar/futbol/argentina/segunda',
    },
    destacados: cfg.equipos,
    metrica: 'PTS',
    columnas: [
      { key: 'pj', label: 'PJ' },
      { key: 'dg', label: 'DG' },
      { key: 'pts', label: 'PTS' },
    ],
    tabla: rows,
    partido,
    ultimos,
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
    const txt = (i) => $(tds[i]).text().replace(/\s+/g, ' ').trim();
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
      cambio_fuente: null,
    });
  });
  if (rows.length < 5) throw new Error('La Liga Argentina: tabla vacía');

  // Fixture: últimos 45 días (resultados) — el handler devuelve toda la liga
  const hoy = new Date();
  const desde = new Date(hoy.getTime() - 45 * 24 * 3600 * 1000);
  const iso = (d) => d.toISOString().slice(0, 10);
  let partidos = [];
  try {
    const fx = await getHtml(
      `https://www.laliganacional.com.ar/laligaargentina/fixture?handler=ProximosPartidos&fechaInicio=${iso(
        desde
      )}&fechaFin=${iso(hoy)}`
    );
    const $$ = cheerio.load(fx);
    $$('tr.fila-tabla-calendarios').each((_, tr) => {
      const c = $$(tr).find('td');
      if (c.length < 6) return;
      const local = $$(tr).find('.celda-nombre.text-start .nombre-equipo').first().text().replace(/\s+/g, ' ').trim();
      const visit = $$(tr).find('.celda-nombre.text-end .nombre-equipo').first().text().replace(/\s+/g, ' ').trim();
      const marc = $$(tr).find('td.resultados strong');
      const gl = marc.length >= 1 ? num(marc.eq(0).text()) : null;
      const gv = marc.length >= 2 ? num(marc.eq(1).text()) : null;
      const fechaTxt = $$(tr).find('.fecha-campo strong').first().text().trim(); // dd/mm/yyyy HH:MM
      const m = fechaTxt.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
      if (!local || !visit || !m) return;
      const fecha = `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00-03:00`;
      const lc = $$(tr).find('.celda-escudo img').eq(0).attr('src') || null;
      const vc = $$(tr).find('.celda-escudo img').eq(1).attr('src') || null;
      partidos.push({
        fecha,
        contexto: cfg.grupo
          ? cfg.grupo
              .toLowerCase()
              .replace('conferencia ', 'Conferencia ')
              .replace(/(^|\s)([a-záéíóú])/g, (m, a, b) => a + b.toUpperCase())
          : null,
        local,
        visitante: visit,
        logo_local: lc ? `https://www.laliganacional.com.ar${lc}` : null,
        logo_visitante: vc ? `https://www.laliganacional.com.ar${vc}` : null,
        goles_local: gl,
        goles_visitante: gv,
      });
    });
  } catch (e) {
    log('  ! sin fixture de básquet', e.message);
  }

  const jugados = partidos
    .filter((p) => p.goles_local !== null && p.goles_visitante !== null)
    .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

  const propios = jugados.filter(
    (p) => hayEquipo(p.local, cfg.equipos) || hayEquipo(p.visitante, cfg.equipos)
  );
  const ultimos = (propios.length ? propios : jugados).slice(0, 6);

  let partido = null;
  if (ultimos.length) {
    const u = ultimos[0];
    partido = {
      fecha: u.fecha,
      contexto: u.contexto,
      local: u.local,
      visitante: u.visitante,
      logo_local: u.logo_local,
      logo_visitante: u.logo_visitante,
      marcador_local: u.goles_local,
      marcador_visitante: u.goles_visitante,
      estado: 'finalizado',
      destacado: true,
    };
  }

  return {
    liga: {
      nombre: cfg.ligaNombre,
      zona: cfg.grupo
        .toLowerCase()
        .replace('conferencia ', 'Conferencia ')
        .replace(/(^|\s)([a-záéíóú])/g, (m, a, b) => a + b.toUpperCase()),
      temporada: String(new Date().getFullYear()),
      fuente: 'AdC',
      url: 'https://www.laliganacional.com.ar/laligaargentina',
      nota: cfg.nota || null,
    },
    destacados: cfg.equipos,
    metrica: 'PTS',
    columnas: [
      { key: 'pj', label: 'PJ' },
      { key: 'pct', label: '%' },
      { key: 'pts', label: 'PTS' },
    ],
    tabla: rows,
    partido,
    ultimos,
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
  const d = new Date(Date.UTC(anio, mes - 1, dia, 21, 0, 0));
  return d.toISOString();
}

async function rugbyDesdeUsr(grupoNombre) {
  const html = await getHtml('https://usr.org.ar/tablas-trl/');
  const $ = cheerio.load(html);
  let nivel = null;
  let categoria = null;
  const tablas = [];

  $('h2, h3, h4, table.gsheet-data-table').each((_, el) => {
    const tag = (el.tagName || el.name || '').toLowerCase();
    if (tag === 'table') {
      if (nivel && /1 nivel/i.test(nivel) && /primera/i.test(categoria || '')) tablas.push(el);
      return;
    }
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (/TRL/i.test(t)) {
      nivel = t;
      categoria = null;
    } else if (nivel) {
      categoria = t;
    }
  });

  if (!tablas.length) throw new Error('USR: no encontré la tabla del TRL 1 nivel');

  const rows = [];
  $(tablas[0])
    .find('tbody tr')
    .each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 3) return;
      const nombre = $(tds[1]).text().replace(/\s+/g, ' ').trim();
      const logoRel = $(tds[0]).find('img').attr('src') || null;
      const pj = num($(tds[tds.length - 2]).text());
      const pts = num($(tds[tds.length - 1]).text());
      if (!nombre) return;
      rows.push({
        pos: rows.length + 1,
        equipo: nombre,
        logo: logoRel && /^https?:/.test(logoRel) ? logoRel : logoRel ? `https://usr.org.ar${logoRel}` : null,
        pj,
        pts,
        g: null,
        e: null,
        p: null,
        dg: null,
        cambio_fuente: null,
      });
    });

  const jugados = rows.filter((r) => (r.pts || 0) > 0).length;
  if (jugados < 4) throw new Error('USR: tabla sin datos cargados (temporada no iniciada)');
  return rows;
}

async function rugbyDesdeWikipedia(anio) {
  const api =
    'https://es.wikipedia.org/w/api.php?action=parse&format=json&formatversion=2&origin=*&page=' +
    encodeURIComponent(`Torneo Regional del Litoral ${anio}`) +
    '&prop=text';
  const data = await getJson(api);
  if (!data.parse || !data.parse.text) throw new Error(`Wikipedia: no hay página del TRL ${anio}`);
  const html = data.parse.text;
  const $ = cheerio.load(html);

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
    .map((_, th) => $(th).text().replace(/\s+/g, ' ').trim())
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
      const equipo = $(cells[1]).text().replace(/\s+/g, ' ').trim();
      if (!equipo) return;
      // Ojo: las imágenes de la celda son banderas de la unión, no escudos.
      rows.push({
        pos: rows.length + 1,
        equipo,
        logo: null,
        pj: iPj >= 0 ? num($(cells[iPj]).text()) : null,
        g: iG >= 0 ? num($(cells[iG]).text()) : null,
        e: iE >= 0 ? num($(cells[iE]).text()) : null,
        p: iP >= 0 ? num($(cells[iP]).text()) : null,
        dg: iDif >= 0 ? num($(cells[iDif]).text()) : null,
        pts: iPts >= 0 ? num($(cells[iPts]).text()) : null,
        cambio_fuente: null,
      });
    });

  if (rows.length < 8) throw new Error('Wikipedia: tabla incompleta');

  // Partidos: las cajas de la fase final tienen fecha | equipo | score | equipo
  const partidos = [];
  $('table').each((_, t) => {
    $(t)
      .find('tr')
      .each((_, tr) => {
        const c = $(tr).find('td,th');
        if (c.length < 4) return;
        const texto = (i) => $(c[i]).text().replace(/\s+/g, ' ').trim();
        const marcador = texto(2).match(/^(\d{1,2})\s*[-–]\s*(\d{1,2})$/);
        if (!marcador) return;
        const fecha = fechaDesdeTexto(texto(0), anio);
        const local = texto(1);
        const visitante = texto(3);
        if (!fecha || !local || !visitante) return;
        partidos.push({
          fecha,
          contexto: 'Fase final',
          local,
          visitante,
          logo_local: null,
          logo_visitante: null,
          goles_local: Number(marcador[1]),
          goles_visitante: Number(marcador[2]),
        });
      });
  });

  partidos.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
  return { rows, partidos, anio };
}

async function desdeRugby(cfg) {
  const anioActual = new Date().getFullYear();
  let rows = null;
  let partidos = [];
  let fuente = null;
  let temporada = String(anioActual);

  try {
    rows = await rugbyDesdeUsr(cfg.grupo || 'TRL 1 nivel');
    fuente = 'USR';
  } catch (e) {
    log('  · rugby USR sin datos:', e.message);
  }

  if (!rows) {
    for (const anio of [anioActual, anioActual - 1]) {
      try {
        const w = await rugbyDesdeWikipedia(anio);
        rows = w.rows;
        partidos = w.partidos;
        fuente = 'Wikipedia';
        temporada = String(anio);
        break;
      } catch (e) {
        log(`  · rugby Wikipedia ${anio}:`, e.message);
      }
    }
  }

  if (!rows) throw new Error('Rugby: ninguna fuente devolvió la tabla del TRL');

  const propios = partidos.filter((p) => hayEquipo(p.local, cfg.equipos) || hayEquipo(p.visitante, cfg.equipos));
  const ultimos = (propios.length ? propios : partidos).slice(0, 6);

  let partido = null;
  if (ultimos.length) {
    const u = ultimos[0];
    partido = {
      fecha: u.fecha,
      contexto: u.contexto,
      local: u.local,
      visitante: u.visitante,
      logo_local: u.logo_local,
      logo_visitante: u.logo_visitante,
      marcador_local: u.goles_local,
      marcador_visitante: u.goles_visitante,
      estado: 'finalizado',
      destacado: true,
    };
  }

  return {
    liga: {
      nombre: cfg.ligaNombre,
      zona: 'Top 10',
      temporada,
      fuente,
      url:
        fuente === 'USR'
          ? 'https://usr.org.ar/tablas-trl/'
          : `https://es.wikipedia.org/wiki/Torneo_Regional_del_Litoral_${temporada}`,
    },
    destacados: cfg.equipos,
    metrica: 'PTS',
    columnas: [
      { key: 'pj', label: 'PJ' },
      { key: 'dg', label: 'DIF' },
      { key: 'pts', label: 'PTS' },
    ],
    tabla: rows,
    partido,
    ultimos,
  };
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

  let cambios;
  if (!prev) {
    cambios = {};
  } else if (prev.hash === h) {
    cambios = prev.cambios || {};
  } else {
    cambios = {};
    for (const [k, pos] of Object.entries(actual)) {
      if (prev.posiciones && prev.posiciones[k] !== undefined) {
        cambios[k] = prev.posiciones[k] - pos; // + = subió, - = bajó
      }
    }
  }

  hist[clave] = { hash: h, fecha: new Date().toISOString(), posiciones: actual, cambios };

  rows.forEach((r) => {
    const c = cambios[slug(r.equipo)];
    r.cambio = typeof c === 'number' ? c : 0;
    r.destacado = false;
  });
  return rows;
}

// ---------------------------------------------------------------- main

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const hist = leerHistorial();
  const salida = { actualizado: new Date().toISOString(), ciudades: CIUDADES, deportes: [] };

  // Datos previos: si una fuente falla, no se pierde lo último bueno
  let previo = null;
  try {
    previo = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
  } catch {}

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

        const clave = `${deporte.id}:${ciudad.id}`;
        datos.tabla = aplicarMovimiento(clave, datos.tabla, hist);
        datos.tabla.forEach((r) => {
          r.destacado = hayEquipo(r.equipo, cfg.equipos);
        });

        // Si esta corrida no trajo último partido, conservamos el anterior
        if (!datos.partido && previo) {
          const ant = (previo.deportes || []).find((d) => d.id === deporte.id);
          const antC = ant && ant.ciudades && ant.ciudades[ciudad.id];
          if (antC && antC.partido) datos.partido = antC.partido;
          if (!datos.ultimos.length && antC && antC.ultimos) datos.ultimos = antC.ultimos;
        }

        bloque.ciudades[ciudad.id] = datos;
        log(`  ✓ ${datos.tabla.length} equipos · partido: ${datos.partido ? datos.partido.local + ' ' + datos.partido.marcador_local + '-' + datos.partido.marcador_visitante + ' ' + datos.partido.visitante : 'sin dato'}`);
      } catch (e) {
        log(`  ✗ ${ciudad.nombre}: ${e.message}`);
        if (previo) {
          const ant = (previo.deportes || []).find((d) => d.id === deporte.id);
          const antC = ant && ant.ciudades && ant.ciudades[ciudad.id];
          if (antC) {
            bloque.ciudades[ciudad.id] = antC;
            log('    · se conserva el dato anterior');
          }
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
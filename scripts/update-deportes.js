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
        equipos: ['Patronato', 'Gimnasia de Concepción'],
        // Liga de abajo: equipos de la provincia que no juegan en la principal
        secundarias: [{ fuente: 'promiedos', id: 'fahi', urlName: 'federal-a', nombre: 'Federal A', prioridad: 3 }],
      },
      santa_fe: {
        fuente: 'espn',
        liga: 'arg.1',
        ligaNombre: 'Liga Profesional',
        equipos: ['Unión (Santa Fe)|Unión', '9 De Julio Rafaela', 'Sportivo Las Parejas'],
        secundarias: [{ fuente: 'promiedos', id: 'fahi', urlName: 'federal-a', nombre: 'Federal A', prioridad: 3 }],
      },
    },
  },
  basquet: {
    id: 'basquet',
    nombre: 'Básquet',
    metrica: 'PTS',
    ciudades: {
      // Paraná no tiene club en La Liga Argentina: sus equipos juegan la Liga
      // Federal (Litoral A), así que esa es la liga principal y la Argentina
      // queda al lado para ver a los equipos entrerrianos de la categoría de
      // arriba.
      parana: {
        fuente: 'laliga',
        grupo: 'CONFERENCIA SUR',
        ligaNombre: 'Liga Argentina',
        prioridad: 2,
        equipos: ['SIONISTA', 'RECREATIVO', 'QUIQUE', 'ROCAMORA', 'CENTRAL ENTERRIANO'],
        nota: 'Entre Ríos',
        secundarias: [
          { fuente: 'ligafederal', id: 'litoral-a', grupo: 'LITORAL A', nombre: 'Liga Federal', prioridad: 1 },
        ],
      },
      santa_fe: {
        fuente: 'laliga',
        grupo: 'CONFERENCIA NORTE',
        ligaNombre: 'Liga Argentina',
        prioridad: 1,
        equipos: ['UNION (SF)', 'RIVADAVIA JRS', 'GIMNASIA (SANTA FE)'],
        secundarias: [
          { fuente: 'ligafederal', id: 'litoral-a', grupo: 'LITORAL A', nombre: 'Liga Federal', prioridad: 2 },
        ],
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
        incluirSinDatos: true,
        divisiones: [
          { id: 'top10', nombre: 'Top 10', prioridad: 1, grupo: 'TRL 1 nivel' },
          { id: 'segunda', nombre: 'Segunda', prioridad: 2, grupo: 'TRL 2 nivel' },
        ],
      },
      santa_fe: {
        fuente: 'rugby',
        ligaNombre: 'Regional del Litoral',
        equipos: ['SANTA FE RC', 'CRAI', 'UNIVERSITARIO (SF)', 'LA SALLE'],
        incluirSinDatos: true,
        divisiones: [
          { id: 'top10', nombre: 'Top 10', prioridad: 1, grupo: 'TRL 1 nivel' },
          { id: 'segunda', nombre: 'Segunda', prioridad: 2, grupo: 'TRL 2 nivel' },
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

  const ligas = [
    {
      id: 'principal',
      nombre: cfg.ligaNombre,
      prioridad: 1,
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
  ];

  // Ligas de abajo (Federal A) para que no quede afuera ningún equipo de la provincia
  for (const sec of cfg.secundarias || []) {
    try {
      ligas.push(await desdePromiedos(sec, cfg.equipos));
    } catch (e) {
      log(`  · ${sec.nombre}:`, e.message);
    }
  }

  return { ligas };
}

/** Promiedos: tablas de ligas que ESPN no publica (Federal A, por ejemplo). */
async function desdePromiedos(cfg, equipos) {
  const html = await getHtml(`https://www.promiedos.com.ar/league/${cfg.urlName}/${cfg.id}`);
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('Promiedos: sin __NEXT_DATA__');
  const data = JSON.parse(m[1]).props.pageProps.data || {};
  const grupos = data.tables_groups || [];

  // Elegimos la tabla (zona) donde juegan los equipos de la provincia; si no hay
  // coincidencias, la primera de la temporada regular.
  let elegida = null;
  for (const g of grupos) {
    for (const t of g.tables || []) {
      const rows = (t.table && t.table.rows) || [];
      const puntos = rows.filter((r) => hayEquipo((r.entity && r.entity.object && r.entity.object.name) || '', equipos)).length;
      const esRegular = /temporada regular/i.test(g.name || '');
      if (!elegida || puntos > elegida.puntos || (puntos === elegida.puntos && esRegular && !elegida.esRegular)) {
        elegida = { grupo: g.name, zona: t.name, rows, puntos, esRegular };
      }
    }
  }
  if (!elegida || !elegida.rows.length) throw new Error('Promiedos: tabla vacía');

  const rows = elegida.rows.map((r) => {
    const val = (k) => {
      const v = (r.values || []).find((x) => x.key === k);
      return v ? num(v.value) : null;
    };
    const goles = ((r.values || []).find((x) => x.key === 'Goals') || {}).value || '';
    const [gf, gc] = String(goles).split(':').map((x) => num(x));
    const nombre = limpiar((r.entity && r.entity.object && r.entity.object.name) || '');
    return {
      pos: num(r.num),
      equipo: nombre,
      logo: null,
      pj: val('GamePlayed'),
      g: val('GamesWon'),
      e: val('GamesEven'),
      p: val('GamesLost'),
      gf: gf ?? null,
      gc: gc ?? null,
      dg: val('Ratio'),
      pts: val('Points'),
      ultimo: null,
      proximo: null,
      cambio_fuente: null,
    };
  }).filter((r) => r.equipo);

  return {
    id: cfg.id,
    nombre: cfg.nombre,
    prioridad: cfg.prioridad || 9,
    zona: limpiar([elegida.grupo, elegida.zona].filter(Boolean).join(' · ')),
    temporada: String(new Date().getFullYear()),
    fuente: 'Promiedos',
    url: `https://www.promiedos.com.ar/league/${cfg.urlName}/${cfg.id}`,
    tabla: rows,
    partido: null,
    ultimos: [],
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

  const ligas = [
    {
      id: 'principal',
      nombre: cfg.ligaNombre,
      prioridad: cfg.prioridad || 1,
      zona: zonaTxt,
      temporada: String(new Date().getFullYear()),
      fuente: 'AdC',
      url: 'https://www.laliganacional.com.ar/laligaargentina',
      nota: cfg.nota || null,
      tabla: rows,
      partido,
      ultimos,
    },
  ];

  // Liga Federal (3ª categoría de la CABB): ahí juegan los clubes de Paraná y
  // Santa Fe que no están en La Liga Argentina.
  for (const sec of cfg.secundarias || []) {
    try {
      ligas.push(await desdeLigaFederal(sec));
    } catch (e) {
      log(`  · ${sec.nombre || 'Liga Federal'}:`, e.message);
    }
  }

  return { ligas };
}

// ---------------------------------------------------------------- básquet (Liga Federal / CABB)

// La CABB publica la Liga Federal por conferencias; los equipos vienen con la
// sede entre paréntesis ("SIONISTA (PARANA)"). La tabla se pide por handler y el
// fixture por compCatId, los dos sacados de la propia página para no hardcodear
// ids de temporada.
const CABB = 'https://argentina.basketball';

const SEDES = {
  PARANA: 'Paraná',
  'SANTA FE': 'Santa Fe',
  COLON: 'Colón',
  'SANTA ELENA': 'Santa Elena',
  'CONCEPCION DEL URUGUAY': 'Concepción del Uruguay',
  GUALEGUAYCHU: 'Gualeguaychú',
  CONCORDIA: 'Concordia',
  ROSARIO: 'Rosario',
  'VENADO TUERTO': 'Venado Tuerto',
  'MARCOS JUAREZ': 'Marcos Juárez',
  'SAN FRANCISCO': 'San Francisco',
  GALVEZ: 'Gálvez',
  ESPERANZA: 'Esperanza',
  RAFAELA: 'Rafaela',
  SUNCHALES: 'Sunchales',
  'SAN JUSTO': 'San Justo',
  'SAN JORGE': 'San Jorge',
  'SAN NICOLAS': 'San Nicolás',
};

const PARTICULAS = ['de', 'del', 'la', 'las', 'los', 'y', 'e'];

/** "SIONISTA (PARANA)" → { nombre: 'Sionista', sede: 'Paraná' } */
function separarSede(raw) {
  const txt = limpiar(raw);
  const m = txt.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (!m) return { nombre: titulo(txt), sede: null };
  const sedeNorm = norm(m[2]);
  return { nombre: titulo(m[1]), sede: SEDES[sedeNorm] || titulo(m[2]) };
}

/** Pasa nombres en mayúsculas a formato de diario, respetando partículas. */
function titulo(s) {
  return limpiar(s)
    .toLowerCase()
    .split(/\s+/)
    .map((palabra, i) => {
      const limpia = palabra.replace(/[^\p{L}\p{N}]/gu, '');
      if (i > 0 && PARTICULAS.includes(limpia)) return palabra;
      return palabra.replace(/\p{L}/u, (c) => c.toUpperCase());
    })
    .join(' ');
}

let cabbCache = null;

async function cabbInfo() {
  if (cabbCache) return cabbCache;
  const html = await getHtml(`${CABB}/liga-federal/tabla-posiciones`);
  const mFase = html.match(/<option value="(\d+)"[^>]*>\s*FASE REGULAR/i);
  if (!mFase) throw new Error('Liga Federal: no encontré la fase regular');
  const faseId = mFase[1];
  const grupos = await getJson(`${CABB}/api/clasificacion/${faseId}/grupos`);
  const fx = await getHtml(`${CABB}/liga-federal/fixture`);
  const mCat = fx.match(/compCatId:\s*['"]?(\d+)/);
  if (!mCat) throw new Error('Liga Federal: no encontré compCatId');
  cabbCache = { faseId, grupos, compCatId: mCat[1] };
  return cabbCache;
}

function parsearCalendarioCabb(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('tr.fila-tabla-calendarios').each((_, tr) => {
    const nombres = $(tr).find('.celda-nombre .nombre-equipo');
    if (nombres.length < 2) return;
    const local = separarSede(nombres.eq(0).text());
    const visitante = separarSede(nombres.eq(1).text());
    const marc = $(tr).find('td.resultados strong');
    const gl = marc.length >= 1 ? num(marc.eq(0).text()) : null;
    const gv = marc.length >= 2 ? num(marc.eq(1).text()) : null;
    const ftxt = limpiar($(tr).find('.fecha-campo strong').text());
    const m = ftxt.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
    if (!local.nombre || !visitante.nombre || !m) return;
    const esc = $(tr).find('.celda-escudo img');
    out.push({
      fecha: `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00-03:00`,
      local: local.nombre,
      visitante: visitante.nombre,
      gl,
      gv,
      cancha: limpiar($(tr).find('.fecha-campo small').text()) || null,
      logo_local: esc.eq(0).attr('src') ? `${CABB}${esc.eq(0).attr('src')}` : null,
      logo_visitante: esc.eq(1).attr('src') ? `${CABB}${esc.eq(1).attr('src')}` : null,
    });
  });
  return out;
}

let cabbCalendarioCache = null;

async function cabbCalendario() {
  if (cabbCalendarioCache) return cabbCalendarioCache;
  const { compCatId } = await cabbInfo();
  const iso = (d) => d.toISOString().slice(0, 10);
  const hoy = Date.now();
  // La fase regular arranca en febrero: si la ventana corta no trae nada, se
  // pide el año entero.
  for (const [atras, adelante] of [[150, 60], [300, 30], [400, 0]]) {
    const html = await getHtml(
      `${CABB}/liga-federal/fixture?handler=CargarFixture&compCatId=${compCatId}` +
        `&fechaIni=${iso(new Date(hoy - atras * 864e5))}&fechaFin=${iso(new Date(hoy + adelante * 864e5))}`
    );
    if (html.includes('fila-tabla-calendarios')) {
      cabbCalendarioCache = parsearCalendarioCabb(html);
      return cabbCalendarioCache;
    }
  }
  cabbCalendarioCache = [];
  return cabbCalendarioCache;
}

async function desdeLigaFederal(cfg) {
  const { faseId, grupos } = await cabbInfo();
  const grupo =
    grupos.find((g) => norm(g.nombre) === norm(cfg.grupo)) ||
    grupos.find((g) => norm(g.nombre).includes(norm(cfg.grupo)));
  if (!grupo) throw new Error(`Liga Federal: no encontré ${cfg.grupo}`);

  const html = await getHtml(
    `${CABB}/liga-federal/tabla-posiciones?handler=CargarClasificacion&faseId=${faseId}&grupoId=${grupo.idGrupo}`
  );
  const $ = cheerio.load(html);
  const rows = [];
  $('table tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 9) return;
    const celdaEquipo = tds.eq(1);
    const { nombre, sede } = separarSede(celdaEquipo.text());
    if (!nombre) return;
    const txt = (i) => limpiar(tds.eq(i).text());
    const logo = celdaEquipo.find('img').attr('src') || null;
    rows.push({
      pos: num(txt(0)),
      equipo: nombre,
      sede,
      logo: logo ? `${CABB}${logo}` : null,
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
  if (rows.length < 4) throw new Error('Liga Federal: tabla vacía');

  const equipoDe = (n) => separarSede(n).nombre;
  const calendario = await cabbCalendario();
  const delGrupo = new Set(rows.map((r) => slug(r.equipo)));
  const partidos = calendario
    .filter((p) => delGrupo.has(slug(equipoDe(p.local))) && delGrupo.has(slug(equipoDe(p.visitante))))
    .map((p) =>
      partidoDesde({
        fecha: p.fecha,
        contexto: grupo.nombre.replace('LITORAL', 'Litoral'),
        local: equipoDe(p.local),
        visitante: equipoDe(p.visitante),
        gl: p.gl,
        gv: p.gv,
        cancha: p.cancha,
      })
    );

  const conFecha = (p) => p && p.fecha && !isNaN(new Date(p.fecha));
  const jugados = partidos
    .filter((p) => p.estado === 'finalizado' && conFecha(p))
    .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
  const pendientes = partidos
    .filter((p) => p.estado !== 'finalizado' && conFecha(p))
    .sort((a, b) => new Date(a.fecha) - new Date(b.fecha));

  const escudos = {};
  rows.forEach((r) => {
    if (r.logo) escudos[slug(r.equipo)] = r.logo;
  });
  const porEquipo = {};
  const tocar = (n) => (porEquipo[slug(n)] = porEquipo[slug(n)] || { ultimo: null, proximo: null });
  jugados.forEach((p) => {
    [p.local, p.visitante].forEach((n) => {
      const d = tocar(n);
      if (!d.ultimo) d.ultimo = p;
    });
    if (p.logo_local) escudos[slug(p.local)] = escudos[slug(p.local)] || p.logo_local;
    if (p.logo_visitante) escudos[slug(p.visitante)] = escudos[slug(p.visitante)] || p.logo_visitante;
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
    if (r.ultimo) conLogos(r.ultimo, escudos);
    if (r.proximo) conLogos(r.proximo, escudos);
  });

  const propios = jugados.filter(
    (p) => hayEquipo(p.local, cfg.equipos) || hayEquipo(p.visitante, cfg.equipos)
  );
  const ultimos = (propios.length ? propios : jugados).slice(0, 6);
  ultimos.forEach((p) => conLogos(p, escudos));

  return {
    id: cfg.id || 'federal',
    nombre: cfg.nombre || 'Liga Federal',
    prioridad: cfg.prioridad || 2,
    zona: grupos.find((g) => g.idGrupo === grupo.idGrupo).nombre.replace('LITORAL', 'Litoral'),
    temporada: String(new Date().getFullYear()),
    fuente: 'CABB',
    url: `${CABB}/liga-federal/tabla-posiciones`,
    tabla: rows,
    partido: ultimos[0] || null,
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

// Mismos clubes con distinto nombre según la fuente: la USR (planilla) los
// abrevia y Wikipedia (tabla con puntos) los escribe enteros. Sirve para cruzar
// los escudos de la USR con la tabla de Wikipedia; el primero de cada fila es la
// clave común.
const RUGBY_MISMOS = [
  ['CAE', 'ESTUDIANTES DE PARANA'],
  ['CRAI', 'CRAI'],
  ['DUENDES', 'DUENDES'],
  ['GER', 'GER'],
  ['JOCKEY ROSARIO', 'JOCKEY CLUB R'],
  ['JOCKEY VT', 'JOCKEY CLUB VT'],
  ['OLD RESIAN', 'OLD RESIAN'],
  ['ROWING', 'PARANA ROWING'],
  ['SFRC', 'SANTA FE RC'],
  ['UNI ROSARIO', 'UNIVERSITARIO R'],
];

const canonRugby = (nombre) => {
  const n = norm(nombre);
  const grupo = RUGBY_MISMOS.find((g) => g.some((x) => norm(x) === n));
  return grupo ? norm(grupo[0]) : n;
};

/** Escudos de la USR indexados por nombre canónico del club. */
function escudosRugby(tablas) {
  const mapa = {};
  (tablas || []).forEach((t) => {
    (t.rows || []).forEach((r) => {
      if (r.logo) mapa[canonRugby(r.equipo)] = r.logo;
    });
  });
  return mapa;
}

async function desdeRugby(cfg) {
  const anio = new Date().getFullYear();
  const divisiones = cfg.divisiones || [{ id: 'principal', nombre: cfg.ligaNombre, grupo: 'TRL 1 nivel' }];
  const ligas = [];
  let tablasUsr = [];

  // 1) USR (oficial). Puede traer Top 10 y Segunda; si está en cero, no sirve.
  try {
    const tablas = await rugbyUsrTablas();
    tablasUsr = tablas;
    for (const d of divisiones) {
      const t = tablas.find((x) => norm(x.nivel) === norm(d.grupo));
      if (!t) continue;
      const jugados = t.rows.filter((r) => (r.pts || 0) > 0).length;
      // La USR publica las divisiones de abajo con los equipos pero sin puntos.
      // Se muestran igual (así aparece Tilcara en la Segunda) y las columnas van
      // vacías hasta que la planilla tenga datos.
      const sinDatos = jugados < 4;
      // La división de arriba nunca se publica vacía: si la planilla está en
      // cero se prefiere Wikipedia, que sí tiene la tabla final. Las de abajo sí
      // se muestran sin puntos (es el único lugar donde aparece Tilcara).
      const esPrincipal = d.id === divisiones[0].id;
      if (sinDatos && (esPrincipal || !cfg.incluirSinDatos)) continue;
      ligas.push({
        id: d.id,
        // El torneo es uno solo (Regional del Litoral) con divisiones: el título
        // del widget es la división y el torneo va como contexto.
        nombre: d.nombre,
        prioridad: d.prioridad || (divisiones.indexOf(d) + 1),
        division: null,
        sinDatos,
        zona: cfg.ligaNombre,
        nota: sinDatos ? 'La USR publica esta división sin puntos cargados' : null,
        temporada: String(anio),
        fuente: 'USR',
        url: 'https://usr.org.ar/tablas-trl/',
        tabla: sinDatos
          ? t.rows.map((r) => ({ ...r, pj: null, pts: null }))
          : t.rows,
        partido: null,
        ultimos: [],
      });
    }
  } catch (e) {
    log('  · rugby USR sin datos:', e.message);
  }

  // 2) Respaldo: Wikipedia (tabla del Top 10 + resultados de la fase final)
  if (!ligas.some((l) => l.id === divisiones[0].id)) {
    for (const a of [anio, anio - 1]) {
      try {
        const w = await rugbyWikipedia(a);
        completarRugby(w.rows, w.partidos);
        const propios = w.partidos.filter((p) => hayEquipo(p.local, cfg.equipos) || hayEquipo(p.visitante, cfg.equipos));
        const ultimos = (propios.length ? propios : w.partidos).slice(0, 6);
        ligas.push({
          id: divisiones[0].id,
          nombre: divisiones[0].nombre,
          prioridad: 1,
          division: null,
          zona: cfg.ligaNombre,
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

  // Wikipedia no trae escudos: se los cruza desde la planilla de la USR.
  const escudos = escudosRugby(tablasUsr);
  ligas.forEach((l) => {
    if (l.fuente === 'USR') return;
    (l.tabla || []).forEach((r) => {
      if (!r.logo) r.logo = escudos[canonRugby(r.equipo)] || null;
    });
    [l.partido, ...(l.ultimos || [])].forEach((p) => {
      if (!p) return;
      p.logo_local = p.logo_local || escudos[canonRugby(p.local)] || null;
      p.logo_visitante = p.logo_visitante || escudos[canonRugby(p.visitante)] || null;
    });
  });

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
            // Algunas fuentes traen el equipo sin la ciudad (Liga Federal: dos
            // "Gimnasia" distintos), así que se prueba también con la sede.
            r.destacado =
              hayEquipo(r.equipo, cfg.equipos) ||
              (r.sede ? hayEquipo(`${r.equipo} (${r.sede})`, cfg.equipos) : false);
          });
        });

        // Las ligas salen ordenadas por jerarquía (principal primero) para que
        // el desplegable del widget las muestre en ese orden.
        datos.ligas.sort((a, b) => (a.prioridad || 9) - (b.prioridad || 9));

        // Liga por defecto: siempre la más alta del deporte (menor prioridad).
        const defecto = datos.ligas
          .slice()
          .sort((a, b) => (a.prioridad || 9) - (b.prioridad || 9))[0];

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
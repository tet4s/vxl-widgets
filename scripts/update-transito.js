/**
 * Scraper de alertas de tránsito — fuentes 100% AR (Litoral: Paraná + Santa Fe)
 * ---------------------------------------------------------------------------
 * Output: data/transito.json  (schema compatible con widgets/mapa-alertas)
 *
 *  items[].{ id, titulo, categoria, tipo, fecha, fecha_raw, horario, resumen,
 *            descripcion, enlace, lat, lon, localidad, provincia, via,
 *            km_desde, km_hasta, vigente_hasta }
 *
 * REGLA (estricta): NUNCA coords inventadas. lat/lon provienen de:
 *   (a) georreferenciación REAL vía georef-ar-api (apis.datos.gob.ar), o
 *   (b) localidad/existencia del feed. Si no se resuelve → se DESCARTA.
 * AlertasTransito.com fue DESCARTADA (ponía coords de CABA para todo).
 *
 * Fuentes (ubicación REAL incluida, HTML parseable):
 *   EL LITORAL  https://www.ellitoral.com/temas/estado-del-transito  → nota /transito-santafe_0_<hash>.html
 *   EL ONCE     https://www.elonce.com/temas/corte  (filtra notas "tránsito", descarta agua/gas/luz)
 *   ANÁLISIS    https://www.analisisdigital.com.ar/policiales  (choques/volcos + calles)
 *   RUTA0       https://www.ruta0.com/estado-de-rutas/litoral/  (road + km + localidad)
 *   APSV        santafe.gob.ar/noticias/noticia/279907  (Estado de rutas oficial)
 *
 * Cron: .github/workflows/update-transito.yml (cada 15').  Run: node scripts/update-transito.js
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const OUTPUT = path.join(__dirname, '../data/transito.json');
const CACHE  = path.join(__dirname, '../data/transito.cache.json');
const PROVS_OK = ['Santa Fe', 'Entre Ríos'];
const MAX = 30;

const log = m => console.log('[scraper] ' + m);
const pad = n => String(n).padStart(2, '0');
function clean(t){ return (t||'').replace(/<script[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/window\.googletag[\s\S]*?;\s*/g,' ').replace(/\s+/g,' ').trim(); }
function short(t,m=180){ t=clean(t); return t.length<=m?t:t.slice(0,m).trim()+'…'; }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
async function fetch(url, tries=3){
  for(let i=0;i<tries;i++){ try{ return (await axios.get(url,{headers:{'User-Agent':UA,'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9','Accept-Language':'es-ES,es;q=0.9','sec-ch-ua':'"Chromium";v="120", "Not_A Brand";v="20", "Brave";v="120"','sec-ch-ua-mobile':'?0','sec-ch-ua-platform':'"Windows"','sec-fetch-dest':'document','sec-fetch-mode':'navigate','sec-fetch-site':'none','sec-fetch-user':'?1','upgrade-insecure-requests':'1'},timeout:25000})).data; }catch(e){ if(i===tries-1) throw e; await sleep(1200*(i+1)); } }
}

/* ── georef-ar-api (gratuito, oficial) ── GET querystring (el POST rechaza 'id') ── */
/* NUNCA invento coords: si devuelve cantidad 0 / no resuelve → null → se descarta. */
async function georef(direccion, provincia, localidad){
  if(!direccion) return null;
  const dir = clean(direccion);
  const PROV_ID = { 'Santa Fe':'22', 'Entre Ríos':'30' };
  try{
    const params = { direccion: dir };
    if(provincia) params.provincia = provincia;
    if(localidad && localidad !== provincia) params.localidad = localidad;
    const res = await axios.get('https://apis.datos.gob.ar/georef/api/direcciones', { params, headers:{'User-Agent':UA}, timeout:8000 });
    const r = res.data && res.data.direcciones && res.data.direcciones[0];
    if(r && r.ubicacion && r.ubicacion.lat!=null && r.ubicacion.lon!=null){
      return { lat:r.ubicacion.lat, lon:r.ubicacion.lon,
               provincia: (r.provincia&&r.provincia.nombre)||provincia,
               localidad: (r.localidad&&r.localidad.nombre)||(r.localidad_censal&&r.localidad_censal.nombre)||localidad };
    }
  }catch(e){ log('   ⚠ georef: '+(e.message||e)); }
  return null;
}

/* ── parsers ── */
const RE_TS = /(\d{1,2}:\d{2})\s*\/\s*([A-Z][a-z]{2})\s*\.\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/;
function tsToISO(ts){ if(!ts) return ''; const m=String(ts).match(RE_TS); if(m) return `${m[5]}-${pad(m[3])}-${pad(m[4])}T${pad(m[1])}:${m[2]}:00-03:00`; const d=new Date(ts); return isNaN(+d)?'':d.toISOString(); }
function parseHorario(txt){ let m=String(txt).match(/de\s+(\d{1,2}:\d{2})\s+a\s+(?:las\s*)?(\d{1,2}:\d{2})/i); if(m) return 'de '+m[1]+' a '+m[2]; m=String(txt).match(/(?:desde\s+(\d{1,2}:\d{2})\s+a\s+(\d{1,2}:\d{2}))/i); if(m) return 'de '+m[1]+' a '+m[2]; m=String(txt).match(/hasta\s+(?:las\s*)?(\d{1,2}:\d{2})/i); if(m) return 'hasta '+m[1]; return null; }
function vigenteHasta(horario, fechaISO){ if(!horario||!fechaISO) return null; const m=String(horario).match(/de\s+(\d{1,2}):(\d{2})\s+a\s+(\d{1,2}):(\d{2})/i); if(m){ const d=new Date(fechaISO); if(isNaN(+d)) return null; const o=new Date(d); o.setHours(parseInt(m[3]),parseInt(m[4]),0,0); return o.toISOString(); } return null; }
function parseKm(txt){ let m=String(txt).match(/k(?:m|il[oó]metro)?\s*(\d+(?:[.\d]+)?)\s*(?:hasta|–|-)\s*k(?:m|il[oó]metro)?\s*(\d+(?:[.\d]+)?)/i); if(m) return{from:m[1],to:m[2]}; m=String(txt).match(/(?:desde|entre)\s*(\d+(?:[.\d]+)?)\s*(?:y|hasta|–)\s*(\d+(?:[.\d]+)?)/i); if(m) return{from:m[1],to:m[2]}; m=String(txt).match(/k(?:m|il[oó]metro)?\s*(\d+(?:[.\d]+)?)/i); if(m) return{from:m[1],to:null}; return{from:null,to:null}; }
function parseTipo(t,tt){ const s=(tt||'')+' '+(t||''); if(/corte\s*total|acceso\s*cerrado|interrupci[oó]n/i.test(s)) return 'corte_total'; if(/corte\s*parcial/i.test(s)) return 'corte_parcial'; if(/reducci[oó]n|menos\s*un\s*carril|entre\s*2\s*carriles/i.test(s)) return 'reduccion'; if(/obra|reparaci[oó]n|construcci[oó]n/i.test(s)) return 'obra'; if(/choque|colisi[oó]n|vuelco|accidente/i.test(s)) return 'choque'; return 'corte_total'; }
function parseCat(t){ if(t==='choque') return 'accidentes'; if(t==='obra') return 'obras'; return 'cortes'; }

function buildItem(o){ if(!o.geo || o.geo.lat==null) return null;
  return { id:o.id, titulo:short(o.titulo||'',80)||'Alerta de tránsito', categoria:o.categoria||parseCat(o.tipo), tipo:o.tipo||'corte_total',
    fecha:o.fecha||'', fecha_raw:o.fecha||'', horario:o.horario||null, resumen:short(o.resumen||o.descripcion,180), descripcion:short(o.descripcion,240), enlace:o.enlace||'',
    lat:o.geo.lat, lon:o.geo.lon, localidad:o.localidad||o.geo.localidad||'', provincia:o.provincia||o.geo.provincia||'',
    via:(o.via||'').trim().slice(0,90), km_desde:o.kmDesde||null, km_hasta:o.kmHasta||null, vigente_hasta:vigenteHasta(o.horario,o.fecha)||null };
}
function uniqById(items){ const v={}; const out=[]; for(const i of items){ if(i&&i.id&&!v[i.id]){v[i.id]=true; out.push(i);} } return out; }

/* ════════════════════════════════════════════════════════════════════════════
   1. EL LITORAL  (Santa Fe) — nota diaria "Estado del tránsito"
   ═══════════════════════════════════════════════════════════════════════════*/
async function scrapElLitoral(){
  log('El Litoral (SF): indexando estado-del-transito...');
  const out=[];
  try{
    const idx = await fetch('https://www.ellitoral.com/temas/estado-del-transito');
    const $ = cheerio.load(idx);
    let nota='';
    $('a[href]').each((_,a)=>{ const h=$(a).attr('href')||''; const href=h.startsWith('http')?h:'https://www.ellitoral.com'+h;
      if(!nota && /\/area-metropolitana\/transito-santafe.*_0_[A-Za-z0-9]+\.html/.test(href)) nota=href; });
    if(!nota){ log('  (sin nota diaria, skip)'); return out; }
    log('  nota: '+nota.replace(/.*\//,''));
    const nhtml = await fetch(nota); const $$ = cheerio.load(nhtml);
    // Incidencias reales: partir HTML por </h2>|</h3> (robusto; no depende de hermanos/parent).
    const bloques = $$.html().replace(/<\/h3>/gi,'</h3>@@SPLIT@@').replace(/<\/h2>/gi,'</h2>@@SPLIT@@').split('@@SPLIT@@')
      .map(seg => clean(seg)).filter(seg => seg.length>40 && !/#HOY:/i.test(seg) && !/Maximiliano Pullaro|Javier Milei|Imagen ilustrativa|Cr[eé]ditos?:|Redacci[oó]n EL|Conoc[eé] la informaci[oó]n vinculada al tr[aá]nsito del [aá]rea metropolitana/i.test(seg) && /acceso\s*cerrado|corte\s*(total|de\s*tr|del\s*tr)|reducci[oó]n\s*(del)?\s*tr|km\s*\d|autopista|r(?:uta?)?\s*\d|obra|vial|\d{1,2}:\d{2}\s*\/|desv[ií]o|congesti[oó]n|siniestro|accidente/i.test(seg));
    log('  bloques: '+bloques.length);
    for(const b of bloques){
      const txt = b; const titulo = short(b.slice(0, b.indexOf('.')>0?b.indexOf('.'):80), 70);
      const mTS=txt.match(RE_TS); const fecha=mTS?tsToISO(mTS[0]):'';
      const km=parseKm(txt);
      let via=''; const vm=txt.match(/autopista\s+[^,.;]+/i); if(vm) via=vm[0];
      if(!via){ const v2=txt.match(/(?:bulevar|avenida|r(?:uta?)?\s*\d+|rp\s*\d+|calle\s+\w+)[^,.;]*/i); if(v2) via=v2[0]; }
      let localidad=''; const searchIn = txt.slice(0, Math.min(txt.length, 220));
      for(const loc of ['Rosario','Santo Tomé','Reconquista','Venado Tuerto','Rafaela','Clorinda','Santa Fe']) { if(searchIn.toLowerCase().includes(loc.toLowerCase())){ localidad=loc; break; } }
      const horario=parseHorario(txt);
      const dirGeo=localidad||'Santa Fe';
      const geo=await georef(dirGeo,'Santa Fe',localidad);
      const item=buildItem({id:'ellitoral:'+(fecha||short(b,40)),titulo:via||titulo,tipo:parseTipo(txt,txt),categoria:'cortes',fecha,descripcion:txt,resumen:txt,enlace:nota,via,kmDesde:km.from,kmHasta:km.to,localidad,provincia:'Santa Fe',horario,geo});
      if(item) out.push(item); await sleep(120);
    }
  }catch(e){ log('  ✗ El Litoral: '+(e.message||e)); }
  return out;
}

/* ════════════════════════════════════════════════════════════════════════════
   2. EL ONCE → DESCARTADO (SPA; no expone links en HTML). Paraná ciudad → Análisis Digital.
   ═══════════════════════════════════════════════════════════════════════════*/
async function scrapElOnce(){
  log('El Once: DESCARTADO (elonce.com/temas/corte es SPA; no expone links). Usa Análisis Digital.');
  return [];
  const out=[];
  try{
    const html = await fetch('https://www.elonce.com/temas/corte');
    const $ = cheerio.load(html);
    const links=[];
    $('a[href]').each((_,a)=>{ const h=$(a).attr('href')||''; const href=h.startsWith('http')?h:h.startsWith('//')?'https:'+h:h.startsWith('/')?'https://www.elonce.com'+h:h;
      if(/elonce\.com\/\d+\/.*\.html/.test(href) && links.indexOf(href)==-1) links.push(href); });
    log('  links: '+links.length);
    for(const url of links.slice(0,12)){
      try{
        const art=await fetch(url); const $$=cheerio.load(art);
        const titulo=clean($$('h1, .titulo').first().text())||clean($$('title').text());
        const txt=clean($$('p, .nota, .contenido').text());
        if(!/tr[\u00e1a]nsito/i.test(titulo) && !/tr[\u00e1a]nsito/i.test(txt)){ await sleep(200); continue; }
        if(/agua|gas|electricidad|luz/i.test(titulo) && !/tr[\u00e1a]nsito/i.test(titulo)){ await sleep(200); continue; }
        const horario=parseHorario(txt)||parseHorario(titulo);
        const dirGeo=(txt.match(/(autopista|r(?:uta?)?\s*\d+|bulevar|avenida|calle\s+\w+|rp\s*\d+)[^,.;]*/i)||[''])[1]||titulo;
        const geo=await georef(dirGeo+' Paraná','Entre Ríos','Paraná');
        const item=buildItem({id:'elonce:'+url,titulo:titulo,tipo:parseTipo(txt,titulo),categoria:parseCat(parseTipo(txt,titulo)),
          fecha:(tsToISO($$('time, .fecha').first().text())||new Date($$('time').attr('datetime')||Date.now()).toISOString()),descripcion:txt,resumen:txt,enlace:url,via:dirGeo||titulo,localidad:'Paraná',provincia:'Entre Ríos',horario,geo});
        if(item) out.push(item);
      }catch(e){}
      await sleep(300);
    }
  }catch(e){ log('  ✗ El Once: '+(e.message||e)); }
  return out;
}

/* ════════════════════════════════════════════════════════════════════════════
   3. ANÁLISIS DIGITAL  (Paraná) — policiales (choques/volcos + calles)
   ═══════════════════════════════════════════════════════════════════════════*/
async function scrapAnalisis(){
  log('Análisis Digital (Paraná): policiales...');
  const out=[];
  try{
    const html = await fetch('https://www.analisisdigital.com.ar/policiales');
    const urlBase='https://www.analisisdigital.com.ar';
    const $ = cheerio.load(html);
    const links=[];
    $('a[href]').each((_,a)=>{ const h=$(a).attr('href')||''; const href=h.replace(/^["']|["']$/g,'');
      const hrefFull = href.startsWith('http')?href:h.startsWith('//')?'https:'+href:h.startsWith('/')?urlBase+href:href;
      const m = href.match(/^\/policiales\/\d{4}\/\d{2}\/\d{2}\/[^?]+$/);
      if(m && links.indexOf(urlBase+href)===-1){ links.push(urlBase+href); } });
    log('  links: '+links.length);
    for(const url of links.slice(0,15)){
      const slug = url.split('/').pop().replace(/\.html$/,'');
      const titulo = clean(decodeURIComponent(slug.replace(/-/g,' ')));
      if(!/choque|colisi[oó]n|vuelco|accidente|chocaron|tr[\u00e1a]nsito|ruta\s*\d/i.test(titulo)){ continue; }
      const geo=await georef('Paraná','Entre Ríos','Paraná');
      const item=buildItem({id:'analisis:'+url,titulo:titulo,tipo:parseTipo(titulo,titulo),categoria:parseCat(parseTipo(titulo,titulo)),fecha:new Date().toISOString(),descripcion:titulo,resumen:titulo,enlace:url,via:'ruta/ciudad Paraná',localidad:'Paraná',provincia:'Entre Ríos',horario:null,geo});
      if(item) out.push(item);
    }
  }catch(e){ log('  ✗ Análisis: '+(e.message||e)); }
  return out;
}

/* ════════════════════════════════════════════════════════════════════════════
   4. RUTA0  (rutas nacionales, Litoral) — road + km + localidad
   ═══════════════════════════════════════════════════════════════════════════*/
async function scrapRuta0(){
  log('Ruta0 (litoral rutas): indexando...');
  const out=[];
  try{
    const html = await fetch('https://www.ruta0.com/estado-de-rutas/litoral/');
    const $ = cheerio.load(html);
    const bloques=[];
    $('.nota, .card, .item, p, li').each((_,el)=>{ const t=clean($(el).text());
      if(/corte|restricci[oó]n|desv[ií]o|obra/i.test(t) && /r(?:uta?)?\s*\d+|km\s*\d+/i.test(t)) bloques.push(t); });
    for(const txt of bloques.slice(0,12)){
      const via=(txt.match(/(r(?:uta?)?\s*\d+|autopista\s+\w+|rp\s*\d+)/i)||[''])[1];
      const km=parseKm(txt);
      const localidad=(txt.match(/(?:altura|en|sobre)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i)||['',null])[1]||(txt.match(/entre\s+([A-Z][a-z]+)/i)||['',null])[1]||'';
      const horario=parseHorario(txt);
      const prov=/Santa Fe/i.test(txt)?'Santa Fe':(/Paran[aá]/i.test(txt)?'Entre Ríos':(localidad?'':''));
      const locForGeo = localidad || (prov==='Santa Fe'?'Santa Fe':prov==='Entre Ríos'?'Paraná':'');
      const geo=await georef((km.from?via+' km '+km.from+' ':via+' ')+(locForGeo||'Litoral'),prov||undefined,locForGeo);
      const item=buildItem({id:'ruta0:'+short(txt,40),titulo:short(txt||(via||'corte'),80),tipo:parseTipo(txt,txt),categoria:parseCat(parseTipo(txt,txt)),fecha:new Date().toISOString(),descripcion:txt,resumen:txt,enlace:'https://www.ruta0.com/estado-de-rutas/litoral/',via,kmDesde:km.from,kmHasta:km.to,localidad:localidad||(prov||'Litoral'),provincia:prov||'',horario,geo});
      if(item && PROVS_OK.indexOf(item.provincia)!==-1) out.push(item);
      await sleep(100);
    }
  }catch(e){ log('  ✗ Ruta0: '+(e.message||e)); }
  return out;
}

/* ════════════════════════════════════════════════════════════════════════════
   5. APSV  (Santa Fe) — Estado de rutas oficial
   ═══════════════════════════════════════════════════════════════════════════*/
async function scrapApsv(){
  log('APSV (Santa Fe): Estado de rutas...');
  const out=[];
  try{
    const html = await fetch('https://www.santafe.gob.ar/noticias/noticia/279907/');
    const $ = cheerio.load(html);
    const txt = clean($('body').text());
    const via=(txt.match(/(autopista|r(?:uta?)?\s*\d+|rp\s*\d+|bulevar)[^,.;]*/i)||[''])[1];
    const km=parseKm(txt);
    const localidad=(txt.match(/altura\s+([A-Z][a-z]+)/i)||['',null])[1]||'Santa Fe';
    const horario=parseHorario(txt);
    const geo=await georef((km.from?via+' km '+km.from+' ':via||'')+localidad+' Santa Fe','Santa Fe',localidad);
    const item=buildItem({id:'apsv:279907',titulo:short(txt,90),tipo:parseTipo(txt,txt),categoria:parseCat(parseTipo(txt,txt)),fecha:new Date().toISOString(),descripcion:txt,resumen:txt,enlace:'https://www.santafe.gob.ar/noticias/noticia/279907/',via,kmDesde:km.from,kmHasta:km.to,localidad,provincia:'Santa Fe',horario,geo});
    if(item) out.push(item);
  }catch(e){ log('  ✗ APSV: '+(e.message||e)); }
  return out;
}

/* ═════════════════════════════════════ main ═══════════════════════════════════*/
async function main(){
  log('🚦 Iniciando extracción de alertas de tránsito (Litoral AR)...');
  let items=[];
  try{ items = items.concat(await scrapElLitoral());  }catch(e){log('El Litoral: '+(e.message||e));}
  try{ items = items.concat(await scrapElOnce());     }catch(e){log('El Once: '+(e.message||e));}
  try{ items = items.concat(await scrapAnalisis());   }catch(e){log('Análisis: '+(e.message||e));}
  try{ items = items.concat(await scrapRuta0());      }catch(e){log('Ruta0: '+(e.message||e));}
  try{ items = items.concat(await scrapApsv());       }catch(e){log('APSV: '+(e.message||e));}

  items = items.filter(i => i && (PROVS_OK.indexOf(i.provincia)!==-1) && i.lat!=null && i.lon!=null);
  items = uniqById(items);
  items.sort((a,b)=>(new Date(b.fecha||Date.now()))-(new Date(a.fecha||Date.now())));
  items = items.slice(0, MAX);

  if(items.length===0){
    log('⚠ Sin alertas georreferenciables; conservo backup anterior.');
    if(fs.existsSync(CACHE)) fs.copyFileSync(CACHE, OUTPUT);
    else fs.writeFileSync(OUTPUT, JSON.stringify({timestamp:new Date().toISOString(),timestamp_epoch:Math.floor(Date.now()/1000),source:'vxl-transito-ar',cantidad:0,items:[]},null,2));
    process.exit(0);
  }
  const payload = { timestamp:new Date().toISOString(), timestamp_epoch:Math.floor(Date.now()/1000), source:'vxl-transito-ar', cantidad:items.length, items:items };
  if(fs.existsSync(OUTPUT)) fs.copyFileSync(OUTPUT, CACHE);
  fs.writeFileSync(OUTPUT, JSON.stringify(payload,null,2), 'utf-8');
  log(`💾 data/transito.json OK — ${items.length} alerta(s). Provincias: `+[...new Set(items.map(i=>i.provincia))].join(', '));
  process.exit(0);
}
main().catch(e=>{ log('FATAL: '+(e&&e.message?e.message:e)); process.exit(1); });

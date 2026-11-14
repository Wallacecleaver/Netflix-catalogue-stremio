// Résolution À LA DEMANDE : quand Stremio demande les flux d'une fiche (ID IMDb `tt…`) qui n'est pas encore stockée,
//   1. TMDB : IMDb → titre, année, type (+ bande-annonce VF au passage)
//   2. Web  : recherche DuckDuckGo « site:netflix.com/title <titre> » → pages Netflix candidates
//   3. On lit la page Netflix, on vérifie que c'est bien le bon titre (nom, type, année) et on stocke sa bande-annonce
// Apple TV est ensuite cherché par appletv.ensure(). Tout est mis en cache (SQLite) : un titre n'est cherché qu'une fois.
const config = require('./config');
const store = require('./db');
const log = require('./log');
const tmdb = require('./tmdb');
const search = require('./search');
const netflix = require('./netflix');
const { ingestNetflix } = require('./enrich');

const HIT_TTL = 30 * 24 * 3600 * 1000;    // titre résolu : on ne recherche plus avant 30 j
const MISS_TTL = 7 * 24 * 3600 * 1000;    // rien trouvé : nouvelle tentative au bout de 7 j
const TOTAL_TIMEOUT = 15000;              // Stremio n'attend pas indéfiniment : au-delà, la recherche continue en arrière-plan
const inflight = new Map();
let ddgBlockedUntil = 0;
let queue = Promise.resolve();
let lastAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** DuckDuckGo : une requête à la fois, au moins 1 s d'écart (évite le blocage). */
function ddg(q) {
  const job = queue.then(async () => {
    const wait = lastAt + 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    try { return await search.netflix(q); } finally { lastAt = Date.now(); }
  });
  queue = job.catch(() => {});
  return job;
}

/** Cherche la page Netflix d'un titre TMDB. → { nid, html } | { nid: null } | { skipped: true } (DuckDuckGo indisponible). */
async function findNetflix(info) {
  if (Date.now() < ddgBlockedUntil) return { skipped: true };
  let cands;
  try { cands = await ddg(info.name); }
  catch (e) {
    ddgBlockedUntil = Date.now() + 10 * 60 * 1000;      // pause de 10 min : on ne retape pas DuckDuckGo à chaque ouverture de fiche
    log.warn('resolve', `DuckDuckGo : ${e.message}`);
    return { skipped: true };
  }
  const names = new Set([info.name, info.originalName].filter(Boolean).map(norm));
  const close = (t) => [...names].some((n) => norm(t) === n || norm(t).includes(n));
  const shortlist = [...cands.filter((c) => c.title && close(c.title)).slice(0, 3), ...cands.filter((c) => !c.title).slice(0, 2)];
  for (const c of shortlist) {
    try {
      const html = await netflix.fetchNetflixPage(c.id);
      const n = netflix.parseNetflixHtml(html);
      if (!n.name || !names.has(norm(n.name))) continue;                       // autre titre
      if (info.type && n.type && n.type !== info.type) continue;               // film ≠ série
      // Netflix donne l'année de la DERNIÈRE saison pour une série : on exige seulement qu'elle ne soit pas antérieure.
      if (info.year && n.year && !(info.type === 'series' ? n.year >= info.year - 1 : Math.abs(n.year - info.year) <= 1)) continue;
      return { nid: c.id, html };
    } catch (e) { log.warn('resolve', `Page Netflix ${c.id} : ${e.message}`); }
  }
  return { nid: null };
}

async function work(imdb, type, existing) {
  const info = await tmdb.findByImdb(imdb, type);
  if (!info) { store.setLookup(imdb, false); return existing; }
  const [bs, nf] = await Promise.allSettled([tmdb.basics(info.tmdbType, info.tmdbId), findNetflix(info)]);
  const b = bs.status === 'fulfilled' ? bs.value : {};
  const net = nf.status === 'fulfilled' ? nf.value : {};
  let id;
  if (net.nid) id = (await ingestNetflix(net.nid, { html: net.html })).id;
  else id = existing ? existing.id : `imdb:${imdb}`;

  const base = { id, imdb_id: imdb, tmdb_id: info.tmdbId, tmdb_type: info.tmdbType, vf_trailer: b.vf || null, vf_checked: Date.now() };
  if (net.nid) { const row = store.getTitle(id); store.upsertTitle({ ...base, type: row.type, name: row.name }); }   // on garde les infos Netflix
  else store.upsertTitle({ ...base, type: info.type, name: info.name, year: info.year, release_date: info.release_date || b.release_date,
    synopsis: info.synopsis, poster: info.poster, background: info.background, genres: b.genres, runtime: b.runtime });

  const row = store.getTitle(id);
  const found = !!(row.vf_trailer || row.trailers.length);
  if (!net.skipped) store.setLookup(imdb, found);      // DuckDuckGo indisponible : on retentera plus tard
  log.info('resolve', `${info.name} (${imdb}) : ${net.nid ? 'Netflix ' + net.nid : net.skipped ? 'Netflix non vérifié' : 'pas sur Netflix'}${b.vf ? ' + VF' : ''}`);
  return row;
}

/** Renvoie la fiche (créée / complétée si besoin) pour un ID IMDb. N'échoue jamais : au pire, renvoie `existing`. */
async function ensure(imdb, type, existing) {
  if (!config.resolveEnabled || !config.tmdbKey || !/^tt\d+$/.test(String(imdb))) return existing;
  if (existing && (existing.trailers.length || existing.appletv.length)) return existing;      // déjà une bande-annonce Netflix / Apple TV
  const chk = store.getLookup(imdb);
  if (chk && Date.now() - chk.checked_at < (chk.found ? HIT_TTL : MISS_TTL)) return existing;
  if (!inflight.has(imdb)) {
    inflight.set(imdb, work(imdb, type, existing).catch((e) => { log.warn('resolve', `${imdb} : ${e.message}`); return existing; })
      .finally(() => inflight.delete(imdb)));
  }
  const res = await Promise.race([inflight.get(imdb), sleep(TOTAL_TIMEOUT).then(() => undefined)]);
  return res === undefined ? (store.findByImdbId(imdb) || existing) : res;     // délai dépassé : la recherche finit en arrière-plan
}

module.exports = { ensure, findNetflix };

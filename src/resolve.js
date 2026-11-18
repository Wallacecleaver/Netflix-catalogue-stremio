// Résolution À LA DEMANDE : quand Stremio demande les flux d'une fiche (ID IMDb `tt…`) qui n'est pas encore stockée,
//   1. TMDB : IMDb → titre, année, type 
//   2. Web  : recherche Brave Search « site:netflix.com/title <titre> » (DuckDuckGo en secours, sans clé) → pages Netflix candidates
//   3. On lit la page Netflix, on vérifie que c'est bien le bon titre (nom, type, année) et on stocke sa bande-annonce
// Apple TV est ensuite cherché par appletv.ensure(). Tout est mis en cache (SQLite) : un titre n'est cherché qu'une fois.
const config = require('./config');
const store = require('./db');
const log = require('./log');
const tmdb = require('./tmdb');
const search = require('./search');
const youtube = require('./youtube');
const netflix = require('./netflix');
const { ingestNetflix } = require('./enrich');

const HIT_TTL = 30 * 24 * 3600 * 1000;    // titre résolu : on ne recherche plus avant 30 j
const MISS_TTL = 7 * 24 * 3600 * 1000;    // rien trouvé : nouvelle tentative au bout de 7 j
const TOTAL_TIMEOUT = 15000;              // Stremio n'attend pas indéfiniment : au-delà, la recherche continue en arrière-plan
const MAX_PER_MIN = 20;                    // garde-fou : l'API publique ne doit pas pouvoir déclencher des centaines de recherches web
const inflight = new Map();
let starts = [];
let searchBlockedUntil = 0;
let queue = Promise.resolve();
let lastAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Recherche web : une requête à la fois, au moins 1 s d'écart (limite du plan gratuit Brave : 1 req/s). */
function webSearch(q) {
  const job = queue.then(async () => {
    const wait = lastAt + 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    try { return await search.netflix(q); } finally { lastAt = Date.now(); }
  });
  queue = job.catch(() => {});
  return job;
}

/** Cherche la page Netflix d'un titre TMDB. → { nid, html } | { nid: null } | { skipped: true } (recherche web indisponible). */
async function findNetflix(info) {
  if (Date.now() < searchBlockedUntil) return { skipped: true };
  let cands;
  try { cands = await webSearch(info.name); }
  catch (e) {
    searchBlockedUntil = Date.now() + 10 * 60 * 1000;   // pause de 10 min : on ne relance pas la recherche à chaque ouverture de fiche
    log.warn('resolve', `Recherche web : ${e.message}`);
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
  if (!existing && info.tmdbId) {
    const byTmdb = store.findByTmdb(info.tmdbType, info.tmdbId);
    if (byTmdb) existing = store.getTitle(byTmdb.id);
  }
  const knownNid = existing && existing.netflix_id ? String(existing.netflix_id) : null;
  const [bs, nf] = await Promise.allSettled([
    tmdb.basics(info.tmdbType, info.tmdbId),
    knownNid
      ? netflix.fetchNetflixPage(knownNid).then((html) => ({ nid: knownNid, html }))
      : findNetflix(info),
  ]);
  const b = bs.status === 'fulfilled' ? bs.value : {};
  const net = nf.status === 'fulfilled' ? nf.value : {};

  // Ni bande-annonce TMDB, ni fiche Netflix : dernière chance, une recherche YouTube VF (matching strict).
  let yt = b.trailer_yt || null;
  let vfYt = b.vf_trailer || null;
  if (!yt && !net.nid) {
    try {
      const found = await youtube.findTrailer(info);
      if (found) { yt = found.id; vfYt = found.id; }
    } catch { /* pas bloquant : la fiche sera simplement sans bande-annonce */ }
  }
  let id;
  if (net.nid) id = (await ingestNetflix(net.nid, { html: net.html })).id;
  else id = existing ? existing.id : `imdb:${imdb}`;

  const base = {
    id,
    imdb_id: imdb,
    tmdb_id: info.tmdbId,
    tmdb_type: info.tmdbType,
    vf_checked: Date.now(),
    ...(yt ? { trailer_yt: yt } : {}),
    ...(vfYt ? { vf_trailer: vfYt } : {}),
  };
  if (net.nid) {
    const row = store.getTitle(id);
    store.upsertTitle({ ...base, type: row.type, name: row.name }); // on garde les infos Netflix
    if (info.tmdbId) store.deleteDuplicates(info.tmdbType, info.tmdbId, id);
    if (existing && existing.id !== id && store.getTitle(existing.id)) {
      // Fusionne une éventuelle fiche `imdb:tt…` préexistante vers la nouvelle fiche `nflx:…`
      const cur = store.getTitle(id);
      const mergedApple = cur.appletv.length ? cur.appletv : (existing.appletv || []);
      const curManual = (cur.extra && Array.isArray(cur.extra.manualTrailers)) ? cur.extra.manualTrailers : [];
      const exManual = (existing.extra && Array.isArray(existing.extra.manualTrailers)) ? existing.extra.manualTrailers : [];
      const mergedManual = [...curManual, ...exManual.filter((m) => m && m.url && !curManual.some((c) => c.url === m.url))].slice(-5);
      store.upsertTitle({
        id,
        type: cur.type,
        name: cur.name,
        ...(mergedApple.length && !cur.appletv.length ? { appletv: mergedApple } : {}),
        ...(mergedManual.length !== curManual.length ? { extra: { ...(cur.extra || {}), manualTrailers: mergedManual } } : {}),
      });
      store.deleteTitle(existing.id);
    }
  } else {
    store.upsertTitle({ ...base, type: info.type, name: info.name, year: info.year, release_date: info.release_date || b.release_date,
      synopsis: info.synopsis, poster: info.poster, background: info.background, genres: b.genres, runtime: b.runtime });
  }

  const row = store.getTitle(id);
  const found = !!row.trailers.length;
  if (!net.skipped) store.setLookup(imdb, found);      // recherche web indisponible : on retentera plus tard
  log.info('resolve', `${info.name} (${imdb}) : ${net.nid ? 'Netflix ' + net.nid : net.skipped ? 'Netflix non vérifié' : 'pas sur Netflix'}`);
  return row;
}

function allowStart() {
  const now = Date.now();
  starts = starts.filter((t) => now - t < 60000);
  if (starts.length >= MAX_PER_MIN) return false;
  starts.push(now);
  return true;
}

/** Une recherche est-elle en cours pour cet IMDb ? (l'API le signale à l'appelant : « réessaie dans quelques secondes ») */
const isPending = (imdb) => inflight.has(imdb);

/**
 * Renvoie la fiche (créée / complétée si besoin) pour un ID IMDb. N'échoue jamais : au pire, renvoie `existing`.
 * `timeoutMs` : durée maximale d'attente de l'appelant ; la recherche, elle, continue en arrière-plan.
 */
async function ensure(imdb, type, existing, { timeoutMs = TOTAL_TIMEOUT } = {}) {
  if (!config.resolveEnabled || !config.tmdbKey || !/^tt\d+$/.test(String(imdb))) return existing;
  if (existing && (existing.trailers.length || existing.appletv.length)) return existing;      // déjà une bande-annonce Netflix / Apple TV
  const chk = store.getLookup(imdb);
  if (chk && Date.now() - chk.checked_at < (chk.found ? HIT_TTL : MISS_TTL)) return existing;
  if (!inflight.has(imdb)) {
    if (!allowStart()) { log.warn('resolve', `Limite de ${MAX_PER_MIN} recherches/minute atteinte : ${imdb} sera cherché plus tard`); return existing; }
    inflight.set(imdb, work(imdb, type, existing).catch((e) => { log.warn('resolve', `${imdb} : ${e.message}`); return existing; })
      .finally(() => inflight.delete(imdb)));
  }
  const res = await Promise.race([inflight.get(imdb), sleep(timeoutMs).then(() => undefined)]);
  return res === undefined ? (store.findByImdbId(imdb) || existing) : res;     // délai dépassé : la recherche finit en arrière-plan
}

module.exports = { ensure, isPending, findNetflix };

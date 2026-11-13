const config = require('./config');
const store = require('./db');
const log = require('./log');
const tmdb = require('./tmdb');
const jw = require('./justwatch');
const { fetchNetflixPage, parseNetflixHtml } = require('./netflix');
const { withReleased, mergeEpisodes } = require('./enrich');

// Job de fond : associe à chaque fiche son ID Netflix (via JustWatch), récupère la bande-annonce
// sur la page Netflix et complète les identifiants TMDB/IMDb manquants.
const state = {
  running: false, stopRequested: false,
  total: 0, done: 0, linked: 0, skipped: 0, failed: 0,
  current: null, startedAt: null, finishedAt: null, errors: [],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function status() {
  return {
    running: state.running, total: state.total, done: state.done,
    linked: state.linked, skipped: state.skipped, failed: state.failed,
    current: state.current, startedAt: state.startedAt, finishedAt: state.finishedAt,
    percent: state.total ? Math.round((state.done / state.total) * 100) : 0,
    errors: state.errors.slice(-8),
  };
}

const first = (cur, ...values) => {
  if (cur !== undefined && cur !== null && cur !== '' && !(Array.isArray(cur) && !cur.length)) return cur;
  return values.find((v) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) ?? null;
};

async function searchWithRetry(query, opts) {
  try { return await jw.searchNetflix(query, opts); }
  catch (e) {
    await sleep(1500);
    return jw.searchNetflix(query, opts);
  }
}

/** JustWatch d'abord sur le nom complet, puis sans sous-titre (après « : » ou « - »). */
async function findMatch(row) {
  const opts = { country: config.region, language: String(config.lang || 'fr-FR').slice(0, 2) };
  const name = String(row.name || '').replace(/\s*\(\d{4}\)\s*$/, '').trim();
  if (!name) return null;
  let best = jw.pickBest(await searchWithRetry(name, opts), { name, year: row.year, type: row.type });
  if (best) return best;
  const short = name.split(/\s*[:–—]\s*|\s+-\s+/)[0].trim();
  if (short && short !== name && short.length >= 3) {
    best = jw.pickBest(await searchWithRetry(short, opts), { name: short, year: row.year, type: row.type });
  }
  return best;
}

/** Associe une fiche (sans `netflix_id`) à un ID Netflix. */
async function linkOne(row) {
  if (!row || row.netflix_id) return { linked: false, reason: 'déjà lié' };
  const best = await findMatch(row);
  if (!best) return { linked: false, reason: 'introuvable' };

  const nid = best.netflixId;
  const twin = store.getTitle(`nflx:${nid}`);

  // Page publique Netflix : bande-annonce, épisodes, casting, visuels. Un blocage n'empêche pas d'enregistrer l'ID.
  let n = null;
  try {
    const parsed = parseNetflixHtml(await fetchNetflixPage(nid));
    if (parsed.name) n = parsed;
  } catch (e) {
    const msg = `page Netflix : ${e.message}`;
    state.errors.push(`${row.name} : ${msg}`);
    if (state.errors.length > 40) state.errors.shift();
    log.warn('link', `${row.name} : ${msg}`, { netflix_id: nid });
  }

  // Complète TMDB/IMDb si la fiche n'a pas encore ces identifiants.
  let t = null;
  if (!row.tmdb_id && config.tmdbKey) {
    try {
      const m = await tmdb.searchMatch({ name: n?.name || row.name, year: row.year || n?.year, type: row.type });
      if (m) t = await tmdb.fetchFull(m.tmdbType, m.id);
    } catch (e) { /* on garde l'ID Netflix même si TMDB échoue */ }
  }
  let imdb = row.imdb_id;
  if (!imdb && row.tmdb_id && config.tmdbKey) {
    try { imdb = (await tmdb.externalIds(row.tmdb_type, row.tmdb_id)).imdb_id; } catch (e) { /* ignore */ }
  }

  const patch = {
    id: row.id, type: row.type, name: row.name,
    netflix_id: nid,
    tmdb_id: first(row.tmdb_id, t?.tmdbId, twin?.tmdb_id),
    tmdb_type: first(row.tmdb_type, t?.tmdbType, twin?.tmdb_type),
    imdb_id: first(imdb, t?.imdb_id, twin?.imdb_id),
    year: first(row.year, n?.year, t?.year, twin?.year),
    release_date: first(row.release_date, t?.release_date, n?.releaseDate, twin?.release_date),
    certification: first(row.certification, n?.certification, t?.certification, twin?.certification),
    genres: first(row.genres, n?.genres?.length ? n.genres : null, t?.genres, twin?.genres),
    synopsis: first(row.synopsis, n?.synopsis, t?.synopsis, twin?.synopsis),
    cast: first(row.cast, n?.cast?.length ? n.cast : null, t?.cast, twin?.cast),
    poster: first(row.poster, t?.poster, n?.image, twin?.poster),
    background: first(row.background, n?.background, t?.background, n?.image, twin?.background),
    logo: first(row.logo, n?.logo, t?.logo, twin?.logo),
    trailer_yt: first(row.trailer_yt, t?.trailer_yt, twin?.trailer_yt),
    runtime: first(row.runtime, t?.runtime, twin?.runtime),
    trailers: first(n?.trailers, row.trailers, twin?.trailers) || [],
    extra: {
      ...(row.extra || {}),
      directors: first(row.extra?.directors, n?.directors, t?.directors) || [],
      creators: first(row.extra?.creators, n?.creators) || [],
      netflixGenres: first(row.extra?.netflixGenres, n?.netflixGenres) || [],
      tags: first(row.extra?.tags, n?.tags) || [],
      seasonLabels: first(row.extra?.seasonLabels, n?.seasonLabels) || [],
      netflixLinkedAt: Date.now(),
    },
    enriched: row.enriched ? 1 : 0,
  };

  store.upsertTitle(patch);
  store.deleteNetflixDuplicates(nid, row.id);

  if (patch.type === 'series') {
    const existing = store.getEpisodes(row.id);
    if (n?.episodes?.length) {
      const merged = withReleased(mergeEpisodes(n.episodes, existing), patch.release_date || patch.year || n.releaseDate);
      store.replaceEpisodes(row.id, merged);
    } else if (twin && twin.id !== row.id && !existing.length) {
      const twinEps = store.getEpisodes(twin.id);
      if (twinEps.length) store.replaceEpisodes(row.id, twinEps);
    }
  }

  return { linked: true, netflixId: nid, name: n?.name || row.name, trailers: (patch.trailers || []).length };
}

/** Lance le liage en arrière-plan. `limit` > 0 borne le nombre de fiches traitées. */
async function run({ limit = 0, delayMs = 300, onProgress } = {}) {
  if (state.running) throw new Error('Liage déjà en cours');
  const rows = store.listUnlinked({ limit });
  Object.assign(state, {
    running: true, stopRequested: false, total: rows.length, done: 0,
    linked: 0, skipped: 0, failed: 0, current: null, startedAt: Date.now(), finishedAt: null, errors: [],
  });
  console.log(`[link] ${rows.length} titre(s) sans ID Netflix`);
  if (!rows.length) {
    state.running = false;
    state.finishedAt = Date.now();
    return status();
  }
  log.info('link', `Début du liage : ${rows.length} titre(s) à associer`, { total: rows.length });

  try {
    for (const row of rows) {
      if (state.stopRequested) break;
      state.current = { id: row.id, name: row.name, type: row.type };
      try {
        const res = await linkOne(row);
        if (res.linked) {
          state.linked++;
          log.info('link', `ID Netflix associé : ${row.name}`, { netflix_id: res.netflixId, trailers: res.trailers });
        } else {
          state.skipped++;
          log.warn('link', `Introuvable : ${row.name}`, { type: row.type, id: row.id });
        }
      } catch (e) {
        state.failed++;
        state.errors.push(`${row.name} : ${e.message}`);
        if (state.errors.length > 40) state.errors.shift();
        log.error('link', `${row.name} : ${e.message}`, { id: row.id });
        console.warn('[link]', row.name, e.message);
      }
      state.done++;
      if (onProgress) { try { onProgress(status()); } catch (e) { /* ignore */ } }
      if (delayMs) await sleep(delayMs);
    }
  } finally {
    state.running = false;
    state.current = null;
    state.finishedAt = Date.now();
    console.log(`[link] terminé : +${state.linked} liés, ${state.skipped} introuvables, ${state.failed} erreurs`);
    log.info('link', `Liage terminé : ${state.linked} liés, ${state.skipped} introuvables, ${state.failed} erreurs`,
      { linked: state.linked, skipped: state.skipped, failed: state.failed, total: state.total });
  }
  return status();
}

/** Démarre sans attendre (le job continue en arrière-plan). */
function start(opts = {}) {
  if (state.running) return status();
  run(opts).catch((e) => {
    state.running = false;
    state.finishedAt = Date.now();
    state.errors.push(e.message);
    console.warn('[link]', e.message);
  });
  return status();
}

function stop() {
  state.stopRequested = true;
  return status();
}

module.exports = { run, start, stop, status, linkOne, findMatch };

const config = require('./config');
const store = require('./db');
const log = require('./log');
const tmdb = require('./tmdb');

// Job de fond : pour chaque titre, une requête TMDB qui (1) cherche une bande-annonce YouTube EN FRANÇAIS
// et (2) complète affiche, fond, synopsis, genres et IMDb quand la fiche vient du moissonnage (donc vide).
// Les titres sans TMDB sont recherchés par nom + année + type. Fonctionne pour TOUS les titres, américains compris.
const state = {
  running: false, stopRequested: false,
  total: 0, done: 0, withVf: 0, noMatch: 0, failed: 0,
  current: null, startedAt: null, finishedAt: null, errors: [],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function status() {
  return {
    running: state.running, total: state.total, done: state.done,
    withVf: state.withVf, noMatch: state.noMatch, failed: state.failed,
    percent: state.total ? Math.round((state.done / state.total) * 100) : 0,
    current: state.current, startedAt: state.startedAt, finishedAt: state.finishedAt,
    errors: state.errors.slice(-8),
  };
}

/** Réessaie sur 429 (limite TMDB) ; renvoie null sur 404 (fiche TMDB disparue). */
async function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      const code = /TMDB (\d{3})/.exec(e.message)?.[1];
      if (code === '404') return null;
      if ((code === '429' || code === '500' || code === '502' || code === '503' || !code) && attempt < 3) { await sleep(2500 * (attempt + 1)); continue; }
      throw e;
    }
  }
}

/** Traite une fiche ; renvoie { vf: bool, match: bool }. */
async function checkOne(row) {
  let tmdbType = row.tmdb_type;
  let tmdbId = row.tmdb_id;
  if (!tmdbId) {
    const m = await withRetry(() => tmdb.searchMatch({ name: row.name, year: row.year, type: row.type }));
    if (m) { tmdbType = m.tmdbType; tmdbId = m.id; }
  }
  const base = { id: row.id, type: row.type, name: row.name, vf_checked: Date.now() };
  if (!tmdbId) { store.upsertTitle(base); return { vf: false, match: false }; }

  const b = await withRetry(() => tmdb.basics(tmdbType, tmdbId));
  if (!b) { store.upsertTitle({ ...base, tmdb_id: tmdbId, tmdb_type: tmdbType }); return { vf: false, match: false }; }

  // On ne remplace jamais une valeur déjà présente (Netflix/TMDB complet) : on comble seulement les trous.
  store.upsertTitle({
    ...base,
    tmdb_id: tmdbId, tmdb_type: tmdbType,
    imdb_id: row.imdb_id || b.imdb_id || null,
    year: row.year || b.year || null, release_date: row.release_date || b.release_date || null,
    synopsis: row.synopsis || b.synopsis || null,
    genres: row.genres && row.genres.length ? row.genres : b.genres,
    poster: row.poster || b.poster || null, background: row.background || b.background || null,
    runtime: row.runtime || b.runtime || null,
    vf_trailer: b.vf || null,
  });
  return { vf: !!b.vf, match: true };
}

/** Lance la vérification. `limit` > 0 borne le nombre de fiches ; `concurrency` requêtes TMDB en parallèle. */
async function run({ limit = 0, concurrency = 4, delayMs = 150, onProgress } = {}) {
  if (state.running) throw new Error('Vérification déjà en cours');
  if (!config.tmdbKey) { const msg = 'TMDB_API_KEY manquant'; log.error('vf', msg); throw new Error(msg); }
  const rows = store.listVfPending({ limit });
  Object.assign(state, {
    running: true, stopRequested: false, total: rows.length, done: 0, withVf: 0, noMatch: 0, failed: 0,
    current: null, startedAt: Date.now(), finishedAt: null, errors: [],
  });
  log.info('vf', `Début de la recherche des bandes-annonces VF : ${rows.length} titre(s)`, { total: rows.length });

  let next = 0;
  const worker = async () => {
    while (!state.stopRequested) {
      const row = rows[next++];
      if (!row) return;
      state.current = { id: row.id, name: row.name, type: row.type };
      try {
        const r = await checkOne(row);
        if (r.vf) state.withVf++;
        if (!r.match) state.noMatch++;
      } catch (e) {
        state.failed++;
        state.errors.push(`${row.name} : ${e.message}`);
        if (state.errors.length > 40) state.errors.shift();
        log.error('vf', `${row.name} : ${e.message}`, { id: row.id });
      }
      state.done++;
      if (onProgress) { try { onProgress(status()); } catch { /* ignore */ } }
      if (delayMs) await sleep(delayMs);
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  } finally {
    state.running = false;
    state.current = null;
    state.finishedAt = Date.now();
    log.info('vf', `Recherche VF terminée : ${state.withVf} avec bande-annonce française, ${state.noMatch} sans fiche TMDB, ${state.failed} erreurs`,
      { withVf: state.withVf, noMatch: state.noMatch, failed: state.failed, done: state.done, total: state.total });
  }
  return status();
}

/** Démarre sans attendre (le job continue en arrière-plan). */
function start(opts = {}) {
  if (state.running) return status();
  if (!config.tmdbKey) throw new Error('TMDB_API_KEY manquant : renseigne-le dans le .env ou dans Paramètres');
  const p = run(opts);
  p.catch((e) => { state.errors.push(e.message); console.warn('[vf]', e.message); });
  return status();
}

function stop() {
  state.stopRequested = true;
  return status();
}

module.exports = { run, start, stop, status, checkOne };

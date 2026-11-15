const store = require('./db');
const log = require('./log');
const link = require('./link');

// Job de fond : lit la page Netflix de chaque titre DÉJÀ lié à un ID mais sans bande-annonce stockée.
// Le moissonnage JustWatch ne pose que les IDs (`netflix_id`) ; seule la lecture des pages donne les
// vidéos, les épisodes et le casting. C'est donc ce job qui remplit réellement la base : sans lui, un
// catalogue de 12 000 titres ne propose que les quelques bandes-annonces ouvertes à la main.
const RETRY_DAYS = 7;             // une page sans bande-annonce est relue au bout d'une semaine
const MAX_STREAK = 8;             // 8 échecs d'affilée = Netflix bloque, on s'arrête proprement
const state = {
  running: false, stopRequested: false,
  total: 0, done: 0, found: 0, failed: 0,
  current: null, startedAt: null, finishedAt: null, errors: [],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function status() {
  return {
    running: state.running, total: state.total, done: state.done,
    found: state.found, failed: state.failed,
    percent: state.total ? Math.round((state.done / state.total) * 100) : 0,
    current: state.current, startedAt: state.startedAt, finishedAt: state.finishedAt,
    errors: state.errors.slice(-8),
  };
}

/** Lance le remplissage en arrière-plan. `limit` > 0 borne le nombre de pages lues (utile pour tester). */
async function run({ limit = 0, delayMs = 1200, onProgress } = {}) {
  if (state.running) throw new Error('Remplissage des bandes-annonces déjà en cours');
  const rows = store.listNetflixTrailerPending({ limit, retryDays: RETRY_DAYS });
  Object.assign(state, {
    running: true, stopRequested: false, total: rows.length, done: 0, found: 0, failed: 0,
    current: null, startedAt: Date.now(), finishedAt: null, errors: [],
  });
  log.info('netflix', `Lecture des pages Netflix : ${rows.length} titre(s) sans bande-annonce`, { total: rows.length });
  if (!rows.length) {
    state.running = false;
    state.finishedAt = Date.now();
    return status();
  }

  let streak = 0;
  try {
    for (const row of rows) {
      if (state.stopRequested) break;
      state.current = { id: row.id, name: row.name, type: row.type };
      try {
        const res = await link.linkOne(row, { refresh: true });
        if (res.linked && res.trailers) state.found++;
        streak = 0;
        // Marqué seulement quand la page a réellement été lue : un échec réseau ne doit pas coûter
        // 7 jours d'attente (le garde-fou des 8 échecs consécutifs évite la boucle infinie).
        store.upsertTitle({ id: row.id, type: row.type, name: row.name, trailers_checked: Date.now() });
      } catch (e) {
        state.failed++;
        streak++;
        state.errors.push(`${row.name} : ${e.message}`);
        if (state.errors.length > 40) state.errors.shift();
        log.warn('netflix', `${row.name} : ${e.message}`, { id: row.id });
        if (streak >= MAX_STREAK) {
          log.error('netflix', `Arrêt : ${MAX_STREAK} échecs consécutifs (Netflix bloque les pages ?)`);
          break;
        }
      }
      // Marqué dans tous les cas : une page sans bande-annonce ne sera pas relue avant RETRY_DAYS.
      state.done++;
      if (onProgress) { try { onProgress(status()); } catch { /* ignore */ } }
      if (delayMs) await sleep(delayMs);
    }
  } finally {
    state.running = false;
    state.current = null;
    state.finishedAt = Date.now();
    log.info('netflix', `Pages Netflix lues : ${state.found} bande(s)-annonce(s) trouvée(s), ${state.failed} erreur(s)`,
      { done: state.done, total: state.total, found: state.found });
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
    log.error('netflix', e.message);
  });
  return status();
}

function stop() {
  state.stopRequested = true;
  return status();
}

module.exports = { run, start, stop, status };

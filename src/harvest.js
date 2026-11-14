const fs = require('fs');
const path = require('path');
const config = require('./config');
const store = require('./db');
const log = require('./log');
const jw = require('./justwatch');

// Moissonnage EXHAUSTIF du catalogue Netflix (région config.region) : on lit l'offre Netflix de chaque titre
// sur JustWatch, donc l'ID Netflix vient directement de l'URL (aucun appariement par nom, aucune erreur de fiche).
// Le catalogue est découpé par type + année de sortie pour ne jamais buter sur une limite de pagination.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/** Plages d'années à parcourir : un bloc pour l'ancien, puis année par année. */
function yearSlices({ from, to }) {
  const now = new Date().getFullYear() + 1;                 // inclut les sorties annoncées de l'an prochain
  const max = Math.min(to || now, now);
  const min = from || 1900;
  const slices = [];
  const oldEnd = Math.min(1979, max);
  if (min <= oldEnd) slices.push({ minYear: min, maxYear: oldEnd });
  for (let y = Math.max(min, 1980); y <= max; y++) slices.push({ minYear: y, maxYear: y });
  return slices.reverse();                                  // récent d'abord
}

async function pageWithRetry(args) {
  for (let attempt = 0; ; attempt++) {
    try { return await jw.listNetflixPage(args); }
    catch (e) {
      if (attempt >= 4) throw e;
      await sleep((e.rateLimited ? 8000 : 1500) * (attempt + 1));
    }
  }
}

/** « FR,US » ou ['fr','us'] → ['FR','US'] ; sans valeur : HARVEST_COUNTRIES (puis REGION). */
function countryList(input) {
  const raw = Array.isArray(input) ? input : String(input || config.harvestCountries || config.region || 'FR').split(/[\s,;]+/);
  const list = [...new Set(raw.map((c) => String(c).trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)))];
  return list.length ? list : ['FR'];
}

/** Enregistre un titre : met à jour une fiche connue, ou lie l'ID Netflix à la fiche TMDB, ou crée la fiche. */
function saveItem(it) {
  const tmdbType = it.type === 'series' ? 'tv' : 'movie';
  const known = store.findByNetflixId(it.netflixId);
  if (known) {
    store.upsertTitle({
      id: known.id, type: known.type, name: known.name, netflix_id: it.netflixId,
      tmdb_id: known.tmdb_id || it.tmdbId || null, tmdb_type: known.tmdb_type || (it.tmdbId ? tmdbType : null),
      imdb_id: known.imdb_id || it.imdbId || null,
      release_date: known.release_date || it.releaseDate || null, year: known.year || it.year || null,
    });
    return 'known';
  }
  if (it.tmdbId) {
    const hit = store.findByTmdb(tmdbType, it.tmdbId);
    const row = hit && store.getTitle(hit.id);
    if (row && !row.netflix_id) {
      store.upsertTitle({
        id: row.id, type: row.type, name: row.name, netflix_id: it.netflixId, imdb_id: row.imdb_id || it.imdbId || null,
        release_date: row.release_date || it.releaseDate || null, year: row.year || it.year || null,
      });
      return 'linked';
    }
  }
  if (!it.name) return 'skipped';
  store.upsertTitle({
    id: `nflx:${it.netflixId}`, netflix_id: it.netflixId, type: it.type, name: it.name,
    tmdb_id: it.tmdbId || null, tmdb_type: it.tmdbId ? tmdbType : null, imdb_id: it.imdbId || null,
    year: it.year || null, release_date: it.releaseDate || null,
  });
  return 'added';
}

/**
 * Parcourt tout le catalogue Netflix.
 * opts : { from, to, types: ['movie','series'], delayMs, dry, onProgress, shouldStop }
 */
async function harvest({ from, to, types = ['movie', 'series'], countries, delayMs = 400, dry = false, onProgress, shouldStop } = {}) {
  const seen = new Map();                                    // netflixId -> item (sert aussi à l'export en mode --dry)
  const stats = { seen: 0, added: 0, linked: 0, known: 0, skipped: 0, pages: 0, errors: [] };
  const slices = yearSlices({ from, to });
  const list = countryList(countries);
  const sliceTotal = list.length * slices.length * types.length;
  let sliceDone = 0;
  log.info('harvest', 'Début du moissonnage du catalogue Netflix', { countries: list, from, to, types });

  outer:
  for (const country of list) {
    for (const slice of slices) {
      for (const type of types) {
        if (shouldStop && shouldStop()) break outer;
        let after = null;
        for (let guard = 0; guard < 200; guard++) {
          if (shouldStop && shouldStop()) break outer;
          let page;
          try {
            page = await pageWithRetry({ country, objectType: type === 'movie' ? 'MOVIE' : 'SHOW', after, ...slice });
          } catch (e) {
            stats.errors.push(`${country} ${type} ${slice.minYear}-${slice.maxYear} : ${e.message}`);
            log.error('harvest', `${country} ${type} ${slice.minYear}-${slice.maxYear} : ${e.message}`);
            break;
          }
          stats.pages++;
          for (const it of page.items) {
            if (seen.has(it.netflixId)) continue;               // déjà vu (autre pays / autre page)
            seen.set(it.netflixId, it);
            stats.seen++;
            if (!dry) stats[saveItem(it)]++;
          }
          if (onProgress) { try { onProgress({ ...stats, country, slice, type, total: page.total, sliceDone, sliceTotal }); } catch { /* ignore */ } }
          if (!page.hasNext || !page.endCursor) break;
          after = page.endCursor;
          if (delayMs) await sleep(delayMs);
        }
        sliceDone++;
        if (onProgress) { try { onProgress({ ...stats, country, slice, type, total: null, sliceDone, sliceTotal }); } catch { /* ignore */ } }
        if (delayMs) await sleep(delayMs);
      }
    }
  }
  const stopped = !!(shouldStop && shouldStop());
  log.info('harvest', `Moissonnage ${stopped ? 'arrêté' : 'terminé'} : ${stats.seen} IDs Netflix`, { ...stats, errors: stats.errors.length });
  return { stats, items: [...seen.values()], stopped };
}

/** Écrit data/netflix-ids.json et data/netflix-ids.csv (ID Netflix, nom, type, année, TMDB, IMDb). */
function exportIds(items) {
  const rows = items || store.listLinked().map((r) => ({
    netflixId: r.netflix_id, name: r.name, type: r.type, year: r.year, tmdbId: r.tmdb_id, imdbId: r.imdb_id,
  }));
  rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  const dir = path.dirname(path.resolve(config.dbPath));
  fs.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, 'netflix-ids.json');
  const csvPath = path.join(dir, 'netflix-ids.csv');
  fs.writeFileSync(jsonPath, JSON.stringify(rows, null, 2));
  fs.writeFileSync(csvPath, ['netflix_id,name,type,year,tmdb_id,imdb_id',
    ...rows.map((r) => [r.netflixId, csvCell(r.name), r.type, r.year ?? '', r.tmdbId ?? '', r.imdbId ?? ''].join(','))].join('\n'));
  return { jsonPath, csvPath, count: rows.length };
}

// ---- Job de fond piloté depuis le dashboard (/admin) ----
const state = {
  running: false, stopRequested: false, mode: null,
  seen: 0, added: 0, linked: 0, known: 0, pages: 0, sliceDone: 0, sliceTotal: 0,
  current: null, startedAt: null, finishedAt: null, stopped: false, exported: null, errors: [],
};

function status() {
  return {
    running: state.running, mode: state.mode, stopped: state.stopped,
    seen: state.seen, added: state.added, linked: state.linked, known: state.known, pages: state.pages,
    percent: state.sliceTotal ? Math.round((state.sliceDone / state.sliceTotal) * 100) : 0,
    current: state.current, startedAt: state.startedAt, finishedAt: state.finishedAt,
    exported: state.exported, errors: state.errors.slice(-8),
  };
}

/** `recent` : seulement l'année précédente, en cours et suivante. Sinon tout le catalogue. */
async function run({ recent = false } = {}) {
  if (state.running) throw new Error('Moissonnage déjà en cours');
  Object.assign(state, {
    running: true, stopRequested: false, mode: recent ? 'recent' : 'all',
    seen: 0, added: 0, linked: 0, known: 0, pages: 0, sliceDone: 0, sliceTotal: 0,
    current: null, startedAt: Date.now(), finishedAt: null, stopped: false, exported: null, errors: [],
  });
  try {
    const res = await harvest({
      from: recent ? new Date().getFullYear() - 1 : undefined,
      shouldStop: () => state.stopRequested,
      onProgress(st) {
        Object.assign(state, { seen: st.seen, added: st.added, linked: st.linked, known: st.known, pages: st.pages,
          sliceDone: st.sliceDone, sliceTotal: st.sliceTotal, errors: st.errors });
        state.current = { type: st.type, country: st.country,
          label: st.slice.minYear === st.slice.maxYear ? String(st.slice.minYear) : `${st.slice.minYear}-${st.slice.maxYear}` };
      },
    });
    state.stopped = res.stopped;
    state.errors = res.stats.errors;
    state.exported = exportIds();
  } catch (e) {
    state.errors.push(e.message);
    log.error('harvest', e.message);
    throw e;
  } finally {
    state.running = false;
    state.current = null;
    state.finishedAt = Date.now();
  }
  return status();
}

/** Démarre sans attendre (le job continue en arrière-plan). */
function start(opts = {}) {
  if (state.running) return status();
  run(opts).catch((e) => console.warn('[harvest]', e.message));   // la partie synchrone de run() passe déjà running à true
  return status();
}

function stop() {
  state.stopRequested = true;
  return status();
}

module.exports = { harvest, exportIds, saveItem, yearSlices, countryList, run, start, stop, status };

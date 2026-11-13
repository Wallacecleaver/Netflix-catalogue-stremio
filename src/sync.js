const config = require('./config');
const store = require('./db');
const log = require('./log');
const tmdb = require('./tmdb');

const isoDay = (ts) => new Date(ts).toISOString().slice(0, 10);

/** Enregistre les résultats TMDB d'une page ; renvoie le nombre de titres ajoutés. */
function addResults(results, tmdbType, genres) {
  let added = 0;
  for (const r of results) {
    const name = r.name || r.title;
    if (!name || store.findByTmdb(tmdbType, r.id)) continue;
    const date = r.first_air_date || r.release_date || null;
    store.upsertTitle({
      id: `nflx:${tmdbType === 'tv' ? 'tv' : 'mv'}-${r.id}`,
      tmdb_id: r.id, tmdb_type: tmdbType, type: tmdbType === 'tv' ? 'series' : 'movie',
      name, year: date ? +date.slice(0, 4) : null, release_date: date,
      synopsis: r.overview || null,
      poster: tmdb.img(r.poster_path, 'w500'), background: tmdb.img(r.backdrop_path, 'w1280'),
      genres: (r.genre_ids || []).map((g) => genres.get(g)).filter(Boolean),
    });
    added++;
  }
  return added;
}

/** Remplit le catalogue avec les titres disponibles sur Netflix (région config.region) via TMDB. */
async function syncCatalog({ pages = config.syncPages } = {}) {
  if (!config.tmdbKey) { const msg = 'TMDB_API_KEY manquant'; log.error('sync', msg); throw new Error(msg); }
  let added = 0;
  for (const tmdbType of ['tv', 'movie']) {
    const genres = await tmdb.genreMap(tmdbType);
    for (let p = 1; p <= pages; p++) {
      const data = await tmdb.discover(tmdbType, p);
      added += addResults(data.results, tmdbType, genres);
      if (p >= data.total_pages) break;
    }
  }
  log.info('sync', `Catalogue synchronisé : +${added} titres`);
  return added;
}

/** Alimente les catalogues « Dernières sorties » : titres Netflix sortis ces RECENT_DAYS derniers jours. */
async function syncRecent({ pages = config.recentPages, days = config.recentDays } = {}) {
  if (!config.tmdbKey) { const msg = 'TMDB_API_KEY manquant'; log.error('sync', msg); throw new Error(msg); }
  const now = Date.now();
  const range = { since: isoDay(now - days * 86400000), until: isoDay(now) };
  let added = 0;
  for (const tmdbType of ['tv', 'movie']) {
    const genres = await tmdb.genreMap(tmdbType);
    for (let p = 1; p <= pages; p++) {
      const data = await tmdb.discoverRecent(tmdbType, { ...range, page: p });
      added += addResults(data.results, tmdbType, genres);
      if (p >= data.total_pages) break;
    }
  }
  log.info('sync', `Dernières sorties synchronisées : +${added} titres`, { days });
  return added;
}

module.exports = { syncCatalog, syncRecent };

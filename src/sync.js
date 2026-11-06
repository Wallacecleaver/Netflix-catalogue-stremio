const config = require('./config');
const store = require('./db');
const tmdb = require('./tmdb');

/** Remplit le catalogue avec les titres disponibles sur Netflix (région config.region) via TMDB. */
async function syncCatalog({ pages = config.syncPages } = {}) {
  if (!config.tmdbKey) throw new Error('TMDB_API_KEY manquant');
  let added = 0;
  for (const tmdbType of ['tv', 'movie']) {
    const genres = await tmdb.genreMap(tmdbType);
    for (let p = 1; p <= pages; p++) {
      const data = await tmdb.discover(tmdbType, p);
      for (const r of data.results) {
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
      if (p >= data.total_pages) break;
    }
  }
  return added;
}
module.exports = { syncCatalog };

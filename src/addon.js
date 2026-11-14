const { addonBuilder } = require('stremio-addon-sdk');
const config = require('./config');
const store = require('./db');
const log = require('./log');
const { enrichTitle } = require('./enrich');

const GENRES = ['Action', 'Animation', 'Aventure', 'Comédie', 'Crime', 'Documentaire', 'Drame', 'Familial', 'Fantastique',
  'Guerre', 'Histoire', 'Horreur', 'Musique', 'Mystère', 'Romance', 'Science-Fiction', 'Thriller', 'Western',
  'Action & Aventure', 'Kids', 'Reality', 'Sci-Fi & Fantastique'];

const extra = [{ name: 'search' }, { name: 'genre', options: GENRES }, { name: 'skip' }];

const manifest = {
  id: 'community.wallacecleaver.netflix-catalogue',
  version: '1.2.0',
  name: 'Netflix Catalogue',
  description: 'Catalogue Netflix avec fiches complètes : synopsis, casting, bande-annonce, épisodes et images. Le seul flux proposé est la bande-annonce Netflix.',
  resources: ['catalog', 'meta', 'stream'],
  types: ['series', 'movie'],
  idPrefixes: ['nflx:'],
  catalogs: [
    { type: 'movie', id: 'netflix-new-movies', name: 'Netflix — Dernières sorties (films)', extra },
    { type: 'series', id: 'netflix-new-series', name: 'Netflix — Dernières sorties (séries)', extra },
    { type: 'series', id: 'netflix-series', name: 'Netflix — Séries', extra },
    { type: 'movie', id: 'netflix-movies', name: 'Netflix — Films', extra },
  ],
};

const builder = new addonBuilder(manifest);

// Catalogues « dernières sorties » : triés par date de sortie, fenêtre config.recentDays.
const RECENT_CATALOGS = new Set(['netflix-new-movies', 'netflix-new-series']);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const rows = RECENT_CATALOGS.has(id)
    ? store.listRecent({ type, genre: extra.genre, skip: Number(extra.skip) || 0, limit: 100 })
    : store.listCatalog({ type, genre: extra.genre, search: extra.search, skip: Number(extra.skip) || 0, limit: 100 });
  return {
    metas: rows.map((r) => ({
      id: r.id, type: r.type, name: r.name, poster: r.poster, posterShape: 'poster',
      releaseInfo: r.year ? String(r.year) : undefined, genres: r.genres, description: r.synopsis || undefined,
    })),
    cacheMaxAge: config.metaCacheSeconds,
  };
});

function buildMeta(row, eps) {
  const description = [row.synopsis, row.certification ? `Classification : ${row.certification}` : null]
    .filter(Boolean).join('\n\n');
  const extra = row.extra || {};
  const meta = {
    id: row.id, type: row.type, name: row.name,
    poster: row.poster, posterShape: extra.posterShape || 'poster', background: row.background, logo: row.logo,
    description, releaseInfo: row.year ? String(row.year) : undefined,
    released: row.release_date ? new Date(row.release_date).toISOString() : undefined,
    genres: row.genres, cast: row.cast,
    director: extra.directors && extra.directors.length ? extra.directors : undefined,
    runtime: row.runtime ? `${row.runtime} min` : undefined,
    imdbId: row.imdb_id || undefined,
  };
  // Bande-annonce de la page Netflix : servie par NOTRE serveur (/trailer/...), qui renouvelle le lien signé à chaque lecture.
  const netflixTrailers = row.netflix_id
    ? (row.trailers || []).map((t, i) => ({ title: t.title || 'Bande-annonce', url: `${config.publicUrl}/trailer/${row.netflix_id}/${i}.mp4` }))
    : [];
  // On ne propose que les bandes-annonces Netflix (si disponibles).
  const trailerStreams = netflixTrailers;
  if (trailerStreams.length) meta.trailerStreams = trailerStreams;
  // YouTube trailer support removed
  if (row.type === 'series') {
    meta.videos = eps.map((e) => ({
      id: `${row.id}:${e.season}:${e.episode}`,
      title: e.name || `Épisode ${e.episode}`,
      season: e.season, episode: e.episode,
      overview: e.synopsis || undefined,
      thumbnail: e.image || undefined,
      released: e.released,
    }));
  }
  for (const k of Object.keys(meta)) if (meta[k] == null) delete meta[k];
  return meta;
}

builder.defineMetaHandler(async ({ id }) => {
  let row = store.getTitle(id);
  if (!row) return { meta: null };
  if (!row.enriched) {
    try { row = (await enrichTitle(id)) || row; }
    catch (e) { log.warn('enrich', `${id} : ${e.message}`); console.warn('[enrich]', id, e.message); }
  }
  return { meta: buildMeta(row, store.getEpisodes(id)), cacheMaxAge: config.metaCacheSeconds };
});

/** `nflx:tv-123`, `nflx:81944880` ou un épisode `nflx:81944880:1:2` → ID de la fiche (`nflx:xxx`). */
const baseId = (id) => String(id).split(':').slice(0, 2).join(':');

// Flux : uniquement la/les bande(s)-annonce(s) Netflix, relayée(s) par /trailer/... (lien Netflix renouvelé à chaque lecture).
// Pour une série, la même bande-annonce est proposée sur chaque épisode.
builder.defineStreamHandler(async ({ type, id }) => {
  const row = store.getTitle(baseId(id));
  if (!row || !row.netflix_id) return { streams: [], cacheMaxAge: 60 };
  const isEpisode = type === 'series' && String(id).split(':').length > 2;
  const streams = (row.trailers || []).map((t, i) => ({
    name: 'Netflix',
    title: `▶ ${t.title || 'Bande-annonce'}${isEpisode ? ' (série)' : ''}`,
    url: `${config.publicUrl}/trailer/${row.netflix_id}/${i}.mp4`,
    behaviorHints: { notWebReady: false, bingeGroup: `netflix-trailer-${row.netflix_id}` },
  }));
  return { streams, cacheMaxAge: 60 };
});

module.exports = { builder, manifest, buildMeta, baseId };

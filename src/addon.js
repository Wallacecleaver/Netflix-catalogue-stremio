const { addonBuilder } = require('stremio-addon-sdk');
const config = require('./config');
const store = require('./db');
const log = require('./log');
const federation = require('./federation');
const { enrichTitle } = require('./enrich');

const GENRES = ['Action', 'Animation', 'Aventure', 'Comédie', 'Crime', 'Documentaire', 'Drame', 'Familial', 'Fantastique',
  'Guerre', 'Histoire', 'Horreur', 'Musique', 'Mystère', 'Romance', 'Science-Fiction', 'Thriller', 'Western',
  'Action & Aventure', 'Kids', 'Reality', 'Sci-Fi & Fantastique'];

const extra = [{ name: 'search' }, { name: 'genre', options: GENRES }, { name: 'skip' }];

const manifest = {
  id: 'community.wallacecleaver.netflix-catalogue',
  version: '1.3.0',
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
    { type: 'movie', id: 'netflix-vf-movies', name: 'Netflix — Films avec bande-annonce VF', extra },
    { type: 'series', id: 'netflix-vf-series', name: 'Netflix — Séries avec bande-annonce VF', extra },
  ],
};

const builder = new addonBuilder(manifest);

// Catalogues « dernières sorties » : triés par date de sortie, fenêtre config.recentDays.
const RECENT_CATALOGS = new Set(['netflix-new-movies', 'netflix-new-series']);
// Catalogues « bande-annonce VF » : uniquement les titres pour lesquels TMDB a une bande-annonce en français.
const VF_CATALOGS = new Set(['netflix-vf-movies', 'netflix-vf-series']);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const rows = RECENT_CATALOGS.has(id)
    ? store.listRecent({ type, genre: extra.genre, skip: Number(extra.skip) || 0, limit: 100 })
    : store.listCatalog({ type, genre: extra.genre, search: extra.search, vf: VF_CATALOGS.has(id), skip: Number(extra.skip) || 0, limit: 100 });
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
  // Bande-annonce VF (via TMDB) d'abord, puis celles de la page Netflix / de l'instance amont.
  const trailerStreams = [
    ...(row.vf_trailer ? [{ title: 'Bande-annonce VF', ytId: row.vf_trailer }] : []),
    ...federation.trailerUrls(row).map(({ title, url }) => ({ title, url })),
  ];
  if (trailerStreams.length) meta.trailerStreams = trailerStreams;
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
  row = await federation.ensureUpstreamTrailers(row);
  return { meta: buildMeta(row, store.getEpisodes(id)), cacheMaxAge: config.metaCacheSeconds };
});

/** `nflx:tv-123`, `nflx:81944880` ou un épisode `nflx:81944880:1:2` → ID de la fiche (`nflx:xxx`). */
const baseId = (id) => String(id).split(':').slice(0, 2).join(':');

// Flux : la bande-annonce VF (via TMDB) en premier si elle existe, puis la/les bande(s)-annonce(s) de la page Netflix
// ou de l'instance amont, relayée(s) par /trailer/... quand un ID Netflix est connu. Proposées aussi sur chaque épisode.
builder.defineStreamHandler(async ({ type, id }) => {
  let row = store.getTitle(baseId(id));
  if (!row) return { streams: [], cacheMaxAge: 60 };
  row = await federation.ensureUpstreamTrailers(row);
  const isEpisode = type === 'series' && String(id).split(':').length > 2;
  const suffix = isEpisode ? ' (série)' : '';
  const streams = [];
  if (row.vf_trailer) streams.push({ name: 'Netflix VF', title: `▶ Bande-annonce VF${suffix}`, ytId: row.vf_trailer });
  for (const t of federation.trailerUrls(row)) {
    streams.push({
      name: t.source === 'upstream' ? 'Amont' : 'Netflix',
      title: `▶ ${t.title}${suffix}`,
      url: t.url,
      behaviorHints: { notWebReady: false, bingeGroup: `netflix-trailer-${row.netflix_id || row.id}` },
    });
  }
  return { streams, cacheMaxAge: 60 };
});

module.exports = { builder, manifest, buildMeta, baseId };

const { addonBuilder } = require('stremio-addon-sdk');
const config = require('./config');
const store = require('./db');
const log = require('./log');
const federation = require('./federation');
const appletv = require('./appletv');
const resolve = require('./resolve');
const { enrichTitle } = require('./enrich');

const TYPES = ['movie', 'series'];
// En-têtes envoyés au CDN Apple : sans eux le lecteur Stremio reste sur un chargement infini.
const APPLE_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', Origin: 'https://tv.apple.com', Referer: 'https://tv.apple.com/' };

// Plus de catalogue : l'addon ne fait que fournir des bandes-annonces.
//  - stream : sur n'importe quelle fiche Stremio (ID IMDb `tt…`, y compris épisodes) ET sur les anciennes fiches `nflx:`
//  - meta   : uniquement les anciennes fiches `nflx:` (déjà présentes dans des bibliothèques Stremio)
const manifest = {
  id: 'community.wallacecleaver.netflix-catalogue',
  version: '2.1.0',
  name: 'W stockage bande annonce',
  description: 'Bandes-annonces sur tes fiches Stremio : Netflix et Apple TV, cherchées automatiquement à l\'ouverture d\'une fiche. Aucun catalogue, aucun film ni épisode.',
  resources: [
    { name: 'meta', types: TYPES, idPrefixes: ['nflx:'] },
    { name: 'stream', types: TYPES, idPrefixes: ['nflx:', 'tt'] },
  ],
  types: TYPES,
  catalogs: [],
};

const builder = new addonBuilder(manifest);

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
  // Bandes-annonces de la page Netflix / de l'instance amont, puis Apple TV.
  const trailerStreams = [
    ...federation.trailerUrls(row).map(({ title, url }) => ({ title, url })),
    ...appletv.urls(row),
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
  row = await appletv.ensure(row);
  return { meta: buildMeta(row, store.getEpisodes(id)), cacheMaxAge: config.metaCacheSeconds };
});

/** `nflx:tv-123`, `nflx:81944880` ou un épisode `nflx:81944880:1:2` → ID de la fiche (`nflx:xxx`). */
const baseId = (id) => String(id).split(':').slice(0, 2).join(':');

/** Fiche stockée pour un ID Stremio : `nflx:…` (direct) ou `tt1234567` / `tt1234567:1:2` (via l'ID IMDb). */
function resolveRow(id) {
  const sid = String(id);
  if (sid.startsWith('nflx:')) return store.getTitle(baseId(sid));
  const imdb = sid.split(':')[0];
  if (!/^tt\d+$/.test(imdb)) return null;
  const hit = federation.lookup({ imdb });
  return hit ? store.getTitle(hit.id) : null;
}

// Flux, dans l'ordre : Netflix (ou instance amont, relayée par /trailer/... quand un ID
// Netflix est connu), puis Apple TV (HLS). Proposés aussi sur chaque épisode d'une série.
builder.defineStreamHandler(async ({ type, id }) => {
  let row = resolveRow(id);
  const imdb = String(id).split(':')[0];
  if (/^tt\d+$/.test(imdb)) row = (await resolve.ensure(imdb, type, row)) || row;   // fiche inconnue : TMDB → web → bande-annonce
  if (!row) return { streams: [], cacheMaxAge: 60 };
  row = await federation.ensureUpstreamTrailers(row);
  row = await appletv.ensure(row);
  const isEpisode = type === 'series' && String(id).split(':').length > 2;
  const suffix = isEpisode ? ' (série)' : '';
  const streams = [];
  for (const t of federation.trailerUrls(row)) {
    streams.push({
      name: t.source === 'upstream' ? 'Amont' : 'Netflix',
      title: `▶ ${t.title}${suffix}`,
      url: t.url,
      behaviorHints: { notWebReady: false, bingeGroup: `netflix-trailer-${row.netflix_id || row.id}` },
    });
  }
  for (const t of appletv.urls(row)) {
    streams.push({
      name: 'Apple TV', title: `▶ ${t.title}${suffix}`, url: t.url,
      behaviorHints: { notWebReady: true, bingeGroup: `appletv-trailer-${row.id}`, proxyHeaders: { request: APPLE_HEADERS } },   // flux HLS (.m3u8) ; Stremio relaie avec ces en-têtes
    });
  }
  return { streams, cacheMaxAge: 60 };
});

module.exports = { builder, manifest, buildMeta, baseId };

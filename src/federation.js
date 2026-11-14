const crypto = require('crypto');
const config = require('./config');
const store = require('./db');
const log = require('./log');

// Petite couche « fédération » : une instance peut exposer ses bandes-annonces
// (API /api/trailers) et/ou en récupérer depuis une instance amont configurée.
const UPSTREAM_TTL = 6 * 3600 * 1000; // nouvelle tentative au bout de 6 h
const attempts = new Map();

function keyOk(given) {
  if (!config.apiKey) return false;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(config.apiKey));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * URL des bandes-annonces d'une fiche, dans l'ordre de `row.trailers`.
 * - fiche avec ID Netflix : on passe par notre relais /trailer/<netflix_id>/<n>.mp4
 * - fiche sans ID Netflix mais avec trailers amont : on renvoie l'URL amont telle quelle
 */
function trailerUrls(row) {
  if (!row) return [];
  const list = Array.isArray(row.trailers) ? row.trailers : [];
  const out = [];
  list.forEach((t, i) => {
    if (!t) return;
    let url = null;
    if (row.netflix_id) url = `${config.publicUrl}/trailer/${row.netflix_id}/${i}.mp4`;
    else if (t.url && /^https?:\/\//i.test(String(t.url))) url = t.url;
    if (!url) return;
    const item = {
      title: t.title || 'Bande-annonce',
      url,
      runtime: t.runtime || null,
      source: t.source === 'upstream' ? 'upstream' : 'netflix',
    };
    if (t.source === 'upstream' && t.url) item.directUrl = t.url;
    out.push(item);
  });
  return out;
}

/** Retrouve une fiche par IMDb, TMDB (+ type) ou ID Netflix. */
function lookup({ imdb = '', tmdb = '', type = '', netflix = '' } = {}) {
  const imdbId = String(imdb || '').trim();
  const tmdbId = String(tmdb || '').trim();
  const netflixId = String(netflix || '').trim();
  if (netflixId) return store.findByNetflixId(netflixId);
  if (imdbId) return store.findByImdbId(imdbId);
  if (tmdbId) {
    const types = type === 'series' ? ['tv'] : type === 'movie' ? ['movie'] : ['movie', 'tv'];
    for (const tmdbType of types) {
      const hit = store.findByTmdb(tmdbType, tmdbId);
      if (hit) return store.getTitle(hit.id);
    }
  }
  return null;
}

/** Récupère les trailers d'une instance amont (config UPSTREAM_URL / UPSTREAM_API_KEY). */
async function fetchFromUpstream({ imdbId, tmdbId, type } = {}) {
  if (!config.upstreamUrl) return [];
  const params = new URLSearchParams();
  if (imdbId) params.set('imdb', imdbId);
  if (tmdbId) params.set('tmdb', String(tmdbId));
  if (type) params.set('type', type);
  if (!params.toString()) return [];

  const headers = { accept: 'application/json' };
  if (config.upstreamApiKey) headers['x-api-key'] = config.upstreamApiKey;
  const options = { headers };
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) options.signal = AbortSignal.timeout(8000);

  const res = await fetch(`${config.upstreamUrl}/api/trailers?${params.toString()}`, options);
  if (!res.ok) throw new Error(`amont HTTP ${res.status}`);
  const data = await res.json();
  return (Array.isArray(data.trailers) ? data.trailers : [])
    .filter((t) => t && /^https?:\/\//i.test(String(t.url || '')))
    .map((t) => ({ title: t.title || 'Bande-annonce', url: t.url, runtime: t.runtime || null, source: 'upstream' }));
}

/** Si la fiche n'a aucun trailer, tente de les récupérer depuis l'instance amont. */
async function ensureUpstreamTrailers(row) {
  if (!row || !config.upstreamUrl) return row;
  if (Array.isArray(row.trailers) && row.trailers.length) return row;
  if (!row.imdb_id && !row.tmdb_id) return row;
  const last = attempts.get(row.id);
  if (last && Date.now() - last < UPSTREAM_TTL) return row;
  attempts.set(row.id, Date.now());
  try {
    const trailers = await fetchFromUpstream({ imdbId: row.imdb_id, tmdbId: row.tmdb_id, type: row.type });
    if (!trailers.length) return row;
    store.upsertTitle({ id: row.id, type: row.type, name: row.name, trailers });
    log.info('upstream', `Bandes-annonces reçues de l'amont : ${row.name}`, { count: trailers.length });
    return store.getTitle(row.id);
  } catch (e) {
    log.warn('upstream', `${row.name} : ${e.message}`);
    return row;
  }
}

module.exports = { keyOk, trailerUrls, lookup, fetchFromUpstream, ensureUpstreamTrailers };

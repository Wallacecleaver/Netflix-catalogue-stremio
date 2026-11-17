const crypto = require('crypto');
const config = require('./config');
const store = require('./db');
const log = require('./log');
const hls = require('./hls');
const { assertSafeUrlSync, safeFetch } = require('./security');

// Petite couche « fédération » : une instance peut exposer ses bandes-annonces
// (API /api/trailers) et/ou en récupérer depuis une instance amont configurée.
const UPSTREAM_TTL = 6 * 3600 * 1000; // nouvelle tentative au bout de 6 h
const attempts = new Map();

// Une URL stockée puis relue par le serveur ne doit jamais viser le réseau interne.
function usableUrl(raw) {
  try { return assertSafeUrlSync(raw).href; } catch { return null; }
}

function keyOk(given) {
  if (!config.apiKey) return false;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(config.apiKey));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Numéro de saison explicite dans un libellé (« Saison 2 (Teaser) : Le Problème à 3 corps » → 2, pas 3). */
function detectSeason(title) {
  const s = String(title || '');
  const m = /\b(?:saison|season|partie|part|volume|vol\.?|tome|chapitre|livre)\s*(\d{1,2})\b/i.exec(s)
    || /\bS(\d{1,2})(?:\b|E\d)/i.exec(s);
  return m ? Number(m[1]) : null;
}

/** Nature d'une vidéo : vraie bande-annonce/teaser vs bonus long (« Au cœur de l'épisode », making-of…). */
function detectKind(t) {
  const s = String((t && t.title) || '');
  const rt = Number(t && t.runtime) || 0;
  if (/au c[oœ]ur de|making[- ]?of|coulisses|b[eê]tisier|extrait|clip|r[eé]cap|pr[eé]c[eé]demment|behind the scenes|featurette|interview/i.test(s) || rt >= 240) {
    return 'extra';
  }
  if (/\bteaser\b|aper[cç]u|annonce de la date|date announcement|dans cette saison|prochainement/i.test(s)) {
    return 'teaser';
  }
  return 'trailer';
}

/**
 * Trie les vidéos sans toucher à leur URL de relais (`/trailer/<id>/<n>.mp4` garde son index en base) :
 * - les vraies bandes-annonces / teasers passent toujours avant les bonus longs (« Au cœur de l'épisode ») ;
 * - si `season > 0` est demandé, les vidéos de cette saison arrivent en tête, puis celles sans numéro de saison.
 */
function orderForSeason(items, season) {
  const reqSeason = Number.isInteger(Number(season)) && Number(season) > 0 ? Number(season) : null;
  return items
    .map((item, idx) => {
      const s = item.season !== undefined ? item.season : detectSeason(item.title);
      const kind = item.kind || detectKind(item);
      const isExtra = kind === 'extra' ? 1 : 0;
      let rank;
      if (reqSeason) {
        if (s === reqSeason && !isExtra) rank = 0;
        else if (s === null && !isExtra) rank = 1;
        else if (s === reqSeason && isExtra) rank = 2;
        else if (s !== reqSeason && !isExtra) rank = 3;
        else rank = 4;
      } else {
        rank = isExtra;
      }
      return { item: { ...item, season: s, kind }, rank, idx };
    })
    .sort((a, b) => a.rank - b.rank || a.idx - b.idx)
    .map((x) => x.item);
}

/**
 * URL des bandes-annonces d'une fiche, triées pour mettre les vraies bandes-annonces (et la saison demandée) en tête.
 * - fiche avec ID Netflix : on passe par notre relais /trailer/<netflix_id>/<n>.mp4
 * - fiche sans ID Netflix mais avec trailers amont : on renvoie l'URL amont telle quelle
 *
 * `includeApple` / `includeManual` : ajoutent les bandes-annonces Apple TV (relayées par
 * /apple/<id>/<n>.mp4) et les liens ajoutés à la main (/media/...). Nécessaire pour l'API de
 * fédération : sans ça, un titre qui n'a QUE de l'Apple TV (beaucoup de séries Apple) était
 * annoncé « aucune bande-annonce » à l'instance amont.
 * Le handler `stream` de l'addon ne les demande pas : il les ajoute lui-même, avec ses propres
 * libellés (sinon elles apparaîtraient deux fois).
 */
function trailerUrls(row, { includeApple = false, includeManual = false, season = null } = {}) {
  if (!row) return [];
  const list = Array.isArray(row.trailers) ? row.trailers : [];
  const out = [];
  list.forEach((t, i) => {
    if (!t) return;
    let url = null;
    // Relay Netflix seulement pour NOS bandes-annonces : une entrée venue d'une instance amont garde son
    // URL d'origine. Sinon, sur une fiche à la fois liée à Netflix et enrichie par l'amont, l'index
    // pointait vers le relais Netflix et servait une autre vidéo (ou une 404).
    if (row.netflix_id && t.source !== 'upstream') url = `${config.publicUrl}/trailer/${row.netflix_id}/${i}.mp4`;
    else if (t.url) url = usableUrl(t.url);
    if (!url) return;
    const item = {
      title: t.title || 'Bande-annonce',
      url,
      runtime: t.runtime || null,
      source: t.source === 'upstream' ? 'upstream' : 'netflix',
    };
    if (t.source === 'upstream' && url) item.directUrl = url;
    out.push(item);
  });

  if (includeApple) {
    (Array.isArray(row.appletv) ? row.appletv : []).forEach((t, i) => {
      if (!t || !t.url || !hls.canServe(t.url)) return;
      out.push({
        title: t.title || 'Bande-annonce Apple TV',
        url: `${config.publicUrl}/apple/${encodeURIComponent(row.id)}/${i}.mp4`,
        runtime: t.runtime || null,
        source: 'appletv',
      });
    });
  }

  if (includeManual) {
    const manual = (row.extra && Array.isArray(row.extra.manualTrailers)) ? row.extra.manualTrailers : [];
    manual.forEach((t, i) => {
      if (!t || !t.url) return;
      out.push({
        title: t.title || 'Bande-annonce',
        url: `${config.publicUrl}/media/${encodeURIComponent(row.id)}/${i}.mp4`,
        runtime: null,
        source: 'manual',
      });
    });
  }

  return orderForSeason(out, season);
}

/** Retrouve une fiche par IMDb, TMDB (+ type) ou ID Netflix. */
function lookup({ imdb = '', tmdb = '', type = '', netflix = '' } = {}) {
  const imdbId = String(imdb || '').trim();
  const tmdbId = String(tmdb || '').trim();
  const netflixId = String(netflix || '').trim();
  if (netflixId) { const hit = store.findByNetflixId(netflixId); if (hit) return hit; }
  if (imdbId) { const hit = store.findByImdbId(imdbId); if (hit) return hit; }
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
  let base;
  try { base = assertSafeUrlSync(config.upstreamUrl).href.replace(/\/+$/, ''); }
  catch (e) { log.warn('upstream', `URL amont refusée (${e.message})`); return []; }
  const params = new URLSearchParams();
  if (imdbId) params.set('imdb', imdbId);
  if (tmdbId) params.set('tmdb', String(tmdbId));
  if (type) params.set('type', type);
  if (!params.toString()) return [];

  const headers = { accept: 'application/json' };
  if (config.upstreamApiKey) headers['x-api-key'] = config.upstreamApiKey;
  const options = { headers };
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) options.signal = AbortSignal.timeout(8000);

  const res = await safeFetch(`${base}/api/trailers?${params.toString()}`, options);
  if (!res.ok) throw new Error(`amont HTTP ${res.status}`);
  const data = await res.json();
  return (Array.isArray(data.trailers) ? data.trailers : [])
    // On ne garde que des URLs fetchables sans risque (pas d'IP interne, pas de javascript:…).
    .map((t) => ({ title: t?.title || 'Bande-annonce', url: usableUrl(t?.url), runtime: t?.runtime || null, source: 'upstream' }))
    .filter((t) => t.url);
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

module.exports = { keyOk, trailerUrls, lookup, fetchFromUpstream, ensureUpstreamTrailers, detectSeason, detectKind, orderForSeason };

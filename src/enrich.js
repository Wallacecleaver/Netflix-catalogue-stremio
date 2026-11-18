const config = require('./config');
const store = require('./db');
const log = require('./log');
const tmdb = require('./tmdb');
const { detectSeason } = require('./federation');

const netflix = require('./netflix');
const { parseNetflixId, parseNetflixHtml } = netflix;

// Stremio exige une date `released` par épisode. Netflix n'en donne pas : on part de la date de mise en ligne,
// avec un décalage de quelques secondes pour conserver l'ordre (sans créer d'épisodes "dans le futur").
function withReleased(eps, base) {
  const t0 = /^\d{4}-\d{2}-\d{2}/.test(String(base)) ? Date.parse(`${String(base).slice(0, 10)}T00:00:00Z`)
    : Date.UTC(Number(base) || 2000, 0, 1);
  return eps.map((e) => ({
    ...e,
    released: e.released ? new Date(`${String(e.released).slice(0, 10)}T00:00:00Z`).toISOString()
      : new Date(t0 + ((e.season - 1) * 1000 + (e.episode - 1)) * 1000).toISOString(),
  }));
}

// Netflix fait foi pour les saisons/épisodes qu'il fournit (ex. "Parties" de Lupin ≠ saisons TMDB).
// TMDB ne complète (date, image) que si la saison a exactement le même nombre d'épisodes.
function mergeEpisodes(netflixEps, tmdbEps) {
  if (!netflixEps.length) return tmdbEps;
  const out = [];
  for (const season of [...new Set(netflixEps.map((e) => e.season))]) {
    const nEps = netflixEps.filter((e) => e.season === season);
    const tEps = tmdbEps.filter((e) => e.season === season);
    const compatible = tEps.length === nEps.length;
    for (const ne of nEps) {
      const te = compatible ? tEps.find((x) => x.episode === ne.episode) : null;
      out.push({
        season, episode: ne.episode,
        name: ne.name || te?.name || null,
        synopsis: ne.synopsis || te?.synopsis || null,
        image: ne.image || te?.image || null,
        runtime: ne.runtime || te?.runtime || null,
        released: te?.released || null,
      });
    }
  }
  return out.sort((a, b) => a.season - b.season || a.episode - b.episode);
}

/** Ajoute / met à jour un titre depuis une URL ou un ID Netflix (ou depuis du HTML déjà téléchargé). */
async function ingestNetflix(input, opts = {}) {
  const nid = parseNetflixId(input);
  if (!nid) throw new Error('URL ou ID Netflix invalide');
  const n = parseNetflixHtml(opts.html || (await netflix.fetchNetflixPage(nid)));
  if (!n.name) throw new Error('Titre illisible (page bloquée ou structure changée) — lance `npm run inspect -- ' + nid + '`');

  let t = null;
  if (config.tmdbKey) {
    try {
      const m = await tmdb.searchMatch({ name: n.name, year: n.year, type: n.type });
      if (m) t = await tmdb.fetchFull(m.tmdbType, m.id);
    } catch (e) { console.warn('[tmdb]', e.message); }
  }

  const type = n.type || (t ? (t.tmdbType === 'tv' ? 'series' : 'movie') : 'movie');
  const id = `nflx:${nid}`;
  const existing = store.getTitle(id);
  const year = n.year || t?.year || null;
  const releaseDate = n.releaseDate || t?.release_date || null;
  const now = Date.now();

  const hasTmdbPoster = !!t?.poster;
  store.upsertTitle({
    id, netflix_id: nid, type, name: n.name,
    tmdb_id: t?.tmdbId, tmdb_type: t?.tmdbType, imdb_id: t?.imdb_id,
    year, release_date: releaseDate,
    certification: n.certification || t?.certification,
    genres: n.genres.length ? n.genres : t?.genres,
    synopsis: n.synopsis || t?.synopsis,
    cast: n.cast.length ? n.cast : t?.cast,
    poster: t?.poster || n.image,                       // TMDB = affiche verticale, sinon visuel horizontal Netflix
    background: n.background || t?.background || n.image,
    logo: n.logo || t?.logo,
    trailers: n.trailers, trailers_checked: now, runtime: t?.runtime,
    extra: {
      ...(existing?.extra || {}),
      directors: n.directors, creators: n.creators, netflixGenres: n.netflixGenres, tags: n.tags,
      seasonLabels: n.seasonLabels, posterShape: hasTmdbPoster ? 'poster' : 'landscape', fetchedAt: now,
    },
    enriched: 1,
  });
  if (t) store.deleteDuplicates(t.tmdbType, t.tmdbId, id);

  if (type === 'series') {
    store.replaceEpisodes(id, withReleased(mergeEpisodes(n.episodes, t?.episodes || []), releaseDate || year));
  }
  return {
    id, name: n.name, type, year, genres: n.genres, episodes: store.getEpisodes(id).length,
    seasons: [...new Set(n.episodes.map((e) => e.season))].length,
    trailersNetflix: n.trailers.length, trailers: n.trailers.length,
    warnings: n.warnings,
  };
}

/** Complète une fiche issue du catalogue TMDB (épisodes, casting, trailer…) à la première ouverture. */
async function enrichTitle(id) {
  const row = store.getTitle(id);
  if (!row || row.enriched || !row.tmdb_id || !config.tmdbKey) return row;
  const t = await tmdb.fetchFull(row.tmdb_type, row.tmdb_id);
  const trailer = t.trailer_yt || null;
  store.upsertTitle({
    id, type: row.type, name: row.name, imdb_id: t.imdb_id, year: t.year, release_date: t.release_date,
    certification: t.certification, genres: t.genres, synopsis: t.synopsis, cast: t.cast,
    poster: t.poster, background: t.background, logo: t.logo, trailer_yt: trailer, runtime: t.runtime, enriched: 1,
  });
  if (row.type === 'series') {
    // Fiche liée à Netflix : on garde la découpe Netflix (saisons/parties) et on complète avec TMDB.
    const existing = store.getEpisodes(id);
    const eps = row.netflix_id && existing.length ? mergeEpisodes(existing, t.episodes) : t.episodes;
    store.replaceEpisodes(id, withReleased(eps, t.release_date || t.year));
  }
  return store.getTitle(id);
}

// Re-télécharge la page pour obtenir des liens vidéo Netflix frais et capter tout nouveau teaser / nouvelle saison.
const inflight = new Map();
function refreshTrailers(nid) {
  const key = String(nid);
  if (!inflight.has(key)) {
    inflight.set(key, (async () => {
      const n = parseNetflixHtml(await netflix.fetchNetflixPage(key));
      const row = store.findByNetflixId(key);
      if (row && n.name) {
        const now = Date.now();
        const patch = {
          id: row.id, type: row.type, name: row.name, trailers_checked: now,
          extra: { ...(row.extra || {}), seasonLabels: n.seasonLabels || row.extra?.seasonLabels, fetchedAt: now },
        };
        if (n.trailers.length) patch.trailers = n.trailers;
        store.upsertTitle(patch);
      }
      return n.trailers;
    })().finally(() => inflight.delete(key)));
  }
  return inflight.get(key);
}

const MISSING_SEASON_TTL_MS = 15 * 60 * 1000;

/**
 * Une fiche liée à Netflix doit-elle relire sa page ?
 * - page jamais lue (ex. moissonnage JustWatch) : oui, immédiatement ;
 * - saison >= 2 demandée sans aucune vidéo de cette saison en base : nouvelle vérification au bout de 15 min ;
 * - dernière lecture plus vieille que `NETFLIX_REFRESH_HOURS` (défaut 4 h) : oui, pour capter un nouveau teaser/saison ;
 * - ancienne fiche sans horodatage : oui dès qu'un lien signé Netflix (`?e=…`) est expiré.
 */
function isNetflixStale(row, { season = null } = {}) {
  if (!row || !row.netflix_id) return false;
  const ttlMs = Math.max(1, Number(config.netflixRefreshHours) || 4) * 3600 * 1000;
  const now = Date.now();
  const list = Array.isArray(row.trailers) ? row.trailers.filter((t) => t && t.source !== 'upstream') : [];
  const checkedAt = Number(row.trailers_checked || row.extra?.fetchedAt || row.extra?.netflixLinkedAt || 0);
  if (!list.length) return !checkedAt || (now - checkedAt > ttlMs);
  const reqSeason = Number.isInteger(Number(season)) && Number(season) >= 2 ? Number(season) : null;
  if (reqSeason && !list.some((t) => detectSeason(t.title) === reqSeason)) {
    if (!checkedAt || now - checkedAt > Math.min(ttlMs, MISSING_SEASON_TTL_MS)) return true;
  }
  if (checkedAt && now - checkedAt > ttlMs) return true;
  return list.some((t) => t.expires && t.expires < now);
}

/** Relit la page Netflix d'une fiche si elle est périmée ou jamais lue, sans jamais bloquer au-delà de `timeoutMs`. */
async function ensureFreshTrailers(row, { timeoutMs = 4500, season = null } = {}) {
  if (!row || !row.netflix_id || !config.netflixRefreshEnabled || !isNetflixStale(row, { season })) return row;
  const job = refreshTrailers(row.netflix_id).catch((e) => {
    log.warn('netflix', `Rafraîchissement ${row.netflix_id} (${row.name}) : ${e.message}`);
    return null;
  });
  await Promise.race([job, new Promise((r) => setTimeout(r, timeoutMs))]);
  return store.getTitle(row.id) || row;
}

module.exports = { refreshTrailers, ensureFreshTrailers, isNetflixStale, ingestNetflix, enrichTitle, withReleased, mergeEpisodes };

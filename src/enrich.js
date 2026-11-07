const config = require('./config');
const store = require('./db');
const tmdb = require('./tmdb');
const youtube = require('./youtube');
const { parseNetflixId, fetchNetflixPage, parseNetflixHtml } = require('./netflix');

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
  const n = parseNetflixHtml(opts.html || (await fetchNetflixPage(nid)));
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
  const year = n.year || t?.year || null;
  const releaseDate = n.releaseDate || t?.release_date || null;

  let trailerYt = t?.trailer_yt || null;
  if (!trailerYt) trailerYt = await youtube.searchTrailer(`${n.name} bande-annonce Netflix France`);

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
    trailer_yt: trailerYt, trailers: n.trailers, runtime: t?.runtime,
    extra: {
      directors: n.directors, creators: n.creators, netflixGenres: n.netflixGenres, tags: n.tags,
      seasonLabels: n.seasonLabels, posterShape: hasTmdbPoster ? 'poster' : 'landscape', fetchedAt: Date.now(),
    },
    enriched: 1,
  });
  if (t) store.deleteDuplicates(t.tmdbType, t.tmdbId, id);

  if (type === 'series') {
    store.replaceEpisodes(id, withReleased(mergeEpisodes(n.episodes, t?.episodes || []), releaseDate || year));
  }
  return {
    id, name: n.name, type, year, genres: n.genres, episodes: store.getEpisodes(id).length,
    seasons: [...new Set(n.episodes.map((e) => e.season))].length, trailerYouTube: trailerYt, trailersNetflix: n.trailers.length,
    warnings: n.warnings,
  };
}

/** Complète une fiche issue du catalogue TMDB (épisodes, casting, trailer…) à la première ouverture. */
async function enrichTitle(id) {
  const row = store.getTitle(id);
  if (!row || row.enriched || !row.tmdb_id || !config.tmdbKey) return row;
  const t = await tmdb.fetchFull(row.tmdb_type, row.tmdb_id);
  const trailer = t.trailer_yt || (await youtube.searchTrailer(`${t.name} bande-annonce`));
  store.upsertTitle({
    id, type: row.type, name: row.name, imdb_id: t.imdb_id, year: t.year, release_date: t.release_date,
    certification: t.certification, genres: t.genres, synopsis: t.synopsis, cast: t.cast,
    poster: t.poster, background: t.background, logo: t.logo, trailer_yt: trailer, runtime: t.runtime, enriched: 1,
  });
  if (row.type === 'series') store.replaceEpisodes(id, withReleased(t.episodes, t.release_date || t.year));
  return store.getTitle(id);
}

// Re-télécharge la page pour obtenir des liens vidéo Netflix frais (les liens signés expirent en quelques heures).
const inflight = new Map();
function refreshTrailers(nid) {
  if (!inflight.has(nid)) {
    inflight.set(nid, (async () => {
      const n = parseNetflixHtml(await fetchNetflixPage(nid));
      const row = store.getTitle(`nflx:${nid}`);
      if (row && n.trailers.length) store.upsertTitle({ id: row.id, type: row.type, name: row.name, trailers: n.trailers });
      return n.trailers;
    })().finally(() => inflight.delete(nid)));
  }
  return inflight.get(nid);
}

module.exports = { refreshTrailers, ingestNetflix, enrichTitle, withReleased, mergeEpisodes };

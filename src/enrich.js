const config = require('./config');
const store = require('./db');
const tmdb = require('./tmdb');
const youtube = require('./youtube');
const { parseNetflixId, fetchNetflixPage, parseNetflixHtml } = require('./netflix');

// Stremio exige une date `released` par épisode : on retombe sur la date de sortie + n jours.
function withReleased(eps, year) {
  const base = Date.UTC(year || 2000, 0, 1);
  return eps.map((e) => ({
    ...e,
    released: e.released ? new Date(`${String(e.released).slice(0, 10)}T00:00:00Z`).toISOString()
      : new Date(base + ((e.season - 1) * 100 + (e.episode - 1)) * 86400000).toISOString(),
  }));
}

function mergeEpisodes(netflixEps, tmdbEps) {
  const map = new Map();
  for (const e of tmdbEps) map.set(`${e.season}:${e.episode}`, { ...e });
  for (const e of netflixEps) {
    const k = `${e.season}:${e.episode}`;
    const t = map.get(k) || {};
    map.set(k, {
      season: e.season, episode: e.episode,
      name: e.name || t.name || null,
      synopsis: e.synopsis || t.synopsis || null,   // la page Netflix est prioritaire
      image: e.image || t.image || null,
      runtime: e.runtime || t.runtime || null,
      released: t.released || null,
    });
  }
  return [...map.values()].sort((a, b) => a.season - b.season || a.episode - b.episode);
}

/** Ajoute / met à jour un titre depuis une URL ou un ID Netflix. */
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

  let trailer = t?.trailer_yt || null;
  if (!trailer) trailer = await youtube.searchTrailer(`${n.name} bande-annonce Netflix`);

  store.upsertTitle({
    id, netflix_id: nid, type, name: n.name,
    tmdb_id: t?.tmdbId, tmdb_type: t?.tmdbType, imdb_id: t?.imdb_id,
    year, release_date: t?.release_date,
    certification: n.certification || t?.certification,
    genres: n.genres.length ? n.genres : t?.genres,
    synopsis: n.synopsis || t?.synopsis,
    cast: n.cast.length ? n.cast : t?.cast,
    poster: t?.poster || n.image,            // TMDB = affiche verticale ; sinon visuel Netflix
    background: t?.background || n.image,
    logo: t?.logo, trailer_yt: trailer, runtime: t?.runtime,
    enriched: 1,
  });
  if (t) store.deleteDuplicates(t.tmdbType, t.tmdbId, id);

  if (type === 'series') {
    store.replaceEpisodes(id, withReleased(mergeEpisodes(n.episodes, t?.episodes || []), year));
  }
  return { id, name: n.name, type, year, episodes: store.getEpisodes(id).length, trailer };
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
  if (row.type === 'series') store.replaceEpisodes(id, withReleased(t.episodes, t.year));
  return store.getTitle(id);
}

module.exports = { ingestNetflix, enrichTitle, withReleased };

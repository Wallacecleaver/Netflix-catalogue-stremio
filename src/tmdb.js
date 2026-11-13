const config = require('./config');
const BASE = 'https://api.themoviedb.org/3';

async function call(path, params = {}) {
  if (!config.tmdbKey) throw new Error('TMDB_API_KEY manquant');
  const url = new URL(BASE + path);
  const headers = { accept: 'application/json' };
  if (config.tmdbKey.startsWith('eyJ')) headers.authorization = `Bearer ${config.tmdbKey}`;
  else url.searchParams.set('api_key', config.tmdbKey);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`TMDB ${res.status} ${path}`);
  return res.json();
}

const img = (p, size = 'w500') => (p ? `https://image.tmdb.org/t/p/${size}${p}` : null);
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');

async function searchMatch({ name, year, type }) {
  const order = type === 'movie' ? ['movie', 'tv'] : ['tv', 'movie'];
  for (const t of order) {
    const yearKey = t === 'tv' ? 'first_air_date_year' : 'year';
    let res = await call(`/search/${t}`, { query: name, language: config.lang, [yearKey]: year || null });
    if (!res.results.length && year) res = await call(`/search/${t}`, { query: name, language: config.lang });
    let best = null, bestScore = 0;
    for (const r of res.results.slice(0, 8)) {
      const d = (r.first_air_date || r.release_date || '').slice(0, 4);
      let score = 0;
      if ([r.name, r.title, r.original_name, r.original_title].some((n) => norm(n) === norm(name))) score += 2;
      if (year && d && Math.abs(+d - year) <= 1) score += 1;
      if (score > bestScore) { best = r; bestScore = score; }
    }
    if (best && bestScore >= 2) return { tmdbType: t, id: best.id };
  }
  return null;
}

function pickTrailer(videos) {
  const yt = (videos?.results || []).filter((v) => v.site === 'YouTube');
  const rank = (v) => (v.type === 'Trailer' ? 0 : v.type === 'Teaser' ? 10 : 99) + (v.iso_639_1 === 'fr' ? 0 : 3) + (v.official ? 0 : 1);
  const best = yt.sort((a, b) => rank(a) - rank(b))[0];
  return best && rank(best) < 99 ? best.key : null;
}

function certification(d, tmdbType) {
  if (tmdbType === 'tv') {
    const r = d.content_ratings?.results?.find((x) => x.iso_3166_1 === config.region)?.rating;
    return r ? (/^\d+$/.test(r) ? `${r}+` : r) : null;
  }
  const rel = d.release_dates?.results?.find((x) => x.iso_3166_1 === config.region);
  const c = rel?.release_dates?.map((x) => x.certification).find(Boolean);
  return c ? (/^\d+$/.test(c) ? `${c}+` : c) : null;
}

function episodeOf(e) {
  return { season: e.season_number, episode: e.episode_number, name: e.name || null, synopsis: e.overview || null,
    image: img(e.still_path, 'w780'), runtime: e.runtime || null, released: e.air_date || null };
}

async function fetchFull(tmdbType, id) {
  const d = await call(`/${tmdbType}/${id}`, {
    language: config.lang,
    append_to_response: tmdbType === 'tv' ? 'videos,credits,external_ids,content_ratings,images' : 'videos,credits,external_ids,release_dates,images',
    include_image_language: 'fr,en,null',
    include_video_language: 'fr,en,null',
  });
  const date = d.first_air_date || d.release_date || null;
  const logos = d.images?.logos || [];
  const logo = logos.find((l) => l.iso_639_1 === 'fr') || logos.find((l) => l.iso_639_1 === 'en') || logos[0];
  const out = {
    tmdbType, tmdbId: id,
    name: d.name || d.title, synopsis: d.overview || null,
    year: date ? +date.slice(0, 4) : null, release_date: date,
    genres: (d.genres || []).map((g) => g.name),
    cast: (d.credits?.cast || []).slice(0, 12).map((c) => c.name),
    poster: img(d.poster_path, 'w500'), background: img(d.backdrop_path, 'w1280'), logo: img(logo?.file_path, 'w500'),
    imdb_id: d.external_ids?.imdb_id || null,
    certification: certification(d, tmdbType),
    trailer_yt: pickTrailer(d.videos),
    runtime: d.runtime || d.episode_run_time?.[0] || null,
    episodes: [],
  };
  if (tmdbType === 'tv') {
    const seasons = (d.seasons || []).map((s) => s.season_number).filter((n) => n > 0);
    for (let i = 0; i < seasons.length; i += 5) {
      const chunk = await Promise.all(seasons.slice(i, i + 5).map((n) =>
        call(`/tv/${id}/season/${n}`, { language: config.lang }).catch(() => null)));
      for (const s of chunk) if (s) out.episodes.push(...(s.episodes || []).map(episodeOf));
    }
  }
  return out;
}

async function discover(tmdbType, page = 1) {
  return call(`/discover/${tmdbType}`, {
    language: config.lang, watch_region: config.region, with_watch_providers: 8,
    with_watch_monetization_types: 'flatrate', sort_by: 'popularity.desc', page,
  });
}

/** Sorties récentes sur Netflix (région config.region), de la plus récente à la plus ancienne. */
async function discoverRecent(tmdbType, { since, until, page = 1 } = {}) {
  const dateFilter = tmdbType === 'tv' ? 'first_air_date' : 'primary_release_date';
  return call(`/discover/${tmdbType}`, {
    language: config.lang, watch_region: config.region, with_watch_providers: 8,
    with_watch_monetization_types: 'flatrate',
    sort_by: `${dateFilter}.desc`,
    [`${dateFilter}.gte`]: since,
    [`${dateFilter}.lte`]: until,
    page,
  });
}

async function genreMap(tmdbType) {
  const res = await call(`/genre/${tmdbType}/list`, { language: config.lang });
  return new Map(res.genres.map((g) => [g.id, g.name]));
}

module.exports = { searchMatch, fetchFull, discover, discoverRecent, genreMap, img };

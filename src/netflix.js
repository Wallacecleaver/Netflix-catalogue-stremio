const cheerio = require('cheerio');
const config = require('./config');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function parseNetflixId(input) {
  const s = String(input || '').trim();
  const m = s.match(/title\/(\d+)/) || s.match(/^(\d{5,})$/);
  return m ? m[1] : null;
}

async function fetchNetflixPage(id, country = config.netflixCountry) {
  const url = `https://www.netflix.com/${country}/title/${id}`;
  const headers = {
    'user-agent': UA,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'fr-FR,fr;q=0.9,en;q=0.5',
    'upgrade-insecure-requests': '1',
    'sec-ch-ua': '"Chromium";v="130", "Not_A Brand";v="24", "Google Chrome";v="130"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
  };
  let status = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers, redirect: 'follow' });
    status = res.status;
    if (res.ok) return res.text();
    if (status < 500 && status !== 429) break;
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw new Error(`Netflix HTTP ${status} — requête probablement bloquée. Enregistre la page depuis ton navigateur et utilise --file (voir README).`);
}

// ---------- utilitaires ----------
const clean = (s) => (typeof s === 'string'
  ? s.replace(/[\u2066-\u2069\u200E\u200F]/g, '').replace(/[\u00A0\u202F]/g, ' ').trim() : s);
const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const edges = (c) => (c?.edges || []).map((e) => e.node).filter(Boolean);
const nameOf = (x) => (typeof x === 'string' ? x : x && x.name) || null;
const imgOf = (x) => (typeof x === 'string' ? x : x && (x.url || x.contentUrl)) || null;
const isoToMinutes = (d) => {
  const m = typeof d === 'string' && d.match(/^PT(?:(\d+)H)?(?:(\d+)M)?/);
  return m ? (+m[1] || 0) * 60 + (+m[2] || 0) || null : null;
};
function walk(node, fn, depth = 0, seen = new Set()) {
  if (!node || typeof node !== 'object' || depth > 60 || seen.has(node)) return;
  seen.add(node);
  fn(node);
  for (const v of Array.isArray(node) ? node : Object.values(node)) walk(v, fn, depth + 1, seen);
}
// Les URL vidéo Netflix sont signées (?e=<timestamp d'expiration en secondes>)
const expiryOf = (url) => { try { const e = new URL(url).searchParams.get('e'); return e ? Number(e) * 1000 : null; } catch { return null; } };

function seasonNumberOf(s, i) {
  const direct = Number(s.number ?? s.seasonNumber ?? s.seq);
  if (direct > 0) return direct;
  const m = String(s.title || '').match(/(\d+)/);   // "Partie 3", "Saison 2"
  return m ? +m[1] : i + 1;
}

// ---------- 1) Données GraphQL embarquées dans netflix.reactContext (source principale) ----------
function fromGraphql(ctx, out, nid) {
  let v = null;
  walk(ctx, (o) => {
    if (v || Array.isArray(o) || !Array.isArray(o.videos)) return;
    v = o.videos.find((x) => x && x.shortSynopsis !== undefined && (x.seasons || x.contentAdvisory || x.primaryGenres)
      && (!nid || String(x.videoId) === String(nid))) || null;
  });
  if (!v) return false;

  out.type = v.__typename === 'Show' ? 'series' : v.__typename === 'Movie' ? 'movie' : out.type;
  out.name = clean(v.title);
  out.synopsis = clean(v.shortSynopsis);
  out.year = v.latestYear || out.year;
  out.certification = v.contentAdvisory?.certificationValue || out.certification;
  out.genres = edges(v.primaryGenres).map((g) => clean(g.name)).filter(Boolean);   // genre affiché sur la page ("Drame")
  out.cast = edges(v.actors).map((p) => clean(p.name)).filter(Boolean);
  out.directors = edges(v.directors).map((p) => clean(p.name)).filter(Boolean);
  out.creators = edges(v.creators).map((p) => clean(p.name)).filter(Boolean);
  out.netflixGenres = edges(v.genres).map((g) => clean(g.title)).filter(Boolean);
  out.tags = (v.tags || []).filter((t) => t.isDisplayable !== false).map((t) => clean(t.displayName)).filter(Boolean);
  out.releaseDate = String(v.availabilityStartTime || '').slice(0, 10) || null;
  out.background = v.eclipseBillboardRedux1920?.url || v.billboardOrStoryArt1280?.url || null;
  out.logo = v.logoStackCropped350?.url || null;

  let trailers = edges(v.trailers);
  if (!trailers.length && v.promoVideo?.video?.playableVideo?.url) {
    trailers = [{ title: v.promoVideo.video.title, runtimeSec: v.promoVideo.video.displayRuntimeMs / 1000,
      playableVideo: v.promoVideo.video.playableVideo, artwork: null }];
  }
  out.trailers = trailers.map((t) => ({
    title: clean(t.title), runtime: t.runtimeSec || null, url: t.playableVideo?.url || null,
    thumb: t.artwork?.url || null, expires: expiryOf(t.playableVideo?.url),
  })).filter((t) => t.url);

  edges(v.seasons).forEach((s, i) => {
    const sn = seasonNumberOf(s, i);
    out.seasonLabels[sn] = clean(s.title) || null;
    for (const ep of edges(s.episodes)) {
      if (typeof ep.number !== 'number') continue;
      out.episodes.push({
        season: sn, episode: ep.number, name: clean(ep.title) || null, synopsis: clean(ep.shortSynopsis) || null,
        image: ep.merchStill300?.url || null, runtime: ep.runtimeSec ? Math.round(ep.runtimeSec / 60) : null,
      });
    }
  });
  return true;
}

function fromReactContext(html, out, nid) {
  const m = html.match(/netflix\.reactContext\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/);
  if (!m) { out.warnings.push('netflix.reactContext introuvable'); return; }
  let ctx;
  try { ctx = JSON.parse(m[1].replace(/\\x([0-9A-Fa-f]{2})/g, '\\u00$1')); }
  catch (e) { out.warnings.push(`JSON.parse(reactContext) a échoué : ${e.message}`); return; }
  if (!fromGraphql(ctx, out, nid)) out.warnings.push('données du titre introuvables dans reactContext');
}

// ---------- 2) JSON-LD (complément) ----------
function fromJsonLd($, out) {
  $('script[type="application/ld+json"]').each((_, el) => {
    let data;
    try { data = JSON.parse($(el).contents().text()); } catch { return; }
    walk(data, (it) => {
      if (Array.isArray(it) || !it['@type']) return;
      const types = asArray(it['@type']);
      if (types.includes('TVSeries') || types.includes('Movie')) {
        out.type = out.type || (types.includes('TVSeries') ? 'series' : 'movie');
        out.name = out.name || clean(it.name);
        out.synopsis = out.synopsis || clean(it.description);
        const y = String(it.datePublished || it.dateCreated || '').slice(0, 4);
        if (/^\d{4}$/.test(y)) out.year = out.year || +y;
        out.releaseDate = out.releaseDate || String(it.dateCreated || it.datePublished || '').slice(0, 10) || null;
        out.certification = out.certification || (typeof it.contentRating === 'string' ? it.contentRating : null);
        if (!out.genres.length && it.genre) out.genres = asArray(it.genre).map(nameOf).filter(Boolean);
        const actors = asArray(it.actor || it.actors).map(nameOf).filter(Boolean);
        if (!out.cast.length && actors.length) out.cast = actors;
        out.image = out.image || imgOf(it.image);
      }
    });
  });
}

// ---------- 3) DOM : cartes d'épisodes (secours si le GraphQL n'est pas lisible) ----------
function fromDom($, out) {
  $('li[data-uia="episode-card"]').each((i, el) => {
    const t = clean($(el).find('[data-uia="episode-title"]').first().text());
    const m = t.match(/^(\d+)\.\s*(.*)$/);
    const rt = $(el).find('span').filter((_, x) => /^\d+\s*(m|min)$/.test(clean($(x).text()))).first().text().match(/\d+/);
    out.episodes.push({
      season: 1, episode: m ? +m[1] : i + 1, name: (m ? m[2] : t) || null,
      synopsis: clean($(el).find('p').not('[data-uia]').first().text()) || null,
      image: $(el).find('img').first().attr('src') || null, runtime: rt ? +rt[0] : null,
    });
  });
}

function parseNetflixHtml(html) {
  const $ = cheerio.load(html);
  const og = (p) => $(`meta[property="${p}"]`).attr('content') || null;
  const nid = (og('og:url') || '').match(/title\/(\d+)/)?.[1] || null;
  const out = {
    netflixId: nid, name: null, synopsis: null, year: null, type: null, certification: null, releaseDate: null,
    genres: [], cast: [], directors: [], creators: [], netflixGenres: [], tags: [],
    image: og('og:image'), background: null, logo: null, trailers: [], seasonLabels: {}, episodes: [], warnings: [],
  };
  const ogType = og('og:type') || '';
  if (/tv_show|tv_episode/.test(ogType)) out.type = 'series';
  else if (/movie/.test(ogType)) out.type = 'movie';

  fromReactContext(html, out, nid);   // source principale
  fromJsonLd($, out);                 // complète ce qui manque
  if (!out.episodes.length) { fromDom($, out); if (out.episodes.length) out.warnings.push('épisodes lus depuis le HTML (secours)'); }

  out.name = out.name || clean((og('og:title') || $('title').text() || '').replace(/^Regarder\s+/i, '').split(' | ')[0]) || null;
  out.synopsis = out.synopsis || clean(og('og:description')) || null;

  // Dédoublonnage + tri des épisodes
  const seen = new Map();
  for (const e of out.episodes) { const k = `${e.season}:${e.episode}`; if (!seen.has(k)) seen.set(k, e); }
  out.episodes = [...seen.values()].sort((a, b) => a.season - b.season || a.episode - b.episode);
  if (!out.type) out.type = out.episodes.length ? 'series' : null;
  if (!out.episodes.length && out.type === 'series') out.warnings.push('aucun épisode trouvé dans la page');
  return out;
}

module.exports = { UA, parseNetflixId, fetchNetflixPage, parseNetflixHtml, expiryOf };

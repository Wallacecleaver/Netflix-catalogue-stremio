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
  throw new Error(`Netflix HTTP ${status} — la requête est probablement bloquée. Enregistre la page depuis ton navigateur et utilise --file (voir README).`);
}

// "PT1H2M" / "PT46M" -> minutes
function isoToMinutes(d) {
  const m = typeof d === 'string' && d.match(/^PT(?:(\d+)H)?(?:(\d+)M)?/);
  return m ? (+m[1] || 0) * 60 + (+m[2] || 0) || null : null;
}

function walk(node, fn, depth = 0, seen = new Set()) {
  if (!node || typeof node !== 'object' || depth > 40 || seen.has(node)) return;
  seen.add(node);
  fn(node);
  for (const v of Array.isArray(node) ? node : Object.values(node)) walk(v, fn, depth + 1, seen);
}

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const nameOf = (x) => (typeof x === 'string' ? x : x && x.name) || null;
const imgOf = (x) => (typeof x === 'string' ? x : x && (x.url || x.contentUrl)) || null;

// ---- 1) JSON-LD -----------------------------------------------------------
function fromJsonLd($, out) {
  $('script[type="application/ld+json"]').each((_, el) => {
    let data;
    try { data = JSON.parse($(el).contents().text()); } catch { return; }
    const items = [];
    walk(data, (o) => { if (!Array.isArray(o) && o['@type']) items.push(o); });
    for (const it of items) {
      const types = asArray(it['@type']);
      const isSeries = types.includes('TVSeries');
      const isMovie = types.includes('Movie');
      if (isSeries || isMovie) {
        out.type = out.type || (isSeries ? 'series' : 'movie');
        out.name = out.name || it.name;
        out.synopsis = out.synopsis || it.description;
        const y = String(it.datePublished || it.dateCreated || '').slice(0, 4);
        if (/^\d{4}$/.test(y)) out.year = out.year || +y;
        out.certification = out.certification || (typeof it.contentRating === 'string' ? it.contentRating : null);
        if (it.genre) out.genres = out.genres.length ? out.genres : asArray(it.genre).map(nameOf).filter(Boolean);
        const actors = asArray(it.actor || it.actors).map(nameOf).filter(Boolean);
        if (actors.length && !out.cast.length) out.cast = actors;
        out.image = out.image || imgOf(it.image);
      }
      if (types.includes('TVSeason')) {
        const sn = Number(it.seasonNumber) || 1;
        for (const ep of asArray(it.episode)) pushEpisode(out, sn, ep);
      }
      if (types.includes('TVEpisode')) {
        pushEpisode(out, Number(it.partOfSeason?.seasonNumber) || 1, it);
      }
    }
  });
}

function pushEpisode(out, season, ep) {
  const num = Number(ep.episodeNumber ?? ep.position);
  if (!num) return;
  out.episodes.push({
    season, episode: num, name: ep.name || null, synopsis: ep.description || null,
    image: imgOf(ep.image), runtime: isoToMinutes(ep.timeRequired || ep.duration),
  });
}

// ---- 2) netflix.reactContext (JS literal avec échappements \xNN) -----------
function fromReactContext(html, out) {
  const m = html.match(/netflix\.reactContext\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/);
  if (!m) return;
  let ctx;
  try { ctx = JSON.parse(m[1].replace(/\\x([0-9A-Fa-f]{2})/g, '\\u00$1')); } catch { return; }
  fromGraphql(ctx, out);
  walk(ctx, (o) => {
    if (Array.isArray(o)) return;
    const title = o.title || o.episodeTitle;
    const syn = o.synopsis || o.contextualSynopsis?.text || o.summary?.synopsis;
    const ep = o.episode ?? o.episodeNumber ?? o.seq;
    if (typeof title !== 'string' || typeof syn !== 'string' || typeof ep !== 'number') return;
    const season = typeof o.season === 'number' ? o.season : o.season?.seq ?? o.seasonNumber ?? 1;
    const rt = typeof o.runtime === 'number' ? (o.runtime > 300 ? Math.round(o.runtime / 60) : o.runtime) : null;
    out.episodes.push({
      season: Number(season) || 1, episode: ep, name: title, synopsis: syn,
      image: imgOf(o.stills?.[0]) || imgOf(o.thumbs?.[0]) || o.imgUrl || o.image || null, runtime: rt,
    });
  });
}

// ---- 2b) GraphQL embarqué (clcsHookV2 : Show -> seasons -> episodes) --------
function fromGraphql(ctx, out) {
  walk(ctx, (o) => {
    if (Array.isArray(o)) return;
    // Genres : coreGenres (ex. Thrillers, Drames) sinon primaryGenres
    if (o.__typename === 'Show' || o.__typename === 'Movie') {
      const g = (conn) => asArray(conn?.edges).map((e) => e?.node?.name).filter(Boolean);
      const genres = g(o.coreGenres).length ? g(o.coreGenres) : g(o.primaryGenres);
      if (genres.length) out.genres = genres;
      if (o.__typename === 'Show' && !out.type) out.type = 'series';
      if (o.__typename === 'Movie' && !out.type) out.type = 'movie';
    }
    // Saisons -> épisodes (ordre des saisons = numéro de saison)
    if (o.seasons && Array.isArray(o.seasons.edges)) {
      o.seasons.edges.forEach((se, i) => {
        const sn = Number(se?.node?.seasonNumber ?? se?.node?.number) || i + 1;
        for (const ee of asArray(se?.node?.episodes?.edges)) {
          const n = ee?.node;
          if (!n || typeof n.number !== 'number') continue;
          out.episodes.push({
            season: sn, episode: n.number,
            name: typeof n.title === 'string' ? n.title.replace(/\u00a0/g, ' ') : null,
            synopsis: n.shortSynopsis || n.contextualSynopsis?.text || null,
            image: imgOf(n.merchStill300) || imgOf(n.merchStill) || null,
            runtime: typeof n.runtimeSec === 'number' ? Math.round(n.runtimeSec / 60) : null,
          });
        }
      });
    }
  });
}

// ---- 3) DOM : cartes d'épisodes (secours) -----------------------------------
function fromDom($, out) {
  $('li[data-uia="episode-card"]').each((i, el) => {
    const t = $(el).find('[data-uia="episode-title"]').first().text().trim();
    const m = t.match(/^(\d+)\.\s*(.*)$/);
    const num = m ? +m[1] : i + 1;
    const rt = $(el).find('span').filter((_, s) => /^\d+\s*(m|min)$/.test($(s).text().trim())).first().text().match(/\d+/);
    out.episodes.push({
      season: 1, episode: num, name: (m ? m[2] : t).replace(/\u00a0/g, ' ') || null,
      synopsis: $(el).find('p').not('[data-uia]').first().text().trim() || null,
      image: $(el).find('img').first().attr('src') || null,
      runtime: rt ? +rt[0] : null,
    });
  });
}

function parseNetflixHtml(html) {
  const $ = cheerio.load(html);
  const og = (p) => $(`meta[property="${p}"]`).attr('content') || null;
  const out = { name: null, synopsis: null, year: null, type: null, certification: null,
    genres: [], cast: [], image: og('og:image'), episodes: [] };

  const ogType = og('og:type') || '';
  if (/tv_show|tv_episode/.test(ogType)) out.type = 'series';
  else if (/movie/.test(ogType)) out.type = 'movie';

  fromJsonLd($, out);
  fromReactContext(html, out);
  if (!out.episodes.length) fromDom($, out);

  out.name = out.name || (og('og:title') || $('title').text() || '').split(' | ')[0].trim() || null;
  out.synopsis = out.synopsis || og('og:description') || null;

  const bodyText = $('body').text().replace(/\s+/g, ' ');
  if (!out.certification) {
    const c = bodyText.match(/(?<![\w+])(TP|7\+|10\+|12\+|13\+|16\+|18\+)(?![\w+])/);
    if (c) out.certification = c[1];
  }
  // "Avec : A, B, C" (feuille la plus petite qui contient le motif)
  if (!out.cast.length) {
    const cands = $('p,div,span,li').filter((_, el) => /^\s*Avec\s*:/.test($(el).text()) && $(el).text().length < 400)
      .toArray().sort((a, b) => $(a).text().length - $(b).text().length);
    if (cands[0]) {
      out.cast = $(cands[0]).text().replace(/^\s*Avec\s*:\s*/, '').split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);
    }
  }
  if (!out.year) {
    const y = bodyText.match(/(?<!\d)(19|20)\d{2}(?!\d)/);
    if (y) out.year = +y[0];
  }

  // dédoublonnage des épisodes (priorité à la première source trouvée)
  const seen = new Map();
  for (const e of out.episodes) {
    const k = `${e.season}:${e.episode}`;
    if (!seen.has(k)) seen.set(k, e);
  }
  out.episodes = [...seen.values()].sort((a, b) => a.season - b.season || a.episode - b.episode);
  if (!out.type) out.type = out.episodes.length || /Épisodes|Saison/i.test(bodyText) ? 'series' : null;
  return out;
}

module.exports = { parseNetflixId, fetchNetflixPage, parseNetflixHtml };

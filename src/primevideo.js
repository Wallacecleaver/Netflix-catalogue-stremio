// Prime Video : lecture des pages titre https://www.primevideo.com/-/fr/detail/<id>
// Les données sont dans le JSON embarqué <script id="dv-web-page-hydration-data"> (même principe que netflix.reactContext).
// ⚠ La bande-annonce Prime est protégée (playbackEnvelope lié à la session + DRM) : on ne récupère PAS d'URL vidéo lisible,
//   seulement sa référence (extra.primeTrailer). Les métadonnées, elles, sont complètes (titre, synopsis, genres, casting, épisodes…).
const cheerio = require('cheerio');
const config = require('./config');
const store = require('./db');
const tmdb = require('./tmdb');
const { UA } = require('./netflix');

const BASE = 'https://www.primevideo.com';

/** Accepte une URL .../detail/<id> ou l'ID compact (ex. 0K94N2UBORZCLPIC46VTJQ093E). */
function parsePrimeId(input) {
  const s = String(input || '').trim();
  const m = s.match(/detail\/([0-9A-Z]{20,})/i) || s.match(/^([0-9A-Z]{20,})$/i);
  return m ? m[1].toUpperCase() : null;
}

async function fetchPrimePage(id, locale = config.primeLocale || 'fr') {
  const url = `${BASE}/-/${locale}/detail/${id}`;
  const headers = {
    'user-agent': UA,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'fr-FR,fr;q=0.9,en;q=0.5',
    'upgrade-insecure-requests': '1',
    'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', 'sec-fetch-user': '?1',
  };
  let status = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers, redirect: 'follow' });
    status = res.status;
    if (res.ok) return res.text();
    if (status < 500 && status !== 429) break;
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw new Error(`Prime Video HTTP ${status} — requête probablement bloquée. Enregistre la page depuis ton navigateur et utilise --file.`);
}

// ---------- utilitaires ----------
const clean = (s) => (typeof s === 'string' ? s.replace(/[\u2066-\u2069\u200E\u200F]/g, '').replace(/[\u00A0\u202F]/g, ' ').trim() : s);
const names = (arr) => (arr || []).map((x) => clean(typeof x === 'string' ? x : x && (x.name || x.text))).filter(Boolean);
const MONTHS = { janvier: 1, 'février': 2, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, 'août': 8, aout: 8,
  septembre: 9, octobre: 10, novembre: 11, 'décembre': 12, decembre: 12 };

/** "5 août 2026" → "2026-08-05" (null si illisible). */
function frDateToIso(s) {
  const m = String(s || '').toLowerCase().match(/(\d{1,2})(?:er)?\s+([a-zéûè]+)\s+(\d{4})/);
  if (!m || !MONTHS[m[2]]) return /^\d{4}-\d{2}-\d{2}/.test(String(s)) ? String(s).slice(0, 10) : null;
  return `${m[3]}-${String(MONTHS[m[2]]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
}

function readHydration($) {
  const raw = $('script#dv-web-page-hydration-data').first().contents().text();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

const stripNumber = (t) => clean(String(t || '').replace(/^\s*\d+\s*[.)]\s*/, ''));
const numberOf = (t) => { const m = String(t || '').match(/^\s*(\d+)\s*[.)]/); return m ? +m[1] : null; };

// ---------- 1) JSON embarqué (source principale) ----------
function fromHydration(h, out) {
  const body = h?.init?.preparations?.body;
  const atf = body?.atf?.state;
  const btf = body?.btf?.state;
  if (!atf) return false;
  const gti = atf.pageTitleId;
  const head = atf.detail?.headerDetail?.[gti] || btf?.detail?.btfMoreDetails?.[gti] || btf?.detail?.detail?.[gti];
  if (!head) return false;

  out.primeGti = gti;
  out.name = clean(head.parentTitle || String(head.title || '').replace(/\s+-\s+S\d+$/i, ''));
  out.seasonNumber = head.seasonNumber || null;
  out.type = head.titleType === 'movie' || head.entityType === 'Movie' ? 'movie' : 'series';
  out.synopsis = clean(head.synopsis) || null;
  out.year = head.releaseYear || null;
  out.releaseDate = frDateToIso(head.releaseDate);
  out.certification = head.ratingBadge?.displayText || null;
  out.genres = (head.genres || []).map((g) => clean(g.text)).filter(Boolean);
  out.cast = names(head.contributors?.cast);
  out.directors = names(head.contributors?.directors);
  out.producers = names(head.contributors?.producers);
  out.studios = names(head.studios);
  out.moods = atf.metadata?.[gti]?.moods || [];
  out.image = head.images?.packshot || null;
  out.background = head.images?.heroshot || null;
  out.logo = head.images?.titleLogo || null;
  out.flags = { hdr: !!head.isHdr, uhd: !!head.isUhd, dolby51: !!head.isDolby51, prime: !!head.isPrime };
  out.audio = head.audioTracks?.length ? head.audioTracks : (btf?.detail?.detail && Object.values(btf.detail.detail)[0]?.audioTracks) || [];
  out.subtitles = head.subtitles?.length ? head.subtitles : [];

  // Référence de bande-annonce (non lisible telle quelle : envelope lié à la session)
  const play = (atf.action?.atf?.[gti]?.secondaryActions || []).find((a) => a.payload?.playback?.isTrailer)?.payload?.playback;
  if (play) {
    out.primeTrailer = {
      playbackId: play.playbackID, playbackEnvelope: play.playbackEnvelope, expires: play.expiryTime || null,
      page: play.playbackURL ? new URL(play.playbackURL, BASE).href : null,
    };
  }
  if (!out.primeTrailer && atf.autoplayTrailerHero?.[gti]?.playbackId) {
    const t = atf.autoplayTrailerHero[gti];
    out.primeTrailer = { playbackId: t.playbackId, playbackEnvelope: t.playbackEnvelope, expires: null, page: null };
  }

  // Épisodes : btf.detail.detail contient une entrée par épisode, l'ordre vient de btf.self[*].sequenceNumber / episodeList
  const eps = btf?.detail?.detail || {};
  const order = btf?.episodeList?.cardTitleIds || Object.keys(eps);
  order.forEach((id, i) => {
    const e = eps[id];
    if (!e || e.titleType !== 'episode') return;
    const seq = e.episodeNumber || btf?.self?.[id]?.sequenceNumber || numberOf(e.title) || i + 1;
    out.episodes.push({
      season: out.seasonNumber || 1, episode: seq, name: stripNumber(e.title) || null, synopsis: clean(e.synopsis) || null,
      image: e.images?.covershot || null,
      runtime: e.duration ? Math.round(e.duration / 60) : (String(e.runtime || '').match(/\d+/) ? +String(e.runtime).match(/\d+/)[0] : null),
      released: frDateToIso(e.releaseDate), primeEpisodeId: btf?.self?.[id]?.compactGTI || null,
    });
  });
  return true;
}

// ---------- 2) DOM (secours) ----------
function fromDom($, out) {
  out.name = out.name || clean(($('title').text() || '').replace(/^Prime Video:\s*/i, '').replace(/\s+-\s+S\d+$/i, '')) || null;
  out.synopsis = out.synopsis || clean($('meta[name="description"]').attr('content')) || null;
  const t = $('title').text().match(/-\s+S(\d+)\s*$/i);
  if (t && !out.seasonNumber) out.seasonNumber = +t[1];
  if (!out.episodes.length) {
    $('li[data-testid="episode-list-item"]').each((i, el) => {
      const title = clean($(el).find('h3').first().text());
      const rt = clean($(el).find('[data-testid="episode-runtime"]').text()).match(/\d+/);
      out.episodes.push({
        season: out.seasonNumber || 1, episode: numberOf(title) || i + 1, name: stripNumber(title) || null,
        synopsis: clean($(el).find('[data-automation-id^="synopsis-"]').first().text()) || null,
        image: $(el).find('img').first().attr('src') || null, runtime: rt ? +rt[0] : null,
        released: frDateToIso($(el).find('[data-testid="episode-release-date"]').text()),
      });
    });
    if (out.episodes.length) out.warnings.push('épisodes lus depuis le HTML (secours)');
  }
}

function parsePrimeHtml(html) {
  const $ = cheerio.load(html);
  const canon = $('link[rel="canonical"]').attr('href') || '';
  const out = {
    primeId: parsePrimeId(canon), primeGti: null, name: null, seasonNumber: null, type: null, synopsis: null, year: null, releaseDate: null,
    certification: null, genres: [], cast: [], directors: [], producers: [], studios: [], moods: [], audio: [], subtitles: [],
    image: $('meta[property="og:image"]').attr('content') || null, background: null, logo: null, flags: {}, primeTrailer: null,
    episodes: [], warnings: [],
  };
  const h = readHydration($);
  if (!h || !fromHydration(h, out)) out.warnings.push('JSON embarqué (dv-web-page-hydration-data) introuvable ou changé : lecture HTML de secours');
  fromDom($, out);

  const seen = new Map();
  for (const e of out.episodes) { const k = `${e.season}:${e.episode}`; if (!seen.has(k)) seen.set(k, e); }
  out.episodes = [...seen.values()].sort((a, b) => a.season - b.season || a.episode - b.episode);
  if (!out.type) out.type = out.episodes.length ? 'series' : null;
  if (!out.primeTrailer) out.warnings.push('pas de référence de bande-annonce');
  return out;
}

/** Ajoute / met à jour un titre depuis une URL / ID Prime Video (ou du HTML déjà téléchargé). */
async function ingestPrime(input, opts = {}) {
  const pid = parsePrimeId(input);
  if (!pid && !opts.html) throw new Error('URL ou ID Prime Video invalide');
  const p = parsePrimeHtml(opts.html || (await fetchPrimePage(pid)));
  const id = `prime:${p.primeId || pid}`;
  if (!p.name) throw new Error('Titre illisible (page bloquée ou structure changée) — lance `npm run inspect-prime -- ' + pid + '`');

  let t = null;
  if (config.tmdbKey) {
    try {
      const m = await tmdb.searchMatch({ name: p.name, year: p.year, type: p.type });
      if (m) t = await tmdb.fetchFull(m.tmdbType, m.id);
    } catch (e) { console.warn('[tmdb]', e.message); }
  }
  const type = p.type || 'movie';
  store.upsertTitle({
    id, type, name: p.name, tmdb_id: t?.tmdbId, tmdb_type: t?.tmdbType, imdb_id: t?.imdb_id,
    year: p.year || t?.year, release_date: p.releaseDate || t?.release_date, certification: p.certification || t?.certification,
    genres: p.genres.length ? p.genres : t?.genres, synopsis: p.synopsis || t?.synopsis, cast: p.cast.length ? p.cast : t?.cast,
    poster: t?.poster || p.image, background: p.background || t?.background, logo: p.logo || t?.logo, runtime: t?.runtime,
    extra: { primeId: p.primeId || pid, primeTrailer: p.primeTrailer, directors: p.directors, producers: p.producers, studios: p.studios,
      moods: p.moods, posterShape: t?.poster ? 'poster' : 'landscape', fetchedAt: Date.now() },
    enriched: 1,
  });
  if (type === 'series' && p.episodes.length) {
    const { withReleased } = require('./enrich');
    store.replaceEpisodes(id, withReleased(p.episodes, p.releaseDate || p.year));
  }
  return { id, name: p.name, type, season: p.seasonNumber, episodes: p.episodes.length, genres: p.genres, warnings: p.warnings };
}

module.exports = { parsePrimeId, fetchPrimePage, parsePrimeHtml, ingestPrime, frDateToIso };

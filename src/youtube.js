const config = require('./config');
const log = require('./log');

// Dernier recours quand TMDB ne fournit aucune bande-annonce : recherche YouTube (sans clé API).
// La page de résultats expose `ytInitialData` (JSON) ; on en tire videoId + titre + chaîne, puis on
// filtre sévèrement — une recherche YouTube seule ramène beaucoup de bruit (réactions, extraits,
// autres films). Mieux vaut aucune bande-annonce qu'une mauvaise.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 20000;
const GAP_MS = 1200;              // une recherche à la fois, espacées : YouTube bloque vite
const NEGATIVE = /\b(reaction|réaction|critique|review|analyse|expliqu|extrait|clip|making[- ]?of|coulisses|bêtisier|bloopers|top|best of|compilation|fan ?made|parodie)\b/i;
const TRAILER = /\b(bande[- ]?annonce|trailer|teaser)\b/i;
const VF = /\b(vf|vostfr|français|francais|french)\b/i;
const OFFICIAL = /netflix|officiel|official|prime video|disney|canal\+|allociné/i;

const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const words = (s) => norm(s).replace(/[^a-z0-9]+/g, ' ').trim();

let queue = Promise.resolve();
let lastAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Extrait `ytInitialData` et retrouve la fin de l'objet par comptage d'accolades (plus fiable qu'une regex). */
function readInitialData(html) {
  const at = html.indexOf('ytInitialData');
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

async function searchVideos(query, { limit = 12 } = {}) {
  const job = queue.then(async () => {
    const wait = lastAt + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=fr&gl=FR`;
      const res = await fetch(url, {
        headers: {
          'user-agent': UA, 'accept-language': 'fr-FR,fr;q=0.9',
          // Évite la page de consentement dans l'UE
          cookie: 'CONSENT=YES+1; SOCS=CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5LjA3X3AxGgJlbiACGgYIgLC_pwY',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`YouTube HTTP ${res.status}`);
      const data = readInitialData(await res.text());
      if (!data) throw new Error('YouTube : page de résultats illisible (structure changée ou blocage)');
      const out = [];
      const walk = (node) => {
        if (!node || typeof node !== 'object' || out.length >= 40) return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        const v = node.videoRenderer;
        if (v && v.videoId) {
          out.push({
            id: v.videoId,
            title: (v.title?.runs || []).map((r) => r.text).join(''),
            channel: v.ownerText?.runs?.[0]?.text || '',
            length: v.lengthText?.simpleText || '',
          });
        }
        Object.values(node).forEach(walk);
      };
      walk(data);
      return out.slice(0, limit);
    } finally { lastAt = Date.now(); }
  });
  queue = job.catch(() => {});
  return job;
}

const secondsOf = (t) => {
  const m = /(\d+):(\d{2})(?::(\d{2}))?/.exec(String(t || ''));
  if (!m) return null;
  return m[3] ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
};

/** Note une vidéo pour un titre donné. 0 = à rejeter. */
function score(video, { name, year } = {}) {
  const want = words(name);
  const got = words(video.title);
  if (!want || !got.includes(want)) return 0;                       // le titre du film doit être dans celui de la vidéo
  if (!TRAILER.test(video.title)) return 0;                          // et ce doit être une bande-annonce
  if (NEGATIVE.test(video.title)) return 0;                          // réaction, extrait, critique…
  const secs = secondsOf(video.length);
  if (secs !== null && (secs < 40 || secs > 600)) return 0;          // trop court (spot) ou trop long (documentaire)
  let s = got.startsWith(want) ? 3 : 1;                              // commence par le titre : très bon signe
  if (VF.test(video.title)) s += 2;                                  // VF d'abord
  if (OFFICIAL.test(video.title) || OFFICIAL.test(video.channel)) s += 1;
  if (year && video.title.includes(String(year))) s += 1;
  return s;
}

/**
 * Cherche la bande-annonce YouTube d'un titre. → { id, title, channel } | null
 * `type` ('movie' | 'series') oriente la requête.
 */
async function findTrailer({ name, year, type } = {}) {
  if (config.youtubeSearchEnabled !== '1' || !name) return null;
  const kind = type === 'series' ? 'série' : 'film';
  const queries = [`${name} bande annonce VF`, `${name} ${year || ''} trailer ${kind}`.trim()];
  for (const q of queries) {
    let videos;
    try { videos = await searchVideos(q); }
    catch (e) { log.warn('youtube', `${name} : ${e.message}`); return null; }
    const scored = videos.map((v) => ({ ...v, score: score(v, { name, year }) })).filter((v) => v.score >= 3);
    if (!scored.length) continue;
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    log.info('youtube', `Bande-annonce YouTube trouvée : ${name}`, { videoId: best.id, score: best.score, via: q });
    return { id: best.id, title: best.title, channel: best.channel };
  }
  return null;
}

module.exports = { findTrailer, searchVideos, score, readInitialData, secondsOf };

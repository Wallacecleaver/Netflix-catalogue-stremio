const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('./config');
const log = require('./log');

// Les bandes-annonces Apple TV sont des flux HLS (.m3u8) : ni Stremio Web ni le navigateur ne les lisent
// nativement, et le lecteur intégré reste à 0:00 quand on lui donne une playlist à la place d'un MP4.
// Ce module télécharge les segments (ils ne sont pas chiffrés) et les recolle en un vrai MP4 fragmenté,
// mis en cache sur disque. Les requêtes suivantes sont servies avec Range, comme le relais Netflix.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HEADERS = {
  'user-agent': UA,
  accept: '*/*',
  'accept-language': 'fr-FR,fr;q=0.9,en;q=0.5',
  origin: 'https://tv.apple.com',
  referer: 'https://tv.apple.com/',
};
const SEGMENT_CONCURRENCY = 4;
const inflight = new Map();

const isHls = (url) => /\.m3u8(\?|#|$)/i.test(String(url || ''));
const hostOf = (u) => { try { return new URL(u).host; } catch { return '?'; } };

async function get(url, as = 'text') {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(config.hlsTimeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${hostOf(url)}`);
  return as === 'buffer' ? Buffer.from(await res.arrayBuffer()) : res.text();
}

function parseAttrs(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}

/** Variantes du flux maître, filtrées sur ce que les lecteurs savent lire (H.264 + audio muxé). */
function parseVariants(masterUrl, text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = parseAttrs(line.slice('#EXT-X-STREAM-INF:'.length));
    const uri = (lines[i + 1] || '').trim();
    if (!uri || uri.startsWith('#')) continue;
    const codecs = String(attrs.CODECS || '');
    const [, h] = String(attrs.RESOLUTION || '').split('x').map(Number);
    out.push({
      url: new URL(uri, masterUrl).href,
      bandwidth: Number(attrs.BANDWIDTH) || 0,
      height: h || 0,
      codecs,
      h264: /avc1/i.test(codecs),
      hevc: /(hvc1|hev1|dvh1|dolby)/i.test(codecs),
      audio: /mp4a/i.test(codecs) ? 2 : /(ac-3|ec-3|aac)/i.test(codecs) ? 1 : 0,
    });
  }
  return out;
}

const durationOf = (playlist) => playlist.split(/\r?\n/)
  .filter((l) => l.startsWith('#EXTINF:'))
  .reduce((sum, l) => sum + (parseFloat(l.slice(8)) || 0), 0);

/** Choisit la meilleure variante lisible sous les limites (hauteur, poids estimé). */
function pickVariant(variants, { maxHeight, maxMB, duration }) {
  const usable = variants.filter((v) => v.audio > 0 && !v.hevc && v.h264);
  const pool = usable.length ? usable : variants.filter((v) => v.audio > 0 && !v.hevc);
  if (!pool.length) throw new Error('aucune variante vidéo lisible dans le flux HLS');
  const fits = pool.filter((v) => v.height <= maxHeight);
  const sorted = (fits.length ? fits : pool).sort((a, b) => b.height - a.height || b.audio - a.audio || b.bandwidth - a.bandwidth);
  const maxBytes = maxMB * 1024 * 1024;
  const chosen = sorted.find((v) => (v.bandwidth / 8) * duration <= maxBytes) || sorted[sorted.length - 1];
  return chosen;
}

async function writeMedia(mediaUrl, file) {
  const text = await get(mediaUrl);
  if (/^#EXT-X-KEY:(?!METHOD=NONE)/im.test(text)) throw new Error('flux HLS chiffré (DRM) : non lisible hors application Apple');
  const base = mediaUrl;
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const init = (lines.find((l) => l.startsWith('#EXT-X-MAP:')) || '').match(/URI="([^"]+)"/)?.[1];
  const segments = lines.filter((l) => l && !l.startsWith('#'));
  if (!segments.length) throw new Error('playlist HLS vide');
  const tmp = `${file}.part`;
  const fh = await fsp.open(tmp, 'w');
  let bytes = 0;
  try {
    if (init) bytes += (await fh.write(await get(new URL(init, base).href, 'buffer'))).bytesWritten;
    for (let i = 0; i < segments.length; i += SEGMENT_CONCURRENCY) {
      const batch = segments.slice(i, i + SEGMENT_CONCURRENCY);
      const bufs = await Promise.all(batch.map((s) => get(new URL(s, base).href, 'buffer')));
      for (const buf of bufs) bytes += (await fh.write(buf)).bytesWritten;
    }
  } finally {
    await fh.close();
  }
  if (!bytes) throw new Error('aucun segment téléchargé');
  await fsp.rename(tmp, file);
  return { bytes, segments: segments.length, duration: durationOf(text) };
}

async function build(url, file, metaFile) {
  const master = await get(url);
  let mediaUrl = url;
  let chosen = null;
  if (master.includes('#EXT-X-STREAM-INF')) {
    const variants = parseVariants(url, master);
    if (!variants.length) throw new Error('flux HLS maître illisible');
    const first = variants.find((v) => v.audio > 0) || variants[0];
    const duration = durationOf(await get(first.url));
    chosen = pickVariant(variants, { maxHeight: config.hlsMaxHeight, maxMB: config.hlsMaxMB, duration });
    mediaUrl = chosen.url;
  }
  const res = await writeMedia(mediaUrl, file);
  const meta = {
    url, mediaUrl, builtAt: Date.now(), bytes: res.bytes, segments: res.segments,
    duration: res.duration || null, height: chosen?.height || null, codecs: chosen?.codecs || null,
  };
  await fsp.writeFile(metaFile, JSON.stringify(meta));
  log.info('hls', `Bande-annonce convertie en MP4 : ${Math.round(res.bytes / 1048576)} Mo, ${Math.round(res.duration || 0)} s`, { host: hostOf(url) });
  return meta;
}

/** Supprime les conversions trop anciennes (les URLs Apple changent au bout de quelques semaines). */
async function prune(dir) {
  const ttl = config.hlsCacheDays * 86400000;
  const now = Date.now();
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return; }
  await Promise.all(names.filter((n) => n.endsWith('.mp4')).map(async (n) => {
    const p = path.join(dir, n);
    try { const st = await fsp.stat(p); if (now - st.mtimeMs > ttl) await fsp.unlink(p); } catch { /* ignore */ }
  }));
}

function keyOf(url) {
  return crypto.createHash('sha1').update(`${url}|${config.hlsMaxHeight}|${config.hlsMaxMB}`).digest('hex').slice(0, 20);
}

/**
 * Chemin local du MP4 correspondant à une playlist HLS, en le construisant au besoin.
 * Les appels simultanés sur la même URL partagent le même téléchargement.
 */
async function ensure(url) {
  if (!isHls(url)) throw new Error('URL HLS attendue');
  const dir = path.resolve(config.hlsCacheDir);
  await fsp.mkdir(dir, { recursive: true });
  const key = keyOf(url);
  const file = path.join(dir, `${key}.mp4`);
  const metaFile = path.join(dir, `${key}.json`);
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    let meta = null;
    try { meta = JSON.parse(await fsp.readFile(metaFile, 'utf8')); } catch { /* pas encore converti */ }
    if (meta && fs.existsSync(file) && Date.now() - meta.builtAt < config.hlsCacheDays * 86400000) return { file, meta, cached: true };
    prune(dir).catch(() => {});
    return { file, meta: await build(url, file, metaFile), cached: false };
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/** Vrai MP4 déjà converti pour cette playlist HLS (null si pas encore). */
async function stat(url) {
  const key = keyOf(url);
  const dir = path.resolve(config.hlsCacheDir);
  const file = path.join(dir, `${key}.mp4`);
  try {
    const meta = JSON.parse(await fsp.readFile(path.join(dir, `${key}.json`), 'utf8'));
    if (fs.existsSync(file)) return { file, meta };
  } catch { /* pas encore converti */ }
  return null;
}

/** Lance la conversion en tâche de fond (sans bloquer la réponse de l'addon). */
function prefetch(url) {
  if (!isHls(url) || inflight.has(keyOf(url))) return;
  ensure(url).catch((e) => log.warn('hls', `conversion impossible : ${e.message}`));
}

module.exports = { isHls, ensure, stat, prefetch, parseVariants, pickVariant, durationOf, keyOf };

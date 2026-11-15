const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const config = require('./config');
const log = require('./log');

// Les bandes-annonces Apple TV sont des flux HLS (.m3u8) : ni Stremio Web ni le navigateur ne les lisent
// nativement, et le lecteur intégré reste à 0:00 quand on lui donne une playlist à la place d'un MP4.
// Ce module télécharge les segments (ils ne sont pas chiffrés) et les recolle en un vrai MP4 fragmenté,
// mis en cache sur disque. Les requêtes suivantes sont servies avec Range, comme le relais Netflix.
// La vidéo et l'audio sont deux flux séparés chez Apple : ffmpeg (s'il est installé) les remuxe en un seul MP4,
// sinon on ne garde que l'image (et on le dit dans le journal).

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

/** Variantes du flux maître : on ne garde que ce que les lecteurs savent lire (H.264, pas de HEVC/Dolby Vision). */
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
      group: attrs.AUDIO || null,          // groupe audio séparé (EXT-X-MEDIA) associé à cette variante
      h264: /avc1/i.test(codecs),
      hevc: /(hvc1|hev1|dvh1|dolby)/i.test(codecs),
    });
  }
  return out;
}

/** Pistes audio (EXT-X-MEDIA TYPE=AUDIO) du groupe de la variante, telles que déclarées par Apple. */
function audioTracks(masterUrl, text, group) {
  return text.split(/\r?\n/)
    .filter((l) => l.startsWith('#EXT-X-MEDIA:'))
    .map((l) => parseAttrs(l.slice('#EXT-X-MEDIA:'.length)))
    .filter((a) => a.TYPE === 'AUDIO' && a.URI && (!group || a['GROUP-ID'] === group))
    .map((a) => {
      const uri = a.URI;
      return {
        url: new URL(uri, masterUrl).href,
        name: a.NAME || null,
        language: a.LANGUAGE || null,
        default: a.DEFAULT === 'YES',
        description: /describes-video/i.test(a.CHARACTERISTICS || ''),   // piste qui raconte l'image
        aac: /mp4a-40/i.test(uri),                                        // AAC (mp4a-40-*) : lu partout
        stereo: String(a.CHANNELS || '2') === '2',
      };
    });
}

/**
 * Note une piste audio : langue demandée d'abord, puis pas d'audio-description, puis AAC stéréo.
 * Une piste d'une autre langue reste utilisable (bande-annonce uniquement en VO) mais passe en dernier.
 */
function audioScore(a, lang) {
  if (!a) return -1;
  const want = String(lang || '').toLowerCase();
  const base = want.slice(0, 2);
  const l = String(a.language || '').toLowerCase();
  let s = l === want ? 100 : base && l.startsWith(base) ? 60 : -100;
  if (a.description) s -= 60;
  if (a.aac && a.stereo) s += 25;
  else if (!a.aac) s -= 15;
  if (a.default) s += 5;
  return s;
}

/** Meilleure piste audio du groupe (celle qui obtient la meilleure note). */
function pickAudio(masterUrl, text, group, lang) {
  const tracks = audioTracks(masterUrl, text, group);
  if (!tracks.length) return null;
  return tracks.reduce((best, t) => (audioScore(t, lang) > audioScore(best, lang) ? t : best));
}

const durationOf = (playlist) => playlist.split(/\r?\n/)
  .filter((l) => l.startsWith('#EXTINF:'))
  .reduce((sum, l) => sum + (parseFloat(l.slice(8)) || 0), 0);

/**
 * Meilleur couple vidéo + audio sous les limites (hauteur, poids estimé) :
 * la langue exacte prime, puis l'absence d'audio-description, puis la définition.
 */
function pickPair(variants, masterUrl, master, { maxHeight, maxMB, duration, lang }) {
  const usable = variants.filter((v) => !v.hevc && v.h264);
  const pool = usable.length ? usable : variants.filter((v) => !v.hevc);
  if (!pool.length) throw new Error('aucune variante vidéo lisible dans le flux HLS');
  const fits = pool.filter((v) => v.height <= maxHeight);
  const sorted = (fits.length ? fits : pool).sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  const maxBytes = maxMB * 1024 * 1024;
  const within = sorted.filter((v) => (v.bandwidth / 8) * duration <= maxBytes);
  const list = within.length ? within : [sorted[sorted.length - 1]];
  const rank = ({ video, score }) => (score >= 100 ? 3 : score >= 60 ? 2 : 1) * 1e6 + video.height * 1000 + score;
  let best = null;
  for (const video of list) {
    const audio = video.group ? pickAudio(masterUrl, master, video.group, lang) : null;
    const cand = { video, audio, score: audioScore(audio, lang) };
    if (!best || rank(cand) > rank(best)) best = cand;
  }
  return best;
}

/** ffmpeg (facultatif) : recolle vidéo + piste audio Apple en un seul MP4. Sans lui, pas de son. */
let ffmpegBin;
function ffmpeg() {
  if (ffmpegBin !== undefined) return ffmpegBin;
  const bin = process.env.FFMPEG_PATH || 'ffmpeg';
  try {
    const probe = spawnSync(bin, ['-hide_banner', '-version'], { stdio: 'ignore', windowsHide: true });
    ffmpegBin = probe.status === 0 ? bin : null;
  } catch { ffmpegBin = null; }
  if (!ffmpegBin) log.warn('hls', 'ffmpeg introuvable : les bandes-annonces Apple seront muettes (installe ffmpeg — winget install Gyan.FFmpeg, apt install ffmpeg — ou renseigne FFMPEG_PATH dans .env)');
  return ffmpegBin;
}

const HEADER_BLOCK = 'Origin: https://tv.apple.com\r\nReferer: https://tv.apple.com/\r\n';

function remux(bin, videoUrl, audioUrl, out) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-y',
      '-user_agent', UA, '-headers', HEADER_BLOCK, '-i', videoUrl,
      '-user_agent', UA, '-headers', HEADER_BLOCK, '-i', audioUrl,
      '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', out];
    const p = spawn(bin, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg code ${code}${err ? ` : ${err.trim().split('\n').slice(-2).join(' | ')}` : ''}`))));
  });
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
  let audio = null;
  let duration = durationOf(master);
  if (master.includes('#EXT-X-STREAM-INF')) {
    const variants = parseVariants(url, master);
    if (!variants.length) throw new Error('flux HLS maître illisible');
    duration = durationOf(await get(variants[0].url));
    ({ video: chosen, audio } = pickPair(variants, url, master, {
      maxHeight: config.hlsMaxHeight, maxMB: config.hlsMaxMB, duration, lang: config.lang,
    }));
    mediaUrl = chosen.url;
  }
  const tmp = `${file}.part`;
  let tracks = 1;
  let res = null;
  const bin = ffmpeg();
  if (bin && audio) {
    try {
      await remux(bin, mediaUrl, audio.url, tmp);
      const size = (await fsp.stat(tmp)).size;
      if (!size) throw new Error('fichier vide');
      await fsp.rename(tmp, file);
      tracks = 2;
      res = { bytes: size, segments: null, duration };
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      log.warn('hls', `muxage audio impossible (${e.message}) : bande-annonce sans son`);
    }
  }
  if (!res) res = await writeMedia(mediaUrl, file);   // secours : image seule, sans ffmpeg
  const meta = {
    url, mediaUrl, audioUrl: audio?.url || null, audioName: audio?.name || null,
    builtAt: Date.now(), bytes: res.bytes, segments: res.segments,
    duration: res.duration || null, height: chosen?.height || null, codecs: chosen?.codecs || null, tracks,
  };
  await fsp.writeFile(metaFile, JSON.stringify(meta));
  const sound = tracks === 2 ? ` (avec son${audio?.name ? ` ${audio.name.trim()}` : ''})` : ' (sans son : ffmpeg absent)';
  log.info('hls', `Bande-annonce convertie en MP4${sound} : ${Math.round(res.bytes / 1048576)} Mo, ${Math.round(res.duration || 0)} s`, { host: hostOf(url) });
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
  return crypto.createHash('sha1').update(`${url}|${config.hlsMaxHeight}|${config.hlsMaxMB}|v3`).digest('hex').slice(0, 20);
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
    // Un fichier muet (converti avant l'installation de ffmpeg) est refait dès que ffmpeg est disponible.
    const silentOnly = meta && meta.tracks < 2 && !!ffmpeg();
    if (meta && fs.existsSync(file) && !silentOnly && Date.now() - meta.builtAt < config.hlsCacheDays * 86400000) return { file, meta, cached: true };
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

module.exports = { isHls, ensure, stat, prefetch, parseVariants, pickPair, pickAudio, audioScore, durationOf, keyOf };

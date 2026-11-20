const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const config = require('./config');
const store = require('./db');
const log = require('./log');
const hls = require('./hls');
const federation = require('./federation');

// Détection de qualité des bandes-annonces : résolution, codec, débit, piste audio.
// On passe TOUJOURS par le relais local (/trailer, /apple, /media) : il applique déjà la protection
// anti-SSRF, renouvelle les liens Netflix expirés et résout les liens Facebook. ffprobe ne lit donc
// que 127.0.0.1 (ou un MP4 déjà converti sur le disque), jamais une URL arbitraire.

// Secret propre au processus : permet aux sondes internes de ne pas consommer le quota public du relais.
const internalSecret = crypto.randomBytes(18).toString('hex');
const INTERNAL_HEADER = 'x-stockage-internal';

const TIERS = [
  { id: '4k', label: '4K', rank: 5, min: 3400 },
  { id: '1440p', label: '1440p', rank: 4, min: 2300 },
  { id: '1080p', label: 'Full HD', rank: 3, min: 1700 },
  { id: '720p', label: 'HD', rank: 2, min: 1180 },
  { id: 'sd', label: 'SD', rank: 1, min: 720 },
  { id: 'low', label: 'Basse', rank: 0, min: 0 },
];

/** Palier de qualité d'après le plus grand côté (couvre aussi les vidéos verticales et les formats cinéma). */
function tierOf(width, height) {
  const side = Math.max(Number(width) || 0, Number(height) || 0);
  return TIERS.find((t) => side >= t.min) || TIERS[TIERS.length - 1];
}

// ---- ffprobe ----
let probeBin;
let probeBinFor = null;
function ffprobeBin() {
  const ff = config.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
  const wanted = process.env.FFPROBE_PATH || ff;
  if (probeBin !== undefined && probeBinFor === wanted) return probeBin;
  probeBinFor = wanted;
  let bin = process.env.FFPROBE_PATH;
  if (!bin) {
    const base = path.basename(ff);
    bin = /^ffmpeg(\.exe)?$/i.test(base)
      ? (path.dirname(ff) === '.' && !/[\\/]/.test(ff) ? 'ffprobe' : path.join(path.dirname(ff), base.replace(/ffmpeg/i, 'ffprobe')))
      : 'ffprobe';
  }
  try {
    probeBin = spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 5000 }).status === 0 ? bin : null;
  } catch { probeBin = null; }
  if (!probeBin) log.warn('quality', 'ffprobe introuvable : la détection de qualité est désactivée (installe ffmpeg, qui l\'inclut, ou renseigne FFPROBE_PATH dans .env)');
  return probeBin;
}
const available = () => !!ffprobeBin();

function fraction(v) {
  const m = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(String(v || ''));
  if (!m || !Number(m[2])) return null;
  return Math.round((Number(m[1]) / Number(m[2])) * 100) / 100;
}

/** Transforme la sortie JSON de ffprobe en fiche de qualité (fonction pure, testée). */
function parseProbe(json) {
  const streams = Array.isArray(json && json.streams) ? json.streams : [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  if (!v) throw new Error('aucune piste vidéo dans ce flux');
  const a = streams.find((s) => s.codec_type === 'audio');
  const fmt = (json && json.format) || {};

  let width = Number(v.width) || 0;
  let height = Number(v.height) || 0;
  const rotation = Math.abs(Number(
    (Array.isArray(v.side_data_list) && v.side_data_list.map((d) => d.rotation).find((r) => r !== undefined)) ||
    (v.tags && v.tags.rotate) || 0,
  ));
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];
  if (!width || !height) throw new Error('résolution illisible');

  const tier = tierOf(width, height);
  const duration = Number(v.duration) || Number(fmt.duration) || null;
  const size = Number(fmt.size) || null;
  let bitrate = Number(v.bit_rate) || 0;
  if (!bitrate) {
    const total = Number(fmt.bit_rate) || (size && duration ? (size * 8) / duration : 0);
    bitrate = total ? Math.max(0, total - (Number(a && a.bit_rate) || 0)) : 0;
  }
  const transfer = String(v.color_transfer || '');
  return {
    width, height,
    tier: tier.id, rank: tier.rank,
    vcodec: v.codec_name || null,
    acodec: a ? (a.codec_name || null) : null,
    fps: fraction(v.avg_frame_rate) || fraction(v.r_frame_rate),
    bitrateKbps: bitrate ? Math.round(bitrate / 1000) : null,
    durationSec: duration ? Math.round(duration * 10) / 10 : null,
    sizeBytes: size,
    hasAudio: !!a,
    hdr: transfer === 'smpte2084' || transfer === 'arib-std-b67',
  };
}

/** Lance ffprobe sur une URL locale ou un fichier et renvoie la fiche de qualité. */
function runFfprobe(input, { timeoutMs = 25000, headers = null } = {}) {
  return new Promise((resolve, reject) => {
    const bin = ffprobeBin();
    if (!bin) return reject(new Error('ffprobe introuvable (installe ffmpeg ou renseigne FFPROBE_PATH)'));
    const isHttp = /^https?:\/\//i.test(input);
    const args = ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', '-analyzeduration', '4000000', '-probesize', '4000000'];
    if (isHttp) {
      args.push('-rw_timeout', String(Math.max(1, Math.floor(timeoutMs * 0.8)) * 1000));
      if (headers) args.push('-headers', Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join(''));
    }
    args.push(input);
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    const killer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* déjà terminé */ } }, timeoutMs);
    p.stdout.on('data', (d) => { if (out.length < 400000) out += d; });
    p.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    p.on('error', (e) => { clearTimeout(killer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(killer);
      if (code !== 0) {
        const why = err.trim().split('\n').pop() || `code ${code}`;
        return reject(new Error(/403|410/.test(why) ? 'flux expiré ou refusé (HTTP 403/410)' : /404/.test(why) ? 'flux introuvable (HTTP 404)' : `ffprobe : ${why.slice(0, 160)}`));
      }
      try { resolve(parseProbe(JSON.parse(out))); } catch (e) { reject(e); }
    });
  });
}

const localBase = () => `http://127.0.0.1:${config.port}`;

/** Liste les flux analysables d'une fiche (sans les liens venant d'une instance amont). */
function itemsOf(row) {
  const base = localBase();
  const items = federation.trailerUrls(row, { includeApple: true, includeManual: true, baseUrl: base })
    .filter((t) => t.source === 'netflix' || t.source === 'appletv' || t.source === 'manual');
  return items.map((t) => {
    const underlying = t.source === 'appletv'
      ? (row.appletv || [])[t.index]
      : t.source === 'manual'
        ? ((row.extra && row.extra.manualTrailers) || [])[t.index]
        : (row.trailers || [])[t.index];
    return {
      key: `${t.source}:${row.id}:${t.index}`,
      source: t.source, idx: t.index, label: t.title,
      relayPath: t.url.startsWith(base) ? t.url.slice(base.length) : null,
      sourceUrl: underlying && underlying.url ? String(underlying.url) : null,
    };
  });
}

/**
 * Analyse un flux et enregistre le résultat.
 * Un HLS (Apple TV, lien .m3u8) n'est lu que s'il est déjà converti en MP4 sur le disque, sauf `convertHls`
 * (la conversion télécharge la vidéo : on ne la déclenche pas pour tout le catalogue sans demande explicite).
 */
async function analyzeItem(row, item, { convertHls = false } = {}) {
  const base = {
    key: item.key, title_id: row.id, title_name: row.name, title_type: row.type,
    source: item.source, idx: item.idx, label: item.label,
  };
  const t0 = Date.now();
  try {
    if (!item.relayPath) throw new Error('relais local indisponible pour ce flux');
    let q;
    if (item.sourceUrl && hls.isHls(item.sourceUrl)) {
      const cached = await hls.stat(item.sourceUrl);
      if (cached) q = await runFfprobe(cached.file);
      else if (!convertHls) return { skipped: true, reason: 'HLS pas encore converti' };
    }
    if (!q) q = await runFfprobe(localBase() + item.relayPath, { headers: { [INTERNAL_HEADER]: internalSecret } });
    const rec = { ...base, ok: 1, error: null, probe_ms: Date.now() - t0, ...toRow(q) };
    store.upsertQuality(rec);
    return { ok: true, record: rec };
  } catch (e) {
    const rec = { ...base, ok: 0, error: String(e.message || e).slice(0, 240), probe_ms: Date.now() - t0, ...toRow(null) };
    store.upsertQuality(rec);
    return { ok: false, record: rec, error: rec.error };
  }
}

function toRow(q) {
  return {
    width: q ? q.width : null, height: q ? q.height : null,
    tier: q ? q.tier : null, rank: q ? q.rank : null,
    vcodec: q ? q.vcodec : null, acodec: q ? q.acodec : null, fps: q ? q.fps : null,
    bitrate_kbps: q ? q.bitrateKbps : null, duration_sec: q ? q.durationSec : null, size_bytes: q ? q.sizeBytes : null,
    has_audio: q ? (q.hasAudio ? 1 : 0) : null, hdr: q ? (q.hdr ? 1 : 0) : null,
  };
}

/** Analyse immédiate d'un flux précis (bouton « Analyser » du dashboard). */
async function analyzeKey(key) {
  const [source, ...rest] = String(key || '').split(':');
  const idx = Number(rest.pop());
  const titleId = rest.join(':');
  const row = store.getTitle(titleId);
  if (!row) throw new Error('fiche introuvable');
  const item = itemsOf(row).find((i) => i.source === source && i.idx === idx);
  if (!item) throw new Error('flux introuvable sur cette fiche');
  return analyzeItem(row, item, { convertHls: true });
}

// ---- Scan de fond ----
const state = {
  running: false, stopRequested: false,
  total: 0, done: 0, ok: 0, failed: 0, skipped: 0,
  current: null, startedAt: null, finishedAt: null, errors: [],
};

function status() {
  return {
    available: available(),
    running: state.running, total: state.total, done: state.done,
    ok: state.ok, failed: state.failed, skipped: state.skipped,
    percent: state.total ? Math.round((state.done / state.total) * 100) : 0,
    current: state.current, startedAt: state.startedAt, finishedAt: state.finishedAt,
    errors: state.errors.slice(-8),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Construit la file : tous les flux sans analyse récente (ou tous si `force`). */
function buildQueue({ force = false, staleDays = 14, limit = 0 } = {}) {
  const ids = store.db.prepare(`SELECT id FROM titles
    WHERE (trailers_json IS NOT NULL AND trailers_json != '[]')
       OR (appletv_json IS NOT NULL AND appletv_json != '[]')
       OR extra_json LIKE '%manualTrailers%'
    ORDER BY added_at DESC`).all();
  const fresh = Date.now() - staleDays * 86400000;
  const queue = [];
  for (const { id } of ids) {
    const row = store.getTitle(id);
    if (!row) continue;
    for (const item of itemsOf(row)) {
      const known = store.getQuality(item.key);
      if (!force && known && known.checked_at > fresh && (known.ok || Date.now() - known.checked_at < 6 * 3600000)) continue;
      queue.push({ row, item });
      if (limit && queue.length >= limit) return queue;
    }
  }
  return queue;
}

async function run({ force = false, limit = 0, convertHls = false, concurrency = 2, delayMs = 250 } = {}) {
  if (state.running) throw new Error('Analyse de qualité déjà en cours');
  if (!available()) throw new Error('ffprobe introuvable : installe ffmpeg (il inclut ffprobe) ou renseigne FFPROBE_PATH');
  const queue = buildQueue({ force, limit });
  Object.assign(state, {
    running: true, stopRequested: false, total: queue.length, done: 0, ok: 0, failed: 0, skipped: 0,
    current: null, startedAt: Date.now(), finishedAt: null, errors: [],
  });
  log.info('quality', `Analyse de qualité lancée : ${queue.length} flux`, { total: queue.length, force, convertHls });
  let cursor = 0;
  const worker = async () => {
    while (!state.stopRequested) {
      const job = queue[cursor++];
      if (!job) break;
      state.current = { id: job.row.id, name: job.row.name, source: job.item.source };
      const res = await analyzeItem(job.row, job.item, { convertHls });
      if (res.skipped) state.skipped++;
      else if (res.ok) state.ok++;
      else {
        state.failed++;
        state.errors.push(`${job.row.name} (${job.item.source}) : ${res.error}`);
        if (state.errors.length > 40) state.errors.shift();
      }
      state.done++;
      if (delayMs) await sleep(delayMs);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(4, concurrency)) }, worker));
  } finally {
    state.running = false;
    state.current = null;
    state.finishedAt = Date.now();
    log.info('quality', `Analyse de qualité terminée : ${state.ok} ok, ${state.failed} en erreur, ${state.skipped} ignorés`,
      { done: state.done, total: state.total });
  }
  return status();
}

function start(opts = {}) {
  if (state.running) return status();
  if (!available()) throw new Error('ffprobe introuvable : installe ffmpeg (il inclut ffprobe) ou renseigne FFPROBE_PATH');
  run(opts).catch((e) => {
    state.running = false;
    state.finishedAt = Date.now();
    state.errors.push(e.message);
    log.error('quality', e.message);
  });
  return status();
}

function stop() {
  state.stopRequested = true;
  return status();
}

/** Les requêtes internes (sondes) ne comptent pas dans le quota du relais public. */
function isInternalProbe(req) {
  const addr = String((req.socket && req.socket.remoteAddress) || '');
  if (!/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(addr)) return false;
  const given = String(req.headers[INTERNAL_HEADER] || '');
  const a = Buffer.from(given);
  const b = Buffer.from(internalSecret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { TIERS, tierOf, parseProbe, runFfprobe, itemsOf, analyzeItem, analyzeKey, buildQueue, start, stop, status, run, available, isInternalProbe };

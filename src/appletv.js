const config = require('./config');
const store = require('./db');
const log = require('./log');
const hls = require('./hls');

// Bandes-annonces Apple TV (tv.apple.com) via l'API web NON documentée (tv.apple.com/api/uts/v3).
// Apple peut changer les paramètres sans prévenir : `APPLETV_API_VERSION`, `APPLETV_UTSCF` et `APPLETV_UTSK` sont réglables dans .env.
// Les trailers sont des flux HLS (.m3u8) directs, stockés dans la colonne `appletv_json` (séparée de `trailers`,
// pour ne pas interférer avec le relais Netflix /trailer/<id>/<n>.mp4 qui indexe `trailers`).
// Ces flux sont servis en vrai MP4 par `src/hls.js` via /apple/<id>/<n>.mp4 : c'est ce que Stremio reçoit.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HIT_TTL = 30 * 24 * 3600 * 1000;   // trailer trouvé : revérifié au bout de 30 j
const MISS_TTL = 7 * 24 * 3600 * 1000;   // rien trouvé : nouvelle tentative au bout de 7 j
const VER = 2;                           // v2 : vraie bande-annonce (shelf « Bandes-annonces ») et plus seulement l'aperçu og:video
const inflight = new Map();

const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function http(url, accept) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept, 'accept-language': config.lang, origin: 'https://tv.apple.com', referer: 'https://tv.apple.com/' },
    signal: AbortSignal.timeout(config.appletvTimeoutMs),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`Apple TV HTTP ${res.status} sur ${new URL(url).pathname}${body ? ` — ${body}` : ''}`);
  }
  return res.text();
}

function walk(node, fn, ancestors = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40) return;
  if (Array.isArray(node)) {
    for (const v of node) walk(v, fn, ancestors, depth + 1);
    return;
  }
  fn(node, ancestors);
  const next = [...ancestors, node];
  for (const v of Object.values(node)) walk(v, fn, next, depth + 1);
}

function apiQuery(extra = {}) {
  return new URLSearchParams({
    caller: 'web', locale: config.appletvLocale, pfm: 'web', sf: String(config.appletvStorefront),
    utscf: config.appletvUtscf, utsk: config.appletvUtsk, v: String(config.appletvApiVersion), ...extra,
  }).toString();
}

/** Recherche dans le catalogue Apple TV → [{ id, title, type: 'movie'|'series', year }] */
async function search(term) {
  const json = JSON.parse(await http(`https://tv.apple.com/api/uts/v3/search?${apiQuery({ searchTerm: term })}`, 'application/json'));
  const seen = new Map();
  walk(json, (o) => {
    if (typeof o.id !== 'string' || !/^umc\.cmc\./.test(o.id) || seen.has(o.id)) return;
    const title = o.title || o.name;
    if (!title) return;
    const t = String(o.type || '').toLowerCase();
    const ts = Number(o.releaseDate);
    seen.set(o.id, {
      id: o.id, title,
      type: t.includes('show') || t.includes('series') ? 'series' : 'movie',
      year: Number.isFinite(ts) && ts > 0 ? new Date(ts).getUTCFullYear() : null,
    });
  });
  return [...seen.values()];
}

/** Choisit le résultat correspondant exactement au titre (et à l'année / au type si connus). Sinon null : mieux vaut pas de trailer qu'un mauvais. */
function pickMatch(items, row) {
  const want = norm(row.name);
  let c = items.filter((i) => norm(i.title) === want);
  if (row.type) { const same = c.filter((i) => i.type === row.type); if (same.length) c = same; }
  if (row.year) c = c.filter((i) => !i.year || Math.abs(i.year - Number(row.year)) <= 1);
  return c[0] || null;
}

const decode = (u) => u.replace(/&amp;/g, '&');
const mediaKey = (u) => { try { return new URL(u).searchParams.get('id') || u; } catch { return u; } };

/**
 * Extrait les flux .m3u8 marqués trailer/preview/bande-annonce d'un JSON (page ou API). Dédoublonne par id de média.
 * Les objets `playable.assets` portent aussi des clés FairPlay (`fpsKeyServerUrl`…) pour l'application Apple,
 * mais la playlist HLS elle-même n'est pas chiffrée : on ignore ces clés et on garde `hlsUrl`.
 */
function extractTrailers(json, debug = false) {
  const out = [];
  const isM3u8 = (v) => typeof v === 'string' && /^https?:\/\/\S+\.m3u8(\?\S*)?$/i.test(v);
  const label = (o) => [o.type, o.kind, o.contentType, o.assetType, o.title, o.name, o.id]
    .filter((x) => typeof x === 'string').join(' ');
  walk(json, (o, ancestors) => {
    const raw = Object.values(o).find(isM3u8);
    if (!raw) return;
    const url = decode(raw);
    if (out.some((t) => mediaKey(t.url) === mediaKey(url))) return;
    const ctx = [...ancestors, o].map(label).join(' ');
    if (!/trailer|preview|teaser|bande[- ]?annonce/i.test(ctx)) return;
    const title = [o.title, o.name, ...[...ancestors].reverse().map((a) => a.title || a.name)]
      .find((x) => typeof x === 'string' && x) || 'Bande-annonce';
    out.push({ title, url, ...(debug ? { ctx: ctx.slice(-300) } : {}) });
  });
  return out;
}

/**
 * Page tv.apple.com/<pays>/<movie|show>/<id>. On garde d'abord les flux de la page (shelf « Bandes-annonces » :
 * la vraie bande-annonce), puis la balise <meta property="og:video"> (aperçu court) comme secours.
 */
async function fetchTrailers(match, debug = false) {
  const kind = match.type === 'series' ? 'show' : 'movie';
  const html = await http(`https://tv.apple.com/${config.appletvCountry}/${kind}/${match.id}`, 'text/html');
  const out = [];
  const m = html.match(/<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/);
  if (m) { try { out.push(...extractTrailers(JSON.parse(m[1]), debug)); } catch { /* JSON illisible : on se rabat sur og:video */ } }
  const re = /<meta[^>]+property="og:video(?::url|:secure_url)?"[^>]+content="([^"]+\.m3u8[^"]*)"/gi;
  let r;
  while ((r = re.exec(html))) {
    const url = decode(r[1]);
    if (!out.some((t) => mediaKey(t.url) === mediaKey(url))) out.push({ title: 'Bande-annonce', url, ...(debug ? { ctx: 'og:video' } : {}) });
  }
  return out;
}

async function lookupTrailers(row) {
  const items = await search(row.name);
  const match = pickMatch(items, row);
  if (!match) return [];
  return (await fetchTrailers(match)).slice(0, config.appletvMaxTrailers).map((t) => ({ ...t, source: 'appletv', appleId: match.id, ver: VER }));
}

/** Rattache la bande-annonce d'un titre Apple TV choisi à la main : à la fiche du même nom si elle existe, sinon nouvelle fiche `apple:<id>`. */
async function attach({ appleId, type, name, year }) {
  if (!/^umc\.cmc\.[a-z0-9]+$/i.test(String(appleId || ''))) throw new Error('ID Apple TV invalide');
  const kind = type === 'series' ? 'series' : 'movie';
  const trailers = (await fetchTrailers({ id: appleId, type: kind })).slice(0, config.appletvMaxTrailers).map((t) => ({ ...t, source: 'appletv', appleId, ver: VER }));
  if (!trailers.length) throw new Error('Aucune bande-annonce lisible sur la page Apple TV de ce titre');
  const row = store.findByName(name, kind);
  const id = row ? row.id : `apple:${appleId}`;
  store.upsertTitle({ id, type: kind, name: row ? row.name : name, year: row?.year || year || null, appletv: trailers, appletv_checked: Date.now() });
  log.info('appletv', `Bande-annonce Apple TV ajoutée à la main : ${name}`, { id });
  return store.getTitle(id);
}

/** Si la fiche n'a pas encore été vérifiée (ou TTL dépassé), cherche les trailers Apple TV. Ne bloque jamais la fiche en cas d'erreur. */
async function ensure(row) {
  if (!row || !config.appletvEnabled || !row.name) return row;
  const stored = Array.isArray(row.appletv) && row.appletv.length > 0;
  const fresh = stored && row.appletv.every((t) => t && t.ver === VER);
  const age = Date.now() - (row.appletv_checked || 0);
  // Données d'une ancienne version (aperçu 29 s au lieu de la vraie bande-annonce) : on rafraîchit tout de suite.
  const ttl = fresh ? HIT_TTL : stored ? 0 : MISS_TTL;
  if (row.appletv_checked && age < ttl) return row;
  if (!inflight.has(row.id)) {
    inflight.set(row.id, (async () => {
      let trailers = [];
      try { trailers = await lookupTrailers(row); }
      catch (e) { log.warn('appletv', `${row.name} : ${e.message}`); return null; }   // erreur réseau : on retentera à la prochaine ouverture
      store.upsertTitle({ id: row.id, type: row.type, name: row.name, appletv: trailers, appletv_checked: Date.now() });
      if (trailers.length) log.info('appletv', `Bande-annonce Apple TV trouvée : ${row.name}`, { count: trailers.length });
      return store.getTitle(row.id);
    })().finally(() => inflight.delete(row.id)));
  }
  return (await inflight.get(row.id)) || row;
}

// ---- Job de fond (dashboard) : cherche les bandes-annonces Apple TV des titres jamais vérifiés ----
const job = { running: false, stopRequested: false, total: 0, done: 0, found: 0, failed: 0, current: null, startedAt: null, finishedAt: null, errors: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function status() {
  return { running: job.running, total: job.total, done: job.done, found: job.found, failed: job.failed,
    percent: job.total ? Math.round((job.done / job.total) * 100) : 0, current: job.current,
    startedAt: job.startedAt, finishedAt: job.finishedAt, errors: job.errors.slice(-8) };
}

async function runBatch({ limit = 0, delayMs = 700 } = {}) {
  if (job.running) throw new Error('Recherche Apple TV déjà en cours');
  const rows = store.listAppletvPending({ limit });
  Object.assign(job, { running: true, stopRequested: false, total: rows.length, done: 0, found: 0, failed: 0, current: null, startedAt: Date.now(), finishedAt: null, errors: [] });
  log.info('appletv', `Début de la recherche Apple TV : ${rows.length} titre(s)`);
  let streak = 0;
  try {
    for (const row of rows) {
      if (job.stopRequested) break;
      job.current = { id: row.id, name: row.name, type: row.type };
      const res = await ensure(row);
      if (!res || res.appletv_checked === row.appletv_checked) {          // erreur réseau / API : rien n'a été enregistré
        job.failed++; streak++;
        job.errors.push(`${row.name} : requête Apple TV échouée (voir le journal)`);
        if (streak >= 5) { log.error('appletv', 'Arrêt : 5 échecs consécutifs (Apple bloque ou ses paramètres ont changé, voir APPLETV_UTSK / APPLETV_API_VERSION)'); break; }
      } else { streak = 0; if (res.appletv && res.appletv.length) job.found++; }
      job.done++;
      await sleep(delayMs);
    }
  } finally {
    job.running = false; job.current = null; job.finishedAt = Date.now();
    log.info('appletv', `Recherche Apple TV terminée : ${job.found} bande(s)-annonce(s) trouvée(s), ${job.failed} erreur(s)`, { done: job.done, total: job.total });
  }
  return status();
}

function start(opts = {}) {
  if (job.running) return status();
  if (!config.appletvEnabled) throw new Error('Apple TV désactivé (APPLETV_ENABLED=0)');
  runBatch(opts).catch((e) => { job.errors.push(e.message); });
  return status();
}
const stop = () => { job.stopRequested = true; return status(); };

const urls = (row) => (Array.isArray(row?.appletv) ? row.appletv : [])
  .map((t, index) => ({ t, index }))
  .filter(({ t }) => t && t.url && hls.canServe(t.url))   // pas de HLS annoncé si ffmpeg est absent
  .map(({ t, index }) => ({ title: t.title ? `Apple TV — ${t.title}` : 'Bande-annonce Apple TV', url: t.url, index }));

module.exports = { ensure, attach, urls, start, stop, status, search, pickMatch, extractTrailers, fetchTrailers, lookupTrailers };

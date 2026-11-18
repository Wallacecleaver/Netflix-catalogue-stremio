const express = require('express');
const crypto = require('crypto');
const { Readable } = require('stream');
const { getRouter } = require('stremio-addon-sdk');
const config = require('./config');
const store = require('./db');
const { builder, manifest } = require('./addon');
const { HTML: ADMIN_HTML } = require('./admin');
const settings = require('./settings');
const log = require('./log');
const federation = require('./federation');
const { ingestNetflix, refreshTrailers, ensureFreshTrailers } = require('./enrich');
const { ingestPrime, parsePrimeId } = require('./primevideo');
const link = require('./link');
const harvest = require('./harvest');
const vf = require('./vf');
const search = require('./search');
const resolve = require('./resolve');
const appletv = require('./appletv');
const netflixTrailers = require('./netflix-trailers');
const hls = require('./hls');
const { syncCatalog, syncRecent } = require('./sync');
const { UA } = require('./netflix');
const { safeFetch, assertSafeUrlSync, securityHeaders, rateLimit } = require('./security');

const app = express();
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(express.json({ limit: '64kb' }));
// Derrière Caddy/Nginx : TRUST_PROXY_HOPS=1 donne req.ip = IP réelle du client.
// 'loopback' = comportement historique (l'en-tête n'est lu que si le pair est local).
app.set('trust proxy', config.trustProxy);

// Limiteurs dédiés : les routes publiques coûteuses (résolution, relais vidéo) sont bornées.
const apiLimiter = rateLimit({ windowMs: 60_000, max: 60, name: 'api' });
const mediaLimiter = rateLimit({ windowMs: 60_000, max: 120, name: 'media' });

// ---- Accès admin : mot de passe = ADMIN_TOKEN (.env) ----
const attempts = new Map();               // borne les essais : 10 échecs / minute / IP

const sha = (v) => crypto.createHash('sha256').update(String(v || '')).digest();
function tokenOk(given) {
  if (!config.adminToken) return false;
  return crypto.timingSafeEqual(sha(given), sha(config.adminToken));
}

// Les routes async d'Express 4 ne remontent pas leurs erreurs toutes seules : sans ça, la requête reste pendue.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// En-têtes de sécurité sur tout le dashboard (page + API).
app.use('/admin', (_req, res, next) => {
  res.set({ 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
  next();
});

function auth(req, res, next) {
  if (!config.adminToken) return res.status(503).json({ error: 'ADMIN_TOKEN non configuré dans le .env' });
  const key = req.ip || req.socket.remoteAddress || '?';
  const now = Date.now();
  const a = attempts.get(key);
  if (a && a.reset > now && a.n >= 10) return res.status(429).json({ error: 'Trop de tentatives, réessaie dans une minute' });
  if (!tokenOk(req.get('x-admin-token'))) {
    if (!a || a.reset <= now) attempts.set(key, { n: 1, reset: now + 60000 });
    else a.n++;
    while (attempts.size > 500) attempts.delete(attempts.keys().next().value);
    log.warn('auth', 'Tentative d\'accès refusée', { ip: key });
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }
  attempts.delete(key);
  next();
}

// ---- API de fédération & API publique v1 : clés API, scopes, quotas par clé et télémétrie ----
// Fermée par défaut : sans clé active (ni API_KEY historique), les appels sont refusés.
// ALLOW_OPEN_API=1 ouvre volontairement la lecture (déconseillé : expose le catalogue sans clé).
const MAX_API_KEYS = 5;
const VALID_SCOPES = new Set(['trailers:read', 'catalog:read', 'trailers:write']);
const keyHash = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');
const apiHasKey = () => !!config.apiKey || store.countActiveApiKeys() > 0;
const apiIsOpen = () => !!config.allowOpenApi;

function normalizeScopes(raw) {
  const list = Array.isArray(raw)
    ? raw
    : String(raw || 'trailers:read,catalog:read').split(/[\s,]+/);
  const clean = [...new Set(list.map((s) => String(s).trim()).filter((s) => VALID_SCOPES.has(s)))];
  return clean.length ? clean.join(',') : 'trailers:read,catalog:read';
}
const hasScope = (scopesStr, needed) => {
  if (!needed) return true;
  const set = new Set(String(scopesStr || '').split(/[\s,]+/).filter(Boolean));
  if (set.has('*') || set.has(needed)) return true;
  // Les clés créées en v2.7/v2.8 avaient uniquement 'trailers:read' : elles gardent la lecture catalogue par compatibilité
  if (needed === 'catalog:read' && set.has('trailers:read')) return true;
  return false;
};

function legacyKeyInfo() {
  if (!config.apiKey) return { active: false, source: null, hint: null };
  const overrides = store.allSettings();
  const fromDb = Object.prototype.hasOwnProperty.call(overrides, 'API_KEY') && !!overrides.API_KEY;
  const raw = String(config.apiKey);
  return {
    active: true,
    source: fromDb ? 'dashboard' : 'env',
    hint: raw.length >= 6 ? `••••${raw.slice(-4)}` : '••••',
  };
}

// Télémétrie temps réel de l'API (mémoire légère, zéro surcharge disque)
const API_RECENT_MAX = 80;
const LATENCY_WINDOW_MAX = 200;
const apiMetrics = {
  startedAt: Date.now(),
  totalCalls: 0,
  trailersCalls: 0,
  trailersHits: 0,
  batchCalls: 0,
  searchCalls: 0,
  titleCalls: 0,
  submitCalls: 0,
  authErrors: 0,
  rateLimited: 0,
  latencies: [],
  recentCalls: [],
};

function recordApiTelemetry(entry) {
  apiMetrics.totalCalls++;
  if (Number.isFinite(entry.ms)) {
    apiMetrics.latencies.push(entry.ms);
    if (apiMetrics.latencies.length > LATENCY_WINDOW_MAX) apiMetrics.latencies.shift();
  }
  apiMetrics.recentCalls.unshift(entry);
  if (apiMetrics.recentCalls.length > API_RECENT_MAX) apiMetrics.recentCalls.pop();
}

function getApiMetricsView() {
  const lats = apiMetrics.latencies;
  const avgLatencyMs = lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : 0;
  let p95LatencyMs = 0;
  if (lats.length) {
    const sorted = [...lats].sort((a, b) => a - b);
    p95LatencyMs = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  }
  const hitRate = apiMetrics.trailersCalls
    ? Math.round((apiMetrics.trailersHits / apiMetrics.trailersCalls) * 100)
    : null;
  return {
    startedAt: apiMetrics.startedAt,
    uptimeSec: Math.round((Date.now() - apiMetrics.startedAt) / 1000),
    totalCalls: apiMetrics.totalCalls,
    trailersCalls: apiMetrics.trailersCalls,
    trailersHits: apiMetrics.trailersHits,
    hitRate,
    batchCalls: apiMetrics.batchCalls,
    searchCalls: apiMetrics.searchCalls,
    titleCalls: apiMetrics.titleCalls,
    submitCalls: apiMetrics.submitCalls,
    authErrors: apiMetrics.authErrors,
    rateLimited: apiMetrics.rateLimited,
    avgLatencyMs,
    p95LatencyMs,
    recentCalls: apiMetrics.recentCalls.slice(0, 40),
  };
}

// Quotas de débit par clé API (fenêtre glissante d'une minute) : un serveur vf-trailer-wallace
// mutualisé derrière une seule IP dispose ainsi de son propre quota (300 req/min par défaut) sans être bloqué à 60.
const keyBuckets = new Map();
const keyBucketTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of keyBuckets) if (v.reset <= now) keyBuckets.delete(k);
}, 60_000);
if (keyBucketTimer.unref) keyBucketTimer.unref();

function checkBucket(bucketKey, limitPerMin, res) {
  res.setHeader('X-Stockage-Version', manifest.version);
  if (!limitPerMin || limitPerMin <= 0) {
    res.setHeader('X-RateLimit-Limit', 'unlimited');
    return true; // 0 = illimité pour cette clé
  }
  const now = Date.now();
  let b = keyBuckets.get(bucketKey);
  if (!b || b.reset <= now) {
    b = { n: 0, reset: now + 60_000 };
    keyBuckets.set(bucketKey, b);
    while (keyBuckets.size > 5000) keyBuckets.delete(keyBuckets.keys().next().value);
  }
  b.n++;
  const remaining = Math.max(0, limitPerMin - b.n);
  const resetSec = Math.max(1, Math.ceil((b.reset - now) / 1000));
  res.setHeader('X-RateLimit-Limit', String(limitPerMin));
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  res.setHeader('X-RateLimit-Reset', String(resetSec));
  if (b.n > limitPerMin) {
    apiMetrics.rateLimited++;
    res.setHeader('Retry-After', String(resetSec));
    res.status(429).json({ error: `Quota API dépassé (${limitPerMin}/min), réessaie dans ${resetSec}s` });
    return false;
  }
  return true;
}

// En-têtes CORS sur toute l'API publique (permet les outils web, Hoppscotch, addons externes)
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'X-Response-Time, X-Trailer-Count, X-Stockage-Version, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

function apiGuard(requiredScope = 'trailers:read') {
  return function apiAuthMiddleware(req, res, next) {
    req.apiStartMs = Date.now();
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const bearer = /^Bearer\s+(.+)$/i.exec(String(req.get('authorization') || ''));
    const given = req.get('x-api-key') || (bearer && bearer[1]) || req.query.key;

    if (given) {
      const hit = store.findApiKey(keyHash(given));
      if (hit) {
        if (!hit.enabled) {
          apiMetrics.authErrors++;
          return res.status(403).json({ error: 'Clé API temporairement désactivée (en pause)' });
        }
        if (hit.expires_at && hit.expires_at <= Date.now()) {
          apiMetrics.authErrors++;
          return res.status(401).json({ error: 'Clé API expirée' });
        }
        if (!hasScope(hit.scopes, requiredScope)) {
          apiMetrics.authErrors++;
          return res.status(403).json({ error: `Permission insuffisante : scope « ${requiredScope} » requis sur cette clé` });
        }
        const limit = hit.rate_limit != null ? Number(hit.rate_limit) : 300;
        if (!checkBucket(`key:${hit.id}`, limit, res)) return;
        req.apiClient = { type: 'key', id: hit.id, label: hit.label, ip: clientIp };
        // Enregistre immédiatement l'utilisation de base (les hits positifs /api/trailers sont incrémentés après exécution)
        store.recordApiKeyUse(hit.id, { hit: false, ip: clientIp });
        return next();
      }
      if (federation.keyOk(given)) {
        if (requiredScope === 'trailers:write') {
          apiMetrics.authErrors++;
          return res.status(403).json({ error: 'La clé héritée API_KEY est en lecture seule : crée une clé nommée avec le scope trailers:write' });
        }
        if (!checkBucket(`legacy:${clientIp}`, 300, res)) return;
        req.apiClient = { type: 'legacy', id: null, label: 'API_KEY (.env)', ip: clientIp };
        return next();
      }
      apiMetrics.authErrors++;
      return res.status(401).json({ error: 'Clé API invalide', hint: 'en-tête x-api-key, ou Authorization: Bearer <clé>' });
    }

    if (apiIsOpen() && requiredScope !== 'trailers:write') {
      if (!checkBucket(`open:${clientIp}`, 60, res)) return;
      req.apiClient = { type: 'open', id: null, label: 'Accès ouvert', ip: clientIp };
      return next();
    }

    if (!apiHasKey()) {
      apiMetrics.authErrors++;
      return res.status(403).json({
        error: "API de fédération désactivée : crée une clé dans l'onglet API (ou ALLOW_OPEN_API=1 pour l'ouvrir explicitement)",
      });
    }

    apiMetrics.authErrors++;
    return res.status(401).json({ error: 'Clé API invalide', hint: 'en-tête x-api-key, ou Authorization: Bearer <clé>' });
  };
}

// Génère une clé API héritée et l'enregistre (route historique conservée).
app.post('/admin/api-key', auth, (_req, res) => {
  const key = crypto.randomBytes(24).toString('hex');
  settings.save({ API_KEY: key });
  log.info('admin', 'Clé API de fédération régénérée');
  res.json({ ok: true, key });
});

// Gestion complète des clés API (onglet « API & Fédération ») : liste, création, édition/pause, rotation, révocation.
app.get('/admin/api/keys', auth, (_req, res) => {
  res.set('cache-control', 'no-store');
  const leg = legacyKeyInfo();
  res.json({
    keys: store.listApiKeys(),
    max: MAX_API_KEYS,
    legacy: leg.active,
    legacyInfo: leg,
    open: apiIsOpen(),
    baseUrl: config.publicUrl,
    metrics: getApiMetricsView(),
  });
});

app.post('/admin/api/keys', auth, (req, res) => {
  if (store.countApiKeys() >= MAX_API_KEYS) {
    return res.status(400).json({ error: `Limite de ${MAX_API_KEYS} clés atteinte : révoque ou régénère une clé existante` });
  }
  const b = req.body || {};
  const label = String(b.label || '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Sans nom';
  const scopes = normalizeScopes(b.scopes);
  const rateLimit = b.rateLimit !== undefined ? Math.max(0, Math.min(10000, Number(b.rateLimit) || 0)) : 300;
  const days = Number(b.expiresInDays) || 0;
  const expiresAt = days > 0 ? Date.now() + Math.min(days, 3650) * 86400000 : null;
  const key = `sdb_${crypto.randomBytes(24).toString('hex')}`;
  const id = store.createApiKey({
    label,
    hash: keyHash(key),
    prefix: key.slice(0, 8),
    last4: key.slice(-4),
    scopes,
    rateLimit,
    expiresAt,
  });
  log.info('admin', `Clé API créée : ${label}`, { id, scopes, rateLimit });
  res.json({ ok: true, id, label, key, scopes, rateLimit, expiresAt });
});

app.post('/admin/api/keys/update', auth, (req, res) => {
  const b = req.body || {};
  const id = Number(b.id);
  if (!id) return res.status(400).json({ error: 'Identifiant de clé manquant' });
  const patch = {};
  if (b.label !== undefined) patch.label = b.label;
  if (b.scopes !== undefined) patch.scopes = normalizeScopes(b.scopes);
  if (b.enabled !== undefined) patch.enabled = !!b.enabled;
  if (b.rateLimit !== undefined) patch.rateLimit = Math.max(0, Math.min(10000, Number(b.rateLimit) || 0));
  if (b.expiresInDays !== undefined) {
    const d = Number(b.expiresInDays);
    patch.expiresAt = d > 0 ? Date.now() + Math.min(d, 3650) * 86400000 : null;
  }
  const updated = store.updateApiKey(id, patch);
  if (!updated) return res.status(404).json({ error: 'Clé introuvable' });
  log.info('admin', `Clé API modifiée : ${updated.label}`, { id, enabled: !!updated.enabled, scopes: updated.scopes, rateLimit: updated.rate_limit });
  res.json({ ok: true, keyInfo: updated });
});

app.post('/admin/api/keys/rotate', auth, (req, res) => {
  const id = Number(req.body && req.body.id);
  const existing = id && store.getApiKeyById(id);
  if (!existing) return res.status(404).json({ error: 'Clé introuvable' });
  const newKey = `sdb_${crypto.randomBytes(24).toString('hex')}`;
  const updated = store.rotateApiKey(id, { hash: keyHash(newKey), prefix: newKey.slice(0, 8), last4: newKey.slice(-4) });
  keyBuckets.delete(`key:${id}`);
  log.warn('admin', `Clé API régénérée (rotation) : ${existing.label}`, { id });
  res.json({ ok: true, id, label: existing.label, key: newKey, keyInfo: updated });
});

app.post('/admin/api/keys/delete', auth, (req, res) => {
  const id = Number(req.body && req.body.id);
  const label = (store.listApiKeys().find((k) => k.id === id) || {}).label;
  if (!label || !store.deleteApiKey(id)) return res.status(404).json({ error: 'Clé introuvable' });
  keyBuckets.delete(`key:${id}`);
  log.warn('admin', `Clé API révoquée : ${label}`, { id });
  res.json({ ok: true, id });
});

app.post('/admin/api/keys/legacy/clear', auth, (_req, res) => {
  settings.save({ API_KEY: '' });
  log.warn('admin', 'Clé API héritée effacée des surcharges');
  const leg = legacyKeyInfo();
  res.json({ ok: true, legacy: leg.active, legacyInfo: leg });
});

app.get('/admin/api/metrics', auth, (_req, res) => {
  res.set('cache-control', 'no-store');
  res.json(getApiMetricsView());
});
app.post('/admin/api/metrics/reset', auth, (_req, res) => {
  Object.assign(apiMetrics, {
    startedAt: Date.now(), totalCalls: 0, trailersCalls: 0, trailersHits: 0,
    batchCalls: 0, searchCalls: 0, titleCalls: 0, submitCalls: 0,
    authErrors: 0, rateLimited: 0, latencies: [], recentCalls: [],
  });
  res.json({ ok: true, metrics: getApiMetricsView() });
});

app.post('/admin/api/hls/clear', auth, wrap(async (_req, res) => {
  const r = await hls.clearCache();
  log.info('admin', `Cache HLS purgé (${r.removed} fichier(s))`, r);
  res.json({ ok: true, ...r, hls: await hls.cacheStats() });
}));

app.get('/admin', (_req, res) => { res.set('cache-control', 'no-store'); res.type('html').send(ADMIN_HTML); });
app.get('/admin/api/summary', auth, wrap(async (_req, res) => {
  res.set('cache-control', 'no-store');
  const hlsStats = await hls.cacheStats();
  const leg = legacyKeyInfo();
  const activeKeys = store.countActiveApiKeys();
  const totalNamedKeys = store.countApiKeys();
  const effectiveKeyCount = activeKeys + (leg.active ? 1 : 0);
  const hasKey = effectiveKeyCount > 0;
  res.json({
    version: manifest.version, uptime: process.uptime(), node: process.version,
    stats: store.stats(), settings: settings.view(), hls: hlsStats,
    apiMetrics: getApiMetricsView(),
    addon: {
      resolve: !!(config.resolveEnabled && config.tmdbKey),
      publicUrl: config.publicUrl,
      appletv: !!config.appletvEnabled,
      upstream: !!config.upstreamUrl,
      apiOpen: apiIsOpen(),
      apiHasKey: hasKey,
      apiKeyCount: effectiveKeyCount,
      namedKeyCount: totalNamedKeys,
      activeNamedKeyCount: activeKeys,
      legacyKey: leg,
    },
    sources: {
      tmdb: !!config.tmdbKey,
      brave: !!config.braveApiKey,
      search: 'JustWatch',
      appletv: !!config.appletvEnabled,
      ffmpeg: hls.ffmpegAvailable(),
      resolve: !!(config.resolveEnabled && config.tmdbKey),
      upstream: config.upstreamUrl || '',
      apiOpen: apiIsOpen(),
      apiHasKey: hasKey,
      apiKeyCount: effectiveKeyCount,
      namedKeyCount: totalNamedKeys,
      activeNamedKeyCount: activeKeys,
      legacyKey: leg,
    },
  });
}));
app.post('/admin/api/settings', auth, (req, res) => {
  try {
    const result = settings.save(req.body && req.body.values ? req.body.values : {});
    log.info('admin', 'Paramètres mis à jour', { saved: result.saved, reset: result.reset, restart: result.restart });
    res.json({ ok: true, ...result });
  } catch (e) {
    log.warn('admin', `Réglage refusé : ${e.message}`);
    res.status(400).json({ error: e.message });
  }
});
app.post('/admin/add', auth, wrap(async (req, res) => {
  const input = String((req.body && (req.body.url || req.body.id)) || '').trim();
  try {
    const isPrime = /primevideo\.com|amazon\.[a-z.]+\/.*detail/i.test(input) || (!/^\d+$/.test(input) && !!parsePrimeId(input));
    const r = isPrime ? await ingestPrime(input) : await ingestNetflix(input);
    log.info('admin', `Titre ajouté : ${r.name}`, { id: r.id });
    res.json(r);
  } catch (e) {
    log.error('admin', `Ajout échoué (${input}) : ${e.message}`);
    res.status(400).json({ error: e.message });
  }
}));
app.post('/admin/sync', auth, async (_req, res) => {
  try {
    log.info('admin', 'Synchronisation manuelle lancée');
    const [added, recent] = await Promise.all([syncCatalog(), syncRecent()]);
    const linking = store.stats().unlinked > 0 ? link.start({}) : link.status();
    res.json({ added, recent, link: linking });
  } catch (e) {
    log.error('admin', `Synchronisation échouée : ${e.message}`);
    res.status(400).json({ error: e.message });
  }
});
app.get('/admin/api/netflix-ids', auth, (_req, res) => {
  res.set('cache-control', 'no-store');
  res.json(link.status());
});
app.post('/admin/netflix-ids', auth, (req, res) => {
  try {
    const limit = Number(req.body && req.body.limit) || 0;
    const st = link.start(limit ? { limit } : {});
    log.info('link', 'Liage lancé depuis le dashboard', { total: st.total, limit });
    res.json(st);
  } catch (e) {
    log.error('link', `Échec du lancement : ${e.message}`);
    res.status(400).json({ error: e.message });
  }
});
app.post('/admin/netflix-ids/stop', auth, (_req, res) => {
  const st = link.stop();
  log.warn('link', 'Arrêt demandé depuis le dashboard', { done: st.done, total: st.total });
  res.json(st);
});
// Moissonnage complet du catalogue Netflix (JustWatch) : statut, lancement (tout / dernières sorties), arrêt.
app.get('/admin/api/harvest', auth, (_req, res) => {
  res.set('cache-control', 'no-store');
  res.json(harvest.status());
});
app.post('/admin/harvest', auth, (req, res) => {
  try {
    const recent = !!(req.body && req.body.recent);
    const st = harvest.start({ recent });
    log.info('harvest', `Moissonnage lancé depuis le dashboard (${recent ? 'dernières sorties' : 'catalogue complet'})`);
    res.json(st);
  } catch (e) {
    log.error('harvest', `Échec du lancement : ${e.message}`);
    res.status(400).json({ error: e.message });
  }
});
app.post('/admin/harvest/stop', auth, (_req, res) => {
  const st = harvest.stop();
  log.warn('harvest', 'Arrêt demandé depuis le dashboard', { seen: st.seen });
  res.json(st);
});
// Bandes-annonces VF (TMDB) : statut, lancement, arrêt. Complète aussi affiches/synopsis des fiches moissonnées.
app.get('/admin/api/vf', auth, (_req, res) => {
  res.set('cache-control', 'no-store');
  res.json(vf.status());
});
app.post('/admin/vf', auth, (req, res) => {
  try {
    const limit = Number(req.body && req.body.limit) || 0;
    const st = vf.start(limit ? { limit } : {});
    log.info('vf', 'Recherche des bandes-annonces VF lancée depuis le dashboard', { total: st.total, limit });
    res.json(st);
  } catch (e) {
    log.error('vf', `Échec du lancement : ${e.message}`);
    res.status(400).json({ error: e.message });
  }
});
app.post('/admin/vf/stop', auth, (_req, res) => {
  const st = vf.stop();
  log.warn('vf', 'Arrêt demandé depuis le dashboard', { done: st.done, total: st.total });
  res.json(st);
});
// Bandes-annonces Apple TV : statut, lancement, arrêt.
app.get('/admin/api/appletv', auth, (_req, res) => { res.set('cache-control', 'no-store'); res.json(appletv.status()); });
app.post('/admin/appletv', auth, (req, res) => {
  try {
    const limit = Number(req.body && req.body.limit) || 0;
    const st = appletv.start(limit ? { limit } : {});
    log.info('appletv', 'Recherche Apple TV lancée depuis le dashboard', { total: st.total, limit });
    res.json(st);
  } catch (e) {
    log.error('appletv', `Échec du lancement : ${e.message}`);
    res.status(400).json({ error: e.message });
  }
});
app.post('/admin/appletv/stop', auth, (_req, res) => {
  const st = appletv.stop();
  log.warn('appletv', 'Arrêt demandé depuis le dashboard', { done: st.done, total: st.total });
  res.json(st);
});
// Bandes-annonces Netflix : lire la page des titres déjà liés à un ID mais sans bande-annonce.
app.get('/admin/api/netflix-trailers', auth, (_req, res) => { res.set('cache-control', 'no-store'); res.json(netflixTrailers.status()); });
app.post('/admin/netflix-trailers', auth, (req, res) => {
  try {
    const limit = Number(req.body && req.body.limit) || 0;
    const st = netflixTrailers.start(limit ? { limit } : {});
    log.info('netflix', `Lecture des pages Netflix lancée depuis le dashboard`, { total: st.total, limit });
    res.json(st);
  } catch (e) {
    log.error('netflix', `Échec du lancement : ${e.message}`);
    res.status(400).json({ error: e.message });
  }
});
app.post('/admin/netflix-trailers/stop', auth, (_req, res) => {
  const st = netflixTrailers.stop();
  log.warn('netflix', 'Arrêt demandé depuis le dashboard', { done: st.done, total: st.total });
  res.json(st);
});
// Recherche manuelle : liens Netflix (Brave Search) + titres Apple TV (API iTunes). Chaque source échoue indépendamment des autres.
const normName = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
app.get('/admin/api/search', auth, async (req, res) => {
  res.set('cache-control', 'no-store');
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.status(400).json({ error: 'Saisis au moins 2 caractères' });
  const [nf, ap] = await Promise.allSettled([
    search.netflix(q),
    // API tv.apple.com d'abord ; si elle échoue ou ne renvoie rien, secours via l'API iTunes Search
    appletv.search(q).then((r) => (r.length ? r : search.apple(q))).catch((e) => search.apple(q).catch(() => { throw e; })),
  ]);
  const want = normName(q);
  const apple = ap.status === 'fulfilled'
    ? ap.value.map((r) => ({ ...r, score: normName(r.title) === want ? 2 : normName(r.title).includes(want) ? 1 : 0 }))
        .sort((a, b) => b.score - a.score).slice(0, 6).map((r) => ({ ...r, stored: !!(store.findByName(r.title, r.type)?.appletv || []).length }))
    : [];
  if (nf.status === 'rejected') log.warn('search', `Netflix : ${nf.reason.message}`);
  if (ap.status === 'rejected') log.warn('search', `Apple TV : ${ap.reason.message}`);
  res.json({
    netflix: nf.status === 'fulfilled' ? nf.value.map((r) => ({ ...r, stored: !!store.findByNetflixId(r.id) })) : [],
    netflixError: nf.status === 'rejected' ? nf.reason.message : null,
    apple, appleError: ap.status === 'rejected' ? ap.reason.message : null,
  });
});
// Recherche Apple TV seule (onglet « Ajouter ») : API tv.apple.com, puis secours API iTunes.
app.get('/admin/api/appletv/search', auth, async (req, res) => {
  res.set('cache-control', 'no-store');
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.status(400).json({ error: 'Saisis au moins 2 caractères' });
  try {
    const found = await appletv.search(q).then((r) => (r.length ? r : search.apple(q))).catch((e) => search.apple(q).catch(() => { throw e; }));
    const want = normName(q);
    const results = found
      .map((r) => ({ ...r, score: normName(r.title) === want ? 2 : normName(r.title).includes(want) ? 1 : 0 }))
      .sort((a, b) => b.score - a.score).slice(0, 8)
      .map((r) => ({ ...r, stored: !!(store.findByName(r.title, r.type)?.appletv || []).length }));
    res.json({ results });
  } catch (e) {
    log.warn('search', `Apple TV : ${e.message}`);
    res.status(502).json({ error: e.message });
  }
});
app.post('/admin/api/search/apple', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const row = await appletv.attach({ appleId: b.id, type: b.type, name: String(b.title || '').slice(0, 200), year: Number(b.year) || null });
    if (!row.imdb_id && config.tmdbKey) { try { await vf.checkOne(row); } catch (e) { log.warn('search', `TMDB : ${e.message}`); } }   // IMDb + VF pour qu'il apparaisse sur les fiches Stremio
    res.json({ id: row.id, name: row.name, trailers: row.appletv.length });
  } catch (e) {
    log.error('appletv', `Ajout manuel échoué : ${e.message}`);
    res.status(400).json({ error: e.message });
  }
});
// Titres stockés + bandes-annonces disponibles par source (onglet « Titres »).
app.get('/admin/api/titles', auth, (req, res) => {
  res.set('cache-control', 'no-store');
  const { total, rows } = store.listTitles({
    search: String(req.query.search || '').trim(),
    filter: String(req.query.filter || ''),
    type: String(req.query.type || ''),
    sort: String(req.query.sort || 'added'),
    limit: Math.min(Number(req.query.limit) || 50, 200),
    offset: Number(req.query.offset) || 0,
  });
  res.json({
    total,
    rows: rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      year: r.year,
      releaseDate: r.release_date || null,
      imdb: r.imdb_id || null,
      netflixId: r.netflix_id || null,
      tmdbId: r.tmdb_id || null,
      poster: r.poster || null,
      added: r.added_at || null,
      netflix: r.trailers.filter((t) => t && t.source !== 'upstream').length,
      upstream: r.trailers.filter((t) => t && t.source === 'upstream').length,
      apple: r.appletv.length,
      manual: ((r.extra && r.extra.manualTrailers) || []).map((m) => ({ title: String(m.title || '').slice(0, 80), url: String(m.url || '').slice(0, 300) })),
      youtube: !!(r.vf_trailer || r.trailer_yt),
    })),
  });
});

// Détail complet d'une fiche + liste ordonnée des bandes-annonces relayées (saison détectée, nature, URL de lecture).
app.get('/admin/api/titles/:id', auth, (req, res) => {
  res.set('cache-control', 'no-store');
  const id = String(req.params.id || '').trim();
  const row = id && store.getTitle(id);
  if (!row) return res.status(404).json({ error: 'Titre introuvable' });
  const trailers = federation.trailerUrls(row, { includeApple: true, includeManual: true });
  const unservableApple = (Array.isArray(row.appletv) ? row.appletv : [])
    .filter((t) => t && t.url && !hls.canServe(t.url))
    .map((t) => ({ title: t.title || 'Bande-annonce Apple TV', source: 'appletv', reason: 'ffmpeg requis pour convertir le flux HLS' }));
  res.json({
    id: row.id,
    name: row.name,
    type: row.type,
    year: row.year || null,
    releaseDate: row.release_date || null,
    imdb: row.imdb_id || null,
    tmdbId: row.tmdb_id || null,
    tmdbType: row.tmdb_type || null,
    netflixId: row.netflix_id || null,
    poster: row.poster || null,
    synopsis: row.synopsis || null,
    genres: row.genres || [],
    youtubeKey: row.vf_trailer || row.trailer_yt || null,
    youtubeVf: !!row.vf_trailer,
    episodesCount: row.type === 'series' ? store.getEpisodes(row.id).length : 0,
    addedAt: row.added_at || null,
    updatedAt: row.updated_at || null,
    trailersCheckedAt: row.trailers_checked || null,
    appletvCheckedAt: row.appletv_checked || null,
    trailers,
    unservableApple,
    manual: ((row.extra && rManual(row)) || []),
  });
});
const rManual = (row) => (Array.isArray(row?.extra?.manualTrailers) ? row.extra.manualTrailers : []).map((m, index) => ({
  index,
  title: String(m?.title || 'Bande-annonce').slice(0, 120),
  url: String(m?.url || '').slice(0, 300),
  relayUrl: `${config.publicUrl}/media/${encodeURIComponent(row.id)}/${index}.mp4`,
  servable: !!(m?.url && hls.canServe(m.url)),
}));

// Gestion d'un titre : supprimer, forcer une nouvelle recherche, retirer un lien manuel.
app.post('/admin/titles/delete', auth, (req, res) => {
  const id = String((req.body && req.body.id) || '').trim();
  const row = id && store.getTitle(id);
  if (!row) return res.status(404).json({ error: 'Titre introuvable' });
  store.deleteTitle(id);
  log.warn('admin', `Titre supprimé : ${row.name}`, { id });
  res.json({ ok: true, id, name: row.name });
});
app.post('/admin/titles/recheck', auth, wrap(async (req, res) => {
  const id = String((req.body && req.body.id) || '').trim();
  if (!id || !store.getTitle(id)) return res.status(404).json({ error: 'Titre introuvable' });
  store.resetChecks(id);
  const errors = [];
  let row = store.getTitle(id);
  if (row.netflix_id) {
    try { await refreshTrailers(row.netflix_id); } catch (e) { errors.push(`Netflix : ${e.message}`); }
    row = store.getTitle(id) || row;
  }
  if (/^tt\d+$/.test(row.imdb_id || '')) {
    try { row = (await resolve.ensure(row.imdb_id, row.type, row, { timeoutMs: 12000 })) || row; } catch (e) { errors.push(`Recherche : ${e.message}`); }
  }
  try { row = await appletv.ensure(row); } catch (e) { errors.push(`Apple TV : ${e.message}`); }
  log.info('admin', `Nouvelle recherche : ${row.name}`, { id, errors: errors.length });
  res.json({ ok: true, id, name: row.name, netflix: (row.trailers || []).length, apple: (row.appletv || []).length,
    youtube: !!(row.vf_trailer || row.trailer_yt), errors });
}));
app.post('/admin/trailer/remove', auth, (req, res) => {
  const id = String((req.body && req.body.id) || '').trim();
  const index = Number(req.body && req.body.index);
  const row = id && store.getTitle(id);
  const list = row && row.extra && Array.isArray(row.extra.manualTrailers) ? [...row.extra.manualTrailers] : [];
  if (!row || !Number.isInteger(index) || index < 0 || index >= list.length) return res.status(404).json({ error: 'Lien introuvable' });
  const [gone] = list.splice(index, 1);
  store.upsertTitle({ id: row.id, type: row.type, name: row.name, extra: { ...row.extra, manualTrailers: list } });
  log.info('admin', `Lien manuel retiré : ${row.name}`, { url: String(gone.url || '').slice(0, 90) });
  res.json({ ok: true, id: row.id, count: list.length });
});
app.get('/admin/api/netflix-ids/export', auth, (_req, res) => {
  res.set('content-disposition', 'attachment; filename="netflix-ids.json"');
  res.json(store.listLinked());
});
app.get('/admin/api/logs', auth, (req, res) => {
  res.set('cache-control', 'no-store');
  res.json(log.list({
    level: String(req.query.level || ''),
    source: String(req.query.source || ''),
    search: String(req.query.search || ''),
    limit: Number(req.query.limit) || 200,
    offset: Number(req.query.offset) || 0,
  }));
});
app.post('/admin/api/logs/clear', auth, (_req, res) => {
  const removed = log.clear();
  log.info('admin', 'Journal effacé', { removed });
  res.json({ ok: true, removed });
});
// Sonde de santé : volontairement minimale (pas d'inventaire des sources ni des erreurs).
app.get('/health', (_req, res) => {
  res.json({ ok: true, version: manifest.version, uptime: Math.round(process.uptime()), titles: store.stats().total });
});

// ---- Logique partagée de l'API de fédération (/api/trailers + batch + console interactive du dashboard) ----
const youtubeInfoOf = (row) => {
  const key = row && (row.vf_trailer || row.trailer_yt);
  return key ? { key, url: `https://www.youtube.com/watch?v=${key}`, vf: !!row.vf_trailer } : null;
};

const seasonsAvailableOf = (trailers) => [...new Set((trailers || []).map((t) => t.season).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);

async function executeTrailersQuery(q, { logFederation = true, forceDebug = false, forceFast = false } = {}) {
  const t0 = Date.now();
  const imdb = String(q.imdb || '').trim();
  const tmdb = String(q.tmdb || '').trim();
  const netflix = String(q.netflix || '').trim();
  const type = String(q.type || '').trim();
  const season = Number(q.season) || null;
  const strictSeason = String(q.strict_season || '') === '1' || q.strict_season === true;
  const includeExtras = String(q.include_extras || '') === '1' || q.include_extras === true;
  const includeYoutube = String(q.include_youtube || '') === '1' || q.include_youtube === true;
  const fastOnly = forceFast || String(q.fast || '') === '1' || q.fast === true;
  const sourceFilter = String(q.source || '').trim()
    ? new Set(String(q.source).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
    : null;
  const kindFilter = String(q.kind || '').trim()
    ? new Set(String(q.kind).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
    : null;

  if (!imdb && !tmdb && !netflix) {
    return { status: 400, body: { error: 'paramètre imdb, tmdb ou netflix requis' }, tookMs: Date.now() - t0 };
  }

  let row = federation.lookup({ imdb, tmdb, type, netflix });

  // Mode normal (fast=0) : rafraîchissement Netflix + résolution à la demande + amont + Apple TV+
  if (!fastOnly) {
    if (row && row.netflix_id) row = await ensureFreshTrailers(row, { timeoutMs: 4500, season });
    if (imdb) row = (await resolve.ensure(imdb, type, row, { timeoutMs: 4500 })) || row;
    if (row) {
      row = await federation.ensureUpstreamTrailers(row);
      row = await appletv.ensure(row, { timeoutMs: 4000 });
    }
  }

  const pending = !!imdb && resolve.isPending(imdb);
  const tookMs = Date.now() - t0;
  if (!row) {
    return { status: 200, tookMs, body: { found: false, pending, tookMs, trailers: [] } };
  }

  // On expose toutes les sources relayables (Netflix, amont, Apple TV, liens manuels), triées pour la saison demandée.
  const allTrailers = federation.trailerUrls(row, { includeApple: true, includeManual: true, season });
  const seasonsAvailable = seasonsAvailableOf(allTrailers);
  let trailers = allTrailers;
  if (strictSeason && season > 0) {
    trailers = trailers.filter((t) => t.season === season && (includeExtras || t.kind !== 'extra'));
  }
  if (sourceFilter && sourceFilter.size) {
    trailers = trailers.filter((t) => sourceFilter.has(String(t.source || '').toLowerCase()));
  }
  if (kindFilter && kindFilter.size) {
    trailers = trailers.filter((t) => kindFilter.has(String(t.kind || '').toLowerCase()));
  }

  if (logFederation) {
    const asked = imdb || (tmdb ? `tmdb:${tmdb}` : `netflix:${netflix}`);
    if (trailers.length) log.info('federation', `${asked} → ${trailers.length} flux MP4`, { sources: [...new Set(trailers.map((t) => t.source))].join(','), ms: tookMs, ...(season ? { season } : {}) });
    else log.warn('federation', `${asked} → aucun flux MP4`, { fiche: row ? row.id : 'introuvable', pending, ms: tookMs, ...(season ? { season } : {}) });
  }

  const yt = youtubeInfoOf(row);
  const debug = (forceDebug || String(q.debug || '') === '1') ? {
    query: { imdb, tmdb, netflix, type, season, strictSeason, includeExtras, fastOnly, source: sourceFilter ? [...sourceFilter] : null, kind: kindFilter ? [...kindFilter] : null },
    fiche: {
      id: row.id, name: row.name, imdb_id: row.imdb_id, tmdb_id: row.tmdb_id,
      netflix_id: row.netflix_id, trailers_checked: row.trailers_checked || null, appletv_checked: row.appletv_checked || null,
    },
    counts: {
      netflix: (row.trailers || []).filter((t) => t && t.source !== 'upstream').length,
      upstream: (row.trailers || []).filter((t) => t && t.source === 'upstream').length,
      appletv: (row.appletv || []).length,
      manual: (row.extra && Array.isArray(row.extra.manualTrailers)) ? row.extra.manualTrailers.length : 0,
      beforeStrictFilter: allTrailers.length,
    },
    seasonsAvailable,
    youtube: yt,
    resolveActive: !!(config.resolveEnabled && config.tmdbKey),
    ffmpegAvailable: hls.ffmpegAvailable(),
    apiOpen: apiIsOpen(),
    apiHasKey: apiHasKey(),
    tookMs,
  } : undefined;

  return {
    status: 200,
    tookMs,
    body: {
      found: trailers.length > 0,
      pending: pending && !trailers.length,
      tookMs,
      seasonsAvailable,
      title: {
        id: row.id, name: row.name, type: row.type, year: row.year,
        netflix_id: row.netflix_id, tmdb_id: row.tmdb_id, tmdb_type: row.tmdb_type, imdb_id: row.imdb_id,
      },
      trailers,
      ...(includeYoutube || yt ? { youtube: yt } : {}),
      ...(debug ? { debug } : {}),
    },
  };
}

function executeCatalogSearch(q = {}) {
  const query = String(q.q || q.search || '').trim();
  const filter = String(q.filter || q.source || '').trim();
  const type = String(q.type || '').trim();
  const sort = String(q.sort || 'added').trim();
  const limit = Math.min(Math.max(1, Number(q.limit) || 20), 100);
  const offset = Math.max(0, Number(q.offset) || 0);
  const { total, rows } = store.listTitles({ search: query, filter, type, sort, limit, offset });
  return {
    ok: true,
    total,
    limit,
    offset,
    results: rows.map((r) => {
      const trailers = federation.trailerUrls(r, { includeApple: true, includeManual: true });
      return {
        id: r.id,
        name: r.name,
        type: r.type,
        year: r.year || null,
        release_date: r.release_date || null,
        imdb_id: r.imdb_id || null,
        tmdb_id: r.tmdb_id || null,
        tmdb_type: r.tmdb_type || null,
        netflix_id: r.netflix_id || null,
        poster: r.poster || null,
        seasonsAvailable: seasonsAvailableOf(trailers),
        youtube: youtubeInfoOf(r),
        trailersCount: trailers.length,
        trailers,
      };
    }),
  };
}

function resolveAnyTitleId(rawId) {
  const key = String(rawId || '').trim();
  if (!key) return null;
  return store.getTitle(key)
    || (/^tt\d+$/i.test(key) ? store.findByImdbId(key) : null)
    || (/^\d+$/.test(key) ? store.findByNetflixId(key) : null);
}

// ---- Console interactive du dashboard (onglet « API & Fédération », sans consommer de clé externe) ----
app.get('/admin/api/test-federation', auth, wrap(async (req, res) => {
  res.set('cache-control', 'no-store');
  const out = await executeTrailersQuery(req.query, { logFederation: false, forceDebug: true });
  res.setHeader('X-Response-Time', `${out.tookMs}ms`);
  res.status(out.status).json(out.body);
}));

app.get('/admin/api/test-search', auth, (req, res) => {
  res.set('cache-control', 'no-store');
  const t0 = Date.now();
  const body = executeCatalogSearch(req.query);
  const tookMs = Date.now() - t0;
  res.setHeader('X-Response-Time', `${tookMs}ms`);
  res.json({ ...body, tookMs });
});

app.post('/admin/api/test-batch', auth, wrap(async (req, res) => {
  res.set('cache-control', 'no-store');
  const items = Array.isArray(req.body && req.body.items) ? req.body.items.slice(0, 25) : [];
  if (!items.length) return res.status(400).json({ error: 'Tableau items requis (1 à 25 entrées)' });
  const t0 = Date.now();
  const results = [];
  for (const it of items) {
    const out = await executeTrailersQuery(it || {}, { logFederation: false, forceFast: true });
    results.push({ query: it, ...(out.body || {}) });
  }
  const tookMs = Date.now() - t0;
  res.json({ ok: true, count: results.length, foundCount: results.filter((r) => r.found).length, tookMs, results });
}));

// ---- Spécification OpenAPI 3.0.3 (importable dans Bruno, Postman, Hoppscotch, Swagger) ----
function buildOpenApiSpec() {
  const base = String(config.publicUrl || 'http://localhost:7000').replace(/\/+$/, '');
  return {
    openapi: '3.0.3',
    info: {
      title: 'Stockage DB — API de Fédération & Catalogue',
      version: manifest.version,
      description: 'API REST de Stockage DB : bandes-annonces MP4/HLS multi-sources (Netflix, Apple TV+, liens directs, instance amont) triées par saison pour vf-trailer-wallace et clients externes.',
    },
    servers: [{ url: base }],
    components: {
      securitySchemes: {
        ApiKeyHeader: { type: 'apiKey', in: 'header', name: 'x-api-key' },
        BearerAuth: { type: 'http', scheme: 'bearer' },
      },
    },
    security: [{ ApiKeyHeader: [] }, { BearerAuth: [] }],
    paths: {
      '/api/status': {
        get: { summary: "État de l'instance, capacités et compteurs du catalogue", responses: { 200: { description: 'Statut JSON' } } },
      },
      '/api/trailers': {
        get: {
          summary: 'Bandes-annonces MP4 relayées pour un film ou une série (triées par saison)',
          parameters: [
            { name: 'imdb', in: 'query', schema: { type: 'string', example: 'tt13016388' } },
            { name: 'tmdb', in: 'query', schema: { type: 'string', example: '108545' } },
            { name: 'netflix', in: 'query', schema: { type: 'string', example: '81024821' } },
            { name: 'type', in: 'query', schema: { type: 'string', enum: ['movie', 'series'] } },
            { name: 'season', in: 'query', schema: { type: 'integer', example: 2 } },
            { name: 'strict_season', in: 'query', schema: { type: 'string', enum: ['0', '1'] } },
            { name: 'include_extras', in: 'query', schema: { type: 'string', enum: ['0', '1'] } },
            { name: 'fast', in: 'query', description: 'Cache SQLite uniquement (0 appel réseau externe)', schema: { type: 'string', enum: ['0', '1'] } },
            { name: 'source', in: 'query', description: 'Filtrer par source (netflix,appletv,manual,upstream)', schema: { type: 'string' } },
            { name: 'kind', in: 'query', description: 'Filtrer par nature (trailer,teaser,extra)', schema: { type: 'string' } },
            { name: 'debug', in: 'query', schema: { type: 'string', enum: ['0', '1'] } },
          ],
          responses: { 200: { description: 'Liste ordonnée de flux MP4 prêts à lire' } },
        },
      },
      '/api/trailers/batch': {
        post: { summary: 'Requête groupée (jusqu’à 25 titres en 1 appel rapide)', responses: { 200: { description: 'Résultats groupés' } } },
      },
      '/api/search': {
        get: {
          summary: 'Recherche dans le catalogue local avec compteurs et flux MP4',
          parameters: [
            { name: 'q', in: 'query', schema: { type: 'string' } },
            { name: 'type', in: 'query', schema: { type: 'string', enum: ['movie', 'series'] } },
            { name: 'filter', in: 'query', schema: { type: 'string', enum: ['any', 'netflix', 'apple', 'manual', 'upstream', 'youtube', 'none'] } },
            { name: 'sort', in: 'query', schema: { type: 'string', enum: ['added', 'release', 'year', 'name'] } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
          ],
          responses: { 200: { description: 'Résultats paginés' } },
        },
      },
      '/api/title/{id}': {
        get: {
          summary: 'Fiche détaillée par ID interne, ID IMDb (tt…) ou ID Netflix',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Métadonnées et bandes-annonces' }, 404: { description: 'Introuvable' } },
        },
      },
      '/api/trailers/submit': {
        post: { summary: 'Attacher un flux MP4/HLS ou ingérer une URL Netflix/Prime (scope trailers:write requis)', responses: { 200: { description: 'Flux enregistré' } } },
      },
    },
  };
}

app.get(['/api/openapi.json', '/api/v1/openapi.json'], (_req, res) => {
  res.set('cache-control', 'public, max-age=60');
  res.json(buildOpenApiSpec());
});

// ---- Routes de l'API publique (exposées sur /api/* et /api/v1/* pour compatibilité totale avec vf-trailer-wallace) ----
app.get(['/api/status', '/api/v1/status'], apiGuard('trailers:read'), (req, res) => {
  res.set('cache-control', 'no-store');
  const ms = Date.now() - (req.apiStartMs || Date.now());
  recordApiTelemetry({
    ts: Date.now(), method: 'GET', path: req.path, query: '',
    client: req.apiClient?.label || 'API', status: 200, found: null, count: null, ms,
  });
  res.setHeader('X-Response-Time', `${ms}ms`);
  res.json({
    ok: true,
    version: manifest.version,
    uptime: Math.round(process.uptime()),
    capabilities: ['trailers', 'batch', 'search', 'title', 'submit', 'openapi', 'strict_season', 'fast_cache', 'source_filter'],
    sources: {
      netflix: true,
      appletv: !!config.appletvEnabled,
      ffmpeg: hls.ffmpegAvailable(),
      resolve: !!(config.resolveEnabled && config.tmdbKey),
      upstream: !!config.upstreamUrl,
    },
    stats: store.stats(),
  });
});

app.get(['/api/trailers', '/api/v1/trailers'], apiGuard('trailers:read'), wrap(async (req, res) => {
  res.set('cache-control', 'no-store');
  const out = await executeTrailersQuery(req.query, { logFederation: true });
  const ms = out.tookMs ?? (Date.now() - (req.apiStartMs || Date.now()));
  const count = Array.isArray(out.body?.trailers) ? out.body.trailers.length : 0;
  const found = !!out.body?.found;
  apiMetrics.trailersCalls++;
  if (found) {
    apiMetrics.trailersHits++;
    if (req.apiClient?.type === 'key' && req.apiClient.id) {
      // Incrémente uniquement hits_total sans recompter calls_total déjà incrémenté par apiGuard
      store.db.prepare('UPDATE api_keys SET hits_total = COALESCE(hits_total, 0) + 1 WHERE id = ?').run(req.apiClient.id);
    }
  }
  const qSummary = [
    req.query.imdb || (req.query.tmdb ? `tmdb:${req.query.tmdb}` : req.query.netflix ? `nflx:${req.query.netflix}` : ''),
    req.query.season ? `S${req.query.season}` : '',
    req.query.strict_season === '1' ? 'strict' : '',
    req.query.fast === '1' ? 'fast' : '',
  ].filter(Boolean).join(' · ');
  recordApiTelemetry({
    ts: Date.now(), method: 'GET', path: '/api/trailers', query: qSummary,
    client: req.apiClient?.label || 'API', status: out.status, found, count, ms,
  });
  res.setHeader('X-Response-Time', `${ms}ms`);
  res.setHeader('X-Trailer-Count', String(count));
  res.status(out.status).json(out.body);
}));

app.post(['/api/trailers/batch', '/api/v1/trailers/batch'], apiGuard('trailers:read'), wrap(async (req, res) => {
  res.set('cache-control', 'no-store');
  const rawItems = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  if (!rawItems.length) return res.status(400).json({ error: 'Tableau items requis (1 à 25 requêtes)' });
  if (rawItems.length > 25) return res.status(400).json({ error: 'Maximum 25 entrées par appel batch' });
  const t0 = Date.now();
  const includeExtras = !!(req.body && req.body.include_extras);
  const results = [];
  for (const item of rawItems) {
    const out = await executeTrailersQuery({ ...(item || {}), ...(includeExtras ? { include_extras: '1' } : {}) }, { logFederation: false, forceFast: true });
    results.push({ query: item, ...(out.body || {}) });
  }
  const tookMs = Date.now() - t0;
  const foundCount = results.filter((r) => r.found).length;
  apiMetrics.batchCalls++;
  recordApiTelemetry({
    ts: Date.now(), method: 'POST', path: '/api/trailers/batch', query: `${results.length} titres`,
    client: req.apiClient?.label || 'API', status: 200, found: foundCount > 0, count: foundCount, ms: tookMs,
  });
  res.setHeader('X-Response-Time', `${tookMs}ms`);
  res.json({ ok: true, count: results.length, foundCount, tookMs, results });
}));

app.get(['/api/search', '/api/v1/search'], apiGuard('catalog:read'), (req, res) => {
  res.set('cache-control', 'no-store');
  const t0 = Date.now();
  const body = executeCatalogSearch(req.query);
  const tookMs = Date.now() - t0;
  apiMetrics.searchCalls++;
  recordApiTelemetry({
    ts: Date.now(), method: 'GET', path: '/api/search', query: String(req.query.q || req.query.filter || 'catalogue').slice(0, 40),
    client: req.apiClient?.label || 'API', status: 200, found: body.results.length > 0, count: body.results.length, ms: tookMs,
  });
  res.setHeader('X-Response-Time', `${tookMs}ms`);
  res.json({ ...body, tookMs });
});

app.get(['/api/title/:id', '/api/v1/title/:id'], apiGuard('catalog:read'), (req, res) => {
  res.set('cache-control', 'no-store');
  const t0 = Date.now();
  const row = resolveAnyTitleId(req.params.id);
  const tookMs = Date.now() - t0;
  apiMetrics.titleCalls++;
  if (!row) {
    recordApiTelemetry({
      ts: Date.now(), method: 'GET', path: '/api/title/:id', query: String(req.params.id || '').slice(0, 32),
      client: req.apiClient?.label || 'API', status: 404, found: false, count: 0, ms: tookMs,
    });
    return res.status(404).json({ error: 'Titre introuvable' });
  }
  const trailers = federation.trailerUrls(row, { includeApple: true, includeManual: true });
  recordApiTelemetry({
    ts: Date.now(), method: 'GET', path: '/api/title/:id', query: row.imdb_id || row.id,
    client: req.apiClient?.label || 'API', status: 200, found: trailers.length > 0, count: trailers.length, ms: tookMs,
  });
  res.setHeader('X-Response-Time', `${tookMs}ms`);
  res.json({
    ok: true,
    tookMs,
    title: {
      id: row.id,
      name: row.name,
      type: row.type,
      year: row.year || null,
      release_date: row.release_date || null,
      imdb_id: row.imdb_id || null,
      tmdb_id: row.tmdb_id || null,
      tmdb_type: row.tmdb_type || null,
      netflix_id: row.netflix_id || null,
      poster: row.poster || null,
      background: row.background || null,
      synopsis: row.synopsis || null,
      genres: row.genres || [],
      episodesCount: row.type === 'series' ? store.getEpisodes(row.id).length : 0,
    },
    seasonsAvailable: seasonsAvailableOf(trailers),
    youtube: youtubeInfoOf(row),
    trailers,
  });
});

app.post(['/api/trailers/submit', '/api/v1/trailers/submit'], apiGuard('trailers:write'), wrap(async (req, res) => {
  res.set('cache-control', 'no-store');
  const t0 = Date.now();
  const b = req.body || {};
  apiMetrics.submitCalls++;
  try {
    // Mode 1 : ingestion directe d'une fiche Netflix / Prime Video via l'API
    if (b.ingest) {
      const input = String(b.ingest).trim();
      const isPrime = /primevideo\.com|amazon\.[a-z.]+\/.*detail/i.test(input) || (!/^\d+$/.test(input) && !!parsePrimeId(input));
      const r = isPrime ? await ingestPrime(input) : await ingestNetflix(input);
      const tookMs = Date.now() - t0;
      log.info('federation', `Ingestion API (${req.apiClient?.label || 'clé'}) : ${r.name}`, { id: r.id });
      recordApiTelemetry({
        ts: Date.now(), method: 'POST', path: '/api/trailers/submit', query: `ingest:${r.id}`,
        client: req.apiClient?.label || 'API', status: 200, found: true, count: r.trailers || 0, ms: tookMs,
      });
      return res.json({ ok: true, mode: 'ingest', tookMs, result: r });
    }

    // Mode 2 : rattachement d'une URL directe MP4 / HLS (.m3u8) à une fiche existante
    const url = String(b.url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('URL http(s) attendue');
    assertSafeUrlSync(url);
    const target = String(b.id || b.imdb || b.netflix || b.target || '').trim();
    if (!target) throw new Error('Cible requise (id, imdb ou netflix)');
    const row = resolveAnyTitleId(target);
    if (!row) return res.status(404).json({ error: `Titre introuvable pour « ${target} »` });
    const extra = { ...(row.extra || {}) };
    const list = Array.isArray(extra.manualTrailers) ? extra.manualTrailers : [];
    const label = String(b.title || 'Bande-annonce').slice(0, 120);
    list.push({ title: label, url, addedAt: Date.now(), addedBy: req.apiClient?.label || 'api' });
    extra.manualTrailers = list.slice(-5);
    store.upsertTitle({ id: row.id, type: row.type, name: row.name, extra });
    const idx = extra.manualTrailers.length - 1;
    const relayUrl = `${config.publicUrl}/media/${encodeURIComponent(row.id)}/${idx}.mp4`;
    const tookMs = Date.now() - t0;
    log.info('federation', `Flux direct soumis par API (${req.apiClient?.label || 'clé'}) : ${row.name}`, { id: row.id, label });
    recordApiTelemetry({
      ts: Date.now(), method: 'POST', path: '/api/trailers/submit', query: `${row.id}`,
      client: req.apiClient?.label || 'API', status: 200, found: true, count: extra.manualTrailers.length, ms: tookMs,
    });
    return res.json({ ok: true, mode: 'manual', id: row.id, name: row.name, count: extra.manualTrailers.length, relayUrl, tookMs });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
}));

// Racine : redirige vers le dashboard (l'addon Stremio reste sur /manifest.json).
app.get('/', (_req, res) => res.redirect('/admin'));

// ---- Bande-annonce Netflix : relais de la vidéo (avec lien renouvelé si expiré) ----
const UPSTREAM_HEADERS_TIMEOUT = 15000;
// `content-type` est volontairement exclu : voir pipeUpstream().
const PASS_HEADERS = ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

/** fetch dont le délai ne couvre que l'attente des en-têtes (le corps d'une vidéo se lit pendant des minutes). Coupé si le client part. */
async function fetchHead(url, headers, res, method = 'GET') {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPSTREAM_HEADERS_TIMEOUT);
  res.once('close', () => ctl.abort());
  // safeFetch : URL validée (pas d'adresse interne) et redirections revalidées une par une.
  try { return await safeFetch(url, { method: method === 'HEAD' ? 'HEAD' : 'GET', headers, signal: ctl.signal }); }
  finally { clearTimeout(timer); }
}

function pipeUpstream(req, res, up) {
  if (!up.ok && up.status !== 206) {
    if (up.body) up.body.cancel().catch(() => {});
    return res.status(up.status === 404 ? 404 : 502).type('text/plain').send('bande-annonce indisponible');
  }
  res.status(up.status);
  for (const h of PASS_HEADERS) if (up.headers.get(h)) res.set(h, up.headers.get(h));
  // Ne JAMAIS relayer le content-type amont : une réponse HTML serait interprétée par le
  // navigateur et pourrait exécuter du script sur l'origine de l'addon.
  res.set('content-type', 'video/mp4');
  res.set('Access-Control-Allow-Origin', '*');
  if (req.method === 'HEAD' || !up.body) return res.end();
  const stream = Readable.fromWeb(up.body);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

async function relayVideo(req, res, url, { range = true } = {}) {
  const headers = { 'user-agent': UA };
  if (range && req.headers.range) headers.range = req.headers.range;
  pipeUpstream(req, res, await fetchHead(url, headers, res, req.method));
}

/** Sert un flux HLS sous forme de MP4 (converti et mis en cache à la première lecture). */
async function serveHls(req, res, url) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('accept-ranges', 'bytes');
  res.set('content-type', 'video/mp4');
  if (req.method === 'HEAD') {                        // sonde du lecteur : inutile de lancer 30 Mo de téléchargement
    const ready = await hls.stat(url);
    if (!ready) return res.end();
    return res.sendFile(ready.file);
  }
  const { file, meta } = await hls.ensure(url);
  res.set('cache-control', 'public, max-age=3600');
  if (meta.duration) res.set('x-trailer-duration', String(Math.round(meta.duration)));
  res.sendFile(file, (err) => {
    if (!err || err.code === 'ECONNABORTED' || err.code === 'EPIPE' || res.headersSent) return;   // lecteur qui coupe : normal
    log.warn('trailer', `envoi du MP4 impossible : ${err.message}`);
    if (!res.headersSent) res.status(500).end();
  });
}

async function trailerHandler(req, res) {
  const nid = req.params.nid;
  const idx = Number(req.params.idx);
  console.log(`[trailer] ${req.method} ${nid}/${idx}${req.headers.range ? ' ' + req.headers.range : ''}`);
  const t = store.findByNetflixId(nid)?.trailers?.[idx];
  if (!t) return res.status(404).send('bande-annonce inconnue');
  try {
    let url = t.url;
    if (!url || (t.expires && t.expires < Date.now() + 120000)) url = (await refreshTrailers(nid))[idx]?.url;
    if (!url) throw new Error('lien vidéo indisponible');
    if (hls.isHls(url)) return await serveHls(req, res, url);
    const hdr = () => ({ 'user-agent': UA, ...(req.headers.range ? { range: req.headers.range } : {}) });
    let up = await fetchHead(url, hdr(), res, req.method);
    if (up.status === 403 || up.status === 410) {            // lien périmé côté Netflix : on le renouvelle une fois
      const fresh = (await refreshTrailers(nid))[idx]?.url;
      if (fresh) { await up.body?.cancel().catch(() => {}); url = fresh; up = await fetchHead(url, hdr(), res, req.method); }
    }
    pipeUpstream(req, res, up);
  } catch (e) {
    console.warn('[trailer]', nid, e.message);
    log.error('trailer', `${nid}/${idx} : ${e.message}`);
    if (!res.headersSent) res.status(502).send('bande-annonce indisponible');
  }
}
app.get('/trailer/:nid/:idx.mp4', mediaLimiter, trailerHandler);
app.head('/trailer/:nid/:idx.mp4', mediaLimiter, trailerHandler);

// ---- Bande-annonce Apple TV : la page fournit un flux HLS, on sert un MP4 converti ----
async function appleTrailerHandler(req, res) {
  const id = String(req.params.id);
  const idx = Number(req.params.idx);
  const t = store.getTitle(id)?.appletv?.[idx];
  if (!t || !t.url) return res.status(404).send('bande-annonce Apple TV inconnue');
  console.log(`[apple] ${req.method} ${id}/${idx}${req.headers.range ? ' ' + req.headers.range : ''}`);
  try {
    if (hls.isHls(t.url)) return await serveHls(req, res, t.url);
    return await relayVideo(req, res, t.url);          // trailer Apple déjà en MP4 : relais direct
  } catch (e) {
    console.warn('[apple]', id, e.message);
    log.error('trailer', `Apple TV ${id}/${idx} : ${e.message}`);
    if (!res.headersSent) res.status(502).send('bande-annonce Apple TV indisponible');
  }
}
app.get('/apple/:id/:idx.mp4', mediaLimiter, appleTrailerHandler);
app.head('/apple/:id/:idx.mp4', mediaLimiter, appleTrailerHandler);

// ---- Bandes-annonces ajoutées à la main : n'importe quelle URL publique (MP4 ou HLS) ----
// Couvre les plateformes sans source dédiée (Arte, Dailymotion, MP4 de distributeur…), stockées dans
// `extra.manualTrailers` de la fiche ciblée. Aucun contournement de DRM : un flux protégé échouera.
app.post('/admin/add/trailer', auth, (req, res) => {
  try {
    const url = String((req.body && req.body.url) || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('URL http(s) attendue');
    // Refuse les adresses internes dès l'ajout (le relais les refuserait de toute façon).
    assertSafeUrlSync(url);
    const key = String((req.body && (req.body.id || req.body.imdb || req.body.netflix)) || '').trim();
    if (!key) throw new Error('Titre cible manquant (ID Netflix, ID IMDb ou URL)');
    let row = store.getTitle(key) || (/^tt\d+$/.test(key) ? store.findByImdbId(key) : null) || store.findByNetflixId(key);
    if (!row && /netflix\.com\/title\/(\d+)/.test(key)) row = store.findByNetflixId(/netflix\.com\/title\/(\d+)/.exec(key)[1]);
    if (!row) throw new Error(`Titre inconnu : ${key} — ajoute-le d'abord (onglet Ajouter)`);
    const extra = { ...(row.extra || {}) };
    const list = Array.isArray(extra.manualTrailers) ? extra.manualTrailers : [];
    list.push({ title: String((req.body && req.body.title) || 'Bande-annonce').slice(0, 120), url, addedAt: Date.now() });
    extra.manualTrailers = list.slice(-5);
    store.upsertTitle({ id: row.id, type: row.type, name: row.name, extra });
    log.info('admin', `Bande-annonce ajoutée à la main : ${row.name}`, { url: url.slice(0, 90) });
    res.json({ ok: true, id: row.id, name: row.name, count: extra.manualTrailers.length });
  } catch (e) {
    log.warn('admin', `Bande-annonce refusée : ${e.message}`);
    res.status(400).json({ error: e.message });
  }
});

async function manualTrailerHandler(req, res) {
  const row = store.getTitle(String(req.params.id));
  const list = row && row.extra && Array.isArray(row.extra.manualTrailers) ? row.extra.manualTrailers : [];
  const t = list[Number(req.params.idx)];
  if (!t || !t.url) return res.status(404).send('bande-annonce inconnue');
  try {
    if (hls.isHls(t.url)) return await serveHls(req, res, t.url);   // HLS → MP4 (même pipeline qu'Apple TV)
    return await relayVideo(req, res, t.url);
  } catch (e) {
    log.error('trailer', `lien manuel ${row.id}/${req.params.idx} : ${e.message}`);
    if (!res.headersSent) res.status(502).send('bande-annonce indisponible');
  }
}
app.get('/media/:id/:idx.mp4', mediaLimiter, manualTrailerHandler);
app.head('/media/:id/:idx.mp4', mediaLimiter, manualTrailerHandler);

// Stremio relit le manifest régulièrement : un cache court évite de le régénérer à chaque ouverture.
app.use((req, res, next) => {
  if (req.path === '/manifest.json') res.set('cache-control', 'public, max-age=300');
  next();
});

// Une route d'API inconnue répond en JSON (et non avec la page d'erreur HTML d'Express).
app.use(['/admin/api', '/api'], (_req, res) => res.status(404).json({ error: 'Route inconnue' }));

// Limitation de débit sur les routes publiques Stremio (/stream et /meta déclenchent de la résolution réseau).
app.use(['/stream', '/meta'], apiLimiter);
app.use(getRouter(builder.getInterface()));

// Dernier filet : JSON invalide, corps trop gros, erreur inattendue → réponse JSON propre, jamais de requête pendue.
app.use((err, req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON invalide' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Corps de requête trop gros' });
  log.error('http', `${req.method} ${req.path} : ${err && err.message}`);
  if (res.headersSent) return res.destroy();
  res.status(500).json({ error: 'Erreur interne' });
});

module.exports = app;

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
const { ingestNetflix, refreshTrailers } = require('./enrich');
const { ingestPrime } = require('./primevideo');
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

const app = express();
app.use(express.json());
app.set('trust proxy', 'loopback');       // derrière Caddy/Nginx : req.ip = IP réelle du client

// ---- Accès admin : mot de passe = ADMIN_TOKEN (.env) ----
const attempts = new Map();               // borne les essais : 10 échecs / minute / IP

function tokenOk(given) {
  if (!config.adminToken) return false;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(config.adminToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function auth(req, res, next) {
  if (!config.adminToken) return res.status(503).json({ error: 'ADMIN_TOKEN non configuré dans le .env' });
  const key = req.ip || req.socket.remoteAddress || '?';
  const now = Date.now();
  const a = attempts.get(key);
  if (a && a.reset > now && a.n >= 10) return res.status(429).json({ error: 'Trop de tentatives, réessaie dans une minute' });
  if (!tokenOk(req.get('x-admin-token'))) {
    if (!a || a.reset <= now) attempts.set(key, { n: 1, reset: now + 60000 });
    else a.n++;
    if (attempts.size > 500) attempts.clear();
    log.warn('auth', 'Tentative d\'accès refusée', { ip: key });
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }
  attempts.delete(key);
  next();
}

// ---- API de fédération : clé API (en-tête x-api-key ou ?key=) ----
// API_KEY vide = API ouverte : une autre instance peut alors utiliser l'URL seule
// (sécurité par obscurité de l'adresse). Dès qu'une clé est configurée, elle redevient obligatoire.
function apiAuth(req, res, next) {
  if (!config.apiKey) return next();
  if (!federation.keyOk(req.get('x-api-key') || req.query.key)) {
    return res.status(401).json({ error: 'Clé API invalide' });
  }
  next();
}

app.get('/admin', (_req, res) => { res.set('cache-control', 'no-store'); res.type('html').send(ADMIN_HTML); });
app.get('/admin/api/summary', auth, (_req, res) => {
  res.set('cache-control', 'no-store');
  res.json({
    version: manifest.version, uptime: process.uptime(), node: process.version, stats: store.stats(), settings: settings.view(),
    addon: { resolve: !!(config.resolveEnabled && config.tmdbKey), publicUrl: config.publicUrl, appletv: !!config.appletvEnabled, upstream: !!config.upstreamUrl, apiOpen: !config.apiKey },
    // État des sources : ce qui, dans ce projet, casse en premier (clé TMDB, moteur de recherche, Apple TV, ffmpeg).
    sources: {
      tmdb: !!config.tmdbKey,
      brave: !!config.braveApiKey,
      search: 'JustWatch',
      appletv: !!config.appletvEnabled,
      ffmpeg: hls.ffmpegAvailable(),
      resolve: !!(config.resolveEnabled && config.tmdbKey),
      upstream: config.upstreamUrl || '',
      apiOpen: !config.apiKey,
    },
  });
});
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
app.post('/admin/add', auth, async (req, res) => {
  try {
    const input = req.body.url || req.body.id;
    const r = /primevideo\.com|amazon\.[a-z.]+\/.*detail/i.test(String(input)) ? await ingestPrime(input) : await ingestNetflix(input);
    log.info('admin', `Titre ajouté : ${r.name}`, { id: r.id });
    res.json(r);
  } catch (e) {
    log.error('admin', `Ajout échoué (${req.body.url || req.body.id}) : ${e.message}`);
    res.status(400).json({ error: e.message });
  }
});
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
app.post('/admin/netflix-ids', auth, (_req, res) => {
  try {
    const st = link.start({});
    log.info('link', 'Liage lancé depuis le dashboard', { total: st.total });
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
app.post('/admin/vf', auth, (_req, res) => {
  try {
    const st = vf.start({});
    log.info('vf', 'Recherche des bandes-annonces VF lancée depuis le dashboard', { total: st.total });
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
app.post('/admin/appletv', auth, (_req, res) => {
  try {
    const st = appletv.start({});
    log.info('appletv', 'Recherche Apple TV lancée depuis le dashboard', { total: st.total });
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
    search: String(req.query.search || '').trim(), filter: String(req.query.filter || ''),
    limit: Math.min(Number(req.query.limit) || 50, 200), offset: Number(req.query.offset) || 0,
  });
  res.json({
    total,
    rows: rows.map((r) => ({
      id: r.id, name: r.name, type: r.type, year: r.year, imdb: r.imdb_id || null, added: r.added_at || null,
      netflix: r.trailers.filter((t) => t && t.source !== 'upstream').length,
      upstream: r.trailers.filter((t) => t && t.source === 'upstream').length,
      apple: r.appletv.length,
      youtube: !!(r.vf_trailer || r.trailer_yt),
    })),
  });
});
app.get('/admin/api/netflix-ids/export', auth, (_req, res) => {
  res.set('content-disposition', 'attachment; filename="netflix-ids.json"');
  res.json(store.listLinked());
});
app.get('/admin/api/logs', auth, (req, res) => {
  res.set('cache-control', 'no-store');
  res.json(log.list({
    level: String(req.query.level || ''),
    search: String(req.query.search || ''),
    limit: Number(req.query.limit) || 200,
  }));
});
app.post('/admin/api/logs/clear', auth, (_req, res) => {
  const removed = log.clear();
  log.info('admin', 'Journal effacé', { removed });
  res.json({ ok: true, removed });
});
app.get('/health', (_req, res) => {
  const s = store.stats();
  res.json({
    ok: true, version: manifest.version, uptime: Math.round(process.uptime()),
    titles: s.total, withTrailer: s.withTrailer, netflix: s.withNetflixTrailer, appletv: s.withAppletv, youtube: s.withYoutube,
    pending: { netflixPages: s.netflixTrailerPending, unlinked: s.unlinked, vf: s.vfPending, appletv: s.appletvPending },
    sources: { tmdb: !!config.tmdbKey, appletv: !!config.appletvEnabled, ffmpeg: hls.ffmpegAvailable(), upstream: !!config.upstreamUrl },
    errors: s.logErrors,
  });
});

// ---- API de fédération : exposer les bandes-annonces à une autre instance ----
app.get('/api/status', apiAuth, (_req, res) => {
  res.set('cache-control', 'no-store');
  res.json({ ok: true, version: manifest.version, stats: store.stats() });
});

app.get('/api/trailers', apiAuth, async (req, res) => {
  res.set('cache-control', 'no-store');
  const imdb = String(req.query.imdb || '').trim();
  const tmdb = String(req.query.tmdb || '').trim();
  const netflix = String(req.query.netflix || '').trim();
  const type = String(req.query.type || '').trim();
  if (!imdb && !tmdb && !netflix) {
    return res.status(400).json({ error: 'paramètre imdb, tmdb ou netflix requis' });
  }
  let row = federation.lookup({ imdb, tmdb, type, netflix });
  // Titre inconnu (ou sans bande-annonce Netflix) : résolution à la demande TMDB → web → page Netflix.
  // Attente bornée à 5 s (le client vf-trailer-wallace abandonne à 6 s) ; au-delà, `pending: true` et la recherche continue.
  if (imdb) row = (await resolve.ensure(imdb, type, row, { timeoutMs: 5000 })) || row;
  const pending = !!imdb && resolve.isPending(imdb);
  if (!row) return res.json({ found: false, pending, trailers: [] });
  const trailers = federation.trailerUrls(row);
  res.json({
    found: trailers.length > 0,
    pending: pending && !trailers.length,
    title: {
      id: row.id, name: row.name, type: row.type, year: row.year,
      netflix_id: row.netflix_id, tmdb_id: row.tmdb_id, tmdb_type: row.tmdb_type, imdb_id: row.imdb_id,
    },
    trailers,
  });
});

// Racine : redirige vers le dashboard (l'addon Stremio reste sur /manifest.json).
app.get('/', (_req, res) => res.redirect('/admin'));

// ---- Bande-annonce Netflix : relais de la vidéo (avec lien renouvelé si expiré) ----
async function relayVideo(req, res, url, { range = true } = {}) {
  const headers = { 'user-agent': UA };
  if (range && req.headers.range) headers.range = req.headers.range;
  const up = await fetch(url, { headers });
  res.status(up.status);
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    if (up.headers.get(h)) res.set(h, up.headers.get(h));
  }
  res.set('Access-Control-Allow-Origin', '*');
  if (req.method === 'HEAD' || !up.body) return res.end();
  const stream = Readable.fromWeb(up.body);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
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
    let up = await fetch(url, { headers: { 'user-agent': UA, ...(req.headers.range ? { range: req.headers.range } : {}) } });
    if (up.status === 403 || up.status === 410) {            // lien périmé côté Netflix : on le renouvelle une fois
      const fresh = (await refreshTrailers(nid))[idx]?.url;
      if (fresh) { url = fresh; up = await fetch(url, { headers: { 'user-agent': UA, ...(req.headers.range ? { range: req.headers.range } : {}) } }); }
    }
    res.status(up.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      if (up.headers.get(h)) res.set(h, up.headers.get(h));
    }
    res.set('Access-Control-Allow-Origin', '*');
    if (req.method === 'HEAD' || !up.body) return res.end();
    const stream = Readable.fromWeb(up.body);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch (e) {
    console.warn('[trailer]', nid, e.message);
    log.error('trailer', `${nid}/${idx} : ${e.message}`);
    if (!res.headersSent) res.status(502).send(`bande-annonce indisponible : ${e.message}`);
  }
}
app.get('/trailer/:nid/:idx.mp4', trailerHandler);
app.head('/trailer/:nid/:idx.mp4', trailerHandler);

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
    if (!res.headersSent) res.status(502).send(`bande-annonce Apple TV indisponible : ${e.message}`);
  }
}
app.get('/apple/:id/:idx.mp4', appleTrailerHandler);
app.head('/apple/:id/:idx.mp4', appleTrailerHandler);

// Stremio relit le manifest régulièrement : un cache court évite de le régénérer à chaque ouverture.
app.use((req, res, next) => {
  if (req.path === '/manifest.json') res.set('cache-control', 'public, max-age=300');
  next();
});

app.use(getRouter(builder.getInterface()));

module.exports = app;

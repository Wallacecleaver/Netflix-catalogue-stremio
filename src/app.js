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
const { ingestNetflix, refreshTrailers } = require('./enrich');
const link = require('./link');
const harvest = require('./harvest');
const vf = require('./vf');
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

app.get('/admin', (_req, res) => { res.set('cache-control', 'no-store'); res.type('html').send(ADMIN_HTML); });
app.get('/admin/api/summary', auth, (_req, res) => {
  res.set('cache-control', 'no-store');
  res.json({ version: manifest.version, uptime: process.uptime(), node: process.version, stats: store.stats(), settings: settings.view() });
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
    const r = await ingestNetflix(req.body.url || req.body.id);
    log.info('admin', `Titre ajouté : ${r.name}`, { id: r.id, netflix_id: r.id.replace(/^nflx:/, '') });
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
app.get('/health', (_req, res) => res.json({ ok: true, titles: store.count() }));

// Racine : redirige vers le dashboard (l'addon Stremio reste sur /manifest.json).
app.get('/', (_req, res) => res.redirect('/admin'));

// ---- Bande-annonce Netflix : relais de la vidéo (avec lien renouvelé si expiré) ----
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
    const headers = { 'user-agent': UA };
    if (req.headers.range) headers.range = req.headers.range;
    let up = await fetch(url, { headers });
    if (up.status === 403 || up.status === 410) {            // lien périmé côté Netflix : on le renouvelle une fois
      const fresh = (await refreshTrailers(nid))[idx]?.url;
      if (fresh) up = await fetch(fresh, { headers });
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

app.use(getRouter(builder.getInterface()));

module.exports = app;

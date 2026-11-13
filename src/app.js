const express = require('express');
const crypto = require('crypto');
const { Readable } = require('stream');
const { getRouter } = require('stremio-addon-sdk');
const config = require('./config');
const store = require('./db');
const { builder, manifest } = require('./addon');
const { HTML: ADMIN_HTML, configView } = require('./admin');
const { ingestNetflix, refreshTrailers } = require('./enrich');
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
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }
  attempts.delete(key);
  next();
}

app.get('/admin', (_req, res) => { res.set('cache-control', 'no-store'); res.type('html').send(ADMIN_HTML); });
app.get('/admin/api/summary', auth, (_req, res) => {
  res.set('cache-control', 'no-store');
  res.json({ version: manifest.version, uptime: process.uptime(), node: process.version, stats: store.stats(), config: configView() });
});
app.post('/admin/add', auth, async (req, res) => {
  try { res.json(await ingestNetflix(req.body.url || req.body.id)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/admin/sync', auth, async (_req, res) => {
  try {
    const [added, recent] = await Promise.all([syncCatalog(), syncRecent()]);
    res.json({ added, recent });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/health', (_req, res) => res.json({ ok: true, titles: store.count() }));

// ---- Bande-annonce Netflix : relais de la vidéo (avec lien renouvelé si expiré) ----
async function trailerHandler(req, res) {
  const nid = req.params.nid;
  const idx = Number(req.params.idx);
  console.log(`[trailer] ${req.method} ${nid}/${idx}${req.headers.range ? ' ' + req.headers.range : ''}`);
  const t = store.getTitle(`nflx:${nid}`)?.trailers?.[idx];
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
    if (!res.headersSent) res.status(502).send(`bande-annonce indisponible : ${e.message}`);
  }
}
app.get('/trailer/:nid/:idx.mp4', trailerHandler);
app.head('/trailer/:nid/:idx.mp4', trailerHandler);

app.use(getRouter(builder.getInterface()));

module.exports = app;

const express = require('express');
const { Readable } = require('stream');
const { getRouter } = require('stremio-addon-sdk');
const config = require('./config');
const store = require('./db');
const { builder } = require('./addon');
const { ingestNetflix, refreshTrailers } = require('./enrich');
const { syncCatalog } = require('./sync');
const { UA } = require('./netflix');

const app = express();
app.use(express.json());

const ADMIN_HTML = `<!doctype html><meta charset="utf-8"><title>Netflix Catalogue — admin</title>
<style>body{font:16px system-ui;max-width:640px;margin:40px auto;padding:0 16px}input,button{font:inherit;padding:8px;margin:4px 0;width:100%;box-sizing:border-box}pre{background:#111;color:#0f0;padding:12px;white-space:pre-wrap}</style>
<h1>Netflix Catalogue</h1>
<input id=t type=password placeholder="ADMIN_TOKEN">
<input id=u placeholder="https://www.netflix.com/fr/title/81944880 (ou l'ID)">
<button onclick="go('/admin/add',{url:u.value})">Ajouter / rafraîchir ce titre</button>
<button onclick="go('/admin/sync',{})">Synchroniser le catalogue TMDB</button>
<pre id=o></pre>
<script>async function go(p,b){o.textContent='...';const r=await fetch(p,{method:'POST',headers:{'content-type':'application/json','x-admin-token':t.value},body:JSON.stringify(b)});o.textContent=JSON.stringify(await r.json(),null,2)}</script>`;

function auth(req, res, next) {
  if (!config.adminToken) return res.status(503).json({ error: 'ADMIN_TOKEN non configuré' });
  if (req.get('x-admin-token') !== config.adminToken) return res.status(401).json({ error: 'token invalide' });
  next();
}

app.get('/admin', (_req, res) => res.type('html').send(ADMIN_HTML));
app.post('/admin/add', auth, async (req, res) => {
  try { res.json(await ingestNetflix(req.body.url || req.body.id)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/admin/sync', auth, async (_req, res) => {
  try { res.json({ added: await syncCatalog() }); }
  catch (e) { res.status(400).json({ error: e.message }); }
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

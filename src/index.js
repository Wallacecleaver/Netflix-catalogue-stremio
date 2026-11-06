const express = require('express');
const { getRouter } = require('stremio-addon-sdk');
const config = require('./config');
const store = require('./db');
const { builder } = require('./addon');
const { ingestNetflix } = require('./enrich');
const { syncCatalog } = require('./sync');

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

app.use(getRouter(builder.getInterface()));

app.listen(config.port, () => {
  console.log(`Addon prêt : http://localhost:${config.port}/manifest.json`);
  if (config.tmdbKey) {
    const run = () => syncCatalog().then((n) => console.log(`[sync] +${n} titres`)).catch((e) => console.warn('[sync]', e.message));
    if (store.count() === 0) run();
    setInterval(run, config.syncEveryHours * 3600 * 1000).unref();
  } else {
    console.warn('TMDB_API_KEY absent : pas de catalogue auto, ajoute des titres via /admin ou `npm run add`.');
  }
});

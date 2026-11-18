// Tests de non-régression : correctifs sécurité (SSRF IPv6), intégrité SQLite (fusion doublons,
// tableaux vides), cache HLS, fédération /api/trailers + relais MP4, et nouveau dashboard v2.8.0.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'stockage-db-audit-'));
process.env.DB_PATH = path.join(tmpBase, 'audit.db');
process.env.HLS_CACHE_DIR = path.join(tmpBase, 'hls');
process.env.ADMIN_TOKEN = 'audit-admin-secret';
process.env.API_KEY = 'audit-federation-key';
process.env.APPLETV_ENABLED = '0';
process.env.NETFLIX_REFRESH = '0';
process.env.RESOLVE_ENABLED = '0';

const { isPrivateIp, assertSafeUrlSync } = require('../src/security');
const store = require('../src/db');
const hls = require('../src/hls');
const config = require('../src/config');
const appletv = require('../src/appletv');

// ---- 1. Anti-SSRF IPv6 (formes décimales ET hex normalisées par new URL) ----
{
  const blocked = [
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',          // new URL('http://[::ffff:127.0.0.1]').hostname
    '::ffff:10.0.0.5',
    '::ffff:a00:5',
    '::ffff:169.254.169.254', // AWS/cloud metadata en IPv4-mapped
    '::ffff:a9fe:a9fe',
    '::ffff:0:127.0.0.1',     // SIIT
    '64:ff9b::7f00:1',        // NAT64
    '64:ff9b:1::1',
    '100::1',                 // RFC 6666 discard
    '2001::1',                // Teredo
    '2001:2::1',              // Benchmarking
    '2001:db8::1',            // Documentation
    '2002:7f00:1::1',         // 6to4 loopback
    '2002:c0a8:101::1',       // 6to4 192.168.1.1
    'fc00::1',                // ULA
    'fd12:3456::1',           // ULA
    'fe80::1',                // Link-local
    'fec0::1',                // Site-local
    'ff02::1',                // Multicast
  ];
  for (const ip of blocked) {
    assert.strictEqual(isPrivateIp(ip), true, `IP interne non détectée : ${ip}`);
  }
  const allowed = [
    '93.184.216.34',
    '1.1.1.1',
    '2606:4700:4700::1111',
    '2002:5db8:d822::1',      // 6to4 vers IP publique 93.184.216.34
  ];
  for (const ip of allowed) {
    assert.strictEqual(isPrivateIp(ip), false, `IP publique bloquée à tort : ${ip}`);
  }

  // assertSafeUrlSync doit rejeter les URLs IPv4-mapped (que Node normalise en ::ffff:7f00:1)
  delete process.env.ALLOW_PRIVATE_URLS;
  for (const badUrl of [
    'http://[::ffff:127.0.0.1]/admin',
    'http://[::ffff:169.254.169.254]/latest/meta-data/',
    'http://[64:ff9b::7f00:1]/x',
    'http://[2002:7f00:1::1]/x',
    'http://[::1]:7000/manifest.json',
    'http://127.0.0.1:7000/manifest.json',
    'http://service.internal/secret',
  ]) {
    assert.throws(() => assertSafeUrlSync(badUrl), /refusé/, `URL interne acceptée à tort : ${badUrl}`);
  }
  assert.doesNotThrow(() => assertSafeUrlSync('https://93.184.216.34/trailer.mp4'));
}

// ---- 2. SQLite : tableaux vides vs champs omis + fusion sans perte des doublons ----
{
  // 2a. Tableau vide explicite doit écraser une ancienne liste périmée (au lieu d'être avalé par COALESCE)
  store.upsertTitle({
    id: 'tmdb:movie:99901',
    type: 'movie',
    name: 'Test Vide',
    appletv: [{ title: 'Ancien trailer v1', url: 'https://tv.apple.com/old.m3u8' }],
    trailers: [{ title: 'Ancien trailer Netflix', url: 'https://nflx.example/old.mp4' }],
  });
  // Omission de `appletv` et `trailers` -> préservés
  store.upsertTitle({ id: 'tmdb:movie:99901', type: 'movie', name: 'Test Vide Maj' });
  let row = store.getTitle('tmdb:movie:99901');
  assert.strictEqual(row.appletv.length, 1);
  assert.strictEqual(row.trailers.length, 1);
  // Tableau vide explicite `[]` -> efface proprement
  store.upsertTitle({ id: 'tmdb:movie:99901', type: 'movie', name: 'Test Vide Maj', appletv: [] });
  row = store.getTitle('tmdb:movie:99901');
  assert.strictEqual(row.appletv.length, 0, 'appletv: [] doit vider la liste existante');
  assert.strictEqual(row.trailers.length, 1, 'trailers omis doit rester intact');

  // 2b. Fusion des doublons (deleteDuplicates + deleteNetflixDuplicates) : aucune perte d'IMDb, Apple TV ou liens manuels
  store.upsertTitle({
    id: 'nflx:770011',
    netflix_id: '770011',
    type: 'series',
    name: 'Série Fusion',
    trailers: [{ title: 'Saison 1 (VF) : Série Fusion', url: 'https://cdn.example/s1.mp4' }],
  });
  store.upsertTitle({
    id: 'tmdb:tv:554433',
    tmdb_id: 554433,
    tmdb_type: 'tv',
    imdb_id: 'tt5544332',
    type: 'series',
    name: 'Série Fusion',
    vf_trailer: 'dQw4w9WgXcQ',
    appletv: [{ title: 'Saison 2 (Bande-annonce) : Série Fusion', url: 'https://play.itunes.apple.com/s2.mp4' }],
    extra: { manualTrailers: [{ title: 'Teaser Saison 3', url: 'https://cdn.example/s3.mp4', addedAt: 1 }] },
  });
  const removed = store.deleteDuplicates('tv', 554433, 'nflx:770011');
  assert.strictEqual(removed, 1);
  assert.ok(!store.getTitle('tmdb:tv:554433'));
  const merged = store.getTitle('nflx:770011');
  assert.strictEqual(merged.imdb_id, 'tt5544332', 'imdb_id du doublon fusionné');
  assert.strictEqual(merged.vf_trailer, 'dQw4w9WgXcQ', 'vf_trailer du doublon fusionné');
  assert.strictEqual(merged.appletv.length, 1, 'appletv du doublon fusionné');
  assert.strictEqual(merged.extra.manualTrailers.length, 1, 'manualTrailers du doublon fusionné');
  assert.strictEqual(merged.trailers.length, 1, 'trailers du titre principal préservés');

  // Et deleteNetflixDuplicates fusionne également un doublon nflx:* vers une fiche existante
  store.upsertTitle({
    id: 'tmdb:movie:661122',
    netflix_id: '991122',
    type: 'movie',
    name: 'Film Doublon Netflix',
  });
  store.upsertTitle({
    id: 'nflx:991122',
    netflix_id: '991122',
    imdb_id: 'tt9911220',
    type: 'movie',
    name: 'Film Doublon Netflix',
    trailers: [{ title: 'Bande-annonce VF', url: 'https://cdn.example/f1.mp4' }],
  });
  assert.strictEqual(store.deleteNetflixDuplicates('991122', 'tmdb:movie:661122'), 1);
  const keptMovie = store.getTitle('tmdb:movie:661122');
  assert.strictEqual(keptMovie.imdb_id, 'tt9911220');
  assert.strictEqual(keptMovie.trailers.length, 1);
}

// ---- 3. HLS : en-têtes Apple limités aux domaines Apple + stats/purge du cache disque ----
async function testHlsAndHttp() {
  assert.strictEqual(hls.isAppleHost('https://play-edge.itunes.apple.com/WebObjects/MZPlay.woa/hls.m3u8'), true);
  assert.strictEqual(hls.isAppleHost('https://vod-ak-amt.tv.apple.com/master.m3u8'), true);
  assert.strictEqual(hls.isAppleHost('https://is1-ssl.mzstatic.com/video.m3u8'), true);
  assert.strictEqual(hls.isAppleHost('https://arteptv-vh.akamaihd.net/i/trailer.m3u8'), false);
  assert.strictEqual(hls.isAppleHost('https://cdn.distributeur.fr/ba-saison-2.m3u8'), false);

  fs.mkdirSync(process.env.HLS_CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.HLS_CACHE_DIR, 'abcd1234.mp4'), Buffer.alloc(4096, 0x11));
  fs.writeFileSync(path.join(process.env.HLS_CACHE_DIR, 'abcd1234.json'), JSON.stringify({ builtAt: Date.now(), bytes: 4096 }));
  const before = await hls.cacheStats();
  assert.strictEqual(before.files, 1);
  assert.strictEqual(before.bytes, 4096);
  const cleared = await hls.clearCache();
  assert.strictEqual(cleared.removed, 1);
  const after = await hls.cacheStats();
  assert.strictEqual(after.files, 0);

  // ---- 4. Serveur HTTP : relais erreur amont, fédération Apple TV à la demande, et Dashboard v2.8.0 ----
  // Autorise les serveurs de test locaux (127.0.0.1) pour le relais vidéo simulé
  process.env.ALLOW_PRIVATE_URLS = '1';

  // Petit serveur amont simulé : renvoie HTTP 500 HTML sur /broken.mp4 et un vrai MP4 sur /ok.mp4
  const mp4Bytes = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
  const upstreamSrv = http.createServer((req, res) => {
    if (req.url === '/broken.mp4') {
      res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body>Upstream gateway error</body></html>');
      return;
    }
    if (req.url === '/ok.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': mp4Bytes.length, 'accept-ranges': 'bytes' });
      if (req.method === 'HEAD') return res.end();
      return res.end(mp4Bytes);
    }
    res.writeHead(404).end('not found');
  });
  await new Promise((r) => upstreamSrv.listen(0, '127.0.0.1', r));
  const upPort = upstreamSrv.address().port;

  // Fiche avec bande-annonce cassée en idx 0 et valide en idx 1
  store.upsertTitle({
    id: 'nflx:880099',
    netflix_id: '880099',
    imdb_id: 'tt8800991',
    type: 'series',
    name: 'Test Relais & Saison',
    year: 2025,
    trailers: [
      { title: 'Bande-annonce cassée', url: `http://127.0.0.1:${upPort}/broken.mp4` },
      { title: 'Saison 2 (Bande-annonce VF) : Test Relais & Saison', url: `http://127.0.0.1:${upPort}/ok.mp4`, lang: 'fr' },
    ],
    extra: {
      manualTrailers: [
        { title: 'Saison 3 — Bande-annonce officielle VF', url: `http://127.0.0.1:${upPort}/ok.mp4`, addedAt: Date.now() },
      ],
    },
  });

  // Fiche sans bande-annonce Netflix mais enrichissable à la demande via appletv.ensure dans /api/trailers
  store.upsertTitle({
    id: 'tmdb:movie:424242',
    tmdb_id: 424242,
    tmdb_type: 'movie',
    imdb_id: 'tt4242420',
    type: 'movie',
    name: 'Film Apple À La Demande',
    year: 2025,
  });

  const origAppleEnsure = appletv.ensure;
  let appleEnsureCalled = 0;
  appletv.ensure = async (row) => {
    if (row && row.imdb_id === 'tt4242420') {
      appleEnsureCalled++;
      const found = [{ title: 'Bande-annonce officielle VF', url: `http://127.0.0.1:${upPort}/ok.mp4`, lang: 'fr-FR' }];
      store.upsertTitle({ id: row.id, type: row.type, name: row.name, appletv: found, appletv_checked: Date.now() });
      return store.getTitle(row.id);
    }
    return row;
  };

  const app = require('../src/app');
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  config.publicUrl = `http://127.0.0.1:${port}`;
  const base = config.publicUrl;
  const adminHeaders = { 'x-admin-token': 'audit-admin-secret', 'content-type': 'application/json' };
  const fedHeaders = { 'x-api-key': 'audit-federation-key' };

  try {
    // 4a. Une erreur HTTP 500 amont ne doit JAMAIS être servie comme un MP4 (status 502 text/plain)
    const brokenRes = await fetch(`${base}/trailer/880099/0.mp4`);
    assert.strictEqual(brokenRes.status, 502);
    assert.match(String(brokenRes.headers.get('content-type') || ''), /text\/plain/i);

    // 4b. Un vrai MP4 (et HEAD sur /media/:id/:idx.mp4) répond 200 video/mp4
    const okHead = await fetch(`${base}/media/${encodeURIComponent('nflx:880099')}/0.mp4`, { method: 'HEAD' });
    assert.strictEqual(okHead.status, 200);
    assert.strictEqual(okHead.headers.get('content-type'), 'video/mp4');

    // 4c. /api/trailers déclenche désormais appletv.ensure à la demande et renvoie le MP4 relayé
    const appleFed = await fetch(`${base}/api/trailers?imdb=tt4242420&type=movie`, { headers: fedHeaders }).then((r) => r.json());
    assert.strictEqual(appleEnsureCalled, 1, 'appletv.ensure doit être appelé sur /api/trailers');
    assert.strictEqual(appleFed.found, true);
    assert.strictEqual(appleFed.trailers.length, 1);
    assert.strictEqual(appleFed.trailers[0].source, 'appletv');

    // 4d. Filtrage strict par saison dans /api/trailers (cohérence avec vf-trailer-wallace)
    const s2Fed = await fetch(`${base}/api/trailers?imdb=tt8800991&type=series&season=2&strict_season=1`, { headers: fedHeaders }).then((r) => r.json());
    assert.strictEqual(s2Fed.found, true);
    assert.strictEqual(s2Fed.trailers.length, 1);
    assert.strictEqual(s2Fed.trailers[0].season, 2);

    const s3Fed = await fetch(`${base}/api/trailers?imdb=tt8800991&type=series&season=3&strict_season=1`, { headers: fedHeaders }).then((r) => r.json());
    assert.strictEqual(s3Fed.found, true);
    assert.strictEqual(s3Fed.trailers.length, 1);
    assert.strictEqual(s3Fed.trailers[0].season, 3);
    assert.strictEqual(s3Fed.trailers[0].source, 'manual');

    // ---- 5. Dashboard HTML + logo W + API universelle v3.3.0 (/api/docs & /api/v1 discovery, sans manifest Stremio) ----
    const manifest404 = await fetch(`${base}/manifest.json`);
    assert.strictEqual(manifest404.status, 404, '/manifest.json ne doit plus exister en mode pur serveur API');

    const discovRes = await fetch(`${base}/api/v1`);
    assert.strictEqual(discovRes.status, 200, 'GET /api/v1 doit exposer le descriptif JSON universel');
    const discovJson = await discovRes.json();
    assert.strictEqual(discovJson.ok, true);
    assert.strictEqual(discovJson.service, 'stockage-db');
    assert.strictEqual(discovJson.version, '3.3.0');
    assert.ok(discovJson.endpoints && discovJson.endpoints.trailersById.includes('/api/v1/trailers/{id}'));

    const wellKnownRes = await fetch(`${base}/.well-known/stockage-db.json`);
    assert.strictEqual(wellKnownRes.status, 200, '/.well-known/stockage-db.json doit répondre 200');

    const docsRes = await fetch(`${base}/api/docs`);
    assert.strictEqual(docsRes.status, 200, 'GET /api/docs doit servir la documentation publique interactive');
    const docsHtml = await docsRes.text();
    assert.ok(docsHtml.includes('API Universelle') && docsHtml.includes('v3.3.0'), 'Le guide /api/docs doit afficher API Universelle et la version v3.3.0');
    const docsScripts = [...docsHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
    assert.ok(docsScripts.length >= 1, 'Au moins un bloc <script> attendu dans api-docs.html');
    for (const [, code] of docsScripts) {
      assert.doesNotThrow(() => new Function(code), 'Erreur de syntaxe JS détectée dans src/api-docs.html');
    }

    const logoSvgRes = await fetch(`${base}/logo.svg`);
    assert.strictEqual(logoSvgRes.status, 200, '/logo.svg doit être servi publiquement');
    assert.ok(String(logoSvgRes.headers.get('content-type') || '').includes('image/svg+xml'));
    const logoSvgText = await logoSvgRes.text();
    assert.ok(logoSvgText.includes('<svg') && logoSvgText.includes('Logo W'), 'Le SVG du logo W doit être valide');

    const logoPngRes = await fetch(`${base}/logo.png`);
    assert.strictEqual(logoPngRes.status, 200, '/logo.png doit être servi publiquement');
    assert.ok(String(logoPngRes.headers.get('content-type') || '').includes('image/png'));

    const htmlRes = await fetch(`${base}/admin`);
    assert.strictEqual(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.ok(html.includes('Stockage DB'), 'Le titre Stockage DB doit figurer dans /admin');
    assert.ok(html.includes('v3.3.0'), 'Le badge de version v3.3.0 doit être injecté dans /admin');
    assert.ok(html.includes('/logo.png') && html.includes('/logo.svg'), 'Le logo personnalisé W doit être intégré au dashboard et au favicon');
    assert.ok(html.includes('vf-trailer-wallace'), 'La compatibilité vf-trailer-wallace doit être mentionnée');
    assert.ok(html.includes('id="tab-streams"') && html.includes('Test des flux'), 'L\'onglet Test des flux doit être présent dans Exploitation');
    assert.ok(html.includes('API &amp; Connexion Universelle'), 'L\'onglet API & Connexion Universelle doit être présent');
    assert.ok(html.includes('/api/docs'), 'Le lien vers le guide public /api/docs doit être présent dans /admin');
    assert.ok(html.includes('white-space: pre-wrap'), 'Les blocs code-box doivent préserver les retours à la ligne');
    assert.ok(!html.includes('/manifest.json') && !html.includes('stremio://'), 'Aucune trace de manifest.json ou stremio:// ne doit rester dans /admin');

    // Vérifie que tout le JavaScript embarqué dans admin.html se compile sans aucune erreur de syntaxe
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
    assert.ok(scripts.length >= 1, 'Au moins un bloc <script> attendu dans admin.html');
    for (const [, code] of scripts) {
      assert.doesNotThrow(() => new Function(code), 'Erreur de syntaxe JS détectée dans src/admin.html');
    }

    // /admin/api/summary enrichi
    const sumRes = await fetch(`${base}/admin/api/summary`, { headers: adminHeaders });
    assert.strictEqual(sumRes.status, 200);
    const summary = await sumRes.json();
    assert.strictEqual(summary.version, '3.3.0');
    assert.strictEqual(summary.addon.apiHasKey, true);
    assert.ok(summary.hls && typeof summary.hls.files === 'number');
    assert.ok(typeof summary.stats.withManual === 'number');
    assert.ok(summary.apiMetrics && typeof summary.apiMetrics.totalCalls === 'number');

    // Tri + export JSON du catalogue
    const sortedRes = await fetch(`${base}/admin/api/titles?sort=name&limit=5`, { headers: adminHeaders }).then((r) => r.json());
    assert.ok(Array.isArray(sortedRes.rows) && sortedRes.rows.length >= 2);
    assert.ok(sortedRes.rows[0].name.localeCompare(sortedRes.rows[1].name, 'fr') <= 0, 'Le tri alphabétique doit ordonner les titres A→Z');

    const expJson = await fetch(`${base}/admin/api/titles/export?type=series&limit=10`, { headers: adminHeaders }).then((r) => r.json());
    assert.strictEqual(expJson.ok, true);
    assert.ok(expJson.exportedCount >= 1 && Array.isArray(expJson.items));

    // /admin/api/titles/:id (inspecteur des bandes-annonces, saisons et champ lang)
    const detailRes = await fetch(`${base}/admin/api/titles/${encodeURIComponent('nflx:880099')}`, { headers: adminHeaders });
    assert.strictEqual(detailRes.status, 200);
    const detailJson = await detailRes.json();
    assert.strictEqual(detailJson.id, 'nflx:880099');
    assert.strictEqual(detailJson.trailers.length, 3);
    assert.ok(detailJson.trailers.some((t) => t.season === 2 && t.source === 'netflix' && t.lang === 'fr'));
    assert.ok(detailJson.trailers.some((t) => t.season === 3 && t.source === 'manual'));

    // /admin/api/test-federation (testeur live depuis le dashboard)
    const testFedRes = await fetch(`${base}/admin/api/test-federation?imdb=tt8800991&type=series&season=2&strict_season=1`, { headers: adminHeaders });
    assert.strictEqual(testFedRes.status, 200);
    const testFedJson = await testFedRes.json();
    assert.strictEqual(testFedJson.found, true);
    assert.strictEqual(testFedJson.trailers.length, 1);
    assert.ok(testFedJson.debug && testFedJson.debug.counts);

    // /admin/api/probe-stream + /admin/api/stream-sample (onglet Exploitation -> Test des flux)
    const brokenProbe = await fetch(`${base}/admin/api/probe-stream`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ url: `${base}/trailer/880099/0.mp4` }),
    }).then((r) => r.json());
    assert.strictEqual(brokenProbe.ok, false, 'Un flux relais cassé doit être détecté comme KO par probe-stream');
    assert.strictEqual(brokenProbe.status, 502);
    assert.strictEqual(brokenProbe.isMp4, false);

    const okProbe = await fetch(`${base}/admin/api/probe-stream`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ url: `${base}/trailer/880099/1.mp4` }),
    }).then((r) => r.json());
    assert.strictEqual(okProbe.ok, true, 'Un flux MP4 valide doit être validé (ftyp) par probe-stream');
    assert.strictEqual(okProbe.isMp4, true);
    assert.ok(okProbe.status === 200 || okProbe.status === 206);
    assert.strictEqual(okProbe.relay, 'trailer');

    const sampleRes = await fetch(`${base}/admin/api/stream-sample?limit=4`, { headers: adminHeaders }).then((r) => r.json());
    assert.strictEqual(sampleRes.ok, true);
    assert.ok(Array.isArray(sampleRes.items) && sampleRes.items.length >= 1);
    assert.ok(sampleRes.items.every((it) => it.primary && typeof it.primary.url === 'string'));

    // ---- 6. Système d'API v3.2.1 : clés scopées, quotas par clé, pause/rotation, batch, prewarm, search, title, submit, OpenAPI ----
    // 6a. Spécification OpenAPI 3.0.3 publique + CORS
    const oaRes = await fetch(`${base}/api/v1/openapi.json`);
    assert.strictEqual(oaRes.status, 200);
    assert.strictEqual(oaRes.headers.get('access-control-allow-origin'), '*');
    const oaJson = await oaRes.json();
    assert.strictEqual(oaJson.openapi, '3.0.3');
    assert.strictEqual(oaJson.info.version, '3.3.0');
    assert.ok(oaJson.paths['/api/v1/trailers/{id}']);
    assert.ok(oaJson.paths['/api/trailers/batch']);
    assert.ok(oaJson.paths['/api/prewarm']);

    // 6b. Création d'une clé scopée lecture seule avec quota personnalisé (120 req/min)
    const keyCreateRes = await fetch(`${base}/admin/api/keys`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ label: 'Serveur VF Test', scopes: 'trailers:read,catalog:read', rateLimit: 120, expiresInDays: 30 }),
    });
    assert.strictEqual(keyCreateRes.status, 200);
    const createdKey = await keyCreateRes.json();
    assert.ok(createdKey.key.startsWith('sdb_'));
    assert.strictEqual(createdKey.rateLimit, 120);

    // Vérification des en-têtes X-RateLimit-* sur /api/v1/status
    const stV1Res = await fetch(`${base}/api/v1/status`, { headers: { Authorization: `Bearer ${createdKey.key}` } });
    assert.strictEqual(stV1Res.status, 200);
    assert.strictEqual(stV1Res.headers.get('x-ratelimit-limit'), '120');
    const stV1Json = await stV1Res.json();
    assert.ok(Array.isArray(stV1Json.capabilities) && stV1Json.capabilities.includes('prewarm'));

    // 6c. Pause puis réactivation de la clé
    await fetch(`${base}/admin/api/keys/update`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ id: createdKey.id, enabled: false }),
    });
    const pausedRes = await fetch(`${base}/api/status`, { headers: { 'x-api-key': createdKey.key } });
    assert.strictEqual(pausedRes.status, 403, 'Une clé en pause doit répondre 403');

    await fetch(`${base}/admin/api/keys/update`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ id: createdKey.id, enabled: true }),
    });
    const resumedRes = await fetch(`${base}/api/status`, { headers: { 'x-api-key': createdKey.key } });
    assert.strictEqual(resumedRes.status, 200, 'La clé réactivée doit de nouveau répondre 200');

    // 6d. Contrôle des scopes : lecture seule refusée sur POST /api/trailers/submit (403)
    const deniedSubmit = await fetch(`${base}/api/trailers/submit`, {
      method: 'POST',
      headers: { 'x-api-key': createdKey.key, 'content-type': 'application/json' },
      body: JSON.stringify({ imdb: 'tt8800991', title: 'Saison 4 VF', url: `http://127.0.0.1:${upPort}/ok.mp4` }),
    });
    assert.strictEqual(deniedSubmit.status, 403);

    // Ajout du scope trailers:write + rotation du secret
    await fetch(`${base}/admin/api/keys/update`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ id: createdKey.id, scopes: 'trailers:read,catalog:read,trailers:write', rateLimit: 0 }),
    });
    const rotRes = await fetch(`${base}/admin/api/keys/rotate`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ id: createdKey.id }),
    }).then((r) => r.json());
    assert.strictEqual(rotRes.ok, true);
    assert.notStrictEqual(rotRes.key, createdKey.key);

    // L'ancienne clé doit être rejetée (401), la nouvelle acceptée avec quota illimité ('unlimited')
    const oldKeyRes = await fetch(`${base}/api/status`, { headers: { 'x-api-key': createdKey.key } });
    assert.strictEqual(oldKeyRes.status, 401);
    const rotatedHeaders = { 'x-api-key': rotRes.key, 'content-type': 'application/json' };
    const unlimRes = await fetch(`${base}/api/status`, { headers: rotatedHeaders });
    assert.strictEqual(unlimRes.status, 200);
    assert.strictEqual(unlimRes.headers.get('x-ratelimit-limit'), 'unlimited');

    // Soumission de bande-annonce autorisée avec trailers:write
    const okSubmit = await fetch(`${base}/api/v1/trailers/submit`, {
      method: 'POST',
      headers: rotatedHeaders,
      body: JSON.stringify({ imdb: 'tt8800991', title: 'Saison 4 — Bande-annonce VF', url: `http://127.0.0.1:${upPort}/ok.mp4` }),
    });
    assert.strictEqual(okSubmit.status, 200);
    const submitJson = await okSubmit.json();
    assert.strictEqual(submitJson.ok, true);
    assert.ok(submitJson.relayUrl.includes('/media/'));

    // 6e. Mode fast=1 + filtre source=manual + seasonsAvailable sur /api/v1/trailers
    const fastRes = await fetch(`${base}/api/v1/trailers?imdb=tt8800991&fast=1&source=manual`, { headers: rotatedHeaders });
    assert.strictEqual(fastRes.status, 200);
    assert.ok(fastRes.headers.get('x-response-time'));
    assert.strictEqual(fastRes.headers.get('x-trailer-count'), '2');
    const fastJson = await fastRes.json();
    assert.deepStrictEqual(fastJson.seasonsAvailable, [2, 3, 4]);
    assert.ok(fastJson.trailers.every((t) => t.source === 'manual'));

    // 6f. Batch lookup (/api/v1/trailers/batch), prewarm (/api/v1/prewarm), recherche (/api/v1/search) et fiche (/api/v1/title/:id)
    const batchRes = await fetch(`${base}/api/v1/trailers/batch`, {
      method: 'POST',
      headers: rotatedHeaders,
      body: JSON.stringify({
        items: [
          { imdb: 'tt8800991', type: 'series', season: 4, strict_season: 1 },
          { imdb: 'tt0000000', type: 'movie' },
        ],
      }),
    }).then((r) => r.json());
    assert.strictEqual(batchRes.ok, true);
    assert.strictEqual(batchRes.count, 2);
    assert.strictEqual(batchRes.foundCount, 1);
    assert.strictEqual(batchRes.results[0].trailers[0].season, 4);

    const prewarmRes = await fetch(`${base}/api/v1/prewarm`, {
      method: 'POST',
      headers: rotatedHeaders,
      body: JSON.stringify({ items: [{ imdb: 'tt8800991', type: 'series' }, { imdb: 'tt0009999', type: 'movie' }] }),
    });
    assert.strictEqual(prewarmRes.status, 202);
    const prewarmJson = await prewarmRes.json();
    assert.strictEqual(prewarmJson.alreadyReady, 1);
    assert.strictEqual(prewarmJson.queued, 1);

    const apiSearch = await fetch(`${base}/api/v1/search?q=Relais&type=series`, { headers: rotatedHeaders }).then((r) => r.json());
    assert.strictEqual(apiSearch.ok, true);
    assert.ok(apiSearch.results.some((r) => r.imdb_id === 'tt8800991'));

    const apiTitle = await fetch(`${base}/api/v1/title/tt8800991`, { headers: rotatedHeaders }).then((r) => r.json());
    assert.strictEqual(apiTitle.ok, true);
    assert.strictEqual(apiTitle.title.id, 'nflx:880099');
    assert.deepStrictEqual(apiTitle.seasonsAvailable, [2, 3, 4]);

    // 6f-bis. API Universelle v3.3.0 : route /api/v1/trailers/:id avec ID composite Stremio (tt...:2:1) + ?apikey=
    const univComposite = await fetch(
      `${base}/api/v1/trailers/${encodeURIComponent('tt8800991:2:1')}?strict_season=1&apikey=${encodeURIComponent(rotRes.key)}`
    ).then((r) => r.json());
    assert.strictEqual(univComposite.found, true, 'L’endpoint universel /api/v1/trailers/:id doit accepter tt...:s:e et ?apikey=');
    assert.strictEqual(univComposite.trailers.length, 1);
    assert.strictEqual(univComposite.trailers[0].season, 2);

    // Recherche universelle directe par titre + année + en-tête Api-Key
    const univByTitle = await fetch(
      `${base}/api/v1/trailers?title=${encodeURIComponent('Test Relais')}&year=2025`,
      { headers: { 'Api-Key': rotRes.key } }
    ).then((r) => r.json());
    assert.strictEqual(univByTitle.found, true, 'La recherche universelle par ?title=...&year=... doit trouver la fiche locale');
    assert.strictEqual(univByTitle.title.id, 'nflx:880099');

    // Capacité multi-instances portée à 50 clés
    const keysInfo = await fetch(`${base}/admin/api/keys`, { headers: adminHeaders }).then((r) => r.json());
    assert.ok(keysInfo.max >= 50, 'La capacité multi-instances doit permettre au moins 50 clés indépendantes');

    // 6g. Télémétrie live /admin/api/metrics + Sauvegarde à chaud SQLite + Maintenance WAL
    const metricsJson = await fetch(`${base}/admin/api/metrics`, { headers: adminHeaders }).then((r) => r.json());
    assert.ok(metricsJson.totalCalls >= 9);
    assert.ok(metricsJson.trailersHits >= 5);
    assert.ok(Array.isArray(metricsJson.recentCalls) && metricsJson.recentCalls.length >= 5);

    const optDbRes = await fetch(`${base}/admin/api/db/optimize`, { method: 'POST', headers: adminHeaders, body: '{}' }).then((r) => r.json());
    assert.strictEqual(optDbRes.ok, true);
    assert.ok(typeof optDbRes.bytesAfter === 'number' && optDbRes.bytesAfter > 0);

    const backupRes = await fetch(`${base}/admin/api/backup.db`, { headers: adminHeaders });
    assert.strictEqual(backupRes.status, 200);
    const backupBuf = Buffer.from(await backupRes.arrayBuffer());
    assert.strictEqual(backupBuf.subarray(0, 15).toString('utf8'), 'SQLite format 3', 'La sauvegarde téléchargée doit être un fichier SQLite valide');

    // /admin/api/hls/clear
    const clearRes = await fetch(`${base}/admin/api/hls/clear`, { method: 'POST', headers: adminHeaders, body: '{}' });
    assert.strictEqual(clearRes.status, 200);
    const clearJson = await clearRes.json();
    assert.strictEqual(clearJson.ok, true);
  } finally {
    appletv.ensure = origAppleEnsure;
    await new Promise((r) => srv.close(r));
    await new Promise((r) => upstreamSrv.close(r));
    store.db.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

testHlsAndHttp().then(() => {
  console.log('audit-and-dashboard OK : SSRF IPv6, fusion SQLite, HLS, API universelle v3.3.0, /api/docs, sonde de flux MP4, sauvegarde SQLite et dashboard vérifiés');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});

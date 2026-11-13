// Test hors-ligne : parseur (structure réelle d'une page Netflix), SQL et handlers Stremio. Aucun appel réseau.
process.env.DB_PATH = require('path').join(require('os').tmpdir(), `nflx-smoke-${Date.now()}.db`);
process.env.ADMIN_TOKEN = 'test-token';
const assert = require('assert');
const { parseNetflixHtml } = require('../src/netflix');
const store = require('../src/db');
const { withReleased, mergeEpisodes } = require('../src/enrich');
const { builder } = require('../src/addon');

const ep = (n, title, syn, sec, id) => ({ node: { __typename: 'Episode', videoId: id, number: n, runtimeSec: sec, shortSynopsis: syn, title,
  merchStill300: { url: `https://img.nflx/ep${n}.webp?r=9ef` } } });
const detail = { __typename: 'Show', title: 'Trouble échange', videoId: 81944880, latestYear: 2026,
  shortSynopsis: 'Un échange de maisons de rêve entre la Sicile et Stockholm tourne mal.', availabilityStartTime: '2026-10-30T07:00:00.000Z',
  contentAdvisory: { certificationValue: '16+' },
  primaryGenres: { edges: [{ node: { name: 'Drame' } }] },
  genres: { edges: [{ node: { title: 'Séries dramatiques' } }] },
  actors: { edges: ['Emma Appleton', 'Fares Fares', 'Frida Gustavsson'].map((name) => ({ node: { name } })) },
  directors: { edges: [{ node: { name: 'Kasper Barfoed' } }] }, creators: { edges: [] },
  tags: [{ displayName: 'Psychologique', isDisplayable: true }],
  logoStackCropped350: { url: 'https://img.nflx/logo.webp' }, eclipseBillboardRedux1920: { url: 'https://img.nflx/bg.webp' },
  trailers: { edges: [{ node: { title: 'Mini-série (Bande-annonce) : Trouble échange', runtimeSec: 100, videoId: 1,
    artwork: { url: 'https://img.nflx/t.jpg' }, playableVideo: { url: `https://v.nflx/t.mp4?v=1&e=${Math.floor(Date.now() / 1000) + 3600}&t=x` } } }] },
  seasons: { edges: [{ node: { title: 'Mini-série', episodes: { edges: [
    ep(1, 'Épisode\u00A01', 'Deux couples échangent leurs maisons.', 2768, 1), ep(2, 'Épisode\u00A02', 'Une découverte choquante.', 2309, 2),
    ep(3, 'Épisode\u00A03', 'Un secret éclate.', 2850, 3), ep(4, 'Épisode\u00A04', 'Une vérité meurtrière.', 2880, 4)] } } }] } };
const similar = { __typename: 'Show', videoId: 80994082, title: 'Lupin' };   // ne doit pas être pris pour le titre
const ctx = { models: { graphqlClcs: { data: { q: { clcsHookV2: { result: { screen: { componentTree: { nodes: [{ data: {
  trifectaRows: { collections: [{ videos: [similar] }] }, videos: [detail] } }] } } } } } } } } };
// Imite l'échappement de Netflix : \xNN pour / ' espace, \uXXXX pour les accents
const js = JSON.stringify(ctx).replace(/\//g, '\\x2F').replace(/'/g, '\\x27').replace(/ /g, '\\x20')
  .replace(/[^\x00-\x7F]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase());
const ld = { '@type': 'TVSeries', name: 'Trouble échange', genre: 'Thrillers', dateCreated: '2026-10-30' };
const html = `<html><head><meta property="og:url" content="https://www.netflix.com/fr/title/81944880"/>
<meta property="og:image" content="https://img.nflx/og.webp"/><script type="application/ld+json">${JSON.stringify(ld)}</script></head>
<body><script>window.netflix = window.netflix || {};
        netflix.reactContext = ${js};</script><script>netflix.reactContext.models.graphql = JSON.parse('{"data":{}}');</script></body></html>`;

const p = parseNetflixHtml(html);
assert.deepEqual(p.warnings, []);
assert.equal(p.name, 'Trouble échange'); assert.equal(p.type, 'series'); assert.equal(p.year, 2026);
assert.equal(p.certification, '16+'); assert.deepEqual(p.genres, ['Drame']);       // pas "Thrillers" (JSON-LD)
assert.equal(p.cast.length, 3); assert.deepEqual(p.directors, ['Kasper Barfoed']);
assert.equal(p.episodes.length, 4); assert.equal(p.episodes[0].name, 'Épisode 1'); assert.equal(p.episodes[0].runtime, 46);
assert.ok(p.episodes[1].image.startsWith('https://img.nflx/ep2')); assert.equal(p.logo, 'https://img.nflx/logo.webp');
assert.equal(p.trailers.length, 1); assert.equal(p.releaseDate, '2026-10-30');

// Fusion TMDB : saisons incompatibles => Netflix seul ; compatibles => dates TMDB
const tm = [{ season: 1, episode: 1, released: '2021-01-08' }, { season: 1, episode: 2, released: '2021-01-08' }];
assert.equal(mergeEpisodes(p.episodes, tm).length, 4); assert.equal(mergeEpisodes(p.episodes, tm)[0].released, null);
const tm4 = p.episodes.map((e) => ({ ...e, released: '2026-10-30', synopsis: 'tmdb' }));
assert.equal(mergeEpisodes(p.episodes, tm4)[0].released, '2026-10-30'); assert.equal(mergeEpisodes(p.episodes, tm4)[0].synopsis, p.episodes[0].synopsis);

store.upsertTitle({ id: 'nflx:81944880', netflix_id: '81944880', type: p.type, name: p.name, year: p.year, release_date: p.releaseDate,
  certification: p.certification, genres: p.genres, synopsis: p.synopsis, cast: p.cast, poster: p.image, background: p.background, logo: p.logo,
  trailer_yt: 'dQw4w9WgXcQ', trailers: p.trailers, extra: { directors: p.directors, posterShape: 'landscape' }, enriched: 1 });
store.replaceEpisodes('nflx:81944880', withReleased(p.episodes, p.releaseDate));

(async () => {
  const iface = builder.getInterface();
  const cat = await iface.get('catalog', 'series', 'netflix-series', {});
  assert.equal(cat.metas[0].id, 'nflx:81944880');
  assert.equal((await iface.get('catalog', 'series', 'netflix-series', { genre: 'Drame' })).metas.length, 1);
  assert.equal((await iface.get('catalog', 'series', 'netflix-series', { search: 'zzz' })).metas.length, 0);

  // Catalogues « dernières sorties » : fenêtre récente + tri par date de sortie décroissante
  const today = new Date().toISOString().slice(0, 10);
  store.upsertTitle({ id: 'nflx:new-mv', type: 'movie', name: 'Film tout neuf', year: +today.slice(0, 4), release_date: today });
  store.upsertTitle({ id: 'nflx:new-tv', type: 'series', name: 'Série toute neuve', year: +today.slice(0, 4), release_date: today });
  store.upsertTitle({ id: 'nflx:old-mv', type: 'movie', name: 'Film ancien', year: 2019, release_date: '2019-05-01' });
  const newMv = await iface.get('catalog', 'movie', 'netflix-new-movies', {});
  assert.equal(newMv.metas[0].id, 'nflx:new-mv');
  assert.ok(!newMv.metas.some((m) => m.id === 'nflx:old-mv'));        // hors fenêtre RECENT_DAYS
  const newTv = await iface.get('catalog', 'series', 'netflix-new-series', {});
  assert.ok(newTv.metas.some((m) => m.id === 'nflx:new-tv'));         // visible dans le catalogue nouveautés
  assert.equal((await iface.get('catalog', 'series', 'netflix-new-series', { genre: 'zzz' })).metas.length, 0);
  const { meta } = await iface.get('meta', 'series', 'nflx:81944880');
  assert.equal(meta.videos.length, 4); assert.equal(meta.videos[0].id, 'nflx:81944880:1:1');
  assert.ok(new Date(meta.videos[3].released) < new Date());                         // pas d'épisode "dans le futur"
  assert.ok(/\/trailer\/81944880\/0\.mp4$/.test(meta.trailerStreams[0].url));   // bande-annonce Netflix d'abord (relayée)
  assert.equal(meta.trailerStreams.length, 1); assert.equal(meta.trailers, undefined); // pas de YouTube quand Netflix est dispo
  assert.equal(meta.posterShape, 'landscape'); assert.deepEqual(meta.director, ['Kasper Barfoed']);
  // Relais vidéo : faux serveur Netflix avec support des Range
  const http = require('http');
  const BODY = Buffer.from('0123456789abcdef');
  const upstream = http.createServer((rq, rs) => {
    const m = /bytes=(\d+)-(\d*)/.exec(rq.headers.range || '');
    if (!m) { rs.writeHead(200, { 'content-type': 'video/mp4', 'content-length': BODY.length, 'accept-ranges': 'bytes' }); return rs.end(BODY); }
    const a = +m[1], b = m[2] ? +m[2] : BODY.length - 1;
    rs.writeHead(206, { 'content-type': 'video/mp4', 'content-range': `bytes ${a}-${b}/${BODY.length}`, 'content-length': b - a + 1 });
    rs.end(BODY.subarray(a, b + 1));
  }).listen(0);
  await new Promise((r) => upstream.once('listening', r));
  store.upsertTitle({ id: 'nflx:81944880', type: 'series', name: 'Trouble échange',
    trailers: [{ title: 'ba', url: `http://127.0.0.1:${upstream.address().port}/v.mp4`, expires: Date.now() + 3600000 }] });
  const app = require('../src/app').listen(0);
  await new Promise((r) => app.once('listening', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const full = await fetch(`${base}/trailer/81944880/0.mp4`);
  assert.equal(full.status, 200); assert.equal(Buffer.from(await full.arrayBuffer()).toString(), '0123456789abcdef');
  const part = await fetch(`${base}/trailer/81944880/0.mp4`, { headers: { range: 'bytes=2-5' } });
  assert.equal(part.status, 206); assert.equal(Buffer.from(await part.arrayBuffer()).toString(), '2345');
  assert.equal((await fetch(`${base}/trailer/81944880/9.mp4`)).status, 404);

  // Dashboard admin : page HTML + API protégées par ADMIN_TOKEN
  const page = await fetch(`${base}/admin`);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('Netflix Catalogue'));
  assert.equal((await fetch(`${base}/admin/api/summary`)).status, 401);
  assert.equal((await fetch(`${base}/admin/api/summary`, { headers: { 'x-admin-token': 'mauvais' } })).status, 401);
  const summary = await (await fetch(`${base}/admin/api/summary`, { headers: { 'x-admin-token': 'test-token' } })).json();
  assert.ok(summary.stats.total >= 1); assert.ok(summary.stats.movies >= 1);
  assert.equal(summary.stats.recent.days > 0, true);
  assert.ok(summary.config.some((g) => g.title === 'Sécurité'));
  assert.ok(summary.config.flatMap((g) => g.items).find((i) => i.env === 'ADMIN_TOKEN').secret); // jamais en clair

  app.close(); upstream.close();
  console.log('OK — parseur (structure réelle), fusion, SQL et handlers Stremio');
})().catch((e) => { console.error(e); process.exitCode = 1; });

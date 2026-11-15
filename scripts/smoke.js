// Test hors-ligne : parseur (structure réelle d'une page Netflix), SQL et handlers Stremio. Aucun appel réseau.
process.env.DB_PATH = require('path').join(require('os').tmpdir(), `nflx-smoke-${Date.now()}.db`);
process.env.ADMIN_TOKEN = 'test-token';
process.env.APPLETV_ENABLED = '0';   // test hors-ligne : pas de recherche Apple TV automatique
process.env.API_KEY = 'test-api-key';
const assert = require('assert');
const { parseNetflixHtml } = require('../src/netflix');
const store = require('../src/db');
const { withReleased, mergeEpisodes } = require('../src/enrich');
const { builder } = require('../src/addon');
const jw = require('../src/justwatch');

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

// Prime Video : structure réelle (JSON embarqué dv-web-page-hydration-data), saison 1 de « Sterling Point »
{
  const { parsePrimeHtml, parsePrimeId, frDateToIso } = require('../src/primevideo');
  const G = 'amzn1.dv.gti.561b790f-28c4-45b6-b350-647cc0f9440a';
  const E1 = 'amzn1.dv.gti.c93c6f76-4d62-4965-95f7-887e061c13a8', E2 = 'amzn1.dv.gti.336b223f-d1ec-4cb3-b70f-74d988392cf6';
  const epd = (n, title, dur) => ({ title, synopsis: 'Synopsis ' + n, episodeNumber: n, duration: dur, titleType: 'episode', releaseDate: '5 août 2026',
    images: { covershot: 'https://img.prime/ep' + n + '.jpg' } });
  const hyd = { init: { preparations: { body: {
    atf: { state: { pageTitleId: G,
      detail: { headerDetail: { [G]: { title: 'Sterling Point - S1', parentTitle: 'Sterling Point', seasonNumber: 1, titleType: 'season', entityType: 'TV Show',
        synopsis: 'Annie Jacobson, 17 ans, hérite d\u2019une île.', releaseYear: 2026, releaseDate: '5 août 2026', ratingBadge: { displayText: '16+' },
        genres: [{ text: 'Drame' }, { text: 'Romance' }], studios: ['Amazon Studios'], isHdr: true, isUhd: true, isPrime: true,
        contributors: { cast: [{ name: 'Ella Rubin' }, { name: 'Amélie Hoeferle' }], directors: [{ name: 'Megan Park' }], producers: [{ name: 'Josh Schwartz' }] },
        images: { packshot: 'https://img.prime/pack.jpg', heroshot: 'https://img.prime/hero.jpg', titleLogo: 'https://img.prime/logo.png' },
        audioTracks: ['Français (France)', 'English'], subtitles: ['Français (France)'] } } },
      metadata: { [G]: { moods: ['Réconfortant'] } },
      action: { atf: { [G]: { secondaryActions: [{ payload: { playback: { isTrailer: true, playbackID: 'amzn1.dv.gti.f08c707b', playbackEnvelope: 'ENV',
        expiryTime: 1794933326863, playbackURL: '/-/fr/detail/0TEACR92ZF4DLOOKOZN4EMAU1T?autoplay=trailer' } } }] } } } } },
    btf: { state: { detail: { detail: { [E2]: epd(2, '2. Elle a l\u2019air célib et bi', 2660), [E1]: epd(1, '1. Mais je viens de prendre un somnifère', 3084), [G]: { titleType: 'season' } } },
      episodeList: { cardTitleIds: [E1, E2] }, self: { [E1]: { sequenceNumber: 1, compactGTI: '0R2I1RKZFG6WWC5CH1D03XMOQ0' } } } } } } } };
  const ph = '<html><head><title>Prime Video: Sterling Point - S1</title><link rel="canonical" href="https://www.primevideo.com/-/fr/detail/0K94N2UBORZCLPIC46VTJQ093E"/></head><body>'
    + '<script id="dv-web-page-hydration-data" type="application/json">' + JSON.stringify(hyd) + '</script></body></html>';
  const pv = parsePrimeHtml(ph);
  assert.deepEqual(pv.warnings, []);
  assert.equal(parsePrimeId('https://www.primevideo.com/-/fr/detail/0K94N2UBORZCLPIC46VTJQ093E?ref_=x'), '0K94N2UBORZCLPIC46VTJQ093E');
  assert.equal(pv.primeId, '0K94N2UBORZCLPIC46VTJQ093E'); assert.equal(pv.name, 'Sterling Point'); assert.equal(pv.type, 'series');
  assert.equal(pv.seasonNumber, 1); assert.equal(pv.year, 2026); assert.equal(pv.releaseDate, '2026-08-05'); assert.equal(pv.certification, '16+');
  assert.deepEqual(pv.genres, ['Drame', 'Romance']); assert.deepEqual(pv.cast, ['Ella Rubin', 'Amélie Hoeferle']); assert.deepEqual(pv.directors, ['Megan Park']);
  assert.deepEqual(pv.moods, ['Réconfortant']); assert.equal(pv.episodes.length, 2);
  assert.equal(pv.episodes[0].name, 'Mais je viens de prendre un somnifère'); assert.equal(pv.episodes[0].runtime, 51); assert.equal(pv.episodes[0].released, '2026-08-05');
  assert.equal(pv.episodes[1].episode, 2); assert.equal(pv.primeTrailer.playbackId, 'amzn1.dv.gti.f08c707b');
  assert.equal(pv.primeTrailer.page, 'https://www.primevideo.com/-/fr/detail/0TEACR92ZF4DLOOKOZN4EMAU1T?autoplay=trailer');
  assert.equal(frDateToIso('1er février 2026'), '2026-02-01');
  // Secours DOM : sans JSON embarqué, le titre et le synopsis restent lisibles
  const pd = parsePrimeHtml('<html><head><title>Prime Video: Sterling Point - S1</title><meta name="description" content="Synopsis"/></head><body></body></html>');
  assert.equal(pd.name, 'Sterling Point'); assert.equal(pd.seasonNumber, 1); assert.ok(pd.warnings.length);
}

// Fusion TMDB : saisons incompatibles => Netflix seul ; compatibles => dates TMDB
const tm = [{ season: 1, episode: 1, released: '2021-01-08' }, { season: 1, episode: 2, released: '2021-01-08' }];
assert.equal(mergeEpisodes(p.episodes, tm).length, 4); assert.equal(mergeEpisodes(p.episodes, tm)[0].released, null);
const tm4 = p.episodes.map((e) => ({ ...e, released: '2026-10-30', synopsis: 'tmdb' }));
assert.equal(mergeEpisodes(p.episodes, tm4)[0].released, '2026-10-30'); assert.equal(mergeEpisodes(p.episodes, tm4)[0].synopsis, p.episodes[0].synopsis);

// Association JustWatch : titre exact ou originalTitle, année + type, offre Netflix obligatoire
const cand = (o) => ({ netflixId: o.id, title: o.title, originalTitle: o.originalTitle || null,
  year: o.year, type: o.type, objectType: o.type === 'movie' ? 'MOVIE' : 'SHOW' });
assert.equal(jw.netflixIdOf('https://www.netflix.com/title/81707977'), '81707977');
assert.equal(jw.pickBest([cand({ id: '81707977', title: 'ChiaroScuro', year: 2026, type: 'series' })],
  { name: 'ChiaroScuro', year: 2026, type: 'series' }).netflixId, '81707977');
assert.equal(jw.pickBest([cand({ id: '80991090', title: 'La Demoiselle et le Dragon', originalTitle: 'Damsel', year: 2024, type: 'movie' })],
  { name: 'Damsel', year: 2024, type: 'movie' }).netflixId, '80991090');           // originalTitle
assert.equal(jw.pickBest([cand({ id: '1', title: 'ChiaroScuro', year: 2026, type: 'series' })],
  { name: 'ChiaroScuro', year: 2026, type: 'movie' }), null);                       // type incompatible
assert.equal(jw.pickBest([cand({ id: '1', title: 'ChiaroScuro', year: 2020, type: 'series' })],
  { name: 'ChiaroScuro', year: 2026, type: 'series' }), null);                      // mauvaise année
assert.equal(jw.pickBest([cand({ id: '1', title: 'The Gentlemen', year: 2024, type: 'series' }),
  cand({ id: '2', title: 'The Gentlemen', year: 2024, type: 'series' })],
  { name: 'The Gentlemen', year: 2024, type: 'series' }), null);                    // ambiguïté
assert.equal(jw.pickBest([cand({ id: '1', title: 'Autre titre', year: 2026, type: 'series' })],
  { name: 'ChiaroScuro', year: 2026, type: 'series' }), null);                      // titre différent

store.upsertTitle({ id: 'nflx:81944880', netflix_id: '81944880', type: p.type, name: p.name, year: p.year, release_date: p.releaseDate,
  certification: p.certification, genres: p.genres, synopsis: p.synopsis, cast: p.cast, poster: p.image, background: p.background, logo: p.logo,
  trailer_yt: 'dQw4w9WgXcQ', trailers: p.trailers, extra: { directors: p.directors, posterShape: 'landscape' }, enriched: 1 });
store.replaceEpisodes('nflx:81944880', withReleased(p.episodes, p.releaseDate));

(async () => {
  const iface = builder.getInterface();
  // Plus de catalogue : manifest sans catalogue, flux sur les IDs IMDb (tt…) et sur les anciennes fiches nflx:, meta seulement nflx:
  assert.deepEqual(iface.manifest.catalogs, []);
  assert.ok(!iface.manifest.resources.some((r) => r.name === 'catalog'));
  assert.deepEqual(iface.manifest.resources.find((r) => r.name === 'stream').idPrefixes, ['nflx:', 'tt']);
  const { meta } = await iface.get('meta', 'series', 'nflx:81944880');
  assert.equal(meta.videos.length, 4); assert.equal(meta.videos[0].id, 'nflx:81944880:1:1');
  assert.ok(new Date(meta.videos[3].released) < new Date());                         // pas d'épisode "dans le futur"
  assert.ok(/\/trailer\/81944880\/0\.mp4$/.test(meta.trailerStreams[0].url));   // bande-annonce Netflix d'abord (relayée)
  assert.equal(meta.trailerStreams.length, 1); assert.equal(meta.trailers, undefined); // pas de YouTube quand Netflix est dispo
  assert.equal(meta.posterShape, 'landscape'); assert.deepEqual(meta.director, ['Kasper Barfoed']);
  // Flux : la bande-annonce Netflix est proposée dans le panneau « flux » (fiche et épisodes)
  assert.ok(iface.manifest.resources.some((r) => r.name === 'stream'));
  const sEp = await iface.get('stream', 'series', 'nflx:81944880:1:1');
  assert.equal(sEp.streams.length, 1); assert.ok(/\/trailer\/81944880\/0\.mp4$/.test(sEp.streams[0].url));
  assert.deepEqual((await iface.get('stream', 'series', 'nflx:inconnu:1:1')).streams, []);
  assert.equal(store.listVfPending().some((r) => r.id === 'nflx:81944880'), true);   // jamais vérifié
  store.upsertTitle({ id: 'nflx:81944880', type: 'series', name: 'Trouble échange', vf_checked: Date.now() });
  assert.equal(store.listVfPending().some((r) => r.id === 'nflx:81944880'), false);
  assert.ok(!(await iface.get('stream', 'series', 'nflx:81944880:1:1')).streams.some((x) => x.ytId));   // plus aucun flux YouTube
  // Flux via l'ID IMDb : n'importe quelle fiche Stremio (film, série, épisode) dont l'IMDb est stocké
  store.upsertTitle({ id: 'nflx:81944880', type: 'series', name: 'Trouble échange', imdb_id: 'tt9999999' });
  const streamsImdb = (await iface.get('stream', 'series', 'tt9999999:1:2')).streams;
  assert.equal(streamsImdb.length, 1); assert.ok(/\/trailer\/81944880\/0\.mp4$/.test(streamsImdb[0].url));
  assert.deepEqual((await iface.get('stream', 'movie', 'tt0000001')).streams, []);   // IMDb inconnu
  assert.deepEqual((await iface.get('stream', 'movie', 'kitsu:1')).streams, []);       // ID non géré
  // Apple TV : flux HLS stockés, exposés via le relais /apple/<id>/<n>.mp4 (converti en MP4)
  store.upsertTitle({ id: 'nflx:81944880', type: 'series', name: 'Trouble échange', appletv: [{ title: 'Bande-annonce', url: 'https://apple.test/a.m3u8', source: 'appletv', ver: 2 }], appletv_checked: Date.now() });
  const appleUrl = `${require('../src/config').publicUrl}/apple/${encodeURIComponent('nflx:81944880')}/0.mp4`;
  const withApple = (await iface.get('stream', 'series', 'tt9999999')).streams;
  assert.equal(withApple.length, 2); assert.equal(withApple[1].name, 'Apple TV'); assert.equal(withApple[1].url, appleUrl);
  assert.equal(withApple[1].behaviorHints.notWebReady, false);
  assert.equal((await iface.get('meta', 'series', 'nflx:81944880')).meta.trailerStreams.at(-1).url, appleUrl);
  assert.equal(store.listAppletvPending().some((r) => r.id === 'nflx:81944880'), false);
  const ddg = require('../src/search').parse(`<div class="result"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.netflix.com%2Ffr%2Ftitle%2F81944880&amp;rut=x">Watch Trouble échange | Netflix Official Site</a></h2><a class="result__snippet" href="x">Un échange de maisons &amp; <b>plus</b></a></div>
    <div class="result"><a rel="nofollow" class="result__a" href="https://www.netflix.com/title/81727408">Autre &#x27;série&#x27;</a></div>
    <div class="result"><a rel="nofollow" class="result__a" href="https://www.netflix.com/fr/title/81944880">Doublon</a></div>`);
  assert.deepEqual(ddg.map((r) => r.id), ['81944880', '81727408']);                      // dédoublonné
  assert.equal(ddg[0].title, 'Trouble échange'); assert.equal(ddg[0].snippet, 'Un échange de maisons & plus'); assert.equal(ddg[1].title, "Autre 'série'");
  assert.deepEqual(require('../src/search').parse('x netflix.com%2Ftitle%2F123 y').map((r) => r.id), ['123']);   // repli : IDs seuls
  assert.equal(store.findByName('TROUBLE ÉCHANGE'.toLowerCase().replace('é', 'é'), 'series')?.id, 'nflx:81944880');   // insensible à la casse
  // Résolution à la demande : TMDB → recherche web → page Netflix, avec réseau simulé (et cache)
  const cfgR = require('../src/config'); const tmdbMod = require('../src/tmdb'); const searchMod = require('../src/search'); const nfMod = require('../src/netflix');
  const rcalls = { tmdb: 0, ddg: 0, page: 0 };
  Object.assign(tmdbMod, {
    findByImdb: async (imdb) => { rcalls.tmdb++; return imdb === 'tt5550001' ? { tmdbType: 'tv', tmdbId: 5, type: 'series', name: 'Trouble échange', originalName: 'Utbyte', year: 2026, release_date: '2026-10-30' } : null; },
    basics: async () => ({ genres: [] }), searchMatch: async () => null });
  searchMod.netflix = async () => { rcalls.ddg++; return [{ id: '70000001', title: 'Autre série', snippet: '' }, { id: '81944999', title: 'Trouble échange', snippet: '' }]; };
  nfMod.fetchNetflixPage = async (nid) => { rcalls.page++; return html; };
  const oldTmdbKey = cfgR.tmdbKey; cfgR.tmdbKey = 'test';
  const resolved1 = (await iface.get('stream', 'series', 'tt5550001:1:1')).streams;
  assert.ok(resolved1.some((x) => /\/trailer\/81944999\/0\.mp4$/.test(x.url)));     // Netflix trouvé
  assert.equal(rcalls.page, 1);                                                      // 'Autre série' écartée sans lire sa page
  assert.equal(store.findByImdbId('tt5550001').id, 'nflx:81944999');
  await iface.get('stream', 'series', 'tt5550001:1:2');
  assert.deepEqual(rcalls, { tmdb: 1, ddg: 1, page: 1 });                            // 2e ouverture : aucune requête
  assert.deepEqual((await iface.get('stream', 'movie', 'tt5550002')).streams, []);  // inconnu de TMDB
  await iface.get('stream', 'movie', 'tt5550002'); assert.equal(rcalls.tmdb, 2);     // l'échec est mis en cache
  assert.equal(store.stats().lookups, 2); assert.equal(store.stats().lookupsFound, 1);
  searchMod.netflix = async () => [{ id: '81944998', title: 'Trouble échange' }];   // même nom, année trop ancienne → refusé
  tmdbMod.findByImdb = async () => ({ tmdbType: 'tv', tmdbId: 6, type: 'series', name: 'Trouble échange', year: 2030 });
  assert.equal((await require('../src/resolve').findNetflix({ name: 'Trouble échange', type: 'series', year: 2030 })).nid, null);
  cfgR.tmdbKey = oldTmdbKey;
  const ap = require('../src/appletv');
  // La playlist HLS d'Apple n'est pas chiffrée (les clés FairPlay ne concernent que l'app) : la vraie bande-annonce est gardée.
  assert.equal(ap.extractTrailers({ a: [{ type: 'Trailer', hlsUrl: 'https://x/e.m3u8', fpsNonceServerUrl: 'https://k' }] })[0].url, 'https://x/e.m3u8');
  assert.deepEqual(ap.extractTrailers({ a: [{ type: 'Episode', hlsUrl: 'https://x/ep.m3u8' }] }), []);   // flux d'épisode : ignoré
  assert.equal(ap.extractTrailers({ a: [{ type: 'Trailer', hlsUrl: 'https://x/t.m3u8?a=1&amp;id=5' }] })[0].url, 'https://x/t.m3u8?a=1&id=5');
  const hv = require('../src/harvest');
  assert.deepEqual(hv.countryList('fr, us;gb  CA fr'), ['FR', 'US', 'GB', 'CA']);   // dédoublonné, majuscules
  assert.deepEqual(hv.countryList('xx1,'), ['FR']);                                   // invalide → repli
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
  // Fiche liée dont l'ID Stremio n'est PAS `nflx:<id>` : le relais doit la retrouver par netflix_id.
  store.upsertTitle({ id: 'nflx:mv-777', netflix_id: '77777777', type: 'movie', name: 'Film lié',
    tmdb_id: 777, tmdb_type: 'movie', imdb_id: 'tt7777777',
    trailers: [{ title: 'ba', url: `http://127.0.0.1:${upstream.address().port}/v.mp4`, expires: Date.now() + 3600000 }] });
  assert.equal(store.findByNetflixId('77777777').id, 'nflx:mv-777');
  assert.ok(!store.listUnlinked().some((r) => r.id === 'nflx:mv-777'));
  const app = require('../src/app').listen(0);
  await new Promise((r) => app.once('listening', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const full = await fetch(`${base}/trailer/81944880/0.mp4`);
  assert.equal(full.status, 200); assert.equal(Buffer.from(await full.arrayBuffer()).toString(), '0123456789abcdef');
  const part = await fetch(`${base}/trailer/81944880/0.mp4`, { headers: { range: 'bytes=2-5' } });
  assert.equal(part.status, 206); assert.equal(Buffer.from(await part.arrayBuffer()).toString(), '2345');
  assert.equal((await fetch(`${base}/trailer/81944880/9.mp4`)).status, 404);
  // Même relais, mais la fiche porte un ID Stremio différent (`nflx:mv-777`) : lookup par netflix_id.
  const linked = await fetch(`${base}/trailer/77777777/0.mp4`);
  assert.equal(linked.status, 200); assert.equal(Buffer.from(await linked.arrayBuffer()).toString(), '0123456789abcdef');
  const linkedPart = await fetch(`${base}/trailer/77777777/0.mp4`, { headers: { range: 'bytes=2-5' } });
  assert.equal(linkedPart.status, 206); assert.equal(Buffer.from(await linkedPart.arrayBuffer()).toString(), '2345');

  // Choix du couple vidéo/audio : langue exacte, piste sans audio-description, AAC stéréo.
  // Ici la 720p n'a qu'une piste AC-3 qui décrit l'image : la 480p en AAC français est préférée.
  const hlsMod = require('../src/hls');
  const AUDIO = [
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Français",LANGUAGE="fr-FR",DEFAULT=NO,CHANNELS="2",URI="fr_mp4a-40-2.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",LANGUAGE="en",DEFAULT=YES,CHANNELS="2",URI="en_mp4a-40-2.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="ac3",NAME="Français (audiodescription)",LANGUAGE="fr-FR",DEFAULT=NO,CHANNELS="6",CHARACTERISTICS="public.accessibility.describes-video",URI="fr-ad-ac3.m3u8"',
  ];
  const masterOf = (audio720) => ['#EXTM3U', ...AUDIO,
    `#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=854x480,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aac"`, 'v480.m3u8',
    `#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="${audio720}"`, 'v720.m3u8',
    `#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,CODECS="hvc1.1.6.L120",AUDIO="ac3"`, 'v1080.m3u8',
  ].join('\n');
  const masterUrl = 'https://apple.test/master.m3u8';
  const pick = (audio720) => {
    const text = masterOf(audio720);
    return hlsMod.pickPair(hlsMod.parseVariants(masterUrl, text), masterUrl, text, { maxHeight: 720, maxMB: 60, duration: 120, lang: 'fr-FR' });
  };
  const pair = pick('aac');
  assert.equal(pair.video.height, 720); assert.equal(pair.audio.url, 'https://apple.test/fr_mp4a-40-2.m3u8');
  assert.equal(pair.audio.language, 'fr-FR'); assert.ok(pair.audio.aac && pair.audio.stereo && !pair.audio.description);
  assert.equal(pick('ac3').video.height, 480);                 // pas de son audible en AC-3/AD : on descend en définition
  assert.ok(hlsMod.audioScore(hlsMod.pickAudio(masterUrl, masterOf('ac3'), 'ac3', 'fr-FR'), 'fr-FR') < 60);

  // Relais Apple TV : la playlist HLS est recollée en MP4 (init + segments) puis servie avec Range.
  const hlsSrv = http.createServer((rq, rs) => {
    const p = rq.url.split('?')[0];
    const body = p === '/master.m3u8' ? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.64001f,mp4a.40.2"\nmedia.m3u8\n'
      : p === '/media.m3u8' ? '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\n1.m4s\n#EXTINF:1,\n2.m4s\n'
        : p === '/init.mp4' ? 'INIT' : p === '/1.m4s' ? 'AAA' : p === '/2.m4s' ? 'BBB' : null;
    if (body === null) { rs.writeHead(404); return rs.end(); }
    rs.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': Buffer.byteLength(body) });
    rs.end(body);
  }).listen(0);
  await new Promise((r) => hlsSrv.once('listening', r));
  require('../src/config').hlsCacheDir = require('path').join(require('os').tmpdir(), `nflx-hls-${Date.now()}`);
  store.upsertTitle({ id: 'apple:umc.cmc.test', type: 'movie', name: 'Film Apple',
    appletv: [{ title: 'Bande-annonce', url: `http://127.0.0.1:${hlsSrv.address().port}/master.m3u8`, source: 'appletv', ver: 2 }],
    appletv_checked: Date.now() });
  const appleRelayUrl = `${base}/apple/${encodeURIComponent('apple:umc.cmc.test')}/0.mp4`;
  const built = await fetch(appleRelayUrl);
  assert.equal(built.status, 200); assert.equal(Buffer.from(await built.arrayBuffer()).toString(), 'INITAAABBB');
  const builtPart = await fetch(appleRelayUrl, { headers: { range: 'bytes=0-3' } });
  assert.equal(builtPart.status, 206); assert.equal(Buffer.from(await builtPart.arrayBuffer()).toString(), 'INIT');
  assert.equal((await fetch(`${base}/apple/${encodeURIComponent('apple:umc.cmc.test')}/9.mp4`)).status, 404);
  hlsSrv.close();

  // Doublon d'ID Netflix : la fiche de référence est conservée, l'autre est supprimée.
  store.upsertTitle({ id: 'nflx:77777777', netflix_id: '77777777', type: 'movie', name: 'Doublon' });
  assert.equal(store.deleteNetflixDuplicates('77777777', 'nflx:mv-777'), 1);
  assert.equal(store.getTitle('nflx:77777777'), undefined);
  assert.equal(store.findByNetflixId('77777777').id, 'nflx:mv-777');

  // Dashboard admin : page HTML + API protégées par ADMIN_TOKEN
  const page = await fetch(`${base}/admin`);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('W stockage bande annonce'));
  const root = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(root.status, 302); assert.equal(root.headers.get('location'), '/admin');
  assert.equal((await fetch(`${base}/admin/api/summary`)).status, 401);
  assert.equal((await fetch(`${base}/admin/api/summary`, { headers: { 'x-admin-token': 'mauvais' } })).status, 401);
  const summary = await (await fetch(`${base}/admin/api/summary`, { headers: { 'x-admin-token': 'test-token' } })).json();
  assert.ok(summary.stats.total >= 1); assert.ok(summary.stats.movies >= 1);
  assert.ok(typeof summary.stats.withTrailer === 'number'); assert.ok(summary.stats.withNetflixTrailer >= 1);
  assert.ok(summary.addon && typeof summary.addon.appletv === 'boolean');
  const titles = await (await fetch(`${base}/admin/api/titles?filter=netflix`, { headers: { 'x-admin-token': 'test-token' } })).json();
  assert.ok(titles.total >= 1); assert.ok(titles.rows[0].netflix >= 1);
  assert.equal((await fetch(`${base}/admin/api/appletv`, { headers: { 'x-admin-token': 'test-token' } })).status, 200);
  assert.ok(typeof summary.stats.unlinked === 'number'); assert.ok(typeof summary.stats.withImdb === 'number');
  const items = summary.settings.flatMap((g) => g.items);
  assert.ok(summary.settings.some((g) => g.title === 'Sécurité'));
  const adminItem = items.find((i) => i.key === 'ADMIN_TOKEN');
  assert.ok(adminItem.secret && adminItem.value === '' && adminItem.hint.startsWith('••')); // jamais en clair

  // Paramètres éditables : enregistrement, effet immédiat, validation, retour au .env
  const auth = { 'x-admin-token': 'test-token' };
  const post = (body) => fetch(`${base}/admin/api/settings`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await post({ values: { RECENT_DAYS: 30 } })).status, 200);
  let sum = await (await fetch(`${base}/admin/api/summary`, { headers: auth })).json();
  let item = sum.settings.flatMap((g) => g.items).find((i) => i.key === 'RECENT_DAYS');
  assert.equal(item.value, '30'); assert.equal(item.source, 'dashboard');
  assert.equal(require('../src/config').recentDays, 30);                             // effet immédiat
  assert.equal((await post({ values: { RECENT_DAYS: 'abc' } })).status, 400);         // nombre invalide
  assert.equal((await post({ values: { INCONNU: 'x' } })).status, 400);               // clé inconnue
  assert.equal((await post({ values: { RECENT_DAYS: null } })).status, 200);          // retour au .env
  sum = await (await fetch(`${base}/admin/api/summary`, { headers: auth })).json();
  item = sum.settings.flatMap((g) => g.items).find((i) => i.key === 'RECENT_DAYS');
  assert.equal(item.source, 'default'); assert.equal(require('../src/config').recentDays, 90);
  assert.equal((await post({ values: { ADMIN_TOKEN: null } })).status, 200);          // secours .env présent

  // API de fédération : clé API, lookup IMDb/TMDB, statut
  const apiKey = { 'x-api-key': 'test-api-key' };
  assert.equal((await fetch(`${base}/api/trailers?imdb=tt7777777`)).status, 401);
  assert.equal((await fetch(`${base}/api/trailers?imdb=tt7777777`, { headers: { 'x-api-key': 'mauvaise' } })).status, 401);
  // /api/trailers : titre inconnu → résolution à la demande (c'est ce qu'appelle vf-trailer-wallace)
  cfgR.tmdbKey = 'test';
  tmdbMod.findByImdb = async () => ({ tmdbType: 'tv', tmdbId: 9, type: 'series', name: 'Trouble échange', originalName: 'Utbyte', year: 2026, release_date: '2026-10-30' });
  searchMod.netflix = async () => [{ id: '81944997', title: 'Trouble échange' }];
  const viaApi = await (await fetch(`${base}/api/trailers?imdb=tt5550003&type=series`, { headers: apiKey })).json();
  assert.equal(viaApi.found, true); assert.equal(viaApi.pending, false);
  assert.ok(/\/trailer\/81944997\/0\.mp4$/.test(viaApi.trailers[0].url)); assert.equal(viaApi.title.imdb_id, 'tt5550003');
  cfgR.tmdbKey = oldTmdbKey;
  assert.equal((await fetch(`${base}/api/trailers`)).status, 401);
  const byImdb = await (await fetch(`${base}/api/trailers?imdb=tt7777777`, { headers: apiKey })).json();
  assert.equal(byImdb.found, true); assert.equal(byImdb.title.netflix_id, '77777777');
  assert.ok(/\/trailer\/77777777\/0\.mp4$/.test(byImdb.trailers[0].url));
  const byTmdb = await (await fetch(`${base}/api/trailers?tmdb=777&type=movie`, { headers: apiKey })).json();
  assert.equal(byTmdb.found, true); assert.equal(byTmdb.title.name, 'Film lié');
  const missing = await (await fetch(`${base}/api/trailers?imdb=tt0000000`, { headers: apiKey })).json();
  assert.equal(missing.found, false); assert.deepEqual(missing.trailers, []);
  assert.equal((await fetch(`${base}/api/trailers`, { headers: apiKey })).status, 400);
  const apiStatus = await (await fetch(`${base}/api/status`, { headers: apiKey })).json();
  assert.equal(apiStatus.ok, true); assert.ok(apiStatus.stats.total >= 1);

  // API_KEY vide = API ouverte : une autre instance n'a besoin que de l'URL (aucune clé).
  const cfg = require('../src/config');
  cfg.apiKey = '';
  const openApi = await (await fetch(`${base}/api/trailers?imdb=tt7777777`)).json();
  assert.equal(openApi.found, true); assert.equal(openApi.title.netflix_id, '77777777');
  assert.equal((await fetch(`${base}/api/status`)).status, 200);
  cfg.apiKey = 'test-api-key';

  // Client amont : récupère les trailers d'une autre instance (avec sa clé)
  const federation = require('../src/federation');
  const config = require('../src/config');
  const remoteUpstream = http.createServer((rq, rs) => {
    if (!rq.url.startsWith('/api/trailers') || rq.headers['x-api-key'] !== 'amont-key') {
      rs.writeHead(401); return rs.end();
    }
    rs.writeHead(200, { 'content-type': 'application/json' });
    rs.end(JSON.stringify({ found: true, trailers: [{ title: 'BA amont', url: 'https://amont.example/trailer/9/0.mp4', runtime: 88 }] }));
  }).listen(0);
  remoteUpstream.unref();
  await new Promise((r) => remoteUpstream.once('listening', r));
  config.upstreamUrl = `http://127.0.0.1:${remoteUpstream.address().port}`;
  config.upstreamApiKey = 'amont-key';
  store.upsertTitle({ id: 'nflx:remote', type: 'movie', name: 'Film amont', tmdb_id: 888, tmdb_type: 'movie', imdb_id: 'tt8888888' });
  const remoteRow = await federation.ensureUpstreamTrailers(store.getTitle('nflx:remote'));
  assert.equal(remoteRow.trailers.length, 1);
  assert.equal(remoteRow.trailers[0].source, 'upstream');
  assert.equal(federation.trailerUrls(remoteRow)[0].url, 'https://amont.example/trailer/9/0.mp4');
  const remoteMeta = await iface.get('meta', 'movie', 'nflx:remote');
  assert.equal(remoteMeta.meta.trailerStreams[0].url, 'https://amont.example/trailer/9/0.mp4');
  const remoteStreams = await iface.get('stream', 'movie', 'nflx:remote');
  assert.equal(remoteStreams.streams[0].url, 'https://amont.example/trailer/9/0.mp4');
  remoteUpstream.close();

  // IDs Netflix : statut du liage + export des IDs stockés (nom + TMDB/IMDb)
  const linkStatus = await (await fetch(`${base}/admin/api/netflix-ids`, { headers: auth })).json();
  assert.equal(linkStatus.running, false); assert.equal(typeof linkStatus.total, 'number');
  const exported = await (await fetch(`${base}/admin/api/netflix-ids/export`, { headers: auth })).json();
  const linkedRow = exported.find((r) => r.netflix_id === '77777777');
  assert.ok(linkedRow); assert.equal(linkedRow.name, 'Film lié');

  // Moissonnage du catalogue : statut protégé par le token, aucun job au repos, arrêt sans effet quand rien ne tourne
  assert.equal((await fetch(`${base}/admin/api/harvest`)).status, 401);
  const hStatus = await (await fetch(`${base}/admin/api/harvest`, { headers: auth })).json();
  assert.equal(hStatus.running, false); assert.equal(hStatus.percent, 0); assert.equal(typeof hStatus.seen, 'number');
  assert.equal((await fetch(`${base}/admin/api/vf`)).status, 401);
  const vStatus = await (await fetch(`${base}/admin/api/vf`, { headers: auth })).json();
  assert.equal(vStatus.running, false); assert.equal(typeof vStatus.matched, 'number');
  assert.equal(typeof summary.stats.vfPending, 'number');
  assert.equal((await fetch(`${base}/admin/harvest/stop`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}' })).status, 200);
  const hs = require('../src/harvest').yearSlices({ from: 2025, to: 2026 });
  assert.deepEqual(hs.map((s) => s.minYear), [2026, 2025]);                           // récent d'abord, année par année
  const saved = require('../src/harvest').saveItem({ netflixId: '99990001', type: 'movie', name: 'Moissonné', year: 2026, tmdbId: null, imdbId: null, releaseDate: '2026-11-01' });
  assert.equal(saved, 'added'); assert.equal(store.findByNetflixId('99990001').id, 'nflx:99990001');
  assert.equal(require('../src/harvest').saveItem({ netflixId: '99990001', type: 'movie', name: 'Moissonné' }), 'known');

  // Journal : écriture, API filtrée par niveau, protection, effacement
  const log = require('../src/log');
  log.info('test', 'Entrée de test info');
  log.error('test', 'Entrée de test erreur');
  let jdata = await (await fetch(`${base}/admin/api/logs`, { headers: auth })).json();
  assert.ok(jdata.total >= 2); assert.equal(jdata.logs[0].source, 'test');
  const errOnly = await (await fetch(`${base}/admin/api/logs?level=error`, { headers: auth })).json();
  assert.ok(errOnly.total >= 1); assert.ok(errOnly.logs.every((l) => l.level === 'error'));
  assert.equal((await fetch(`${base}/admin/api/logs`)).status, 401);
  const cleared = await (await fetch(`${base}/admin/api/logs/clear`, { method: 'POST', headers: auth })).json();
  assert.equal(cleared.ok, true);
  jdata = await (await fetch(`${base}/admin/api/logs`, { headers: auth })).json();
  assert.equal(jdata.total, 1); // l'effacement est lui-même journalisé

  app.close(); upstream.close();
  console.log('OK — parseur (structure réelle), fusion, SQL et handlers Stremio');
})().catch((e) => { console.error(e); process.exit(1); });
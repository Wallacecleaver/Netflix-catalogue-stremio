// Test hors-ligne : parser + base + handlers Stremio, sans appel réseau.
process.env.DB_PATH = require('path').join(require('os').tmpdir(), `nflx-smoke-${Date.now()}.db`);
const assert = require('assert');
const { parseNetflixHtml } = require('../src/netflix');
const store = require('../src/db');
const { withReleased } = require('../src/enrich');
const { builder } = require('../src/addon');

const ld = { '@context': 'https://schema.org', '@type': 'TVSeries', name: 'Trouble échange',
  description: 'Un échange de maisons de rêve entre la Sicile et Stockholm tourne mal.', datePublished: '2026-01-01',
  contentRating: '16+', genre: ['Drame'], actor: [{ name: 'Emma Appleton' }, { name: 'Fares Fares' }, { name: 'Frida Gustavsson' }],
  containsSeason: [{ '@type': 'TVSeason', seasonNumber: 1, episode: [
    { '@type': 'TVEpisode', episodeNumber: 1, name: 'Épisode 1', description: 'Deux couples échangent leurs maisons.', timeRequired: 'PT46M', image: 'https://img/e1.jpg' }] }] };
const html = `<html><head><meta property="og:type" content="video.tv_show"><meta property="og:image" content="https://img/main.jpg">
<script type="application/ld+json">${JSON.stringify(ld)}</script></head><body><p>Avec : Emma Appleton, Fares Fares</p>
<script>netflix.reactContext = {"x":{"eps":[{"title":"Épisode 2","synopsis":"Une \\x22découverte\\x22 choquante","seq":0,"episode":2,"season":1,"runtime":2280,"stills":[{"url":"https://img/e2.jpg"}]}]}};</script></body></html>`;

const p = parseNetflixHtml(html);
assert.equal(p.name, 'Trouble échange'); assert.equal(p.type, 'series'); assert.equal(p.year, 2026);
assert.equal(p.certification, '16+'); assert.deepEqual(p.genres, ['Drame']); assert.equal(p.cast.length, 3);
assert.equal(p.episodes.length, 2); assert.equal(p.episodes[1].synopsis, 'Une "découverte" choquante');
assert.equal(p.episodes[1].runtime, 38); assert.equal(p.episodes[0].runtime, 46);

store.upsertTitle({ id: 'nflx:81944880', netflix_id: '81944880', type: 'series', name: p.name, year: p.year, certification: p.certification,
  genres: p.genres, synopsis: p.synopsis, cast: p.cast, poster: 'https://img/poster.jpg', trailer_yt: 'dQw4w9WgXcQ', enriched: 1 });
store.replaceEpisodes('nflx:81944880', withReleased(p.episodes, p.year));

(async () => {
  const iface = builder.getInterface();
  const cat = await iface.get('catalog', 'series', 'netflix-series', {});
  assert.equal(cat.metas[0].id, 'nflx:81944880');
  assert.equal((await iface.get('catalog', 'series', 'netflix-series', { genre: 'Drame' })).metas.length, 1);
  assert.equal((await iface.get('catalog', 'series', 'netflix-series', { search: 'zzz' })).metas.length, 0);
  const { meta } = await iface.get('meta', 'series', 'nflx:81944880');
  assert.equal(meta.videos.length, 2); assert.equal(meta.videos[0].id, 'nflx:81944880:1:1');
  assert.ok(meta.videos[0].released.endsWith('Z')); assert.equal(meta.trailerStreams[0].ytId, 'dQw4w9WgXcQ');
  console.log('OK — parser, SQL et handlers Stremio');
  console.log(JSON.stringify(meta, null, 2).slice(0, 900));
})().catch((e) => { console.error(e); process.exit(1); });

// Tests hors ligne de src/youtube.js (matching strict + extraction ytInitialData) : réseau simulé.
//   node test/youtube.test.js
const assert = require('node:assert/strict');
const path = require('node:path');

const MOD = path.join(__dirname, '..', 'src', 'youtube.js');
const CONFIG = path.join(__dirname, '..', 'src', 'config.js');

let passes = 0;
const ok = (name) => { passes++; console.log(`  ok  ${name}`); };

function reload(env, fetchImpl) {
  for (const k of [MOD, CONFIG]) delete require.cache[k];
  for (const k of Object.keys(process.env)) if (k.startsWith('YOUTUBE_')) delete process.env[k];
  Object.assign(process.env, env);
  global.fetch = fetchImpl;
  return require(MOD);
}

/** Page YouTube minimale avec ytInitialData (accolades dans les chaînes incluses). */
function page(videos) {
  const data = {
    contents: {
      list: videos.map((v) => ({
        videoRenderer: {
          videoId: v.id,
          title: { runs: [{ text: v.title }] },
          ownerText: { runs: [{ text: v.channel }] },
          lengthText: { simpleText: v.length },
        },
      })),
    },
    note: 'accolade dans une chaîne : { ceci n\'est pas du JSON }',
  };
  return `<html><script>var ytInitialData = ${JSON.stringify(data)};</script></html>`;
}

const VIDEOS = [
  { id: 'BON', title: 'BELOW Bande Annonce VF (2026) Josh Hartnett', channel: 'AuCiné', length: '2:10' },
  { id: 'BRUIT1', title: 'A Couple of Lies | Official Trailer | Netflix', channel: 'Netflix', length: '1:58' },
  { id: 'BRUIT2', title: 'BELOW - Extrait du film', channel: 'FilmsActu', length: '1:20' },
  { id: 'BRUIT3', title: 'BELOW Teaser', channel: 'X', length: '0:20' },
];

(async () => {
  // 1. Extraction : ytInitialData lisible même avec des accolades dans les chaînes
  {
    const yt = reload({}, async () => ({ ok: true, status: 200, text: async () => page(VIDEOS) }));
    const html = page(VIDEOS);
    const data = yt.readInitialData(html);
    assert.ok(data && data.contents, 'ytInitialData doit être extrait et parsé');
    assert.equal(data.note.includes('{'), true, 'les accolades dans les chaînes ne cassent pas le parsing');
    const vids = await yt.searchVideos('below bande annonce');
    assert.deepEqual(vids.map((v) => v.id), ['BON', 'BRUIT1', 'BRUIT2', 'BRUIT3']);
    ok('ytInitialData : extraction fiable (accolades incluses) + liste des vidéos');
  }

  // 2. Notation : titre du film + « bande annonce », et rejets du bruit
  {
    const yt = reload({});
    const ctx = { name: 'Below', year: 2026 };
    assert.ok(yt.score(VIDEOS[0], ctx) >= 3, 'VF officielle acceptée');
    assert.equal(yt.score(VIDEOS[1], ctx), 0, 'autre film → rejeté');
    assert.equal(yt.score(VIDEOS[2], ctx), 0, 'extrait → rejeté');
    assert.equal(yt.score(VIDEOS[3], ctx), 0, '20 s (spot) → rejeté');
    assert.equal(yt.score({ title: 'BELOW Réaction', channel: 'X', length: '10:00' }, ctx), 0, 'réaction → rejetée');
    ok('score : VF retenue, autres films / extraits / spots / réactions rejetés');
  }

  // 3. findTrailer : choisit la bonne vidéo
  {
    const yt = reload({}, async () => ({ ok: true, status: 200, text: async () => page(VIDEOS) }));
    const found = await yt.findTrailer({ name: 'Below', year: 2026, type: 'movie' });
    assert.equal(found.id, 'BON');
    assert.equal(found.channel, 'AuCiné');
    ok('findTrailer : renvoie la bande-annonce VF');
  }

  // 4. findTrailer : rien de crédible → null (mieux vaut pas de vidéo qu'une mauvaise)
  {
    const yt = reload({}, async () => ({ ok: true, status: 200, text: async () => page([VIDEOS[1], VIDEOS[2]]) }));
    assert.equal(await yt.findTrailer({ name: 'Trouble échange', year: 2026, type: 'movie' }), null);
    ok('findTrailer : aucune correspondance fiable → null');
  }

  // 5. Interrupteur YOUTUBE_SEARCH=0 : aucune requête réseau
  {
    let calls = 0;
    const yt = reload({ YOUTUBE_SEARCH: '0' }, async () => { calls++; return { ok: true, status: 200, text: async () => page(VIDEOS) }; });
    assert.equal(await yt.findTrailer({ name: 'Below', year: 2026 }), null);
    assert.equal(calls, 0, 'aucun appel quand la recherche YouTube est désactivée');
    ok('YOUTUBE_SEARCH=0 : désactivé, zéro requête');
  }

  console.log(`\n${passes} tests OK`);
})().catch((e) => { console.error('\nÉCHEC :', e.message); process.exit(1); });

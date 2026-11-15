// Tests hors ligne de src/search.js (Brave Search + API iTunes) : réseau simulé par un faux `fetch`.
//   node test/search-brave-itunes.test.js
const assert = require('node:assert/strict');
const path = require('node:path');

const SEARCH = path.join(__dirname, '..', 'src', 'search.js');
const CONFIG = path.join(__dirname, '..', 'src', 'config.js');

let passes = 0;
const ok = (name) => { passes++; console.log(`  ok  ${name}`); };

/** Recharge search.js avec un environnement et un `fetch` donnés (les modules sont mis en cache par Node). */
function reload(env, fetchImpl) {
  for (const k of [SEARCH, CONFIG]) delete require.cache[k];
  for (const k of Object.keys(process.env)) if (k.startsWith('BRAVE_')) delete process.env[k];
  Object.assign(process.env, env);
  global.fetch = fetchImpl;
  return require(SEARCH);
}

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const text = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => body, json: async () => ({}) });

const BRAVE_FIXTURE = {
  web: {
    results: [
      { url: 'https://www.netflix.com/fr/title/81944880', title: 'Trouble échange | Netflix officiel', description: 'Un film drôle.' },
      { url: 'https://www.netflix.com/title/81944880', title: 'Doublon à ignorer', description: '' },
      { url: 'https://www.netflix.com/fr/title/81040344', title: 'Regarder Squid Game', description: 'Une série coréenne.' },
      { url: 'https://www.allocine.fr/film/fichefilm_gen_cfilm=123.html', title: 'Pas Netflix', description: '' },
    ],
  },
};

const DDG_HTML = `<div><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.netflix.com%2Ftitle%2F81234567">Le Bon Film</a>
<a class="result__snippet" href="#">Résumé du film</a></div>`;

const ITUNES_MOVIE = { results: [
  { wrapperType: 'track', kind: 'feature-movie', trackName: 'Trouble échange', releaseDate: '2024-01-19T08:00:00Z', trackViewUrl: 'https://tv.apple.com/fr/movie/trouble-echange/umc.cmc.1abc?l=fr' },
] };
const ITUNES_SHOW = { results: [
  { wrapperType: 'season', collectionName: 'Ted Lasso, Season 1', releaseDate: '2020-08-14T07:00:00Z', trackViewUrl: 'https://tv.apple.com/fr/show/ted-lasso/umc.cmc.2def?l=fr' },
  { wrapperType: 'season', collectionName: 'Ted Lasso, Season 2', releaseDate: '2021-07-23T07:00:00Z', trackViewUrl: 'https://tv.apple.com/fr/show/ted-lasso/umc.cmc.2def?l=fr' },
] };

(async () => {
  // 1. Brave : extraction des IDs, nettoyage des titres, dédoublonnage, en-tête d'authentification
  {
    const calls = [];
    const search = reload({ BRAVE_API_KEY: 'cle-test' }, async (url, opts) => {
      calls.push({ url: new URL(url), opts });
      return json(BRAVE_FIXTURE);
    });
    const out = await search.netflix('Trouble échange');
    assert.deepEqual(out.map((r) => r.id), ['81944880', '81040344'], 'IDs Netflix extraits et dédoublonnés');
    assert.equal(out[0].title, 'Trouble échange', 'suffixe « | Netflix » retiré');
    assert.equal(out[1].title, 'Squid Game', 'préfixe « Regarder » retiré');
    assert.equal(out[0].snippet, 'Un film drôle.');
    assert.equal(out[0].url, 'https://www.netflix.com/title/81944880');
    assert.equal(calls.length, 1);
    const u = calls[0].url;
    assert.equal(u.hostname, 'api.search.brave.com');
    assert.equal(u.pathname, '/res/v1/web/search');
    assert.equal(u.searchParams.get('q'), 'site:netflix.com/title Trouble échange');
    assert.equal(u.searchParams.get('country'), 'FR');
    assert.equal(u.searchParams.get('search_lang'), 'fr');
    assert.equal(u.searchParams.get('count'), '20');
    assert.equal(calls[0].opts.headers['x-subscription-token'], 'cle-test');
    ok('Brave : IDs, titres nettoyés, dédoublonnage, en-tête de clé');
  }

  // 2. Clé refusée : erreur de configuration remontée telle quelle (pas de secours silencieux)
  {
    const calls = [];
    const search = reload({ BRAVE_API_KEY: 'mauvaise' }, async (url) => {
      calls.push(String(url));
      if (String(url).includes('brave')) return text('unauthorized', 401);
      return text(DDG_HTML);
    });
    await assert.rejects(() => search.netflix('x'), /BRAVE_API_KEY/);
    assert.equal(calls.length, 1, 'aucun appel à DuckDuckGo quand la clé est refusée');
    ok('Brave 401 : erreur de configuration remontée sans secours');
  }

  // 3. Quota Brave atteint : bascule sur DuckDuckGo
  {
    const calls = [];
    const search = reload({ BRAVE_API_KEY: 'cle-test' }, async (url) => {
      calls.push(String(url));
      if (String(url).includes('brave')) return text('quota', 429);
      return text(DDG_HTML);
    });
    const out = await search.netflix('Le Bon Film');
    assert.deepEqual(out.map((r) => r.id), ['81234567']);
    assert.equal(out[0].title, 'Le Bon Film');
    assert.equal(calls.length, 2);
    assert.ok(calls[1].includes('html.duckduckgo.com'), 'deuxième appel = DuckDuckGo');
    ok('Brave 429 : bascule sur DuckDuckGo');
  }

  // 4. Sans clé : comportement d'origine strictement inchangé
  {
    const calls = [];
    const search = reload({}, async (url) => {
      calls.push(String(url));
      return text(DDG_HTML);
    });
    const out = await search.netflix('Le Bon Film');
    assert.deepEqual(out.map((r) => r.id), ['81234567']);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].startsWith('https://html.duckduckgo.com/html/?q='), 'aucun appel Brave sans clé');
    ok('Sans BRAVE_API_KEY : DuckDuckGo inchangé');
  }

  // 5. Les deux moteurs en échec : message qui cite les deux causes
  {
    const search = reload({ BRAVE_API_KEY: 'cle-test' }, async (url) => {
      if (String(url).includes('brave')) throw new Error('réseau coupé');
      return text('<html>anomaly detected</html>', 202);
    });
    await assert.rejects(() => search.netflix('x'), (e) => /réseau coupé/.test(e.message) && /DuckDuckGo/.test(e.message));
    ok('Brave + DuckDuckGo en échec : message combiné');
  }

  // 6. Apple TV via iTunes : ID umc.cmc, type, année, saisons dédoublonnées
  {
    const calls = [];
    const search = reload({}, async (url) => {
      const u = new URL(url);
      calls.push(u);
      assert.equal(u.hostname, 'itunes.apple.com');
      assert.equal(u.searchParams.get('country'), 'fr');
      assert.equal(u.searchParams.get('lang'), null, 'lang non transmis (seuls en_us/ja_jp sont acceptés)');
      if (u.searchParams.get('media') === 'movie') return json(ITUNES_MOVIE);
      return json(ITUNES_SHOW);
    });
    const out = await search.apple('Ted Lasso');
    assert.equal(calls.length, 2, 'un appel films + un appel séries');
    assert.deepEqual(calls.map((u) => u.searchParams.get('entity')).sort(), ['movie', 'tvSeason']);
    const movie = out.find((r) => r.type === 'movie');
    const show = out.find((r) => r.type === 'series');
    assert.equal(movie.id, 'umc.cmc.1abc');
    assert.equal(movie.title, 'Trouble échange');
    assert.equal(movie.year, 2024);
    assert.equal(show.title, 'Ted Lasso', '« , Season 1 » retiré');
    assert.equal(show.year, 2020, 'première occurrence gardée');
    assert.equal(out.filter((r) => r.id === 'umc.cmc.2def').length, 1, 'saisons dédoublonnées');
    assert.equal(search.appleWeb, search.apple, 'alias de compatibilité conservé');
    ok('Apple TV : iTunes → ID umc.cmc, type, année, dédoublonnage des saisons');
  }

  // 7. iTunes indisponible
  {
    const search = reload({}, async () => text('boom', 500));
    await assert.rejects(() => search.apple('x'), /iTunes Search HTTP 500/);
    ok('iTunes 500 : erreur remontée');
  }

  // 8. Compatibilité des exports historiques (parse / parseApple / appleWeb)
  {
    const search = reload({}, async () => text(''));
    assert.equal(typeof search.parse, 'function');
    assert.equal(typeof search.parseApple, 'function');
    assert.equal(typeof search.appleWeb, 'function');
    assert.deepEqual(search.parse(DDG_HTML).map((r) => r.id), ['81234567']);
    assert.deepEqual(search.parseApple(DDG_HTML), []);
    ok('parse / parseApple / appleWeb toujours exportés');
  }

  console.log(`\n${passes} tests OK`);
})().catch((e) => { console.error('\nÉCHEC :', e.message); process.exit(1); });

// Tests hors ligne de src/search.js : JustWatch d'abord, moteur de recherche en secours, API iTunes pour Apple TV.
//   node test/search-brave-itunes.test.js
const assert = require('node:assert/strict');
const path = require('node:path');

const SEARCH = path.join(__dirname, '..', 'src', 'search.js');
const CONFIG = path.join(__dirname, '..', 'src', 'config.js');
const JW = path.join(__dirname, '..', 'src', 'justwatch.js');

let passes = 0;
const ok = (name) => { passes++; console.log(`  ok  ${name}`); };

const jwFail = { searchNetflix: async () => { throw new Error('JustWatch 503'); } };
const jwEmpty = { searchNetflix: async () => [] };
const jwHit = { searchNetflix: async () => ([
  { netflixId: '81763154', netflixUrl: 'https://www.netflix.com/title/81763154', title: 'Ninho : Le prix à payer', type: 'movie', objectType: 'MOVIE', year: 2026 },
]) };

/** Recharge search.js avec un environnement, un `fetch` simulé et un faux JustWatch. */
function reload(env, fetchImpl, justwatch = jwFail) {
  for (const k of [SEARCH, CONFIG, JW]) delete require.cache[k];
  require.cache[JW] = { id: JW, filename: JW, loaded: true, exports: justwatch };
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
  // 1. JustWatch répond : aucune requête réseau, même avec une clé Brave configurée
  {
    const calls = [];
    const search = reload({ BRAVE_API_KEY: 'cle-test' }, async (url) => { calls.push(String(url)); return json(BRAVE_FIXTURE); }, jwHit);
    const out = await search.netflix('ninho le prix a payer');
    assert.equal(calls.length, 0, 'aucun appel réseau quand JustWatch répond');
    assert.deepEqual(out.map((r) => r.id), ['81763154']);
    assert.equal(out[0].title, 'Ninho : Le prix à payer');
    assert.equal(out[0].snippet, 'Film · 2026');
    assert.equal(out[0].url, 'https://www.netflix.com/title/81763154');
    ok('JustWatch prioritaire : gratuit, sans clé, sans requête web');
  }

  // 2. JustWatch répond « rien » : c'est une vraie réponse, pas de moteur de recherche
  {
    const calls = [];
    const search = reload({}, async (url) => { calls.push(String(url)); return text(DDG_HTML); }, jwEmpty);
    const out = await search.netflix('titre absent');
    assert.deepEqual(out, []);
    assert.equal(calls.length, 0, 'pas de recherche web pour un titre absent de JustWatch');
    ok('JustWatch vide : réponse vide, sans appel web');
  }

  // 3. JustWatch en panne → Brave
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
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.hostname, 'api.search.brave.com');
    assert.equal(calls[0].opts.headers['x-subscription-token'], 'cle-test');
    ok('JustWatch en panne → Brave Search');
  }

  // 4. Clé Brave refusée : erreur de configuration remontée telle quelle
  {
    const search = reload({ BRAVE_API_KEY: 'mauvaise' }, async (url) => (String(url).includes('brave') ? text('unauthorized', 401) : text(DDG_HTML)));
    await assert.rejects(() => search.netflix('x'), /BRAVE_API_KEY/);
    ok('Brave 401 : erreur de configuration, pas de masquage');
  }

  // 5. Quota Brave → DuckDuckGo
  {
    const calls = [];
    const search = reload({ BRAVE_API_KEY: 'cle-test' }, async (url) => {
      calls.push(String(url));
      return String(url).includes('brave') ? text('quota', 429) : text(DDG_HTML);
    });
    const out = await search.netflix('Le Bon Film');
    assert.deepEqual(out.map((r) => r.id), ['81234567']);
    assert.ok(calls[1].includes('html.duckduckgo.com'), 'deuxième appel = DuckDuckGo');
    ok('Brave 429 → DuckDuckGo');
  }

  // 6. Sans clé Brave : DuckDuckGo (comportement historique)
  {
    const calls = [];
    const search = reload({}, async (url) => { calls.push(String(url)); return text(DDG_HTML); });
    const out = await search.netflix('Le Bon Film');
    assert.deepEqual(out.map((r) => r.id), ['81234567']);
    assert.ok(calls[0].startsWith('https://html.duckduckgo.com/html/?q='));
    ok('Sans clé Brave → DuckDuckGo');
  }

  // 7. Tout en échec : message qui cite les deux causes, et « fetch failed » traduit
  {
    const netErr = () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNRESET' }; return e; };
    const search = reload({ BRAVE_API_KEY: 'cle-test' }, async (url) => {
      if (String(url).includes('brave')) throw netErr();
      throw netErr();
    });
    await assert.rejects(() => search.netflix('x'), (e) => /JustWatch : JustWatch 503/.test(e.message) && /réseau injoignable/.test(e.message));
    ok('Tout en échec : causes citées, erreur réseau lisible');
  }

  // 8. Apple TV via iTunes : ID umc.cmc, type, année, saisons dédoublonnées
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
    const movie = out.find((r) => r.type === 'movie');
    const show = out.find((r) => r.type === 'series');
    assert.equal(movie.id, 'umc.cmc.1abc');
    assert.equal(movie.year, 2024);
    assert.equal(show.title, 'Ted Lasso', '« , Season 1 » retiré');
    assert.equal(out.filter((r) => r.id === 'umc.cmc.2def').length, 1, 'saisons dédoublonnées');
    assert.equal(search.appleWeb, search.apple, 'alias de compatibilité conservé');
    ok('Apple TV : iTunes → ID umc.cmc, type, année, dédoublonnage des saisons');
  }

  // 9. iTunes indisponible
  {
    const search = reload({}, async () => text('boom', 500));
    await assert.rejects(() => search.apple('x'), /iTunes Search HTTP 500/);
    ok('iTunes 500 : erreur remontée');
  }

  // 10. Compatibilité des exports historiques (parse / parseApple / appleWeb)
  {
    const search = reload({}, async () => text(''));
    assert.equal(typeof search.parse, 'function');
    assert.equal(typeof search.parseApple, 'function');
    assert.equal(typeof search.appleWeb, 'function');
    assert.deepEqual(search.parse(DDG_HTML).map((r) => r.id), ['81234567']);
    ok('parse / parseApple / appleWeb toujours exportés');
  }

  console.log(`\n${passes} tests OK`);
})().catch((e) => { console.error('\nÉCHEC :', e.message); process.exit(1); });

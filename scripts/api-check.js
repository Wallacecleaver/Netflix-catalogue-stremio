// Diagnostic de l'API de fédération, à lancer DEPUIS le conteneur (là où `docker` n'existe pas) :
//   npm run api-check -- tt26598805
//   npm run api-check -- 81763154 --type movie
//   npm run api-check -- tt26598805 --url https://stockage.mondomaine.fr --key <clé>
// Il interroge /api/trailers?debug=1 et dit si la fiche est en base, ce qu'elle contient et pourquoi
// une instance cliente ne recevrait rien.
const config = require('../src/config');

const argv = process.argv.slice(2);
const WITH_VALUE = new Set(['--type', '--url', '--key']);
let id = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (WITH_VALUE.has(a)) { i++; continue; }          // saute la valeur de l'option
  if (!a.startsWith('--') && id === null) id = a;     // premier argument libre = identifiant
}
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };

const base = String(opt('url', `http://127.0.0.1:${config.port}`)).replace(/\/+$/, '');
const type = opt('type', '');
const key = opt('key', config.apiKey);

(async () => {
  if (!id) {
    console.error('usage : npm run api-check -- <tt…|id tmdb|id netflix> [--type series|movie] [--url …] [--key …]');
    process.exit(1);
  }

  const qs = new URLSearchParams();
  if (/^tt\d+$/.test(id)) qs.set('imdb', id);
  else if (/^\d+$/.test(id)) qs.set('tmdb', id);
  else qs.set('netflix', id);
  if (type) qs.set('type', type);
  qs.set('debug', '1');
  const url = `${base}/api/trailers?${qs}`;

  let res;
  try {
    res = await fetch(url, { headers: key ? { 'x-api-key': key } : {} });
  } catch (e) {
    console.error(`\n✗ ${url}\n  Connexion impossible : ${e.message}`);
    process.exit(1);
  }
  const data = await res.json().catch(() => ({}));

  console.log(`\n${url}`);
  console.log(`HTTP ${res.status}`);
  if (res.status === 401) {
    console.log('\n→ API fermée : la clé manque. Ajoute --key <clé> (Paramètres → API de fédération).');
    return;
  }
  if (!res.ok) { console.log(JSON.stringify(data, null, 1)); return; }

  console.log(`found         : ${data.found}`);
  console.log(`pending       : ${data.pending}`);
  if (data.title) {
    console.log(`fiche         : ${data.title.name} (${data.title.type}${data.title.year ? ' ' + data.title.year : ''})`);
    console.log(`identifiants  : id=${data.title.id} imdb=${data.title.imdb_id || '—'} tmdb=${data.title.tmdb_id || '—'} netflix=${data.title.netflix_id || '—'}`);
  }
  console.log(`bande-annonce : ${data.trailers.length}`);
  for (const t of data.trailers) console.log(`   [${t.source}] ${t.title} → ${t.url}`);

  if (data.debug) {
    const c = data.debug.counts || {};
    console.log(`compteurs     : netflix=${c.netflix ?? '—'} appletv=${c.appletv ?? '—'} manuel=${c.manual ?? '—'}`);
    console.log(`résolution    : ${data.debug.resolveActive ? 'active (TMDB présent)' : 'inactive (TMDB_API_KEY manquant ou RESOLVE_ENABLED=0)'}`);
    console.log(`API           : ${data.debug.apiOpen ? 'ouverte' : 'fermée par une clé'}`);
  }

  console.log('');
  if (data.found) console.log('→ OK : une instance cliente peut utiliser ces URLs.');
  else if (!data.debug || !data.debug.fiche) console.log('→ Fiche absente de la base sous cet identifiant : ajoute-la (onglet Ajouter) ou vérifie l\'ID.');
  else if (data.pending) console.log('→ Fiche trouvée, recherche en cours : réessaie dans quelques secondes.');
  else console.log('→ Fiche trouvée mais aucune bande-annonce : lance « Bandes-annonces Netflix » ou « Apple TV » dans Stockage.');
})();

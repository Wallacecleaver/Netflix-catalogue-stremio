// Lit la page Netflix des titres déjà liés à un ID mais sans bande-annonce stockée.
//   npm run netflix-trailers              → tout le gisement
//   npm run netflix-trailers -- --limit 50
require('../src/settings');
const job = require('../src/netflix-trailers');

const argv = process.argv.slice(2);
const i = argv.indexOf('--limit');
const limit = i >= 0 ? Number(argv[i + 1]) || 0 : 0;

job.run({ limit })
  .then((s) => console.log(`\nTerminé : ${s.found} bande(s)-annonce(s) trouvée(s) sur ${s.done} page(s) lue(s), ${s.failed} erreur(s).`))
  .catch((e) => { console.error('ÉCHEC :', e.message); process.exit(1); });

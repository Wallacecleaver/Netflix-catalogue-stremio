// Associe chaque titre à TMDB/IMDb (et complète affiches, synopsis, genres)
// et complète affiche / synopsis / genres / IMDb des fiches moissonnées. Nécessite TMDB_API_KEY.
// Usage : npm run vf                      (tous les titres pas encore vérifiés)
//         npm run vf -- --limit 200       (test rapide)
//         npm run vf -- --concurrency 6   (requêtes TMDB en parallèle, 4 par défaut)
const vf = require('../src/vf');
require('../src/settings');                     // applique les surcharges enregistrées depuis /admin

const args = process.argv.slice(2);
const val = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? Number(args[i + 1]) : undefined; };

(async () => {
  let last = -1;
  const st = await vf.run({
    limit: val('limit') || 0,
    concurrency: val('concurrency') || 4,
    onProgress(s) {
      if (s.done === last) return;
      last = s.done;
      process.stdout.write(`\r${s.done}/${s.total} · ${s.matched} liés à TMDB · ${s.noMatch} sans fiche TMDB · ${s.failed} erreurs`);
    },
  });
  process.stdout.write('\n');
  console.log(`Terminé : ${st.matched} titres liés à TMDB sur ${st.done} vérifiés (${st.noMatch} introuvables sur TMDB, ${st.failed} erreurs).`);
  if (st.errors.length) console.log('Dernières erreurs :\n- ' + st.errors.join('\n- '));
})().catch((e) => { console.error(e.message); process.exitCode = 1; });

// Associe les fiches sans ID Netflix (JustWatch → page Netflix) et stocke ID + nom + TMDB/IMDb.
// Usage : npm run netflix-ids                 (tout le catalogue)
//         npm run netflix-ids -- --limit 50   (test rapide)
const link = require('../src/link');

(async () => {
  const args = process.argv.slice(2);
  const li = args.indexOf('--limit');
  const limit = li >= 0 ? Number(args[li + 1]) : 0;
  const delay = args.indexOf('--delay');
  const delayMs = delay >= 0 ? Number(args[delay + 1]) : 300;

  let last = -1;
  const status = await link.run({
    limit: Number.isFinite(limit) ? limit : 0,
    delayMs: Number.isFinite(delayMs) ? delayMs : 300,
    onProgress(st) {
      if (st.done === last) return;
      last = st.done;
      process.stdout.write(`\r${st.done}/${st.total} · ${st.linked} liés · ${st.skipped} introuvables · ${st.failed} erreurs`);
    },
  });
  process.stdout.write('\n');
  console.log(`Terminé : ${status.linked} IDs liés, ${status.skipped} introuvables, ${status.failed} erreurs.`);
  if (status.errors.length) console.log('Dernières erreurs :\n- ' + status.errors.join('\n- '));
})();

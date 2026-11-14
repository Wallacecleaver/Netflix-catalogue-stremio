// Moissonne TOUS les IDs Netflix du catalogue (région REGION) et les enregistre en base.
// Usage : npm run harvest                      (tout le catalogue, films + séries)
//         npm run harvest -- --recent          (dernières sorties : année en cours, précédente et suivante)
//         npm run harvest -- --from 2020 --to 2026
//         npm run harvest -- --type series     (movie | series)
//         npm run harvest -- --dry             (n'écrit pas en base, exporte seulement les IDs trouvés)
//         npm run harvest -- --delay 800       (pause entre requêtes, en ms)
// Résultat : data/netflix-ids.json et data/netflix-ids.csv
const { harvest, exportIds } = require('../src/harvest');
require('../src/settings');                     // applique les surcharges enregistrées depuis /admin

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const val = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const num = (v) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined);

(async () => {
  const year = new Date().getFullYear();
  const recent = flag('recent');
  const type = val('type');
  if (type && !['movie', 'series'].includes(type)) throw new Error('--type doit valoir movie ou series');

  let last = '';
  const { stats, items } = await harvest({
    from: recent ? year - 1 : num(val('from')),
    to: num(val('to')),
    types: type ? [type] : ['movie', 'series'],
    delayMs: num(val('delay')) ?? 400,
    dry: flag('dry'),
    onProgress(st) {
      const line = `\r${st.type} ${st.slice.minYear === st.slice.maxYear ? st.slice.minYear : `${st.slice.minYear}-${st.slice.maxYear}`}`
        + ` · ${st.seen} IDs · ${st.added} ajoutés · ${st.linked} liés · ${st.known} déjà connus   `;
      if (line !== last) { process.stdout.write(line); last = line; }
    },
  });
  process.stdout.write('\n');

  const out = flag('dry') ? exportIds(items) : exportIds();
  console.log(`Terminé : ${stats.seen} IDs Netflix vus (${stats.added} nouveaux, ${stats.linked} liés à une fiche TMDB, ${stats.known} déjà connus).`);
  console.log(`Export : ${out.count} lignes → ${out.jsonPath} et ${out.csvPath}`);
  if (stats.errors.length) console.log(`${stats.errors.length} tranche(s) en erreur :\n- ${stats.errors.slice(-10).join('\n- ')}`);
  if (!flag('dry')) console.log('Astuce : `npm run netflix-ids` complète ensuite TMDB/IMDb, bande-annonce et épisodes pour les fiches sans métadonnées.');
})().catch((e) => { console.error(e.message); process.exitCode = 1; });

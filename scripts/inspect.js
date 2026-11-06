// Débogage : télécharge la page Netflix, la sauvegarde dans data/ et affiche ce que le parser en tire.
const fs = require('fs');
const { parseNetflixId, fetchNetflixPage, parseNetflixHtml } = require('../src/netflix');
(async () => {
  const id = parseNetflixId(process.argv[2]);
  if (!id) { console.log('Usage: npm run inspect -- <url|id>'); process.exit(1); }
  const html = await fetchNetflixPage(id);
  fs.mkdirSync('data', { recursive: true });
  const file = `data/inspect-${id}.html`;
  fs.writeFileSync(file, html);
  const p = parseNetflixHtml(html);
  console.log(`HTML sauvegardé : ${file} (${html.length} octets)`);
  console.log(JSON.stringify({ ...p, episodes: `${p.episodes.length} épisode(s)` }, null, 2));
  console.log(p.episodes.slice(0, 3));
})().catch((e) => { console.error(e.message); process.exit(1); });

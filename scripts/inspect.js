// Débogage : affiche ce que le parseur tire d'une page Netflix.
// Usage : npm run inspect -- <url|id>            (télécharge la page)
//         npm run inspect -- --file page.html     (page enregistrée depuis ton navigateur)
const fs = require('fs');
const { parseNetflixId, fetchNetflixPage, parseNetflixHtml } = require('../src/netflix');
(async () => {
  const args = process.argv.slice(2);
  const fi = args.indexOf('--file');
  let html;
  if (fi >= 0) {
    html = fs.readFileSync(args[fi + 1], 'utf8');
  } else {
    const id = parseNetflixId(args[0]);
    if (!id) { console.log('Usage: npm run inspect -- <url|id>  ou  --file page.html'); process.exitCode = 1; return; }
    html = await fetchNetflixPage(id);
    fs.mkdirSync('data', { recursive: true });
    fs.writeFileSync(`data/inspect-${id}.html`, html);
    console.log(`HTML sauvegardé : data/inspect-${id}.html`);
  }
  const p = parseNetflixHtml(html);
  console.log(`HTML : ${html.length} octets`);
  console.log(JSON.stringify({ ...p, episodes: `${p.episodes.length} épisode(s)` }, null, 2));
  console.log(p.episodes.slice(0, 3));
})().catch((e) => { console.error(e.message); process.exitCode = 1; });

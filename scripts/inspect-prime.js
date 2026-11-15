// Débogage : affiche ce que le parseur tire d'une page Prime Video.
// Usage : npm run inspect-prime -- <url|id>            (télécharge la page)
//         npm run inspect-prime -- --file page.html     (page enregistrée depuis ton navigateur)
const fs = require('fs');
const { parsePrimeId, fetchPrimePage, parsePrimeHtml } = require('../src/primevideo');
(async () => {
  const args = process.argv.slice(2);
  const fi = args.indexOf('--file');
  let html;
  if (fi >= 0) {
    html = fs.readFileSync(args[fi + 1], 'utf8');
  } else {
    const id = parsePrimeId(args[0]);
    if (!id) { console.log('Usage: npm run inspect-prime -- <url|id>  ou  --file page.html'); process.exitCode = 1; return; }
    html = await fetchPrimePage(id);
    fs.mkdirSync('data', { recursive: true });
    fs.writeFileSync(`data/inspect-prime-${id}.html`, html);
    console.log(`HTML sauvegardé : data/inspect-prime-${id}.html`);
  }
  const p = parsePrimeHtml(html);
  console.log(`HTML : ${html.length} octets`);
  console.log(JSON.stringify({
    ...p, image: p.image && '[url]', background: p.background && '[url]', logo: p.logo && '[url]',
    audio: `${p.audio.length} piste(s)`, subtitles: `${p.subtitles.length} langue(s)`, cast: `${p.cast.length} acteur(s)`,
    primeTrailer: p.primeTrailer && { playbackId: p.primeTrailer.playbackId, envelope: p.primeTrailer.playbackEnvelope ? '[présent]' : null, page: p.primeTrailer.page },
    episodes: `${p.episodes.length} épisode(s)`,
  }, null, 2));
  for (const e of p.episodes) console.log(`S${e.season}E${e.episode} · ${e.name} · ${e.runtime ?? '?'} min · ${e.released ?? '?'} · ${e.image ? 'image ok' : 'pas d’image'} · ${(e.synopsis || '').slice(0, 60)}…`);
})().catch((e) => { console.error(e.message); process.exitCode = 1; });

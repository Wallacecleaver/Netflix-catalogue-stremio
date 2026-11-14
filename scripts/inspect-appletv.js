// Usage : npm run inspect-appletv -- "Trouble échange" [movie|series]
// Affiche les résultats de recherche Apple TV, le titre retenu et les flux .m3u8 repérés (utile si Apple change son JSON).
const { search, pickMatch, fetchTrailers } = require('../src/appletv');
(async () => {
  const name = process.argv[2];
  const type = process.argv[3] || null;
  if (!name) { console.log('Usage : npm run inspect-appletv -- "<titre>" [movie|series]'); process.exit(1); }
  const items = await search(name);
  console.log('Résultats :', items);
  const match = pickMatch(items, { name, type });
  console.log('Retenu :', match);
  if (match) console.log('Trailers (tous ceux trouvés ; seuls les premiers sont gardés par l\'addon) :', await fetchTrailers(match, true));
})().catch((e) => { console.error(e.message); process.exit(1); });

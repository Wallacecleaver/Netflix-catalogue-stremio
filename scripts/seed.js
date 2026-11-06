// Données de démo (sans réseau) : "Trouble échange" avec épisodes, pour tester l'addon dans Stremio.
const store = require('../src/db');
const { withReleased } = require('../src/enrich');
const id = 'nflx:81944880';
store.upsertTitle({
  id, netflix_id: '81944880', type: 'series', name: 'Trouble échange', year: 2026, certification: '16+',
  genres: ['Drame'], cast: ['Emma Appleton', 'Fares Fares', 'Frida Gustavsson'],
  synopsis: 'Un échange de maisons de rêve entre la Sicile et Stockholm tourne mal quand deux couples fortunés sont soudain prêts à tout pour se protéger. Et pour protéger leurs secrets.',
  poster: 'https://placehold.co/500x750/111/fff?text=Trouble+%C3%A9change',
  background: 'https://placehold.co/1280x720/111/fff?text=Trouble+%C3%A9change',
  trailer_yt: null, enriched: 1,
});
store.replaceEpisodes(id, withReleased([
  { season: 1, episode: 1, name: 'Épisode 1', runtime: 46, synopsis: "Deux couples échangent leurs maisons entre la Sicile et l'archipel de Stockholm, mais d'inquiétants détails dans leurs nouveaux logements perturbent leurs vacances." },
  { season: 1, episode: 2, name: 'Épisode 2', runtime: 38, synopsis: "Une découverte choquante met Carl et Helene à cran. Scarlett se méfie d'Adam suite à une surprise embarrassante qui vient gâcher leur déjeuner romantique à Stockholm." },
  { season: 1, episode: 3, name: 'Épisode 3', runtime: 47, synopsis: "Alors qu'un secret bien gardé éclate enfin au grand jour, la décision inattendue d'Helene met Carl en péril. Scarlett reçoit une nouvelle bouleversante qui l'anéantit." },
  { season: 1, episode: 4, name: 'Épisode 4', runtime: 48, synopsis: "Après une cascade d'événements en Sicile, une vérité aussi troublante que meurtrière pourrait émerger d'une inextricable toile de mensonges et de manigances…" },
], 2026));
console.log('Démo ajoutée : Trouble échange (4 épisodes)');

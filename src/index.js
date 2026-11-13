const config = require('./config');
const store = require('./db');
const app = require('./app');
const { syncCatalog, syncRecent } = require('./sync');

app.listen(config.port, () => {
  console.log(`Addon prêt : http://localhost:${config.port}/manifest.json`);
  console.log(`URL publique des bandes-annonces : ${config.publicUrl}/trailer/…`);
  if (config.tmdbKey) {
    const full = () => syncCatalog().then((n) => console.log(`[sync] +${n} titres`)).catch((e) => console.warn('[sync]', e.message));
    const recent = () => syncRecent().then((n) => console.log(`[sync] sorties récentes +${n} titres`))
      .catch((e) => console.warn('[sync] sorties récentes', e.message));
    const run = () => Promise.all([full(), recent()]);
    if (store.count() === 0) run();
    else recent();                                    // le catalogue complet est déjà là : on rafraîchit les nouveautés
    setInterval(run, config.syncEveryHours * 3600 * 1000).unref();
  } else {
    console.warn('TMDB_API_KEY absent : pas de catalogue auto, ajoute des titres via /admin ou `npm run add`.');
  }
});

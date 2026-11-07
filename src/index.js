const config = require('./config');
const store = require('./db');
const app = require('./app');
const { syncCatalog } = require('./sync');

app.listen(config.port, () => {
  console.log(`Addon prêt : http://localhost:${config.port}/manifest.json`);
  console.log(`URL publique des bandes-annonces : ${config.publicUrl}/trailer/…`);
  if (config.tmdbKey) {
    const run = () => syncCatalog().then((n) => console.log(`[sync] +${n} titres`)).catch((e) => console.warn('[sync]', e.message));
    if (store.count() === 0) run();
    setInterval(run, config.syncEveryHours * 3600 * 1000).unref();
  } else {
    console.warn('TMDB_API_KEY absent : pas de catalogue auto, ajoute des titres via /admin ou `npm run add`.');
  }
});

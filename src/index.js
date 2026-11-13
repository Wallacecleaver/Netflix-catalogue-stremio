const config = require('./config');
const store = require('./db');
const log = require('./log');
const app = require('./app');
const link = require('./link');
const { syncCatalog, syncRecent } = require('./sync');

// Associe en arrière-plan les titres non liés à leur ID Netflix (même sans clé TMDB).
const kickLink = () => { if (store.stats().unlinked > 0 && !link.status().running) link.start({}); };

app.listen(config.port, () => {
  log.info('startup', `Serveur démarré (port ${config.port}, base ${config.dbPath})`);
  console.log(`Addon prêt : http://localhost:${config.port}/manifest.json`);
  console.log(`URL publique des bandes-annonces : ${config.publicUrl}/trailer/…`);
  setTimeout(kickLink, 5000);                        // reprise éventuelle d'un liage interrompu
  if (config.tmdbKey) {
    const full = () => syncCatalog().then((n) => console.log(`[sync] +${n} titres`)).catch((e) => console.warn('[sync]', e.message));
    const recent = () => syncRecent().then((n) => console.log(`[sync] sorties récentes +${n} titres`))
      .catch((e) => console.warn('[sync] sorties récentes', e.message));
    // Après chaque synchro, relance le liage sur les nouveaux titres.
    const run = () => Promise.all([full(), recent()]).then(() => setTimeout(kickLink, 3000));
    if (store.count() === 0) run();
    else recent().then(() => setTimeout(kickLink, 3000)); // le catalogue complet est déjà là : on rafraîchit les nouveautés
    setInterval(run, config.syncEveryHours * 3600 * 1000).unref();
  } else {
    log.warn('startup', 'TMDB_API_KEY absent : catalogue automatique désactivé');
    console.warn('TMDB_API_KEY absent : pas de catalogue auto, ajoute des titres via /admin ou `npm run add`.');
  }
});

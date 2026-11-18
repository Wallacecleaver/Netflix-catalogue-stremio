const config = require('./config');
const store = require('./db');
const log = require('./log');
const app = require('./app');
const link = require('./link');
const { syncCatalog, syncRecent } = require('./sync');

// Un job d'arrière-plan qui échoue ne doit pas faire tomber le serveur (Node ≥ 15 quitte sur une promesse rejetée non gérée).
process.on('unhandledRejection', (e) => { console.error('[unhandledRejection]', e); log.error('process', `Promesse rejetée : ${e && e.message || e}`); });

// Associe en arrière-plan les titres non liés à leur ID Netflix (même sans clé TMDB).
const kickLink = () => { if (store.stats().unlinked > 0 && !link.status().running) link.start({}); };

const server = app.listen(config.port, () => {
  log.info('startup', `Serveur API démarré (port ${config.port}, base ${config.dbPath})`);
  console.log(`Dashboard Admin : http://localhost:${config.port}/admin`);
  console.log(`API v1          : ${config.publicUrl}/api/v1/status`);
  console.log(`Relais MP4      : ${config.publicUrl}/trailer/…`);
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

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${config.port} déjà utilisé` : e);
  process.exit(1);
});

// Arrêt propre (docker stop / redémarrage) : on signale l'arrêt aux jobs de fond, puis on ferme SQLite (checkpoint WAL).
let stopping = false;
function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  console.log(`[${sig}] arrêt…`);
  for (const mod of ['./link', './harvest', './vf', './appletv', './netflix-trailers']) {
    try { require(mod).stop?.(); } catch { /* ignore */ }
  }
  const force = setTimeout(() => process.exit(0), 8000);
  force.unref();
  server.close(() => { try { store.db.close(); } catch { /* déjà fermée */ } process.exit(0); });
  server.closeIdleConnections?.();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

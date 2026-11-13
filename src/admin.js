const fs = require('fs');
const path = require('path');
const config = require('./config');

const HTML = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
const fromEnv = (name) => process.env[name] !== undefined && process.env[name] !== '';
const hint = (v) => `••••••••${String(v).slice(-2)}`;

/** Configuration affichée dans le dashboard, regroupée comme dans le .env (secrets masqués). */
function configView() {
  return [
    {
      title: 'Serveur',
      items: [
        { env: 'PORT', label: 'Port HTTP', value: config.port },
        { env: 'DB_PATH', label: 'Base SQLite', value: config.dbPath },
        { env: 'PUBLIC_URL', label: 'URL publique', value: config.publicUrl },
        { env: 'NODE_ENV', label: 'Environnement', value: process.env.NODE_ENV || 'development' },
      ],
    },
    {
      title: 'TMDB & Netflix',
      items: [
        { env: 'TMDB_API_KEY', label: 'Clé TMDB', value: config.tmdbKey ? hint(config.tmdbKey) : '', secret: true },
        { env: 'REGION', label: 'Région (fournisseurs TMDB)', value: config.region },
        { env: 'TMDB_LANG', label: 'Langue TMDB', value: config.lang },
        { env: 'NETFLIX_COUNTRY', label: 'Pays Netflix', value: config.netflixCountry },
      ],
    },
    {
      title: 'Synchronisation',
      items: [
        { env: 'SYNC_EVERY_HOURS', label: 'Cycle de synchro', value: `${config.syncEveryHours} h` },
        { env: 'SYNC_PAGES', label: 'Pages catalogue complet', value: config.syncPages },
        { env: 'RECENT_DAYS', label: 'Fenêtre dernières sorties', value: `${config.recentDays} jours` },
        { env: 'RECENT_PAGES', label: 'Pages dernières sorties', value: config.recentPages },
      ],
    },
    {
      title: 'Stremio',
      items: [
        { env: 'META_CACHE_SECONDS', label: 'Cache fiches/catalogues', value: `${config.metaCacheSeconds} s` },
        { env: 'TRAILER_PREFER', label: 'Bande-annonce préférée', value: config.trailerPrefer },
      ],
    },
    {
      title: 'Sécurité',
      items: [
        { env: 'ADMIN_TOKEN', label: 'Mot de passe dashboard', value: config.adminToken ? `•••••••• (${config.adminToken.length} car.)` : '', secret: true },
      ],
    },
  ].map((g) => ({
    ...g,
    items: g.items.map((it) => ({ ...it, fromEnv: fromEnv(it.env), set: it.secret ? !!it.value : true })),
  }));
}

module.exports = { HTML, configView };

require('dotenv').config();
const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
module.exports = {
  port: num(process.env.PORT, 7000),
  dbPath: process.env.DB_PATH || './data/netflix.db',
  tmdbKey: process.env.TMDB_API_KEY || '',
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${num(process.env.PORT, 7000)}`).replace(/\/+$/, ''),
  metaCacheSeconds: num(process.env.META_CACHE_SECONDS, 300),
  apiKey: process.env.API_KEY || '',
  upstreamUrl: (process.env.UPSTREAM_URL || '').replace(/\/+$/, ''),
  upstreamApiKey: process.env.UPSTREAM_API_KEY || '',
  adminToken: process.env.ADMIN_TOKEN || '',
  region: process.env.REGION || 'FR',
  lang: process.env.TMDB_LANG || 'fr-FR',
  netflixCountry: (process.env.NETFLIX_COUNTRY || 'fr').toLowerCase(),
  syncPages: num(process.env.SYNC_PAGES, 5),
  syncEveryHours: num(process.env.SYNC_EVERY_HOURS, 24),
  recentDays: num(process.env.RECENT_DAYS, 90),
  recentPages: num(process.env.RECENT_PAGES, 3),
  // Pays dont on moissonne le catalogue Netflix (l'ID Netflix est le même partout : on fait l'union, dédoublonnée).
  harvestCountries: (process.env.HARVEST_COUNTRIES || 'FR,US,GB,CA').toUpperCase(),
};

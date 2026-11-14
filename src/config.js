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
  // Bandes-annonces Apple TV (API web non documentée ; sf 143442 = France).
  appletvEnabled: process.env.APPLETV_ENABLED !== '0',
  appletvStorefront: num(process.env.APPLETV_STOREFRONT, 143442),
  appletvLocale: process.env.APPLETV_LOCALE || 'fr-FR',
  appletvCountry: (process.env.APPLETV_COUNTRY || 'fr').toLowerCase(),
  appletvApiVersion: num(process.env.APPLETV_API_VERSION, 84),
  // Paramètres du client web tv.apple.com (relevés dans le trafic du site ; Apple peut les faire évoluer).
  appletvUtscf: process.env.APPLETV_UTSCF || 'OjAAAAEAAAAAAAAAEAAAACMA',
  appletvUtsk: process.env.APPLETV_UTSK || '6e3013c6d6fae3c2::::::235656c069bb0efb',
  appletvMaxTrailers: num(process.env.APPLETV_MAX_TRAILERS, 2),
  appletvTimeoutMs: num(process.env.APPLETV_TIMEOUT_MS, 6000),
  harvestCountries: (process.env.HARVEST_COUNTRIES || 'FR,US,GB,CA').toUpperCase(),
};

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
  // Résolution à la demande (TMDB → recherche web → page Netflix) quand Stremio ouvre une fiche inconnue. Nécessite TMDB_API_KEY.
  resolveEnabled: process.env.RESOLVE_ENABLED !== '0',
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
  // Bandes-annonces HLS (Apple TV) recollées en MP4 dans un cache disque, pour qu'elles se lisent partout.
  hlsCacheDir: process.env.HLS_CACHE_DIR || './data/hls',
  hlsMaxHeight: num(process.env.HLS_MAX_HEIGHT, 720),      // hauteur maximale des variantes téléchargées
  hlsMaxMB: num(process.env.HLS_MAX_MB, 60),               // poids maximal estimé d'une bande-annonce
  hlsCacheDays: num(process.env.HLS_CACHE_DAYS, 7),        // au-delà, la conversion est refaite
  hlsTimeoutMs: num(process.env.HLS_TIMEOUT_MS, 30000),
  harvestCountries: (process.env.HARVEST_COUNTRIES || 'FR,US,GB,CA').toUpperCase(),
  // Recherche web des fiches Netflix : Brave Search si une clé est fournie, sinon DuckDuckGo (sans clé).
  braveApiKey: process.env.BRAVE_API_KEY || '',
  braveCountry: (process.env.BRAVE_COUNTRY || process.env.REGION || 'FR').toUpperCase(),
  braveLang: (process.env.BRAVE_LANG || String(process.env.TMDB_LANG || 'fr-FR').slice(0, 2)).toLowerCase(),
  // Plateformes dont on liste le catalogue dans TMDB : 8 = Netflix, 337 = Apple TV+, 2 = Apple TV,
  // 119 = Prime Video, « all » = aucune filtre (tout TMDB, plusieurs centaines de milliers de titres).
  catalogProviders: (process.env.CATALOG_PROVIDERS || '8,337').trim(),
  // Proposer AUSSI la vidéo YouTube de TMDB quand une bande-annonce Netflix/Apple existe.
  // Netflix ne sert ses bandes-annonces qu'en 768x432 ; YouTube monte à 1080p, mais se joue via
  // l'intégration YouTube de Stremio (clé `ytId`), pas comme un fichier relayé par ce serveur.
  // '1' / '0' (chaîne) pour que le réglage du dashboard affiche la bonne valeur.
  youtubeAsSource: process.env.YOUTUBE_AS_SOURCE === '1' ? '1' : '0',
};

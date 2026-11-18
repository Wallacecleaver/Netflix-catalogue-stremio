require('dotenv').config();
const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
module.exports = {
  port: num(process.env.PORT, 7000),
  dbPath: process.env.DB_PATH || './data/stockage.db',
  tmdbKey: process.env.TMDB_API_KEY || '',
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${num(process.env.PORT, 7000)}`).replace(/\/+$/, ''),
  apiKey: process.env.API_KEY || '',
  // API de fédération ouverte uniquement sur demande explicite (sinon une clé est obligatoire).
  allowOpenApi: process.env.ALLOW_OPEN_API === '1',
  upstreamUrl: (process.env.UPSTREAM_URL || '').replace(/\/+$/, ''),
  upstreamApiKey: process.env.UPSTREAM_API_KEY || '',
  adminToken: process.env.ADMIN_TOKEN || '',
  // Nombre de reverse proxies de confiance devant l'app ('loopback' = comportement historique).
  trustProxy: (() => {
    const raw = process.env.TRUST_PROXY_HOPS;
    if (raw === undefined || raw === '') return 'loopback';
    if (raw === '0' || raw === 'false') return false;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : 'loopback';
  })(),
  region: process.env.REGION || 'FR',
  lang: process.env.TMDB_LANG || 'fr-FR',
  netflixCountry: (process.env.NETFLIX_COUNTRY || 'fr').toLowerCase(),
  syncPages: num(process.env.SYNC_PAGES, 5),
  syncEveryHours: num(process.env.SYNC_EVERY_HOURS, 24),
  recentDays: num(process.env.RECENT_DAYS, 90),
  recentPages: num(process.env.RECENT_PAGES, 3),
  // Résolution à la demande (TMDB → recherche web → page Netflix) lors d'un appel /api/trailers sur un ID IMDb inconnu. Nécessite TMDB_API_KEY.
  resolveEnabled: process.env.RESOLVE_ENABLED !== '0',
  // Relecture automatique d'une page Netflix déjà connue au bout de N heures (détecte les nouveaux teasers/saisons).
  netflixRefreshEnabled: process.env.NETFLIX_REFRESH !== '0',
  netflixRefreshHours: num(process.env.NETFLIX_REFRESH_HOURS, 4),
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
  // Bandes-annonces HLS (Apple TV / liens manuels) recollées en MP4 dans un cache disque, pour qu'elles se lisent partout.
  hlsCacheDir: process.env.HLS_CACHE_DIR || './data/hls',
  hlsMaxHeight: num(process.env.HLS_MAX_HEIGHT, 720),      // hauteur maximale des variantes téléchargées
  hlsMaxMB: num(process.env.HLS_MAX_MB, 60),               // poids maximal estimé d'une bande-annonce
  hlsCacheDays: num(process.env.HLS_CACHE_DAYS, 7),        // au-delà, la conversion est refaite
  hlsMaxDiskMB: num(process.env.HLS_MAX_DISK_MB, 2048),    // plafond du cache disque
  hlsMaxConcurrent: num(process.env.HLS_MAX_CONCURRENT, 2), // conversions ffmpeg simultanées max
  hlsTimeoutMs: num(process.env.HLS_TIMEOUT_MS, 30000),
  harvestCountries: (process.env.HARVEST_COUNTRIES || 'FR,US,GB,CA').toUpperCase(),
  // Recherche web des fiches Netflix : Brave Search si une clé est fournie, sinon DuckDuckGo (sans clé).
  braveApiKey: process.env.BRAVE_API_KEY || '',
  braveCountry: (process.env.BRAVE_COUNTRY || process.env.REGION || 'FR').toUpperCase(),
  braveLang: (process.env.BRAVE_LANG || String(process.env.TMDB_LANG || 'fr-FR').slice(0, 2)).toLowerCase(),
  // Plateformes dont on liste le catalogue dans TMDB : 8 = Netflix, 337 = Apple TV+, 2 = Apple TV,
  // 119 = Prime Video, « all » = aucun filtre (tout TMDB, plusieurs centaines de milliers de titres).
  catalogProviders: (process.env.CATALOG_PROVIDERS || '8,337').trim(),
  // Dernier recours quand TMDB ne fournit aucune bande-annonce : recherche YouTube (sans clé API).
  // '0' pour désactiver (YouTube peut bloquer un serveur trop bavard).
  youtubeSearchEnabled: process.env.YOUTUBE_SEARCH === '0' ? '0' : '1',
};

require('dotenv').config();
const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
module.exports = {
  port: num(process.env.PORT, 7000),
  dbPath: process.env.DB_PATH || './data/netflix.db',
  tmdbKey: process.env.TMDB_API_KEY || '',
  adminToken: process.env.ADMIN_TOKEN || '',
  region: process.env.REGION || 'FR',
  lang: process.env.TMDB_LANG || 'fr-FR',
  netflixCountry: (process.env.NETFLIX_COUNTRY || 'fr').toLowerCase(),
  syncPages: num(process.env.SYNC_PAGES, 5),
  syncEveryHours: num(process.env.SYNC_EVERY_HOURS, 24),
};

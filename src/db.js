const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });
const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS titles (
  id TEXT PRIMARY KEY,
  netflix_id TEXT,
  tmdb_id INTEGER,
  tmdb_type TEXT,
  imdb_id TEXT,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  year INTEGER,
  release_date TEXT,
  certification TEXT,
  genres_json TEXT,
  synopsis TEXT,
  cast_json TEXT,
  poster TEXT,
  background TEXT,
  logo TEXT,
  trailer_yt TEXT,
  runtime INTEGER,
  enriched INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_titles_type ON titles(type);
CREATE INDEX IF NOT EXISTS idx_titles_release ON titles(type, release_date);
CREATE INDEX IF NOT EXISTS idx_titles_tmdb ON titles(tmdb_type, tmdb_id);
CREATE TABLE IF NOT EXISTS episodes (
  title_id TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  season INTEGER NOT NULL,
  episode INTEGER NOT NULL,
  name TEXT,
  synopsis TEXT,
  image TEXT,
  runtime INTEGER,
  released TEXT,
  PRIMARY KEY (title_id, season, episode)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

for (const col of ['extra_json', 'trailers_json']) {
  try { db.exec(`ALTER TABLE titles ADD COLUMN ${col} TEXT`); } catch { /* déjà présente */ }
}

const FIELDS = ['netflix_id', 'tmdb_id', 'tmdb_type', 'imdb_id', 'type', 'name', 'year', 'release_date',
  'certification', 'genres_json', 'synopsis', 'cast_json', 'poster', 'background', 'logo', 'trailer_yt', 'runtime', 'extra_json', 'trailers_json'];

const upsertSql = db.prepare(`
INSERT INTO titles (id, ${FIELDS.join(',')}, enriched, added_at, updated_at)
VALUES (@id, ${FIELDS.map((f) => '@' + f).join(',')}, @enriched, @now, @now)
ON CONFLICT(id) DO UPDATE SET
  ${FIELDS.map((f) => `${f}=COALESCE(excluded.${f}, titles.${f})`).join(',\n  ')},
  enriched=MAX(titles.enriched, excluded.enriched),
  updated_at=excluded.updated_at
`);

function upsertTitle(t) {
  const row = { id: t.id, now: Date.now(), enriched: t.enriched ? 1 : 0 };
  for (const f of FIELDS) row[f] = null;
  for (const [k, v] of Object.entries(t)) {
    if (k === 'genres') row.genres_json = Array.isArray(v) && v.length ? JSON.stringify(v) : null;
    else if (k === 'cast') row.cast_json = Array.isArray(v) && v.length ? JSON.stringify(v) : null;
    else if (k === 'extra') row.extra_json = v ? JSON.stringify(v) : null;
    else if (k === 'trailers') row.trailers_json = Array.isArray(v) && v.length ? JSON.stringify(v) : null;
    else if (FIELDS.includes(k)) row[k] = v === undefined ? null : v;
  }
  upsertSql.run(row);
}

const parse = (r) => r && ({ ...r, genres: JSON.parse(r.genres_json || '[]'), cast: JSON.parse(r.cast_json || '[]'),
  extra: JSON.parse(r.extra_json || '{}'), trailers: JSON.parse(r.trailers_json || '[]') });

const getTitle = (id) => parse(db.prepare('SELECT * FROM titles WHERE id = ?').get(id));
const getEpisodes = (id) => db.prepare('SELECT * FROM episodes WHERE title_id = ? ORDER BY season, episode').all(id);
const findByTmdb = (tmdbType, tmdbId) => db.prepare('SELECT id FROM titles WHERE tmdb_type = ? AND tmdb_id = ?').get(tmdbType, tmdbId);
const count = () => db.prepare('SELECT COUNT(*) c FROM titles').get().c;

const insEp = db.prepare(`INSERT INTO episodes (title_id, season, episode, name, synopsis, image, runtime, released)
  VALUES (@title_id, @season, @episode, @name, @synopsis, @image, @runtime, @released)`);
const replaceEpisodes = db.transaction((titleId, eps) => {
  db.prepare('DELETE FROM episodes WHERE title_id = ?').run(titleId);
  for (const e of eps) {
    insEp.run({ title_id: titleId, season: e.season, episode: e.episode, name: e.name ?? null,
      synopsis: e.synopsis ?? null, image: e.image ?? null, runtime: e.runtime ?? null, released: e.released ?? null });
  }
});

// Un titre ajouté depuis Netflix remplace la ligne "découverte TMDB" équivalente (évite les doublons)
function deleteDuplicates(tmdbType, tmdbId, keepId) {
  db.prepare('DELETE FROM titles WHERE tmdb_type = ? AND tmdb_id = ? AND id != ?').run(tmdbType, tmdbId, keepId);
}

function listCatalog({ type, genre, search, skip = 0, limit = 100 }) {
  const where = ['type = @type'];
  const p = { type, skip, limit };
  if (genre) { where.push('genres_json LIKE @genre'); p.genre = `%"${genre}"%`; }
  if (search) { where.push('name LIKE @search'); p.search = `%${search}%`; }
  return db.prepare(`SELECT * FROM titles WHERE ${where.join(' AND ')}
    ORDER BY (netflix_id IS NOT NULL) DESC, COALESCE(release_date, year || '-01-01', '') DESC, added_at DESC
    LIMIT @limit OFFSET @skip`).all(p).map(parse);
}

// Sorties récentes : déjà sorties (date <= aujourd'hui) et pas plus vieilles que `days`.
function listRecent({ type, genre, skip = 0, limit = 100, days = config.recentDays }) {
  const day = 86400000;
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const since = new Date(now - days * day).toISOString().slice(0, 10);
  const where = ['type = @type', 'release_date IS NOT NULL', 'release_date <= @today', 'release_date >= @since'];
  const p = { type, today, since, skip, limit };
  if (genre) { where.push('genres_json LIKE @genre'); p.genre = `%"${genre}"%`; }
  return db.prepare(`SELECT * FROM titles WHERE ${where.join(' AND ')}
    ORDER BY release_date DESC, added_at DESC
    LIMIT @limit OFFSET @skip`).all(p).map(parse);
}

// Chiffres affichés dans le dashboard (aucune donnée sensible).
function stats({ days = config.recentDays } = {}) {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const since = new Date(now - days * 86400000).toISOString().slice(0, 10);
  const byType = Object.fromEntries(db.prepare('SELECT type, COUNT(*) c FROM titles GROUP BY type').all().map((r) => [r.type, r.c]));
  const recent = Object.fromEntries(db.prepare(`SELECT type, COUNT(*) c FROM titles
    WHERE release_date IS NOT NULL AND release_date BETWEEN @since AND @today GROUP BY type`).all({ since, today }).map((r) => [r.type, r.c]));
  const dbBytes = db.pragma('page_count', { simple: true }) * db.pragma('page_size', { simple: true });
  return {
    total: (byType.movie || 0) + (byType.series || 0),
    movies: byType.movie || 0,
    series: byType.series || 0,
    enriched: db.prepare('SELECT COUNT(*) c FROM titles WHERE enriched = 1').get().c,
    netflixId: db.prepare('SELECT COUNT(*) c FROM titles WHERE netflix_id IS NOT NULL').get().c,
    episodes: db.prepare('SELECT COUNT(*) c FROM episodes').get().c,
    recent: { days, movies: recent.movie || 0, series: recent.series || 0 },
    dbBytes,
  };
}

// Paramètres surchargés depuis le dashboard (prioritaires sur le .env).
const allSettings = () => Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
const setSettings = db.transaction((entries) => {
  const now = Date.now();
  const up = db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
  for (const [k, v] of Object.entries(entries)) up.run(k, String(v), now);
});
const deleteSetting = (key) => db.prepare('DELETE FROM settings WHERE key = ?').run(key).changes;

module.exports = { db, upsertTitle, getTitle, getEpisodes, findByTmdb, count, replaceEpisodes, deleteDuplicates, listCatalog, listRecent, stats, allSettings, setSettings, deleteSetting };

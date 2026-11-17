const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

const resolvedDbPath = path.resolve(config.dbPath);
fs.mkdirSync(path.dirname(resolvedDbPath), { recursive: true });
// Migration transparente d'une installation existante (netflix.db → stockage.db).
if (path.basename(resolvedDbPath) === 'stockage.db' && !fs.existsSync(resolvedDbPath)) {
  const legacyDbPath = path.join(path.dirname(resolvedDbPath), 'netflix.db');
  if (fs.existsSync(legacyDbPath)) {
    for (const ext of ['', '-wal', '-shm']) {
      if (fs.existsSync(legacyDbPath + ext)) fs.renameSync(legacyDbPath + ext, resolvedDbPath + ext);
    }
  }
}
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
CREATE INDEX IF NOT EXISTS idx_titles_imdb ON titles(imdb_id);
CREATE INDEX IF NOT EXISTS idx_titles_netflix ON titles(netflix_id);
CREATE INDEX IF NOT EXISTS idx_titles_added ON titles(added_at DESC);
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
CREATE TABLE IF NOT EXISTS lookups (
  imdb TEXT PRIMARY KEY,
  checked_at INTEGER NOT NULL,
  found INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  source TEXT,
  message TEXT NOT NULL,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts DESC);
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  last4 TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT 'trailers:read',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
`);

for (const col of ['extra_json TEXT', 'trailers_json TEXT', 'vf_trailer TEXT', 'vf_checked INTEGER', 'appletv_json TEXT', 'appletv_checked INTEGER', 'trailers_checked INTEGER', 'link_checked INTEGER']) {
  try { db.exec(`ALTER TABLE titles ADD COLUMN ${col}`); } catch { /* déjà présente */ }
}
db.exec('CREATE INDEX IF NOT EXISTS idx_titles_vf ON titles(vf_trailer)');
db.exec('CREATE INDEX IF NOT EXISTS idx_titles_name ON titles(type, name COLLATE NOCASE)');

// vf_trailer = clé YouTube de la bande-annonce en français (TMDB) ; vf_checked = date de la dernière vérification.
const FIELDS = ['netflix_id', 'tmdb_id', 'tmdb_type', 'imdb_id', 'type', 'name', 'year', 'release_date',
  'certification', 'genres_json', 'synopsis', 'cast_json', 'poster', 'background', 'logo', 'trailer_yt', 'runtime', 'extra_json', 'trailers_json',
  'vf_trailer', 'vf_checked', 'appletv_json', 'appletv_checked', 'trailers_checked', 'link_checked'];

const upsertSql = db.prepare(`
INSERT INTO titles (id, ${FIELDS.join(',')}, enriched, added_at, updated_at)
VALUES (@id, ${FIELDS.map((f) => '@' + f).join(',')}, @enriched, @now, @now)
ON CONFLICT(id) DO UPDATE SET
  ${FIELDS.map((f) => `${f}=COALESCE(excluded.${f}, titles.${f})`).join(',\n  ')},
  enriched=MAX(titles.enriched, excluded.enriched),
  updated_at=excluded.updated_at
`);

// Les stats (≈ 30 COUNT) sont mises en cache 5 s ; toute écriture sur les fiches les invalide.
let statsCache = null;
const invalidateStats = () => { statsCache = null; };

function upsertTitle(t) {
  invalidateStats();
  const row = { id: t.id, now: Date.now(), enriched: t.enriched ? 1 : 0 };
  for (const f of FIELDS) row[f] = null;
  for (const [k, v] of Object.entries(t)) {
    if (k === 'genres') row.genres_json = Array.isArray(v) && v.length ? JSON.stringify(v) : null;
    else if (k === 'cast') row.cast_json = Array.isArray(v) && v.length ? JSON.stringify(v) : null;
    else if (k === 'extra') row.extra_json = v ? JSON.stringify(v) : null;
    else if (k === 'appletv') row.appletv_json = Array.isArray(v) && v.length ? JSON.stringify(v) : null;
    else if (k === 'trailers') row.trailers_json = Array.isArray(v) && v.length ? JSON.stringify(v) : null;
    else if (FIELDS.includes(k)) row[k] = v === undefined ? null : v;
  }
  upsertSql.run(row);
}

const parse = (r) => r && ({ ...r, genres: JSON.parse(r.genres_json || '[]'), cast: JSON.parse(r.cast_json || '[]'),
  extra: JSON.parse(r.extra_json || '{}'), trailers: JSON.parse(r.trailers_json || '[]'), appletv: JSON.parse(r.appletv_json || '[]') });

const getTitle = (id) => parse(db.prepare('SELECT * FROM titles WHERE id = ?').get(id));
const getEpisodes = (id) => db.prepare('SELECT * FROM episodes WHERE title_id = ? ORDER BY season, episode').all(id);
const findByTmdb = (tmdbType, tmdbId) => db.prepare('SELECT id FROM titles WHERE tmdb_type = ? AND tmdb_id = ?').get(tmdbType, tmdbId);
const findByImdbId = (imdbId) => parse(db.prepare(
  'SELECT * FROM titles WHERE imdb_id = ? ORDER BY enriched DESC, added_at ASC LIMIT 1').get(String(imdbId)));
const findByName = (name, type) => parse(db.prepare(
  'SELECT * FROM titles WHERE type = ? AND name = ? COLLATE NOCASE ORDER BY enriched DESC, added_at ASC LIMIT 1').get(type, String(name)));
// Cache des recherches automatiques (resolve.js) : quand un IMDb a été cherché, et si une bande-annonce a été trouvée.
const getLookup = (imdb) => db.prepare('SELECT * FROM lookups WHERE imdb = ?').get(String(imdb));
const setLookup = (imdb, found) => { invalidateStats(); return db.prepare(`INSERT INTO lookups (imdb, checked_at, found) VALUES (?, ?, ?)
  ON CONFLICT(imdb) DO UPDATE SET checked_at = excluded.checked_at, found = excluded.found`).run(String(imdb), Date.now(), found ? 1 : 0); };
const count = () => db.prepare('SELECT COUNT(*) c FROM titles').get().c;

// L'ID Netflix n'est pas toujours l'ID Stremio (`nflx:tv-123`) : on retrouve la fiche par `netflix_id`.
const findByNetflixId = (netflixId) => parse(db.prepare(
  'SELECT * FROM titles WHERE netflix_id = ? ORDER BY enriched DESC, added_at ASC LIMIT 1').get(String(netflixId)));

/**
 * Titres pas encore associés à un ID Netflix (les plus récents d'abord).
 * `link_checked` évite de rejouer indéfiniment les mêmes échecs : les titres Apple TV+ arrivés par la
 * synchro TMDB ne sont pas sur Netflix, et sans ce marqueur le liage les retentait à chaque passage.
 */
const unlinkedWhere = '(netflix_id IS NULL AND (link_checked IS NULL OR link_checked < @before))';
function listUnlinked({ limit = 0, retryDays = 30 } = {}) {
  const p = { before: Date.now() - retryDays * 86400000 };
  if (limit > 0) p.limit = limit;
  const sql = `SELECT * FROM titles WHERE ${unlinkedWhere}
    ORDER BY COALESCE(release_date, '') DESC, added_at DESC${limit > 0 ? ' LIMIT @limit' : ''}`;
  return db.prepare(sql).all(p).map(parse);
}

// Titres liés à un ID Netflix mais dont la page n'a jamais été lue (ou sans bande-annonce depuis `retryDays`).
// C'est le gisement principal : le moissonnage donne les IDs, seule la lecture des pages donne les vidéos.
const netflixTrailerPendingWhere = `(netflix_id IS NOT NULL
  AND (trailers_json IS NULL OR trailers_json IN ('', '[]'))
  AND (trailers_checked IS NULL OR trailers_checked < @before))`;
function listNetflixTrailerPending({ limit = 0, retryDays = 7 } = {}) {
  const p = { before: Date.now() - retryDays * 86400000 };
  if (limit > 0) p.limit = limit;
  const sql = `SELECT * FROM titles WHERE ${netflixTrailerPendingWhere}
    ORDER BY COALESCE(release_date, '') DESC, added_at DESC${limit > 0 ? ' LIMIT @limit' : ''}`;
  return db.prepare(sql).all(p).map(parse);
}

// Titres dont la bande-annonce VF n'a pas encore été cherchée (ou sans résultat depuis plus de `retryDays` jours).
const vfPendingWhere = '(vf_checked IS NULL OR (vf_trailer IS NULL AND vf_checked < @before))';
function listVfPending({ limit = 0, retryDays = 14 } = {}) {
  const p = { before: Date.now() - retryDays * 86400000 };
  if (limit > 0) p.limit = limit;
  const sql = `SELECT * FROM titles WHERE ${vfPendingWhere}
    ORDER BY (tmdb_id IS NULL), COALESCE(release_date, '') DESC, added_at DESC${limit > 0 ? ' LIMIT @limit' : ''}`;
  return db.prepare(sql).all(p).map(parse);
}

/** Tous les IDs Netflix stockés avec leur nom + correspondances TMDB/IMDb (export dashboard). */
const listLinked = () => db.prepare(`SELECT netflix_id, name, type, year, tmdb_type, tmdb_id, imdb_id
  FROM titles WHERE netflix_id IS NOT NULL ORDER BY name`).all();

/** Supprime les doublons d'un même ID Netflix (garde la fiche dont l'ID Stremio est déjà connu des utilisateurs). */
function deleteNetflixDuplicates(netflixId, keepId) {
  invalidateStats();
  return db.prepare('DELETE FROM titles WHERE id != ? AND (netflix_id = ? OR id = ?)')
    .run(keepId, String(netflixId), `nflx:${netflixId}`).changes;
}

const insEp = db.prepare(`INSERT INTO episodes (title_id, season, episode, name, synopsis, image, runtime, released)
  VALUES (@title_id, @season, @episode, @name, @synopsis, @image, @runtime, @released)`);
const replaceEpisodes = db.transaction((titleId, eps) => {
  invalidateStats();
  db.prepare('DELETE FROM episodes WHERE title_id = ?').run(titleId);
  for (const e of eps) {
    insEp.run({ title_id: titleId, season: e.season, episode: e.episode, name: e.name ?? null,
      synopsis: e.synopsis ?? null, image: e.image ?? null, runtime: e.runtime ?? null, released: e.released ?? null });
  }
});

// Un titre ajouté depuis Netflix remplace la ligne "découverte TMDB" équivalente (évite les doublons)
function deleteDuplicates(tmdbType, tmdbId, keepId) {
  invalidateStats();
  db.prepare('DELETE FROM titles WHERE tmdb_type = ? AND tmdb_id = ? AND id != ?').run(tmdbType, tmdbId, keepId);
}

// Conditions SQL « ce titre a une bande-annonce de telle source ».
const TR = {
  netflix: "(trailers_json IS NOT NULL AND trailers_json NOT IN ('', '[]'))",
  apple: "(appletv_json IS NOT NULL AND appletv_json NOT IN ('', '[]'))",
};
TR.any = `(${TR.netflix} OR ${TR.apple})`;

// Titres dont les bandes-annonces Apple TV n'ont pas encore été cherchées (ou sans résultat depuis plus de `retryDays` jours).
const appletvPendingWhere = '(appletv_checked IS NULL OR (appletv_json IS NULL AND appletv_checked < @before))';
function listAppletvPending({ limit = 0, retryDays = 7 } = {}) {
  const p = { before: Date.now() - retryDays * 86400000 };
  if (limit > 0) p.limit = limit;
  return db.prepare(`SELECT * FROM titles WHERE ${appletvPendingWhere}
    ORDER BY COALESCE(release_date, '') DESC, added_at DESC${limit > 0 ? ' LIMIT @limit' : ''}`).all(p).map(parse);
}

/** Liste paginée pour l'onglet « Titres » : filtre par source de bande-annonce (none = aucune) et recherche par nom. */
function listTitles({ search = '', filter = '', limit = 50, offset = 0 } = {}) {
  const where = ['1 = 1'];
  const p = {};
  if (search) { where.push('name LIKE @search'); p.search = `%${search}%`; }
  if (filter === 'none') where.push(`NOT ${TR.any}`);
  else if (TR[filter]) where.push(TR[filter]);
  const w = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) c FROM titles WHERE ${w}`).get(p).c;
  const rows = db.prepare(`SELECT * FROM titles WHERE ${w} ORDER BY added_at DESC, name LIMIT @limit OFFSET @offset`)
    .all({ ...p, limit, offset }).map(parse);
  return { total, rows };
}

// Chiffres affichés dans le dashboard (aucune donnée sensible).
function stats() {
  if (statsCache && Date.now() - statsCache.at < 5000) return statsCache.value;
  const value = computeStats();
  statsCache = { at: Date.now(), value };
  return value;
}
function computeStats() {
  const byType = Object.fromEntries(db.prepare('SELECT type, COUNT(*) c FROM titles GROUP BY type').all().map((r) => [r.type, r.c]));
  const dbBytes = db.pragma('page_count', { simple: true }) * db.pragma('page_size', { simple: true });
  return {
    total: (byType.movie || 0) + (byType.series || 0),
    movies: byType.movie || 0,
    series: byType.series || 0,
    enriched: db.prepare('SELECT COUNT(*) c FROM titles WHERE enriched = 1').get().c,
    netflixId: db.prepare('SELECT COUNT(*) c FROM titles WHERE netflix_id IS NOT NULL').get().c,
    unlinked: db.prepare(`SELECT COUNT(*) c FROM titles WHERE ${unlinkedWhere}`).get({ before: Date.now() - 30 * 86400000 }).c,
    withImdb: db.prepare('SELECT COUNT(*) c FROM titles WHERE imdb_id IS NOT NULL').get().c,
    vfChecked: db.prepare('SELECT COUNT(*) c FROM titles WHERE vf_checked IS NOT NULL').get().c,
    vfPending: db.prepare(`SELECT COUNT(*) c FROM titles WHERE ${vfPendingWhere}`).get({ before: Date.now() - 14 * 86400000 }).c,
    logs: db.prepare('SELECT COUNT(*) c FROM logs').get().c,
    logErrors: db.prepare("SELECT COUNT(*) c FROM logs WHERE level = 'error'").get().c,
    episodes: db.prepare('SELECT COUNT(*) c FROM episodes').get().c,
    lookups: db.prepare('SELECT COUNT(*) c FROM lookups').get().c,
    lookupsFound: db.prepare('SELECT COUNT(*) c FROM lookups WHERE found = 1').get().c,
    withTrailer: db.prepare(`SELECT COUNT(*) c FROM titles WHERE ${TR.any}`).get().c,
    withNetflixTrailer: db.prepare(`SELECT COUNT(*) c FROM titles WHERE ${TR.netflix}`).get().c,
    withAppletv: db.prepare(`SELECT COUNT(*) c FROM titles WHERE ${TR.apple}`).get().c,
    // Bandes-annonces YouTube (TMDB) réellement utilisées : celles des titres sans flux Netflix/Apple,
    // puisque c'est la seule source qui reste affichée dans ce cas.
    withYoutube: db.prepare(`SELECT COUNT(*) c FROM titles
      WHERE ((vf_trailer IS NOT NULL AND vf_trailer <> '') OR (trailer_yt IS NOT NULL AND trailer_yt <> ''))
        AND NOT ${TR.netflix} AND NOT ${TR.apple}`).get().c,
    // Couverture réelle toutes sources confondues : Netflix/Apple d'un côté, YouTube de l'autre
    // (ces deux ensembles sont disjoints : withYoutube exclut les titres déjà couverts).
    withVideo: db.prepare(`SELECT COUNT(*) c FROM titles
      WHERE (${TR.any})
        OR (((vf_trailer IS NOT NULL AND vf_trailer <> '') OR (trailer_yt IS NOT NULL AND trailer_yt <> ''))
          AND NOT ${TR.netflix} AND NOT ${TR.apple})`).get().c,
    appletvChecked: db.prepare('SELECT COUNT(*) c FROM titles WHERE appletv_checked IS NOT NULL').get().c,
    appletvPending: db.prepare(`SELECT COUNT(*) c FROM titles WHERE ${appletvPendingWhere}`).get({ before: Date.now() - 7 * 86400000 }).c,
    netflixTrailerPending: db.prepare(`SELECT COUNT(*) c FROM titles WHERE ${netflixTrailerPendingWhere}`).get({ before: Date.now() - 7 * 86400000 }).c,
    dbBytes,
  };
}

/** Supprime une fiche (les épisodes partent avec : ON DELETE CASCADE). */
function deleteTitle(id) {
  invalidateStats();
  return db.prepare('DELETE FROM titles WHERE id = ?').run(String(id)).changes;
}

/** Remet à zéro les marqueurs « déjà cherché » : la fiche sera re-cherchée à sa prochaine ouverture (ou au prochain lot). */
function resetChecks(id) {
  invalidateStats();
  const row = getTitle(id);
  if (!row) return false;
  db.prepare('UPDATE titles SET vf_checked = NULL, appletv_checked = NULL, trailers_checked = NULL, link_checked = NULL, updated_at = ? WHERE id = ?').run(Date.now(), id);
  if (row.imdb_id) db.prepare('DELETE FROM lookups WHERE imdb = ?').run(row.imdb_id);
  return true;
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

// ---- Clés API de fédération : seule l'empreinte SHA-256 est stockée (la clé n'est montrée qu'à la création) ----
const listApiKeys = () => db.prepare('SELECT id, label, last4, scopes, created_at, last_used_at FROM api_keys ORDER BY id').all();
const countApiKeys = () => db.prepare('SELECT COUNT(*) c FROM api_keys').get().c;
const createApiKey = ({ label, hash, last4, scopes = 'trailers:read' }) => Number(db.prepare(
  'INSERT INTO api_keys (label, key_hash, last4, scopes, created_at) VALUES (?, ?, ?, ?, ?)').run(label, hash, last4, scopes, Date.now()).lastInsertRowid);
const deleteApiKey = (id) => db.prepare('DELETE FROM api_keys WHERE id = ?').run(Number(id)).changes;
const findApiKey = (hash) => db.prepare('SELECT id, label, scopes FROM api_keys WHERE key_hash = ?').get(String(hash));
// « Dernière utilisation » : une écriture par minute et par clé au plus (l'API peut être très sollicitée).
const touchApiKey = (id) => db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)')
  .run(Date.now(), Number(id), Date.now() - 60000);

// ---- Journal d'événements (erreurs liage/synchro/relais, actions admin…) ----
const LOG_KEEP = 2000;
function addLog({ level = 'info', source = null, message, meta = null }) {
  db.prepare('INSERT INTO logs (ts, level, source, message, meta) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), level, source || null, String(message ?? ''), meta ? JSON.stringify(meta) : null);
  db.prepare('DELETE FROM logs WHERE id <= (SELECT COALESCE(MAX(id), 0) - ? FROM logs)').run(LOG_KEEP);
}
function listLogs({ level = '', search = '', limit = 200, offset = 0 } = {}) {
  const where = [];
  const p = { limit: Math.min(Number(limit) || 200, 500), offset: Math.max(Number(offset) || 0, 0) };
  if (level) { where.push('level = @level'); p.level = level; }
  if (search) { where.push('(message LIKE @like OR source LIKE @like)'); p.like = `%${search}%`; }
  const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM logs ${cond}`).get(p).c;
  const logs = db.prepare(`SELECT * FROM logs ${cond} ORDER BY id DESC LIMIT @limit OFFSET @offset`).all(p)
    .map((r) => ({ ...r, meta: JSON.parse(r.meta || 'null') }));
  return { total, logs };
}
const clearLogs = () => db.prepare('DELETE FROM logs').run().changes;

module.exports = { db, upsertTitle, getTitle, getEpisodes, findByTmdb, findByImdbId, findByNetflixId, findByName, getLookup, setLookup, listUnlinked, listLinked, listVfPending,
  listNetflixTrailerPending, deleteNetflixDuplicates, count, replaceEpisodes, deleteDuplicates, listAppletvPending, listTitles, stats,
  allSettings, setSettings, deleteSetting, deleteTitle, resetChecks,
  listApiKeys, countApiKeys, createApiKey, deleteApiKey, findApiKey, touchApiKey, addLog, listLogs, clearLogs };

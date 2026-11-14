const config = require('./config');
const store = require('./db');

// Valeurs initiales (.env puis défauts de config.js), avant surcharge par le dashboard.
const BASE = { ...config };

const trim = (v) => String(v).trim();
const stripSlash = (v) => String(v).trim().replace(/\/+$/, '');
const lower = (v) => String(v).trim().toLowerCase();
const upper = (v) => String(v).trim().toUpperCase();
const countryList = (v) => {
  const list = String(v).split(/[\s,;]+/).map((c) => c.toUpperCase()).filter(Boolean);
  if (!list.length || list.some((c) => !/^[A-Z]{2}$/.test(c))) throw new Error('HARVEST_COUNTRIES : codes pays à 2 lettres séparés par des virgules (ex. FR,US,GB)');
  return [...new Set(list)].join(',');
};

// Toutes les variables éditables depuis /admin → onglet Paramètres.
const DEFS = [
  { key: 'PORT', prop: 'port', label: 'Port HTTP', group: 'Serveur', type: 'number', min: 1, max: 65535, restart: true },
  { key: 'DB_PATH', prop: 'dbPath', label: 'Base SQLite', group: 'Serveur', type: 'text', restart: true },
  { key: 'PUBLIC_URL', prop: 'publicUrl', label: 'URL publique', group: 'Serveur', type: 'text', normalize: stripSlash },
  { key: 'TMDB_API_KEY', prop: 'tmdbKey', label: 'Clé TMDB', group: 'TMDB & Netflix', type: 'password', secret: true },
  { key: 'REGION', prop: 'region', label: 'Région TMDB', group: 'TMDB & Netflix', type: 'text', normalize: upper },
  { key: 'TMDB_LANG', prop: 'lang', label: 'Langue TMDB', group: 'TMDB & Netflix', type: 'text' },
  { key: 'NETFLIX_COUNTRY', prop: 'netflixCountry', label: 'Pays Netflix', group: 'TMDB & Netflix', type: 'text', normalize: lower },
  { key: 'SYNC_EVERY_HOURS', prop: 'syncEveryHours', label: 'Cycle de synchro (heures)', group: 'Synchronisation', type: 'number', min: 1, max: 720, restart: true },
  { key: 'SYNC_PAGES', prop: 'syncPages', label: 'Pages catalogue complet', group: 'Synchronisation', type: 'number', min: 1, max: 50 },
  { key: 'RECENT_DAYS', prop: 'recentDays', label: 'Fenêtre dernières sorties (jours)', group: 'Synchronisation', type: 'number', min: 1, max: 365 },
  { key: 'RECENT_PAGES', prop: 'recentPages', label: 'Pages dernières sorties', group: 'Synchronisation', type: 'number', min: 1, max: 50 },
  { key: 'HARVEST_COUNTRIES', prop: 'harvestCountries', label: 'Pays moissonnés (ex. FR,US,GB,CA)', group: 'Synchronisation', type: 'text', normalize: countryList },
  { key: 'META_CACHE_SECONDS', prop: 'metaCacheSeconds', label: 'Cache fiches/catalogues (s)', group: 'Stremio', type: 'number', min: 0, max: 86400 },
  { key: 'API_KEY', prop: 'apiKey', label: 'Clé API (sortie, vide = API ouverte)', group: 'API & fédération', type: 'password', secret: true, minLength: 6 },
  { key: 'UPSTREAM_URL', prop: 'upstreamUrl', label: 'Instance amont (URL)', group: 'API & fédération', type: 'text', normalize: stripSlash },
  { key: 'UPSTREAM_API_KEY', prop: 'upstreamApiKey', label: 'Clé API amont', group: 'API & fédération', type: 'password', secret: true },
  { key: 'ADMIN_TOKEN', prop: 'adminToken', label: 'Mot de passe du dashboard', group: 'Sécurité', type: 'password', secret: true, minLength: 4 },
];

const byKey = new Map(DEFS.map((d) => [d.key, d]));

function coerce(def, raw) {
  if (def.type === 'number') {
    const n = Number(String(raw).replace(',', '.'));
    if (!Number.isFinite(n)) throw new Error(`${def.key} : nombre attendu`);
    if (def.min != null && n < def.min) throw new Error(`${def.key} : minimum ${def.min}`);
    if (def.max != null && n > def.max) throw new Error(`${def.key} : maximum ${def.max}`);
    return n;
  }
  if (def.type === 'select') {
    const v = String(raw).trim().toLowerCase();
    if (!def.options.includes(v)) throw new Error(`${def.key} : valeurs possibles : ${def.options.join(', ')}`);
    return v;
  }
  let v = trim(raw);
  if (def.minLength && v.length < def.minLength) throw new Error(`${def.key} : ${def.minLength} caractères minimum`);
  if (def.normalize) v = def.normalize(v);
  if (!v) throw new Error(`${def.key} : valeur vide`);
  return v;
}

/** Recalcule la config effective : .env/défauts, puis surcharges enregistrées en base. */
function apply() {
  Object.assign(config, BASE);
  const saved = store.allSettings();
  for (const def of DEFS) {
    const raw = saved[def.key];
    if (raw === undefined || raw === '') continue;
    try { config[def.prop] = coerce(def, raw); } catch { /* valeur invalide en base : on garde le défaut */ }
  }
}

const sourceOf = (def, saved) => (saved[def.key] !== undefined && saved[def.key] !== '' ? 'dashboard'
  : (process.env[def.key] !== undefined && process.env[def.key] !== '' ? 'env' : 'default'));

/** Paramètres pour l'interface : valeurs effectives + provenance (secrets masqués). */
function view() {
  const saved = store.allSettings();
  const groups = new Map();
  for (const def of DEFS) {
    const current = config[def.prop];
    const hasValue = current !== undefined && current !== null && String(current) !== '';
    const item = {
      key: def.key, label: def.label, type: def.type, secret: !!def.secret,
      source: sourceOf(def, saved), needsRestart: !!def.restart,
      options: def.options, min: def.min, max: def.max,
      value: def.secret ? '' : (hasValue ? String(current) : ''),
      hasValue,
      hint: def.secret && hasValue ? `••••••••${String(current).slice(-2)}` : '',
    };
    if (!groups.has(def.group)) groups.set(def.group, []);
    groups.get(def.group).push(item);
  }
  return [...groups].map(([title, items]) => ({ title, items }));
}

/** Enregistre les surcharges (null/'' = retour au .env) puis recalcule la config. */
function save(values = {}) {
  const writes = {};
  const deletes = [];
  for (const [key, raw] of Object.entries(values)) {
    const def = byKey.get(key);
    if (!def) throw new Error(`Paramètre inconnu : ${key}`);
    if (raw === null || raw === '') deletes.push(key);
    else writes[key] = String(coerce(def, raw));
  }
  for (const key of deletes) {
    if (key === 'ADMIN_TOKEN' && !process.env.ADMIN_TOKEN) {
      throw new Error('Impossible de retirer ADMIN_TOKEN : aucune valeur de secours dans le .env (tu perdrais l\'accès au dashboard).');
    }
  }
  store.setSettings(writes);
  for (const key of deletes) store.deleteSetting(key);
  apply();
  const touched = new Set([...Object.keys(writes), ...deletes]);
  return { restart: DEFS.filter((d) => d.restart && touched.has(d.key)).map((d) => d.key), saved: Object.keys(writes), reset: deletes };
}

apply();

module.exports = { apply, view, save, DEFS };

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
  { key: 'PUBLIC_URL', prop: 'publicUrl', label: 'URL publique (utilisée dans les liens de relais /trailer et /apple)', group: 'Serveur', type: 'text', normalize: stripSlash },

  { key: 'TMDB_API_KEY', prop: 'tmdbKey', label: 'Clé TMDB', group: 'Sources & Catalogues', type: 'password', secret: true },
  { key: 'REGION', prop: 'region', label: 'Région TMDB / JustWatch (ex. FR)', group: 'Sources & Catalogues', type: 'text', normalize: upper },
  { key: 'TMDB_LANG', prop: 'lang', label: 'Langue préférée (ex. fr-FR)', group: 'Sources & Catalogues', type: 'text' },
  { key: 'NETFLIX_COUNTRY', prop: 'netflixCountry', label: 'Pays des pages Netflix (ex. fr)', group: 'Sources & Catalogues', type: 'text', normalize: lower },
  { key: 'RESOLVE_ENABLED', prop: 'resolveEnabled', label: 'Résolution automatique à la demande (IMDb → TMDB → Netflix)', group: 'Sources & Catalogues', type: 'select', options: ['1', '0'], bool: true },
  { key: 'NETFLIX_REFRESH', prop: 'netflixRefreshEnabled', label: 'Relecture automatique des pages Netflix périmées (nouvelles saisons/teasers)', group: 'Sources & Catalogues', type: 'select', options: ['1', '0'], bool: true },
  { key: 'NETFLIX_REFRESH_HOURS', prop: 'netflixRefreshHours', label: 'Âge avant relecture d\'une page Netflix (heures)', group: 'Sources & Catalogues', type: 'number', min: 1, max: 720 },
  { key: 'BRAVE_API_KEY', prop: 'braveApiKey', label: 'Clé Brave Search (secours recherche web Netflix)', group: 'Sources & Catalogues', type: 'password', secret: true },
  { key: 'BRAVE_COUNTRY', prop: 'braveCountry', label: 'Pays Brave Search', group: 'Sources & Catalogues', type: 'text', normalize: upper },
  { key: 'BRAVE_LANG', prop: 'braveLang', label: 'Langue Brave Search', group: 'Sources & Catalogues', type: 'text', normalize: lower },

  { key: 'APPLETV_ENABLED', prop: 'appletvEnabled', label: 'Activer Apple TV+ (recherche et extraction HLS)', group: 'Apple TV & Conversion HLS', type: 'select', options: ['1', '0'], bool: true },
  { key: 'APPLETV_COUNTRY', prop: 'appletvCountry', label: 'Pays Apple TV (ex. fr)', group: 'Apple TV & Conversion HLS', type: 'text', normalize: lower },
  { key: 'APPLETV_LOCALE', prop: 'appletvLocale', label: 'Locale Apple TV (ex. fr-FR)', group: 'Apple TV & Conversion HLS', type: 'text' },
  { key: 'APPLETV_MAX_TRAILERS', prop: 'appletvMaxTrailers', label: 'Nombre max de bandes-annonces Apple TV par fiche', group: 'Apple TV & Conversion HLS', type: 'number', min: 1, max: 10 },
  { key: 'HLS_MAX_HEIGHT', prop: 'hlsMaxHeight', label: 'Définition max HLS converti (px, ex. 720 ou 1080)', group: 'Apple TV & Conversion HLS', type: 'number', min: 360, max: 2160 },
  { key: 'HLS_MAX_MB', prop: 'hlsMaxMB', label: 'Poids max estimé par vidéo HLS (Mo)', group: 'Apple TV & Conversion HLS', type: 'number', min: 5, max: 500 },
  { key: 'HLS_CACHE_DAYS', prop: 'hlsCacheDays', label: 'Durée de conservation du cache MP4 (jours)', group: 'Apple TV & Conversion HLS', type: 'number', min: 1, max: 90 },
  { key: 'HLS_MAX_DISK_MB', prop: 'hlsMaxDiskMB', label: 'Plafond disque du cache HLS (Mo)', group: 'Apple TV & Conversion HLS', type: 'number', min: 100, max: 102400 },

  { key: 'SYNC_EVERY_HOURS', prop: 'syncEveryHours', label: 'Cycle de synchro TMDB (heures)', group: 'Synchronisation & Moissonnage', type: 'number', min: 1, max: 720, restart: true },
  { key: 'SYNC_PAGES', prop: 'syncPages', label: 'Pages catalogue TMDB complet', group: 'Synchronisation & Moissonnage', type: 'number', min: 1, max: 500 },
  { key: 'CATALOG_PROVIDERS', prop: 'catalogProviders', label: 'Plateformes TMDB (8=Netflix, 337=Apple TV+, 2=Apple TV, 119=Prime, all=tout)', group: 'Synchronisation & Moissonnage', type: 'text' },
  { key: 'RECENT_DAYS', prop: 'recentDays', label: 'Fenêtre dernières sorties TMDB (jours)', group: 'Synchronisation & Moissonnage', type: 'number', min: 1, max: 365 },
  { key: 'RECENT_PAGES', prop: 'recentPages', label: 'Pages dernières sorties TMDB', group: 'Synchronisation & Moissonnage', type: 'number', min: 1, max: 50 },
  { key: 'HARVEST_COUNTRIES', prop: 'harvestCountries', label: 'Pays moissonnés Netflix / JustWatch (ex. FR,US,GB,CA)', group: 'Synchronisation & Moissonnage', type: 'text', normalize: countryList },
  { key: 'YOUTUBE_SEARCH', prop: 'youtubeSearchEnabled', label: 'Chercher sur YouTube quand TMDB n\'a pas de vidéo (1 = oui, 0 = non)', group: 'Synchronisation & Moissonnage', type: 'select', options: ['1', '0'], bool: true },

  { key: 'API_KEY', prop: 'apiKey', label: 'Clé API héritée (optionnelle, préférer les clés nommées dans Fédération)', group: 'API & Fédération', type: 'password', secret: true, minLength: 16 },
  { key: 'UPSTREAM_URL', prop: 'upstreamUrl', label: 'Instance Stockage DB amont (URL)', group: 'API & Fédération', type: 'text', normalize: stripSlash },
  { key: 'UPSTREAM_API_KEY', prop: 'upstreamApiKey', label: 'Clé API de l\'instance amont', group: 'API & Fédération', type: 'password', secret: true },

  { key: 'ADMIN_TOKEN', prop: 'adminToken', label: 'Mot de passe du dashboard', group: 'Sécurité', type: 'password', secret: true, minLength: 16 },
];

const byKey = new Map(DEFS.map((d) => [d.key, d]));

function coerce(def, raw, { strict = false } = {}) {
  if (def.type === 'number') {
    const n = Number(String(raw).replace(',', '.'));
    if (!Number.isFinite(n)) throw new Error(`${def.key} : nombre attendu`);
    if (def.min != null && n < def.min) throw new Error(`${def.key} : minimum ${def.min}`);
    if (def.max != null && n > def.max) throw new Error(`${def.key} : maximum ${def.max}`);
    return n;
  }
  if (def.type === 'select') {
    const norm = raw === true ? '1' : raw === false ? '0' : String(raw).trim().toLowerCase();
    if (!def.options.includes(norm)) throw new Error(`${def.key} : valeurs possibles : ${def.options.join(', ')}`);
    return def.bool ? norm === '1' : norm;
  }
  let v = trim(raw);
  // La longueur minimale n'est imposée qu'à l'enregistrement (strict) : une valeur
  // ancienne déjà en base continue de fonctionner, sinon l'admin se verrouillerait dehors.
  if (strict && def.minLength && v.length < def.minLength) throw new Error(`${def.key} : ${def.minLength} caractères minimum`);
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
    const displayValue = def.bool ? (current ? '1' : '0') : (hasValue ? String(current) : '');
    const item = {
      key: def.key, label: def.label, type: def.type, secret: !!def.secret,
      source: sourceOf(def, saved), needsRestart: !!def.restart,
      options: def.options, min: def.min, max: def.max,
      value: def.secret ? '' : displayValue,
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
    else {
      const coerced = coerce(def, raw, { strict: true });
      writes[key] = def.bool ? (coerced ? '1' : '0') : String(coerced);
    }
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

if (config.adminToken && String(config.adminToken).length < 16) {
  console.warn('[sécurité] ADMIN_TOKEN fait moins de 16 caractères : change-le depuis l’onglet Paramètres du dashboard.');
}

module.exports = { apply, view, save, DEFS };

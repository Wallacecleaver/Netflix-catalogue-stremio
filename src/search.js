// Recherche web des fiches à ajouter.
//   Netflix  : Brave Search (JSON, clé BRAVE_API_KEY). Sans clé — ou si Brave est saturé — on retombe sur
//              DuckDuckGo (HTML), pour ne pas casser les installations existantes.
//   Apple TV : API iTunes Search (publique, sans clé) : l'URL `trackViewUrl` contient déjà l'ID `umc.cmc.*`
//              de tv.apple.com, avec le type (movie/show), le titre et la date de sortie.
const config = require('./config');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TIMEOUT_MS = 10000;

const decodeEnt = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
const strip = (s) => decodeEnt(String(s).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
// « Regarder Squid Game », « Squid Game | Netflix officiel », « Squid Game - Netflix » → « Squid Game »
const cleanTitle = (t) => t.replace(/^(Watch|Regarder)\s+/i, '').replace(/\s*[|\-–]\s*Netflix\b.*$/i, '').trim();
const NETFLIX_ID = /netflix\.com\/(?:[a-z]{2}(?:-[A-Za-z]{2})?\/)?title\/(\d+)/;

/** Résultats de recherche (URL + titre) → fiches Netflix candidates, dédoublonnées par ID. */
function netflixCandidates(results) {
  const out = [];
  const seen = new Set();
  for (const r of results || []) {
    const m = NETFLIX_ID.exec(String(r && r.url ? r.url : ''));
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({
      id: m[1],
      url: `https://www.netflix.com/title/${m[1]}`,
      title: cleanTitle(strip(String((r && r.title) || ''))) || null,
      snippet: strip(String((r && (r.description || r.snippet)) || '')).slice(0, 220),
    });
  }
  return out;
}

// ---- Netflix : Brave Search ----

/** Recherche web Brave. `fatal` = erreur de configuration (clé refusée) : inutile de retenter ailleurs. */
async function braveWeb(query, count = 20) {
  const params = new URLSearchParams({
    q: query,
    count: String(count),          // maximum de l'API : 20
    country: config.braveCountry,  // code pays ISO 3166-1 alpha-2 (FR par défaut)
    search_lang: config.braveLang, // langue des résultats (fr par défaut)
    safesearch: 'off',
  });
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: {
      accept: 'application/json',
      'accept-language': config.lang,
      'x-subscription-token': config.braveApiKey,
      'user-agent': UA,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) {
    const e = new Error(`Brave Search refuse la clé BRAVE_API_KEY (HTTP ${res.status}) : vérifie-la sur api.search.brave.com`);
    e.fatal = true;
    throw e;
  }
  if (res.status === 422) {
    const e = new Error('Brave Search refuse les paramètres (HTTP 422) : vérifie BRAVE_COUNTRY / BRAVE_LANG');
    e.fatal = true;
    throw e;
  }
  if (res.status === 429) { const e = new Error('Brave Search : quota atteint (HTTP 429)'); e.rateLimited = true; throw e; }
  if (!res.ok) throw new Error(`Brave Search HTTP ${res.status}`);
  const data = await res.json().catch(() => ({}));
  return (data && data.web && data.web.results) || [];
}

async function netflixBrave(query) {
  return netflixCandidates(await braveWeb(`site:netflix.com/title ${query}`)).slice(0, 8);
}

// ---- Netflix : secours DuckDuckGo (HTML) ----

/** HTML de html.duckduckgo.com → [{ id, url, title, snippet }] (dédoublonné par ID Netflix). */
function parse(html) {
  const out = [];
  const seen = new Set();
  for (const block of html.split(/class="result__a"/).slice(1)) {
    const href = /href="([^"]+)"/.exec(block);
    if (!href) continue;
    let url = decodeEnt(href[1]);
    const u = /[?&]uddg=([^&]+)/.exec(url);
    if (u) { try { url = decodeURIComponent(u[1]); } catch { /* garde l'URL brute */ } }
    const m = NETFLIX_ID.exec(url);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    const title = />([\s\S]*?)<\/a>/.exec(block);
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    out.push({ id: m[1], url: `https://www.netflix.com/title/${m[1]}`, title: title ? cleanTitle(strip(title[1])) || null : null, snippet: snippet ? strip(snippet[1]).slice(0, 220) : '' });
  }
  if (!out.length) {   // mise en page changée : on récupère au moins les IDs présents dans le HTML
    for (const m of decodeURIComponent(html.replace(/%(?![0-9A-Fa-f]{2})/g, '%25')).matchAll(/netflix\.com\/(?:[a-z]{2}(?:-[A-Za-z]{2})?\/)?title\/(\d+)/g)) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      out.push({ id: m[1], url: `https://www.netflix.com/title/${m[1]}`, title: null, snippet: '' });
    }
  }
  return out;
}

async function netflixDdg(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`site:netflix.com/title ${query}`)}&kl=fr-fr`;
  const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'fr-FR,fr;q=0.9' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const html = await res.text();
  if (!res.ok || /anomaly|captcha|unusual traffic/i.test(html.slice(0, 5000))) throw new Error(`DuckDuckGo bloque la requête (HTTP ${res.status}) : réessaie dans quelques minutes`);
  return parse(html).slice(0, 8);
}

/**
 * Cherche la fiche Netflix d'un titre. Brave d'abord (si BRAVE_API_KEY) ; en cas de quota/réseau, DuckDuckGo.
 * Une clé Brave refusée remonte l'erreur telle quelle : c'est un problème de configuration, pas de couverture.
 */
async function netflix(query) {
  if (!config.braveApiKey) return netflixDdg(query);
  try {
    return await netflixBrave(query);
  } catch (e) {
    if (e.fatal) throw e;
    try {
      return await netflixDdg(query);
    } catch (e2) {
      throw new Error(`${e.message} ; secours DuckDuckGo : ${e2.message}`);
    }
  }
}

// ---- Apple TV : API iTunes Search ----
// L'API non documentée de tv.apple.com peut ne rien renvoyer (paramètres périmés) : iTunes Search, publique et stable,
// retrouve la même fiche et son URL contient le type et l'ID umc.cmc.* — exactement ce qu'attend appletv.fetchTrailers.
const APPLE_URL = /tv\.apple\.com\/(?:[a-z]{2}\/)?(show|movie)\/([^\/?#\s"]*)\/?(umc\.cmc\.[a-z0-9]+)/i;
const cleanApple = (t) => t
  .replace(/^(Regarder|Watch)\s+/i, '')
  .replace(/\s*[-–,]\s*(Season|Saison)\s*\d+.*$/i, '')     // « Ted Lasso, Season 1 » → « Ted Lasso »
  .replace(/\s+(sur|on)\s+Apple TV\+?.*$/i, '')
  .replace(/\s*[|\-–]\s*Apple TV\+?.*$/i, '')
  .trim();

const yearOf = (d) => {
  const t = Date.parse(String(d || ''));
  return Number.isFinite(t) ? new Date(t).getUTCFullYear() : null;
};

/** Résultats iTunes (movies + saisons) → [{ id, title, type, year }] dédoublonné par ID Apple. */
function appleCandidates(results) {
  const out = [];
  const seen = new Set();
  for (const it of results || []) {
    const m = APPLE_URL.exec(String((it && (it.trackViewUrl || it.collectionViewUrl || it.trackCatalogueUrl)) || ''));
    if (!m || seen.has(m[3])) continue;
    seen.add(m[3]);
    const slug = decodeURIComponent(m[2] || '').replace(/-/g, ' ').trim();
    const raw = String((it && (it.trackName || it.collectionName)) || '');
    out.push({
      id: m[3],
      title: cleanApple(raw) || slug || null,
      type: m[1].toLowerCase() === 'show' ? 'series' : 'movie',
      year: yearOf(it && (it.releaseDate || it.currentVersionReleaseDate)) || null,
    });
  }
  return out;
}

/** HTML de recherche DuckDuckGo (secours historique) → mêmes champs que appleCandidates. */
function parseApple(html) {
  const out = [];
  const seen = new Set();
  for (const block of html.split(/class="result__a"/).slice(1)) {
    const href = /href="([^"]+)"/.exec(block);
    if (!href) continue;
    let url = decodeEnt(href[1]);
    const u = /[?&]uddg=([^&]+)/.exec(url);
    if (u) { try { url = decodeURIComponent(u[1]); } catch { /* URL brute */ } }
    const m = APPLE_URL.exec(url);
    if (!m || seen.has(m[3])) continue;
    seen.add(m[3]);
    const t = />([\s\S]*?)<\/a>/.exec(block);
    const slug = decodeURIComponent(m[2] || '').replace(/-/g, ' ').trim();
    out.push({ id: m[3], title: (t ? cleanApple(strip(t[1])) : '') || slug, type: m[1].toLowerCase() === 'show' ? 'series' : 'movie', year: null });
  }
  return out;
}

async function itunesSearch({ term, media, entity, limit = 12 }) {
  // `lang` n'accepte que en_us / ja_jp : on ne le passe pas, `country` suffit à choisir le storefront
  // (les titres et l'URL tv.apple.com reviennent donc dans la langue du pays demandé).
  const params = new URLSearchParams({
    term,
    country: config.appletvCountry,
    media,
    entity,
    limit: String(limit),
  });
  const res = await fetch(`https://itunes.apple.com/search?${params}`, {
    headers: { accept: 'application/json', 'user-agent': UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`iTunes Search HTTP ${res.status}`);
  const data = await res.json().catch(() => ({}));
  return data && Array.isArray(data.results) ? data.results : [];
}

/** Recherche Apple TV : films et saisons de séries en parallèle, une requête chacun. */
async function apple(query) {
  const [movies, shows] = await Promise.allSettled([
    itunesSearch({ term: query, media: 'movie', entity: 'movie' }),
    itunesSearch({ term: query, media: 'tvShow', entity: 'tvSeason' }),
  ]);
  const items = [
    ...(movies.status === 'fulfilled' ? movies.value : []),
    ...(shows.status === 'fulfilled' ? shows.value : []),
  ];
  if (!items.length && movies.status === 'rejected' && shows.status === 'rejected') throw movies.reason;
  return appleCandidates(items).slice(0, 8);
}

module.exports = { netflix, parse, apple, appleWeb: apple, appleCandidates, netflixCandidates, parseApple };

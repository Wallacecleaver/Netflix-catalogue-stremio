const config = require('./config');

// JustWatch expose publiquement le catalogue Netflix (via ses offres) : c'est notre source d'IDs.
// La recherche Netflix elle-même redirige vers /login, donc inutilisable en scraping.
const ENDPOINT = 'https://apis.justwatch.com/graphql';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const QUERY = `query GetSearchResults($country: Country!, $language: Language!, $first: Int!, $searchQuery: String!) {
  popularTitles(country: $country, first: $first, filter: { searchQuery: $searchQuery }) {
    edges { node { ... on MovieOrShow {
      objectId objectType
      content(country: $country, language: $language) { title originalTitle originalReleaseYear }
      offers(country: $country, platform: WEB) { standardWebURL package { clearName } }
    } } }
  }
}`;

const clean = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');

/** Extrait l'ID numérique d'une URL Netflix (`https://www.netflix.com/title/81707977`). */
function netflixIdOf(url) {
  const m = String(url || '').match(/\/title\/(\d{5,})/);
  return m ? m[1] : null;
}

/** Recherche un titre et ne garde que les résultats réellement disponibles sur Netflix. */
async function searchNetflix(query, { country = config.region, language = String(config.lang || 'fr-FR').slice(0, 2), first = 8 } = {}) {
  if (!query) return [];
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA },
    body: JSON.stringify({
      operationName: 'GetSearchResults',
      variables: { country, language, first, searchQuery: String(query) },
      query: QUERY,
    }),
  });
  if (!res.ok) throw new Error(`JustWatch ${res.status}`);
  const data = await res.json();
  if (Array.isArray(data.errors) && data.errors.length) throw new Error(`JustWatch : ${data.errors[0].message}`);

  const out = [];
  const seen = new Set();
  for (const edge of data?.data?.popularTitles?.edges || []) {
    const node = edge?.node;
    if (!node) continue;
    for (const offer of node.offers || []) {
      if (!/netflix/i.test(offer?.package?.clearName || '')) continue;
      const id = netflixIdOf(offer.standardWebURL);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        netflixId: id,
        netflixUrl: offer.standardWebURL,
        title: node.content?.title || null,
        originalTitle: node.content?.originalTitle || null,
        year: node.content?.originalReleaseYear || null,
        objectType: node.objectType || null,
        type: node.objectType === 'MOVIE' ? 'movie' : node.objectType === 'SHOW' ? 'series' : null,
      });
    }
  }
  return out;
}

function score(candidate, { name, year, type }) {
  if (!candidate?.netflixId) return null;
  if (type && candidate.type && candidate.type !== type) return null;
  const n = clean(name);
  if (!n) return null;
  const a = clean(candidate.title);
  const b = clean(candidate.originalTitle);
  let base = 0;
  if (a === n || b === n) base = 4;
  else if (n.length >= 6 && ((a && (a.includes(n) || n.includes(a))) || (b && (b.includes(n) || n.includes(b))))) base = 2;
  else return null;

  if (year && candidate.year) {
    const diff = Math.abs(Number(candidate.year) - Number(year));
    if (diff > 1) return null;                 // remake / autre année : on refuse
    base += diff === 0 ? 2 : 1;
  }
  return base;
}

/**
 * Choisit le meilleur candidat. Règle : correspondance de titre (exacte, sinon partielle avec année exacte),
 * même type (film/série) et offre Netflix. Un score < 4 ou une ambiguïté (deux IDs à égalité) => null.
 */
function pickBest(candidates, { name, year, type } = {}) {
  const scored = [];
  for (const candidate of candidates || []) {
    const s = score(candidate, { name, year, type });
    if (s != null) scored.push({ ...candidate, score: s });
  }
  if (!scored.length) return null;
  scored.sort((x, y) => y.score - x.score);
  const best = scored[0];
  if (best.score < 4) return null;
  if (year && !best.year && scored.length > 1) return null;
  const tied = scored.filter((c) => c.score === best.score && c.netflixId !== best.netflixId);
  return tied.length ? null : best;
}

// ---- Moissonnage du catalogue Netflix complet (pagination par curseur) ----
const CATALOG_FIELDS = (withIds) => `
      objectId objectType
      content(country: $country, language: $language) {
        title originalTitle originalReleaseYear originalReleaseDate
        ${withIds ? 'externalIds { imdbId tmdbId }' : ''}
      }
      offers(country: $country, platform: WEB) { standardWebURL package { shortName clearName } }`;

const catalogQuery = (withIds) => `query GetNetflixCatalog($country: Country!, $language: Language!, $first: Int!, $after: String, $filter: TitleFilter) {
  popularTitles(country: $country, first: $first, after: $after, filter: $filter, sortBy: RELEASE_YEAR) {
    totalCount
    pageInfo { endCursor hasNextPage }
    edges { node { ... on MovieOrShow { ${CATALOG_FIELDS(withIds)} } } }
  }
}`;

let useExternalIds = true;   // désactivé automatiquement si le schéma JustWatch change

async function gql(query, variables) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA },
    body: JSON.stringify({ operationName: 'GetNetflixCatalog', variables, query }),
  });
  if (res.status === 429) { const e = new Error('JustWatch 429'); e.rateLimited = true; throw e; }
  if (!res.ok) throw new Error(`JustWatch ${res.status}`);
  const data = await res.json();
  if (Array.isArray(data.errors) && data.errors.length && !data?.data?.popularTitles) {
    throw new Error(`JustWatch : ${data.errors[0].message}`);
  }
  return data;
}

/**
 * Une page du catalogue Netflix d'un pays, filtrée par type (MOVIE | SHOW) et plage d'années.
 * Renvoie { items, endCursor, hasNext, total } ; chaque item contient l'ID Netflix extrait de l'offre.
 */
async function listNetflixPage({ country = config.region, language = String(config.lang || 'fr-FR').slice(0, 2),
  objectType, minYear, maxYear, after = null, first = 100 } = {}) {
  const filter = { packages: ['nfx'] };
  if (objectType) filter.objectTypes = [objectType];
  if (minYear || maxYear) filter.releaseYear = { ...(minYear ? { min: minYear } : {}), ...(maxYear ? { max: maxYear } : {}) };
  const variables = { country, language, first, after, filter };

  let data;
  try { data = await gql(catalogQuery(useExternalIds), variables); }
  catch (e) {
    if (e.rateLimited || !useExternalIds) throw e;
    useExternalIds = false;                       // on retente sans externalIds (TMDB/IMDb) au cas où le champ n'existe plus
    data = await gql(catalogQuery(false), variables);
  }

  const conn = data?.data?.popularTitles;
  const items = [];
  for (const edge of conn?.edges || []) {
    const node = edge?.node;
    if (!node) continue;
    const offer = (node.offers || []).find((o) =>
      (o?.package?.shortName === 'nfx' || /netflix/i.test(o?.package?.clearName || '')) && netflixIdOf(o.standardWebURL));
    if (!offer) continue;
    items.push({
      netflixId: netflixIdOf(offer.standardWebURL),
      type: node.objectType === 'MOVIE' ? 'movie' : 'series',
      name: node.content?.title || node.content?.originalTitle || null,
      originalTitle: node.content?.originalTitle || null,
      year: node.content?.originalReleaseYear || null,
      releaseDate: node.content?.originalReleaseDate || null,
      tmdbId: node.content?.externalIds?.tmdbId ? Number(node.content.externalIds.tmdbId) : null,
      imdbId: node.content?.externalIds?.imdbId || null,
    });
  }
  return {
    items,
    endCursor: conn?.pageInfo?.endCursor || null,
    hasNext: !!conn?.pageInfo?.hasNextPage,
    total: conn?.totalCount ?? null,
  };
}

module.exports = { searchNetflix, pickBest, netflixIdOf, listNetflixPage };

const config = require('./config');
const store = require('./db');
const log = require('./log');

// Bandes-annonces Apple TV (tv.apple.com) via l'API web NON documentée (uts-api.itunes.apple.com).
// Apple peut changer les paramètres sans prévenir : `APPLETV_API_VERSION` est réglable dans .env.
// Les trailers sont des flux HLS (.m3u8) directs, stockés dans la colonne `appletv_json` (séparée de `trailers`,
// pour ne pas interférer avec le relais Netflix /trailer/<id>/<n>.mp4 qui indexe `trailers`).
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HIT_TTL = 30 * 24 * 3600 * 1000;   // trailer trouvé : revérifié au bout de 30 j
const MISS_TTL = 7 * 24 * 3600 * 1000;   // rien trouvé : nouvelle tentative au bout de 7 j
const inflight = new Map();

const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function http(url, accept) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept, 'accept-language': config.lang }, signal: AbortSignal.timeout(config.appletvTimeoutMs) });
  if (!res.ok) throw new Error(`Apple TV HTTP ${res.status}`);
  return res.text();
}

function walk(node, fn, parent = null, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40) return;
  if (!Array.isArray(node)) fn(node, parent);
  for (const v of Object.values(node)) walk(v, fn, node, depth + 1);
}

function apiQuery(extra = {}) {
  return new URLSearchParams({
    caller: 'js', locale: config.appletvLocale, pfm: 'desktop', sf: String(config.appletvStorefront), v: String(config.appletvApiVersion), ...extra,
  }).toString();
}

/** Recherche dans le catalogue Apple TV → [{ id, title, type: 'movie'|'series', year }] */
async function search(term) {
  const json = JSON.parse(await http(`https://uts-api.itunes.apple.com/uts/v3/search?${apiQuery({ searchTerm: term })}`, 'application/json'));
  const seen = new Map();
  walk(json, (o) => {
    if (typeof o.id !== 'string' || !/^umc\.cmc\./.test(o.id) || seen.has(o.id)) return;
    const title = o.title || o.name;
    if (!title) return;
    const t = String(o.type || '').toLowerCase();
    const ts = Number(o.releaseDate);
    seen.set(o.id, {
      id: o.id, title,
      type: t.includes('show') || t.includes('series') ? 'series' : 'movie',
      year: Number.isFinite(ts) && ts > 0 ? new Date(ts).getUTCFullYear() : null,
    });
  });
  return [...seen.values()];
}

/** Choisit le résultat correspondant exactement au titre (et à l'année / au type si connus). Sinon null : mieux vaut pas de trailer qu'un mauvais. */
function pickMatch(items, row) {
  const want = norm(row.name);
  let c = items.filter((i) => norm(i.title) === want);
  if (row.type) { const same = c.filter((i) => i.type === row.type); if (same.length) c = same; }
  if (row.year) c = c.filter((i) => !i.year || Math.abs(i.year - Number(row.year)) <= 1);
  return c[0] || null;
}

/** Extrait les flux .m3u8 marqués trailer/preview/bande-annonce d'un JSON (page ou API). */
function extractTrailers(json) {
  const out = [];
  const isM3u8 = (v) => typeof v === 'string' && /^https?:\/\/\S+\.m3u8(\?\S*)?$/i.test(v);
  walk(json, (o, parent) => {
    const url = Object.values(o).find(isM3u8);
    if (!url || out.some((t) => t.url === url)) return;
    const label = [o.type, o.kind, o.contentType, o.assetType, o.title, o.name].filter((x) => typeof x === 'string').join(' ');
    const ctx = label + ' ' + (parent && !Array.isArray(parent) ? [parent.type, parent.kind, parent.contentType].filter((x) => typeof x === 'string').join(' ') : '');
    if (!/trailer|preview|teaser|bande[- ]?annonce/i.test(ctx)) return;
    out.push({ title: (typeof o.title === 'string' && o.title) || (typeof o.name === 'string' && o.name) || 'Bande-annonce', url });
  });
  return out;
}

/** Page tv.apple.com/<pays>/<movie|show>/<id> : JSON embarqué (serialized-server-data) puis, à défaut, flux .m3u8 repérés dans le HTML. */
async function fetchTrailers(match) {
  const kind = match.type === 'series' ? 'show' : 'movie';
  const html = await http(`https://tv.apple.com/${config.appletvCountry}/${kind}/${match.id}`, 'text/html');
  const m = html.match(/<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/);
  if (m) { try { const t = extractTrailers(JSON.parse(m[1])); if (t.length) return t; } catch { /* JSON illisible : repli ci-dessous */ } }
  return extractTrailers(JSON.parse(`{"a":${JSON.stringify([...new Set(html.match(/https?:\/\/[^"'\\\s<>]+\.m3u8[^"'\\\s<>]*/g) || [])].map((u) => ({ type: 'trailer', url: u })))}}`));
}

async function lookupTrailers(row) {
  const items = await search(row.name);
  const match = pickMatch(items, row);
  if (!match) return [];
  return (await fetchTrailers(match)).map((t) => ({ ...t, source: 'appletv', appleId: match.id }));
}

/** Si la fiche n'a pas encore été vérifiée (ou TTL dépassé), cherche les trailers Apple TV. Ne bloque jamais la fiche en cas d'erreur. */
async function ensure(row) {
  if (!row || !config.appletvEnabled || !row.name) return row;
  const has = Array.isArray(row.appletv) && row.appletv.length > 0;
  const age = Date.now() - (row.appletv_checked || 0);
  if (row.appletv_checked && age < (has ? HIT_TTL : MISS_TTL)) return row;
  if (!inflight.has(row.id)) {
    inflight.set(row.id, (async () => {
      let trailers = [];
      try { trailers = await lookupTrailers(row); }
      catch (e) { log.warn('appletv', `${row.name} : ${e.message}`); return null; }   // erreur réseau : on retentera à la prochaine ouverture
      store.upsertTitle({ id: row.id, type: row.type, name: row.name, appletv: trailers, appletv_checked: Date.now() });
      if (trailers.length) log.info('appletv', `Bande-annonce Apple TV trouvée : ${row.name}`, { count: trailers.length });
      return store.getTitle(row.id);
    })().finally(() => inflight.delete(row.id)));
  }
  return (await inflight.get(row.id)) || row;
}

const urls = (row) => (Array.isArray(row?.appletv) ? row.appletv : []).filter((t) => t && t.url).map((t) => ({ title: t.title ? `Apple TV — ${t.title}` : 'Bande-annonce Apple TV', url: t.url }));

module.exports = { ensure, urls, search, pickMatch, extractTrailers, fetchTrailers, lookupTrailers };

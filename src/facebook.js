'use strict';
/**
 * src/facebook.js — Source "Facebook" pour Stockage DB.
 *
 * Résout une URL publique de reel / vidéo Facebook en liens MP4 directs (HD / SD).
 * Module CommonJS (comme le reste du projet).
 *
 *   const { resolveFacebookVideo } = require('./facebook');
 *   const r = await resolveFacebookVideo('https://www.facebook.com/reel/1821011232469230');
 *   // r.sources = [{ quality: 'hd', url }, { quality: 'sd', url }]
 *
 * ⚠️ Les liens fbcdn sont signés et expirent (paramètre `oe`). Il faut donc stocker
 * l'URL de la page Facebook et re-résoudre à la lecture (comme pour Netflix),
 * jamais le lien MP4 lui-même.
 */

const ALLOWED_PAGE_HOSTS = /^(?:[a-z0-9-]+\.)*(?:facebook\.com|fb\.watch|fb\.com)$/i;
const ALLOWED_MEDIA_HOSTS = /(?:^|\.)(?:fbcdn\.net|facebook\.com|fbsbx\.com)$/i;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
];

const HD_KEYS = ['browser_native_hd_url', 'playable_url_quality_hd', 'hd_src'];
const SD_KEYS = ['browser_native_sd_url', 'playable_url', 'sd_src'];

const MAX_HTML_BYTES = 5_000_000;
const MAX_REDIRECTS = 5;
const CACHE_MAX_MS = 30 * 60 * 1000;
const cache = new Map(); // url -> { at, expiresAt, value }

function fail(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

/** Valide une URL Facebook et en extrait l'id de vidéo quand il est dans l'URL. */
function parseFacebookUrl(input) {
  let u;
  try {
    u = new URL(String(input || '').trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || !ALLOWED_PAGE_HOSTS.test(u.hostname)) return null;
  let id =
    (u.pathname.match(/\/(?:reel|reels|videos)\/(\d{6,})/) || [])[1] ||
    u.searchParams.get('v') ||
    null;
  if (id && !/^\d+$/.test(id)) id = null;
  return { url: u.toString(), id };
}

function isFacebookUrl(input) {
  return !!parseFacebookUrl(input);
}

function decodeJsonString(s) {
  try {
    return JSON.parse('"' + s + '"');
  } catch {
    return s.replace(/\\\//g, '/').replace(/\\u0025/gi, '%').replace(/\\u0026/gi, '&');
  }
}

function decodeHtml(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function jsonField(html, key) {
  const m = html.match(new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'));
  return m ? decodeJsonString(m[1]) : null;
}

function metaContent(html, prop) {
  const a = html.match(
    new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]*content=["\']([^"\']*)["\']', 'i'),
  );
  if (a) return decodeHtml(a[1]);
  const b = html.match(
    new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + prop + '["\']', 'i'),
  );
  return b ? decodeHtml(b[1]) : null;
}

/** N'accepte que du https vers les CDN Facebook (anti-SSRF côté source). */
function cleanMediaUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || !ALLOWED_MEDIA_HOSTS.test(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function expiryOf(url) {
  try {
    const oe = new URL(url).searchParams.get('oe'); // timestamp UNIX en hexadécimal
    if (oe && /^[0-9a-f]{6,10}$/i.test(oe)) return parseInt(oe, 16) * 1000;
  } catch {}
  return null;
}

/** Extrait les liens vidéo et les métadonnées d'une page Facebook (fonction pure, testable). */
function parseFacebookHtml(html) {
  const found = [];
  const push = (quality, raw) => {
    const url = cleanMediaUrl(raw);
    if (url && !found.some((s) => s.url === url)) found.push({ quality, url });
  };

  for (const k of HD_KEYS) push('hd', jsonField(html, k));
  for (const k of SD_KEYS) push('sd', jsonField(html, k));
  for (const p of ['og:video:secure_url', 'og:video:url', 'og:video']) push('sd', metaContent(html, p));

  const title =
    metaContent(html, 'og:title') ||
    ((html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '').trim() ||
    null;

  const times = found.map((s) => expiryOf(s.url)).filter(Boolean);
  return {
    title: title ? decodeHtml(title) : null,
    thumbnail: cleanMediaUrl(metaContent(html, 'og:image')),
    sources: found,
    expiresAt: times.length ? Math.min(...times) : null,
  };
}

/** GET avec redirections suivies à la main : chaque saut doit rester sur Facebook. */
async function fetchPage(url, userAgent, timeoutMs) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5',
      },
    });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      const next = new URL(loc, current);
      if (!/^https?:$/.test(next.protocol) || !ALLOWED_PAGE_HOSTS.test(next.hostname)) {
        throw fail('FB_BAD_REDIRECT', 'Redirection hors Facebook refusée');
      }
      current = next.toString();
      continue;
    }
    if (!res.ok) throw fail('FB_HTTP_' + res.status, 'Facebook a répondu ' + res.status);
    const html = (await res.text()).slice(0, MAX_HTML_BYTES);
    return { html, finalUrl: current };
  }
  throw fail('FB_TOO_MANY_REDIRECTS', 'Trop de redirections');
}

/**
 * Résout une URL Facebook en liens MP4 directs.
 * @param {string} input  URL publique (reel, /videos/, watch/?v=, fb.watch, /share/r/…)
 * @param {{ fresh?: boolean, timeoutMs?: number }} [opts]
 * @returns {Promise<{ id: string|null, pageUrl: string, title: string|null, thumbnail: string|null,
 *   sources: {quality: 'hd'|'sd', url: string}[], expiresAt: number|null }>}
 */
async function resolveFacebookVideo(input, opts = {}) {
  const parsed = parseFacebookUrl(input);
  if (!parsed) throw fail('FB_BAD_URL', 'URL Facebook invalide');

  const key = parsed.url;
  const hit = cache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_MAX_MS && (!hit.expiresAt || hit.expiresAt - 5 * 60 * 1000 > Date.now())) {
    return hit.value;
  }

  const timeoutMs = opts.timeoutMs || 15000;
  let lastErr = null;
  let sawLoginWall = false;

  for (const ua of USER_AGENTS) {
    try {
      const { html, finalUrl } = await fetchPage(parsed.url, ua, timeoutMs);
      const data = parseFacebookHtml(html);
      if (data.sources.length) {
        const value = { id: parsed.id, pageUrl: finalUrl, ...data };
        cache.set(key, { at: Date.now(), expiresAt: data.expiresAt, value });
        return value;
      }
      if (/\/login|checkpoint/.test(finalUrl) || /id="login_form"|name="login"/i.test(html)) {
        sawLoginWall = true;
      }
    } catch (e) {
      lastErr = e;
    }
  }

  if (sawLoginWall) throw fail('FB_LOGIN_WALL', 'Facebook demande une connexion pour cette vidéo (privée ou bloquée)');
  if (lastErr) throw lastErr;
  throw fail('FB_NO_VIDEO', 'Aucune vidéo trouvée sur cette page');
}

module.exports = { resolveFacebookVideo, parseFacebookUrl, parseFacebookHtml, isFacebookUrl };

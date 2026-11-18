// Durcissement partag├® : validation d'URL (anti-SSRF), en-t├¬tes HTTP, limitation de d├®bit
// et plafonnement des conversions simultan├®es.
//
// R├¿gle : toute URL qui vient d'une source non fiable (instance amont, r├®ponse HTTP, base)
// doit passer par assertSafeUrl()/safeFetch() avant d'├¬tre fetch├®e c├┤t├® serveur.

const dns = require('dns');
const net = require('net');

// ---- Adresses internes / r├®serv├®es (IPv4 + IPv6) ----
const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
];

const v4ToInt = (ip) => ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;

function inCidrV4(ip, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
}

/** Décompose une adresse IPv6 valide en 8 mots de 16 bits (gère ::ffff:127.0.0.1 et ::ffff:7f00:1). */
function parseIpv6Words(ip) {
  let norm = String(ip || '').toLowerCase().split('%')[0];
  const v4Tail = norm.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Tail && net.isIPv4(v4Tail[2])) {
    const n = v4ToInt(v4Tail[2]);
    norm = `${v4Tail[1]}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = norm.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
  const missing = halves.length === 2 ? 8 - (left.length + right.length) : 0;
  if (missing < 0 || (halves.length === 1 && left.length !== 8)) return null;
  const words = [...left, ...Array(missing).fill('0'), ...right].map((w) => parseInt(w, 16));
  return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : null;
}

const wordsToV4 = (hi, lo) => `${(hi >>> 8) & 0xff}.${hi & 0xff}.${(lo >>> 8) & 0xff}.${lo & 0xff}`;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return BLOCKED_V4.some(([base, bits]) => inCidrV4(ip, base, bits));
  if (net.isIPv6(ip)) {
    const w = parseIpv6Words(ip);
    if (!w) return true;
    const allZeroPrefix = w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0;
    // :: (non spécifiée), ::1 (loopback) et ::/96 (IPv4-compatible dépréciée)
    if (allZeroPrefix && w[5] === 0) {
      if (w[6] === 0 && (w[7] === 0 || w[7] === 1)) return true;
      return isPrivateIp(wordsToV4(w[6], w[7]));
    }
    // ::ffff:0:0/96 (IPv4-mapped, y compris la forme hex normalisée par new URL : ::ffff:7f00:1)
    if (allZeroPrefix && w[5] === 0xffff) return isPrivateIp(wordsToV4(w[6], w[7]));
    // ::ffff:0:0:0/96 (IPv4-translated SIIT)
    if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0xffff && w[5] === 0) {
      return isPrivateIp(wordsToV4(w[6], w[7]));
    }
    // 64:ff9b::/96 et 64:ff9b:1::/48 (NAT64)
    if (w[0] === 0x0064 && w[1] === 0xff9b && (w[2] === 0 || w[2] === 1)) return true;
    // 100::/64 (discard-only RFC 6666)
    if (w[0] === 0x0100 && w[1] === 0 && w[2] === 0 && w[3] === 0) return true;
    // 2001::/23 (IETF protocol assignments, Teredo 2001::/32, benchmarking 2001:2::/48) et 2001:db8::/32 (doc)
    if (w[0] === 0x2001 && (w[1] < 0x0200 || w[1] === 0x0db8)) return true;
    // 2002::/16 (6to4 : l'adresse IPv4 est dans w[1..2])
    if (w[0] === 0x2002) return isPrivateIp(wordsToV4(w[1], w[2]));
    // fc00::/7 (ULA), fe80::/10 (link-local), fec0::/10 (site-local), ff00::/8 (multicast)
    if ((w[0] & 0xfe00) === 0xfc00) return true;
    if ((w[0] & 0xffc0) === 0xfe80 || (w[0] & 0xffc0) === 0xfec0) return true;
    if ((w[0] & 0xff00) === 0xff00) return true;
    return false;
  }
  return false;
}

const INTERNAL_NAMES = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i;

// Option de dépannage/auto-hébergement (déconseillée) : autorise les adresses internes
// (ex. une instance amont sur le réseau Docker). Jamais activée par défaut.
const allowPrivate = () => process.env.ALLOW_PRIVATE_URLS === '1';

function evictOldest(map, maxEntries) {
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** Contrôles synchrones : schéma, identifiants dans l'URL, IP littérale interne. */
function assertSafeUrlSync(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { throw new Error('URL invalide'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('schéma URL refusé');
  if (url.username || url.password) throw new Error('URL contenant des identifiants refusée');
  if (allowPrivate()) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new Error('hôte manquant dans l’URL');
  if (net.isIP(host) && isPrivateIp(host)) throw new Error('adresse interne refusée');
  if (INTERNAL_NAMES.test(host)) throw new Error('hôte interne refusé');
  return url;
}

// Cache des résolutions DNS (évite un lookup par segment HLS).
const dnsCache = new Map();
const DNS_OK_TTL = 5 * 60 * 1000;
const DNS_BAD_TTL = 60 * 1000;
const DNS_CACHE_MAX = 2000;

/** Contrôles synchrones + résolution DNS : refuse toute URL qui pointe vers le réseau interne. */
async function assertSafeUrl(raw) {
  const url = assertSafeUrlSync(raw);
  if (allowPrivate()) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return url;

  const now = Date.now();
  const hit = dnsCache.get(host);
  if (hit && hit.exp > now) {
    if (hit.bad) throw new Error('hôte interne refusé');
    return url;
  }

  let addrs;
  try {
    addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch {
    dnsCache.set(host, { exp: now + DNS_BAD_TTL, bad: true });
    evictOldest(dnsCache, DNS_CACHE_MAX);
    throw new Error('hôte introuvable');
  }
  const bad = !addrs.length || addrs.some((a) => isPrivateIp(a.address));
  dnsCache.set(host, { exp: now + (bad ? DNS_BAD_TTL : DNS_OK_TTL), bad });
  evictOldest(dnsCache, DNS_CACHE_MAX);
  if (bad) throw new Error('hôte interne refusé');
  return url;
}

/** fetch() avec validation d'URL et redirections revalidées à chaque saut. */
async function safeFetch(raw, options = {}, maxRedirects = 3) {
  let current = String(raw);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertSafeUrl(current);
    const res = await fetch(current, { ...options, redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      try { await res.body?.cancel?.(); } catch { /* ignore */ }
      current = new URL(location, current).href;
      continue;
    }
    return res;
  }
  throw new Error('trop de redirections');
}

// ---- En-têtes de sécurité ----
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // Les bandes-annonces sont chargées par un lecteur externe (Stremio) : pas de CORP bloquant.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  // Les flux vidéo n'ont pas besoin de CSP et doivent rester lisibles par les lecteurs.
  if (!/^\/(trailer|apple|media)\//.test(req.path)) {
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com data:; " +
      "img-src 'self' data: https:; media-src 'self' https: blob:; connect-src 'self'; " +
      "frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'");
  }
  next();
}

// ---- Limitation de débit en mémoire (aucune dépendance) ----
function rateLimit({ windowMs = 60_000, max = 60, name = 'rl' } = {}) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, hit] of hits) if (hit.reset <= now) hits.delete(key);
  }, windowMs);
  if (timer.unref) timer.unref();

  return function limiter(req, res, next) {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let hit = hits.get(key);
    if (!hit || hit.reset <= now) { hit = { n: 0, reset: now + windowMs }; hits.set(key, hit); }
    hit.n++;
    evictOldest(hits, 10_000);
    if (hit.n > max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((hit.reset - now) / 1000))));
      return res.status(429).json({ error: `Trop de requêtes (${name}), réessaie dans un instant` });
    }
    next();
  };
}

/** S├®maphore : borne le nombre de t├óches lourdes simultan├®es (conversions ffmpeg). */
function createSemaphore(limit) {
  let active = 0;
  const queue = [];
  const release = () => {
    active--;
    const next = queue.shift();
    if (next) next();
  };
  return async function run(fn) {
    if (active >= limit) await new Promise((resolve) => queue.push(resolve));
    active++;
    try { return await fn(); } finally { release(); }
  };
}

module.exports = {
  isPrivateIp, assertSafeUrlSync, assertSafeUrl, safeFetch,
  securityHeaders, rateLimit, createSemaphore,
};

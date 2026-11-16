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

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return BLOCKED_V4.some(([base, bits]) => inCidrV4(ip, base, bits));
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === '::' || low === '::1') return true;
    if (low.startsWith('fc') || low.startsWith('fd')) return true;      // fc00::/7 (ULA)
    if (/^fe[89ab]/.test(low)) return true;                             // fe80::/10 (link-local)
    const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return false;
}

const INTERNAL_NAMES = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i;

// Option de d├®pannage/auto-h├®bergement (d├®conseill├®e) : autorise les adresses internes
// (ex. une instance amont sur le r├®seau Docker). Jamais activ├®e par d├®faut.
const allowPrivate = () => process.env.ALLOW_PRIVATE_URLS === '1';

/** Contr├┤les synchrones : sch├®ma, identifiants dans l'URL, IP litt├®rale interne. */
function assertSafeUrlSync(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { throw new Error('URL invalide'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('sch├®ma URL refus├®');
  if (url.username || url.password) throw new Error('URL contenant des identifiants refus├®e');
  if (allowPrivate()) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new Error('h├┤te manquant dans lÔÇÖURL');
  if (net.isIP(host) && isPrivateIp(host)) throw new Error('adresse interne refus├®e');
  if (INTERNAL_NAMES.test(host)) throw new Error('h├┤te interne refus├®');
  return url;
}

// Cache des r├®solutions DNS (├®vite un lookup par segment HLS).
const dnsCache = new Map();
const DNS_OK_TTL = 5 * 60 * 1000;
const DNS_BAD_TTL = 60 * 1000;

/** Contr├┤les synchrones + r├®solution DNS : refuse toute URL qui pointe vers le r├®seau interne. */
async function assertSafeUrl(raw) {
  const url = assertSafeUrlSync(raw);
  if (allowPrivate()) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return url;

  const now = Date.now();
  const hit = dnsCache.get(host);
  if (hit && hit.exp > now) {
    if (hit.bad) throw new Error('h├┤te interne refus├®');
    return url;
  }

  let addrs;
  try {
    addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch {
    dnsCache.set(host, { exp: now + DNS_BAD_TTL, bad: true });
    throw new Error('h├┤te introuvable');
  }
  const bad = !addrs.length || addrs.some((a) => isPrivateIp(a.address));
  dnsCache.set(host, { exp: now + (bad ? DNS_BAD_TTL : DNS_OK_TTL), bad });
  if (bad) throw new Error('h├┤te interne refus├®');
  return url;
}

/** fetch() avec validation d'URL et redirections revalid├®es ├á chaque saut. */
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

// ---- En-t├¬tes de s├®curit├® ----
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // Les bandes-annonces sont charg├®es par un lecteur externe (Stremio) : pas de CORP bloquant.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  // Les flux vid├®o n'ont pas besoin de CSP et doivent rester lisibles par les lecteurs.
  if (!/^\/(trailer|apple)\//.test(req.path)) {
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; " +
      "object-src 'none'; form-action 'self'");
  }
  next();
}

// ---- Limitation de d├®bit en m├®moire (aucune d├®pendance) ----
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
    if (hits.size > 10_000) hits.clear();
    if (hit.n > max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((hit.reset - now) / 1000))));
      return res.status(429).json({ error: `Trop de requ├¬tes (${name}), r├®essaie dans un instant` });
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

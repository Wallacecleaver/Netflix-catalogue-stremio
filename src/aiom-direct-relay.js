const { createHmac, timingSafeEqual } = require('node:crypto');
const { assertSafeUrlSync } = require('./security');

const TTL_SECONDS = 24 * 60 * 60;
const MAX_URL_LENGTH = 2000;

function safeHlsUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !/\.m3u8$/i.test(url.pathname)) return null;
    url.hash = '';
    if (url.href.length > MAX_URL_LENGTH) return null;
    assertSafeUrlSync(url.href);
    return url.href;
  } catch {
    return null;
  }
}

function signature(payload, secret) {
  return createHmac('sha256', secret).update('aiom-direct:hls:').update(payload).digest();
}

function createToken(value, secret, now = Date.now()) {
  if (!secret || secret.length < 32) return null;
  const url = safeHlsUrl(value);
  if (!url) return null;
  const payload = Buffer.from(JSON.stringify([Math.floor(now / 1000) + TTL_SECONDS, url])).toString('base64url');
  return payload + '.' + signature(payload, secret).toString('base64url');
}

function readToken(token, secret, now = Date.now()) {
  if (!secret || secret.length < 32 || typeof token !== 'string' || token.length > 2900) return null;
  const parts = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!parts) return null;
  const [, payload, encodedSignature] = parts;
  const received = Buffer.from(encodedSignature, 'base64url');
  if (received.toString('base64url') !== encodedSignature || !timingSafeEqual(signature(payload, secret), received)) return null;
  try {
    const [expires, url] = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!Number.isSafeInteger(expires) || expires <= Math.floor(now / 1000)) return null;
    return safeHlsUrl(url);
  } catch {
    return null;
  }
}

module.exports = { createToken, readToken };

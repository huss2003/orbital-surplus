// server/security.js
// -----------------------------------------------------------------------------
// Everything the original static site did NOT have, collected in one place:
//   * security response headers (CSP, frame blocking, nosniff, …)
//   * a per-IP rate limit for mutating API calls
//   * a size-limited JSON body reader
//   * small input validators
//   * constant-time string comparison for secrets
// -----------------------------------------------------------------------------
import crypto from 'node:crypto';
import { config } from './config.js';
import { AppError } from './store.js';

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/** A fresh random value per HTML response, used to allow our own inline scripts. */
export const makeNonce = () => crypto.randomBytes(16).toString('base64');

/**
 * Content-Security-Policy.
 * - Scripts: only our origin, the pinned jsDelivr CDN (three.js, GSAP) and
 *   inline scripts that carry this response's nonce (the import map and
 *   JSON-LD blocks in index.html get the nonce injected by seo.js).
 * - Styles: our origin + Google Fonts CSS; 'unsafe-inline' is allowed for
 *   styles only (GSAP and the SPA set inline style attributes).
 * - Media: blob:/data: so WebGL textures, generated images and AR blobs work.
 */
export function cspHeader(nonce) {
  const script = ["'self'", 'https://cdn.jsdelivr.net'];
  if (nonce) script.push(`'nonce-${nonce}'`);
  return [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "connect-src 'self' blob: data: https://cdn.jsdelivr.net",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Headers sent on every response. */
export function securityHeaders(nonce) {
  return {
    'Content-Security-Policy': cspHeader(nonce),
    'X-Frame-Options': 'DENY', // legacy twin of frame-ancestors 'none'
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    // Camera + WebXR are needed by the AR page on our own origin only.
    'Permissions-Policy':
      'camera=(self), xr-spatial-tracking=(self), accelerometer=(self), gyroscope=(self), magnetometer=(self), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    // Ignored by browsers over plain http; effective once deployed behind TLS.
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  };
}

// ---------------------------------------------------------------------------
// Rate limiting (fixed window, in memory)
// ---------------------------------------------------------------------------
// Good enough for one process. On serverless (many instances) use a shared
// store instead: Upstash Redis / Vercel KV, or Vercel Firewall rate-limit rules.
const buckets = new Map(); // key -> { count, resetAt }

export function clientIp(req) {
  // Only trust X-Forwarded-For when you are behind a proxy you control.
  const fwd = req.headers['x-forwarded-for'];
  if (process.env.TRUST_PROXY === '1' && fwd) return String(fwd).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

/** Throws 429 when the caller exceeded the budget. Sets RateLimit-* headers. */
export function rateLimit(req, res) {
  const now = Date.now();
  const key = clientIp(req);
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + config.rateLimitWindowMs };
    buckets.set(key, b);
  }
  b.count++;
  const remaining = Math.max(0, config.rateLimitMax - b.count);
  res.setHeader('RateLimit-Limit', String(config.rateLimitMax));
  res.setHeader('RateLimit-Remaining', String(remaining));
  if (b.count > config.rateLimitMax) {
    const retry = Math.ceil((b.resetAt - now) / 1000);
    res.setHeader('Retry-After', String(retry));
    throw new AppError(429, 'RATE_LIMITED', `Too many requests. Try again in ${retry}s.`);
  }
}

// Forget old buckets now and then so the Map does not grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}, 60_000).unref();

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

/** Read the raw body as a string, refusing anything over `limit` bytes (413). */
export function readRawBody(req, limit = config.maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) {
      req.resume(); // drain without buffering
      return reject(new AppError(413, 'PAYLOAD_TOO_LARGE', `Body must be under ${limit} bytes.`));
    }
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new AppError(413, 'PAYLOAD_TOO_LARGE', `Body must be under ${limit} bytes.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Parse a JSON object body. Empty body → `{}`. Wrong content type → 415. */
export async function readJsonBody(req) {
  const raw = await readRawBody(req);
  if (!raw) return {};
  const type = String(req.headers['content-type'] || '');
  if (!type.includes('application/json')) {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send JSON with Content-Type: application/json.');
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new AppError(400, 'INVALID_JSON', 'Body is not valid JSON.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new AppError(400, 'INVALID_JSON', 'Body must be a JSON object.');
  }
  return data;
}

// ---------------------------------------------------------------------------
// Validators: each returns the clean value or throws a 400 AppError.
// ---------------------------------------------------------------------------
const bad = (field, msg) => new AppError(400, 'VALIDATION_ERROR', `${field}: ${msg}`, { field });

export function vString(value, field, { min = 1, max = 200, pattern } = {}) {
  if (typeof value !== 'string') throw bad(field, 'must be a string');
  const v = value.trim();
  if (v.length < min) throw bad(field, min === 1 ? 'is required' : `must be at least ${min} characters`);
  if (v.length > max) throw bad(field, `must be at most ${max} characters`);
  if (pattern && !pattern.test(v)) throw bad(field, 'has an invalid format');
  // Strip ASCII control characters (keeps newlines/tabs) to avoid log/header injection.
  return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

export function vEmail(value, field = 'email') {
  return vString(value, field, { max: 254, pattern: /^[^\s@<>()"]+@[^\s@<>()"]+\.[a-z]{2,}$/i }).toLowerCase();
}

export function vInt(value, field, { min = 0, max = 1e9 } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) throw bad(field, `must be an integer between ${min} and ${max}`);
  return value;
}

export function vEnum(value, field, allowed) {
  if (!allowed.includes(value)) throw bad(field, `must be one of ${allowed.join(', ')}`);
  return value;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/** Compare two strings in constant time (prevents timing attacks on tokens). */
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab); // keep timing similar
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/** Parse the Cookie header into an object. */
export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

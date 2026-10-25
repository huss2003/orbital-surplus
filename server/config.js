// server/config.js
// -----------------------------------------------------------------------------
// All runtime settings in one place, read from environment variables.
// Every value has a safe local-development default so `npm start` just works.
// In production (e.g. Vercel) these would be Project Environment Variables.
// -----------------------------------------------------------------------------
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Project root = the folder that contains package.json. */
export const ROOT = path.resolve(here, '..');

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  ROOT,
  // `PORT=0` asks the OS for a random free port (the tests use this).
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',

  // Public origin used for canonical URLs, sitemap and OG tags.
  // Left empty, the server derives it from the request's Host header.
  siteUrl: (process.env.SITE_URL || '').replace(/\/$/, ''),

  // Folder with the frontend (owned by the frontend build).
  publicDir: path.resolve(process.env.PUBLIC_DIR || path.join(ROOT, 'public')),

  // Seed catalog (checked into git) and the folder for runtime JSON files.
  catalogFile: path.join(ROOT, 'data', 'products.json'),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data')),

  // Rate limit for mutating API calls: N requests per window per IP.
  rateLimitMax: int(process.env.RATE_LIMIT_MAX, 120),
  rateLimitWindowMs: int(process.env.RATE_LIMIT_WINDOW_MS, 60 * 1000),

  // Maximum accepted JSON request body.
  maxBodyBytes: 16 * 1024,

  brand: 'ORBITAL SURPLUS',
};

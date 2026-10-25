// ---------------------------------------------------------------------------
// Database access. One tiny interface over two drivers:
//   production  → postgres.js over Neon's pooled connection (DATABASE_URL)
//   local dev   → PGlite (Postgres compiled to WASM), so `npm run dev` needs no install
// Every query is parameterised ($1, $2 …). Money is integer pence everywhere.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const URL_ = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';

let impl;

async function connect() {
  if (URL_) {
    const { default: postgres } = await import('postgres');
    // Neon's pooler runs PgBouncer in transaction mode → no prepared statements
    // json/jsonb parameters: we always pass JSON text, so send strings through untouched
    // (postgres.js would otherwise JSON-encode them a second time)
    const asJson = (to) => ({ to, from: [to], serialize: (x) => (typeof x === 'string' ? x : JSON.stringify(x)), parse: (x) => JSON.parse(x) });
    const sql = postgres(URL_, { prepare: false, max: Number(process.env.PGMAX || 4), idle_timeout: 20, connect_timeout: 10, ssl: process.env.PGSSL === 'off' ? false : 'require', types: { bigint: postgres.BigInt, json: asJson(114), jsonb: asJson(3802) } });
    const wrap = (s) => ({ q: async (text, params = []) => [...(await s.unsafe(text, params.map(norm)))].map(fix) });
    return { kind: 'postgres', ...wrap(sql), tx: (fn) => sql.begin((t) => fn(wrap(t))) };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = process.env.PGLITE_DIR || path.join(ROOT, '.data', 'pglite');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const pg = new PGlite(process.env.PGLITE_MEMORY ? undefined : dir);
  const wrap = (s) => ({ q: async (text, params = []) => (await s.query(text, params.map(norm))).rows.map(fix) });
  return { kind: 'pglite', ...wrap(pg), tx: (fn) => pg.transaction((t) => fn(wrap(t))) };
}

// JS → SQL: objects/arrays as JSON text (columns are jsonb), bigint ok
function norm(v) {
  if (v === undefined) return null;
  if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) return JSON.stringify(v);
  if (Array.isArray(v) && v.some((x) => x && typeof x === 'object')) return JSON.stringify(v);
  return v;
}
// SQL → JS: bigint columns come back as BigInt; ids here always fit in a double
function fix(row) {
  for (const k in row) if (typeof row[k] === 'bigint') row[k] = Number(row[k]);
  return row;
}

export async function db() {
  impl ??= connect();
  return impl;
}
export const q = async (text, params) => (await db()).q(text, params);
export const one = async (text, params) => (await q(text, params))[0] || null;
export const tx = async (fn) => (await db()).tx(fn);

export async function getMeta(key, fallback = null) {
  const r = await one('select value from meta where key = $1', [key]);
  return r ? r.value : fallback;
}
export async function setMeta(key, value, t) {
  return (t || (await db())).q('insert into meta (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value', [key, JSON.stringify(value)]);
}
/** Bump after any change shown on the storefront, so every server instance reloads its catalog cache */
export async function bumpCatalog(t) {
  return (t || (await db())).q(`insert into meta (key, value) values ('catalog_version', '1'::jsonb)
    on conflict (key) do update set value = to_jsonb((meta.value #>> '{}')::int + 1)`);
}

export const SCHEMA_VERSION = 1;
export async function ensureSchema() {
  let current = 0;
  try { current = Number(await getMeta('schema_version', 0)); } catch { current = 0; }
  if (current >= SCHEMA_VERSION) return false;
  const sqlText = fs.readFileSync(path.join(ROOT, 'server', 'schema.sql'), 'utf8');
  const d = await db();
  for (const stmt of sqlText.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) await d.q(stmt);
  return true; // caller seeds
}

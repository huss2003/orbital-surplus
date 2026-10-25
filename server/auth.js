// ---------------------------------------------------------------------------
// Customer accounts and admin access (ORBITAL SURPLUS).
//   • Passwords: scrypt with a per-user salt, compared in constant time
//   • Sessions: random 32-byte token in an HttpOnly cookie; only its SHA-256
//     is stored, so a database leak can't be replayed as a login
//   • Throttling: 8 failed logins per email+IP per 15 minutes
//   • The first admin comes from ADMIN_EMAIL / ADMIN_PASSWORD
// ---------------------------------------------------------------------------
import { scrypt as _scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { q, one } from './db.js';

const scrypt = promisify(_scrypt);
const sha = (s) => createHash('sha256').update(s).digest('hex');
const SESSION_DAYS = 30;

export async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await scrypt(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, salt, hash] = stored.split('$');
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(String(pw), Buffer.from(salt, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(key, expected);
}

export const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || '')) && String(e).length <= 200;
export function passwordProblem(pw) {
  if (String(pw || '').length < 8) return 'Use at least 8 characters for your password.';
  if (String(pw).length > 200) return 'That password is too long.';
  return null;
}

/* ---------------- sessions ---------------- */
export async function createSession(customerId) {
  const token = randomBytes(32).toString('hex');
  await q("insert into sessions (id, customer_id, expires_at) values ($1, $2, now() + make_interval(days => $3))", [sha(token), customerId, SESSION_DAYS]);
  return token;
}
export async function sessionCustomer(token) {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return one(`select c.id, c.email, c.name, c.is_admin, c.accepts_marketing, c.default_address, c.created_at
    from sessions s join customers c on c.id = s.customer_id where s.id = $1 and s.expires_at > now()`, [sha(token)]);
}
export const sessionCustomerById = (id) => one('select id, email, name, is_admin, accepts_marketing, default_address, created_at from customers where id = $1', [id]);
export const destroySession = (token) => token && q('delete from sessions where id = $1', [sha(token)]);
export const sessionCookie = (token, secure) => `os_sid=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
export const clearSessionCookie = (secure) => `os_sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

/* ---------------- throttling ---------------- */
async function throttled(key) {
  const r = await one("select failures, window_start > now() - interval '15 minutes' as fresh from auth_throttle where key = $1", [key]);
  return r && r.fresh && r.failures >= 8;
}
async function recordFailure(key) {
  await q(`insert into auth_throttle (key, failures, window_start) values ($1, 1, now())
    on conflict (key) do update set failures = case when auth_throttle.window_start > now() - interval '15 minutes' then auth_throttle.failures + 1 else 1 end,
    window_start = case when auth_throttle.window_start > now() - interval '15 minutes' then auth_throttle.window_start else now() end`, [key]);
}

export class AuthError extends Error {}

export async function login(email, password, ip) {
  const e = String(email || '').trim().toLowerCase();
  const key = sha(`${e}|${ip}`);
  if (await throttled(key)) throw new AuthError('Too many attempts. Please wait 15 minutes and try again.');
  const c = await one('select * from customers where email = $1', [e]);
  const ok = c?.password_hash ? await verifyPassword(password, c.password_hash) : (await hashPassword('timing-equaliser'), false);
  if (!ok) { await recordFailure(key); throw new AuthError('That email and password do not match.'); }
  await q('delete from auth_throttle where key = $1', [key]);
  return c;
}

export async function register({ email, password, name, accepts_marketing }) {
  const e = String(email || '').trim().toLowerCase();
  if (!validEmail(e)) throw new AuthError('Enter a valid email address.');
  const prob = passwordProblem(password); if (prob) throw new AuthError(prob);
  const existing = await one('select id, password_hash from customers where email = $1', [e]);
  if (existing?.password_hash) throw new AuthError('There is already an account with that email. Try signing in.');
  const hash = await hashPassword(password);
  const nm = String(name || '').trim().slice(0, 100);
  const [c] = await q(`insert into customers (email, name, password_hash, accepts_marketing) values ($1,$2,$3,$4)
    on conflict (email) do update set password_hash = excluded.password_hash,
      name = coalesce(nullif(excluded.name, ''), customers.name), accepts_marketing = customers.accepts_marketing or excluded.accepts_marketing
    returning *`, [e, nm, hash, !!accepts_marketing]);
  // a guest who checked out before can claim their order history by registering with the same email
  await q('update orders set customer_id = $1 where email = $2 and customer_id is null', [c.id, e]);
  if (accepts_marketing) await q("insert into subscribers (email, source) values ($1, 'account') on conflict do nothing", [e]);
  return c;
}

/* ---------------- password reset ---------------- */
export async function createReset(email) {
  const c = await one('select id, email from customers where email = $1 and password_hash is not null', [String(email || '').trim().toLowerCase()]);
  if (!c) return null; // the caller shows the same message either way
  const token = randomBytes(32).toString('hex');
  await q("insert into password_resets (id, customer_id, expires_at) values ($1, $2, now() + interval '1 hour')", [sha(token), c.id]);
  return { token, email: c.email };
}
export async function useReset(token, password) {
  const prob = passwordProblem(password); if (prob) throw new AuthError(prob);
  const r = await one('select * from password_resets where id = $1 and not used and expires_at > now()', [sha(String(token || ''))]);
  if (!r) throw new AuthError('This reset link has expired. Please request a new one.');
  await q('update password_resets set used = true where id = $1', [r.id]);
  await q('update customers set password_hash = $2 where id = $1', [r.customer_id, await hashPassword(password)]);
  await q('delete from sessions where customer_id = $1', [r.customer_id]);
  return r.customer_id;
}

/** Make sure the configured admin exists and its password matches ADMIN_PASSWORD (runs once per cold start) */
export async function ensureAdmin() {
  const email = (process.env.ADMIN_EMAIL || 'admin@orbital.local').toLowerCase();
  const pw = process.env.ADMIN_PASSWORD || (process.env.DATABASE_URL ? null : 'orbital-admin');
  if (!pw) return;
  const c = await one('select id, password_hash, is_admin from customers where email = $1', [email]);
  if (c && c.is_admin && (await verifyPassword(pw, c.password_hash))) return;
  await q(`insert into customers (email, name, password_hash, is_admin) values ($1, 'Depot Admin', $2, true)
    on conflict (email) do update set password_hash = excluded.password_hash, is_admin = true`, [email, await hashPassword(pw)]);
}


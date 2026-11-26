// Shared server helpers (files starting with "_" are not exposed as routes on Vercel).
import { put, list, del, get } from '@vercel/blob';
import crypto from 'node:crypto';

export const ACCESS = process.env.BLOB_ACCESS === 'public' ? 'public' : 'private';
export const SCHEDULE = 'marketing-ops/schedule';
export const USERS = 'marketing-ops/users';
export const ROLES = ['admin', 'editor'];
const SESSION_HOURS = 24;

/* ---------- JSON documents in Blob (each save is a new version; old versions are trimmed) ---------- */
async function versions(prefix) {
  const { blobs } = await list({ prefix, limit: 1000 });
  return blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
}
export async function readJSON(prefix) {
  const v = await versions(prefix);
  if (!v.length) return null;
  const r = await get(v[0].url, { access: ACCESS, useCache: false });
  if (!r || !r.stream) return null;
  return new Response(r.stream).json();
}
export async function writeJSON(prefix, data, keep = 15) {
  await put(prefix + '.json', JSON.stringify(data), { access: ACCESS, addRandomSuffix: true, contentType: 'application/json' });
  const v = await versions(prefix);
  const old = v.slice(keep).map((b) => b.url);
  if (old.length) await del(old);
}

/* ---------- passwords & sessions ---------- */
export function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pw), salt, 64).toString('hex') };
}
export function checkPassword(pw, salt, hash) {
  const h = crypto.scryptSync(String(pw), salt, 64), b = Buffer.from(String(hash), 'hex');
  return b.length === h.length && crypto.timingSafeEqual(h, b);
}
const secret = () => process.env.SESSION_SECRET || 'fallback:' + (process.env.ADMIN_PIN || '');
export function signToken(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + SESSION_HOURS * 3600e3 })).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', secret()).update(body).digest('base64url');
}
function verifyToken(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  if (want.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
export const ownerName = () => process.env.OWNER_NAME || 'Owner';

// Returns { username, name, role } for a valid, still-active session, else null.
export async function userFromToken(token) {
  const p = verifyToken(token);
  if (!p) return null;
  if (p.u === 'owner') return { username: 'owner', name: ownerName(), role: 'admin' };
  const users = (await readJSON(USERS))?.users || [];
  const u = users.find((x) => x.username === p.u);
  if (!u || u.disabled || (u.pwChangedAt && p.iat < u.pwChangedAt)) return null; // disabled or password reset → session ends
  return { username: u.username, name: u.name, role: u.role };
}
export function bearer(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const parseBody = (req) => (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {});

// Adds an entry to the schedule's activity log without touching its updatedAt (so open editors don't conflict).
export async function appendLog(changes, by) {
  const cur = await readJSON(SCHEDULE);
  if (!cur) return;
  cur.log = [{ at: new Date().toISOString(), by, changes }, ...(cur.log || [])].slice(0, 500);
  await writeJSON(SCHEDULE, cur);
}

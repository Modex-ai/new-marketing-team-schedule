// Shared server helpers (files starting with "_" are not exposed as routes on Vercel).
import { put, list, del, get } from '@vercel/blob';
import crypto from 'node:crypto';

export const ACCESS = process.env.BLOB_ACCESS === 'public' ? 'public' : 'private';
export const SCHEDULE = 'marketing-ops/schedule';
export const USERS = 'marketing-ops/users';
export const ROLES = ['admin', 'editor', 'viewer', 'custom'];
// What each signed-in account may do. The built-in "owner" account has everything, plus approving / rejecting records
// (that one is owner-only and can't be given to anyone else).
export const PERMS = ['schedule', 'setup', 'settings', 'records', 'money', 'approve', 'reports', 'sources', 'tasks', 'tasksManage', 'tasksReview', 'log', 'users'];
export const PRESETS = {
  admin: PERMS,
  editor: PERMS.filter((p) => !['users', 'sources', 'settings', 'setup', 'approve'].includes(p)),
  viewer: ['reports', 'tasks'],
};
// accounts made before permissions existed keep what they could do then (admin = everything, editor = all but users & sheets)
const LEGACY = { admin: PERMS, editor: PERMS.filter((p) => !['users', 'sources', 'approve'].includes(p)) };
export const permsOf = (u) => (Array.isArray(u.perms) ? u.perms.filter((p) => PERMS.includes(p)) : LEGACY[u.role] || PRESETS.viewer);
export const can = (me, p) => !!me && (me.owner || (me.perms || []).includes(p));
// scope = the team members this account may see in Reports, Tasks and Profiles (empty = everyone)
export const scopeOf = (u) => (Array.isArray(u.scope) ? u.scope.filter((x) => typeof x === 'string' && x).slice(0, 100) : []);
export const inScope = (me, memberId) => !me || me.owner || !(me.scope || []).length || me.scope.includes(memberId);
export const sessionUser = (u) => ({ username: u.username, name: u.name, role: u.role, perms: permsOf(u), scope: scopeOf(u), owner: false });
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
  const doc = (await readJSON(USERS)) || {};
  if (p.u === 'owner') { const o = doc.owner || {}; if (o.pwChangedAt && p.iat < o.pwChangedAt) return null; return ownerUser(o); }
  const users = doc.users || [];
  const u = users.find((x) => x.username === p.u);
  if (!u || u.disabled || (u.pwChangedAt && p.iat < u.pwChangedAt)) return null; // disabled or password reset → session ends
  return sessionUser(u);
}
// The built-in owner account. Its sign-in name and password can be changed from Manage → Users (stored in the users doc).
export const ownerUser = (o = {}) => ({ username: 'owner', login: o.username || 'owner', name: o.name || ownerName(), role: 'owner', perms: [...PERMS], scope: [], owner: true });
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

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
export const sessionUser = (u) => ({ username: u.username, name: u.name, role: u.role, perms: permsOf(u), scope: scopeOf(u), owner: false, mustChange: !!u.mustChange });
// the owner's one-time recovery code (shown once, stored hashed) — used when the owner password is lost
export const newRecoveryCode = () => crypto.randomBytes(12).toString('hex').toUpperCase().match(/.{1,4}/g).slice(0, 5).join('-');
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

/* ---------- notifications (schedule decisions → schedule editors, submissions → approvers) ---------- */
export const NOTICES = 'marketing-ops/notices';
export const TELEGRAM = 'marketing-ops/telegram';
export async function pushNotices(list, by, origin) {
  const doc = (await readJSON(NOTICES)) || { list: [] }, at = new Date().toISOString();
  const made = list.map((n) => ({ id: crypto.randomBytes(6).toString('hex'), at, by: { username: by.username, name: by.name }, seen: {}, ...n }));
  doc.list = [...made, ...doc.list].slice(0, 300);
  await writeJSON(NOTICES, doc, 5);
  await telegramNotices(made, origin).catch(() => {});
}
// which notices an account receives: never its own; decisions go to schedule editors, submissions to approvers
export const noticeFor = (me, n) => !!me && n.by.username !== me.username && (n.to === 'schedule' ? can(me, 'schedule') : n.to === 'approve' ? can(me, 'approve') : false);

/* ---------- Telegram (optional — needs TELEGRAM_BOT_TOKEN) ---------- */
export const tgToken = () => process.env.TELEGRAM_BOT_TOKEN || '';
export const tgSecret = () => crypto.createHash('sha256').update('tg:' + tgToken() + ':' + (process.env.SESSION_SECRET || process.env.ADMIN_PIN || '')).digest('hex').slice(0, 40);
export async function tgCall(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${tgToken()}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description || 'Telegram error ' + r.status);
  return j.result;
}
const hx = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const DN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayAt = (key, i) => { const d = new Date(key + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i); return d; };
const dTxt = (key, i) => { const d = dayAt(key, i); return `${DN[d.getUTCDay()]} ${d.getUTCDate()} ${MN[d.getUTCMonth()]}`; };
const SYM = { approved: '✅', review: '🟡', rejected: '❌' }, WORD = { approved: 'approved', review: 'sent back to review', rejected: 'rejected' };
export function noticeText(n) {
  const wk = `${dTxt(n.week, 0)} – ${dTxt(n.week, 6)}`, by = hx(n.by.name), days = n.days || [];
  if (n.kind === 'submitted') {
    const which = days.length && days.length < 7 ? `\nChanged: ${days.map((d) => dTxt(n.week, d.i)).join(', ')}` : '';
    return `🟡 <b>Schedule waiting for your approval</b>\nWeek ${wk}\n${n.note === 'New week' ? 'New week created' : 'Changes submitted'} by ${by}${which}`;
  }
  const same = !days.length || (days.length === 7 && days.every((d) => d.status === days[0].status));
  let t = same ? `${SYM[n.status] || '•'} <b>Week ${wk} ${WORD[n.status] || n.status}</b>\nby ${by}` : `${SYM[n.status] || '•'} <b>Week ${wk} reviewed</b> → ${hx(n.status)}\nby ${by}\n${days.map((d) => `${SYM[d.status]} ${dTxt(n.week, d.i)}`).join('\n')}`;
  const why = days.filter((d) => d.status === 'rejected' && d.note);
  if (why.length) t += '\n\n<b>What to fix</b>\n' + why.map((d) => `• ${dTxt(n.week, d.i)} — ${hx(d.note)}`).join('\n');
  if (n.note) t += `\n\n“${hx(n.note)}”`;
  return t;
}
async function telegramNotices(list, origin) {
  if (!tgToken() || !list.length) return;
  const tg = (await readJSON(TELEGRAM)) || {}, links = tg.links || {};
  if (!Object.keys(links).length) return;
  const udoc = (await readJSON(USERS)) || {};
  const accounts = [ownerUser(udoc.owner || {}), ...(udoc.users || []).filter((u) => !u.disabled).map(sessionUser)];
  const sends = [];
  for (const n of list) for (const a of accounts) {
    const l = links[a.username]; if (!l || !noticeFor(a, n)) continue;
    const url = origin && /^https:/.test(origin) ? `${origin}/#week=${n.week}` : '';
    sends.push(tgCall('sendMessage', { chat_id: l.chatId, text: noticeText(n), parse_mode: 'HTML', disable_web_page_preview: true, ...(url ? { reply_markup: { inline_keyboard: [[{ text: n.kind === 'submitted' ? 'Review now' : 'Open the week', url }]] } } : {}) }).catch(() => {}));
  }
  await Promise.all(sends);
}

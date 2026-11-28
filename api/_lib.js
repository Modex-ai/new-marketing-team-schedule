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
  member: ['reports', 'tasks', 'records'], // a team member's personal account
};
// the most a personal account can ever do, whatever is ticked: see her own reports and tasks, request excuses / swaps
export const SELF_MAX = ['reports', 'tasks', 'records'];
// accounts made before permissions existed keep what they could do then (admin = everything, editor = all but users & sheets)
const LEGACY = { admin: PERMS, editor: PERMS.filter((p) => !['users', 'sources', 'approve'].includes(p)) };
export const permsOf = (u) => (Array.isArray(u.perms) ? u.perms.filter((p) => PERMS.includes(p)) : LEGACY[u.role] || PRESETS.viewer);
export const can = (me, p) => !!me && (me.owner || (me.perms || []).includes(p));
// scope = the team members this account may see in Reports, Tasks and Profiles (empty = everyone)
export const scopeOf = (u) => (Array.isArray(u.scope) ? u.scope.filter((x) => typeof x === 'string' && x).slice(0, 100) : []);
export const inScope = (me, memberId) => !me || me.owner || !(me.scope || []).length || me.scope.includes(memberId);
// self: a team member's personal account — it only ever sees (and touches) her own data
export const sessionUser = (u) => { const self = !!(u.self && u.member); return { username: u.username, name: u.name, role: u.role, perms: self ? permsOf(u).filter((p) => SELF_MAX.includes(p)) : permsOf(u), scope: self ? [u.member] : scopeOf(u), owner: false, mustChange: !!u.mustChange, member: u.member || '', self }; };
// the owner's one-time recovery code (shown once, stored hashed) — used when the owner password is lost
export const newRecoveryCode = () => crypto.randomBytes(12).toString('hex').toUpperCase().match(/.{1,4}/g).slice(0, 5).join('-');
const SESSION_HOURS = 24;

/* ---------- JSON documents in Blob (each save is a new version; old versions are trimmed) ---------- */
/* ---------- storage: one JSON document per name, read with as few Blob operations as possible ----------
   Each document lives at a fixed path (marketing-ops/schedule.json …) and is overwritten in place:
   a read is one simple GET (no list()), a write one PUT. A warm function keeps what it read for a few
   seconds, and re-checks with the ETag after that, so busy pages don't multiply storage operations.
   Documents saved by the earlier version (random-suffix copies) are found once and moved to the fixed path. */
const MEM = new Map(); // name → { at, data, etag }
const copy = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
const paused = (e) => /\b403\b|suspend|blocked|limit/i.test(String((e && e.message) || e));
const storeErr = (e) => (paused(e) ? Object.assign(new Error('Temporarily unavailable — please try again later.'), { status: 503 }) : e);
let legacyDone = false;
async function migrateLegacy() { // one list() for everything, the first time a fixed-path document is missing
  if (legacyDone) return; legacyDone = true;
  const { blobs } = await list({ prefix: 'marketing-ops/', limit: 1000 });
  const latest = {};
  for (const b of blobs) {
    const m = /^(marketing-ops\/(?!backups\/)[\w~\/-]+?)-[A-Za-z0-9]{20,}\.json$/.exec(b.pathname); if (!m) continue;
    if (!latest[m[1]] || new Date(b.uploadedAt) > new Date(latest[m[1]].uploadedAt)) latest[m[1]] = b;
  }
  const fixed = new Set(blobs.map((b) => b.pathname)), safe = new Set();
  for (const [name, b] of Object.entries(latest)) {
    if (fixed.has(name + '.json')) { safe.add(name); continue; }
    const r = await get(b.url, { access: ACCESS, useCache: false });
    if (!r || !r.stream) continue;
    const text = await new Response(r.stream).text();
    await put(name + '.json', text, { access: ACCESS, addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
    MEM.delete(name); safe.add(name);
  }
  // remove the old random-suffix copies — only of documents that now exist at their fixed path
  const old = blobs.filter((b) => { const m = /^(marketing-ops\/(?!backups\/)[\w~\/-]+?)-[A-Za-z0-9]{20,}\.json$/.exec(b.pathname); return m && safe.has(m[1]); }).map((b) => b.url);
  if (old.length) await del(old).catch(() => {});
}
// opt.ttl (ms) → a warm copy that young is fine (pages that only read); default: always check the stored copy
export async function readJSON(name, opt = {}) {
  try {
    const c = MEM.get(name), ttl = opt.ttl || 0; // read-mostly callers pass a ttl; anything that writes back reads fresh
    if (c && Date.now() - c.at < ttl) return copy(c.data);
    let r = await get(name + '.json', { access: ACCESS, useCache: false, ...(c && c.etag ? { ifNoneMatch: c.etag } : {}) });
    if (r && r.statusCode === 304 && c) { c.at = Date.now(); return copy(c.data); }
    if (!r && !legacyDone) { await migrateLegacy(); r = await get(name + '.json', { access: ACCESS, useCache: false }); }
    if (!r || !r.stream) { MEM.set(name, { at: Date.now(), data: null, etag: '' }); return null; }
    const data = await new Response(r.stream).json();
    MEM.set(name, { at: Date.now(), data, etag: (r.blob && r.blob.etag) || '' });
    return copy(data);
  } catch (e) { throw storeErr(e); }
}
const backedUp = {};
export async function writeJSON(name, data) {
  try {
    const body = JSON.stringify(data);
    const r = await put(name + '.json', body, { access: ACCESS, addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
    MEM.set(name, { at: Date.now(), data: JSON.parse(body), etag: (r && r.etag) || '' });
    // one dated copy a day of the documents that matter most (schedule, users, attendance), kept for recovery
    const day = new Date().toISOString().slice(0, 10);
    if (/\/(schedule|users|tasks|attendance)$|\/att\//.test(name) && backedUp[name] !== day) { backedUp[name] = day; await put(`marketing-ops/backups/${name.replace('marketing-ops/', '').replace(/[\/~]/g, '_')}-${day}.json`, body, { access: ACCESS, addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' }).catch(() => {}); }
  } catch (e) { throw storeErr(e); }
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
  const doc = (await readJSON(USERS, { ttl: 15000 })) || {};
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
// which notices an account receives — never its own. A notice names its readers by any of:
//   to: a permission ("schedule", "approve", "tasksReview"…) · users: usernames · members: team-member ids (the accounts linked to them)
export const noticeFor = (me, n) => {
  if (!me || (n.by && n.by.username === me.username)) return false;
  if (Array.isArray(n.users) && n.users.includes(me.username)) return true;
  if (Array.isArray(n.members) && me.member && n.members.includes(me.member)) return true;
  return !!n.to && PERMS.includes(n.to) && can(me, n.to);
};
// every account that can sign in (the owner included), for delivering notices and messages
export async function allAccounts() {
  const d = (await readJSON(USERS, { ttl: 15000 })) || {};
  return [ownerUser(d.owner || {}), ...(d.users || []).filter((u) => !u.disabled).map(sessionUser)];
}

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
  if (n.title) { // records, tasks, attendance, messages…
    let t = `${SYM[n.status] || n.icon || '🔔'} <b>${hx(n.title)}</b>`;
    if (n.lines && n.lines.length) t += '\n' + n.lines.map(hx).join('\n');
    if (n.note) t += `\n\n${n.status === 'rejected' ? '<b>Reason:</b> ' : '💬 '}${hx(n.note)}`;
    if (n.by && n.by.name) t += `\n\n— ${hx(n.by.name)}`;
    return t;
  }
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
  const accounts = await allAccounts();
  const sends = [];
  for (const n of list) for (const a of accounts) {
    const l = links[a.username]; if (!l || !noticeFor(a, n)) continue;
    const path = n.week ? `#week=${n.week}` : n.link || '';
    const url = origin && /^https:/.test(origin) && path ? `${origin}/${path}` : '';
    const btn = n.week ? (n.kind === 'submitted' ? 'Review now' : 'Open the week') : n.linkText || 'Open the dashboard';
    sends.push(tgCall('sendMessage', { chat_id: l.chatId, text: noticeText(n), parse_mode: 'HTML', disable_web_page_preview: true, ...(url ? { reply_markup: { inline_keyboard: [[{ text: btn, url }]] } } : {}) }).catch(() => {}));
  }
  await Promise.all(sends);
}

/* ---------- security: sign-in attempts, lockouts and the security log (governance) ---------- */
export const SECURITY = 'marketing-ops/security';
const LOCK_AFTER = 5, LOCK_MIN = 15;
export const clientOf = (req) => ({ ip: String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim().slice(0, 60), ua: String((req.headers && req.headers['user-agent']) || '').slice(0, 140) });
export async function secEvent(ev) {
  const d = (await readJSON(SECURITY)) || { fails: {}, log: [] };
  d.log = [{ at: new Date().toISOString(), ...ev }, ...(d.log || [])].slice(0, 400);
  await writeJSON(SECURITY, d, 3);
}
// → minutes left when the username is locked, else 0
export async function secLocked(uname) {
  const d = (await readJSON(SECURITY)) || {}, f = (d.fails || {})[uname];
  return f && f.until && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 60000) : 0;
}
export async function secResult(uname, ok, client, name) {
  const d = (await readJSON(SECURITY)) || { fails: {}, log: [] };
  d.fails = d.fails || {};
  const at = new Date().toISOString();
  let locked = false;
  if (ok) { delete d.fails[uname]; d.last = { ...(d.last || {}), [uname]: at }; d.log = [{ at, type: 'signin', username: uname, name, ...client }, ...(d.log || [])]; }
  else {
    let f = d.fails[uname] || { n: 0 };
    if ((f.until && f.until < Date.now()) || (f.last && Date.now() - Date.parse(f.last) > LOCK_MIN * 60e3)) f = { n: 0 }; // an old streak starts over
    d.fails[uname] = f;
    f.n = (f.n || 0) + 1; f.last = at;
    if (f.n >= LOCK_AFTER) { f.until = Date.now() + LOCK_MIN * 60e3; f.n = 0; locked = true; }
    d.log = [{ at, type: locked ? 'lockout' : 'failed', username: uname, ...client }, ...(d.log || [])];
  }
  d.log = d.log.slice(0, 400);
  await writeJSON(SECURITY, d, 3);
  if (locked) await pushNotices([{ kind: 'security', to: 'users', status: 'rejected', icon: '🔒', title: `Sign-in locked for “${uname}” — ${LOCK_AFTER} wrong passwords`, lines: [`Locked for ${LOCK_MIN} minutes`, client.ip ? `IP ${client.ip}` : ''].filter(Boolean), link: '#governance', linkText: 'Open governance' }], { username: 'system', name: 'Security' }).catch(() => {});
  return locked;
}

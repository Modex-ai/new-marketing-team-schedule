// User management — accounts with the "users" permission (and the owner).
// GET    /api/users                                         → { users, perms, presets }  (no password data)
// POST   /api/users {username, name, perms|role, password}  → create
// PATCH  /api/users {username, name?, perms?, role?, password?, disabled?}
// DELETE /api/users {username}
// Nobody can give permissions they don't have themselves, change their own permissions, or touch the owner account.
import { readJSON, writeJSON, USERS, PERMS, PRESETS, permsOf, scopeOf, can, hashPassword, checkPassword, signToken, userFromToken, bearer, parseBody, appendLog, sleep, newRecoveryCode, SECURITY, TELEGRAM } from './_lib.js';

const LABEL = { schedule: 'Edit schedule', setup: 'Team & setup', settings: 'Settings', records: 'Excuses & shift changes', money: 'Bonuses & deductions', approve: 'Approve / reject', log: 'Activity log', reports: 'View reports', sources: 'Report sheets', tasks: 'View tasks', tasksManage: 'Assign & manage tasks', tasksReview: 'Review & rate tasks', users: 'Manage users' };
const presetOf = (perms) => Object.keys(PRESETS).find((k) => PRESETS[k].length === perms.length && PRESETS[k].every((p) => perms.includes(p))) || 'custom';
const publicUser = (u) => { const perms = permsOf(u); return { username: u.username, name: u.name, role: presetOf(perms), perms, scope: scopeOf(u), member: u.member || '', self: !!(u.self && u.member), disabled: !!u.disabled, createdAt: u.createdAt, createdBy: u.createdBy, lastLogin: u.lastLogin || null }; };
const roleName = (perms) => { const r = presetOf(perms); return r === 'custom' ? `custom access (${perms.map((p) => LABEL[p]).join(', ') || 'nothing'})` : r[0].toUpperCase() + r.slice(1); };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const me = await userFromToken(bearer(req));
    if (!me) return res.status(401).json({ error: 'Please sign in again' });
    if (!can(me, 'users')) return res.status(403).json({ error: "Your account can't manage users" });
    const by = { username: me.username, name: me.name };
    const reply = (doc, extra) => ({ ok: true, users: doc.users.map(publicUser), resetRequests: (doc.resetRequests || []).filter((r) => doc.users.some((u) => u.username === r.username)), owner: { login: (doc.owner || {}).username || 'owner', name: (doc.owner || {}).name || me.name, custom: !!(doc.owner || {}).hash, recovery: !!(doc.owner || {}).recovery }, perms: PERMS, presets: PRESETS, ...extra });
    // which team members the account sees (empty = everyone); a limited manager can only hand out part of their own list
    const wantScope = (b) => {
      if (!Array.isArray(b.scope)) return null;
      const list = [...new Set(b.scope.filter((x) => typeof x === 'string' && x))].slice(0, 100);
      const mine = me.scope || [];
      if (!me.owner && mine.length && (!list.length || list.some((x) => !mine.includes(x)))) throw Object.assign(new Error("You can only give access to the team members you can see yourself"), { status: 400 });
      return list;
    };
    // the permissions asked for, limited to what this account may hand out
    const wanted = (b) => {
      const list = Array.isArray(b.perms) ? b.perms : PRESETS[b.role] || null;
      if (!list) return null;
      const clean = [...new Set(list.filter((p) => PERMS.includes(p)))];
      const over = clean.filter((p) => !can(me, p));
      if (over.length) throw Object.assign(new Error(`You can't give permissions you don't have: ${over.map((p) => LABEL[p]).join(', ')}`), { status: 400 });
      return clean;
    };

    const doc = (await readJSON(USERS)) || { users: [] };
    doc.users = doc.users || [];
    if (req.method === 'GET') {
      const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
      if (q.governance !== '1') return res.status(200).json(reply(doc));
      // governance view: the security log, live lockouts and who gets alerts on Telegram
      const sec = (await readJSON(SECURITY).catch(() => null)) || {}, tg = (await readJSON(TELEGRAM).catch(() => null)) || {};
      const locks = Object.entries(sec.fails || {}).filter(([, f]) => f.until && f.until > Date.now()).map(([u, f]) => ({ username: u, until: new Date(f.until).toISOString() }));
      return res.status(200).json({ ...reply(doc), security: (sec.log || []).slice(0, 200), locks, telegram: Object.keys(tg.links || {}), ownerLastLogin: (doc.owner || {}).lastLogin || null });
    }

    const b = parseBody(req);
    const ownerLogin = (doc.owner || {}).username || 'owner';

    // the owner changes their own sign-in name / display name / password
    if (req.method === 'PATCH' && b.owner) {
      if (!me.owner) return res.status(403).json({ error: 'Only the owner can change the owner account' });
      const o = (doc.owner = doc.owner || {}), changes = [];
      // changing the sign-in name or password needs the current password (or the PIN until a password is set)
      const curOk = o.hash ? checkPassword(b.current || '', o.salt, o.hash) : !!process.env.ADMIN_PIN && String(b.current || '') === String(process.env.ADMIN_PIN);
      const sensitive = b.password || b.newRecovery || (b.login !== undefined && String(b.login).trim().toLowerCase() !== ownerLogin);
      if (sensitive && !curOk) { await sleep(700); return res.status(400).json({ error: 'Your current password is wrong' }); }
      let recoveryCode = null;
      if (b.newRecovery) { recoveryCode = newRecoveryCode(); o.recovery = hashPassword(recoveryCode); changes.push('Users: owner generated a new recovery code'); }
      if (b.login !== undefined) {
        const l = String(b.login).trim().toLowerCase();
        if (!/^[a-z0-9._-]{3,32}$/.test(l)) return res.status(400).json({ error: 'Username: 3–32 letters, numbers, dot, dash or underscore' });
        if (doc.users.some((x) => x.username === l)) return res.status(409).json({ error: 'A user already has that username' });
        if (l !== ownerLogin) { o.username = l; changes.push(`Users: owner sign-in name changed to @${l}`); }
      }
      if (b.name !== undefined && String(b.name).trim() && String(b.name).trim() !== (o.name || me.name)) { o.name = String(b.name).trim().slice(0, 60); changes.push(`Users: owner display name → ${o.name}`); }
      let token = null;
      if (b.password) {
        if (String(b.password).length < 8) return res.status(400).json({ error: 'The owner password must be at least 8 characters' });
        const now = Date.now();
        Object.assign(o, hashPassword(b.password), { pwChangedAt: now });
        if (!o.recovery) { recoveryCode = newRecoveryCode(); o.recovery = hashPassword(recoveryCode); }
        token = signToken({ u: 'owner', iat: now + 1 }); // this session stays signed in; every other owner session ends
        changes.push('Users: owner password changed — other owner sessions signed out');
      }
      if (!changes.length) return res.status(200).json(reply(doc));
      await writeJSON(USERS, doc, 10);
      await appendLog(changes, by);
      return res.status(200).json(reply(doc, { ...(token ? { token } : {}), ...(recoveryCode ? { recoveryCode } : {}) }));
    }
    const uname = String(b.username || '').trim().toLowerCase();
    const u = doc.users.find((x) => x.username === uname);

    if (req.method === 'POST') {
      if (!/^[a-z0-9._-]{3,32}$/.test(uname) || uname === 'owner' || uname === ownerLogin) return res.status(400).json({ error: 'Username: 3–32 letters, numbers, dot, dash or underscore' });
      if (u) return res.status(409).json({ error: 'That username already exists' });
      const name = String(b.name || '').trim().slice(0, 60);
      if (!name) return res.status(400).json({ error: "Enter the person's name" });
      if (String(b.password || '').length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
      const perms = wanted(b) || PRESETS.viewer, scope = wantScope(b) || (me.scope || []).slice();
      const member = typeof b.member === 'string' ? b.member.slice(0, 80) : '';
      doc.users.push({ username: uname, name, role: presetOf(perms), perms, scope, member, self: !!(b.self && member), ...hashPassword(b.password), createdAt: new Date().toISOString(), createdBy: me.name, disabled: false, lastLogin: null });
      await writeJSON(USERS, doc, 10);
      await appendLog([`Users: added ${name} (@${uname}) — ${roleName(perms)}`], by);
      return res.status(200).json(reply(doc));
    }

    if (!u) return res.status(404).json({ error: 'User not found' });

    if (req.method === 'PATCH') {
      const changes = [];
      // end every session of this account (lost phone, shared device, someone leaving)
      if (b.endSessions) { u.pwChangedAt = Date.now(); await writeJSON(USERS, doc, 10); await appendLog([`Users: signed ${u.name} (@${uname}) out of every device`], by); return res.status(200).json(reply(doc)); }
      if (b.name !== undefined && String(b.name).trim() && String(b.name).trim() !== u.name) { changes.push(`Users: renamed @${uname} ${u.name} → ${String(b.name).trim()}`); u.name = String(b.name).trim().slice(0, 60); }
      if (b.perms !== undefined || b.role !== undefined) {
        if (uname === me.username) return res.status(400).json({ error: "You can't change your own permissions" });
        const before = permsOf(u);
        // taking away a permission you don't have yourself isn't allowed either
        const lost = before.filter((p) => !can(me, p));
        const next = [...new Set([...(wanted(b) || before), ...lost])];
        const added = next.filter((p) => !before.includes(p)), removed = before.filter((p) => !next.includes(p));
        if (added.length || removed.length) {
          u.perms = next; u.role = presetOf(next);
          changes.push(`Users: ${u.name} (@${uname}) permissions${added.length ? ` + ${added.map((p) => LABEL[p]).join(', ')}` : ''}${removed.length ? ` − ${removed.map((p) => LABEL[p]).join(', ')}` : ''}`);
        }
      }
      // which team member this account belongs to (her check-ins, her records and tasks reach her)
      if (typeof b.member === 'string' && b.member.slice(0, 80) !== (u.member || '')) { u.member = b.member.slice(0, 80); changes.push(`Users: ${u.name} (@${uname}) ${u.member ? 'linked to a team member' : 'unlinked from the team'}`); }
      if (typeof b.self === 'boolean' && b.self !== !!u.self) { u.self = b.self; changes.push(`Users: ${u.name} (@${uname}) ${b.self ? 'sees only her own data' : 'sees her usual access again'}`); }
      if (b.scope !== undefined) {
        if (uname === me.username) return res.status(400).json({ error: "You can't change your own access" });
        const next = wantScope(b), before = scopeOf(u);
        if (next && next.join() !== before.join()) { u.scope = next; changes.push(`Users: ${u.name} (@${uname}) sees ${next.length ? next.length + ' team member' + (next.length === 1 ? '' : 's') + ' only' : 'the whole team'}`); }
      }
      if (b.disabled !== undefined && !!b.disabled !== !!u.disabled) {
        if (uname === me.username) return res.status(400).json({ error: "You can't disable your own account" });
        u.disabled = !!b.disabled; changes.push(`Users: ${u.disabled ? 'froze' : 'activated'} ${u.name} (@${uname})`);
      }
      if (b.password) {
        if (String(b.password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
        // a password set by someone else is temporary — the person must choose their own at the next sign-in
        Object.assign(u, hashPassword(b.password), { pwChangedAt: Date.now(), mustChange: true });
        doc.resetRequests = (doc.resetRequests || []).filter((r) => r.username !== uname);
        changes.push(`Users: set a temporary password for ${u.name} (@${uname})`);
      }
      if (!changes.length) return res.status(200).json(reply(doc));
      await writeJSON(USERS, doc, 10);
      await appendLog(changes, by);
      return res.status(200).json(reply(doc));
    }

    if (req.method === 'DELETE') {
      if (uname === me.username) return res.status(400).json({ error: "You can't delete your own account" });
      if (!me.owner && permsOf(u).some((p) => !can(me, p))) return res.status(403).json({ error: 'Only the owner can delete an account with more access than yours' });
      doc.users = doc.users.filter((x) => x.username !== uname);
      await writeJSON(USERS, doc, 10);
      await appendLog([`Users: deleted ${u.name} (@${uname})`], by);
      return res.status(200).json(reply(doc));
    }

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(e.status || 500).json({ error: String((e && e.message) || e) });
  }
}

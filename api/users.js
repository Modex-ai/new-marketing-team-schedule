// User management — accounts with the "users" permission (and the owner).
// GET    /api/users                                         → { users, perms, presets }  (no password data)
// POST   /api/users {username, name, perms|role, password}  → create
// PATCH  /api/users {username, name?, perms?, role?, password?, disabled?}
// DELETE /api/users {username}
// Nobody can give permissions they don't have themselves, change their own permissions, or touch the owner account.
import { readJSON, writeJSON, USERS, PERMS, PRESETS, permsOf, can, hashPassword, userFromToken, bearer, parseBody, appendLog } from './_lib.js';

const LABEL = { schedule: 'Edit schedule', setup: 'Team & setup', settings: 'Settings', records: 'Excuses & shift changes', money: 'Bonuses & deductions', reports: 'View reports', sources: 'Report sheets', tasks: 'View tasks', tasksManage: 'Assign & manage tasks', tasksReview: 'Review & rate tasks', users: 'Manage users' };
const presetOf = (perms) => Object.keys(PRESETS).find((k) => PRESETS[k].length === perms.length && PRESETS[k].every((p) => perms.includes(p))) || 'custom';
const publicUser = (u) => { const perms = permsOf(u); return { username: u.username, name: u.name, role: presetOf(perms), perms, disabled: !!u.disabled, createdAt: u.createdAt, createdBy: u.createdBy, lastLogin: u.lastLogin || null }; };
const roleName = (perms) => { const r = presetOf(perms); return r === 'custom' ? `custom access (${perms.map((p) => LABEL[p]).join(', ') || 'nothing'})` : r[0].toUpperCase() + r.slice(1); };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const me = await userFromToken(bearer(req));
    if (!me) return res.status(401).json({ error: 'Please sign in again' });
    if (!can(me, 'users')) return res.status(403).json({ error: "Your account can't manage users" });
    const by = { username: me.username, name: me.name };
    const reply = (doc) => ({ ok: true, users: doc.users.map(publicUser), perms: PERMS, presets: PRESETS });
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
    if (req.method === 'GET') return res.status(200).json(reply(doc));

    const b = parseBody(req);
    const uname = String(b.username || '').trim().toLowerCase();
    const u = doc.users.find((x) => x.username === uname);

    if (req.method === 'POST') {
      if (!/^[a-z0-9._-]{3,32}$/.test(uname) || uname === 'owner') return res.status(400).json({ error: 'Username: 3–32 letters, numbers, dot, dash or underscore' });
      if (u) return res.status(409).json({ error: 'That username already exists' });
      const name = String(b.name || '').trim().slice(0, 60);
      if (!name) return res.status(400).json({ error: "Enter the person's name" });
      if (String(b.password || '').length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
      const perms = wanted(b) || PRESETS.viewer;
      doc.users.push({ username: uname, name, role: presetOf(perms), perms, ...hashPassword(b.password), createdAt: new Date().toISOString(), createdBy: me.name, disabled: false, lastLogin: null });
      await writeJSON(USERS, doc, 10);
      await appendLog([`Users: added ${name} (@${uname}) — ${roleName(perms)}`], by);
      return res.status(200).json(reply(doc));
    }

    if (!u) return res.status(404).json({ error: 'User not found' });

    if (req.method === 'PATCH') {
      const changes = [];
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
      if (b.disabled !== undefined && !!b.disabled !== !!u.disabled) {
        if (uname === me.username) return res.status(400).json({ error: "You can't disable your own account" });
        u.disabled = !!b.disabled; changes.push(`Users: ${u.disabled ? 'disabled' : 're-enabled'} ${u.name} (@${uname})`);
      }
      if (b.password) {
        if (String(b.password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
        Object.assign(u, hashPassword(b.password), { pwChangedAt: Date.now() });
        changes.push(`Users: reset password for ${u.name} (@${uname})`);
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

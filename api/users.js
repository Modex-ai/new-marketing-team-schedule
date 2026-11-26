// User management — admins only.
// GET    /api/users                                  → { users }  (no password data)
// POST   /api/users {username, name, role, password} → create
// PATCH  /api/users {username, name?, role?, password?, disabled?}
// DELETE /api/users {username}
import { readJSON, writeJSON, USERS, ROLES, hashPassword, userFromToken, bearer, parseBody, appendLog } from './_lib.js';

const publicUser = (u) => ({ username: u.username, name: u.name, role: u.role, disabled: !!u.disabled, createdAt: u.createdAt, createdBy: u.createdBy, lastLogin: u.lastLogin || null });
const roleName = (r) => (r === 'admin' ? 'Admin' : 'Editor');

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const me = await userFromToken(bearer(req));
    if (!me) return res.status(401).json({ error: 'Please sign in again' });
    if (me.role !== 'admin') return res.status(403).json({ error: 'Only admins can manage users' });
    const by = { username: me.username, name: me.name };

    const doc = (await readJSON(USERS)) || { users: [] };
    if (req.method === 'GET') return res.status(200).json({ users: doc.users.map(publicUser) });

    const b = parseBody(req);
    const uname = String(b.username || '').trim().toLowerCase();
    const u = doc.users.find((x) => x.username === uname);

    if (req.method === 'POST') {
      if (!/^[a-z0-9._-]{3,32}$/.test(uname) || uname === 'owner') return res.status(400).json({ error: 'Username: 3–32 letters, numbers, dot, dash or underscore' });
      if (u) return res.status(409).json({ error: 'That username already exists' });
      const name = String(b.name || '').trim().slice(0, 60);
      if (!name) return res.status(400).json({ error: 'Enter the person\'s name' });
      if (String(b.password || '').length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
      const role = ROLES.includes(b.role) ? b.role : 'editor';
      doc.users.push({ username: uname, name, role, ...hashPassword(b.password), createdAt: new Date().toISOString(), createdBy: me.name, disabled: false, lastLogin: null });
      await writeJSON(USERS, doc, 10);
      await appendLog([`Users: added ${name} (@${uname}) as ${roleName(role)}`], by);
      return res.status(200).json({ ok: true, users: doc.users.map(publicUser) });
    }

    if (!u) return res.status(404).json({ error: 'User not found' });

    if (req.method === 'PATCH') {
      const changes = [];
      if (b.name !== undefined && String(b.name).trim() && String(b.name).trim() !== u.name) { changes.push(`Users: renamed @${uname} ${u.name} → ${String(b.name).trim()}`); u.name = String(b.name).trim().slice(0, 60); }
      if (b.role !== undefined && ROLES.includes(b.role) && b.role !== u.role) {
        if (uname === me.username) return res.status(400).json({ error: 'You can\'t change your own role' });
        changes.push(`Users: ${u.name} (@${uname}) role ${roleName(u.role)} → ${roleName(b.role)}`); u.role = b.role;
      }
      if (b.disabled !== undefined && !!b.disabled !== !!u.disabled) {
        if (uname === me.username) return res.status(400).json({ error: 'You can\'t disable your own account' });
        u.disabled = !!b.disabled; changes.push(`Users: ${u.disabled ? 'disabled' : 're-enabled'} ${u.name} (@${uname})`);
      }
      if (b.password) {
        if (String(b.password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
        Object.assign(u, hashPassword(b.password), { pwChangedAt: Date.now() });
        changes.push(`Users: reset password for ${u.name} (@${uname})`);
      }
      if (!changes.length) return res.status(200).json({ ok: true, users: doc.users.map(publicUser) });
      await writeJSON(USERS, doc, 10);
      await appendLog(changes, by);
      return res.status(200).json({ ok: true, users: doc.users.map(publicUser) });
    }

    if (req.method === 'DELETE') {
      if (uname === me.username) return res.status(400).json({ error: 'You can\'t delete your own account' });
      doc.users = doc.users.filter((x) => x.username !== uname);
      await writeJSON(USERS, doc, 10);
      await appendLog([`Users: deleted ${u.name} (@${uname})`], by);
      return res.status(200).json({ ok: true, users: doc.users.map(publicUser) });
    }

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}

// POST /api/auth {username, password} → { token, user }   (sign in)
// GET  /api/auth  (Authorization: Bearer …)  → { user }   (who am I)
// The owner can always sign in as "owner" with the ADMIN_PIN (break-glass account).
import { readJSON, writeJSON, USERS, checkPassword, signToken, userFromToken, bearer, sleep, parseBody, ownerUser, sessionUser } from './_lib.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const user = await userFromToken(bearer(req));
      return user ? res.status(200).json({ user }) : res.status(401).json({ error: 'Signed out' });
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'method not allowed' });
    }
    const { username = '', password = '' } = parseBody(req);
    const uname = String(username).trim().toLowerCase();
    const now = Date.now();

    const doc = (await readJSON(USERS)) || { users: [] };
    const o = doc.owner || {}, ownerLogin = o.username || 'owner';
    if (uname === ownerLogin) {
      // the owner's own password once set; until then the ADMIN_PIN
      const ok = o.hash ? checkPassword(password, o.salt, o.hash) : !!process.env.ADMIN_PIN && String(password) === String(process.env.ADMIN_PIN);
      if (ok) return res.status(200).json({ token: signToken({ u: 'owner', iat: now }), user: ownerUser(o) });
    } else {
      doc.users = doc.users || [];
      const u = doc.users.find((x) => x.username === uname);
      if (u && !u.disabled && checkPassword(password, u.salt, u.hash)) {
        u.lastLogin = new Date(now).toISOString();
        await writeJSON(USERS, doc, 10);
        return res.status(200).json({ token: signToken({ u: u.username, iat: now }), user: sessionUser(u) });
      }
    }
    await sleep(800); // slow down guessing
    return res.status(401).json({ error: 'Wrong username or password' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}

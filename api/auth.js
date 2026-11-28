// POST /api/auth {username, password}                         → { token, user }      sign in
// POST /api/auth {action:'change', current, password}  (signed in) → { token }    change my own password (needs the current one)
// POST /api/auth {action:'forgot', username}                  → { ok }            ask an admin to reset my password
// POST /api/auth {action:'recover', username, code, password} → { token, user }   owner: new password with the recovery code
// GET  /api/auth  (Authorization: Bearer …)                    → { user }          who am I
// The owner signs in with their own password once set (until then the ADMIN_PIN).
import { readJSON, writeJSON, USERS, hashPassword, checkPassword, signToken, userFromToken, bearer, sleep, parseBody, ownerUser, sessionUser, appendLog, newRecoveryCode, clientOf, secLocked, secResult } from './_lib.js';

const ownerOk = (o, pw) => (o.hash ? checkPassword(pw, o.salt, o.hash) : !!process.env.ADMIN_PIN && String(pw) === String(process.env.ADMIN_PIN));

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
    const b = parseBody(req);
    const now = Date.now();
    const doc = (await readJSON(USERS)) || { users: [] };
    doc.users = doc.users || [];
    const o = doc.owner || {}, ownerLogin = o.username || 'owner';

    // change my own password — the current password is required
    if (b.action === 'change') {
      const me = await userFromToken(bearer(req));
      if (!me) return res.status(401).json({ error: 'Please sign in again' });
      const pw = String(b.password || '');
      if (me.owner) {
        if (!ownerOk(o, b.current)) { await sleep(600); return res.status(400).json({ error: 'Your current password is wrong' }); }
        if (pw.length < 8) return res.status(400).json({ error: 'The new password must be at least 8 characters' });
        doc.owner = Object.assign(o, hashPassword(pw), { pwChangedAt: now });
        let code = null;
        if (!o.recovery) { code = newRecoveryCode(); o.recovery = hashPassword(code); }
        await writeJSON(USERS, doc, 10);
        await appendLog(['Users: owner changed their password — other owner sessions signed out'], { username: me.username, name: me.name });
        return res.status(200).json({ ok: true, token: signToken({ u: 'owner', iat: now + 1 }), recoveryCode: code });
      }
      const u = doc.users.find((x) => x.username === me.username);
      if (!u || !checkPassword(b.current, u.salt, u.hash)) { await sleep(600); return res.status(400).json({ error: 'Your current password is wrong' }); }
      if (pw.length < 6) return res.status(400).json({ error: 'The new password must be at least 6 characters' });
      if (checkPassword(pw, u.salt, u.hash)) return res.status(400).json({ error: 'Choose a password different from the current one' });
      Object.assign(u, hashPassword(pw), { pwChangedAt: now, mustChange: false });
      await writeJSON(USERS, doc, 10);
      await appendLog([`Users: ${u.name} (@${u.username}) changed their password`], { username: u.username, name: u.name });
      return res.status(200).json({ ok: true, token: signToken({ u: u.username, iat: now + 1 }), user: sessionUser(u) });
    }

    // "forgot my password" — goes to whoever manages users (no hint whether the username exists)
    if (b.action === 'forgot') {
      const uname = String(b.username || '').trim().toLowerCase();
      const u = doc.users.find((x) => x.username === uname);
      if (u && !u.disabled) {
        doc.resetRequests = (doc.resetRequests || []).filter((r) => r.username !== uname);
        doc.resetRequests.unshift({ username: uname, name: u.name, at: new Date(now).toISOString() });
        doc.resetRequests = doc.resetRequests.slice(0, 50);
        await writeJSON(USERS, doc, 10);
        await appendLog([`Users: ${u.name} (@${uname}) asked for a password reset`], { username: uname, name: u.name });
      }
      await sleep(400);
      return res.status(200).json({ ok: true });
    }

    // owner lost the password → recovery code
    if (b.action === 'recover') {
      const uname = String(b.username || '').trim().toLowerCase(), pw = String(b.password || '');
      const code = String(b.code || '').trim().toUpperCase();
      if (uname !== ownerLogin || !o.recovery || !checkPassword(code, o.recovery.salt, o.recovery.hash)) { await sleep(900); return res.status(400).json({ error: 'That recovery code is not valid' }); }
      if (pw.length < 8) return res.status(400).json({ error: 'The new password must be at least 8 characters' });
      const next = newRecoveryCode();
      Object.assign(o, hashPassword(pw), { pwChangedAt: now, recovery: hashPassword(next) });
      doc.owner = o;
      await writeJSON(USERS, doc, 10);
      await appendLog(['Users: owner password reset with the recovery code — a new code was issued'], { username: 'owner', name: o.name || 'Owner' });
      return res.status(200).json({ token: signToken({ u: 'owner', iat: now + 1 }), user: ownerUser(o), recoveryCode: next });
    }

    // sign in
    // 5 wrong passwords lock the username for 15 minutes; every sign-in is written to the security log
    const uname = String(b.username || '').trim().toLowerCase(), password = b.password || '', client = clientOf(req);
    const wait = uname ? await secLocked(uname) : 0;
    if (wait) { await sleep(600); return res.status(429).json({ error: `Too many wrong passwords — try again in ${wait} minute${wait === 1 ? '' : 's'}` }); }
    if (uname === ownerLogin) {
      if (ownerOk(o, password)) {
        o.lastLogin = new Date(now).toISOString(); doc.owner = o; await writeJSON(USERS, doc, 10);
        await secResult(uname, true, client, o.name || 'Owner').catch(() => {});
        return res.status(200).json({ token: signToken({ u: 'owner', iat: now }), user: ownerUser(o) });
      }
    } else {
      const u = doc.users.find((x) => x.username === uname);
      if (u && checkPassword(password, u.salt, u.hash)) {
        if (u.disabled) { await sleep(400); return res.status(403).json({ error: 'This account is frozen — ask an admin to activate it' }); }
        u.lastLogin = new Date(now).toISOString();
        await writeJSON(USERS, doc, 10);
        await secResult(uname, true, client, u.name).catch(() => {});
        return res.status(200).json({ token: signToken({ u: u.username, iat: now }), user: sessionUser(u) });
      }
    }
    const locked = uname ? await secResult(uname, false, client).catch(() => false) : false;
    await sleep(800); // slow down guessing
    return res.status(locked ? 429 : 401).json({ error: locked ? 'Too many wrong passwords — this sign-in is locked for 15 minutes' : 'Wrong username or password' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}

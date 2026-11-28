// Messages between dashboard accounts (also delivered to / answered from Telegram).
// GET  /api/messages                                   → { threads, contacts, unread }
// POST /api/messages { action: "send", to: [usernames] | "all", text } → { ok, sent }
// POST /api/messages { action: "read", id }            → marks a conversation as read
import { readJSON, writeJSON, userFromToken, bearer, parseBody, allAccounts } from './_lib.js';
import { MSGS, contactsOf, sendMessage } from './_messages.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const me = await userFromToken(bearer(req));
    if (!me) return res.status(401).json({ error: 'Please sign in again' });
    const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
    if (req.method === 'GET') {
      const doc = (await readJSON(MSGS, { ttl: 5000 })) || { threads: {} }, accounts = await allAccounts();
      const byU = Object.fromEntries(accounts.map((a) => [a.username, a]));
      const threads = Object.values(doc.threads || {}).filter((t) => t.users.includes(me.username)).map((t) => {
        const other = t.users.find((u) => u !== me.username), seen = (t.read || {})[me.username] || '';
        return { id: t.id, with: { username: other, name: (byU[other] || {}).name || other, member: (byU[other] || {}).member || '' }, last: t.last, msgs: t.msgs.slice(-150), unread: t.msgs.filter((m) => m.from.username !== me.username && m.at > seen).length };
      }).sort((a, b) => String(b.last).localeCompare(String(a.last)));
      const contacts = contactsOf(me, accounts).map((a) => ({ username: a.username, name: a.name, member: a.member || '', owner: !!a.owner }));
      return res.status(200).json({ threads, contacts, unread: threads.reduce((n, t) => n + t.unread, 0) });
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'method not allowed' }); }
    const b = parseBody(req);
    if (b.action === 'send') {
      const accounts = await allAccounts();
      const to = b.to === 'all' ? contactsOf(me, accounts).map((a) => a.username) : Array.isArray(b.to) ? b.to.map(String) : [];
      const sent = await sendMessage(me, to, b.text, 'dashboard', origin);
      return res.status(200).json({ ok: true, sent });
    }
    if (b.action === 'read') {
      const doc = (await readJSON(MSGS)) || { threads: {} }, t = (doc.threads || {})[String(b.id || '')];
      if (t && t.users.includes(me.username)) { t.read = { ...(t.read || {}), [me.username]: new Date().toISOString() }; await writeJSON(MSGS, doc, 5); }
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    return res.status(e.status || 500).json({ error: String((e && e.message) || e) });
  }
}

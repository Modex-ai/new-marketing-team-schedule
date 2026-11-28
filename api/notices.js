// Notifications for signed-in accounts.
// GET  /api/notices                       → { list, unread }   (the 40 latest this account receives)
// POST /api/notices { action: "seen", ids? } → marks the given notices (or all of them) as read for this account
// Notices are written by /api/schedule when a week or day is approved / rejected / sent back to review
// (→ everyone who edits the schedule) or when an editor submits schedule changes (→ approvers).
import { readJSON, writeJSON, userFromToken, bearer, parseBody, NOTICES, noticeFor } from './_lib.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const me = await userFromToken(bearer(req));
    if (!me) return res.status(401).json({ error: 'Please sign in again' });
    const doc = (await readJSON(NOTICES)) || { list: [] };
    if (req.method === 'GET') {
      const mine = doc.list.filter((n) => noticeFor(me, n)).slice(0, 40);
      const list = mine.map(({ seen, ...n }) => ({ ...n, read: !!(seen || {})[me.username] }));
      return res.status(200).json({ list, unread: list.filter((n) => !n.read).length });
    }
    if (req.method === 'POST') {
      const body = parseBody(req);
      if (body.action !== 'seen') return res.status(400).json({ error: 'unknown action' });
      const ids = Array.isArray(body.ids) ? new Set(body.ids.map(String)) : null, at = new Date().toISOString();
      let n = 0;
      for (const x of doc.list) if (noticeFor(me, x) && (!ids || ids.has(x.id)) && !(x.seen || {})[me.username]) { x.seen = { ...(x.seen || {}), [me.username]: at }; n++; }
      if (n) await writeJSON(NOTICES, doc, 5);
      return res.status(200).json({ ok: true, marked: n });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}

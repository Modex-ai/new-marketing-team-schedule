// GET /api/schedule                         → { data }          (public, read-only)
// PUT /api/schedule {data, baseUpdatedAt, changes}  (signed in) → { ok, updatedAt, entry }
//
// Env vars:
//   BLOB_READ_WRITE_TOKEN — added automatically when the Blob store is connected
//   ADMIN_PIN             — password of the built-in "owner" account
//   SESSION_SECRET        — signs login sessions
//   OWNER_NAME            — optional display name for the owner account
//   BLOB_ACCESS           — optional: 'private' (default) or 'public'
import { readJSON, writeJSON, SCHEDULE, userFromToken, bearer, parseBody } from './_lib.js';

function validate(d) {
  if (!d || typeof d !== 'object') return 'data missing';
  for (const k of ['members', 'shiftTypes', 'responsibilities', 'timeSlots']) if (!Array.isArray(d[k])) return k + ' must be an array';
  if (!d.weeks || typeof d.weeks !== 'object') return 'weeks missing';
  if (!d.settings || typeof d.settings !== 'object') return 'settings missing';
  if (JSON.stringify(d).length > 3_000_000) return 'data too large';
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') return res.status(200).json({ data: await readJSON(SCHEDULE) });

    if (req.method !== 'PUT') {
      res.setHeader('Allow', 'GET, PUT');
      return res.status(405).json({ error: 'method not allowed' });
    }
    const me = await userFromToken(bearer(req));
    if (!me) return res.status(401).json({ error: 'Please sign in again' });

    const body = parseBody(req);
    const data = body.data;
    const err = validate(data);
    if (err) return res.status(400).json({ error: err });

    const current = await readJSON(SCHEDULE);
    if (current && current.updatedAt && body.baseUpdatedAt !== current.updatedAt && !body.force) {
      return res.status(409).json({ error: 'Someone else saved changes first. Refresh the page, then edit again.', updatedAt: current.updatedAt });
    }

    // Only admins choose which Google Sheets the Reports page reads (an editor's save keeps the stored list).
    if (me.role !== 'admin') {
      if (current && Array.isArray(current.reportSources)) data.reportSources = current.reportSources;
      else delete data.reportSources;
    }
    data.updatedAt = new Date().toISOString();
    data.updatedBy = me.name;
    // activity log — the server stamps time and author; history comes from the stored copy, not the client
    const changes = Array.isArray(body.changes)
      ? body.changes.filter((x) => typeof x === 'string' && x.trim()).slice(0, 200).map((x) => x.slice(0, 400))
      : [];
    const prevLog = current && Array.isArray(current.log) ? current.log : [];
    const entry = changes.length ? { at: data.updatedAt, by: { username: me.username, name: me.name }, changes } : null;
    data.log = entry ? [entry, ...prevLog].slice(0, 500) : prevLog;

    await writeJSON(SCHEDULE, data);
    return res.status(200).json({ ok: true, updatedAt: data.updatedAt, entry });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}

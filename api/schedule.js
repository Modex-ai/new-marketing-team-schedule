// GET /api/schedule                         → { data }          (public, read-only)
// PUT /api/schedule {data, baseUpdatedAt, changes}  (signed in) → { ok, updatedAt, entry }
//
// Env vars:
//   BLOB_READ_WRITE_TOKEN — added automatically when the Blob store is connected
//   ADMIN_PIN             — password of the built-in "owner" account
//   SESSION_SECRET        — signs login sessions
//   OWNER_NAME            — optional display name for the owner account
//   BLOB_ACCESS           — optional: 'private' (default) or 'public'
import { readJSON, writeJSON, SCHEDULE, userFromToken, bearer, parseBody, can, inScope } from './_lib.js';

function validate(d) {
  if (!d || typeof d !== 'object') return 'data missing';
  for (const k of ['members', 'shiftTypes', 'responsibilities', 'timeSlots']) if (!Array.isArray(d[k])) return k + ' must be an array';
  if (!d.weeks || typeof d.weeks !== 'object') return 'weeks missing';
  if (!d.settings || typeof d.settings !== 'object') return 'settings missing';
  if (JSON.stringify(d).length > 3_000_000) return 'data too large';
  return null;
}

const keep = (data, current, k) => { if (!current) return; if (current[k] !== undefined) data[k] = current[k]; else delete data[k]; };
const moneyType = (t) => t === 'bonus' || t === 'deduction';
// Records (excuses, swaps, bonuses, deductions): only the owner and accounts with "approve" approve or reject. Everyone else adds them
// "under review" (status pending, not applied to the schedule) and can only edit or delete pending ones.
function mergeRecords(me, inc, cur) {
  // records of team members outside this account's scope were never sent to it — keep them as stored
  const vis = (r) => inScope(me, r.member) || (r.withMember && inScope(me, r.withMember));
  const hidden = (cur || []).filter((r) => !vis(r));
  inc = (inc || []).filter((r) => r && vis(r));
  cur = (cur || []).filter(vis);
  if (can(me, 'approve')) return [...inc, ...hidden];
  const okType = (t) => can(me, moneyType(t) ? 'money' : 'records');
  const byId = new Map((inc || []).map((r) => [r && r.id, r]));
  const out = [];
  for (const s of cur || []) {
    const i = byId.get(s.id);
    byId.delete(s.id);
    if (!i) { if (s.status === 'pending' && okType(s.type)) continue; out.push(s); continue; } // deleted
    if (!okType(s.type)) { out.push(s); continue; }
    if (s.status !== 'pending') { out.push({ ...s, details: i.details, attachments: i.attachments }); continue; }
    out.push({ ...i, type: s.type, status: 'pending', applied: !!s.applied, ref: s.ref });
  }
  for (const i of byId.values()) if (i && i.id && okType(i.type)) { const r = { ...i, status: 'pending' }; delete r.applied; out.push(r); }
  return [...out, ...hidden];
}
function enforcePerms(me, data, current) {
  if (me.owner) return '';
  let allowed = 0;
  if (can(me, 'schedule')) allowed++; else keep(data, current, 'weeks');
  if (can(me, 'setup')) allowed++; else ['members', 'shiftTypes', 'responsibilities', 'timeSlots'].forEach((k) => keep(data, current, k));
  if (can(me, 'settings')) allowed++; else keep(data, current, 'settings');
  if (can(me, 'sources')) allowed++; else keep(data, current, 'reportSources');
  if (can(me, 'records') || can(me, 'money')) allowed++;
  data.requests = mergeRecords(me, data.requests, current ? current.requests : []);
  if (!data.weeks) data.weeks = {};
  return allowed ? '' : 'nothing';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      // the activity log is only sent to accounts allowed to see it
      const data = await readJSON(SCHEDULE), me = await userFromToken(bearer(req)).catch(() => null);
      if (data && !can(me, 'log')) delete data.log;
      // excuses / bonuses / deductions and the report sheet list are for signed-in accounts only;
      // an account limited to some team members only gets theirs
      if (data && !me) { delete data.requests; delete data.reportSources; }
      else if (data && Array.isArray(data.requests)) data.requests = data.requests.filter((r) => inScope(me, r.member) || (r.withMember && inScope(me, r.withMember)));
      return res.status(200).json({ data });
    }

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

    // A page that was opened signed-out never received the records / report sheets — never let it wipe them.
    if (!body.recordsLoaded && current) { data.requests = current.requests || []; if (current.reportSources) data.reportSources = current.reportSources; }
    // Permissions: whatever this account isn't allowed to change is put back to the stored copy.
    if (enforcePerms(me, data, current) === 'nothing') return res.status(403).json({ error: "Your account can't edit the schedule" });
    data.updatedAt = new Date().toISOString();
    data.updatedBy = me.name;
    // activity log — the server stamps time and author; history comes from the stored copy, not the client
    const changes = Array.isArray(body.changes)
      ? body.changes.filter((x) => typeof x === 'string' && x.trim()).slice(0, 200).map((x) => x.slice(0, 400))
      : [];
    // approvals are the owner's: a status / apply line from anyone else never reaches the log (the server kept the old value)
    if (!can(me, 'approve')) for (let k = changes.length - 1; k >= 0; k--) if (/^Records: .* — status |^Records: applied /.test(changes[k])) changes.splice(k, 1);
    const prevLog = current && Array.isArray(current.log) ? current.log : [];
    const entry = changes.length ? { at: data.updatedAt, by: { username: me.username, name: me.name }, changes } : null;
    data.log = entry ? [entry, ...prevLog].slice(0, 500) : prevLog;

    await writeJSON(SCHEDULE, data);
    return res.status(200).json({ ok: true, updatedAt: data.updatedAt, entry });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}

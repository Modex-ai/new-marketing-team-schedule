// GET /api/schedule                         → { data }          (signed in; ?history=1 → { history } — the old sheets)
// PUT /api/schedule {data, baseUpdatedAt, changes}  (signed in) → { ok, updatedAt, entry }
//
// Env vars:
//   BLOB_READ_WRITE_TOKEN — added automatically when the Blob store is connected
//   ADMIN_PIN             — password of the built-in "owner" account
//   SESSION_SECRET        — signs login sessions
//   OWNER_NAME            — optional display name for the owner account
//   BLOB_ACCESS           — optional: 'private' (default) or 'public'
import { readJSON, writeJSON, SCHEDULE, userFromToken, bearer, parseBody, can, inScope, pushNotices } from './_lib.js';
import HISTORY from './_history.js';

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
    out.push({ ...i, type: s.type, status: 'pending', applied: !!s.applied, ref: s.ref, settled: false, decidedBy: s.decidedBy, decidedAt: s.decidedAt });
  }
  for (const i of byId.values()) if (i && i.id && okType(i.type)) { const r = { ...i, status: 'pending' }; delete r.applied; delete r.settled; delete r.decidedBy; delete r.decidedAt; out.push(r); }
  return [...out, ...hidden];
}
// Weekly schedules are reviewed day by day: each day is "approved", "review" or "rejected" (with a reason).
// The week's status follows its days: any rejected day → rejected, all seven approved → approved, otherwise in review.
// Someone without "approve" can edit a week; only the days they changed go back to review. They can never decide a day.
const DAYK = [0, 1, 2, 3, 4, 5, 6];
const DST = ['approved', 'review', 'rejected'];
const deriveWeek = (days) => { const s = DAYK.map((i) => ((days || {})[i] || {}).status || 'review'); return s.includes('rejected') ? 'rejected' : s.every((x) => x === 'approved') ? 'approved' : 'review'; };
// per-day decisions of a stored week (older weeks only have a week-level status)
function daysOf(w) {
  if (w && w.days && typeof w.days === 'object') return Object.fromEntries(DAYK.map((i) => [i, { ...(w.days[i] || { status: 'review' }) }]));
  const d = (w && w.decided) || {};
  return Object.fromEntries(DAYK.map((i) => [i, w && w.status ? { status: w.status, by: d.by, at: d.at, note: w.status === 'review' ? '' : d.note } : { status: 'review' }]));
}
function cleanDays(days) {
  const out = {};
  for (const i of DAYK) {
    const x = (days || {})[i] || {}, st = DST.includes(x.status) ? x.status : 'review';
    out[i] = { status: st, ...(x.by ? { by: String(x.by).slice(0, 80) } : {}), ...(x.at ? { at: String(x.at).slice(0, 40) } : {}), ...(x.note ? { note: String(x.note).slice(0, 500) } : {}) };
  }
  return out;
}
const dayBody = (w, k) => JSON.stringify([w.memberIds, (w.memberIds || []).map((id) => ((w.cells || {})[id] || {})[k] ?? null), (w.notes || {})[k] || null]);
function reviewWeeks(me, data, current) {
  const cur = (current && current.weeks) || {}, now = new Date().toISOString(), by = me.name;
  for (const [k, w] of Object.entries(data.weeks || {})) {
    const c = cur[k];
    if (!c && /^imported/.test(String(w.src || '')) && !w.status) continue; // schedule history from the old sheets
    if (!c) {
      w.days = Object.fromEntries(DAYK.map((i) => [i, { status: 'review', by, at: now, note: 'New week' }]));
      w.status = 'review'; w.review = { by, at: now, note: 'New week', days: DAYK }; delete w.decided; continue;
    }
    const changed = DAYK.filter((i) => dayBody(w, i) !== dayBody(c, i));
    w.decided = c.decided; w.review = c.review;
    if (!changed.length) { // nothing in the week itself changed — decisions stay exactly as stored
      if (c.days) w.days = c.days; else delete w.days;
      if (c.status) w.status = c.status; else delete w.status;
      continue;
    }
    const days = daysOf(c);
    for (const i of changed) days[i] = { status: 'review', by, at: now, note: days[i].status === 'approved' ? 'Changed after approval' : days[i].status === 'rejected' ? 'Updated after rejection' : 'Changed' };
    w.days = days; w.status = deriveWeek(days);
    w.review = { by, at: now, note: `Changed ${changed.length === 7 ? 'the whole week' : changed.length + ' day' + (changed.length > 1 ? 's' : '')}`, days: changed };
  }
}
// After the permission rules ran: keep each week's status in step with its days, keep the decision history
// server-owned, and work out who must be told about what (a decision → schedule editors, a submission → approvers).
function settleWeeks(me, data, current) {
  const cur = (current && current.weeks) || {}, now = new Date().toISOString(), notices = [], approver = can(me, 'approve');
  for (const [k, w] of Object.entries(data.weeks || {})) {
    const c = cur[k];
    if (w.days) { w.days = cleanDays(w.days); w.status = deriveWeek(w.days); }
    w.history = (c && Array.isArray(c.history) ? c.history : []).slice(-40);
    if (!c) continue;
    const a = daysOf(c), b = daysOf(w);
    const ch = DAYK.filter((i) => a[i].status !== b[i].status || (a[i].note || '') !== (b[i].note || ''));
    const stA = c.days ? deriveWeek(c.days) : c.status || 'review', stB = w.days ? w.status : w.status || 'review';
    if (approver) {
      if (!ch.length && stA === stB) continue;
      const days = ch.map((i) => ({ i, status: b[i].status, note: b[i].note || '' }));
      const fresh = w.decided && (!c.decided || w.decided.at !== c.decided.at), note = fresh ? String(w.decided.note || '').slice(0, 500) : '';
      w.decided = { by: me.name, at: now, ...(note ? { note } : {}) };
      w.history.push({ at: now, by: me.name, kind: 'decision', status: stB, days, note });
      notices.push({ kind: 'decision', to: 'schedule', week: k, status: stB, days, note });
    } else if (w.review && JSON.stringify(w.review) !== JSON.stringify(c.review)) {
      const days = (w.review.days || DAYK).map((i) => ({ i, status: 'review', note: '' }));
      w.history.push({ at: now, by: me.name, kind: 'submitted', status: stB, days, note: w.review.note || '' });
      notices.push({ kind: 'submitted', to: 'approve', week: k, status: stB, days, note: w.review.note || '' });
    }
  }
  // a new week, whoever made it, is announced to the approvers (never to the one who made it)
  for (const [k, w] of Object.entries(data.weeks || {})) if (!cur[k] && !/^imported/.test(String(w.src || ''))) {
    if (!w.review) w.review = { by: me.name, at: now, note: 'New week' };
    w.history.push({ at: now, by: me.name, kind: 'submitted', status: w.days ? deriveWeek(w.days) : w.status || 'review', days: DAYK.map((i) => ({ i, status: 'review', note: '' })), note: 'New week' });
    notices.push({ kind: 'submitted', to: 'approve', week: k, status: 'review', days: [], note: 'New week' });
  }
  return notices;
}
// Excuses, swaps, bonuses and deductions: whoever a record is about (and whoever filed it) hears every decision on it,
// with the reason; approvers hear about new records waiting for them.
const RTYPE = { swap: 'Shift swap', change: 'Shift / desk change', excuse: 'Excuse / absence', late: 'Late arrival', early: 'Early leave', dayoff: 'Day-off change', deduction: 'Deduction', bonus: 'Bonus', other: 'Record' };
const RWORD = { approved: 'approved', rejected: 'rejected', pending: 'moved back to review' };
const DN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dShort = (iso) => { const d = new Date(String(iso) + 'T00:00:00Z'); return isNaN(d) ? String(iso || '') : `${DN[d.getUTCDay()]} ${d.getUTCDate()} ${MN[d.getUTCMonth()]}`; };
function recordNotices(me, data, current) {
  const old = new Map(((current && current.requests) || []).map((r) => [r.id, r])), out = [];
  const nameOf = (id) => ((data.members || []).find((m) => m.id === id) || {}).name || id || '—';
  const what = (r) => {
    const t = RTYPE[r.type] || 'Record', money = r.type === 'deduction' || r.type === 'bonus';
    const lines = [`${t}${r.ref ? ' ' + r.ref : ''} · ${nameOf(r.member)}${r.withMember ? ' ⇄ ' + nameOf(r.withMember) : ''}`, `📅 ${dShort(r.date)}${r.withDate && r.withDate !== r.date ? ' ⇄ ' + dShort(r.withDate) : ''}`];
    if (money) lines.push(`💰 ${r.amount ? (+r.amount).toLocaleString('en-US') + ' EGP' : ''}${r.amount && r.days ? ' + ' : ''}${r.days ? r.days + ' day' + (r.days > 1 ? 's' : '') : ''}${r.reason ? ' — ' + r.reason : ''}`);
    if (r.details) lines.push(`📝 ${String(r.details).slice(0, 300)}`);
    return { t, lines, money };
  };
  const about = (r) => [r.member, r.withMember].filter(Boolean);
  for (const r of data.requests || []) {
    const o = old.get(r.id);
    if (!o && !r.createdByU) r.createdByU = me.username; // who filed it, so they hear back
    else if (o && o.createdByU) r.createdByU = o.createdByU;
    const w = what(r), users = r.createdByU ? [r.createdByU] : [];
    if (!o) {
      if (r.status === 'pending') out.push({ kind: 'record', to: 'approve', status: 'review', title: `New ${w.t.toLowerCase()} waiting for approval`, lines: w.lines, link: '#approvals', linkText: 'Review it' });
      else out.push({ kind: 'record', members: about(r), users, status: r.status, title: w.money ? `${w.t} recorded${r.status === 'approved' ? '' : ' — ' + RWORD[r.status]}` : `${w.t} ${RWORD[r.status] || r.status}`, lines: w.lines, note: r.decisionNote || '' });
      continue;
    }
    if (o.status !== r.status) out.push({ kind: 'record', members: about(r), users, status: r.status === 'pending' ? 'review' : r.status, title: `${w.t} ${RWORD[r.status] || r.status}`, lines: w.lines, note: r.decisionNote || '' });
    else if (!!o.settled !== !!r.settled && w.money) out.push({ kind: 'record', members: about(r), users, status: r.settled ? 'approved' : 'review', title: r.type === 'deduction' ? (r.settled ? 'Deduction applied to your pay' : 'Deduction marked as not applied yet') : (r.settled ? 'Bonus paid' : 'Bonus marked as not paid yet'), lines: w.lines, note: r.settleNote || '' });
    else if ((o.decisionNote || '') !== (r.decisionNote || '') && r.decisionNote) out.push({ kind: 'record', members: about(r), users, status: r.status === 'pending' ? 'review' : r.status, title: `Note on your ${w.t.toLowerCase()}`, lines: w.lines, note: r.decisionNote });
  }
  return out;
}
function enforcePerms(me, data, current) {
  if (me.owner) return '';
  // a personal account only ever saw its own row — it can add its own records, nothing else changes
  if (me.self) {
    for (const k of new Set([...Object.keys(data), ...Object.keys(current || {})])) if (k !== 'requests' && k !== 'log') keep(data, current, k);
    data.requests = mergeRecords(me, data.requests, current ? current.requests : []);
    return can(me, 'records') || can(me, 'money') ? '' : 'nothing';
  }
  let allowed = 0;
  if (can(me, 'schedule')) { allowed++; if (!can(me, 'approve')) reviewWeeks(me, data, current); }
  else {
    const inc = data.weeks || {};
    keep(data, current, 'weeks');
    if (can(me, 'approve')) { allowed++; for (const [k, w] of Object.entries(data.weeks || {})) { const x = inc[k]; if (x) for (const f of ['status', 'days', 'decided']) { if (x[f] !== undefined) w[f] = x[f]; else delete w[f]; } } }
  }
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
      // the dashboard is private: nothing is served without a valid session
      const me = await userFromToken(bearer(req)).catch(() => null);
      if (!me) return res.status(401).json({ error: 'Please sign in' });
      // a personal account gets the weeks with her own row only
      const own = (weeks) => (me.self ? Object.fromEntries(Object.entries(weeks || {}).map(([k, w]) => [k, { ...w, memberIds: (w.memberIds || []).filter((x) => x === me.member), cells: { [me.member]: (w.cells || {})[me.member] || {} }, notes: {} }])) : weeks);
      if (String((req.query && req.query.history) || new URL(req.url, 'http://x').searchParams.get('history') || '') === '1') return res.status(200).json({ history: me.self ? { ...HISTORY, weeks: own(HISTORY.weeks) } : HISTORY });
      const data = await readJSON(SCHEDULE);
      if (data && me.self) data.weeks = own(data.weeks);
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
    const notices = [...settleWeeks(me, data, current), ...recordNotices(me, data, current)];
    data.updatedAt = new Date().toISOString();
    data.updatedBy = me.name;
    // activity log — the server stamps time and author; history comes from the stored copy, not the client
    const changes = Array.isArray(body.changes)
      ? body.changes.filter((x) => typeof x === 'string' && x.trim()).slice(0, 200).map((x) => x.slice(0, 400))
      : [];
    // approvals are the owner's: a status / apply line from anyone else never reaches the log (the server kept the old value)
    if (!can(me, 'approve')) for (let k = changes.length - 1; k >= 0; k--) if (/^Records: .* — status |^Records: applied |^Records: .* marked |^Approvals: /.test(changes[k])) changes.splice(k, 1);
    const prevLog = current && Array.isArray(current.log) ? current.log : [];
    const entry = changes.length ? { at: data.updatedAt, by: { username: me.username, name: me.name }, changes } : null;
    data.log = entry ? [entry, ...prevLog].slice(0, 500) : prevLog;

    await writeJSON(SCHEDULE, data);
    if (notices.length) await pushNotices(notices, me, `https://${req.headers['x-forwarded-host'] || req.headers.host}`).catch(() => {});
    return res.status(200).json({ ok: true, updatedAt: data.updatedAt, entry });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}

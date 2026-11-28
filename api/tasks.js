// Team tasks — assigned from the dashboard, sent to the team member as an image, closed with proof and a rating.
// GET  /api/tasks                         (signed in) → { tasks, seq, updatedAt }
// POST /api/tasks { op, ... }             (signed in) → { ok, task?, tasks, updatedAt }
//   op "create"   { task }                 → new task, numbered TSK-0001, TSK-0002 …
//   op "update"   { id, patch, note }      → edit fields / move status (assigned → progress → done → approved | returned)
//   op "addProof" { id, att }              → attach a photo/video (her reply, screenshots…)
//   op "delProof" { id, j }
//   op "delete"   { id }                   → admins only
// Every change is stamped on the task's own timeline and in the dashboard's activity log.
import { readJSON, writeJSON, userFromToken, bearer, parseBody, appendLog, can, inScope, pushNotices } from './_lib.js';

const TASKS = 'marketing-ops/tasks';
const STATUS = ['assigned', 'progress', 'done', 'approved', 'returned', 'cancelled'];
const LABEL = { assigned: 'Assigned', progress: 'In progress', done: 'Done — awaiting review', approved: 'Approved', returned: 'Returned for rework', cancelled: 'Cancelled' };
const PRIORITY = ['low', 'normal', 'high', 'urgent'];
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const isTime = (s) => /^\d{2}:\d{2}$/.test(String(s || ''));
const str = (v, n) => String(v ?? '').slice(0, n);
const okUrl = (u) => /^https:\/\/[\w.-]+\.blob\.vercel-storage\.com\//.test(String(u || ''));
const cleanAtt = (a) => (a && okUrl(a.url) ? { url: a.url, name: str(a.name, 160) || 'file', kind: a.kind === 'video' ? 'video' : 'image', size: +a.size || 0, at: a.at && !isNaN(Date.parse(a.at)) ? a.at : new Date().toISOString() } : null);

function cleanFields(src, out) {
  if ('title' in src) out.title = str(src.title, 200).trim();
  if ('details' in src) out.details = str(src.details, 6000);
  if ('member' in src) out.member = str(src.member, 80);
  if ('memberName' in src) out.memberName = str(src.memberName, 120);
  if ('priority' in src) out.priority = PRIORITY.includes(src.priority) ? src.priority : 'normal';
  if ('due' in src) out.due = isDate(src.due) ? src.due : '';
  if ('dueTime' in src) out.dueTime = isTime(src.dueTime) ? src.dueTime : '';
  if ('desk' in src) out.desk = str(src.desk, 80);
  if ('files' in src) out.files = (Array.isArray(src.files) ? src.files : []).map(cleanAtt).filter(Boolean).slice(0, 30);
  if ('checklist' in src) out.checklist = (Array.isArray(src.checklist) ? src.checklist : []).slice(0, 40).map((c) => ({ t: str(c && c.t, 300), d: !!(c && c.d) })).filter((c) => c.t.trim());
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const me = await userFromToken(bearer(req));
    if (!me) return res.status(401).json({ error: 'Please sign in again' });
    if (!can(me, 'tasks') && !can(me, 'tasksManage') && !can(me, 'tasksReview')) return res.status(403).json({ error: "Your account doesn't have access to Tasks" });
    const by = { username: me.username, name: me.name };
    const doc = (await readJSON(TASKS)) || { tasks: [], seq: 0 };
    // accounts limited to some team members only see (and touch) those members' tasks
    const mine = (t) => inScope(me, t.member);
    const out = (o) => ({ ...o, tasks: (o.tasks || []).filter(mine) });
    if (req.method === 'GET') return res.status(200).json(out(doc));
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'method not allowed' }); }

    const b = parseBody(req), now = new Date().toISOString();
    // permissions: reviewing (approve / return / rating) needs "tasksReview", everything else "tasksManage"
    const review = b.op === 'update' && b.patch && (['approved', 'returned'].includes(b.patch.status) || b.patch.rating != null);
    // a team member's personal account: start / finish her own task, tick its checklist, attach proof — nothing else
    const own = me.self && can(me, 'tasks') && (b.op === 'addProof' && b.list !== 'files' || b.op === 'update' && b.patch && Object.keys(b.patch).every((k) => ['status', 'doneNote', 'doneAt', 'checklist'].includes(k)) && (!b.patch.status || ['progress', 'done'].includes(b.patch.status)));
    if (own) { const t = doc.tasks.find((x) => x.id === b.id); if (!t || t.member !== me.member) return res.status(403).json({ error: 'This task is not yours' }); }
    else {
      if (review && !can(me, 'tasksReview')) return res.status(403).json({ error: "Your account can't review or rate tasks" });
      if (!review && b.op !== 'delete' && !can(me, 'tasksManage')) return res.status(403).json({ error: "Your account can't assign or change tasks" });
    }
    const find = () => doc.tasks.find((t) => t.id === b.id && mine(t));
    const ev = (t, type, note, extra) => (t.events = [...(t.events || []), { at: now, by, type, ...(note ? { note: str(note, 1000) } : {}), ...(extra || {}) }].slice(-80));
    const who = (t) => t.memberName || t.member || 'someone';
    let log = [], task = null;
    const notes = []; // notices: the team member hears about her task, reviewers hear when it's done
    const tline = (t) => [`${t.code} · ${t.title}`, ...(t.due ? [`⏰ Due ${t.due}${t.dueTime ? ' ' + t.dueTime : ''}`] : []), ...(t.priority && t.priority !== 'normal' ? [`Priority: ${t.priority}`] : [])];

    if (b.op === 'create') {
      const f = cleanFields(b.task || {}, {});
      if (!f.title) return res.status(400).json({ error: 'Write a title for the task' });
      if (!f.member) return res.status(400).json({ error: 'Choose who the task is for' });
      if (!inScope(me, f.member)) return res.status(403).json({ error: "You can't give tasks to that team member" });
      doc.seq = (+doc.seq || 0) + 1;
      task = { id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), code: 'TSK-' + String(doc.seq).padStart(4, '0'), priority: 'normal', due: '', dueTime: '', desk: '', details: '', checklist: [], files: [], ...f, status: 'assigned', createdAt: now, createdBy: by, proof: [], rating: null, returns: 0, events: [] };
      ev(task, 'created');
      doc.tasks.unshift(task);
      notes.push({ kind: 'task', members: [task.member], status: 'review', icon: '📌', title: 'New task for you', lines: tline(task), note: task.details ? str(task.details, 400) : '', link: '#tasks', linkText: 'Open the task' });
      log.push(`Task ${task.code} assigned to ${who(task)}: “${task.title}”${task.due ? ` — due ${task.due}${task.dueTime ? ' ' + task.dueTime : ''}` : ''} (${task.priority})`);
    } else if (b.op === 'update') {
      task = find(); if (!task) return res.status(404).json({ error: 'Task not found' });
      const p = b.patch || {}, before = { ...task };
      if (p.member && !inScope(me, String(p.member))) return res.status(403).json({ error: "You can't move a task to that team member" });
      cleanFields(p, task);
      const edited = ['title', 'details', 'member', 'priority', 'due', 'dueTime', 'desk'].filter((k) => k in p && before[k] !== task[k]);
      if (edited.some((k) => ['title', 'due', 'dueTime', 'priority', 'member'].includes(k)) && !p.status) notes.push({ kind: 'task', members: [task.member], status: 'review', icon: '✏️', title: 'Your task was updated', lines: tline(task), link: '#tasks', linkText: 'Open the task' });
      if (edited.length) { ev(task, 'edited', '', { fields: edited }); log.push(`Task ${task.code}: edited ${edited.join(', ')}`); }
      if ('files' in p && JSON.stringify((before.files || []).map((x) => x.url)) !== JSON.stringify(task.files.map((x) => x.url))) { ev(task, 'files', `${task.files.length} attachment${task.files.length === 1 ? '' : 's'}`); log.push(`Task ${task.code}: attachments updated (${task.files.length})`); }
      if ('checklist' in p && JSON.stringify(before.checklist) !== JSON.stringify(task.checklist) && !edited.length) ev(task, 'checklist');
      if (p.status && p.status !== before.status) {
        if (!STATUS.includes(p.status)) return res.status(400).json({ error: 'Unknown status' });
        if (p.status === 'approved') {
          const r = Math.round(+p.rating);
          if (!(r >= 1 && r <= 5)) return res.status(400).json({ error: 'Give the task a rating (1–5 stars) to approve it' });
          task.rating = r; task.ratedAt = now; task.ratedBy = by; task.reviewNote = str(p.reviewNote ?? b.note, 1000);
          if (!task.doneAt) task.doneAt = now;
        }
        if (p.status === 'done') { task.doneAt = (p.doneAt && !isNaN(Date.parse(p.doneAt)) ? new Date(p.doneAt) : new Date()).toISOString(); task.doneNote = str(p.doneNote ?? b.note, 2000); }
        if (p.status === 'returned') { task.returns = (+task.returns || 0) + 1; task.rating = null; task.doneAt = null; task.reviewNote = str(b.note, 1000); }
        if (['assigned', 'progress'].includes(p.status) && ['approved', 'done', 'cancelled'].includes(before.status)) { task.rating = null; task.doneAt = null; } // reopened
        if (p.status === 'progress' && !task.startedAt) task.startedAt = now;
        if (p.status === 'cancelled') task.cancelledAt = now;
        task.status = p.status;
        ev(task, p.status, b.note, p.status === 'approved' ? { rating: task.rating } : p.status === 'done' ? { doneAt: task.doneAt } : undefined);
        const st = p.status;
        if (st === 'done') notes.push({ kind: 'task', to: 'tasksReview', status: 'review', title: `${who(task)} finished a task — review it`, lines: tline(task), note: task.doneNote || '', link: '#tasks', linkText: 'Review the task' });
        else if (st === 'approved') notes.push({ kind: 'task', members: [task.member], status: 'approved', title: `Task approved — ${'★'.repeat(task.rating)}${'☆'.repeat(5 - task.rating)}`, lines: tline(task), note: task.reviewNote || '', link: '#tasks', linkText: 'Open the task' });
        else if (st === 'returned') notes.push({ kind: 'task', members: [task.member], status: 'rejected', title: 'Task returned for rework', lines: tline(task), note: task.reviewNote || '', link: '#tasks', linkText: 'Open the task' });
        else if (st === 'cancelled') notes.push({ kind: 'task', members: [task.member], status: 'rejected', title: 'Task cancelled', lines: tline(task), note: str(b.note, 400), link: '#tasks' });
        else if (st === 'progress' && before.status !== 'assigned') notes.push({ kind: 'task', members: [task.member], status: 'review', title: 'Task reopened', lines: tline(task), note: str(b.note, 400), link: '#tasks', linkText: 'Open the task' });
        log.push(`Task ${task.code} (${who(task)}): ${LABEL[p.status]}${p.status === 'approved' ? ` — rated ${task.rating}/5` : ''}${b.note ? ` — ${str(b.note, 160)}` : ''}`);
      } else if (p.status === 'approved' && p.rating != null) { // re-rate
        const r = Math.round(+p.rating);
        if (r >= 1 && r <= 5 && r !== task.rating) { task.rating = r; task.ratedAt = now; task.ratedBy = by; ev(task, 'rated', b.note, { rating: r }); log.push(`Task ${task.code} (${who(task)}): rating changed to ${r}/5`); }
      }
      task.updatedAt = now;
    } else if (b.op === 'addProof') {
      task = find(); if (!task) return res.status(404).json({ error: 'Task not found' });
      const a = cleanAtt(b.att); if (!a) return res.status(400).json({ error: 'Invalid attachment' });
      const L = b.list === 'files' ? 'files' : 'proof';
      task[L] = [...(task[L] || []), a].slice(0, 40); ev(task, L === 'files' ? 'fileAdded' : 'proof', a.name);
      log.push(`Task ${task.code} (${who(task)}): ${L === 'files' ? 'brief attachment' : 'proof'} added — ${a.name}`);
    } else if (b.op === 'delProof') {
      task = find(); if (!task) return res.status(404).json({ error: 'Task not found' });
      const L = b.list === 'files' ? 'files' : 'proof';
      const [x] = (task[L] || []).splice(+b.j, 1);
      if (x) { ev(task, L === 'files' ? 'fileRemoved' : 'proofRemoved', x.name); log.push(`Task ${task.code}: removed attachment ${x.name}`); }
    } else if (b.op === 'delete') {
      if (!me.owner && !can(me, 'users')) return res.status(403).json({ error: 'Only the owner or a user manager can delete tasks — cancel it instead' });
      const k = doc.tasks.findIndex((t) => t.id === b.id && mine(t)); if (k < 0) return res.status(404).json({ error: 'Task not found' });
      const [t] = doc.tasks.splice(k, 1);
      log.push(`Task ${t.code} deleted (“${t.title}”, ${who(t)})`);
    } else return res.status(400).json({ error: 'Unknown operation' });

    doc.updatedAt = now;
    if (JSON.stringify(doc).length > 4_000_000) return res.status(400).json({ error: 'Task list too large' });
    await writeJSON(TASKS, doc);
    if (log.length) { try { await appendLog(log, by); } catch {} }
    if (notes.length) await pushNotices(notes, me, `https://${req.headers['x-forwarded-host'] || req.headers.host}`).catch(() => {});
    return res.status(200).json({ ok: true, task, tasks: doc.tasks.filter(mine), seq: doc.seq, updatedAt: doc.updatedAt });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}

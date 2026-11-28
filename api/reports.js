// GET /api/reports[?force=1]   (signed in) → team report sheets as JSON
//
// The sheets stay private in Google Drive. An Apps Script web app (apps-script/Code.gs), running as
// the sheets' owner, reads each sheet's "Daily Log" tab. This function calls it with a secret key the
// browser never sees, and keeps the last snapshot in Blob so the page loads fast and still shows data
// if Google is slow.
//
// Env vars:  REPORTS_URL — the Apps Script web app URL     REPORTS_KEY — must match KEY in Code.gs
import { readJSON, writeJSON, SCHEDULE, userFromToken, bearer, can, inScope } from './_lib.js';

const CACHE = 'marketing-ops/reports-cache';
const MAX_AGE_MS = 10 * 60 * 1000;

// Used until report sources are saved from the dashboard (Manage → Reports).
export const DEFAULT_SOURCES = [
  { id: 'src-heba', sheetId: '1dcGo7iY0jCJ6bzJF9CHXMcmgcCrEgdwMp3hueYNJxZE', memberId: 'heba' },
  { id: 'src-mai', sheetId: '1JzFWJe6rO-nsPGArSe22bgmCJTfyS64hLDIGhdJVa2c', memberId: 'mai' },
  { id: 'src-roaa', sheetId: '1x2YBcCXVPrdwglstbJEoecH0FyKXuH9PydRR8mqm9YI', memberId: 'roaa' },
  { id: 'src-basant', sheetId: '1pz6qqCg6LNWu-Q6WvnAhuT39VYOGvrFlV_kz1u90lJw', memberId: 'basant' },
  { id: 'src-suhaila', sheetId: '1l-cQr2Hp-rdk5jJr23p1ZctTca4epiwk8apIssEZCcw', memberId: 'suhaila' },
  { id: 'src-snapel', sheetId: '1fMFZ6e2VznvImyYaD63emUtplY39BGhx4gCSfZTfO0Y', memberId: 'snapel' },
  { id: 'src-shams', sheetId: '18zI8u9XpnZUOhOQkP3o8DMjoegMDDX1a3hU7Cc6D84w', memberId: '', name: 'Shams' },
];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  const url = process.env.REPORTS_URL, key = process.env.REPORTS_KEY;
  const q0 = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  // ?check=1&k=<REPORTS_KEY> → connection health only (titles, row counts, dates, errors — no sales or feedback)
  const check = q0.check === '1' && key && q0.k === key;
  let me = null;
  if (!check) {
    me = await userFromToken(bearer(req));
    if (!me) return res.status(401).json({ error: 'Please sign in again' });
    if (!can(me, 'reports')) return res.status(403).json({ error: "Your account doesn't have access to Team Reports" });
  }

  if (!url || !key) return res.status(200).json({ configured: false });

  const sched = await readJSON(SCHEDULE, { ttl: 30000 }).catch(() => null);
  const sources = Array.isArray(sched?.reportSources) ? sched.reportSources : DEFAULT_SOURCES;
  const ids = [...new Set(sources.map((s) => s.sheetId).filter((x) => /^[\w-]{20,}$/.test(String(x || ''))))].sort();
  if (!ids.length) return res.status(200).json({ configured: true, sheets: [], fetchedAt: null });

  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  // an account limited to some team members only receives their sheets
  const allowed = new Set(sources.filter((s) => inScope(me, s.memberId) && (!(me && (me.scope || []).length) || s.memberId)).map((s) => s.sheetId));
  const only = (o) => (o && Array.isArray(o.sheets) && me && !me.owner && (me.scope || []).length ? { ...o, sheets: o.sheets.filter((x) => allowed.has(x.id)) } : o);
  const cached = await readJSON(CACHE).catch(() => null);
  const sameIds = cached && Array.isArray(cached.ids) && cached.ids.join() === ids.join();
  if (q.force !== '1' && !check && sameIds && Date.now() - new Date(cached.fetchedAt).getTime() < MAX_AGE_MS) {
    return res.status(200).json({ configured: true, cached: true, ...only(cached) });
  }

  try {
    const sep = url.includes('?') ? '&' : '?';
    const r = await fetch(`${url}${sep}key=${encodeURIComponent(key)}&ids=${encodeURIComponent(ids.join(','))}`, { redirect: 'follow' });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch {
      throw new Error('The Apps Script did not answer with data. Check it is deployed as a Web app with access "Anyone".');
    }
    if (!j.ok) throw new Error(j.error === 'unauthorized' ? 'The Apps Script key does not match REPORTS_KEY.' : j.error || 'Apps Script error');
    const snap = { ids, fetchedAt: new Date().toISOString(), generatedAt: j.generatedAt, sheets: j.sheets || [] };
    await writeJSON(CACHE, snap, 2);
    if (check) return res.status(200).json({ ok: true, fetchedAt: snap.fetchedAt, stamping: j.stamping || null, sheets: snap.sheets.map((x) => ({ title: x.title, tab: x.tab, error: x.error, rows: (x.rows || []).length, header: x.header, firstDate: x.rows && x.rows[0] && x.rows[0][0], lastDate: x.rows && x.rows.length ? x.rows[x.rows.length - 1][0] : null, updated: x.updated, stampSince: x.stampSince || null, stampedDays: Object.keys(x.stamps || {}).length })) });
    return res.status(200).json({ configured: true, ...only(snap) });
  } catch (e) {
    const error = String((e && e.message) || e);
    if (cached && cached.sheets) return res.status(200).json({ configured: true, stale: true, error, ...only(cached) });
    return res.status(502).json({ configured: true, error });
  }
}

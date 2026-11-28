// Attendance — check in / check out against the schedule.
// GET  /api/attendance?from=YYYY-MM-DD&to=YYYY-MM-DD → { days, startedAt, grace, me }
//      managers (approve / records / reports) see everyone in their scope; everyone else only their own days
// POST /api/attendance { action: "in" | "out" }                         → { ok, msg, rec }   (the account's own team member)
// POST /api/attendance { action: "fix", member, date, in, out, note }   → approvers correct or clear a day (times "HH:MM", Cairo)
import { readJSON, writeJSON, SCHEDULE, userFromToken, bearer, parseBody, can, inScope, appendLog } from './_lib.js';
import { ATTEND, attend, shiftOf, grade, graceOf, dIdx, iDate, cairoAbs, clock } from './_attendance.js';

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const hm = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? +m[1] * 60 + +m[2] : null; };
const manager = (me) => can(me, 'approve') || can(me, 'records') || can(me, 'reports');

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const me = await userFromToken(bearer(req));
    if (!me) return res.status(401).json({ error: 'Please sign in again' });
    const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
    if (req.method === 'GET') {
      const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
      const today = Math.floor(cairoAbs(Date.now()) / 1440);
      const from = isDate(q.from) ? q.from : iDate(today - 45), to = isDate(q.to) ? q.to : iDate(today + 1);
      const doc = (await readJSON(ATTEND)) || { days: {} }, D = (await readJSON(SCHEDULE)) || {};
      const see = (mid) => (manager(me) ? inScope(me, mid) : mid === me.member);
      const days = {};
      for (const [k, v] of Object.entries(doc.days || {})) if (k >= from && k <= to) { const x = Object.fromEntries(Object.entries(v).filter(([mid]) => see(mid))); if (Object.keys(x).length) days[k] = x; }
      const mine = me.member ? await attend(me, 'status', 'dashboard') : null;
      return res.status(200).json({ days, from, to, startedAt: doc.startedAt || null, grace: graceOf(D), now: cairoAbs(Date.now()), all: manager(me), me: mine ? { member: me.member, msg: mine.msg, shift: mine.shift, rec: mine.rec } : null });
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'method not allowed' }); }
    const b = parseBody(req);
    if (b.action === 'in' || b.action === 'out') {
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim().slice(0, 60), ua = String(req.headers['user-agent'] || '').slice(0, 160);
      const g = b.geo && typeof b.geo === 'object' ? { lat: b.geo.lat, lng: b.geo.lng, acc: b.geo.acc, error: b.geo.error } : null;
      const r = await attend(me, b.action, 'dashboard', { ip, ua }, origin, g);
      return res.status(r.ok ? 200 : 400).json(r.ok ? r : { error: r.msg });
    }
    // Settings → Office location: turn a Google Maps link (short links too) into coordinates
    if (b.action === 'resolveMap') {
      if (!can(me, 'settings') && !can(me, 'approve')) return res.status(403).json({ error: "Your account can't change the office location" });
      let url = String(b.url || '').trim(), seen = [];
      if (!/^https:\/\/([\w-]+\.)*(google\.[a-z.]+|goo\.gl|maps\.app\.goo\.gl)\//i.test(url)) return res.status(400).json({ error: 'Paste a Google Maps link' });
      const pick = (t) => { t = decodeURIComponent(String(t || '')); let m = /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/.exec(t) || /[?&](?:q|query|ll|destination|center)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/.exec(t) || /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(t) || /\/search\/(-?\d+\.\d+),\+?(-?\d+\.\d+)/.exec(t); return m ? { lat: +m[1], lng: +m[2] } : null; };
      let at = pick(url), body = '';
      for (let k = 0; k < 6 && !at; k++) {
        const r = await fetch(url, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36', 'accept-language': 'en' } });
        const loc = r.headers.get('location'); seen.push(url);
        if (loc) { url = new URL(loc, url).href; at = pick(url); continue; }
        body = await r.text(); at = pick(body); break;
      }
      if (!at) return res.status(400).json({ error: "Couldn't read the location from that link — open it in Google Maps, long-press the pin and paste the coordinates instead" });
      const name = (/\/place\/([^/@]+)/.exec(decodeURIComponent(url)) || [])[1];
      return res.status(200).json({ ok: true, lat: +at.lat.toFixed(6), lng: +at.lng.toFixed(6), name: name ? name.replace(/\+/g, ' ').slice(0, 120) : '', url });
    }
    if (b.action === 'fix') {
      if (!can(me, 'approve')) return res.status(403).json({ error: 'Only approvers can correct attendance' });
      const mid = String(b.member || ''), date = String(b.date || '');
      if (!mid || !isDate(date) || !inScope(me, mid)) return res.status(400).json({ error: 'Choose a team member and a date' });
      const D = (await readJSON(SCHEDULE)) || {}, doc = (await readJSON(ATTEND)) || { days: {} };
      doc.days = doc.days || {};
      const i = dIdx(date), tin = hm(b.in), tout = hm(b.out), name = ((D.members || []).find((m) => m.id === mid) || {}).name || mid;
      const day = (doc.days[date] = doc.days[date] || {});
      if (tin == null && tout == null) { delete day[mid]; if (!Object.keys(day).length) delete doc.days[date]; await writeJSON(ATTEND, doc, 10); await appendLog([`Attendance: ${name} — ${date} cleared`], { username: me.username, name: me.name }).catch(() => {}); return res.status(200).json({ ok: true }); }
      if (tin == null) return res.status(400).json({ error: 'Enter the check-in time' });
      const sh = shiftOf(D, mid, i) || { i, none: true };
      let ain = i * 1440 + tin; if (sh.s != null && ain < sh.s - 720) ain += 1440; // after midnight on a night shift
      const r = { in: { at: '', abs: ain, via: 'manual' }, shift: sh.none ? '' : sh.off ? 'off' : sh.name, t: sh.t || '', desk: sh.desk || '', s: sh.s ?? null, e: sh.e ?? null, edited: { by: me.name, at: new Date().toISOString(), note: String(b.note || '').slice(0, 300) } };
      if (tout != null) { let aout = i * 1440 + tout; while (aout <= ain) aout += 1440; r.out = { at: '', abs: aout, via: 'manual' }; }
      Object.assign(r, grade(r, graceOf(D)));
      day[mid] = r;
      if (!doc.startedAt || doc.startedAt > date) doc.startedAt = date;
      await writeJSON(ATTEND, doc, 10);
      await appendLog([`Attendance: ${name} — ${date} set to ${clock(ain)}${r.out ? ' – ' + clock(r.out.abs) : ''}${r.edited.note ? ` (“${r.edited.note}”)` : ''}`], { username: me.username, name: me.name }).catch(() => {});
      return res.status(200).json({ ok: true, rec: r });
    }
    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}

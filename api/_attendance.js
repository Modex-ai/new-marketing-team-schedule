// Check in / check out, measured against the person's own shift in the weekly schedule (Cairo time).
// Used by /api/attendance (the dashboard) and /api/telegram (the ✅ Check in / 🏁 Check out buttons).
// Times are "Cairo wall-clock minutes since 1970-01-01" (day index × 1440 + minutes), the same scale the dashboard uses,
// so a night shift 19:00–03:00 simply ends at 1620 minutes of its day.
import { readJSON, writeJSON, SCHEDULE, pushNotices } from './_lib.js';

export const ATTEND = 'marketing-ops/attendance';
const cairo = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export const dIdx = (s) => { const [y, m, d] = String(s).split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 864e5); };
export const iDate = (i) => new Date(i * 864e5).toISOString().slice(0, 10);
const wdOf = (i) => new Date(i * 864e5).getUTCDay();
export function cairoAbs(ms) {
  const p = Object.fromEntries(cairo.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return dIdx(`${p.year}-${p.month}-${p.day}`) * 1440 + (+p.hour % 24) * 60 + +p.minute + +p.second / 60;
}
const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
function tRange(t) {
  const parts = String(t || '').split(',').map((x) => /^\s*(\d{1,2}:\d{2})-(\d{1,2}:\d{2})\s*$/.exec(x));
  if (!parts.length || parts.some((m) => !m)) return null;
  let base = null, end = 0;
  const ps = parts.map((m) => { let s = hm(m[1]); if (base != null && s < base) s += 1440; let e = hm(m[2]); while (e <= s) e += 1440; if (base == null) base = s; end = Math.max(end, e); return { s, e }; });
  return { s: ps[0].s, e: end };
}
// the member's planned shift on day i, or null when the schedule has nothing for that day
export function shiftOf(D, mid, i) {
  const ws = i - ((wdOf(i) - (+((D.settings || {}).weekStart) || 0) + 7) % 7), w = (D.weeks || {})[iDate(ws)];
  const c = w && ((w.cells || {})[mid] || {})[i - ws];
  if (!c || !c.s) return null;
  const ty = (D.shiftTypes || []).find((x) => x.id === c.s); if (!ty) return null;
  if (ty.kind === 'off') return { i, off: true, name: ty.name, type: ty.id };
  const t = c.t || ty.time || '', r = tRange(t), desk = ((D.responsibilities || []).find((x) => x.id === c.r) || {}).name || '';
  return { i, name: ty.name, type: ty.id, t, desk, s: r ? i * 1440 + r.s : null, e: r ? i * 1440 + r.e : null };
}
/* ---- where people work from: the office (checked by location) or remotely ---- */
// settings.office = { lat, lng, radius }  · settings.remoteShifts = shift type ids (default: night)
// settings.remoteDays = weekdays 0–6 (default: Friday) · member.remote = always remote
export const officeOf = (D) => { const o = (D.settings || {}).office || {}; return Number.isFinite(+o.lat) && Number.isFinite(+o.lng) && (o.lat !== '' && o.lng !== '') && (+o.lat || +o.lng) ? { lat: +o.lat, lng: +o.lng, radius: Math.max(20, +o.radius || 150) } : null; };
const remoteShifts = (D) => (Array.isArray((D.settings || {}).remoteShifts) ? D.settings.remoteShifts : ['night']);
const remoteDays = (D) => (Array.isArray((D.settings || {}).remoteDays) ? D.settings.remoteDays.map(Number) : [5]);
export function remoteWhy(D, mid, sh) {
  const m = (D.members || []).find((x) => x.id === mid) || {};
  if (m.remote) return 'Works remotely';
  if (sh && sh.type && remoteShifts(D).includes(sh.type)) return `${sh.name} shifts are remote`;
  if (sh && sh.i != null && remoteDays(D).includes(wdOf(sh.i))) return `${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][wdOf(sh.i)]} is remote`;
  return '';
}
export function distM(a, b) { const R = 6371000, r = (x) => (x * Math.PI) / 180, dLa = r(b.lat - a.lat), dLo = r(b.lng - a.lng); const h = Math.sin(dLa / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLo / 2) ** 2; return Math.round(2 * R * Math.asin(Math.sqrt(h))); }
export const distTxt = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`);
// does this check-in / check-out need the person's location?
export async function needsGeo(me, action) {
  if (!me.member) return false;
  const D = (await readJSON(SCHEDULE)) || {}; if (!officeOf(D)) return false;
  const doc = (await readJSON(ATTEND)) || { days: {} }, now = cairoAbs(Date.now()), today = Math.floor(now / 1440);
  if (action === 'out') { const open = [today, today - 1].map((i) => (((doc.days || {})[iDate(i)] || {})[me.member])).find((r) => r && r.in && !r.out); return !!open && !open.remote; }
  return !remoteWhy(D, me.member, pickShift(D, doc, me.member, now));
}
// grade the location of one check-in / out: { remote } | { dist, away, acc } | { none: true }
function placeOf(D, rec, geo) {
  const off = officeOf(D);
  if (!off) return null;
  if (rec.remote) return { remote: rec.remote };
  if (!geo || !Number.isFinite(+geo.lat) || !Number.isFinite(+geo.lng)) return { none: true, why: geo && geo.error ? String(geo.error).slice(0, 80) : 'Location not shared' };
  const d = distM(off, { lat: +geo.lat, lng: +geo.lng }), acc = Math.round(+geo.acc || 0);
  return { lat: +(+geo.lat).toFixed(6), lng: +(+geo.lng).toFixed(6), acc, dist: d, away: d - Math.min(acc, 150) > off.radius };
}

export const clock = (abs) => { const m = Math.round(((abs % 1440) + 1440) % 1440), h = Math.floor(m / 60), mm = m % 60; return `${h % 12 || 12}:${String(mm).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
export const dur = (min) => { min = Math.round(min); const h = Math.floor(min / 60), m = min % 60; return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`; };
export const graceOf = (D) => Math.max(0, +(((D.settings || {}).lateGrace) ?? 10) || 0);
const dayTxt = (i) => { const d = new Date(i * 864e5); return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}`; };
const shiftTxt = (r) => (r.shift && r.shift !== 'off' ? `${r.shift}${r.s != null ? ` ${clock(r.s)} – ${clock(r.e)}` : ''}${r.desk ? ' · ' + r.desk : ''}` : r.shift === 'off' ? 'Day off' : 'No shift in the schedule');

// status of one record: ontime / late / unscheduled, plus early leave and overtime once checked out
export function grade(r, grace) {
  const g = {};
  if (r.s == null) g.status = 'unscheduled';
  else { g.late = Math.max(0, Math.round(r.in.abs - r.s)); g.status = g.late > grace ? 'late' : 'ontime'; }
  if (r.out) { g.worked = Math.max(0, Math.round(r.out.abs - r.in.abs)); if (r.e != null) { g.early = Math.max(0, Math.round(r.e - r.out.abs)); g.over = Math.max(0, Math.round(r.out.abs - r.e)); } }
  return g;
}
// which shift a check-in belongs to: a night shift that is still running counts for its own (previous) day
function pickShift(D, doc, mid, now) {
  const today = Math.floor(now / 1440), has = (i) => !!(((doc.days || {})[iDate(i)] || {})[mid] || {}).in;
  const y = shiftOf(D, mid, today - 1);
  if (y && !y.off && y.e != null && now <= y.e && !has(today - 1)) return y;
  return shiftOf(D, mid, today) || { i: today, none: true };
}

// action: "in" | "out" | "status". Returns { ok, msg, rec?, shift? }  (msg is plain text with emoji, for Telegram and toasts)
export async function attend(me, action, via, meta = {}, origin = '', geo = null) {
  if (!me.member) return { ok: false, msg: "This account isn't linked to a team member yet. Ask the admin to link it (Manage → Users → Team member)." };
  const D = (await readJSON(SCHEDULE)) || {}, doc = (await readJSON(ATTEND)) || { days: {} };
  doc.days = doc.days || {};
  const mid = me.member, nowMs = Date.now(), now = cairoAbs(nowMs), today = Math.floor(now / 1440), grace = graceOf(D);
  const name = ((D.members || []).find((m) => m.id === mid) || {}).name || me.name;
  const recOf = (i) => (doc.days[iDate(i)] || {})[mid];
  if (action === 'status') {
    const open = [today, today - 1].map((i) => [i, recOf(i)]).find(([, r]) => r && r.in && !r.out);
    const sh = pickShift(D, doc, mid, now), r = recOf(sh.i);
    let msg = `📅 ${dayTxt(sh.i)}: ${sh.none ? 'No shift in the schedule' : sh.off ? 'Day off' : `${sh.name}${sh.s != null ? ` ${clock(sh.s)} – ${clock(sh.e)}` : ''}${sh.desk ? ' · ' + sh.desk : ''}`}`;
    if (open) msg += `\n✅ Checked in at ${clock(open[1].in.abs)} — ${dur(now - open[1].in.abs)} so far`;
    else if (r && r.out) msg += `\n🏁 Done: ${clock(r.in.abs)} – ${clock(r.out.abs)}`;
    else if (sh.s != null && now > sh.s + grace) msg += `\n⚠️ Not checked in yet — the shift started ${dur(now - sh.s)} ago`;
    const next = shiftOf(D, mid, today + 1);
    if (next) msg += `\n➡️ Tomorrow: ${next.off ? 'Day off' : `${next.name}${next.s != null ? ` ${clock(next.s)} – ${clock(next.e)}` : ''}`}`;
    return { ok: true, msg, shift: sh, rec: open ? open[1] : r || null };
  }
  const notes = [];
  if (action === 'in') {
    const sh = pickShift(D, doc, mid, now), key = iDate(sh.i), prev = recOf(sh.i);
    if (prev && prev.in) return { ok: false, msg: `You already checked in at ${clock(prev.in.abs)}${prev.out ? ` and out at ${clock(prev.out.abs)}` : ''}.`, rec: prev };
    const r = { in: { at: new Date(nowMs).toISOString(), abs: now, via, ...meta }, shift: sh.none ? '' : sh.off ? 'off' : sh.name, t: sh.t || '', desk: sh.desk || '', s: sh.s ?? null, e: sh.e ?? null };
    const why = officeOf(D) ? remoteWhy(D, mid, sh) : ''; if (why) r.remote = why;
    const pl = placeOf(D, r, geo); if (pl) r.in.place = pl;
    Object.assign(r, grade(r, grace));
    (doc.days[key] = doc.days[key] || {})[mid] = r;
    if (!doc.startedAt) doc.startedAt = key;
    await writeJSON(ATTEND, doc, 10);
    let msg = `✅ Checked in at ${clock(now)} — ${shiftTxt(r)}`;
    const placeNote = (p, verb) => { if (!p || p.remote) return; if (p.none) { msg += `\n📍 No location — your manager is notified`; notes.push({ kind: 'attendance', to: 'approve', status: 'rejected', icon: '📍', title: `${name} ${verb} without sharing the location`, lines: [`${dayTxt(sh.i)} · ${clock(now)}`, p.why], link: '#attendance', linkText: 'Open attendance' }); } else if (p.away) { msg += `\n📍 ${distTxt(p.dist)} from the office — your manager is notified`; notes.push({ kind: 'attendance', to: 'approve', status: 'rejected', icon: '📍', title: `${name} ${verb} ${distTxt(p.dist)} away from the office`, lines: [`${dayTxt(sh.i)} · ${clock(now)} · ${shiftTxt(r)}`, `Accuracy ±${distTxt(p.acc || 0)}`], link: '#attendance', linkText: 'Open attendance' }); } else msg += `\n📍 At the office (${distTxt(p.dist)})`; };
    placeNote(r.in.place, 'checked in');
    if (r.remote) msg += `\n🏠 Remote — ${r.remote}`;
    if (r.status === 'late') { msg += `\n⏱ ${dur(r.late)} late`; notes.push({ kind: 'attendance', to: 'approve', status: 'rejected', icon: '⏱', title: `${name} checked in ${dur(r.late)} late`, lines: [`${dayTxt(sh.i)} · ${shiftTxt(r)}`, `Checked in ${clock(now)}`], link: '#attendance', linkText: 'Open attendance' }); }
    else if (r.status === 'ontime') msg += r.late ? `\n🟢 On time (${r.late} min after the start, within the ${grace}-min grace)` : `\n🟢 On time`;
    else notes.push({ kind: 'attendance', to: 'approve', status: 'review', icon: '📍', title: `${name} checked in on a ${r.shift === 'off' ? 'day off' : 'day with no shift'}`, lines: [`${dayTxt(sh.i)} · ${clock(now)}`], link: '#attendance', linkText: 'Open attendance' });
    if (notes.length) await pushNotices(notes, me, origin).catch(() => {});
    return { ok: true, msg, rec: r };
  }
  if (action === 'out') {
    const open = [today, today - 1].map((i) => [i, recOf(i)]).find(([, r]) => r && r.in && !r.out);
    if (!open) return { ok: false, msg: "You haven't checked in — check in first." };
    const [i, r] = open;
    r.out = { at: new Date(nowMs).toISOString(), abs: now, via, ...meta };
    const pl = placeOf(D, r, geo); if (pl) r.out.place = pl;
    Object.assign(r, grade(r, grace));
    await writeJSON(ATTEND, doc, 10);
    let msg = `🏁 Checked out at ${clock(now)} — worked ${dur(r.worked)}`;
    const p = r.out.place;
    if (p && !p.remote) {
      if (p.none) { msg += `\n📍 No location — your manager is notified`; notes.push({ kind: 'attendance', to: 'approve', status: 'rejected', icon: '📍', title: `${name} checked out without sharing the location`, lines: [`${dayTxt(i)} · ${clock(now)}`, p.why], link: '#attendance', linkText: 'Open attendance' }); }
      else if (p.away) { msg += `\n📍 ${distTxt(p.dist)} from the office — your manager is notified`; notes.push({ kind: 'attendance', to: 'approve', status: 'rejected', icon: '📍', title: `${name} checked out ${distTxt(p.dist)} away from the office`, lines: [`${dayTxt(i)} · ${clock(now)} · ${shiftTxt(r)}`, `Accuracy ±${distTxt(p.acc || 0)}`], link: '#attendance', linkText: 'Open attendance' }); }
    }
    if (r.early > grace) { msg += `\n⚠️ ${dur(r.early)} before the shift ends`; notes.push({ kind: 'attendance', to: 'approve', status: 'rejected', icon: '⏱', title: `${name} left ${dur(r.early)} early`, lines: [`${dayTxt(i)} · ${shiftTxt(r)}`, `${clock(r.in.abs)} – ${clock(now)}`], link: '#attendance', linkText: 'Open attendance' }); }
    else if (r.over > 15) msg += `\n➕ ${dur(r.over)} after the shift`;
    if (notes.length) await pushNotices(notes, me, origin).catch(() => {});
    return { ok: true, msg, rec: r };
  }
  return { ok: false, msg: 'Unknown action' };
}

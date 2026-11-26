/**
 * Team Reports connector — shared by the Fémini and Vendoor dashboards
 *
 * 1) Reads the "Daily Log" tab of each team member's report sheet and returns it as JSON.
 *    Runs as you, so it can open your sheets while they stay private.
 * 2) NEW — submission times: an automatic "on edit" trigger on each report sheet records the
 *    exact time each day's report was first written (and later edits). The times are kept in
 *    this script's storage, not in the sheet, so nobody can change them.
 *
 * Update from the previous version (keeps the same Web app URL):
 *   1. Replace all the code with this file → Save.
 *   2. Choose the function "setup" in the toolbar → Run → allow the new permission
 *      (it lets the script add its own triggers).
 *   3. Deploy → Manage deployments → ✎ Edit → Version: "New version" → Deploy.
 *
 * The KEY below must match REPORTS_KEY on Vercel. Without it the script returns nothing.
 * New sheets added from a dashboard (Manage → Reports) get their trigger automatically.
 */
const KEY = 'PASTE_THE_KEY_HERE'; // must match REPORTS_KEY on Vercel
const TZ = 'Africa/Cairo';
const MAX_SHEETS = 40;
const MAX_TRIGGERS = 19; // Google allows 20 triggers per script

function doGet(e) {
  return handle_((e && e.parameter) || {});
}

function doPost(e) {
  let p = {};
  try { p = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) {}
  return handle_(p);
}

// Run once from the editor after updating, to grant the trigger permission.
function setup() {
  const n = ScriptApp.getProjectTriggers().length;
  Logger.log('Ready. Triggers installed so far: ' + n + '. They are added automatically for every report sheet.');
}

function handle_(p) {
  if (!p.key || p.key !== KEY) return out_({ ok: false, error: 'unauthorized' });
  const ids = String(p.ids || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, MAX_SHEETS);
  let trig = null;
  try { trig = ensureTriggers_(ids); } catch (err) { trig = { error: String((err && err.message) || err) }; }
  const props = PropertiesService.getScriptProperties().getProperties();
  const sheets = ids.map((id) => {
    try { return readSheet_(id, props); } catch (err) { return { id: id, error: String((err && err.message) || err) }; }
  });
  return out_({ ok: true, generatedAt: new Date().toISOString(), stamping: trig, sheets: sheets });
}

// Columns someone types into each day (calculated columns like AOV are ignored when deciding if a row was filled).
const INPUT_COLS = /^(shift|total sales|sales|orders|items|total items|quantity|out of stock|refund|exchang|feedback|notes?)/i;
const NAME_COLS = /^(moderator|t\.?l|name)$/i;
// A day counts as "reported" once one of these has a value (the Shift column alone isn't a report).
const REPORT_COLS = /^(total sales|sales|total orders|orders|items|total items|quantity|feedback|notes?)$/i;

function readSheet_(id, props) {
  const ss = SpreadsheetApp.openById(id);
  const sh = ss.getSheetByName('Daily Log') || ss.getSheets()[0];
  const vals = sh.getDataRange().getValues();
  const h = vals.findIndex((r) => String(r[0]).trim().toLowerCase() === 'date');
  if (h < 0) throw new Error('No "Date" header found in the "' + sh.getName() + '" tab');

  const header = vals[h].map((v) => String(v).trim());
  let width = header.length;
  while (width > 1 && !header[width - 1]) width--;
  const check = [];
  for (let c = 1; c < width; c++) if (INPUT_COLS.test(header[c]) && !/\/|vs/i.test(header[c])) check.push(c);
  if (!check.length) for (let c = 1; c < width; c++) if (!NAME_COLS.test(header[c])) check.push(c);

  const rows = [];
  for (let i = h + 1; i < vals.length; i++) {
    const r = vals[i];
    if (r[0] === '' || r[0] === null) continue;
    if (!check.some((c) => r[c] !== '' && r[c] !== null)) continue;
    rows.push(r.slice(0, width).map((v) => (v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : v)));
  }

  // submission times recorded by the edit trigger: { 'yyyy-MM-dd': { f: first written, l: last edit, n: later edits, x: cleared } }
  const stamps = {};
  const pre = 'st:' + id + ':';
  Object.keys(props || {}).forEach((k) => {
    if (k.indexOf(pre) !== 0) return;
    try { const m = JSON.parse(props[k]); Object.keys(m).forEach((d) => (stamps[d] = m[d])); } catch (err) {}
  });

  let updated = null;
  try { updated = DriveApp.getFileById(id).getLastUpdated().toISOString(); } catch (err) {}
  return { id: id, title: ss.getName(), tab: sh.getName(), url: ss.getUrl(), header: header.slice(0, width), rows: rows, updated: updated,
    stamps: stamps, stampSince: (props && props['since:' + id]) || null };
}

/* ---------------- submission-time tracking ---------------- */

function ensureTriggers_(ids) {
  const have = {};
  ScriptApp.getProjectTriggers().forEach((t) => { if (t.getHandlerFunction() === 'onReportEdit') have[t.getTriggerSourceId()] = true; });
  const P = PropertiesService.getScriptProperties();
  let count = Object.keys(have).length, added = 0, skipped = [];
  ids.forEach((id) => {
    if (have[id]) return;
    if (count >= MAX_TRIGGERS) { skipped.push(id); return; }
    ScriptApp.newTrigger('onReportEdit').forSpreadsheet(id).onEdit().create();
    if (!P.getProperty('since:' + id)) P.setProperty('since:' + id, new Date().toISOString());
    have[id] = true; count++; added++;
  });
  return { active: count, added: added, skipped: skipped };
}

// Installable trigger handler — runs on every edit in a report sheet (by anyone), as the script owner.
function onReportEdit(e) {
  if (!e || !e.range) return;
  const sh = e.range.getSheet();
  const ss = sh.getParent();
  const tab = ss.getSheetByName('Daily Log') || ss.getSheets()[0];
  if (sh.getSheetId() !== tab.getSheetId()) return;

  const lastCol = sh.getLastColumn();
  const top = sh.getRange(1, 1, Math.min(12, sh.getLastRow()), lastCol).getValues();
  const h = top.findIndex((r) => String(r[0]).trim().toLowerCase() === 'date');
  if (h < 0) return;
  const header = top[h].map((v) => String(v).trim());
  const rc = [];
  header.forEach((x, c) => { if (c > 0 && REPORT_COLS.test(x)) rc.push(c); });
  if (!rc.length) return;

  const r0 = Math.max(e.range.getRow(), h + 2), r1 = e.range.getLastRow();
  if (r1 < r0) return;
  const vals = sh.getRange(r0, 1, r1 - r0 + 1, lastCol).getValues();
  const now = new Date().toISOString();
  const id = ss.getId();

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return;
  try {
    const P = PropertiesService.getScriptProperties();
    const maps = {};
    vals.forEach((r) => {
      const d = dayKey_(r[0]);
      if (!d) return;
      const has = rc.some((c) => r[c] !== '' && r[c] !== null);
      const key = 'st:' + id + ':' + d.slice(0, 7);
      const map = maps[key] || (maps[key] = JSON.parse(P.getProperty(key) || '{}'));
      const o = map[d] || {};
      if (has && !o.f) { o.f = now; o.l = now; o.n = 0; }
      else if (has) { o.l = now; o.n = (o.n || 0) + 1; delete o.x; }
      else if (o.f) { o.x = now; } // report cleared after being written
      else return;
      map[d] = o;
    });
    Object.keys(maps).forEach((k) => P.setProperty(k, JSON.stringify(maps[k])));
  } finally {
    lock.releaseLock();
  }
}

function dayKey_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  const s = String(v || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})/.exec(s);
  if (m) {
    const mi = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2].toLowerCase());
    if (mi >= 0) return m[3] + '-' + ('0' + (mi + 1)).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  }
  return null;
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

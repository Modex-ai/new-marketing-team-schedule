/**
 * Vendoor · Marketing Team Operations — Team Reports connector
 *
 * Reads the "Daily Log" tab of each team member's report sheet and returns it as JSON
 * to the dashboard. Runs as you, so it can open your sheets while they stay private.
 *
 * Setup (once):
 *   1. Go to script.google.com → New project → paste this file → Save.
 *   2. Deploy → New deployment → type "Web app"
 *        Execute as: Me      Who has access: Anyone
 *      → Deploy → allow access → copy the Web app URL.
 *   3. Send the Web app URL to whoever manages the dashboard (it goes into Vercel as REPORTS_URL).
 *
 * The KEY below must match REPORTS_KEY on Vercel. Without it the script returns nothing.
 * Adding a new girl's sheet never needs a change here — add its link from the dashboard (Manage → Reports).
 */
const KEY = 'PASTE_THE_KEY_HERE';
const TZ = 'Africa/Cairo';
const MAX_SHEETS = 40;

function doGet(e) {
  return handle_((e && e.parameter) || {});
}

function doPost(e) {
  let p = {};
  try { p = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) {}
  return handle_(p);
}

function handle_(p) {
  if (!p.key || p.key !== KEY) return out_({ ok: false, error: 'unauthorized' });
  const ids = String(p.ids || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, MAX_SHEETS);
  const sheets = ids.map((id) => {
    try { return readSheet_(id); } catch (err) { return { id: id, error: String((err && err.message) || err) }; }
  });
  return out_({ ok: true, generatedAt: new Date().toISOString(), sheets: sheets });
}

// Columns someone types into each day (calculated columns like AOV are ignored when deciding if a row was filled).
const INPUT_COLS = /^(shift|total sales|sales|orders|items|total items|quantity|out of stock|refund|exchang|feedback|notes?)/i;
const NAME_COLS = /^(moderator|t\.?l|name)$/i;

function readSheet_(id) {
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

  let updated = null;
  try { updated = DriveApp.getFileById(id).getLastUpdated().toISOString(); } catch (err) {}
  return { id: id, title: ss.getName(), tab: sh.getName(), url: ss.getUrl(), header: header.slice(0, width), rows: rows, updated: updated };
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

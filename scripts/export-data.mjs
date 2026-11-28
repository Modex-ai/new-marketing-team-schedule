// Download everything the dashboard stored in Vercel Blob into ./data (the folder server.js reads with STORAGE=fs).
//   BLOB_READ_WRITE_TOKEN=vercel_blob_rw_… node scripts/export-data.mjs
// Older saves used random-suffix copies (schedule-AbC….json): the newest copy of each document is saved under its plain name.
import { list, get } from '@vercel/blob';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(process.env.DATA_DIR || 'data');
if (!process.env.BLOB_READ_WRITE_TOKEN) { console.error('Set BLOB_READ_WRITE_TOKEN (Vercel → Storage → the store → .env.local).'); process.exit(1); }
const all = []; let cursor;
do { const r = await list({ prefix: 'marketing-ops/', limit: 1000, cursor }); all.push(...r.blobs); cursor = r.hasMore ? r.cursor : undefined; } while (cursor);
const pick = new Map(); // target path → newest blob
for (const b of all) {
  const m = /^(.*?)-[A-Za-z0-9]{20,}(\.json)$/.exec(b.pathname);
  const target = m && !/\/(attachments|backups)\//.test(b.pathname) ? m[1] + m[2] : b.pathname;
  const cur = pick.get(target);
  if (!cur || (cur.pathname !== target && (b.pathname === target || new Date(b.uploadedAt) > new Date(cur.uploadedAt)))) pick.set(target, b);
}
let n = 0;
for (const [target, b] of pick) {
  const r = await get(b.url, { access: 'private', useCache: false });
  if (!r || !r.stream) { console.warn('skipped', b.pathname); continue; }
  const f = path.join(OUT, target); fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, Buffer.from(await new Response(r.stream).arrayBuffer())); n++;
  console.log('saved', target);
}
console.log(`\n${n} files in ${OUT}`);

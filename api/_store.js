// Where the dashboard keeps its JSON documents and attachments.
// On Vercel: Vercel Blob (default). On any other server: set STORAGE=fs and the files live in DATA_DIR (default ./data).
import * as blob from '@vercel/blob';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const FS = process.env.STORAGE === 'fs';
const ROOT = path.resolve(process.env.DATA_DIR || 'data');
const file = (p) => { const rel = String(p).replace(/^fs:\/\//, '').replace(/^https?:\/\/[^/]+\//, ''); const f = path.resolve(ROOT, rel); if (!f.startsWith(ROOT + path.sep)) throw new Error('bad path'); return f; };
const etagOf = (buf) => '"' + crypto.createHash('sha1').update(buf).digest('hex') + '"';

const fsStore = {
  async put(p, body, o = {}) {
    let rel = String(p);
    if (o.addRandomSuffix) rel = rel.replace(/(\.\w+)?$/, (ext) => '-' + crypto.randomBytes(15).toString('hex') + (ext || ''));
    const f = file(rel);
    if (!o.allowOverwrite && !o.addRandomSuffix && fs.existsSync(f)) throw new Error('This file already exists');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : await new Response(body).arrayBuffer());
    fs.writeFileSync(f + '.tmp', buf); fs.renameSync(f + '.tmp', f); // never a half-written file
    return { url: 'fs://' + rel, pathname: rel, etag: etagOf(buf) };
  },
  async get(p, o = {}) {
    const f = file(p); if (!fs.existsSync(f)) return null;
    const buf = fs.readFileSync(f), etag = etagOf(buf), st = fs.statSync(f);
    const meta = { url: 'fs://' + path.relative(ROOT, f), pathname: path.relative(ROOT, f), etag, size: buf.length, uploadedAt: st.mtime, contentType: /\.json$/.test(f) ? 'application/json' : 'application/octet-stream' };
    if (o.ifNoneMatch && o.ifNoneMatch === etag) return { statusCode: 304, stream: null, blob: meta };
    return { statusCode: 200, stream: new Blob([buf]).stream(), headers: new Headers({ 'content-type': meta.contentType, 'content-length': String(buf.length) }), blob: meta };
  },
  async list({ prefix = '' } = {}) {
    const out = [], walk = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (!f.endsWith('.tmp')) { const rel = path.relative(ROOT, f).split(path.sep).join('/'); if (rel.startsWith(prefix)) out.push({ pathname: rel, url: 'fs://' + rel, uploadedAt: fs.statSync(f).mtime, size: fs.statSync(f).size }); } } };
    walk(ROOT);
    return { blobs: out, hasMore: false };
  },
  async del(urls) { for (const u of [].concat(urls)) { try { fs.unlinkSync(file(u)); } catch {} } },
};

export const put = FS ? fsStore.put : blob.put;
export const get = FS ? fsStore.get : blob.get;
export const list = FS ? fsStore.list : blob.list;
export const del = FS ? fsStore.del : blob.del;
export const STORAGE_FS = FS;

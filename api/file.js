// Serves attachments from the private Blob store (with Range support so videos stream and seek).
// GET    /api/file?u=<blob url>                → the file
// DELETE /api/file?u=<blob url>  (signed in) → deletes the file
import { get, del } from '@vercel/blob';
import { Readable } from 'node:stream';
import { userFromToken, bearer } from './_lib.js';

const ACCESS = process.env.BLOB_ACCESS === 'public' ? 'public' : 'private';
const PREFIX = '/marketing-ops/attachments/';

function validUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && x.hostname.endsWith('.blob.vercel-storage.com') && x.pathname.startsWith(PREFIX);
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  const u = String((req.query && req.query.u) || new URL(req.url, 'http://x').searchParams.get('u') || '');
  if (!validUrl(u)) return res.status(400).json({ error: 'invalid file url' });

  try {
    if (req.method === 'DELETE') {
      if (!(await userFromToken(bearer(req)))) return res.status(401).json({ error: 'Please sign in again' });
      await del(u);
      return res.status(200).json({ ok: true });
    }
    // private: images and videos load with ?t=<session token> (an <img> can't send a header)
    const tok = bearer(req) || String((req.query && req.query.t) || new URL(req.url, 'http://x').searchParams.get('t') || '');
    if (!(await userFromToken(tok))) return res.status(401).json({ error: 'Please sign in' });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD, DELETE');
      return res.status(405).json({ error: 'method not allowed' });
    }

    const range = req.headers.range;
    const r = await get(u, { access: ACCESS, headers: range ? { range } : undefined });
    if (!r || !r.stream) return res.status(404).json({ error: 'not found' });

    for (const h of ['content-type', 'content-length', 'content-range', 'etag', 'last-modified']) {
      const v = r.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('accept-ranges', 'bytes');
    res.setHeader('cache-control', 'private, max-age=3600');
    res.statusCode = r.headers.get('content-range') ? 206 : 200;
    if (req.method === 'HEAD') return res.end();
    Readable.fromWeb(r.stream).pipe(res);
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}

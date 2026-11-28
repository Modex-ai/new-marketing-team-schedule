// Run the dashboard on any Node.js server (20+), outside Vercel:
//   npm install && STORAGE=fs DATA_DIR=./data PORT=3000 node server.js
// It serves the page and the same /api/* routes as Vercel. Put the environment variables from .env.example in place first.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// a simple .env loader (KEY=value lines), so the server can run without extra packages
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
if (!process.env.STORAGE) process.env.STORAGE = 'fs';

const routes = {};
for (const f of fs.readdirSync(path.join(ROOT, 'api'))) if (/^[a-z]\w*\.js$/.test(f)) routes[f.slice(0, -3)] = (await import(pathToFileURL(path.join(ROOT, 'api', f)).href)).default;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon' };
const PUBLIC = new Set(['index.html']), PUBLIC_DIRS = ['assets/'];

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const m = /^\/api\/(\w+)\/?$/.exec(u.pathname);
    if (m && routes[m[1]]) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      req.query = Object.fromEntries(u.searchParams);
      try { req.body = /json/.test(req.headers['content-type'] || '') && raw ? JSON.parse(raw) : raw; } catch { req.body = raw; }
      res.status = (c) => { res.statusCode = c; return res; };
      res.json = (o) => { if (!res.headersSent) res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); return res; };
      res.send = (b) => { res.end(b); return res; };
      return await routes[m[1]](req, res);
    }
    // static files: the page and its assets only (never the server code or the data folder)
    const rel = decodeURIComponent(u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
    if (!PUBLIC.has(rel) && !PUBLIC_DIRS.some((d) => rel.startsWith(d))) { res.statusCode = 404; return res.end('Not found'); }
    const fp = path.resolve(ROOT, rel);
    if (!fp.startsWith(ROOT + path.sep) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('content-type', TYPES[path.extname(fp)] || 'application/octet-stream');
    res.setHeader('cache-control', rel === 'index.html' ? 'no-cache' : 'public, max-age=3600');
    fs.createReadStream(fp).pipe(res);
  } catch (e) {
    if (!res.headersSent) { res.statusCode = 500; res.setHeader('content-type', 'application/json'); }
    res.end(JSON.stringify({ error: String((e && e.message) || e) }));
  }
}).listen(+process.env.PORT || 3000, () => console.log(`Dashboard on http://localhost:${+process.env.PORT || 3000}  (storage: ${process.env.STORAGE === 'fs' ? 'files in ' + path.resolve(process.env.DATA_DIR || 'data') : 'Vercel Blob'})`));

// Serves site-dist/ under /VelocityBlocks/, the path GitHub Pages uses for this project site, so relative URLs,
// the 404 page and the game in play/ behave as they will online.
//   npm run site:serve              → http://localhost:5371/VelocityBlocks/
//   node scripts/serve-site.mjs --port 8080
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'site-dist');
const BASE = '/VelocityBlocks/';
const i = process.argv.indexOf('--port');
const PORT = i > 0 ? Number(process.argv[i + 1]) : 5371;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.ktx2': 'image/ktx2',
  '.wasm': 'application/wasm',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, file) {
  res.writeHead(status, { 'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let p = decodeURIComponent(url.pathname);
    if (p === '/' || p === BASE.slice(0, -1)) {
      res.writeHead(301, { location: BASE });
      return res.end();
    }
    if (!p.startsWith(BASE)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not under ' + BASE);
    }
    const rel = p.slice(BASE.length);
    let file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end();
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      // Like GitHub Pages: a folder without its trailing slash redirects, so relative URLs resolve inside it.
      if (!p.endsWith('/')) {
        res.writeHead(301, { location: p + '/' + url.search });
        return res.end();
      }
      file = path.join(file, 'index.html');
    }
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return send(res, 200, file);
    const notFound = path.join(ROOT, '404.html');
    if (fs.existsSync(notFound)) return send(res, 404, notFound);
    res.writeHead(404);
    res.end('Not found');
  })
  .listen(PORT, () => console.log(`site-dist/ at http://localhost:${PORT}${BASE}`));

'use strict';

/**
 * Honey Management System - frontend server.
 * Serves ./public and forwards /api/* and /setup to the backend.
 *   npm install   (nothing to download, but keeps the workflow the same)
 *   npm start     then open http://localhost:8080
 *
 * BACKEND_URL defaults to http://127.0.0.1:3000 (docker compose sets http://backend:3000).
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 8080;
const BACKEND = new URL(process.env.BACKEND_URL || 'http://127.0.0.1:3000');
const PUBLIC_DIR = path.join(__dirname, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
};

function proxy(req, res) {
  const headers = { ...req.headers, host: BACKEND.host, 'x-forwarded-for': req.socket.remoteAddress };
  const upstream = http.request(
    { hostname: BACKEND.hostname, port: BACKEND.port, path: req.url, method: req.method, headers },
    (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); }
  );
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ error: 'Backend is not reachable' }));
  });
  req.pipe(upstream);
}

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { rel = '/'; }
  if (rel === '/' || rel === '') rel = '/index.html';
  let target = path.resolve(PUBLIC_DIR, `.${rel}`);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) target = path.join(PUBLIC_DIR, 'index.html');
  const type = TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-cache' });
  fs.createReadStream(target).pipe(res);
}

http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname.startsWith('/api/') || pathname === '/setup') return proxy(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    return res.end('Method not allowed');
  }
  serveStatic(req, res, pathname);
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Frontend: http://localhost:${PORT}  ->  backend ${BACKEND.origin}`);
});

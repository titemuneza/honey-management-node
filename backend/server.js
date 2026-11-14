'use strict';

/**
 * Honey Management System - web server (Node.js).
 *   npm install      (once)
 *   npm start        then open http://localhost:3000
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const db = require('./lib/db');
const { routes, Raw } = require('./lib/routes');
const { ApiError, now, hashPassword } = require('./lib/util');

const PUBLIC_DIR = path.join(__dirname, 'public');
const COOKIE = 'hms_session';
const SESSION_SECONDS = 12 * 3600;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------------------
// Sessions (kept in memory: restarting the server signs everyone out)
// ---------------------------------------------------------------------------
const sessions = new Map(); // token -> { userId, expires }

setInterval(() => {
  const t = Date.now();
  for (const [token, s] of sessions) if (s.expires < t) sessions.delete(token);
}, 600000).unref();

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function sessionUserId(token) {
  const s = token ? sessions.get(token) : null;
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); return null; }
  return s.userId;
}

const cookieHeader = (req, value, maxAge) =>
  `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${req.socket.encrypted ? '; Secure' : ''}`;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------
function send(res, status, body, type, extra = {}) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...extra,
  });
  res.end(data);
}

const sendJson = (res, status, payload, extra) => send(res, status, JSON.stringify(payload), 'application/json; charset=utf-8', extra);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1000000) {
        reject(new ApiError(413, 'Request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw new ApiError(415, 'Content-Type must be application/json');
  }
  let data;
  try { data = JSON.parse(raw); } catch { throw new ApiError(400, 'Invalid JSON'); }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new ApiError(400, 'JSON body must be an object');
  return data;
}

function sendFailure(res, e) {
  if (e instanceof ApiError) return sendJson(res, e.status, { error: e.message });
  if (e && e.noTable) return sendJson(res, 500, { error: 'Database tables are missing. Restart the server to create them.' });
  console.error(e);
  return sendJson(res, 500, { error: 'Something went wrong on the server' });
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function handleApi(req, res, method, apiPath, query) {
  let found = null;
  let args = [];
  let pathKnown = false;
  for (const r of routes) {
    const m = r.regex.exec(apiPath);
    if (!m) continue;
    pathKnown = true;
    if (r.method === method) { found = r; args = m.slice(1); break; }
  }
  if (!found) throw new ApiError(pathKnown ? 405 : 404, 'Not found');

  const body = method === 'POST' || method === 'PUT' ? await readJson(req) : {};
  const token = readCookie(req, COOKIE);
  const extraHeaders = [];

  let user = null;
  if (found.auth !== null) {
    const userId = sessionUserId(token);
    if (userId) user = await db.row('SELECT * FROM users WHERE id = ? AND active = 1', [userId]);
    if (!user) throw new ApiError(401, 'Please sign in');
    if (found.auth === 'admin' && user.role !== 'admin') throw new ApiError(403, 'Administrator access required');
  }

  const ctx = {
    body,
    query,
    user,
    ip: String(req.socket.remoteAddress || '0.0.0.0').slice(0, 45),
    login(userId) {
      if (token) sessions.delete(token);
      const fresh = crypto.randomBytes(32).toString('base64url');
      sessions.set(fresh, { userId: Number(userId), expires: Date.now() + SESSION_SECONDS * 1000 });
      extraHeaders.push(cookieHeader(req, fresh, SESSION_SECONDS));
    },
    logout() {
      if (token) sessions.delete(token);
      extraHeaders.push(cookieHeader(req, '', 0));
    },
  };

  // Writes run in a transaction so a failed request changes nothing.
  // (Sign-in and sign-out are single statements and run on their own.)
  const call = () => found.handler(ctx, ...args);
  const [status, payload] = method === 'GET' || found.auth === null ? await call() : await db.transaction(call);

  const setCookie = extraHeaders.length ? { 'Set-Cookie': extraHeaders } : {};
  if (payload instanceof Raw) return send(res, status, payload.data, payload.contentType, { ...payload.headers, ...setCookie });
  return sendJson(res, status, payload, setCookie);
}

// ---------------------------------------------------------------------------
// One-time setup page: creates the first administrator
// ---------------------------------------------------------------------------
const h = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function setupPage(title, content) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(title)} - Honey Management</title><link rel="stylesheet" href="/style.css"></head><body>
<main class="login-wrap"><div class="login-card" style="max-width:460px"><div class="brand"><span>Honey Management setup</span></div>${content}</div></main></body></html>`;
}

async function handleSetup(req, res, method) {
  const userCount = Number(await db.scalar('SELECT COUNT(*) FROM users'));
  const page = (status, title, content) => send(res, status, setupPage(title, content), 'text/html; charset=utf-8');

  if (userCount > 0) {
    return page(200, 'Already set up', '<p>The system is already set up, so this page is locked.</p>'
      + '<p><a class="btn primary" href="/">Open Honey Management</a></p>');
  }

  let error = '';
  let username = 'admin';
  let fullName = '';
  if (method === 'POST') {
    const form = new URLSearchParams(await readBody(req));
    username = String(form.get('username') || '').trim().toLowerCase();
    fullName = String(form.get('full_name') || '').trim().slice(0, 100);
    const password = String(form.get('password') || '');
    if (!/^[a-z0-9_.-]{3,32}$/.test(username)) error = 'Username must be 3-32 characters: letters, numbers, . _ -';
    else if (password.length < 8) error = 'Password must be at least 8 characters.';
    else if (password !== String(form.get('confirm') || '')) error = 'The two passwords do not match.';
    else {
      await db.run('INSERT INTO users (username, full_name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
        [username, fullName, 'admin', await hashPassword(password), now()]);
      return page(200, 'Setup complete', `<p><strong>Done.</strong> The administrator <code>${h(username)}</code> has been created.</p>`
        + '<p><a class="btn primary" href="/">Sign in</a></p>');
    }
  }

  return page(error ? 400 : 200, 'Create administrator',
    '<p class="muted">The database is ready. Create the first administrator account.</p>'
    + (error ? `<div class="form-error" role="alert">${h(error)}</div>` : '')
    + '<form method="post" action="/setup" autocomplete="off">'
    + `<label class="field"><span>Username</span><input name="username" required value="${h(username)}"></label>`
    + `<label class="field"><span>Full name</span><input name="full_name" value="${h(fullName)}"></label>`
    + '<label class="field"><span>Password (at least 8 characters)</span><input name="password" type="password" required minlength="8" autocomplete="new-password"></label>'
    + '<label class="field"><span>Confirm password</span><input name="confirm" type="password" required minlength="8" autocomplete="new-password"></label>'
    + '<button class="btn primary" type="submit">Create administrator</button></form>');
}

// ---------------------------------------------------------------------------
// Static files (the frontend in public/)
// ---------------------------------------------------------------------------
function serveStatic(res, urlPath) {
  let relative;
  try { relative = decodeURIComponent(urlPath); } catch { return send(res, 400, 'Bad request', 'text/plain'); }
  if (relative === '/' || relative === '') relative = '/index.html';
  const target = path.resolve(PUBLIC_DIR, `.${relative}`);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found', 'text/plain');
  let data;
  try {
    if (!fs.statSync(target).isFile()) throw new Error('not a file');
    data = fs.readFileSync(target);
  } catch {
    return send(res, 404, 'Not found', 'text/plain');
  }
  return send(res, 200, data, TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream', { 'Cache-Control': 'no-cache' });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const method = req.method;
    if (url.pathname.startsWith('/api/')) {
      const query = Object.fromEntries(url.searchParams);
      return await handleApi(req, res, method, url.pathname.slice(4), query);
    }
    if (url.pathname === '/setup' && (method === 'GET' || method === 'POST')) return await handleSetup(req, res, method);
    if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
    return serveStatic(res, url.pathname);
  } catch (e) {
    if (!res.headersSent) return sendFailure(res, e);
    res.end();
  }
});

async function main() {
  try {
    await db.connect();
    if (!(await db.tablesExist())) {
      await db.createTables();
      console.log('Created the database tables.');
    }
  } catch (e) {
    console.error('\nCould not start the database: ' + e.message);
    if (config.dbDriver === 'mysql' && !/mysql2/.test(e.message)) {
      console.error('Make sure MySQL is running (XAMPP Control Panel > MySQL > Start) and that DB_USER / DB_PASS in config.js are right.\n');
    }
    process.exit(1);
  }

  server.listen(config.port, config.host, async () => {
    const where = db.driverName() === 'sqlite' ? `SQLite file ${config.sqliteFile}` : `MySQL database "${config.dbName}"`;
    console.log(`Honey Management System running at http://localhost:${config.port}  (${where})`);
    if (Number(await db.scalar('SELECT COUNT(*) FROM users')) === 0) {
      console.log(`\nFirst time? Create the administrator at http://localhost:${config.port}/setup`);
    }
    console.log('Press Ctrl+C to stop.');
  });

  const stop = () => { server.close(); db.close().finally(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main();

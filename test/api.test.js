'use strict';

/**
 * End-to-end test: starts the server with the built-in SQLite driver (no MySQL needed),
 * then exercises sign-in, roles, CRUD, stock rules, sales, reports and the setup page.
 * Run with:  npm test      (needs Node 22.5 or newer)
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(os.tmpdir(), `honey-test-${process.pid}.db`);
let failures = 0;

function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : '  -> ' + String(extra).slice(0, 300)}`);
  if (!ok) failures += 1;
}

class Client {
  constructor() { this.cookie = ''; }
  async call(method, route, body, { raw = false, contentType = 'application/json' } = {}) {
    const headers = {};
    if (this.cookie) headers.Cookie = this.cookie;
    if (body !== undefined) headers['Content-Type'] = contentType;
    const res = await fetch(`${BASE}/api${route}`, {
      method, headers, body: body === undefined ? undefined : (contentType === 'application/json' ? JSON.stringify(body) : String(body)),
    });
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0];
      this.cookie = pair.endsWith('=') ? '' : pair;
    }
    const text = await res.text();
    let data = text;
    if (!raw) { try { data = JSON.parse(text); } catch { /* keep text */ } }
    return { status: res.status, data, headers: res.headers, setCookie: res.headers.getSetCookie() };
  }
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/`); return; } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  throw new Error('server did not start');
}

async function run() {
  // ---- setup page ----
  let page = await (await fetch(`${BASE}/setup`)).text();
  check('setup page shows the form', page.includes('Create administrator'));
  const post = (form) => fetch(`${BASE}/setup`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
  page = await (await post({ username: 'boss', password: 'abc', confirm: 'abc' })).text();
  check('setup rejects short password', page.includes('at least 8 characters'));
  page = await (await post({ username: 'boss', password: 'TestPass123', confirm: 'different1' })).text();
  check('setup rejects mismatched passwords', page.includes('do not match'));
  page = await (await post({ username: 'Admin', full_name: 'Owner', password: 'TestPass123', confirm: 'TestPass123' })).text();
  check('setup creates the administrator', page.includes('Setup complete'));
  page = await (await fetch(`${BASE}/setup`)).text();
  check('setup locks afterwards', page.includes('locked'));

  // ---- static files and safety ----
  for (const [file, type] of [['/', 'text/html'], ['/app.js', 'javascript'], ['/style.css', 'text/css']]) {
    const res = await fetch(BASE + file);
    check(`static ${file}`, res.status === 200 && (res.headers.get('content-type') || '').includes(type), res.status);
  }
  for (const evil of ['/../server.js', '/%2e%2e/server.js', '/..%2fconfig.js', '/lib/routes.js', '/honey.db']) {
    const res = await fetch(BASE + evil);
    check(`cannot read ${evil}`, res.status === 404, res.status);
  }

  const admin = new Client();
  const call = (...a) => admin.call(...a);
  const stockOf = async (pid) => (await call('GET', '/products')).data.items.find((p) => p.id === pid).stock;

  // ---- auth ----
  check('me requires login', (await call('GET', '/me')).status === 401);
  check('bad login rejected', (await call('POST', '/login', { username: 'admin', password: 'wrong' })).status === 401);
  let r = await call('POST', '/login', { username: 'admin', password: 'TestPass123' });
  check('login ok', r.status === 200 && r.data.user.role === 'admin' && r.data.currency === 'USD', JSON.stringify(r.data));
  check('session cookie is HttpOnly', r.setCookie.some((c) => /HttpOnly/i.test(c) && /SameSite=Lax/i.test(c)), r.setCookie);
  const me = (await call('GET', '/me')).data;
  check('me after login', me.user.username === 'admin' && me.user.full_name === 'Owner', JSON.stringify(me));

  // ---- empty start ----
  r = await call('GET', '/dashboard');
  check('starts empty (nothing added automatically)', r.status === 200 && r.data.counts.products === 0 && r.data.counts.customers === 0
    && r.data.counts.units_in_stock === 0 && r.data.counts.stock_value === 0 && r.data.daily.length === 14, JSON.stringify(r.data.counts));

  // ---- create ----
  r = await call('POST', '/products', { name: 'Acacia', price: '10', unit: '500g', low_stock_threshold: 5 });
  const pid = r.data.id;
  check('create product', r.status === 201 && r.data.price === 10 && r.data.stock === 0 && r.data.low === true, JSON.stringify(r.data));
  check('product name required', (await call('POST', '/products', { name: '', price: 1 })).status === 400);
  check('negative price rejected', (await call('POST', '/products', { name: 'X', price: -1 })).status === 400);
  check('non-number price rejected', (await call('POST', '/products', { name: 'X', price: 'abc' })).status === 400);
  r = await call('POST', '/customers', { name: 'Amina', email: 'a@b.c' });
  const cid = r.data.id;
  check('create customer', r.status === 201, JSON.stringify(r.data));
  r = await call('POST', '/suppliers', { name: 'Hilltop' });
  const supid = r.data.id;
  check('create supplier', r.status === 201, JSON.stringify(r.data));
  r = await call('POST', '/stock', { product_id: pid, quantity: 50, supplier_id: supid, cost_per_unit: 5, harvest_date: '2026-10-01' });
  const eid = r.data.id;
  check('receive batch: stock 50, batch code, supplier name', r.status === 201 && (await stockOf(pid)) === 50 && /^HN-\d{8}-\d{4}$/.test(r.data.batch_code) && r.data.supplier_name === 'Hilltop', JSON.stringify(r.data));
  check('zero quantity rejected', (await call('POST', '/stock', { product_id: pid, quantity: 0 })).status === 400);
  check('bad harvest date rejected', (await call('POST', '/stock', { product_id: pid, quantity: 1, harvest_date: 'x' })).status === 400);
  check('unknown product rejected', (await call('POST', '/stock', { product_id: 9999, quantity: 1 })).status === 400);

  // ---- read / search ----
  r = await call('GET', '/products?q=acac');
  check('search products', r.status === 200 && r.data.items.length === 1 && r.data.items[0].low === false, JSON.stringify(r.data));
  check('read one batch', (await call('GET', `/stock/${eid}`)).data.quantity === 50);
  check('missing batch is 404', (await call('GET', '/stock/99999')).status === 404);

  // ---- update ----
  r = await call('PUT', `/products/${pid}`, { price: 11 });
  check('partial product update', r.status === 200 && r.data.price === 11 && r.data.name === 'Acacia', JSON.stringify(r.data));
  r = await call('PUT', `/stock/${eid}`, { quantity: 60 });
  check('batch quantity up: stock 60', r.status === 200 && (await stockOf(pid)) === 60, JSON.stringify(r.data));
  r = await call('PUT', `/stock/${eid}`, { quantity: 40, notes: 'recount', supplier_id: '', harvest_date: '' });
  check('batch quantity down, supplier and date cleared', r.status === 200 && (await stockOf(pid)) === 40 && r.data.supplier_id === null && r.data.harvest_date === null && r.data.notes === 'recount', JSON.stringify(r.data));
  check('batch quantity 0 rejected', (await call('PUT', `/stock/${eid}`, { quantity: 0 })).status === 400);
  r = await call('PUT', `/stock/${eid}`, { batch_code: '' });
  check('blank batch code regenerates', r.status === 200 && r.data.batch_code.startsWith('HN-'), JSON.stringify(r.data));
  r = await call('PUT', `/customers/${cid}`, { phone: '0788' });
  check('update customer', r.status === 200 && r.data.phone === '0788', JSON.stringify(r.data));
  await call('PUT', `/products/${pid}`, { price: 10 });

  // ---- sales ----
  r = await call('POST', '/sales', { customer_id: cid, payment_method: 'mobile_money', items: [{ product_id: pid, quantity: '3' }, { product_id: pid, quantity: 2 }] });
  const sid = r.data.id;
  check('sale merges lines: total 50, stock 35', r.status === 201 && r.data.total === 50 && r.data.items[0].quantity === 5 && (await stockOf(pid)) === 35 && r.data.customer_name === 'Amina', JSON.stringify(r.data));
  check('oversell is 409 with no stock change', (await call('POST', '/sales', { items: [{ product_id: pid, quantity: 999 }] })).status === 409 && (await stockOf(pid)) === 35);
  check('empty sale rejected', (await call('POST', '/sales', { items: [] })).status === 400);
  check('bad quantity rejected', (await call('POST', '/sales', { items: [{ product_id: pid, quantity: 'abc' }] })).status === 400);
  check('bad payment method rejected', (await call('POST', '/sales', { payment_method: 'bitcoin', items: [{ product_id: pid, quantity: 1 }] })).status === 400);
  check('unknown customer rejected', (await call('POST', '/sales', { customer_id: 9999, items: [{ product_id: pid, quantity: 1 }] })).status === 400);
  check('cannot cut a batch below the stock already sold', (await call('PUT', `/stock/${eid}`, { quantity: 3 })).status === 409 && (await stockOf(pid)) === 35);
  check('cannot delete a batch whose stock is sold', (await call('DELETE', `/stock/${eid}`)).status === 409 && (await stockOf(pid)) === 35);

  await call('PUT', `/products/${pid}`, { price: 12 });
  r = await call('PUT', `/sales/${sid}`, { customer_id: null, payment_method: 'cash', items: [{ product_id: pid, quantity: 15 }] });
  check('edit sale keeps the original price (150), stock 25', r.status === 200 && r.data.total === 150 && (await stockOf(pid)) === 25 && r.data.customer_id === null && r.data.payment_method === 'cash', JSON.stringify(r.data));
  check('edit that oversells is 409 and rolled back', (await call('PUT', `/sales/${sid}`, { items: [{ product_id: pid, quantity: 9999 }] })).status === 409 && (await stockOf(pid)) === 25);
  r = await call('GET', `/sales/${sid}`);
  check('failed edit left the sale intact', r.data.items[0].quantity === 15 && r.data.total === 150, JSON.stringify(r.data));
  check('edit with no items rejected', (await call('PUT', `/sales/${sid}`, { items: [] })).status === 400);
  check('edit of missing sale is 404', (await call('PUT', '/sales/99999', { items: [{ product_id: pid, quantity: 1 }] })).status === 404);
  r = await call('GET', '/sales');
  check('list sales has units and numeric total', r.data.items[0].units === 15 && r.data.items[0].total === 150, JSON.stringify(r.data));
  check('date filter works', (await call('GET', '/sales?from=2000-01-01&to=2999-01-01')).data.items.length === 1);
  check('bad date filter is 400', (await call('GET', '/sales?from=bad')).status === 400);

  check('delete sale returns stock (40)', (await call('DELETE', `/sales/${sid}`)).status === 200 && (await stockOf(pid)) === 40);
  check('deleted sale is gone', (await call('GET', `/sales/${sid}`)).status === 404);
  r = await call('POST', '/sales', { items: [{ product_id: pid, quantity: 4 }] });
  const sid2 = r.data.id;
  r = await call('POST', `/sales/${sid2}/void`);
  check('void restores stock', r.status === 200 && r.data.status === 'void' && (await stockOf(pid)) === 40, JSON.stringify(r.data));
  check('double void is 409', (await call('POST', `/sales/${sid2}/void`)).status === 409);
  check('void sale cannot be edited', (await call('PUT', `/sales/${sid2}`, { items: [{ product_id: pid, quantity: 1 }] })).status === 409);
  check('deleting a void sale does not restore stock twice', (await call('DELETE', `/sales/${sid2}`)).status === 200 && (await stockOf(pid)) === 40);

  await call('PUT', `/products/${pid}`, { price: 10 });
  r = await call('POST', '/sales', { customer_id: cid, payment_method: 'card', items: [{ product_id: pid, quantity: 2 }] });
  const sid3 = r.data.id;
  check('product with history cannot be deleted', (await call('DELETE', `/products/${pid}`)).status === 409);
  r = await call('GET', '/dashboard');
  const d = r.data;
  check('dashboard figures', r.status === 200 && d.today.revenue === 20 && d.today.orders === 1 && d.counts.units_in_stock === 38 && d.counts.stock_value === 380
    && d.daily[13].revenue === 20 && d.top_products[0].units === 2 && d.recent_sales[0].id === sid3 && d.low_stock.length === 0, JSON.stringify(d).slice(0, 400));

  // ---- reports ----
  await call('POST', '/customers', { name: '=HYPERLINK("x")' });
  r = await call('GET', '/reports/sales.csv?from=2000-01-01', undefined, { raw: true });
  check('sales csv', r.status === 200 && r.headers.get('content-type').startsWith('text/csv') && r.data.includes('Sale #') && r.data.includes('Acacia'), r.data);
  r = await call('GET', '/reports/inventory.csv', undefined, { raw: true });
  check('inventory csv', r.status === 200 && r.data.includes('Acacia') && r.data.includes('OK'), r.data);
  r = await call('GET', '/reports/stock-in.csv', undefined, { raw: true });
  check('batches csv', r.status === 200 && r.data.includes('HN-'), r.data);
  r = await call('GET', '/reports/customers.csv', undefined, { raw: true });
  check('customers csv neutralises formulas', r.status === 200 && r.data.includes(`"'=HYPERLINK(""x"")"`) && r.data.includes('Amina'), r.data);
  check('bad report date is 400', (await call('GET', '/reports/sales.csv?from=bad')).status === 400);

  // ---- database overview ----
  r = await call('GET', '/database');
  const names = r.data.tables ? r.data.tables.map((t) => t.name) : [];
  check('database overview lists the tables', r.status === 200 && ['products', 'sales', 'sale_items', 'stock_in', 'users'].every((n) => names.includes(n)), JSON.stringify(r.data).slice(0, 200));

  // ---- users and roles ----
  check('short password rejected', (await call('POST', '/users', { username: 'staff1', password: 'short' })).status === 400);
  check('bad username rejected', (await call('POST', '/users', { username: 'A B', password: 'staffpass1' })).status === 400);
  r = await call('POST', '/users', { username: 'Staff1', password: 'staffpass1', role: 'staff', full_name: 'Sam' });
  const staffId = r.data.id;
  check('create staff (username lowercased)', r.status === 201 && r.data.username === 'staff1' && r.data.active === 1, JSON.stringify(r.data));
  check('duplicate username is 409', (await call('POST', '/users', { username: 'staff1', password: 'staffpass1' })).status === 409);
  check('cannot demote yourself', (await call('PUT', `/users/${me.user.id}`, { role: 'staff' })).status === 400);
  check('cannot delete yourself', (await call('DELETE', `/users/${me.user.id}`)).status === 400);

  const staff = new Client();
  const sc = (...a) => staff.call(...a);
  r = await sc('POST', '/login', { username: 'staff1', password: 'staffpass1' });
  check('staff can sign in', r.status === 200, JSON.stringify(r.data));
  check('staff blocked from users', (await sc('GET', '/users')).status === 403);
  check('staff blocked from deleting a customer', (await sc('DELETE', `/customers/${cid}`)).status === 403);
  check('staff blocked from deleting a sale', (await sc('DELETE', `/sales/${sid3}`)).status === 403);
  check('staff blocked from voiding', (await sc('POST', `/sales/${sid3}/void`)).status === 403);
  check('staff blocked from deleting a batch', (await sc('DELETE', `/stock/${eid}`)).status === 403);
  check('staff blocked from the database page', (await sc('GET', '/database')).status === 403);
  check('staff can sell', (await sc('POST', '/sales', { items: [{ product_id: pid, quantity: 1 }] })).status === 201);
  check('staff can edit a batch', (await sc('PUT', `/stock/${eid}`, { notes: 'ok' })).status === 200);
  check('wrong current password rejected', (await sc('POST', '/change-password', { current_password: 'nope', new_password: 'newpass999' })).status === 400);
  check('change password', (await sc('POST', '/change-password', { current_password: 'staffpass1', new_password: 'newpass999' })).status === 200);
  check('logout', (await sc('POST', '/logout', {})).status === 200);
  check('session invalid after logout', (await sc('GET', '/me')).status === 401);
  check('sign in with the new password', (await sc('POST', '/login', { username: 'staff1', password: 'newpass999' })).status === 200);
  r = await call('PUT', `/users/${staffId}`, { active: false });
  check('admin disables the user', r.status === 200 && r.data.active === 0, JSON.stringify(r.data));
  check('disabled user is locked out at once', (await sc('GET', '/me')).status === 401);
  check('disabled user cannot sign in', (await new Client().call('POST', '/login', { username: 'staff1', password: 'newpass999' })).status === 401);
  check('admin can delete the user', (await call('DELETE', `/users/${staffId}`)).status === 200);

  // ---- delete everything in dependency order ----
  for (const s of (await call('GET', '/sales')).data.items) await call('DELETE', `/sales/${s.id}`);
  check('delete batch now allowed', (await call('DELETE', `/stock/${eid}`)).status === 200);
  check('delete product now allowed', (await call('DELETE', `/products/${pid}`)).status === 200);
  check('delete customer and supplier', (await call('DELETE', `/customers/${cid}`)).status === 200 && (await call('DELETE', `/suppliers/${supid}`)).status === 200);

  // ---- protocol ----
  check('unknown route is 404', (await call('GET', '/nope')).status === 404);
  check('wrong method is 405', (await call('DELETE', '/dashboard')).status === 405);
  check('non-JSON body is 415', (await call('POST', '/products', 'name=a', { contentType: 'text/plain' })).status === 415);

  // ---- login brake ----
  const brute = new Client();
  const codes = [];
  for (let i = 0; i < 10; i++) codes.push((await brute.call('POST', '/login', { username: 'admin', password: `bad${i}` })).status);
  check('repeated failed logins get blocked (429)', codes.includes(429), codes.join(','));
}

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DB_DRIVER: 'sqlite', SQLITE_FILE: DB_FILE, PORT: String(PORT), HOST: '127.0.0.1', NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  try {
    await waitForServer();
    await run();
  } catch (e) {
    console.error('Test run crashed:', e);
    failures += 1;
  } finally {
    child.kill();
    for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) fs.rmSync(f, { force: true });
  }
  const serverErrors = output.split('\n').filter((l) => /error|exception|unhandled/i.test(l) && !/^Created/.test(l));
  if (serverErrors.length) console.log('\nServer log problems:\n' + serverErrors.join('\n'));
  console.log(`\nFAILED: ${failures}`);
  process.exit(failures ? 1 : 0);
})();

'use strict';

/**
 * Every API operation. Each handler receives ctx = { body, query, user, ip, login, logout }
 * and returns [http status, payload]. Create = INSERT, Read = SELECT, Update = UPDATE, Delete = DELETE.
 */
const config = require('../config');
const { q, run, row, scalar, describe } = require('./db');
const {
  ApiError, now, today, addDays, validDate, toInt, validate, money, publicUser, hashPassword, verifyPassword,
} = require('./util');

const PAYMENT_METHODS = ['cash', 'mobile_money', 'card', 'bank_transfer'];

/** A non-JSON response (used for CSV downloads). */
class Raw {
  constructor(data, contentType, headers = {}) {
    this.data = data;
    this.contentType = contentType;
    this.headers = headers;
  }
}

const routes = [];
/** auth: null (public), 'user' (signed in) or 'admin'. */
function route(method, pattern, handler, auth = 'user') {
  routes.push({ method, regex: new RegExp(`^${pattern}$`), handler, auth });
}

const str = (v) => (v === null || v === undefined ? '' : String(v));

// ===========================================================================
// Authentication
// ===========================================================================
let dummyHash = null;

route('POST', '/login', async (c) => {
  const cutoff = new Date(Date.now() - 300000).toLocaleString('sv-SE', { timeZone: config.timezone });
  await run('DELETE FROM login_attempts WHERE attempted_at < ?', [cutoff]);
  const recent = Number(await scalar('SELECT COUNT(*) FROM login_attempts WHERE ip = ?', [c.ip]));
  if (recent >= 8) throw new ApiError(429, 'Too many failed attempts. Try again in a few minutes.');

  const username = str(c.body.username).trim().toLowerCase();
  const password = str(c.body.password);
  const user = await row('SELECT * FROM users WHERE username = ? AND active = 1', [username]);
  dummyHash = dummyHash || (await hashPassword('not-a-real-password'));
  const ok = await verifyPassword(password, user ? user.password_hash : dummyHash);
  if (!user || !ok) {
    await run('INSERT INTO login_attempts (ip, attempted_at) VALUES (?, ?)', [c.ip, now()]);
    throw new ApiError(401, 'Invalid username or password');
  }
  await run('DELETE FROM login_attempts WHERE ip = ?', [c.ip]);
  c.login(user.id);
  return [200, { user: publicUser(user), currency: config.currency }];
}, null);

route('POST', '/logout', async (c) => {
  c.logout();
  return [200, { ok: true }];
}, null);

route('GET', '/me', async (c) => [200, { user: publicUser(c.user), currency: config.currency }]);

route('POST', '/change-password', async (c) => {
  const current = str(c.body.current_password);
  const next = str(c.body.new_password);
  if (!(await verifyPassword(current, c.user.password_hash))) throw new ApiError(400, 'Current password is incorrect');
  if (next.length < 8) throw new ApiError(400, 'New password must be at least 8 characters');
  await run('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(next), c.user.id]);
  return [200, { ok: true }];
});

// ===========================================================================
// Users (admin)
// ===========================================================================
async function userRow(id) {
  const user = await row('SELECT id, username, full_name, role, active, created_at FROM users WHERE id = ?', [id]);
  if (!user) throw new ApiError(404, 'User not found');
  return user;
}

const otherActiveAdmins = async (excludingId) =>
  Number(await scalar("SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = 1 AND id <> ?", [excludingId]));

route('GET', '/users', async () => [200, {
  items: await q('SELECT id, username, full_name, role, active, created_at FROM users ORDER BY username'),
}], 'admin');

route('POST', '/users', async (c) => {
  const username = str(c.body.username).trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,32}$/.test(username)) throw new ApiError(400, 'Username must be 3-32 characters: letters, numbers, . _ -');
  const password = str(c.body.password);
  if (password.length < 8) throw new ApiError(400, 'Password must be at least 8 characters');
  const role = c.body.role === undefined ? 'staff' : c.body.role;
  if (role !== 'admin' && role !== 'staff') throw new ApiError(400, 'Role must be admin or staff');
  if (Number(await scalar('SELECT COUNT(*) FROM users WHERE username = ?', [username])) > 0) {
    throw new ApiError(409, 'That username is already taken');
  }
  const r = await run(
    'INSERT INTO users (username, full_name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    [username, str(c.body.full_name).trim().slice(0, 100), role, await hashPassword(password), now()],
  );
  return [201, await userRow(r.insertId)];
}, 'admin');

route('PUT', '/users/(\\d+)', async (c, idText) => {
  const id = Number(idText);
  const current = await userRow(id);
  const body = c.body;
  const role = body.role === undefined ? current.role : body.role;
  if (role !== 'admin' && role !== 'staff') throw new ApiError(400, 'Role must be admin or staff');
  const active = body.active === undefined ? Number(current.active) : (body.active && body.active !== '0' ? 1 : 0);
  if (id === Number(c.user.id) && (role !== 'admin' || !active)) {
    throw new ApiError(400, 'You cannot remove your own admin access or deactivate yourself');
  }
  if (current.role === 'admin' && (role !== 'admin' || !active) && (await otherActiveAdmins(id)) === 0) {
    throw new ApiError(400, 'At least one active admin is required');
  }
  const fullName = body.full_name === undefined ? current.full_name : str(body.full_name).trim().slice(0, 100);
  await run('UPDATE users SET full_name = ?, role = ?, active = ? WHERE id = ?', [fullName, role, active, id]);
  if (body.password) {
    if (str(body.password).length < 8) throw new ApiError(400, 'Password must be at least 8 characters');
    await run('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(str(body.password)), id]);
  }
  return [200, await userRow(id)];
}, 'admin');

route('DELETE', '/users/(\\d+)', async (c, idText) => {
  const id = Number(idText);
  const current = await userRow(id);
  if (id === Number(c.user.id)) throw new ApiError(400, 'You cannot delete your own account');
  if (current.role === 'admin' && (await otherActiveAdmins(id)) === 0) throw new ApiError(400, 'At least one active admin is required');
  await run('DELETE FROM users WHERE id = ?', [id]);
  return [200, { ok: true }];
}, 'admin');

// ===========================================================================
// Products, suppliers, customers (the same five operations each)
// ===========================================================================
function entityRoutes(table, spec, searchColumns, decorate = (x) => x) {
  const columns = spec.map((f) => f[0]);
  const fetchOne = async (id) => {
    const item = await row(`SELECT * FROM ${table} WHERE id = ?`, [id]);
    if (!item) throw new ApiError(404, 'Not found');
    return decorate(item);
  };

  // Read (list + search)
  route('GET', `/${table}`, async (c) => {
    let sql = `SELECT * FROM ${table}`;
    let params = [];
    const search = str(c.query.q).trim();
    if (search) {
      sql += ' WHERE ' + searchColumns.map((col) => `${col} LIKE ?`).join(' OR ');
      params = searchColumns.map(() => `%${search}%`);
    }
    return [200, { items: (await q(`${sql} ORDER BY name`, params)).map(decorate) }];
  });

  // Create (INSERT)
  route('POST', `/${table}`, async (c) => {
    const data = validate(spec, c.body);
    const r = await run(
      `INSERT INTO ${table} (${columns.join(', ')}, created_at) VALUES (${columns.map(() => '?').join(', ')}, ?)`,
      [...columns.map((col) => data[col]), now()],
    );
    return [201, await fetchOne(r.insertId)];
  });

  // Update (UPDATE)
  route('PUT', `/${table}/(\\d+)`, async (c, idText) => {
    const id = Number(idText);
    await fetchOne(id);
    const data = validate(spec, c.body, true);
    const keys = Object.keys(data);
    if (keys.length) {
      await run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => data[k]), id]);
    }
    return [200, await fetchOne(id)];
  });

  // Delete (DELETE)
  route('DELETE', `/${table}/(\\d+)`, async (c, idText) => {
    const id = Number(idText);
    await fetchOne(id);
    try {
      await run(`DELETE FROM ${table} WHERE id = ?`, [id]);
    } catch (e) {
      if (e.isConstraint) throw new ApiError(409, 'This record is used by stock or sales history and cannot be deleted');
      throw e;
    }
    return [200, { ok: true }];
  }, 'admin');
}

entityRoutes('products', [
  ['name', 'str', true, null],
  ['honey_type', 'str', false, ''],
  ['unit', 'str', false, ''],
  ['price', 'num', true, null],
  ['low_stock_threshold', 'int', false, 10],
], ['name', 'honey_type'], (p) => ({ ...p, low: p.stock <= p.low_stock_threshold }));

entityRoutes('suppliers', [
  ['name', 'str', true, null],
  ['phone', 'str', false, ''],
  ['location', 'str', false, ''],
  ['notes', 'str', false, ''],
], ['name', 'phone', 'location']);

entityRoutes('customers', [
  ['name', 'str', true, null],
  ['phone', 'str', false, ''],
  ['email', 'str', false, ''],
  ['address', 'str', false, ''],
], ['name', 'phone', 'email']);

// ===========================================================================
// Stock batches (full CRUD)
// ===========================================================================
const STOCK_SPEC = [
  ['batch_code', 'str', false, ''],
  ['product_id', 'int', true, null],
  ['supplier_id', 'int', false, null],
  ['quantity', 'int', true, null],
  ['cost_per_unit', 'num', false, 0],
  ['harvest_date', 'str', false, ''],
  ['notes', 'str', false, ''],
];

const STOCK_SELECT = `SELECT s.id, s.batch_code, s.product_id, p.name AS product_name,
        s.supplier_id, sup.name AS supplier_name, s.quantity, s.cost_per_unit,
        s.harvest_date, s.notes, s.created_at, u.username AS created_by
    FROM stock_in s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN suppliers sup ON sup.id = s.supplier_id
    LEFT JOIN users u ON u.id = s.created_by`;

async function stockEntry(id) {
  const entry = await row(`${STOCK_SELECT} WHERE s.id = ?`, [id]);
  if (!entry) throw new ApiError(404, 'Batch not found');
  return entry;
}

const batchCode = (id) => `HN-${today().replace(/-/g, '')}-${String(id).padStart(4, '0')}`;

/** Change a product's stock by delta, refusing to go below zero. */
async function adjustProductStock(productId, delta, what) {
  const r = await run('UPDATE products SET stock = stock + ? WHERE id = ? AND stock + ? >= 0', [delta, productId, delta]);
  if (r.changes === 0) throw new ApiError(409, `Cannot ${what}: some of this stock has already been sold`);
}

route('GET', '/stock', async (c) => {
  let sql = STOCK_SELECT;
  const params = [];
  if (c.query.product_id) {
    sql += ' WHERE s.product_id = ?';
    params.push(toInt(c.query.product_id, 'product_id'));
  }
  return [200, { items: await q(`${sql} ORDER BY s.id DESC LIMIT 500`, params) }];
});

route('GET', '/stock/(\\d+)', async (c, id) => [200, await stockEntry(Number(id))]);

route('POST', '/stock', async (c) => {
  const data = validate(STOCK_SPEC, c.body);
  if (data.quantity <= 0) throw new ApiError(400, 'Quantity must be at least 1');
  if (data.harvest_date !== '') validDate(data.harvest_date, 'Harvest date');
  if ((await scalar('SELECT 1 FROM products WHERE id = ?', [data.product_id])) === null) throw new ApiError(400, 'Product not found');
  if (data.supplier_id !== null && (await scalar('SELECT 1 FROM suppliers WHERE id = ?', [data.supplier_id])) === null) {
    throw new ApiError(400, 'Supplier not found');
  }
  const r = await run(
    `INSERT INTO stock_in (batch_code, product_id, supplier_id, quantity, cost_per_unit, harvest_date, notes, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [data.batch_code, data.product_id, data.supplier_id, data.quantity, data.cost_per_unit,
      data.harvest_date === '' ? null : data.harvest_date, data.notes, c.user.id, now()],
  );
  if (data.batch_code === '') await run('UPDATE stock_in SET batch_code = ? WHERE id = ?', [batchCode(r.insertId), r.insertId]);
  await adjustProductStock(data.product_id, data.quantity, 'add this batch');
  return [201, await stockEntry(r.insertId)];
});

route('PUT', '/stock/(\\d+)', async (c, idText) => {
  const entry = await stockEntry(Number(idText));
  const spec = STOCK_SPEC.filter((f) => f[0] !== 'product_id'); // the product cannot change
  const data = validate(spec, c.body, true);
  if (data.quantity !== undefined && data.quantity <= 0) throw new ApiError(400, 'Quantity must be at least 1');
  if (data.harvest_date) validDate(data.harvest_date, 'Harvest date');
  if (data.harvest_date === '') data.harvest_date = null;
  if (data.supplier_id !== undefined && data.supplier_id !== null
    && (await scalar('SELECT 1 FROM suppliers WHERE id = ?', [data.supplier_id])) === null) {
    throw new ApiError(400, 'Supplier not found');
  }
  if (data.batch_code === '') data.batch_code = batchCode(entry.id);
  if (data.quantity !== undefined && data.quantity !== entry.quantity) {
    await adjustProductStock(entry.product_id, data.quantity - entry.quantity, 'reduce this batch');
  }
  const keys = Object.keys(data);
  if (keys.length) {
    await run(`UPDATE stock_in SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => data[k]), entry.id]);
  }
  return [200, await stockEntry(entry.id)];
});

route('DELETE', '/stock/(\\d+)', async (c, idText) => {
  const entry = await stockEntry(Number(idText));
  await adjustProductStock(entry.product_id, -entry.quantity, 'delete this batch');
  await run('DELETE FROM stock_in WHERE id = ?', [entry.id]);
  return [200, { ok: true }];
}, 'admin');

// ===========================================================================
// Sales (full CRUD)
// ===========================================================================
const SALE_SELECT = `SELECT s.id, s.customer_id, c.name AS customer_name, s.payment_method, s.total,
        s.status, s.created_at, u.username AS served_by,
        (SELECT COALESCE(SUM(quantity), 0) FROM sale_items WHERE sale_id = s.id) AS units
    FROM sales s
    LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN users u ON u.id = s.created_by`;

async function getSale(id) {
  const sale = await row(`${SALE_SELECT} WHERE s.id = ?`, [id]);
  if (!sale) throw new ApiError(404, 'Sale not found');
  sale.items = await q(
    `SELECT i.product_id, p.name AS product_name, p.unit, i.quantity, i.unit_price,
            ROUND(i.quantity * i.unit_price, 2) AS line_total
     FROM sale_items i JOIN products p ON p.id = i.product_id
     WHERE i.sale_id = ? ORDER BY i.id`, [id]);
  return sale;
}

/** Validate a sale payload. Returns { customerId, method, wanted: Map(productId -> quantity) }. */
async function parseSale(body) {
  const items = body.items;
  if (!Array.isArray(items) || items.length === 0) throw new ApiError(400, 'Add at least one product to the sale');
  if (items.length > 100) throw new ApiError(400, 'Too many line items');
  const method = body.payment_method === undefined || body.payment_method === null || body.payment_method === '' ? 'cash' : body.payment_method;
  if (!PAYMENT_METHODS.includes(method)) throw new ApiError(400, 'Invalid payment method');
  let customerId = body.customer_id;
  if (customerId === undefined || customerId === null || customerId === '') {
    customerId = null;
  } else {
    customerId = toInt(customerId, 'customer');
    if ((await scalar('SELECT 1 FROM customers WHERE id = ?', [customerId])) === null) throw new ApiError(400, 'Customer not found');
  }
  const wanted = new Map();
  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new ApiError(400, 'Invalid line item');
    const productId = toInt(item.product_id, 'product');
    const quantity = toInt(item.quantity, 'quantity');
    if (quantity < 1 || quantity > 100000) throw new ApiError(400, 'Quantity must be between 1 and 100000');
    wanted.set(productId, (wanted.get(productId) || 0) + quantity);
  }
  return { customerId, method, wanted };
}

/** Deduct stock for each product. keepPrices keeps the old prices when editing a sale. */
async function takeStock(wanted, keepPrices = new Map()) {
  const lines = [];
  let total = 0;
  for (const [productId, quantity] of wanted) {
    const product = await row('SELECT * FROM products WHERE id = ?', [productId]);
    if (!product) throw new ApiError(400, 'A selected product no longer exists');
    const r = await run('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?', [quantity, productId, quantity]);
    if (r.changes === 0) throw new ApiError(409, `Not enough stock for ${product.name} (available: ${product.stock})`);
    const price = keepPrices.has(productId) ? keepPrices.get(productId) : product.price;
    lines.push([productId, quantity, price]);
    total += quantity * price;
  }
  return { lines, total: money(total) };
}

async function restoreStock(saleId) {
  for (const item of await q('SELECT product_id, quantity FROM sale_items WHERE sale_id = ?', [saleId])) {
    await run('UPDATE products SET stock = stock + ? WHERE id = ?', [item.quantity, item.product_id]);
  }
}

async function insertItems(saleId, lines) {
  for (const [productId, quantity, price] of lines) {
    await run('INSERT INTO sale_items (sale_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)', [saleId, productId, quantity, price]);
  }
}

route('GET', '/sales', async (c) => {
  const clauses = [];
  const params = [];
  if (c.query.from) { clauses.push('DATE(s.created_at) >= ?'); params.push(validDate(c.query.from, 'From date')); }
  if (c.query.to) { clauses.push('DATE(s.created_at) <= ?'); params.push(validDate(c.query.to, 'To date')); }
  if (c.query.customer_id) { clauses.push('s.customer_id = ?'); params.push(toInt(c.query.customer_id, 'customer_id')); }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  return [200, { items: await q(`${SALE_SELECT}${where} ORDER BY s.id DESC LIMIT 500`, params) }];
});

route('GET', '/sales/(\\d+)', async (c, id) => [200, await getSale(Number(id))]);

route('POST', '/sales', async (c) => {
  const { customerId, method, wanted } = await parseSale(c.body);
  const { lines, total } = await takeStock(wanted);
  const r = await run(
    'INSERT INTO sales (customer_id, payment_method, total, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
    [customerId, method, total, c.user.id, now()],
  );
  await insertItems(r.insertId, lines);
  return [201, await getSale(r.insertId)];
});

route('PUT', '/sales/(\\d+)', async (c, idText) => {
  const sale = await getSale(Number(idText));
  if (sale.status === 'void') throw new ApiError(409, 'A void sale cannot be edited');
  const { customerId, method, wanted } = await parseSale(c.body);
  const oldPrices = new Map(sale.items.map((i) => [i.product_id, i.unit_price]));
  await restoreStock(sale.id);
  await run('DELETE FROM sale_items WHERE sale_id = ?', [sale.id]);
  const { lines, total } = await takeStock(wanted, oldPrices); // any failure rolls the whole edit back
  await run('UPDATE sales SET customer_id = ?, payment_method = ?, total = ? WHERE id = ?', [customerId, method, total, sale.id]);
  await insertItems(sale.id, lines);
  return [200, await getSale(sale.id)];
});

route('DELETE', '/sales/(\\d+)', async (c, idText) => {
  const sale = await getSale(Number(idText));
  if (sale.status === 'completed') await restoreStock(sale.id);
  await run('DELETE FROM sales WHERE id = ?', [sale.id]);
  return [200, { ok: true }];
}, 'admin');

route('POST', '/sales/(\\d+)/void', async (c, idText) => {
  const sale = await getSale(Number(idText));
  if (sale.status === 'void') throw new ApiError(409, 'This sale is already void');
  await restoreStock(sale.id);
  await run("UPDATE sales SET status = 'void' WHERE id = ?", [sale.id]);
  return [200, await getSale(sale.id)];
}, 'admin');

// ===========================================================================
// Dashboard
// ===========================================================================
route('GET', '/dashboard', async () => {
  const todayStr = today();
  const salesSince = async (since) => {
    const r = await row(
      `SELECT COALESCE(SUM(total), 0) AS revenue, COUNT(*) AS orders FROM sales
       WHERE status = 'completed' AND DATE(created_at) >= ?`, [since]);
    return { revenue: money(r.revenue), orders: Number(r.orders) };
  };

  const counts = await row(
    `SELECT (SELECT COUNT(*) FROM products) AS products,
            (SELECT COUNT(*) FROM customers) AS customers,
            (SELECT COUNT(*) FROM suppliers) AS suppliers,
            (SELECT COALESCE(SUM(stock), 0) FROM products) AS units_in_stock,
            (SELECT COALESCE(SUM(stock * price), 0) FROM products) AS stock_value`);

  const start = addDays(todayStr, -13);
  const byDay = new Map();
  for (const r of await q(
    `SELECT DATE(created_at) AS day, SUM(total) AS revenue, COUNT(*) AS orders FROM sales
     WHERE status = 'completed' AND DATE(created_at) >= ? GROUP BY DATE(created_at)`, [start])) {
    byDay.set(String(r.day).slice(0, 10), r);
  }
  const daily = [];
  for (let i = 0; i < 14; i++) {
    const day = addDays(start, i);
    const hit = byDay.get(day);
    daily.push({ date: day, revenue: hit ? money(hit.revenue) : 0, orders: hit ? Number(hit.orders) : 0 });
  }

  return [200, {
    counts: { ...counts, stock_value: money(counts.stock_value) },
    today: await salesSince(todayStr),
    month: await salesSince(`${todayStr.slice(0, 7)}-01`),
    all_time: await salesSince('1970-01-01'),
    daily,
    top_products: await q(
      `SELECT p.name, SUM(i.quantity) AS units, ROUND(SUM(i.quantity * i.unit_price), 2) AS revenue
       FROM sale_items i JOIN sales s ON s.id = i.sale_id JOIN products p ON p.id = i.product_id
       WHERE s.status = 'completed' AND DATE(s.created_at) >= ?
       GROUP BY p.id, p.name ORDER BY revenue DESC LIMIT 5`, [addDays(todayStr, -29)]),
    stock_levels: await q('SELECT id, name, stock, low_stock_threshold FROM products ORDER BY name'),
    low_stock: await q(
      `SELECT id, name, unit, stock, low_stock_threshold FROM products
       WHERE stock <= low_stock_threshold ORDER BY stock, name`),
    recent_sales: await q(`${SALE_SELECT} ORDER BY s.id DESC LIMIT 6`),
  }];
});

// ===========================================================================
// Database overview (admin)
// ===========================================================================
route('GET', '/database', async () => [200, await describe()], 'admin');

// ===========================================================================
// Reports (CSV downloads)
// ===========================================================================
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; // stop spreadsheets running formulas
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvOut(filename, header, dataRows) {
  const lines = [header, ...dataRows.map((r) => Object.values(r))].map((cells) => cells.map(csvCell).join(','));
  const body = Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8'); // BOM so Excel reads UTF-8
  return [200, new Raw(body, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${filename}"` })];
}

route('GET', '/reports/(sales|inventory|stock-in|customers)\\.csv', async (c, name) => {
  const stamp = today();
  if (name === 'sales') {
    const clauses = [];
    const params = [];
    if (c.query.from) { clauses.push('DATE(s.created_at) >= ?'); params.push(validDate(c.query.from, 'From date')); }
    if (c.query.to) { clauses.push('DATE(s.created_at) <= ?'); params.push(validDate(c.query.to, 'To date')); }
    const data = await q(
      `SELECT s.id AS sale_id, s.created_at, COALESCE(c.name, 'Walk-in') AS customer, s.payment_method, s.status,
              p.name AS product, i.quantity, i.unit_price, ROUND(i.quantity * i.unit_price, 2) AS line_total, u.username AS served_by
       FROM sales s JOIN sale_items i ON i.sale_id = s.id JOIN products p ON p.id = i.product_id
       LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN users u ON u.id = s.created_by
       ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY s.id, i.id`, params);
    return csvOut(`sales-${stamp}.csv`,
      ['Sale #', 'Date', 'Customer', 'Payment', 'Status', 'Product', 'Qty', 'Unit price', 'Line total', 'Served by'], data);
  }
  if (name === 'inventory') {
    const data = await q(
      `SELECT name, honey_type, unit, price, stock, ROUND(stock * price, 2) AS stock_value, low_stock_threshold,
              CASE WHEN stock <= low_stock_threshold THEN 'LOW' ELSE 'OK' END AS status
       FROM products ORDER BY name`);
    return csvOut(`inventory-${stamp}.csv`,
      ['Product', 'Honey type', 'Unit', 'Price', 'In stock', 'Stock value', 'Low-stock level', 'Status'], data);
  }
  if (name === 'stock-in') {
    const data = await q(
      `SELECT s.created_at, s.batch_code, p.name AS product, COALESCE(sup.name, '') AS supplier, s.quantity, s.cost_per_unit,
              ROUND(s.quantity * s.cost_per_unit, 2) AS total_cost, COALESCE(s.harvest_date, '') AS harvest_date, COALESCE(s.notes, '') AS notes
       FROM stock_in s JOIN products p ON p.id = s.product_id
       LEFT JOIN suppliers sup ON sup.id = s.supplier_id ORDER BY s.id`);
    return csvOut(`stock-in-${stamp}.csv`,
      ['Received', 'Batch', 'Product', 'Supplier', 'Quantity', 'Cost per unit', 'Total cost', 'Harvest date', 'Notes'], data);
  }
  const data = await q(
    `SELECT c.name, c.phone, c.email, COALESCE(c.address, '') AS address, COUNT(s.id) AS orders, COALESCE(SUM(s.total), 0) AS spent
     FROM customers c LEFT JOIN sales s ON s.customer_id = c.id AND s.status = 'completed'
     GROUP BY c.id, c.name, c.phone, c.email, c.address ORDER BY c.name`);
  return csvOut(`customers-${stamp}.csv`, ['Name', 'Phone', 'Email', 'Address', 'Orders', 'Total spent'], data);
});

module.exports = { routes, Raw };

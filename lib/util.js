'use strict';

const crypto = require('node:crypto');
const config = require('../config');

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Dates (always in the timezone from config.js)
// ---------------------------------------------------------------------------
function now() {
  // sv-SE formats as "2026-11-05 22:03:11", which is what the database stores.
  return new Date().toLocaleString('sv-SE', { timeZone: config.timezone });
}

function today() {
  return now().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function validDate(text, label) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new ApiError(400, `${label} must be a date like 2026-11-05`);
  }
  const d = new Date(text + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== text) {
    throw new ApiError(400, `${label} must be a date like 2026-11-05`);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
function toInt(value, label) {
  const bad = () => new ApiError(400, `${label} must be a whole number`);
  if (typeof value === 'boolean' || value === null || value === undefined) throw bad();
  if (typeof value === 'string' && value.trim() === '') throw bad();
  const n = Number(value);
  if (!Number.isFinite(n) || n !== Math.floor(n) || Math.abs(n) > 2147483647) throw bad();
  return n;
}

function toNum(value, label) {
  const bad = () => new ApiError(400, `${label} must be a number`);
  if (typeof value === 'boolean' || value === null || value === undefined) throw bad();
  if (typeof value === 'string' && value.trim() === '') throw bad();
  const n = Number(value);
  if (!Number.isFinite(n)) throw bad();
  return n;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** spec: array of [field, kind ('str'|'int'|'num'), required, default]. */
function validate(spec, data, partial = false) {
  const out = {};
  for (const [name, kind, required, dflt] of spec) {
    const label = name.replace(/_/g, ' ');
    const present = Object.prototype.hasOwnProperty.call(data, name);
    const raw = data[name];
    const missing = raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '');
    if (missing) {
      if (partial && !present) continue;
      if (required) throw new ApiError(400, `${cap(label)} is required`);
      out[name] = dflt;
      continue;
    }
    let value;
    if (kind === 'str') {
      if (typeof raw !== 'string' && typeof raw !== 'number') throw new ApiError(400, `${cap(label)} is not valid`);
      value = String(raw).trim();
      if (value.length > 500) throw new ApiError(400, `${cap(label)} is too long`);
    } else if (kind === 'int') {
      value = toInt(raw, label);
      if (value < 0) throw new ApiError(400, `${cap(label)} cannot be negative`);
    } else {
      value = toNum(raw, label);
      if (value < 0) throw new ApiError(400, `${cap(label)} cannot be negative`);
    }
    out[name] = value;
  }
  return out;
}

const money = (v) => Math.round((Number(v) || 0) * 100) / 100;

// Database drivers may return DECIMAL/SUM values as strings: make them numbers.
const MONEY_KEYS = new Set(['price', 'total', 'unit_price', 'cost_per_unit', 'line_total', 'revenue', 'stock_value', 'spent']);
const INT_KEYS = new Set(['id', 'stock', 'low_stock_threshold', 'quantity', 'units', 'orders', 'product_id',
  'supplier_id', 'customer_id', 'sale_id', 'active', 'units_in_stock', 'products', 'customers', 'suppliers']);

function cleanRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) out[key] = null;
    else if (MONEY_KEYS.has(key)) out[key] = Number(value);
    else if (INT_KEYS.has(key)) out[key] = Number(value);
    else if (typeof value === 'bigint') out[key] = Number(value);
    else out[key] = value;
  }
  return out;
}

function publicUser(u) {
  return { id: Number(u.id), username: u.username, full_name: u.full_name, role: u.role };
}

// ---------------------------------------------------------------------------
// Passwords (scrypt, built into Node: no packages needed)
// ---------------------------------------------------------------------------
const scrypt = (password, salt) => new Promise((resolve, reject) => {
  crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key)));
});

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const expected = Buffer.from(parts[2], 'hex');
    const actual = await scrypt(password, Buffer.from(parts[1], 'hex'));
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

module.exports = {
  ApiError, now, today, addDays, validDate, toInt, toNum, validate, money,
  cleanRow, publicUser, hashPassword, verifyPassword,
};

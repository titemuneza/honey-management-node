'use strict';

/**
 * Database layer. Two drivers share one small interface:
 *   mysql  - MySQL / MariaDB through the "mysql2" package (what XAMPP / phpMyAdmin use)
 *   sqlite - Node's built-in node:sqlite (no server needed; Node 22.5+)
 *
 * Handlers just call q() / row() / scalar() / run(). Inside a write request those calls
 * automatically run in that request's transaction (AsyncLocalStorage), so a failure
 * rolls the whole request back.
 */
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const config = require('../config');
const { cleanRow } = require('./util');

const ROOT = path.join(__dirname, '..');
const scope = new AsyncLocalStorage();
let driver = null;

function plain(row) {
  return cleanRow({ ...row });
}

/** Split a .sql file into statements (comments removed). */
function sqlStatements(file) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/^\s*--.*$/gm, '');
  return text.split(';').map((s) => s.trim()).filter(Boolean);
}

// ===========================================================================
// MySQL / MariaDB
// ===========================================================================
function mysqlDriver() {
  let mysql;
  try {
    mysql = require('mysql2/promise');
  } catch {
    throw new Error('The "mysql2" package is missing. Run:  npm install');
  }
  let pool = null;

  const options = (withDatabase) => ({
    host: config.dbHost,
    port: config.dbPort,
    user: config.dbUser,
    password: config.dbPass,
    ...(withDatabase ? { database: config.dbName } : {}),
    charset: 'UTF8MB4_GENERAL_CI',
    dateStrings: true,        // keep DATE / DATETIME as plain text like 2026-11-05 22:03:11
    supportBigNumbers: true,
    waitForConnections: true,
    connectionLimit: 10,
  });

  const wrapError = (e) => {
    if (e && (e.errno === 1451 || e.errno === 1452 || e.code === 'ER_ROW_IS_REFERENCED_2' || e.code === 'ER_NO_REFERENCED_ROW_2')) e.isConstraint = true;
    if (e && (e.errno === 1146 || e.code === 'ER_NO_SUCH_TABLE')) e.noTable = true;
    return e;
  };

  const exec = async (conn, sql, params) => {
    try {
      const [result] = await conn.query(sql, params);
      if (Array.isArray(result)) return { rows: result.map(plain), insertId: 0, changes: 0 };
      return { rows: [], insertId: Number(result.insertId || 0), changes: Number(result.affectedRows || 0) };
    } catch (e) {
      throw wrapError(e);
    }
  };

  return {
    name: 'mysql',
    async connect() {
      try {
        pool = mysql.createPool(options(true));
        await pool.query('SELECT 1');
      } catch (e) {
        if (pool) await pool.end().catch(() => {});
        if (e.errno === 1049 || e.code === 'ER_BAD_DB_ERROR') {
          // The database does not exist yet: create it, then connect again.
          if (!/^[A-Za-z0-9_]{1,64}$/.test(config.dbName)) {
            throw new Error('DB_NAME may only contain letters, numbers and underscores.');
          }
          const server = await mysql.createConnection(options(false));
          await server.query(`CREATE DATABASE IF NOT EXISTS \`${config.dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
          await server.end();
          pool = mysql.createPool(options(true));
          await pool.query('SELECT 1');
        } else {
          throw e;
        }
      }
    },
    query: (sql, params = []) => exec(pool, sql, params),
    async begin() {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
      } catch (e) {
        conn.release();
        throw e;
      }
      return {
        query: (sql, params = []) => exec(conn, sql, params),
        async commit() { try { await conn.commit(); } finally { conn.release(); } },
        async rollback() { try { await conn.rollback(); } finally { conn.release(); } },
      };
    },
    async createTables() {
      for (const statement of sqlStatements('database.sql')) await pool.query(statement);
    },
    async describe() {
      const schema = config.dbName;
      const { rows: tableRows } = await exec(pool,
        `SELECT TABLE_NAME AS name, COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) AS bytes
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`, [schema]);
      const tables = [];
      let size = 0;
      for (const t of tableRows) {
        size += Number(t.bytes);
        const { rows: cols } = await exec(pool,
          `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, COLUMN_KEY AS ckey, IS_NULLABLE AS nullable
           FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [schema, t.name]);
        const { rows: count } = await exec(pool, `SELECT COUNT(*) AS n FROM \`${String(t.name).replace(/`/g, '``')}\``, []);
        tables.push({
          name: t.name,
          rows: Number(Object.values(count[0])[0]),
          columns: cols.map((c) => ({ name: c.name, type: String(c.type), pk: c.ckey === 'PRI', required: c.nullable === 'NO' })),
        });
      }
      const { rows: version } = await exec(pool, 'SELECT VERSION() AS v', []);
      return { engine: `MySQL/MariaDB ${Object.values(version[0])[0]}`, file: schema, size_bytes: size, tables };
    },
    async close() { if (pool) await pool.end(); },
  };
}

// ===========================================================================
// SQLite (built into Node 22.5+)
// ===========================================================================
function sqliteDriver() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    throw new Error('DB_DRIVER=sqlite needs Node 22.5 or newer. Use the MySQL driver instead, or update Node.');
  }
  let db = null;
  let file = '';

  // One connection: run one request's statements at a time.
  let chain = Promise.resolve();
  const lock = () => {
    let release;
    const next = new Promise((r) => { release = r; });
    const ready = chain.then(() => release);
    chain = chain.then(() => next);
    return ready;
  };

  const exec = (sql, params) => {
    const values = params.map((v) => (typeof v === 'boolean' ? Number(v) : v === undefined ? null : v));
    try {
      const stmt = db.prepare(sql);
      if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql)) {
        return { rows: stmt.all(...values).map(plain), insertId: 0, changes: 0 };
      }
      const r = stmt.run(...values);
      return { rows: [], insertId: Number(r.lastInsertRowid || 0), changes: Number(r.changes || 0) };
    } catch (e) {
      if (/FOREIGN KEY constraint failed/i.test(e.message)) e.isConstraint = true;
      if (/no such table/i.test(e.message)) e.noTable = true;
      throw e;
    }
  };

  return {
    name: 'sqlite',
    async connect() {
      file = path.resolve(ROOT, config.sqliteFile);
      db = new DatabaseSync(file === path.resolve(ROOT, ':memory:') ? ':memory:' : file);
      db.exec('PRAGMA foreign_keys = ON');
    },
    async query(sql, params = []) {
      const release = await lock();
      try { return exec(sql, params); } finally { release(); }
    },
    async begin() {
      const release = await lock();
      try {
        db.exec('BEGIN');
      } catch (e) {
        release();
        throw e;
      }
      return {
        query: async (sql, params = []) => exec(sql, params),
        async commit() { try { db.exec('COMMIT'); } finally { release(); } },
        async rollback() { try { db.exec('ROLLBACK'); } finally { release(); } },
      };
    },
    async createTables() {
      for (const statement of sqlStatements('database.sqlite.sql')) db.exec(statement);
    },
    async describe() {
      const tables = [];
      const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      for (const { name } of names) {
        const cols = db.prepare(`PRAGMA table_info("${name}")`).all();
        const count = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get();
        tables.push({
          name,
          rows: Number(count.n),
          columns: cols.map((c) => ({ name: c.name, type: c.type, pk: Boolean(c.pk), required: Boolean(c.notnull) })),
        });
      }
      let size = 0;
      try { size = fs.statSync(file).size; } catch { /* in-memory */ }
      const { v } = db.prepare('SELECT sqlite_version() AS v').get();
      return { engine: `SQLite ${v}`, file: path.basename(file), size_bytes: size, tables };
    },
    async close() { if (db) db.close(); },
  };
}

// ===========================================================================
// Public helpers
// ===========================================================================
async function connect() {
  driver = config.dbDriver === 'sqlite' ? sqliteDriver() : mysqlDriver();
  await driver.connect();
}

const current = () => scope.getStore() || driver;

/** Run a statement; returns { rows, insertId, changes }. */
const run = (sql, params = []) => current().query(sql, params);
/** Run a SELECT; returns all rows. */
const q = async (sql, params = []) => (await run(sql, params)).rows;
const rows = q;
/** First row or null. */
const row = async (sql, params = []) => (await q(sql, params))[0] || null;
/** First column of the first row, or null. */
const scalar = async (sql, params = []) => {
  const r = await row(sql, params);
  return r ? Object.values(r)[0] : null;
};

/** Run fn inside a transaction; commit on success, roll back on any error. */
async function transaction(fn) {
  const tx = await driver.begin();
  try {
    const result = await scope.run(tx, fn);
    await tx.commit();
    return result;
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  }
}

const tablesExist = async () => {
  try {
    await driver.query('SELECT COUNT(*) FROM users');
    return true;
  } catch (e) {
    if (e.noTable) return false;
    throw e;
  }
};

module.exports = {
  connect, run, q, rows, row, scalar, transaction, tablesExist,
  createTables: () => driver.createTables(),
  describe: () => driver.describe(),
  close: () => (driver ? driver.close() : undefined),
  driverName: () => (driver ? driver.name : config.dbDriver),
};

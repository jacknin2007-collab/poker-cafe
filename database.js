// PostgreSQL-backed database with a uniform async API.
//
//   Production : real PostgreSQL via DATABASE_URL  (e.g. Render PostgreSQL — data persists)
//   Local dev  : embedded PGlite (PostgreSQL in WASM) persisted to ./pgdata
//
// Both speak the same PostgreSQL dialect, so anything that works locally works in production.
// The API mimics the old better-sqlite3 shape (db.prepare(sql).get/all/run) but is async,
// so callers must `await`.  `?` placeholders are auto-converted to $1,$2,...

const USE_PG = !!process.env.DATABASE_URL;

let backend = null; // { query(sql, params) -> { rows, rowCount } }

async function makeBackend() {
  if (USE_PG) {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
    return { query: (sql, params) => pool.query(sql, params) };
  }
  // Local: embedded Postgres (no system install needed), persisted to disk.
  const { PGlite } = require('@electric-sql/pglite');
  const pg = new PGlite('./pgdata');
  await pg.waitReady;
  return {
    query: async (sql, params) => {
      const r = await pg.query(sql, params || []);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
  };
}

// Convert SQLite-style "?" placeholders to PostgreSQL "$1, $2, ..."
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

let readyPromise = null;
function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      backend = await makeBackend();
      await initSchema();
    })();
  }
  return readyPromise;
}

async function q(sql, params) {
  await ready();
  return backend.query(toPg(sql), params);
}

const db = {
  prepare(sql) {
    return {
      get: async (...p) => (await q(sql, p)).rows[0],
      all: async (...p) => (await q(sql, p)).rows,
      run: async (...p) => {
        const r = await q(sql, p);
        return { changes: r.rowCount, lastInsertRowid: r.rows[0]?.id };
      },
    };
  },
  exec: async (sql) => {
    await ready();
    return backend.query(sql);
  },
  ready,
};

async function initSchema() {
  // backend.query directly (NOT q) to avoid re-entering ready()
  const run = (sql) => backend.query(sql);

  await run(`CREATE TABLE IF NOT EXISTS customers (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    top1 INTEGER DEFAULT 0,
    top2 INTEGER DEFAULT 0,
    top3 INTEGER DEFAULT 0,
    rounds INTEGER DEFAULT 0,
    drinks INTEGER DEFAULT 0,
    created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
    last_top_increase TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
  )`);

  await run(`CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    payer TEXT,
    phone TEXT,
    amount INTEGER,
    table_name TEXT,
    note TEXT,
    created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
  )`);

  await run(`CREATE TABLE IF NOT EXISTS stock (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    qty INTEGER DEFAULT 0,
    price INTEGER DEFAULT 0,
    consumed INTEGER DEFAULT 0,
    cost INTEGER DEFAULT 1
  )`);

  await run(`CREATE TABLE IF NOT EXISTS tour_buyin (
    id SERIAL PRIMARY KEY,
    phone TEXT NOT NULL,
    date TEXT NOT NULL,
    UNIQUE(phone, date)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS tournament_buyin (
    id SERIAL PRIMARY KEY,
    customer_phone TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    date TEXT NOT NULL,
    is_rebuy INTEGER DEFAULT 0,
    created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
  )`);

  await run(`CREATE TABLE IF NOT EXISTS daily_consumed (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    date TEXT NOT NULL,
    qty INTEGER DEFAULT 1,
    UNIQUE(name, date)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS staff_members (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL DEFAULT '123456',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS staff_sessions (
    id SERIAL PRIMARY KEY,
    staff_name TEXT NOT NULL,
    app_name TEXT NOT NULL,
    login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    logout_time TIMESTAMP
  )`);

  // Idempotent migrations for older databases
  try { await run(`ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS password TEXT NOT NULL DEFAULT '123456'`); } catch (e) {}
  try { await run(`ALTER TABLE stock ADD COLUMN IF NOT EXISTS cost INTEGER DEFAULT 1`); } catch (e) {}
}

module.exports = db;

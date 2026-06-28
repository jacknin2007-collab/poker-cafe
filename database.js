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
    // QUAN TRỌNG: bắt lỗi của client nhàn rỗi (DB restart / mất kết nối) để
    // KHÔNG làm sập tiến trình ("Exited with status 1"). Pool tự tạo kết nối mới.
    pool.on('error', (err) => {
      console.error('[DB] Lỗi kết nối nhàn rỗi (đã bỏ qua, pool sẽ tự kết nối lại):', err.message);
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

  // App khách hàng: nội dung chung admin chỉnh (banner, thông báo) - mọi khách thấy
  await run(`CREATE TABLE IF NOT EXISTS app_content (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  )`);

  // App khách hàng: ảnh carousel trang chủ (lưu base64 trong DB cho bền)
  await run(`CREATE TABLE IF NOT EXISTS banner_images (
    id SERIAL PRIMARY KEY,
    image TEXT NOT NULL,
    caption TEXT NOT NULL DEFAULT '',
    top1 TEXT DEFAULT '',
    top2 TEXT DEFAULT '',
    top3 TEXT DEFAULT '',
    top4 TEXT DEFAULT '',
    top5 TEXT DEFAULT '',
    top6 TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  // App khách hàng: thông báo gửi tới khách (hiện ở chuông)
  await run(`CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    message TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  // App khách hàng: lịch thi đấu (admin đăng, khách xem T2..CN)
  await run(`CREATE TABLE IF NOT EXISTS schedules (
    id SERIAL PRIMARY KEY,
    weekday INTEGER NOT NULL,
    title TEXT NOT NULL,
    time_text TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  // App khách hàng: lịch sử được trao top (top mấy, +bao nhiêu bounty, khi nào)
  await run(`CREATE TABLE IF NOT EXISTS match_history (
    id SERIAL PRIMARY KEY,
    phone TEXT NOT NULL,
    top_rank INTEGER NOT NULL,
    points INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  // Track notification read status per customer
  await run(`CREATE TABLE IF NOT EXISTS notification_reads (
    id SERIAL PRIMARY KEY,
    notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    phone TEXT NOT NULL,
    is_read BOOLEAN DEFAULT FALSE,
    read_at TIMESTAMP,
    UNIQUE(notification_id, phone)
  )`);

  // Idempotent migrations for older databases
  try { await run(`ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS password TEXT NOT NULL DEFAULT '123456'`); } catch (e) {}
  try { await run(`ALTER TABLE stock ADD COLUMN IF NOT EXISTS cost INTEGER DEFAULT 1`); } catch (e) {}
  // App khách hàng: thêm mật khẩu đăng nhập + quyền admin cho khách
  // Mặc định mật khẩu RỖNG -> khách chưa đăng nhập được cho tới khi admin đặt mật khẩu.
  try { await run(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS password TEXT NOT NULL DEFAULT ''`); } catch (e) {}
  try { await run(`ALTER TABLE customers ALTER COLUMN password SET DEFAULT ''`); } catch (e) {}
  try { await run(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE`); } catch (e) {}
  try { await run(`ALTER TABLE banner_images ADD COLUMN IF NOT EXISTS caption TEXT NOT NULL DEFAULT ''`); } catch (e) {}
  try { await run(`ALTER TABLE banner_images ADD COLUMN IF NOT EXISTS top1 TEXT DEFAULT ''`); } catch (e) {}
  try { await run(`ALTER TABLE banner_images ADD COLUMN IF NOT EXISTS top2 TEXT DEFAULT ''`); } catch (e) {}
  try { await run(`ALTER TABLE banner_images ADD COLUMN IF NOT EXISTS top3 TEXT DEFAULT ''`); } catch (e) {}
  try { await run(`ALTER TABLE banner_images ADD COLUMN IF NOT EXISTS top4 TEXT DEFAULT ''`); } catch (e) {}
  try { await run(`ALTER TABLE banner_images ADD COLUMN IF NOT EXISTS top5 TEXT DEFAULT ''`); } catch (e) {}
  try { await run(`ALTER TABLE banner_images ADD COLUMN IF NOT EXISTS top6 TEXT DEFAULT ''`); } catch (e) {}
  try { await run(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT ''`); } catch (e) {}
  try { await run(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS avatar TEXT NOT NULL DEFAULT ''`); } catch (e) {}
}

module.exports = db;

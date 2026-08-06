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

  // Rankings: Season (S1: 1/1-6/30, S2: 7/1-12/31) và Monthly (1-12)
  await run(`CREATE TABLE IF NOT EXISTS rankings (
    id SERIAL PRIMARY KEY,
    phone TEXT NOT NULL,
    period_type TEXT NOT NULL,
    period_value TEXT NOT NULL,
    rank_position INTEGER,
    stars INTEGER DEFAULT 0,
    top1_count INTEGER DEFAULT 0,
    top2_count INTEGER DEFAULT 0,
    top3_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(phone, period_type, period_value)
  )`);

  // Performance stats: ITM%, win rate, buy/tour ratio (cache để query nhanh)
  await run(`CREATE TABLE IF NOT EXISTS performance_stats (
    phone TEXT PRIMARY KEY,
    total_matches INTEGER DEFAULT 0,
    top1_count INTEGER DEFAULT 0,
    top2_count INTEGER DEFAULT 0,
    top3_count INTEGER DEFAULT 0,
    itm_percentage NUMERIC(5,2) DEFAULT 0,
    win_rate NUMERIC(5,2) DEFAULT 0,
    tournament_count INTEGER DEFAULT 0,
    buyin_count INTEGER DEFAULT 0,
    buy_tour_ratio NUMERIC(5,2) DEFAULT 0,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  // Tournaments: Lưu chi tiết mỗi tournament
  await run(`CREATE TABLE IF NOT EXISTS tournaments (
    id SERIAL PRIMARY KEY,
    date TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT 'Tournament',
    prize_pool INTEGER DEFAULT 0,
    total_players INTEGER DEFAULT 0,
    buy_in INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  // Tournament results: Top 6 kết quả của mỗi tournament
  await run(`CREATE TABLE IF NOT EXISTS tournament_results (
    id SERIAL PRIMARY KEY,
    tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    phone TEXT NOT NULL,
    customer_name TEXT DEFAULT '',
    rank_position INTEGER NOT NULL,
    prize_won INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tournament_id, phone)
  )`);

  // Rewards: Free Drinks, Free Rounds (admin nhập thủ công)
  await run(`CREATE TABLE IF NOT EXISTS rewards (
    id SERIAL PRIMARY KEY,
    phone TEXT NOT NULL,
    type TEXT NOT NULL,
    quantity INTEGER DEFAULT 1,
    note TEXT DEFAULT '',
    used_quantity INTEGER DEFAULT 0,
    used_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
  try { await run(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS star_penalty INTEGER DEFAULT 0`); } catch (e) {}

  // Migration: Convert old match history points (30/20/10) to new stars (5/3/1)
  try {
    await run(`UPDATE match_history SET points = 5 WHERE points = 30`);
    await run(`UPDATE match_history SET points = 3 WHERE points = 20`);
    await run(`UPDATE match_history SET points = 1 WHERE points = 10`);
    console.log('✓ Converted old match history points to new star system');
  } catch (e) {
    // Silently fail if table doesn't exist or already converted
  }

  // Add match_type column to track gain/lose
  try {
    await run(`ALTER TABLE match_history ADD COLUMN IF NOT EXISTS match_type TEXT DEFAULT 'gain'`);
    console.log('✓ Added match_type column to match_history');
  } catch (e) {
    // Column already exists
  }

}

module.exports = db;

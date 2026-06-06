const Database = require('better-sqlite3');
const db = new Database('poker.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    top1 INTEGER DEFAULT 0,
    top2 INTEGER DEFAULT 0,
    top3 INTEGER DEFAULT 0,
    rounds INTEGER DEFAULT 0,
    drinks INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    last_top_increase TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payer TEXT,
    phone TEXT,
    amount INTEGER,
    table_name TEXT,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS stock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    qty INTEGER DEFAULT 0,
    price INTEGER DEFAULT 0,
    consumed INTEGER DEFAULT 0,
    cost INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS tour_buyin (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    date TEXT NOT NULL,
    UNIQUE(phone, date)
  );
  CREATE TABLE IF NOT EXISTS tournament_buyin (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_phone TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    date TEXT NOT NULL,
    is_rebuy INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

module.exports = db;

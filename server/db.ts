import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type SqliteDatabase = Database.Database;

interface Migration {
  id: string;
  sql: string;
}

const migrations: Migration[] = [
  {
    id: "001_create_app_settings",
    sql: `
      CREATE TABLE app_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        bithumb_test_market TEXT NOT NULL,
        bithumb_candle_unit INTEGER NOT NULL,
        bithumb_candle_count INTEGER NOT NULL,
        updated_at TEXT
      );
    `
  },
  {
    id: "002_create_trading_persistence",
    sql: `
      CREATE TABLE strategies (
        id TEXT PRIMARY KEY,
        market TEXT NOT NULL,
        upper_price REAL NOT NULL,
        lower_price REAL NOT NULL,
        slot_count INTEGER NOT NULL,
        total_budget REAL NOT NULL,
        slot_budget REAL NOT NULL,
        target_profit_rate REAL NOT NULL,
        fee_rate REAL NOT NULL DEFAULT 0,
        slippage_rate REAL NOT NULL DEFAULT 0,
        mode TEXT NOT NULL CHECK (mode IN ('PAPER', 'LIVE')),
        status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED', 'STOPPED')),
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        activated_at TEXT,
        stopped_at TEXT,
        CHECK (upper_price > lower_price),
        CHECK (slot_count > 0),
        CHECK (total_budget > 0),
        CHECK (slot_budget > 0),
        CHECK (target_profit_rate >= 0),
        CHECK (fee_rate >= 0),
        CHECK (slippage_rate >= 0)
      );

      CREATE TABLE slots (
        id TEXT PRIMARY KEY,
        strategy_id TEXT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
        slot_number INTEGER NOT NULL,
        buy_price REAL NOT NULL,
        target_sell_price REAL NOT NULL,
        budget REAL NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('EMPTY', 'HOLDING', 'BUY_PENDING', 'SELL_PENDING', 'PAUSED')),
        entry_price REAL,
        quantity REAL NOT NULL DEFAULT 0,
        entry_gross_amount REAL NOT NULL DEFAULT 0,
        entry_fee REAL NOT NULL DEFAULT 0,
        current_order_id TEXT,
        last_buy_at TEXT,
        last_sell_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (strategy_id, slot_number),
        CHECK (slot_number > 0),
        CHECK (buy_price > 0),
        CHECK (target_sell_price > 0),
        CHECK (budget > 0),
        CHECK (quantity >= 0),
        CHECK (entry_gross_amount >= 0),
        CHECK (entry_fee >= 0)
      );

      CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        strategy_id TEXT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
        slot_id TEXT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
        broker_order_id TEXT UNIQUE,
        client_order_id TEXT NOT NULL UNIQUE,
        market TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
        order_type TEXT NOT NULL,
        price REAL,
        quantity REAL,
        amount REAL,
        status TEXT NOT NULL CHECK (status IN ('REQUESTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'FAILED', 'UNKNOWN')),
        requested_at TEXT NOT NULL,
        accepted_at TEXT,
        updated_at TEXT NOT NULL,
        raw_request_json TEXT,
        raw_response_json TEXT,
        error_message TEXT,
        CHECK (price IS NULL OR price > 0),
        CHECK (quantity IS NULL OR quantity > 0),
        CHECK (amount IS NULL OR amount > 0)
      );

      CREATE TABLE fills (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        strategy_id TEXT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
        slot_id TEXT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
        broker_fill_id TEXT UNIQUE,
        price REAL NOT NULL,
        quantity REAL NOT NULL,
        fee REAL NOT NULL DEFAULT 0,
        tax REAL NOT NULL DEFAULT 0,
        filled_at TEXT NOT NULL,
        raw_response_json TEXT,
        created_at TEXT NOT NULL,
        CHECK (price > 0),
        CHECK (quantity > 0),
        CHECK (fee >= 0),
        CHECK (tax >= 0)
      );

      CREATE TABLE decision_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        strategy_id TEXT REFERENCES strategies(id) ON DELETE SET NULL,
        slot_id TEXT REFERENCES slots(id) ON DELETE SET NULL,
        order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
        market TEXT,
        current_price REAL,
        action TEXT NOT NULL CHECK (action IN ('BUY', 'SELL', 'HOLD', 'PAUSE', 'ERROR', 'RECOVER')),
        reason TEXT NOT NULL,
        snapshot_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        CHECK (current_price IS NULL OR current_price > 0)
      );

      CREATE TABLE runner_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        status TEXT NOT NULL CHECK (status IN ('RUNNING', 'PAUSED', 'RECOVERING', 'STOPPED')),
        active_strategy_id TEXT REFERENCES strategies(id) ON DELETE SET NULL,
        auto_trading_enabled INTEGER NOT NULL DEFAULT 0 CHECK (auto_trading_enabled IN (0, 1)),
        kill_switch_enabled INTEGER NOT NULL DEFAULT 0 CHECK (kill_switch_enabled IN (0, 1)),
        heartbeat_at TEXT,
        last_tick_at TEXT,
        last_market_poll_at TEXT,
        last_order_sync_at TEXT,
        last_reconcile_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_strategies_status ON strategies(status);
      CREATE INDEX idx_slots_strategy_status ON slots(strategy_id, status);
      CREATE INDEX idx_orders_strategy_status ON orders(strategy_id, status);
      CREATE INDEX idx_orders_client_order_id ON orders(client_order_id);
      CREATE INDEX idx_fills_order_id ON fills(order_id);
      CREATE INDEX idx_decision_logs_strategy_created_at ON decision_logs(strategy_id, created_at);
      CREATE INDEX idx_decision_logs_created_at ON decision_logs(created_at);

      INSERT INTO runner_state (
        id,
        status,
        auto_trading_enabled,
        kill_switch_enabled,
        updated_at
      )
      VALUES (
        1,
        'STOPPED',
        0,
        0,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );
    `
  }
];

export function openDatabase(filePath: string): SqliteDatabase {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  initializeDatabase(db);
  return db;
}

export function initializeDatabase(db: SqliteDatabase): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  runMigrations(db);
}

function runMigrations(db: SqliteDatabase): void {
  const hasMigration = db.prepare("SELECT 1 FROM _migrations WHERE id = ?").pluck();
  const recordMigration = db.prepare("INSERT INTO _migrations (id, applied_at) VALUES (?, ?)");
  const applyMigration = db.transaction((migration: Migration) => {
    db.exec(migration.sql);
    recordMigration.run(migration.id, new Date().toISOString());
  });

  for (const migration of migrations) {
    if (hasMigration.get(migration.id)) {
      continue;
    }

    applyMigration(migration);
  }
}

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

import fs from "node:fs/promises";
import { defaultAppSettings, normalizeAppSettings } from "../src/shared/settings";
import type { AppSettings } from "../src/shared/settings";
import type { SqliteDatabase } from "./db";

export const settingsStorage = "sqlite" as const;

const appSettingsId = 1;

interface AppSettingsRow {
  bithumb_test_market: string;
  bithumb_candle_unit: number;
  bithumb_candle_count: number;
  updated_at: string | null;
}

export async function seedAppSettingsIfMissing(db: SqliteDatabase, legacySettingsFilePath: string): Promise<AppSettings> {
  const existing = getAppSettingsRow(db);
  if (existing) {
    return rowToAppSettings(existing);
  }

  const seed = await readLegacySettings(legacySettingsFilePath);
  return saveAppSettings(db, seed);
}

export function getAppSettings(db: SqliteDatabase): AppSettings {
  const row = getAppSettingsRow(db);
  return row ? rowToAppSettings(row) : defaultAppSettings;
}

export function saveAppSettings(db: SqliteDatabase, value: unknown): AppSettings {
  const settings = normalizeAppSettings(value);
  const write = db.transaction((nextSettings: AppSettings) => {
    db.prepare(`
      INSERT INTO app_settings (
        id,
        bithumb_test_market,
        bithumb_candle_unit,
        bithumb_candle_count,
        updated_at
      )
      VALUES (@id, @testMarket, @candleUnit, @candleCount, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        bithumb_test_market = excluded.bithumb_test_market,
        bithumb_candle_unit = excluded.bithumb_candle_unit,
        bithumb_candle_count = excluded.bithumb_candle_count,
        updated_at = excluded.updated_at
    `).run({
      id: appSettingsId,
      testMarket: nextSettings.bithumb.testMarket,
      candleUnit: nextSettings.bithumb.candleUnit,
      candleCount: nextSettings.bithumb.candleCount,
      updatedAt: nextSettings.updatedAt ?? null
    });
  });

  write(settings);
  return settings;
}

function getAppSettingsRow(db: SqliteDatabase): AppSettingsRow | undefined {
  return db.prepare("SELECT bithumb_test_market, bithumb_candle_unit, bithumb_candle_count, updated_at FROM app_settings WHERE id = ?")
    .get(appSettingsId) as AppSettingsRow | undefined;
}

async function readLegacySettings(filePath: string): Promise<AppSettings> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return normalizeAppSettings(JSON.parse(content) as unknown);
  } catch {
    return defaultAppSettings;
  }
}

function rowToAppSettings(row: AppSettingsRow): AppSettings {
  return normalizeAppSettings({
    bithumb: {
      testMarket: row.bithumb_test_market,
      candleUnit: row.bithumb_candle_unit,
      candleCount: row.bithumb_candle_count
    },
    updatedAt: row.updated_at ?? undefined
  });
}

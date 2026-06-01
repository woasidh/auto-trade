import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "./db";
import { getAppSettings, saveAppSettings, seedAppSettingsIfMissing } from "./settingsRepository";
import { defaultAppSettings } from "../src/shared/settings";
import type { SqliteDatabase } from "./db";

const cleanupCallbacks: Array<() => void> = [];

afterEach(() => {
  while (cleanupCallbacks.length > 0) {
    cleanupCallbacks.pop()?.();
  }
});

describe("settingsRepository", () => {
  it("seeds default settings when the database is empty and no legacy file exists", async () => {
    const { db, legacyPath } = createTestContext();

    await seedAppSettingsIfMissing(db, legacyPath);

    expect(getAppSettings(db)).toEqual(defaultAppSettings);
  });

  it("imports the legacy JSON settings into an empty database", async () => {
    const { db, legacyPath } = createTestContext();
    writeLegacySettings(legacyPath, {
      bithumb: {
        testMarket: "KRW-ETH",
        candleUnit: 3,
        candleCount: 50
      },
      updatedAt: "2026-05-30T12:00:00.000Z"
    });

    await seedAppSettingsIfMissing(db, legacyPath);

    expect(getAppSettings(db)).toEqual({
      bithumb: {
        testMarket: "KRW-ETH",
        candleUnit: 3,
        candleCount: 50
      },
      updatedAt: "2026-05-30T12:00:00.000Z"
    });
  });

  it("persists saved settings and reads them back", async () => {
    const { db } = createTestContext();

    const saved = saveAppSettings(db, {
      bithumb: {
        testMarket: "KRW-XRP",
        candleUnit: 5,
        candleCount: 120
      },
      updatedAt: "2026-05-31T01:00:00.000Z"
    });

    expect(saved).toEqual(getAppSettings(db));
  });

  it("normalizes invalid settings before saving them", () => {
    const { db } = createTestContext();

    const saved = saveAppSettings(db, {
      bithumb: {
        testMarket: "not-a-market",
        candleUnit: 999,
        candleCount: 999
      }
    });

    expect(saved).toEqual({
      bithumb: {
        testMarket: defaultAppSettings.bithumb.testMarket,
        candleUnit: defaultAppSettings.bithumb.candleUnit,
        candleCount: 200
      },
      updatedAt: undefined
    });
    expect(getAppSettings(db)).toEqual(saved);
  });

  it("does not overwrite existing database settings from the legacy file", async () => {
    const { db, legacyPath } = createTestContext();
    saveAppSettings(db, {
      bithumb: {
        testMarket: "KRW-SOL",
        candleUnit: 10,
        candleCount: 80
      }
    });
    writeLegacySettings(legacyPath, {
      bithumb: {
        testMarket: "KRW-DOGE",
        candleUnit: 30,
        candleCount: 10
      }
    });

    await seedAppSettingsIfMissing(db, legacyPath);

    expect(getAppSettings(db).bithumb).toEqual({
      testMarket: "KRW-SOL",
      candleUnit: 10,
      candleCount: 80
    });
  });
});

function createTestContext(): { db: SqliteDatabase; legacyPath: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "slice-trade-settings-"));
  const db = openDatabase(path.join(dir, "test.sqlite"));

  cleanupCallbacks.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    db,
    legacyPath: path.join(dir, "settings", "app-settings.json")
  };
}

function writeLegacySettings(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

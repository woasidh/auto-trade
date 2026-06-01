import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "./db";
import { TradingRunner } from "./tradingRunner";
import { getRunnerState, getTradingPersistenceSnapshot, saveStrategy } from "./tradingRepository";
import type { SqliteDatabase } from "./db";

const cleanupCallbacks: Array<() => void> = [];

afterEach(() => {
  while (cleanupCallbacks.length > 0) {
    cleanupCallbacks.pop()?.();
  }
});

describe("TradingRunner", () => {
  it("creates a PAPER strategy with slots and executes paper buys on start", async () => {
    const db = createTestDatabase();
    const runner = new TradingRunner(db, async () => 103, 60_000);

    const created = runner.createPaperStrategy({
      id: "strategy-1",
      market: "KRW-BTC",
      upperPrice: 107,
      lowerPrice: 101,
      slotCount: 7,
      totalBudget: 700_000,
      targetProfitRate: 0.01,
      feeRate: 0.0004
    });

    expect(created.strategies[0]).toMatchObject({ mode: "PAPER", status: "PAUSED" });
    expect(created.slots).toHaveLength(7);

    const started = await runner.start("strategy-1");

    expect(started.runnerState).toMatchObject({ status: "RUNNING", autoTradingEnabled: true });
    expect(started.slots.filter((slot) => slot.status === "HOLDING")).toHaveLength(5);
    expect(started.orders.filter((order) => order.side === "BUY" && order.status === "FILLED")).toHaveLength(5);
    expect(started.fills).toHaveLength(5);

    runner.pause();
  });

  it("recovers and resumes when server restarts with auto trading enabled", async () => {
    const db = createTestDatabase();
    const firstRunner = new TradingRunner(db, async () => 103, 60_000);
    firstRunner.createPaperStrategy({
      id: "strategy-1",
      market: "KRW-BTC",
      upperPrice: 107,
      lowerPrice: 101,
      slotCount: 7,
      totalBudget: 700_000,
      targetProfitRate: 0.01
    });
    await firstRunner.start("strategy-1");
    const secondRunner = new TradingRunner(db, async () => 120, 60_000);

    const recovered = await secondRunner.recover();

    expect(recovered.runnerState).toMatchObject({ status: "RUNNING", autoTradingEnabled: true });
    expect(recovered.orders.some((order) => order.side === "SELL")).toBe(true);

    secondRunner.pause();
  });

  it("refuses to start LIVE strategies", async () => {
    const db = createTestDatabase();
    const runner = new TradingRunner(db, async () => 100, 60_000);
    saveStrategy(db, {
      id: "live-strategy",
      market: "KRW-BTC",
      upperPrice: 107,
      lowerPrice: 101,
      slotCount: 7,
      totalBudget: 700_000,
      targetProfitRate: 0.01,
      mode: "LIVE",
      status: "PAUSED"
    });

    await expect(runner.start("live-strategy")).rejects.toThrow("LIVE strategy execution is disabled");
    expect(getRunnerState(db)).toMatchObject({ status: "STOPPED", autoTradingEnabled: false });
  });

  it("pauses and records errors when price polling fails", async () => {
    const db = createTestDatabase();
    const runner = new TradingRunner(
      db,
      async () => {
        throw new Error("ticker unavailable");
      },
      60_000
    );
    runner.createPaperStrategy({
      id: "strategy-1",
      market: "KRW-BTC",
      upperPrice: 107,
      lowerPrice: 101,
      slotCount: 7,
      totalBudget: 700_000,
      targetProfitRate: 0.01
    });

    await expect(runner.start("strategy-1")).rejects.toThrow("ticker unavailable");

    const snapshot = getTradingPersistenceSnapshot(db);
    expect(snapshot.runnerState).toMatchObject({
      status: "PAUSED",
      autoTradingEnabled: false,
      lastError: "ticker unavailable"
    });
    expect(snapshot.decisionLogs[0]).toMatchObject({ action: "ERROR", reason: "ticker unavailable" });
  });
});

function createTestDatabase(): SqliteDatabase {
  const dir = mkdtempSync(path.join(os.tmpdir(), "slice-trade-runner-"));
  const db = openDatabase(path.join(dir, "test.sqlite"));

  cleanupCallbacks.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return db;
}

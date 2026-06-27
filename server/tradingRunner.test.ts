import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "./db";
import { TradingRunner } from "./tradingRunner";
import { getRunnerState, getTradingPersistenceSnapshot, saveStrategy } from "./tradingRepository";
import type { SqliteDatabase } from "./db";
import type { TradingBroker } from "./tradingBroker";

const cleanupCallbacks: Array<() => void> = [];

afterEach(() => {
  vi.useRealTimers();
  while (cleanupCallbacks.length > 0) {
    cleanupCallbacks.pop()?.();
  }
});

describe("TradingRunner", () => {
  it("keeps PAPER buy limits resting and syncs fills when price reaches them", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    const db = createTestDatabase();
    let price = 108;
    const runner = new TradingRunner(db, async () => price, 60_000);

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
    expect(started.slots.filter((slot) => slot.status === "BUY_PENDING")).toHaveLength(7);
    expect(started.orders.filter((order) => order.side === "BUY" && order.status === "ACCEPTED")).toHaveLength(7);
    expect(started.orders[0].rawRequest).toMatchObject({ mode: "PAPER_STAGE", endpoint: "/v2/orders" });
    expect(started.orders[0].rawResponse).toMatchObject({ mode: "PAPER_STAGE", state: "wait" });
    expect(started.fills).toHaveLength(0);

    const logCountBeforeRestingTick = started.decisionLogs.length;
    price = 107.5;
    vi.setSystemTime(new Date("2026-06-01T00:00:05.000Z"));
    const resting = await runner.tick();

    expect(resting.orders.filter((order) => order.side === "BUY" && order.status === "ACCEPTED")).toHaveLength(7);
    expect(resting.fills).toHaveLength(0);
    expect(resting.decisionLogs).toHaveLength(logCountBeforeRestingTick);
    expect(resting.decisionLogs.some((log) => log.reason === "no broker order sync or replenishment was needed")).toBe(false);

    price = 104;
    vi.setSystemTime(new Date("2026-06-01T00:00:10.000Z"));
    const filled = await runner.tick();

    expect(filled.slots.filter((slot) => slot.status === "SELL_PENDING")).toHaveLength(4);
    expect(filled.slots.filter((slot) => slot.status === "BUY_PENDING")).toHaveLength(3);
    expect(filled.orders.filter((order) => order.side === "BUY" && order.status === "FILLED")).toHaveLength(4);
    expect(filled.orders.filter((order) => order.side === "SELL" && order.status === "ACCEPTED")).toHaveLength(4);
    expect(filled.fills).toHaveLength(4);
    expect(filled.slots.find((slot) => slot.slotNumber === 4)?.entryPrice).toBe(104);
    expect(filled.orders.find((order) => order.side === "BUY" && order.status === "FILLED")?.rawResponse).toMatchObject({ state: "done" });

    runner.pause();
  });

  it("creates PAPER slots from a price interval", () => {
    const db = createTestDatabase();
    const runner = new TradingRunner(db, async () => 1468, 60_000);

    const created = runner.createPaperStrategy({
      id: "strategy-interval",
      market: "KRW-USDT",
      upperPrice: 1480,
      lowerPrice: 1460,
      slotCount: 8,
      totalBudget: 800_000,
      slotBudget: 100_000,
      slotPriceOffset: 3,
      targetProfitPriceUnit: 3,
      targetProfitRate: 0.005,
      feeRate: 0.0004
    });

    expect(created.strategies[0].config).toMatchObject({ slotPriceOffset: 3, targetProfitPriceUnit: 3 });
    expect(created.slots.map((slot) => slot.buyPrice)).toEqual([1480, 1477, 1474, 1471, 1468, 1465, 1462, 1460]);
    expect(created.slots.map((slot) => slot.targetSellPrice)).toEqual([1483, 1480, 1477, 1474, 1471, 1468, 1465, 1463]);
  });

  it("fills PAPER sells and replenishes the next buy limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    const db = createTestDatabase();
    let price = 101;
    const runner = new TradingRunner(db, async () => price, 60_000);

    runner.createPaperStrategy({
      id: "strategy-1",
      market: "KRW-BTC",
      upperPrice: 100,
      lowerPrice: 99,
      slotCount: 2,
      totalBudget: 200_000,
      targetProfitRate: 0.01,
      feeRate: 0.0004
    });
    await runner.start("strategy-1");

    price = 100;
    vi.setSystemTime(new Date("2026-06-01T00:00:05.000Z"));
    const bought = await runner.tick();

    expect(bought.slots.find((slot) => slot.slotNumber === 1)).toMatchObject({ status: "SELL_PENDING", entryPrice: 100 });
    expect(bought.orders.filter((order) => order.side === "SELL" && order.status === "ACCEPTED")).toHaveLength(1);

    price = 101;
    vi.setSystemTime(new Date("2026-06-01T00:00:10.000Z"));
    const sold = await runner.tick();

    expect(sold.orders.filter((order) => order.side === "SELL" && order.status === "FILLED")).toHaveLength(1);
    expect(sold.orders.find((order) => order.side === "SELL" && order.status === "FILLED")?.rawResponse).toMatchObject({ state: "done" });
    expect(sold.slots.find((slot) => slot.slotNumber === 1)).toMatchObject({ status: "BUY_PENDING", quantity: 0 });
    expect(sold.orders.filter((order) => order.side === "BUY" && order.status === "ACCEPTED")).toHaveLength(2);
    expect(sold.fills).toHaveLength(2);

    runner.pause();
  });

  it("routes order synchronization through the configured broker", async () => {
    const db = createTestDatabase();
    const calls = {
      syncOpenOrders: 0,
      executeDecision: 0
    };
    const broker: TradingBroker = {
      mode: "PAPER",
      executeDecision(_db, _strategy, decision) {
        calls.executeDecision += 1;
        return { orderId: `order-${decision.slot.id}`, slotId: decision.slot.id };
      },
      syncOpenOrders() {
        calls.syncOpenOrders += 1;
        return [];
      },
      cancelOrder(_db, _strategy, order) {
        return { orderId: order.id, slotId: order.slotId, canceled: false };
      },
      reconcileAccount(_db, strategy, now = new Date()) {
        return {
          mode: "PAPER",
          strategyId: strategy.id,
          checkedAt: now.toISOString(),
          openOrderCount: 0,
          adjustments: []
        };
      }
    };
    const runner = new TradingRunner(db, async () => 108, 60_000, { PAPER: broker });

    runner.createPaperStrategy({
      id: "strategy-1",
      market: "KRW-BTC",
      upperPrice: 107,
      lowerPrice: 101,
      slotCount: 7,
      totalBudget: 700_000,
      targetProfitRate: 0.01
    });

    await runner.start("strategy-1");

    expect(calls.syncOpenOrders).toBe(1);
    expect(calls.executeDecision).toBe(0);
    runner.pause();
  });

  it("recovers by replenishing resting orders without retroactive fills", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
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
    const secondRunner = new TradingRunner(db, async () => 106.5, 60_000);

    const recovered = await secondRunner.recover();

    expect(recovered.runnerState).toMatchObject({ status: "RUNNING", autoTradingEnabled: true });
    expect(recovered.slots.find((slot) => slot.slotNumber === 1)).toMatchObject({ status: "EMPTY" });
    expect(recovered.slots.filter((slot) => slot.status === "BUY_PENDING")).toHaveLength(6);
    expect(recovered.orders.filter((order) => order.side === "BUY" && order.status === "FILLED")).toHaveLength(0);
    expect(recovered.fills).toHaveLength(0);

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

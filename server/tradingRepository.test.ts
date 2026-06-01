import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "./db";
import {
  appendDecisionLog,
  getRunnerState,
  getTradingPersistenceSnapshot,
  saveFill,
  saveOrder,
  saveSlot,
  saveStrategy,
  updateRunnerState
} from "./tradingRepository";
import type { SqliteDatabase } from "./db";

const cleanupCallbacks: Array<() => void> = [];

afterEach(() => {
  while (cleanupCallbacks.length > 0) {
    cleanupCallbacks.pop()?.();
  }
});

describe("tradingRepository", () => {
  it("creates trading persistence tables without account snapshots", () => {
    const db = createTestDatabase();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all() as string[];

    expect(tables).toContain("strategies");
    expect(tables).toContain("slots");
    expect(tables).toContain("orders");
    expect(tables).toContain("fills");
    expect(tables).toContain("decision_logs");
    expect(tables).toContain("runner_state");
    expect(tables).not.toContain("account_snapshots");
    expect(getRunnerState(db)).toMatchObject({
      status: "STOPPED",
      autoTradingEnabled: false,
      killSwitchEnabled: false
    });
  });

  it("persists strategy, slot, order, fill, decision log, and runner state", () => {
    const db = createTestDatabase();
    const strategy = saveStrategy(db, {
      id: "strategy-1",
      market: "krw-btc",
      upperPrice: 100,
      lowerPrice: 94,
      slotCount: 7,
      totalBudget: 700_000,
      targetProfitRate: 0.01,
      feeRate: 0.0004,
      status: "ACTIVE"
    });
    const slot = saveSlot(db, {
      id: "slot-1",
      strategyId: strategy.id,
      slotNumber: 1,
      buyPrice: 100,
      targetSellPrice: 101,
      budget: 100_000,
      status: "BUY_PENDING",
      currentOrderId: "order-1"
    });
    const order = saveOrder(db, {
      id: "order-1",
      strategyId: strategy.id,
      slotId: slot.id,
      clientOrderId: "slice-strategy-1-slot-1-buy",
      market: "KRW-BTC",
      side: "BUY",
      orderType: "limit",
      price: 100,
      quantity: 1,
      status: "ACCEPTED",
      rawRequest: { client_order_id: "slice-strategy-1-slot-1-buy" },
      rawResponse: { uuid: "broker-order-1" }
    });
    saveFill(db, {
      id: "fill-1",
      orderId: order.id,
      strategyId: strategy.id,
      slotId: slot.id,
      brokerFillId: "broker-fill-1",
      price: 100,
      quantity: 1,
      fee: 0.04,
      rawResponse: { trade_uuid: "broker-fill-1" }
    });
    appendDecisionLog(db, {
      strategyId: strategy.id,
      slotId: slot.id,
      orderId: order.id,
      market: "KRW-BTC",
      currentPrice: 99,
      action: "BUY",
      reason: "slot buy price reached",
      snapshot: { slotStatus: "EMPTY" }
    });
    updateRunnerState(db, {
      status: "RUNNING",
      activeStrategyId: strategy.id,
      autoTradingEnabled: true,
      heartbeatAt: "2026-06-01T00:00:00.000Z",
      lastOrderSyncAt: "2026-06-01T00:00:01.000Z"
    });

    const snapshot = getTradingPersistenceSnapshot(db);

    expect(snapshot.strategies).toHaveLength(1);
    expect(snapshot.strategies[0]).toMatchObject({ id: "strategy-1", market: "KRW-BTC", status: "ACTIVE" });
    expect(snapshot.slots).toHaveLength(1);
    expect(snapshot.slots[0]).toMatchObject({ id: "slot-1", status: "BUY_PENDING", currentOrderId: "order-1" });
    expect(snapshot.orders).toHaveLength(1);
    expect(snapshot.orders[0]).toMatchObject({ id: "order-1", clientOrderId: "slice-strategy-1-slot-1-buy", status: "ACCEPTED" });
    expect(snapshot.fills).toHaveLength(1);
    expect(snapshot.fills[0]).toMatchObject({ id: "fill-1", brokerFillId: "broker-fill-1" });
    expect(snapshot.decisionLogs).toHaveLength(1);
    expect(snapshot.decisionLogs[0]).toMatchObject({ action: "BUY", reason: "slot buy price reached" });
    expect(snapshot.runnerState).toMatchObject({
      status: "RUNNING",
      activeStrategyId: "strategy-1",
      autoTradingEnabled: true
    });
  });

  it("prevents duplicate client order ids", () => {
    const db = createTestDatabase();
    const strategy = saveStrategy(db, {
      id: "strategy-1",
      market: "KRW-BTC",
      upperPrice: 100,
      lowerPrice: 94,
      slotCount: 7,
      totalBudget: 700_000,
      targetProfitRate: 0.01
    });
    const slot = saveSlot(db, {
      id: "slot-1",
      strategyId: strategy.id,
      slotNumber: 1,
      buyPrice: 100,
      targetSellPrice: 101,
      budget: 100_000
    });

    saveOrder(db, {
      id: "order-1",
      strategyId: strategy.id,
      slotId: slot.id,
      clientOrderId: "same-client-order-id",
      market: "KRW-BTC",
      side: "BUY",
      orderType: "limit",
      price: 100,
      quantity: 1
    });

    expect(() =>
      saveOrder(db, {
        id: "order-2",
        strategyId: strategy.id,
        slotId: slot.id,
        clientOrderId: "same-client-order-id",
        market: "KRW-BTC",
        side: "BUY",
        orderType: "limit",
        price: 99,
        quantity: 1
      })
    ).toThrow();
  });
});

function createTestDatabase(): SqliteDatabase {
  const dir = mkdtempSync(path.join(os.tmpdir(), "slice-trade-trading-"));
  const db = openDatabase(path.join(dir, "test.sqlite"));

  cleanupCallbacks.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return db;
}

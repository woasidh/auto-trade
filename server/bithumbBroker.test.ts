import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BithumbLiveBroker } from "./bithumbBroker";
import { openDatabase } from "./db";
import { getTradingPersistenceSnapshot, saveSlot, saveStrategy } from "./tradingRepository";
import type { SqliteDatabase } from "./db";

const cleanupCallbacks: Array<() => void> = [];

afterEach(() => {
  while (cleanupCallbacks.length > 0) {
    cleanupCallbacks.pop()?.();
  }
});

describe("BithumbLiveBroker", () => {
  it("prepares a validated limit buy order without placing it", async () => {
    const db = createTestDatabase();
    const strategy = saveStrategy(db, {
      id: "live-strategy",
      market: "KRW-BTC",
      upperPrice: 107,
      lowerPrice: 101,
      slotCount: 7,
      totalBudget: 70_000,
      targetProfitRate: 0.01,
      feeRate: 0.0004,
      mode: "LIVE",
      status: "ACTIVE"
    });
    const slot = saveSlot(db, {
      strategyId: strategy.id,
      slotNumber: 1,
      buyPrice: 100,
      targetSellPrice: 101,
      budget: 10_000,
      status: "EMPTY"
    });
    const broker = new BithumbLiveBroker({
      client: createFakeClient(),
      liveTradingEnabled: () => false
    });

    const prepared = await broker.prepareDecisionOrder(
      strategy,
      { action: "BUY", slot, reason: "test buy" },
      100
    );

    expect(prepared.endpoint).toBe("/v2/orders");
    expect(prepared.request).toMatchObject({
      market: "KRW-BTC",
      side: "bid",
      order_type: "limit",
      price: "100"
    });
    expect(Number(prepared.request.volume)).toBeCloseTo(slot.budget / (1 + 0.0004) / slot.buyPrice, 10);
    expect(prepared.request.client_order_id).toMatch(/^[A-Za-z0-9_-]{1,36}$/);
    expect(prepared.validation).toMatchObject({
      bestAskPrice: 101,
      bestBidPrice: 100,
      feeRate: 0.0004,
      minTotal: 5_000,
      maxTotal: 1_000_000
    });
  });

  it("does not call Bithumb when the live trading gate is disabled", async () => {
    const db = createTestDatabase();
    const strategy = saveStrategy(db, {
      id: "live-strategy",
      market: "KRW-BTC",
      upperPrice: 107,
      lowerPrice: 101,
      slotCount: 7,
      totalBudget: 70_000,
      targetProfitRate: 0.01,
      mode: "LIVE",
      status: "ACTIVE"
    });
    const slot = saveSlot(db, {
      strategyId: strategy.id,
      slotNumber: 1,
      buyPrice: 100,
      targetSellPrice: 101,
      budget: 10_000,
      status: "EMPTY"
    });
    let called = false;
    const broker = new BithumbLiveBroker({
      client: {
        requestPrivate: async () => {
          called = true;
          return { status: 200, body: { data: {} } };
        },
        requestPublic: async () => {
          called = true;
          return { status: 200, body: { data: {} } };
        }
      },
      liveTradingEnabled: () => false
    });

    await expect(broker.executeDecision(db, strategy, { action: "BUY", slot, reason: "test buy" }, 100)).rejects.toThrow(
      "Bithumb live trading gate is disabled"
    );

    expect(called).toBe(false);
    expect(getTradingPersistenceSnapshot(db).decisionLogs[0]).toMatchObject({
      action: "HOLD",
      reason: "Bithumb live trading gate is disabled"
    });
  });
});

function createFakeClient() {
  return {
    requestPrivate: async () => ({
      status: 200,
      body: {
        data: {
          bid_fee: "0.0004",
          ask_fee: "0.0004",
          market: {
            state: "active",
            order_types: ["limit"],
            bid_types: ["limit"],
            ask_types: ["limit"],
            bid: { min_total: "5000" },
            ask: { min_total: "5000" },
            max_total: "1000000"
          },
          bid_account: { balance: "1000000" },
          ask_account: { balance: "1" }
        }
      }
    }),
    requestPublic: async () => ({
      status: 200,
      body: {
        data: [
          {
            orderbook_units: [{ ask_price: 101, bid_price: 100 }]
          }
        ]
      }
    })
  };
}

function createTestDatabase(): SqliteDatabase {
  const dir = mkdtempSync(path.join(os.tmpdir(), "slice-trade-bithumb-broker-"));
  const db = openDatabase(path.join(dir, "test.sqlite"));

  cleanupCallbacks.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return db;
}

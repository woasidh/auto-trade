import { describe, expect, it } from "vitest";
import { createStrategySlots, evaluateSevenSplit } from "./strategyEngine";
import type { Strategy, TradingSlot } from "./tradingRepository";

const strategy: Strategy = {
  id: "strategy-1",
  market: "KRW-BTC",
  upperPrice: 107,
  lowerPrice: 101,
  slotCount: 7,
  totalBudget: 700_000,
  slotBudget: 100_000,
  targetProfitRate: 0.01,
  feeRate: 0.0004,
  slippageRate: 0,
  mode: "PAPER",
  status: "ACTIVE",
  config: {},
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z"
};

describe("createStrategySlots", () => {
  it("creates seven split slots across the configured price band", () => {
    const slots = createStrategySlots(strategy);

    expect(slots).toHaveLength(7);
    expect(slots.map((slot) => slot.buyPrice)).toEqual([107, 106, 105, 104, 103, 102, 101]);
    expect(slots[0].targetSellPrice).toBeCloseTo(108.07);
  });

  it("creates slots from a configured price interval", () => {
    const slots = createStrategySlots({
      ...strategy,
      upperPrice: 1480,
      lowerPrice: 1460,
      slotCount: 8,
      targetProfitRate: 0.005,
      config: { slotPriceOffset: 3, targetProfitPriceUnit: 3 }
    });

    expect(slots).toHaveLength(8);
    expect(slots.map((slot) => slot.buyPrice)).toEqual([1480, 1477, 1474, 1471, 1468, 1465, 1462, 1460]);
    expect(slots.map((slot) => slot.targetSellPrice)).toEqual([1483, 1480, 1477, 1474, 1471, 1468, 1465, 1463]);
    expect(slots.every((slot) => slot.budget === 100_000)).toBe(true);
  });
});

describe("evaluateSevenSplit", () => {
  it("buys all empty slots touched by the observed price move", () => {
    const slots = createSlots();

    const decisions = evaluateSevenSplit(strategy, slots, 103, { previousPrice: 107 });

    expect(decisions.map((decision) => `${decision.action}:${decision.slot.slotNumber}`)).toEqual([
      "BUY:1",
      "BUY:2",
      "BUY:3",
      "BUY:4",
      "BUY:5"
    ]);
  });

  it("buys a slot touched by an upward move inside the band", () => {
    const slots = createSlots();

    const decisions = evaluateSevenSplit(strategy, slots, 104, { previousPrice: 102 });

    expect(decisions.map((decision) => `${decision.action}:${decision.slot.slotNumber}`)).toEqual([
      "BUY:4",
      "BUY:5",
      "BUY:6"
    ]);
  });

  it("only buys the exact matching slot when started without a previous price", () => {
    const slots = createSlots();

    const decisions = evaluateSevenSplit(strategy, slots, 103);

    expect(decisions.map((decision) => `${decision.action}:${decision.slot.slotNumber}`)).toEqual(["BUY:5"]);
  });

  it("skips buys when the observed price gap is too large", () => {
    const slots = createSlots();

    const decisions = evaluateSevenSplit(strategy, slots, 95, { previousPrice: 107, maxBuyPriceGap: 10 });

    expect(decisions).toEqual([]);
  });

  it("allows retry buys after the latest buy order failed or was canceled", () => {
    const slots = createSlots();

    const decisions = evaluateSevenSplit(strategy, slots, 102, {
      previousPrice: 101,
      retryBuySlotIds: new Set(["slot-3"])
    });

    expect(decisions.some((decision) => decision.action === "BUY" && decision.slot.slotNumber === 3)).toBe(true);
  });

  it("sells holding slots before considering buys", () => {
    const slots = createSlots().map((slot) =>
      slot.slotNumber === 1
        ? {
            ...slot,
            status: "HOLDING" as const,
            quantity: 1,
            entryPrice: 100,
            targetSellPrice: 101
          }
        : slot
    );

    const decisions = evaluateSevenSplit(strategy, slots, 101, { previousPrice: 102 });

    expect(decisions[0]).toMatchObject({ action: "SELL", slot: { slotNumber: 1 } });
    expect(decisions.some((decision) => decision.action === "BUY" && decision.slot.slotNumber === 7)).toBe(true);
  });

  it("ignores pending slots", () => {
    const slots = createSlots().map((slot) =>
      slot.slotNumber === 1
        ? {
            ...slot,
            status: "BUY_PENDING" as const
          }
        : slot
    );

    const decisions = evaluateSevenSplit(strategy, slots, 100);

    expect(decisions.some((decision) => decision.slot.slotNumber === 1)).toBe(false);
  });
});

function createSlots(): TradingSlot[] {
  return createStrategySlots(strategy).map((slot) => ({
    id: `slot-${slot.slotNumber}`,
    strategyId: strategy.id,
    slotNumber: slot.slotNumber,
    buyPrice: slot.buyPrice,
    targetSellPrice: slot.targetSellPrice,
    budget: slot.budget,
    status: "EMPTY",
    quantity: 0,
    entryGrossAmount: 0,
    entryFee: 0,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z"
  }));
}

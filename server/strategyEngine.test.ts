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
});

describe("evaluateSevenSplit", () => {
  it("buys all empty slots crossed by a gap down", () => {
    const slots = createSlots();

    const decisions = evaluateSevenSplit(strategy, slots, 103);

    expect(decisions.map((decision) => `${decision.action}:${decision.slot.slotNumber}`)).toEqual([
      "BUY:1",
      "BUY:2",
      "BUY:3",
      "BUY:4",
      "BUY:5"
    ]);
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

    const decisions = evaluateSevenSplit(strategy, slots, 101);

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

import { describe, expect, it } from "vitest";
import { kstIsoToEpochSeconds } from "./candles";
import { createSlots, simulateSevenSplit } from "./simulator";
import type { Candle, SimulationSettings } from "./types";

const baseSettings: SimulationSettings = {
  slotPriceOffset: 1,
  upperPrice: 107,
  lowerPrice: 101,
  totalBudget: 700_000,
  targetProfitPriceUnit: 1,
  feeRate: 0.0004
};

describe("createSlots", () => {
  it("calculates every slot from upper to lower price by integer offset", () => {
    expect(createSlots(baseSettings).map((slot) => slot.buyPrice)).toEqual([107, 106, 105, 104, 103, 102, 101]);
  });

  it("includes the lower price when the offset does not divide the range evenly", () => {
    const slots = createSlots({ ...baseSettings, slotPriceOffset: 3, lowerPrice: 100 });

    expect(slots.map((slot) => slot.buyPrice)).toEqual([107, 104, 101, 100]);
    expect(slots.every((slot) => slot.budget === 175_000)).toBe(true);
  });

  it("keeps slot buy and target sell prices in whole price units", () => {
    const slots = createSlots({
      ...baseSettings,
      upperPrice: 107.8,
      lowerPrice: 101.2
    });

    expect(slots.every((slot) => Number.isInteger(slot.buyPrice))).toBe(true);
    expect(slots.every((slot) => Number.isInteger(slot.targetSellPrice))).toBe(true);
    expect(slots[0].buyPrice).toBe(107);
    expect(slots[0].targetSellPrice).toBe(108);
  });

  it("calculates target returns from integer price units after fees", () => {
    const slots = createSlots({
      slotPriceOffset: 1,
      upperPrice: 100,
      lowerPrice: 99,
      totalBudget: 200_000,
      targetProfitPriceUnit: 1,
      feeRate: 0.001
    });

    expect(slots[0].targetSellPrice).toBe(101);
    expect(slots[0].grossTargetProfitRate).toBeCloseTo(0.01);
    expect(slots[0].netTargetProfitRate).toBeCloseTo((101 * 0.999) / (100 * 1.001) - 1);
  });
});

describe("simulateSevenSplit", () => {
  it("buys multiple slots when low crosses several buy prices", () => {
    const result = simulateSevenSplit([candle("2026-05-10T00:00:00", 107, 103, 104)], baseSettings);

    expect(result.summary.buyCount).toBe(5);
    expect(result.slots.slice(0, 5).every((slot) => slot.status === "HOLDING")).toBe(true);
  });

  it("does not sell a slot in the same candle where it was bought", () => {
    const result = simulateSevenSplit([candle("2026-05-10T00:00:00", 110, 100, 108)], baseSettings);

    expect(result.summary.buyCount).toBe(7);
    expect(result.summary.sellCount).toBe(0);
  });

  it("prevents same-candle rebuy after an existing holding is sold", () => {
    const result = simulateSevenSplit(
      [
        candle("2026-05-10T00:00:00", 107, 107, 107),
        candle("2026-05-10T00:01:00", 109, 100, 108)
      ],
      baseSettings
    );

    const slotOne = result.slots[0];
    expect(slotOne.trades.map((trade) => trade.type)).toEqual(["BUY", "SELL"]);
    expect(slotOne.status).toBe("EMPTY");
  });

  it("applies fees to realized profit", () => {
    const result = simulateSevenSplit(
      [
        candle("2026-05-10T00:00:00", 100, 100, 100),
        candle("2026-05-10T00:01:00", 102, 102, 102)
      ],
      {
        slotPriceOffset: 1,
        upperPrice: 100,
        lowerPrice: 99,
        totalBudget: 200_000,
        targetProfitPriceUnit: 1,
        feeRate: 0.001
      }
    );

    expect(result.summary.sellCount).toBe(1);
    expect(result.slots[0].realizedProfit).toBeGreaterThan(700);
  });

  it("calculates final unrealized profit for open slots", () => {
    const result = simulateSevenSplit(
      [candle("2026-05-10T00:00:00", 100, 100, 102)],
      {
        slotPriceOffset: 1,
        upperPrice: 100,
        lowerPrice: 99,
        totalBudget: 200_000,
        targetProfitPriceUnit: 1,
        feeRate: 0.001
      }
    );

    expect(result.summary.sellCount).toBe(0);
    expect(result.slots[0].unrealizedProfit).toBeGreaterThan(0);
  });
});

function candle(time: string, high: number, low: number, close: number): Candle {
  return {
    market: "KRW-USDT",
    time,
    epochSeconds: kstIsoToEpochSeconds(time),
    open: close,
    high,
    low,
    close,
    volume: 1,
    accTradePrice: close
  };
}

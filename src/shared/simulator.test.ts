import { describe, expect, it } from "vitest";
import { kstIsoToEpochSeconds } from "./candles";
import { createSlots, simulateSevenSplit } from "./simulator";
import type { Candle, SimulationSettings } from "./types";

const baseSettings: SimulationSettings = {
  slotCount: 7,
  upperPrice: 107,
  lowerPrice: 101,
  totalBudget: 700_000,
  targetProfitRate: 0.01,
  feeRate: 0.0004
};

describe("createSlots", () => {
  it("calculates prices for 2, 7, and 20 slots", () => {
    expect(createSlots({ ...baseSettings, slotCount: 2 }).map((slot) => slot.buyPrice)).toEqual([107, 101]);
    expect(createSlots(baseSettings).map((slot) => slot.buyPrice)).toEqual([107, 106, 105, 104, 103, 102, 101]);

    const slots = createSlots({ ...baseSettings, slotCount: 20 });
    expect(slots).toHaveLength(20);
    expect(slots[0].buyPrice).toBe(107);
    expect(slots[19].buyPrice).toBe(101);
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
        slotCount: 2,
        upperPrice: 100,
        lowerPrice: 99,
        totalBudget: 200_000,
        targetProfitRate: 0.01,
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
        slotCount: 2,
        upperPrice: 100,
        lowerPrice: 99,
        totalBudget: 200_000,
        targetProfitRate: 0.01,
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

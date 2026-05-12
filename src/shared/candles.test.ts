import { describe, expect, it } from "vitest";
import { fillMissingCandles, getPriceBand, kstIsoToEpochSeconds } from "./candles";
import type { Candle } from "./types";

describe("fillMissingCandles", () => {
  it("fills missing minutes with the previous close", () => {
    const candles: Candle[] = [
      candle("2026-05-10T00:00:00", 100),
      candle("2026-05-10T00:02:00", 102)
    ];

    const filled = fillMissingCandles(candles, "2026-05-10", "2026-05-10").slice(0, 3);

    expect(filled[0]).toMatchObject({ time: "2026-05-10T00:00:00", close: 100 });
    expect(filled[0].synthetic).toBeUndefined();
    expect(filled[1]).toMatchObject({
      time: "2026-05-10T00:01:00",
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      synthetic: true
    });
    expect(filled[2]).toMatchObject({ time: "2026-05-10T00:02:00", close: 102 });
    expect(filled[2].synthetic).toBeUndefined();
  });
});

describe("getPriceBand", () => {
  it("returns null when there are no candles", () => {
    expect(getPriceBand([])).toBeNull();
  });

  it("finds the band without spreading a large array into Math.max/min", () => {
    const base = candle("2026-05-10T00:00:00", 100);
    const candles = new Array(160_000).fill(base);

    candles[0] = { ...base, high: 101, low: 99 };
    candles[candles.length - 1] = { ...base, high: 123.45, low: 87.65 };

    expect(getPriceBand(candles)).toEqual({
      upperPrice: 123.45,
      lowerPrice: 87.65
    });
  });
});

function candle(time: string, close: number): Candle {
  return {
    market: "KRW-USDT",
    time,
    epochSeconds: kstIsoToEpochSeconds(time),
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    accTradePrice: close
  };
}

import { describe, expect, it } from "vitest";
import { fillMissingCandles, kstIsoToEpochSeconds } from "./candles";
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

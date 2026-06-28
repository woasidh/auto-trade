import type { Time, UTCTimestamp } from "lightweight-charts";
import { describe, expect, it } from "vitest";
import { createHoverConnectionLineSegments } from "./PriceChart";

describe("PriceChart hover connection lines", () => {
  it("builds SVG overlay line coordinates without adding second-level trade times to the chart", () => {
    const timeCoordinateCalls: Time[] = [];

    const segments = createHoverConnectionLineSegments(
      [
        {
          id: "buy-1:sell-1",
          profit: 1200,
          buy: { epochSeconds: 1_800 + 52, price: 1516 },
          sell: { epochSeconds: 1_920 + 8, price: 1518 }
        }
      ],
      {
        chart: {
          timeScale: () => ({
            timeToCoordinate: (time: Time) => {
              timeCoordinateCalls.push(time);
              return time === (1_800 as UTCTimestamp) ? 120 : 260;
            }
          })
        },
        series: {
          priceToCoordinate: (price: number) => (price === 1516 ? 280 : 180)
        },
        availableTimes: new Set([1_800, 1_920])
      }
    );

    expect(timeCoordinateCalls).toEqual([1_800, 1_920]);
    expect(segments).toEqual([
      {
        id: "buy-1:sell-1",
        x1: 120,
        y1: 280,
        x2: 260,
        y2: 180,
        color: "#0f766e",
        dashed: false
      }
    ]);
  });
});

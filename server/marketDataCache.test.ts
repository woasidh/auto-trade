import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RawBithumbCandle } from "../src/shared/types";
import {
  getCachedBithumbMinuteCandles,
  mergeMinuteCandlesIntoCache,
  readMinuteCandlesFromCache
} from "./marketDataCache";
import type { BithumbHttpResponse } from "./bithumbClient";

const cleanupCallbacks: Array<() => void> = [];

afterEach(() => {
  while (cleanupCallbacks.length > 0) {
    cleanupCallbacks.pop()?.();
  }
});

describe("marketDataCache", () => {
  it("returns closed cached minute candles without calling Bithumb", async () => {
    const dataRoot = createTempDataRoot();
    await mergeMinuteCandlesIntoCache({
      dataRoot,
      market: "KRW-USDT",
      unit: 1,
      candles: [rawCandle("2026-06-28T00:01:00", 1479), rawCandle("2026-06-28T00:02:00", 1480)]
    });
    const calls: string[] = [];

    const response = await getCachedBithumbMinuteCandles({
      dataRoot,
      market: "KRW-USDT",
      unit: 1,
      count: 2,
      to: "2026-06-28 00:03:00",
      now: new Date("2026-06-27T16:00:00.000Z"),
      client: {
        requestPublic: async (endpoint) => {
          calls.push(endpoint);
          return okResponse(endpoint, []);
        }
      }
    });

    expect(calls).toEqual([]);
    expect(response.body.endpoint).toContain("file-cache:");
    expect((response.body.data as RawBithumbCandle[]).map((candle) => candle.candle_date_time_kst)).toEqual([
      "2026-06-28T00:02:00",
      "2026-06-28T00:01:00"
    ]);
  });

  it("fetches missing candles, stores them, then serves the same page from cache", async () => {
    const dataRoot = createTempDataRoot();
    const calls: string[] = [];
    const freshCandles = [rawCandle("2026-06-28T00:02:00", 1480), rawCandle("2026-06-28T00:01:00", 1479)];
    const client = {
      requestPublic: async (endpoint: string): Promise<BithumbHttpResponse> => {
        calls.push(endpoint);
        return okResponse(endpoint, freshCandles);
      }
    };

    const first = await getCachedBithumbMinuteCandles({
      dataRoot,
      client,
      market: "KRW-USDT",
      unit: 1,
      count: 2,
      to: "2026-06-28 00:03:00",
      now: new Date("2026-06-27T16:00:00.000Z")
    });
    const second = await getCachedBithumbMinuteCandles({
      dataRoot,
      client,
      market: "KRW-USDT",
      unit: 1,
      count: 2,
      to: "2026-06-28 00:03:00",
      now: new Date("2026-06-27T16:00:00.000Z")
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("/v1/candles/minutes/1?market=KRW-USDT&count=2&to=2026-06-28+00%3A03%3A00");
    expect((first.body.data as RawBithumbCandle[])).toHaveLength(2);
    expect(second.body.endpoint).toContain("file-cache:");
    expect(readCachedFile(dataRoot, "KRW-USDT", 1, "2026-06-28").map((candle) => candle.candle_date_time_kst)).toEqual([
      "2026-06-28T00:01:00",
      "2026-06-28T00:02:00"
    ]);
  });

  it("does not store the currently open minute candle", async () => {
    const dataRoot = createTempDataRoot();
    const client = {
      requestPublic: async (endpoint: string): Promise<BithumbHttpResponse> =>
        okResponse(endpoint, [rawCandle("2026-06-28T00:03:00", 1481), rawCandle("2026-06-28T00:02:00", 1480)])
    };

    await getCachedBithumbMinuteCandles({
      dataRoot,
      client,
      market: "KRW-USDT",
      unit: 1,
      count: 2,
      now: new Date("2026-06-27T15:03:30.000Z")
    });

    expect(readCachedFile(dataRoot, "KRW-USDT", 1, "2026-06-28").map((candle) => candle.candle_date_time_kst)).toEqual([
      "2026-06-28T00:02:00"
    ]);
  });

  it("deduplicates candles when merging the same minute more than once", async () => {
    const dataRoot = createTempDataRoot();
    await mergeMinuteCandlesIntoCache({
      dataRoot,
      market: "KRW-USDT",
      unit: 1,
      candles: [rawCandle("2026-06-28T00:01:00", 1479)]
    });
    await mergeMinuteCandlesIntoCache({
      dataRoot,
      market: "KRW-USDT",
      unit: 1,
      candles: [rawCandle("2026-06-28T00:01:00", 1480)]
    });

    const cached = await readMinuteCandlesFromCache(dataRoot, "KRW-USDT", 1, [
      Date.parse("2026-06-28T00:01:00+09:00")
    ]);

    expect([...cached.values()]).toHaveLength(1);
    expect([...cached.values()][0].trade_price).toBe(1480);
  });

  it("ignores corrupted cache files and refetches from Bithumb", async () => {
    const dataRoot = createTempDataRoot();
    const filePath = path.join(dataRoot, "KRW-USDT", "1m", "2026-06-28.json");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "{not-json", "utf8");
    const calls: string[] = [];

    const response = await getCachedBithumbMinuteCandles({
      dataRoot,
      market: "KRW-USDT",
      unit: 1,
      count: 1,
      to: "2026-06-28 00:03:00",
      now: new Date("2026-06-27T16:00:00.000Z"),
      client: {
        requestPublic: async (endpoint) => {
          calls.push(endpoint);
          return okResponse(endpoint, [rawCandle("2026-06-28T00:02:00", 1480)]);
        }
      }
    });

    expect(calls).toHaveLength(1);
    expect((response.body.data as RawBithumbCandle[])[0].candle_date_time_kst).toBe("2026-06-28T00:02:00");
    expect(readCachedFile(dataRoot, "KRW-USDT", 1, "2026-06-28")).toHaveLength(1);
  });
});

function createTempDataRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "slice-trade-market-data-"));
  cleanupCallbacks.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function okResponse(endpoint: string, data: RawBithumbCandle[]): BithumbHttpResponse {
  return {
    status: 200,
    body: {
      endpoint,
      data
    }
  };
}

function rawCandle(kstTime: string, price: number): RawBithumbCandle {
  const epochMs = Date.parse(`${kstTime}+09:00`);
  return {
    market: "KRW-USDT",
    candle_date_time_utc: new Date(epochMs).toISOString().slice(0, 19),
    candle_date_time_kst: kstTime,
    opening_price: price,
    high_price: price,
    low_price: price,
    trade_price: price,
    timestamp: epochMs + 59_000,
    candle_acc_trade_price: price * 100,
    candle_acc_trade_volume: 100,
    unit: 1
  };
}

function readCachedFile(dataRoot: string, market: string, unit: number, date: string): RawBithumbCandle[] {
  return JSON.parse(readFileSync(path.join(dataRoot, market, `${unit}m`, `${date}.json`), "utf8")) as RawBithumbCandle[];
}

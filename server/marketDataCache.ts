import fs from "node:fs/promises";
import path from "node:path";
import { formatKstIso, kstIsoToEpochSeconds } from "../src/shared/candles";
import type { RawBithumbCandle } from "../src/shared/types";
import type { BithumbHttpResponse } from "./bithumbClient";

type BithumbPublicClient = {
  requestPublic(endpoint: string): Promise<BithumbHttpResponse>;
};

export interface CachedMinuteCandleRequest {
  dataRoot: string;
  client: BithumbPublicClient;
  market: string;
  unit: number;
  count: number;
  to?: string;
  forceRefresh?: boolean;
  now?: Date;
  closedCandleDelayMs?: number;
}

const minuteMs = 60_000;
const defaultClosedCandleDelayMs = 10_000;
const writeLocks = new Map<string, Promise<void>>();

export async function getCachedBithumbMinuteCandles({
  dataRoot,
  client,
  market,
  unit,
  count,
  to = "",
  forceRefresh = false,
  now = new Date(),
  closedCandleDelayMs = defaultClosedCandleDelayMs
}: CachedMinuteCandleRequest): Promise<BithumbHttpResponse> {
  const unitMs = unit * minuteMs;
  const normalizedMarket = market.trim().toUpperCase();
  const normalizedCount = Math.min(200, Math.max(1, Math.round(count)));
  const requestEndExclusiveMs = getRequestEndExclusiveMs(to, unitMs, now);
  const expectedBucketStarts = createExpectedBucketStarts(requestEndExclusiveMs, unitMs, normalizedCount);
  const cachedByTime = await readMinuteCandlesFromCache(dataRoot, normalizedMarket, unit, expectedBucketStarts);

  if (!forceRefresh && isCacheComplete(cachedByTime, expectedBucketStarts, unitMs, now.getTime(), closedCandleDelayMs)) {
    return {
      status: 200,
      body: {
        endpoint: createCacheEndpoint(normalizedMarket, unit, normalizedCount, to),
        data: candlesForBuckets(cachedByTime, expectedBucketStarts)
      }
    };
  }

  const freshEndpoint = createBithumbMinuteCandleEndpoint({
    market: normalizedMarket,
    unit,
    count: calculateFreshRequestCount(expectedBucketStarts, cachedByTime, unitMs, now.getTime(), closedCandleDelayMs, forceRefresh),
    to: calculateFreshRequestTo(expectedBucketStarts, cachedByTime, unitMs, now.getTime(), closedCandleDelayMs, forceRefresh, to)
  });
  const freshResponse = await client.requestPublic(freshEndpoint);
  const freshCandles = rawCandlesFromResponse(freshResponse);

  if (freshCandles.length > 0) {
    await mergeMinuteCandlesIntoCache({
      dataRoot,
      market: normalizedMarket,
      unit,
      candles: freshCandles.filter((candle) => isClosedMinuteCandle(candle, unit, now, closedCandleDelayMs))
    });
  }

  if (freshResponse.status < 200 || freshResponse.status >= 300 || freshCandles.length === 0) {
    return freshResponse;
  }

  const freshByTime = new Map(freshCandles.map((candle) => [candle.candle_date_time_kst, candle]));
  const mergedByTime = new Map([...cachedByTime, ...freshByTime]);
  const mergedCandles = candlesForBuckets(mergedByTime, expectedBucketStarts);

  return {
    ...freshResponse,
    body: {
      ...freshResponse.body,
      data: mergedCandles.length > 0 ? mergedCandles : freshCandles
    }
  };
}

export async function mergeMinuteCandlesIntoCache({
  dataRoot,
  market,
  unit,
  candles
}: {
  dataRoot: string;
  market: string;
  unit: number;
  candles: RawBithumbCandle[];
}): Promise<void> {
  const normalizedMarket = market.trim().toUpperCase();
  const validCandles = candles.filter((candle) => isRawBithumbCandle(candle));
  const candlesByDate = new Map<string, RawBithumbCandle[]>();

  for (const candle of validCandles) {
    const date = candle.candle_date_time_kst.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      continue;
    }

    const current = candlesByDate.get(date) ?? [];
    current.push({ ...candle, market: normalizedMarket, unit });
    candlesByDate.set(date, current);
  }

  for (const [date, dateCandles] of candlesByDate) {
    const filePath = minuteCandleFilePath(dataRoot, normalizedMarket, unit, date);
    await withFileWriteLock(filePath, async () => {
      const existing = await readRawCandlesFile(filePath);
      const merged = mergeRawCandles(existing, dateCandles);
      await writeRawCandlesFile(filePath, merged);
    });
  }
}

export async function readMinuteCandlesFromCache(
  dataRoot: string,
  market: string,
  unit: number,
  bucketStarts: number[]
): Promise<Map<string, RawBithumbCandle>> {
  const normalizedMarket = market.trim().toUpperCase();
  const dates = new Set(bucketStarts.map((bucketStart) => formatKstIso(bucketStart).slice(0, 10)));
  const candlesByTime = new Map<string, RawBithumbCandle>();

  for (const date of dates) {
    const filePath = minuteCandleFilePath(dataRoot, normalizedMarket, unit, date);
    const candles = await readRawCandlesFile(filePath);
    for (const candle of candles) {
      if (candle.market === normalizedMarket && candle.unit === unit) {
        candlesByTime.set(candle.candle_date_time_kst, candle);
      }
    }
  }

  return candlesByTime;
}

export function isClosedMinuteCandle(
  candle: RawBithumbCandle,
  unit: number,
  now = new Date(),
  closedCandleDelayMs = defaultClosedCandleDelayMs
): boolean {
  const bucketStartMs = kstIsoToEpochSeconds(candle.candle_date_time_kst) * 1000;
  return bucketStartMs + unit * minuteMs + closedCandleDelayMs <= now.getTime();
}

function isCacheComplete(
  cachedByTime: Map<string, RawBithumbCandle>,
  bucketStarts: number[],
  unitMs: number,
  nowMs: number,
  closedCandleDelayMs: number
): boolean {
  return bucketStarts.every((bucketStart) => {
    const time = formatKstIso(bucketStart);
    return bucketStart + unitMs + closedCandleDelayMs <= nowMs && cachedByTime.has(time);
  });
}

function candlesForBuckets(candlesByTime: Map<string, RawBithumbCandle>, bucketStarts: number[]): RawBithumbCandle[] {
  return bucketStarts
    .map((bucketStart) => candlesByTime.get(formatKstIso(bucketStart)))
    .filter((candle): candle is RawBithumbCandle => Boolean(candle))
    .sort((left, right) => right.candle_date_time_kst.localeCompare(left.candle_date_time_kst));
}

function calculateFreshRequestCount(
  bucketStarts: number[],
  cachedByTime: Map<string, RawBithumbCandle>,
  unitMs: number,
  nowMs: number,
  closedCandleDelayMs: number,
  forceRefresh: boolean
): number {
  if (forceRefresh) {
    return bucketStarts.length;
  }

  const missingStarts = bucketStarts.filter((bucketStart) => {
    const time = formatKstIso(bucketStart);
    return bucketStart + unitMs + closedCandleDelayMs > nowMs || !cachedByTime.has(time);
  });

  if (missingStarts.length === 0) {
    return 1;
  }

  return Math.min(200, Math.max(1, Math.round((Math.max(...missingStarts) - Math.min(...missingStarts)) / unitMs) + 1));
}

function calculateFreshRequestTo(
  bucketStarts: number[],
  cachedByTime: Map<string, RawBithumbCandle>,
  unitMs: number,
  nowMs: number,
  closedCandleDelayMs: number,
  forceRefresh: boolean,
  originalTo: string
): string {
  if (forceRefresh) {
    return originalTo;
  }

  const missingStarts = bucketStarts.filter((bucketStart) => {
    const time = formatKstIso(bucketStart);
    return bucketStart + unitMs + closedCandleDelayMs > nowMs || !cachedByTime.has(time);
  });

  if (missingStarts.length === 0) {
    return originalTo;
  }

  const maxMissingStart = Math.max(...missingStarts);
  const latestRequestedStart = bucketStarts[bucketStarts.length - 1];
  if (!originalTo && maxMissingStart === latestRequestedStart) {
    return "";
  }

  return formatKstIso(maxMissingStart + unitMs).replace("T", " ");
}

function createExpectedBucketStarts(endExclusiveMs: number, unitMs: number, count: number): number[] {
  const latestBucketStart = floorToUnit(endExclusiveMs - 1, unitMs);
  const starts: number[] = [];

  for (let index = count - 1; index >= 0; index -= 1) {
    starts.push(latestBucketStart - index * unitMs);
  }

  return starts;
}

function getRequestEndExclusiveMs(to: string, unitMs: number, now: Date): number {
  const parsedToMs = parseBithumbKstTime(to);
  if (Number.isFinite(parsedToMs)) {
    return floorToUnit(parsedToMs, unitMs);
  }

  return floorToUnit(now.getTime(), unitMs) + unitMs;
}

function parseBithumbKstTime(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) {
    return NaN;
  }

  const normalized = trimmed.replace(" ", "T");
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(normalized)) {
    return Date.parse(normalized);
  }

  return Date.parse(`${normalized}+09:00`);
}

function createBithumbMinuteCandleEndpoint({
  market,
  unit,
  count,
  to
}: {
  market: string;
  unit: number;
  count: number;
  to: string;
}): string {
  const params = new URLSearchParams({ market, count: String(count) });
  if (to) {
    params.set("to", to);
  }

  return `/v1/candles/minutes/${unit}?${params.toString()}`;
}

function createCacheEndpoint(market: string, unit: number, count: number, to: string): string {
  const params = new URLSearchParams({ market, count: String(count) });
  if (to) {
    params.set("to", to);
  }

  return `file-cache:/v1/candles/minutes/${unit}?${params.toString()}`;
}

function rawCandlesFromResponse(response: BithumbHttpResponse): RawBithumbCandle[] {
  const data = response.body.data;
  return Array.isArray(data) ? data.filter((item): item is RawBithumbCandle => isRawBithumbCandle(item)) : [];
}

function mergeRawCandles(existing: RawBithumbCandle[], next: RawBithumbCandle[]): RawBithumbCandle[] {
  const byTime = new Map<string, RawBithumbCandle>();

  for (const candle of existing) {
    if (isRawBithumbCandle(candle)) {
      byTime.set(candle.candle_date_time_kst, candle);
    }
  }

  for (const candle of next) {
    byTime.set(candle.candle_date_time_kst, candle);
  }

  return [...byTime.values()].sort((left, right) => left.candle_date_time_kst.localeCompare(right.candle_date_time_kst));
}

async function readRawCandlesFile(filePath: string): Promise<RawBithumbCandle[]> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is RawBithumbCandle => isRawBithumbCandle(item)) : [];
  } catch {
    return [];
  }
}

async function writeRawCandlesFile(filePath: string, candles: RawBithumbCandle[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempFilePath, `${JSON.stringify(candles, null, 2)}\n`, "utf8");
  await fs.rename(tempFilePath, filePath);
}

async function withFileWriteLock(filePath: string, write: () => Promise<void>): Promise<void> {
  const currentLock = writeLocks.get(filePath) ?? Promise.resolve();
  const nextLock = currentLock.then(write, write);
  writeLocks.set(filePath, nextLock);

  try {
    await nextLock;
  } finally {
    if (writeLocks.get(filePath) === nextLock) {
      writeLocks.delete(filePath);
    }
  }
}

function minuteCandleFilePath(dataRoot: string, market: string, unit: number, date: string): string {
  return path.join(dataRoot, market, `${unit}m`, `${date}.json`);
}

function floorToUnit(epochMs: number, unitMs: number): number {
  return Math.floor(epochMs / unitMs) * unitMs;
}

function isRawBithumbCandle(value: unknown): value is RawBithumbCandle {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candle = value as Partial<RawBithumbCandle>;
  return (
    typeof candle.market === "string" &&
    typeof candle.candle_date_time_utc === "string" &&
    typeof candle.candle_date_time_kst === "string" &&
    Number.isFinite(candle.opening_price) &&
    Number.isFinite(candle.high_price) &&
    Number.isFinite(candle.low_price) &&
    Number.isFinite(candle.trade_price) &&
    Number.isFinite(candle.timestamp) &&
    Number.isFinite(candle.candle_acc_trade_price) &&
    Number.isFinite(candle.candle_acc_trade_volume) &&
    Number.isFinite(candle.unit)
  );
}

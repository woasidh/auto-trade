import type { Candle, RawBithumbCandle } from "./types";

const minuteMs = 60_000;
const kstOffsetMs = 9 * 60 * 60 * 1000;

export function normalizeRawCandle(raw: RawBithumbCandle): Candle {
  return {
    market: raw.market,
    time: raw.candle_date_time_kst,
    epochSeconds: kstIsoToEpochSeconds(raw.candle_date_time_kst),
    open: raw.opening_price,
    high: raw.high_price,
    low: raw.low_price,
    close: raw.trade_price,
    volume: raw.candle_acc_trade_volume,
    accTradePrice: raw.candle_acc_trade_price
  };
}

export function fillMissingCandles(candles: Candle[], fromDate: string, toDate: string): Candle[] {
  if (candles.length === 0) {
    return [];
  }

  const sorted = [...candles].sort((a, b) => a.time.localeCompare(b.time));
  const candleByTime = new Map(sorted.map((candle) => [candle.time, candle]));
  const startMs = Date.parse(`${fromDate}T00:00:00+09:00`);
  const endMs = Date.parse(`${addDays(toDate, 1)}T00:00:00+09:00`);
  let previousClose = sorted[0].close;
  const market = sorted[0].market;
  const filled: Candle[] = [];

  for (let ms = startMs; ms < endMs; ms += minuteMs) {
    const time = formatKstIso(ms);
    const real = candleByTime.get(time);

    if (real) {
      previousClose = real.close;
      filled.push(real);
      continue;
    }

    filled.push({
      market,
      time,
      epochSeconds: Math.floor(ms / 1000),
      open: previousClose,
      high: previousClose,
      low: previousClose,
      close: previousClose,
      volume: 0,
      accTradePrice: 0,
      synthetic: true
    });
  }

  return filled;
}

export function countMissingMinutes(raw: RawBithumbCandle[], date: string): number {
  const uniqueTimes = new Set(
    raw
      .map((candle) => candle.candle_date_time_kst)
      .filter((time) => time >= `${date}T00:00:00` && time < `${addDays(date, 1)}T00:00:00`)
  );

  return Math.max(0, 1440 - uniqueTimes.size);
}

export function dateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  let current = from;

  while (current <= to) {
    dates.push(current);
    current = addDays(current, 1);
  }

  return dates;
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function isDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function kstIsoToEpochSeconds(kstIso: string): number {
  return Math.floor(Date.parse(`${kstIso}+09:00`) / 1000);
}

export function formatKstIso(epochMs: number): string {
  const kst = new Date(epochMs + kstOffsetMs);
  return [
    `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())}`,
    `${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}:${pad(kst.getUTCSeconds())}`
  ].join("T");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

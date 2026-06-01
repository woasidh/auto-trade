export const supportedMinuteUnits = [1, 3, 5, 10, 15, 30, 60, 240] as const;

export interface AppSettings {
  bithumb: {
    testMarket: string;
    candleUnit: number;
    candleCount: number;
  };
  updatedAt?: string;
}

export const defaultAppSettings: AppSettings = {
  bithumb: {
    testMarket: "KRW-BTC",
    candleUnit: 1,
    candleCount: 20
  }
};

export function normalizeAppSettings(value: unknown): AppSettings {
  const root = isRecord(value) ? value : {};
  const bithumb = isRecord(root.bithumb) ? root.bithumb : {};

  return {
    bithumb: {
      testMarket: normalizeMarket(bithumb.testMarket, defaultAppSettings.bithumb.testMarket),
      candleUnit: supportedMinuteUnits.includes(Number(bithumb.candleUnit) as (typeof supportedMinuteUnits)[number])
        ? Number(bithumb.candleUnit)
        : defaultAppSettings.bithumb.candleUnit,
      candleCount: normalizeInteger(bithumb.candleCount, defaultAppSettings.bithumb.candleCount, 1, 200)
    },
    updatedAt: typeof root.updatedAt === "string" ? root.updatedAt : undefined
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMarket(value: unknown, fallback: string) {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9]+-[A-Z0-9]+$/.test(normalized) ? normalized : fallback;
}

function normalizeNumber(value: unknown, fallback: number, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  const normalized = typeof value === "number" ? value : Number(value);
  return Number.isFinite(normalized) ? Math.min(max, Math.max(min, normalized)) : fallback;
}

function normalizeInteger(value: unknown, fallback: number, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  return Math.round(normalizeNumber(value, fallback, min, max));
}

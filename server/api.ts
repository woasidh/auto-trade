import express from "express";
import { createHash, createHmac, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  countMissingMinutes,
  dateRange,
  fillMissingCandles,
  isDateString,
  normalizeRawCandle
} from "../src/shared/candles";
import { defaultAppSettings, normalizeAppSettings, supportedMinuteUnits } from "../src/shared/settings";
import type { DatasetResponse, RawBithumbCandle } from "../src/shared/types";
import { openDatabase } from "./db";
import { getAppSettings, saveAppSettings, seedAppSettingsIfMissing, settingsStorage } from "./settingsRepository";
import { TradingRunner } from "./tradingRunner";
import { getTradingPersistenceSnapshot } from "./tradingRepository";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataRoot = path.join(rootDir, "data", "bithumb");
const settingsDbFilePath = path.join(rootDir, "data", "slice-trade.sqlite");
const legacySettingsFilePath = path.join(rootDir, "data", "settings", "app-settings.json");
const localEnvFilePath = path.join(rootDir, ".env.local");
const bithumbApiBaseUrl = "https://api.bithumb.com";
const port = Number(process.env.API_PORT ?? 5174);
const db = openDatabase(settingsDbFilePath);
const tradingRunner = new TradingRunner(db, fetchBithumbTradePrice);

const app = express();

app.use(express.json({ limit: "128kb" }));

await seedAppSettingsIfMissing(db, legacySettingsFilePath);
await loadLocalEnv();
await tradingRunner.recover();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/settings", async (_req, res, next) => {
  try {
    const settings = getAppSettings(db);
    res.json({ settings, filePath: path.relative(rootDir, settingsDbFilePath), storage: settingsStorage });
  } catch (error) {
    next(error);
  }
});

app.put("/api/settings", async (req, res, next) => {
  try {
    const body = typeof req.body === "object" && req.body !== null ? req.body : {};
    const settings = normalizeAppSettings({
      ...body,
      updatedAt: new Date().toISOString()
    });

    const savedSettings = saveAppSettings(db, settings);
    res.json({ settings: savedSettings, filePath: path.relative(rootDir, settingsDbFilePath), storage: settingsStorage });
  } catch (error) {
    next(error);
  }
});

app.get("/api/trading/persistence", (_req, res, next) => {
  try {
    res.json(getTradingPersistenceSnapshot(db));
  } catch (error) {
    next(error);
  }
});

app.post("/api/trading/strategy", (req, res, next) => {
  try {
    const input = normalizePaperStrategyRequest(req.body);
    if (!input.ok) {
      res.status(400).json({ error: input.error });
      return;
    }

    res.json(tradingRunner.createPaperStrategy(input.value));
  } catch (error) {
    next(error);
  }
});

app.post("/api/trading/start", async (req, res, next) => {
  try {
    const body = isRecord(req.body) ? req.body : {};
    const strategyId = typeof body.strategyId === "string" && body.strategyId.trim() ? body.strategyId.trim() : undefined;
    res.json(await tradingRunner.start(strategyId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/trading/pause", (_req, res, next) => {
  try {
    res.json(tradingRunner.pause());
  } catch (error) {
    next(error);
  }
});

app.post("/api/trading/stop", (_req, res, next) => {
  try {
    res.json(tradingRunner.stop());
  } catch (error) {
    next(error);
  }
});

app.post("/api/trading/tick", async (_req, res, next) => {
  try {
    res.json(await tradingRunner.tick());
  } catch (error) {
    next(error);
  }
});

app.get("/api/datasets", async (_req, res, next) => {
  try {
    const datasets: DatasetResponse["datasets"] = [];
    const markets = await listDirectories(dataRoot);

    for (const market of markets) {
      const marketPath = path.join(dataRoot, market);
      const intervals = [];
      const intervalNames = await listDirectories(marketPath);

      for (const interval of intervalNames) {
        const intervalPath = path.join(marketPath, interval);
        const files = (await fs.readdir(intervalPath))
          .filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
          .sort();

        const dates = [];
        for (const file of files) {
          const date = file.replace(".json", "");
          const raw = await readCandlesFile(path.join(intervalPath, file));
          dates.push({
            date,
            count: raw.length,
            missing: countMissingMinutes(raw, date)
          });
        }

        intervals.push({ interval, dates });
      }

      datasets.push({ market, intervals });
    }

    res.json({ datasets });
  } catch (error) {
    next(error);
  }
});

app.get("/api/candles", async (req, res, next) => {
  try {
    const market = String(req.query.market ?? "KRW-USDT");
    const interval = String(req.query.interval ?? "1m");
    const from = String(req.query.from ?? "");
    const to = String(req.query.to ?? from);

    if (!/^[A-Z0-9-]+$/.test(market) || !/^[a-z0-9]+$/.test(interval)) {
      res.status(400).json({ error: "Invalid market or interval" });
      return;
    }

    if (!isDateString(from) || !isDateString(to) || from > to) {
      res.status(400).json({ error: "Invalid date range" });
      return;
    }

    const raw: RawBithumbCandle[] = [];
    for (const date of dateRange(from, to)) {
      const filePath = path.join(dataRoot, market, interval, `${date}.json`);
      raw.push(...(await readCandlesFile(filePath)));
    }

    const candles = fillMissingCandles(raw.map(normalizeRawCandle), from, to);
    res.json({ market, interval, from, to, candles });
  } catch (error) {
    next(error);
  }
});

app.get("/api/bithumb/markets", async (req, res, next) => {
  try {
    const params = new URLSearchParams();
    if (String(req.query.isDetails ?? "false") === "true") {
      params.set("isDetails", "true");
    }

    const endpoint = `/v1/market/all${params.size > 0 ? `?${params.toString()}` : ""}`;
    const response = await requestBithumb(endpoint);
    res.status(response.status).json(response.body);
  } catch (error) {
    next(error);
  }
});

app.get("/api/bithumb/ticker", async (req, res, next) => {
  try {
    const markets = normalizeMarkets(String(req.query.markets ?? ""));
    if (!markets) {
      res.status(400).json({ error: "Invalid markets" });
      return;
    }

    const endpoint = `/v1/ticker?${new URLSearchParams({ markets }).toString()}`;
    const response = await requestBithumb(endpoint);
    res.status(response.status).json(response.body);
  } catch (error) {
    next(error);
  }
});

app.get("/api/bithumb/orderbook", async (req, res, next) => {
  try {
    const markets = normalizeMarkets(String(req.query.markets ?? ""));
    if (!markets) {
      res.status(400).json({ error: "Invalid markets" });
      return;
    }

    const endpoint = `/v1/orderbook?${new URLSearchParams({ markets }).toString()}`;
    const response = await requestBithumb(endpoint);
    res.status(response.status).json(response.body);
  } catch (error) {
    next(error);
  }
});

app.get("/api/bithumb/candles/minutes", async (req, res, next) => {
  try {
    const unit = Number(req.query.unit ?? defaultAppSettings.bithumb.candleUnit);
    const market = normalizeMarket(String(req.query.market ?? defaultAppSettings.bithumb.testMarket));
    const count = clampInteger(Number(req.query.count ?? defaultAppSettings.bithumb.candleCount), 1, 200);
    const to = typeof req.query.to === "string" ? req.query.to.trim() : "";

    if (!supportedMinuteUnits.includes(unit as (typeof supportedMinuteUnits)[number]) || !market) {
      res.status(400).json({ error: "Invalid candle request" });
      return;
    }

    const params = new URLSearchParams({ market, count: String(count) });
    if (to) {
      params.set("to", to);
    }

    const endpoint = `/v1/candles/minutes/${unit}?${params.toString()}`;
    const response = await requestBithumb(endpoint);
    res.status(response.status).json(response.body);
  } catch (error) {
    next(error);
  }
});

app.get("/api/bithumb/private/status", async (_req, res, next) => {
  try {
    await loadLocalEnv();
    const accessKey = getBithumbAccessKey();
    res.json({
      configured: Boolean(accessKey && getBithumbSecretKey()),
      accessKey: maskSecret(accessKey),
      liveTrading: isLiveTradingEnabled(),
      envFilePath: path.relative(rootDir, localEnvFilePath)
    });
  } catch (error) {
    next(error);
  }
});

app.put("/api/bithumb/private/credentials", async (req, res, next) => {
  try {
    const body = isRecord(req.body) ? req.body : {};
    const accessKey = typeof body.accessKey === "string" ? body.accessKey.trim() : "";
    const secretKey = typeof body.secretKey === "string" ? body.secretKey.trim() : "";
    const liveTrading = body.liveTrading === true;

    if (!accessKey || !secretKey) {
      res.status(400).json({ error: "API Key and Secret Key are required" });
      return;
    }

    await writeLocalEnv({
      BITHUMB_ACCESS_KEY: accessKey,
      BITHUMB_SECRET_KEY: secretKey,
      BITHUMB_LIVE_TRADING: liveTrading ? "true" : "false"
    });
    await loadLocalEnv();

    res.json({
      configured: true,
      accessKey: maskSecret(accessKey),
      liveTrading: isLiveTradingEnabled(),
      envFilePath: path.relative(rootDir, localEnvFilePath)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/bithumb/private/accounts", async (_req, res, next) => {
  try {
    const response = await requestBithumbPrivate({ method: "GET", endpoint: "/v1/accounts" });
    res.status(response.status).json(response.body);
  } catch (error) {
    next(error);
  }
});

app.get("/api/bithumb/private/orders/chance", async (req, res, next) => {
  try {
    const market = normalizeMarket(String(req.query.market ?? defaultAppSettings.bithumb.testMarket));
    if (!market) {
      res.status(400).json({ error: "Invalid market" });
      return;
    }

    const response = await requestBithumbPrivate({
      method: "GET",
      endpoint: "/v1/orders/chance",
      params: { market }
    });
    res.status(response.status).json(response.body);
  } catch (error) {
    next(error);
  }
});

app.post("/api/bithumb/private/orders", async (req, res, next) => {
  try {
    const order = normalizeOrderRequest(req.body);

    if (!order.ok) {
      res.status(400).json({ error: order.error });
      return;
    }

    const liveTrading = isLiveTradingEnabled();
    const confirmLive = isRecord(req.body) && req.body.confirmLive === true;
    const clientOrderId = order.value.client_order_id ?? `slice-${Date.now()}`;
    const requestBody = {
      ...order.value,
      client_order_id: clientOrderId
    };

    if (!liveTrading || !confirmLive) {
      res.json({
        dryRun: true,
        liveTrading,
        endpoint: `${bithumbApiBaseUrl}/v2/orders`,
        request: requestBody,
        reason: liveTrading ? "confirmLive must be true" : "BITHUMB_LIVE_TRADING is not true"
      });
      return;
    }

    const response = await requestBithumbPrivate({
      method: "POST",
      endpoint: "/v2/orders",
      body: requestBody
    });
    res.status(response.status).json(response.body);
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "Unexpected error";
  res.status(500).json({ error: message });
});

app.listen(port, () => {
  console.log(`Backtest API listening on http://localhost:${port}`);
});

async function listDirectories(dir: string) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

async function readCandlesFile(filePath: string): Promise<RawBithumbCandle[]> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    return Array.isArray(parsed) ? (parsed as RawBithumbCandle[]) : [];
  } catch {
    return [];
  }
}

async function loadLocalEnv() {
  try {
    const content = await fs.readFile(localEnvFilePath, "utf8");
    const values = parseEnv(content);
    for (const [key, value] of Object.entries(values)) {
      process.env[key] = value;
    }
  } catch {
    // .env.local is optional.
  }
}

async function writeLocalEnv(nextValues: Record<string, string>) {
  const current = await readLocalEnvValues();
  const merged = { ...current, ...nextValues };
  const content = Object.entries(merged)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${quoteEnvValue(value)}`)
    .join("\n");

  await fs.writeFile(localEnvFilePath, `${content}\n`, "utf8");
}

async function readLocalEnvValues() {
  try {
    return parseEnv(await fs.readFile(localEnvFilePath, "utf8"));
  } catch {
    return {};
  }
}

async function requestBithumb(endpoint: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(`${bithumbApiBaseUrl}${endpoint}`, {
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    const contentType = response.headers.get("content-type") ?? "";
    const data = contentType.includes("application/json") ? await response.json() : await response.text();

    return {
      status: response.status,
      body: response.ok
        ? { endpoint: `${bithumbApiBaseUrl}${endpoint}`, data }
        : { endpoint: `${bithumbApiBaseUrl}${endpoint}`, error: "Bithumb API request failed", data }
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBithumbTradePrice(market: string): Promise<number> {
  const normalizedMarket = normalizeMarket(market);
  if (!normalizedMarket) {
    throw new Error("Invalid market");
  }

  const response = await requestBithumb(`/v1/ticker?${new URLSearchParams({ markets: normalizedMarket }).toString()}`);
  if (response.status < 200 || response.status >= 300) {
    throw new Error("Bithumb ticker request failed");
  }

  const data = isRecord(response.body) ? response.body.data : undefined;
  const ticker = Array.isArray(data) ? data[0] : undefined;
  const tradePrice = isRecord(ticker) ? Number(ticker.trade_price) : NaN;
  if (!Number.isFinite(tradePrice) || tradePrice <= 0) {
    throw new Error("Bithumb ticker response did not include trade_price");
  }

  return tradePrice;
}

async function requestBithumbPrivate({
  method,
  endpoint,
  params,
  body
}: {
  method: "GET" | "POST" | "DELETE";
  endpoint: string;
  params?: Record<string, string>;
  body?: Record<string, string>;
}) {
  await loadLocalEnv();
  const credentials = getBithumbCredentials();
  if (!credentials) {
    return {
      status: 401,
      body: { error: "Bithumb credentials are not configured" }
    };
  }

  const query = params ? new URLSearchParams(params).toString() : "";
  const requestPath = `${endpoint}${query ? `?${query}` : ""}`;
  const hashSource = body ? encodeParams(body) : query;
  const token = createBithumbJwt(credentials.accessKey, credentials.secretKey, hashSource);
  const response = await fetch(`${bithumbApiBaseUrl}${requestPath}`, {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const contentType = response.headers.get("content-type") ?? "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();

  return {
    status: response.status,
    body: response.ok
      ? { endpoint: `${bithumbApiBaseUrl}${requestPath}`, data }
      : { endpoint: `${bithumbApiBaseUrl}${requestPath}`, error: "Bithumb private API request failed", data }
  };
}

function createBithumbJwt(accessKey: string, secretKey: string, hashSource: string) {
  const payload: Record<string, string | number> = {
    access_key: accessKey,
    nonce: randomUUID(),
    timestamp: Date.now()
  };

  if (hashSource) {
    payload.query_hash = createHash("sha512").update(hashSource, "utf8").digest("hex");
    payload.query_hash_alg = "SHA512";
  }

  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac("sha256", secretKey).update(`${encodedHeader}.${encodedPayload}`).digest("base64url");
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function encodeParams(params: Record<string, string>) {
  return Object.entries(params)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function base64UrlEncode(value: string) {
  return Buffer.from(value).toString("base64url");
}

function normalizeMarkets(value: string) {
  const markets = value
    .split(",")
    .map((market) => normalizeMarket(market))
    .filter(Boolean);

  return markets.length > 0 ? markets.join(",") : "";
}

function normalizeMarket(value: string) {
  const market = value.trim().toUpperCase();
  return /^[A-Z0-9]+-[A-Z0-9]+$/.test(market) ? market : "";
}

function clampInteger(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(Number.isFinite(value) ? value : min)));
}

function getBithumbCredentials() {
  const accessKey = getBithumbAccessKey();
  const secretKey = getBithumbSecretKey();
  return accessKey && secretKey ? { accessKey, secretKey } : null;
}

function getBithumbAccessKey() {
  return process.env.BITHUMB_ACCESS_KEY?.trim() ?? "";
}

function getBithumbSecretKey() {
  return process.env.BITHUMB_SECRET_KEY?.trim() ?? "";
}

function isLiveTradingEnabled() {
  return process.env.BITHUMB_LIVE_TRADING === "true";
}

function maskSecret(value: string) {
  if (!value) {
    return "";
  }

  if (value.length <= 8) {
    return `${value.slice(0, 2)}****`;
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function parseEnv(content: string) {
  const values: Record<string, string> = {};

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const index = trimmed.indexOf("=");
    if (index === -1) {
      continue;
    }

    const key = trimmed.slice(0, index).trim();
    const rawValue = trimmed.slice(index + 1).trim();
    values[key] = unquoteEnvValue(rawValue);
  }

  return values;
}

function quoteEnvValue(value: string) {
  return JSON.stringify(value);
}

function unquoteEnvValue(value: string) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }

  return value;
}

function normalizeOrderRequest(value: unknown):
  | { ok: true; value: { market: string; side: string; order_type: string; price?: string; volume?: string; client_order_id?: string } }
  | { ok: false; error: string } {
  const body = isRecord(value) ? value : {};
  const market = normalizeMarket(String(body.market ?? ""));
  const side = String(body.side ?? "");
  const orderType = String(body.orderType ?? body.order_type ?? "");
  const price = normalizeDecimalString(body.price);
  const volume = normalizeDecimalString(body.volume);
  const clientOrderId = typeof body.clientOrderId === "string" ? body.clientOrderId.trim() : "";

  if (!market) {
    return { ok: false, error: "Invalid market" };
  }

  if (side !== "bid" && side !== "ask") {
    return { ok: false, error: "Invalid side" };
  }

  if (orderType !== "limit" && orderType !== "price" && orderType !== "market") {
    return { ok: false, error: "Invalid order type" };
  }

  if (clientOrderId && !/^[A-Za-z0-9_-]{1,36}$/.test(clientOrderId)) {
    return { ok: false, error: "Invalid client order id" };
  }

  if (orderType === "limit" && (!price || !volume)) {
    return { ok: false, error: "Limit orders require price and volume" };
  }

  if (orderType === "price" && (side !== "bid" || !price)) {
    return { ok: false, error: "Market buy orders require side=bid and price total" };
  }

  if (orderType === "market" && (side !== "ask" || !volume)) {
    return { ok: false, error: "Market sell orders require side=ask and volume" };
  }

  return {
    ok: true,
    value: {
      market,
      side,
      order_type: orderType,
      ...(price ? { price } : {}),
      ...(volume ? { volume } : {}),
      ...(clientOrderId ? { client_order_id: clientOrderId } : {})
    }
  };
}

function normalizePaperStrategyRequest(value: unknown):
  | {
      ok: true;
      value: {
        market: string;
        upperPrice: number;
        lowerPrice: number;
        slotCount: number;
        totalBudget: number;
        slotBudget: number;
        targetProfitRate: number;
        feeRate: number;
        slippageRate: number;
      };
    }
  | { ok: false; error: string } {
  const body = isRecord(value) ? value : {};
  const requestedMode = typeof body.mode === "string" ? body.mode.trim().toUpperCase() : "PAPER";
  if (requestedMode === "LIVE") {
    return { ok: false, error: "LIVE trading is disabled in this MVP" };
  }

  const market = normalizeMarket(String(body.market ?? ""));
  const upperPrice = positiveNumber(body.upperPrice);
  const lowerPrice = positiveNumber(body.lowerPrice);
  const slotCount = clampInteger(Number(body.slotCount ?? 7), 2, 20);
  const slotBudget = positiveNumber(body.slotBudget);
  const totalBudget = Number.isFinite(slotBudget) ? slotBudget * slotCount : positiveNumber(body.totalBudget);
  const targetProfitRate =
    body.targetProfitRate !== undefined
      ? nonNegativeNumber(body.targetProfitRate)
      : nonNegativeNumber(body.targetProfitPercent ?? 0.5) / 100;
  const feeRate =
    body.feeRate !== undefined
      ? nonNegativeNumber(body.feeRate)
      : nonNegativeNumber(body.feePercent ?? 0.04) / 100;
  const slippageRate =
    body.slippageRate !== undefined
      ? nonNegativeNumber(body.slippageRate)
      : nonNegativeNumber(body.slippagePercent ?? 0) / 100;

  if (!market) {
    return { ok: false, error: "Invalid market" };
  }

  if (!Number.isFinite(upperPrice) || !Number.isFinite(lowerPrice) || upperPrice <= lowerPrice) {
    return { ok: false, error: "Upper price must be greater than lower price" };
  }

  if (!Number.isFinite(totalBudget) || totalBudget <= 0) {
    return { ok: false, error: "Total budget must be greater than 0" };
  }

  if (!Number.isFinite(slotBudget) && !Number.isFinite(positiveNumber(body.totalBudget))) {
    return { ok: false, error: "Slot budget must be greater than 0" };
  }

  if (!Number.isFinite(targetProfitRate) || targetProfitRate <= 0) {
    return { ok: false, error: "Target profit rate must be greater than 0" };
  }

  if (!Number.isFinite(feeRate) || feeRate < 0 || !Number.isFinite(slippageRate) || slippageRate < 0) {
    return { ok: false, error: "Fee and slippage rates cannot be negative" };
  }

  return {
    ok: true,
    value: {
      market,
      upperPrice,
      lowerPrice,
      slotCount,
      totalBudget,
      slotBudget: Number.isFinite(slotBudget) ? slotBudget : totalBudget / slotCount,
      targetProfitRate,
      feeRate,
      slippageRate
    }
  };
}

function normalizeDecimalString(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") {
    return "";
  }

  const normalized = String(value).trim();
  return /^(0|[1-9]\d*)(\.\d+)?$/.test(normalized) && Number(normalized) > 0 ? normalized : "";
}

function positiveNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : NaN;
}

function nonNegativeNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : NaN;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

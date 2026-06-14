import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./db";
import type { BithumbClient, BithumbHttpResponse } from "./bithumbClient";
import type {
  BrokerCancelResult,
  BrokerExecutionResult,
  BrokerReconciliationResult,
  TradingBroker
} from "./tradingBroker";
import type { TradeDecision } from "./strategyEngine";
import type { Strategy, TradingOrder } from "./tradingRepository";
import { appendDecisionLog } from "./tradingRepository";

type BithumbClientLike = Pick<BithumbClient, "requestPublic" | "requestPrivate">;
type BithumbSide = "bid" | "ask";

interface BithumbOrderRequest {
  market: string;
  side: BithumbSide;
  order_type: "limit";
  price: string;
  volume: string;
  client_order_id: string;
}

export interface BithumbPreparedOrder {
  endpoint: "/v2/orders";
  request: BithumbOrderRequest;
  validation: {
    currentPrice: number;
    spreadRate: number;
    bestAskPrice: number;
    bestBidPrice: number;
    feeRate: number;
    orderTotal: number;
    requiredBalance: number;
    availableBalance: number;
    minTotal?: number;
    maxTotal?: number;
  };
}

export interface BithumbLiveBrokerOptions {
  client: BithumbClientLike;
  liveTradingEnabled: () => boolean;
  maxSpreadRate?: number;
  clientOrderIdPrefix?: string;
}

export class BithumbLiveBroker implements TradingBroker {
  readonly mode = "LIVE";
  private readonly maxSpreadRate: number;
  private readonly clientOrderIdPrefix: string;

  constructor(private readonly options: BithumbLiveBrokerOptions) {
    this.maxSpreadRate = options.maxSpreadRate ?? 0.01;
    this.clientOrderIdPrefix = options.clientOrderIdPrefix ?? "bth";
  }

  async executeDecision(
    db: SqliteDatabase,
    strategy: Strategy,
    decision: TradeDecision,
    currentPrice: number
  ): Promise<BrokerExecutionResult> {
    assertLiveStrategy(strategy);

    if (!this.options.liveTradingEnabled()) {
      appendDecisionLog(db, {
        strategyId: strategy.id,
        slotId: decision.slot.id,
        market: strategy.market,
        currentPrice,
        action: "HOLD",
        reason: "Bithumb live trading gate is disabled",
        snapshot: {
          mode: "LIVE",
          broker: "BITHUMB",
          decision: decision.action
        }
      });
      throw new Error("Bithumb live trading gate is disabled");
    }

    const prepared = await this.prepareDecisionOrder(strategy, decision, currentPrice);
    appendDecisionLog(db, {
      strategyId: strategy.id,
      slotId: decision.slot.id,
      market: strategy.market,
      currentPrice,
      action: "HOLD",
      reason: "Bithumb live order validated, but order placement is not implemented yet",
      snapshot: prepared
    });
    throw new Error("Bithumb live order placement is not implemented yet");
  }

  syncOpenOrders(
    db: SqliteDatabase,
    strategy: Strategy,
    _currentPrice: number,
    _now = new Date()
  ): BrokerExecutionResult[] {
    assertLiveStrategy(strategy);
    if (!this.options.liveTradingEnabled()) {
      appendDecisionLog(db, {
        strategyId: strategy.id,
        market: strategy.market,
        action: "HOLD",
        reason: "Bithumb live order sync skipped because live trading gate is disabled",
        snapshot: {
          mode: "LIVE",
          broker: "BITHUMB"
        }
      });
      return [];
    }

    throw new Error("Bithumb live broker is scaffolded, but order synchronization is not implemented yet");
  }

  cancelOrder(
    _db: SqliteDatabase,
    _strategy: Strategy,
    _order: TradingOrder,
    _reason: string
  ): BrokerCancelResult {
    assertLiveStrategy(_strategy);
    if (!this.options.liveTradingEnabled()) {
      throw new Error("Bithumb live trading gate is disabled");
    }

    throw new Error("Bithumb live broker is scaffolded, but order cancellation is not implemented yet");
  }

  reconcileAccount(_db: SqliteDatabase, strategy: Strategy, now = new Date()): BrokerReconciliationResult {
    assertLiveStrategy(strategy);

    return {
      mode: "LIVE",
      strategyId: strategy.id,
      checkedAt: now.toISOString(),
      openOrderCount: 0,
      adjustments: ["Bithumb account reconciliation is not implemented yet"]
    };
  }

  async prepareDecisionOrder(strategy: Strategy, decision: TradeDecision, currentPrice: number): Promise<BithumbPreparedOrder> {
    assertLiveStrategy(strategy);
    validateDecisionSlot(decision);

    const [chance, orderbook] = await Promise.all([
      this.fetchOrderChance(strategy.market),
      this.fetchOrderbook(strategy.market)
    ]);
    const side: BithumbSide = decision.action === "BUY" ? "bid" : "ask";
    assertLimitOrderSupported(chance, side);

    const firstUnit = getFirstOrderbookUnit(orderbook);
    const bestAskPrice = getPositiveNumber(firstUnit, "ask_price", "orderbook ask_price");
    const bestBidPrice = getPositiveNumber(firstUnit, "bid_price", "orderbook bid_price");
    const spreadRate = (bestAskPrice - bestBidPrice) / ((bestAskPrice + bestBidPrice) / 2);
    if (!Number.isFinite(spreadRate) || spreadRate < 0 || spreadRate > this.maxSpreadRate) {
      throw new Error(`Bithumb orderbook spread ${spreadRate} exceeds max ${this.maxSpreadRate}`);
    }

    const marketRules = getRecord(chance, "market");
    const account = getRecord(chance, side === "bid" ? "bid_account" : "ask_account");
    const feeRate = getOptionalNumber(chance, side === "bid" ? "bid_fee" : "ask_fee") ?? strategy.feeRate;
    const price = decision.action === "BUY" ? decision.slot.buyPrice : decision.slot.targetSellPrice;
    const grossAmount = decision.action === "BUY" ? decision.slot.budget / (1 + feeRate) : decision.slot.quantity * price;
    const volume = decision.action === "BUY" ? grossAmount / price : decision.slot.quantity;
    const orderTotal = price * volume;
    const minTotal = getNestedOptionalNumber(marketRules, side === "bid" ? ["bid", "min_total"] : ["ask", "min_total"]);
    const maxTotal = getOptionalNumber(marketRules, "max_total");
    const availableBalance = getOptionalNumber(account, "balance") ?? 0;
    const requiredBalance = decision.action === "BUY" ? decision.slot.budget : volume;

    if (orderTotal <= 0 || volume <= 0) {
      throw new Error("Bithumb order amount must be greater than 0");
    }

    if (minTotal !== undefined && orderTotal < minTotal) {
      throw new Error(`Bithumb order total ${orderTotal} is below min_total ${minTotal}`);
    }

    if (maxTotal !== undefined && orderTotal > maxTotal) {
      throw new Error(`Bithumb order total ${orderTotal} exceeds max_total ${maxTotal}`);
    }

    if (availableBalance < requiredBalance) {
      throw new Error(`Bithumb available balance ${availableBalance} is below required ${requiredBalance}`);
    }

    return {
      endpoint: "/v2/orders",
      request: {
        market: strategy.market,
        side,
        order_type: "limit",
        price: formatDecimal(price, 8),
        volume: formatDecimal(volume, 12),
        client_order_id: createBithumbClientOrderId(this.clientOrderIdPrefix, strategy.id, decision.slot.slotNumber, side)
      },
      validation: {
        currentPrice,
        spreadRate,
        bestAskPrice,
        bestBidPrice,
        feeRate,
        orderTotal,
        requiredBalance,
        availableBalance,
        ...(minTotal !== undefined ? { minTotal } : {}),
        ...(maxTotal !== undefined ? { maxTotal } : {})
      }
    };
  }

  private async fetchOrderChance(market: string): Promise<Record<string, unknown>> {
    const response = await this.options.client.requestPrivate({
      method: "GET",
      endpoint: "/v1/orders/chance",
      params: { market }
    });

    return unwrapRecordResponse(response, "Bithumb orders/chance request failed");
  }

  private async fetchOrderbook(market: string): Promise<Record<string, unknown>> {
    const response = await this.options.client.requestPublic(`/v1/orderbook?markets=${encodeURIComponent(market)}`);
    const data = unwrapResponseData(response, "Bithumb orderbook request failed");
    const orderbook = Array.isArray(data) ? data[0] : data;
    if (!isRecord(orderbook)) {
      throw new Error("Bithumb orderbook response is invalid");
    }

    return orderbook;
  }
}

function assertLiveStrategy(strategy: Strategy): void {
  if (strategy.mode !== "LIVE") {
    throw new Error("Bithumb broker can only execute LIVE strategies");
  }
}

function validateDecisionSlot(decision: TradeDecision): void {
  if (decision.action === "BUY" && decision.slot.status !== "EMPTY") {
    throw new Error(`Slot ${decision.slot.slotNumber} is not ready to buy`);
  }

  if (decision.action === "SELL" && decision.slot.status !== "HOLDING") {
    throw new Error(`Slot ${decision.slot.slotNumber} is not ready to sell`);
  }

  if (decision.action === "SELL" && decision.slot.quantity <= 0) {
    throw new Error(`Slot ${decision.slot.slotNumber} has no quantity to sell`);
  }
}

function assertLimitOrderSupported(chance: Record<string, unknown>, side: BithumbSide): void {
  const market = getRecord(chance, "market");
  const state = getOptionalString(market, "state");
  if (state && state.toLowerCase() !== "active") {
    throw new Error(`Bithumb market state is not active: ${state}`);
  }

  const typeKey = side === "bid" ? "bid_types" : "ask_types";
  const sideTypes = getOptionalStringArray(market, typeKey);
  const orderTypes = getOptionalStringArray(market, "order_types");
  const supportedTypes = sideTypes.length > 0 ? sideTypes : orderTypes;
  if (!supportedTypes.includes("limit")) {
    throw new Error(`Bithumb market does not support ${side} limit orders`);
  }
}

function unwrapRecordResponse(response: BithumbHttpResponse, errorMessage: string): Record<string, unknown> {
  const data = unwrapResponseData(response, errorMessage);
  if (!isRecord(data)) {
    throw new Error(`${errorMessage}: invalid response body`);
  }

  return data;
}

function unwrapResponseData(response: BithumbHttpResponse, errorMessage: string): unknown {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(errorMessage);
  }

  return response.body.data;
}

function getFirstOrderbookUnit(orderbook: Record<string, unknown>): Record<string, unknown> {
  const units = orderbook.orderbook_units;
  if (!Array.isArray(units) || !isRecord(units[0])) {
    throw new Error("Bithumb orderbook response did not include orderbook_units");
  }

  return units[0];
}

function getRecord(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key];
  if (!isRecord(value)) {
    throw new Error(`Bithumb response did not include ${key}`);
  }

  return value;
}

function getPositiveNumber(source: Record<string, unknown>, key: string, label: string): number {
  const value = getOptionalNumber(source, key);
  if (value === undefined || value <= 0) {
    throw new Error(`Bithumb response did not include valid ${label}`);
  }

  return value;
}

function getOptionalNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getNestedOptionalNumber(source: Record<string, unknown>, path: string[]): number | undefined {
  let current: unknown = source;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }

  const parsed = Number(current);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getOptionalString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

function getOptionalStringArray(source: Record<string, unknown>, key: string): string[] {
  const value = source[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function formatDecimal(value: number, maxDecimalPlaces: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Decimal value must be greater than 0");
  }

  return value.toFixed(maxDecimalPlaces).replace(/\.?0+$/, "");
}

function createBithumbClientOrderId(prefix: string, strategyId: string, slotNumber: number, side: BithumbSide): string {
  const normalizedPrefix = prefix.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 6) || "bth";
  const normalizedStrategyId = strategyId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8) || "strategy";
  const sideKey = side === "bid" ? "buy" : "sell";
  const timestamp = Date.now().toString(36);
  const suffix = randomUUID().replace(/-/g, "").slice(0, 4);
  return `${normalizedPrefix}-${normalizedStrategyId}-${slotNumber}-${sideKey}-${timestamp}-${suffix}`.slice(0, 36);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

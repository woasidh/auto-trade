import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./db";
import type {
  BrokerCancelResult,
  BrokerExecutionResult,
  BrokerReconciliationResult,
  TradingBroker
} from "./tradingBroker";
import type { Strategy, TradingOrder, TradingSlot } from "./tradingRepository";
import { appendDecisionLog, listOrders, listSlots, saveFill, saveOrder, saveSlot } from "./tradingRepository";
import { calculateTargetSellPrice } from "./strategyEngine";
import type { TradeDecision } from "./strategyEngine";

type BithumbSide = "bid" | "ask";
type BithumbOrderState = "wait" | "done" | "cancel";

const activeOrderStatuses = new Set<TradingOrder["status"]>(["ACCEPTED", "PARTIALLY_FILLED"]);
const orderType = "paper-limit";
const tinyAmount = 1e-8;

export type PaperExecutionResult = BrokerExecutionResult;

export class PaperBroker implements TradingBroker {
  readonly mode = "PAPER";

  executeDecision(db: SqliteDatabase, strategy: Strategy, decision: TradeDecision, currentPrice: number): PaperExecutionResult {
    const result = executePaperDecision(db, strategy, decision, currentPrice);
    if (!result) {
      throw new Error(`Paper ${decision.action.toLowerCase()} order could not be placed`);
    }

    return result;
  }

  syncOpenOrders(db: SqliteDatabase, strategy: Strategy, currentPrice: number, now = new Date()): PaperExecutionResult[] {
    return syncPaperStageOrders(db, strategy, currentPrice, now);
  }

  cancelOrder(db: SqliteDatabase, strategy: Strategy, order: TradingOrder, reason: string): BrokerCancelResult {
    return cancelPaperOrder(db, strategy, order, reason);
  }

  reconcileAccount(db: SqliteDatabase, strategy: Strategy, now = new Date()): BrokerReconciliationResult {
    assertPaperStrategy(strategy, "reconcile");
    const openOrderCount = listOrders(db, strategy.id).filter((order) => activeOrderStatuses.has(order.status)).length;

    return {
      mode: "PAPER",
      strategyId: strategy.id,
      checkedAt: now.toISOString(),
      openOrderCount,
      adjustments: []
    };
  }
}

export function executePaperDecision(db: SqliteDatabase, strategy: Strategy, decision: TradeDecision, currentPrice: number): PaperExecutionResult | undefined {
  assertPaperStrategy(strategy, "execute");

  const execute = db.transaction(() => {
    if (decision.action === "BUY") {
      return placePaperBuyOrder(db, strategy, decision.slot, currentPrice, decision.reason);
    }

    return placePaperSellOrder(db, strategy, decision.slot, currentPrice, decision.reason);
  });

  return execute();
}

export function syncPaperStageOrders(db: SqliteDatabase, strategy: Strategy, currentPrice: number, now = new Date()): PaperExecutionResult[] {
  assertPaperStrategy(strategy, "sync");

  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    throw new Error("Current price must be greater than 0");
  }

  const sync = db.transaction(() => {
    const results: PaperExecutionResult[] = [];
    results.push(...fillRestingPaperOrders(db, strategy, currentPrice, now));
    results.push(...ensurePaperStageOrders(db, strategy, currentPrice));

    return results;
  });

  return sync();
}

function fillRestingPaperOrders(db: SqliteDatabase, strategy: Strategy, currentPrice: number, now: Date): PaperExecutionResult[] {
  const slotsById = new Map(listSlots(db, strategy.id).map((slot) => [slot.id, slot]));
  const readyOrders = listOrders(db, strategy.id)
    .filter((order) => activeOrderStatuses.has(order.status) && isSupportedPaperOrder(order))
    .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));

  const results: PaperExecutionResult[] = [];
  for (const order of readyOrders) {
    if (!isPaperOrderFillable(order, currentPrice)) {
      continue;
    }

    const slot = slotsById.get(order.slotId);
    if (!slot) {
      continue;
    }

    const result = order.side === "BUY"
      ? fillPaperBuy(db, strategy, slot, order, currentPrice, now)
      : fillPaperSell(db, strategy, slot, order, currentPrice, now);
    results.push(result);

    const updatedSlot = listSlots(db, strategy.id).find((candidate) => candidate.id === order.slotId);
    if (updatedSlot) {
      slotsById.set(order.slotId, updatedSlot);
    }
  }

  return results;
}

function ensurePaperStageOrders(db: SqliteDatabase, strategy: Strategy, currentPrice: number): PaperExecutionResult[] {
  const results: PaperExecutionResult[] = [];
  const activeOrders = listOrders(db, strategy.id).filter((order) => activeOrderStatuses.has(order.status));
  const activeOrderKeySet = new Set(activeOrders.map((order) => createActiveOrderKey(order.slotId, order.side)));

  for (const slot of listSlots(db, strategy.id)) {
    if (slot.status === "EMPTY") {
      if (slot.buyPrice > currentPrice || activeOrderKeySet.has(createActiveOrderKey(slot.id, "BUY"))) {
        continue;
      }

      const result = placePaperBuyOrder(
        db,
        strategy,
        slot,
        currentPrice,
        `paper stage buy limit order placed for empty slot at ${slot.buyPrice}`
      );
      if (result) {
        activeOrderKeySet.add(createActiveOrderKey(slot.id, "BUY"));
        results.push(result);
      }
      continue;
    }

    if (slot.status === "HOLDING") {
      if (activeOrderKeySet.has(createActiveOrderKey(slot.id, "SELL"))) {
        continue;
      }

      const result = placePaperSellOrder(
        db,
        strategy,
        slot,
        currentPrice,
        `paper stage sell limit order placed for holding slot at ${slot.targetSellPrice}`
      );
      if (result) {
        activeOrderKeySet.add(createActiveOrderKey(slot.id, "SELL"));
        results.push(result);
      }
    }
  }

  return results;
}

function placePaperBuyOrder(db: SqliteDatabase, strategy: Strategy, slot: TradingSlot, currentPrice: number, reason: string): PaperExecutionResult | undefined {
  if (slot.status !== "EMPTY") {
    throw new Error(`Slot ${slot.slotNumber} is not ready to buy`);
  }

  const availableKrw = calculateAvailablePaperKrw(db, strategy);
  if (availableKrw + tinyAmount < slot.budget) {
    appendDecisionLog(db, {
      strategyId: strategy.id,
      slotId: slot.id,
      market: strategy.market,
      currentPrice,
      action: "HOLD",
      reason: `paper stage buy order skipped because available KRW ${availableKrw} is below required ${slot.budget}`,
      snapshot: {
        mode: "PAPER_STAGE",
        slotNumber: slot.slotNumber,
        availableKrw,
        requiredKrw: slot.budget
      }
    });
    return undefined;
  }

  const now = new Date().toISOString();
  const orderId = randomUUID();
  const brokerOrderId = `paper-${orderId}`;
  const clientOrderId = createPaperClientOrderId(strategy.id, slot.slotNumber, "bid");
  const price = slot.buyPrice;
  const grossAmount = slot.budget / (1 + strategy.feeRate);
  const quantity = grossAmount / price;
  const request = createBithumbOrderRequest(strategy.market, "bid", price, quantity, clientOrderId);
  const order = saveOrder(db, {
    id: orderId,
    strategyId: strategy.id,
    slotId: slot.id,
    brokerOrderId,
    clientOrderId,
    market: strategy.market,
    side: "BUY",
    orderType,
    price,
    quantity,
    amount: slot.budget,
    status: "ACCEPTED",
    requestedAt: now,
    acceptedAt: now,
    rawRequest: {
      mode: "PAPER_STAGE",
      endpoint: "/v2/orders",
      request,
      reason,
      validation: {
        currentPrice,
        availableKrw,
        requiredKrw: slot.budget,
        feeRate: strategy.feeRate
      }
    },
    rawResponse: createBithumbOrderSnapshot({
      brokerOrderId,
      clientOrderId,
      market: strategy.market,
      side: "bid",
      price,
      volume: quantity,
      remainingVolume: quantity,
      executedVolume: 0,
      executedFunds: 0,
      paidFee: 0,
      locked: slot.budget,
      state: "wait",
      createdAt: now,
      updatedAt: now
    })
  });

  saveSlot(db, {
    ...slot,
    status: "BUY_PENDING",
    currentOrderId: order.id
  });
  appendDecisionLog(db, {
    strategyId: strategy.id,
    slotId: slot.id,
    orderId: order.id,
    market: strategy.market,
    currentPrice,
    action: "BUY",
    reason,
    snapshot: {
      mode: "PAPER_STAGE",
      slotNumber: slot.slotNumber,
      orderStatus: "ACCEPTED",
      bithumbState: "wait",
      limitPrice: price,
      quantity,
      lockedKrw: slot.budget
    }
  });

  return { orderId: order.id, slotId: slot.id };
}

function placePaperSellOrder(db: SqliteDatabase, strategy: Strategy, slot: TradingSlot, currentPrice: number, reason: string): PaperExecutionResult | undefined {
  if (slot.status !== "HOLDING") {
    throw new Error(`Slot ${slot.slotNumber} is not ready to sell`);
  }

  if (slot.quantity <= 0) {
    throw new Error(`Slot ${slot.slotNumber} has no quantity to sell`);
  }

  const now = new Date().toISOString();
  const orderId = randomUUID();
  const brokerOrderId = `paper-${orderId}`;
  const clientOrderId = createPaperClientOrderId(strategy.id, slot.slotNumber, "ask");
  const price = slot.targetSellPrice;
  const grossAmount = slot.quantity * price;
  const request = createBithumbOrderRequest(strategy.market, "ask", price, slot.quantity, clientOrderId);
  const order = saveOrder(db, {
    id: orderId,
    strategyId: strategy.id,
    slotId: slot.id,
    brokerOrderId,
    clientOrderId,
    market: strategy.market,
    side: "SELL",
    orderType,
    price,
    quantity: slot.quantity,
    amount: grossAmount,
    status: "ACCEPTED",
    requestedAt: now,
    acceptedAt: now,
    rawRequest: {
      mode: "PAPER_STAGE",
      endpoint: "/v2/orders",
      request,
      reason,
      validation: {
        currentPrice,
        availableQuantity: slot.quantity,
        requiredQuantity: slot.quantity,
        feeRate: strategy.feeRate
      }
    },
    rawResponse: createBithumbOrderSnapshot({
      brokerOrderId,
      clientOrderId,
      market: strategy.market,
      side: "ask",
      price,
      volume: slot.quantity,
      remainingVolume: slot.quantity,
      executedVolume: 0,
      executedFunds: 0,
      paidFee: 0,
      locked: slot.quantity,
      state: "wait",
      createdAt: now,
      updatedAt: now
    })
  });

  saveSlot(db, {
    ...slot,
    status: "SELL_PENDING",
    currentOrderId: order.id
  });
  appendDecisionLog(db, {
    strategyId: strategy.id,
    slotId: slot.id,
    orderId: order.id,
    market: strategy.market,
    currentPrice,
    action: "SELL",
    reason,
    snapshot: {
      mode: "PAPER_STAGE",
      slotNumber: slot.slotNumber,
      orderStatus: "ACCEPTED",
      bithumbState: "wait",
      limitPrice: price,
      quantity: slot.quantity,
      lockedQuantity: slot.quantity
    }
  });

  return { orderId: order.id, slotId: slot.id };
}

function fillPaperBuy(db: SqliteDatabase, strategy: Strategy, slot: TradingSlot, order: TradingOrder, currentPrice: number, now: Date): PaperExecutionResult {
  if (slot.status !== "BUY_PENDING" || slot.currentOrderId !== order.id) {
    throw new Error(`Slot ${slot.slotNumber} is not waiting for buy order ${order.id}`);
  }

  const nowIso = now.toISOString();
  const fillId = randomUUID();
  const fillPrice = getPaperFillPrice(order, currentPrice);
  const quantity = order.quantity ?? (order.amount ?? slot.budget) / (1 + strategy.feeRate) / fillPrice;
  const grossAmount = quantity * fillPrice;
  const amount = order.amount ?? grossAmount * (1 + strategy.feeRate);
  const fee = Math.max(0, amount - grossAmount);
  const brokerOrderId = order.brokerOrderId ?? `paper-${order.id}`;
  const filledOrder = saveOrder(db, {
    ...order,
    brokerOrderId,
    price: fillPrice,
    quantity,
    amount,
    status: "FILLED",
    acceptedAt: order.acceptedAt,
    rawRequest: order.rawRequest,
    rawResponse: createBithumbOrderSnapshot({
      brokerOrderId,
      clientOrderId: order.clientOrderId,
      market: strategy.market,
      side: "bid",
      price: fillPrice,
      volume: quantity,
      remainingVolume: 0,
      executedVolume: quantity,
      executedFunds: grossAmount,
      paidFee: fee,
      locked: 0,
      state: "done",
      createdAt: order.acceptedAt ?? order.requestedAt,
      updatedAt: nowIso
    })
  });
  const fill = saveFill(db, {
    id: fillId,
    orderId: filledOrder.id,
    strategyId: strategy.id,
    slotId: slot.id,
    brokerFillId: `paper-fill-${fillId}`,
    price: fillPrice,
    quantity,
    fee,
    filledAt: nowIso,
    rawResponse: {
      mode: "PAPER_STAGE",
      order_id: brokerOrderId,
      side: "bid",
      price: formatDecimal(fillPrice, 8),
      volume: formatDecimal(quantity, 12),
      funds: formatDecimal(grossAmount, 8),
      fee: formatDecimal(fee, 8)
    }
  });

  saveSlot(db, {
    ...slot,
    status: "HOLDING",
    entryPrice: fillPrice,
    targetSellPrice: calculateTargetSellPrice(strategy, fillPrice),
    quantity,
    entryGrossAmount: grossAmount,
    entryFee: fee,
    currentOrderId: undefined,
    lastBuyAt: nowIso
  });
  appendDecisionLog(db, {
    strategyId: strategy.id,
    slotId: slot.id,
    orderId: filledOrder.id,
    market: strategy.market,
    currentPrice,
    action: "BUY",
    reason: "paper stage buy limit order filled by mock exchange",
    snapshot: {
      mode: "PAPER_STAGE",
      slotNumber: slot.slotNumber,
      requestedPrice: order.price,
      fillPrice,
      targetSellPrice: calculateTargetSellPrice(strategy, fillPrice),
      quantity,
      fee,
      bithumbState: "done"
    }
  });

  return { orderId: filledOrder.id, fillId: fill.id, slotId: slot.id };
}

function fillPaperSell(db: SqliteDatabase, strategy: Strategy, slot: TradingSlot, order: TradingOrder, currentPrice: number, now: Date): PaperExecutionResult {
  if (slot.status !== "SELL_PENDING" || slot.currentOrderId !== order.id) {
    throw new Error(`Slot ${slot.slotNumber} is not waiting for sell order ${order.id}`);
  }

  const quantity = order.quantity ?? slot.quantity;
  if (quantity <= 0) {
    throw new Error(`Slot ${slot.slotNumber} has no quantity to sell`);
  }

  const nowIso = now.toISOString();
  const fillId = randomUUID();
  const fillPrice = getPaperFillPrice(order, currentPrice);
  const grossAmount = quantity * fillPrice;
  const fee = grossAmount * strategy.feeRate;
  const brokerOrderId = order.brokerOrderId ?? `paper-${order.id}`;
  const filledOrder = saveOrder(db, {
    ...order,
    brokerOrderId,
    price: fillPrice,
    quantity,
    amount: grossAmount,
    status: "FILLED",
    acceptedAt: order.acceptedAt,
    rawRequest: order.rawRequest,
    rawResponse: createBithumbOrderSnapshot({
      brokerOrderId,
      clientOrderId: order.clientOrderId,
      market: strategy.market,
      side: "ask",
      price: fillPrice,
      volume: quantity,
      remainingVolume: 0,
      executedVolume: quantity,
      executedFunds: grossAmount,
      paidFee: fee,
      locked: 0,
      state: "done",
      createdAt: order.acceptedAt ?? order.requestedAt,
      updatedAt: nowIso
    })
  });
  const fill = saveFill(db, {
    id: fillId,
    orderId: filledOrder.id,
    strategyId: strategy.id,
    slotId: slot.id,
    brokerFillId: `paper-fill-${fillId}`,
    price: fillPrice,
    quantity,
    fee,
    filledAt: nowIso,
    rawResponse: {
      mode: "PAPER_STAGE",
      order_id: brokerOrderId,
      side: "ask",
      price: formatDecimal(fillPrice, 8),
      volume: formatDecimal(quantity, 12),
      funds: formatDecimal(grossAmount, 8),
      fee: formatDecimal(fee, 8)
    }
  });

  saveSlot(db, {
    ...slot,
    status: "EMPTY",
    entryPrice: undefined,
    quantity: 0,
    entryGrossAmount: 0,
    entryFee: 0,
    currentOrderId: undefined,
    lastSellAt: nowIso
  });
  appendDecisionLog(db, {
    strategyId: strategy.id,
    slotId: slot.id,
    orderId: filledOrder.id,
    market: strategy.market,
    currentPrice,
    action: "SELL",
    reason: "paper stage sell limit order filled by mock exchange",
    snapshot: {
      mode: "PAPER_STAGE",
      slotNumber: slot.slotNumber,
      requestedPrice: order.price,
      fillPrice,
      quantity,
      fee,
      grossAmount,
      bithumbState: "done"
    }
  });

  return { orderId: filledOrder.id, fillId: fill.id, slotId: slot.id };
}

function calculateAvailablePaperKrw(db: SqliteDatabase, strategy: Strategy): number {
  const allocated = listSlots(db, strategy.id).reduce((sum, slot) => {
    if (slot.status === "BUY_PENDING") {
      const order = slot.currentOrderId ? listOrders(db, strategy.id).find((candidate) => candidate.id === slot.currentOrderId) : undefined;
      return sum + (activeOrderStatuses.has(order?.status ?? "UNKNOWN") ? order?.amount ?? slot.budget : slot.budget);
    }

    if (slot.status === "HOLDING" || slot.status === "SELL_PENDING") {
      return sum + (slot.entryGrossAmount + slot.entryFee || slot.budget);
    }

    return sum;
  }, 0);

  return Math.max(0, strategy.totalBudget - allocated);
}

function isSupportedPaperOrder(order: TradingOrder): boolean {
  return order.orderType === orderType || order.orderType === "paper-market";
}

function isPaperOrderFillable(order: TradingOrder, currentPrice: number): boolean {
  if (order.orderType === "paper-market") {
    return true;
  }

  const limitPrice = order.price;
  if (!limitPrice) {
    return false;
  }

  return order.side === "BUY" ? currentPrice <= limitPrice : currentPrice >= limitPrice;
}

function getPaperFillPrice(order: TradingOrder, currentPrice: number): number {
  return order.orderType === orderType && order.price ? order.price : currentPrice;
}

export function cancelPaperOrder(db: SqliteDatabase, strategy: Strategy, order: TradingOrder, reason = "paper order canceled"): BrokerCancelResult {
  assertPaperStrategy(strategy, "cancel");

  const cancel = db.transaction(() => {
    const slot = listSlots(db, strategy.id).find((candidate) => candidate.id === order.slotId);
    if (!slot) {
      throw new Error(`Slot not found for paper order ${order.id}`);
    }

    if (!activeOrderStatuses.has(order.status)) {
      appendDecisionLog(db, {
        strategyId: strategy.id,
        slotId: slot.id,
        orderId: order.id,
        market: strategy.market,
        action: "HOLD",
        reason: `paper order ${order.id} was not canceled because status is ${order.status}`,
        snapshot: {
          mode: "PAPER_STAGE",
          orderStatus: order.status,
          requestedReason: reason
        }
      });

      return { orderId: order.id, slotId: slot.id, canceled: false };
    }

    const nowIso = new Date().toISOString();
    const brokerOrderId = order.brokerOrderId ?? `paper-${order.id}`;
    const remainingVolume = order.quantity ?? 0;
    const canceledOrder = saveOrder(db, {
      ...order,
      brokerOrderId,
      status: "CANCELED",
      acceptedAt: order.acceptedAt,
      rawRequest: order.rawRequest,
      rawResponse: createBithumbOrderSnapshot({
        brokerOrderId,
        clientOrderId: order.clientOrderId,
        market: order.market,
        side: order.side === "BUY" ? "bid" : "ask",
        price: order.price ?? 0,
        volume: order.quantity ?? 0,
        remainingVolume,
        executedVolume: 0,
        executedFunds: 0,
        paidFee: 0,
        locked: 0,
        state: "cancel",
        createdAt: order.acceptedAt ?? order.requestedAt,
        updatedAt: nowIso,
        reason
      }),
      errorMessage: reason
    });

    saveSlot(db, {
      ...slot,
      status: order.side === "BUY" ? "EMPTY" : "HOLDING",
      currentOrderId: undefined
    });
    appendDecisionLog(db, {
      strategyId: strategy.id,
      slotId: slot.id,
      orderId: canceledOrder.id,
      market: strategy.market,
      action: "HOLD",
      reason,
      snapshot: {
        mode: "PAPER_STAGE",
        orderStatus: "CANCELED",
        bithumbState: "cancel",
        side: order.side
      }
    });

    return { orderId: canceledOrder.id, slotId: slot.id, canceled: true };
  });

  return cancel();
}

function createBithumbOrderRequest(market: string, side: BithumbSide, price: number, volume: number, clientOrderId: string) {
  return {
    market,
    side,
    order_type: "limit",
    price: formatDecimal(price, 8),
    volume: formatDecimal(volume, 12),
    client_order_id: clientOrderId
  };
}

function createBithumbOrderSnapshot(input: {
  brokerOrderId: string;
  clientOrderId: string;
  market: string;
  side: BithumbSide;
  price: number;
  volume: number;
  remainingVolume: number;
  executedVolume: number;
  executedFunds: number;
  paidFee: number;
  locked: number;
  state: BithumbOrderState;
  createdAt: string;
  updatedAt: string;
  reason?: string;
}) {
  return {
    mode: "PAPER_STAGE",
    order_id: input.brokerOrderId,
    uuid: input.brokerOrderId,
    client_order_id: input.clientOrderId,
    market: input.market,
    side: input.side,
    order_type: "limit",
    ord_type: "limit",
    price: formatDecimal(input.price, 8),
    volume: formatDecimal(input.volume, 12),
    remaining_volume: formatDecimal(input.remainingVolume, 12),
    executed_volume: formatDecimal(input.executedVolume, 12),
    executed_funds: formatDecimal(input.executedFunds, 8),
    paid_fee: formatDecimal(input.paidFee, 8),
    locked: formatDecimal(input.locked, 12),
    state: input.state,
    trades_count: input.executedVolume > 0 ? 1 : 0,
    created_at: input.createdAt,
    updated_at: input.updatedAt,
    ...(input.reason ? { reason: input.reason } : {})
  };
}

function createActiveOrderKey(slotId: string, side: TradingOrder["side"]): string {
  return `${slotId}:${side}`;
}

function createPaperClientOrderId(strategyId: string, slotNumber: number, side: BithumbSide): string {
  return `p-${strategyId.slice(0, 8)}-${slotNumber}-${side[0]}-${randomUUID().slice(0, 12)}`;
}

function formatDecimal(value: number, maxFractionDigits: number) {
  const fixed = value.toFixed(maxFractionDigits);
  const trimmed = fixed.replace(/\.?0+$/, "");
  return trimmed === "-0" || trimmed === "" ? "0" : trimmed;
}

function assertPaperStrategy(strategy: Strategy, operation: string): void {
  if (strategy.mode !== "PAPER") {
    throw new Error(`Paper broker can only ${operation} PAPER strategies`);
  }
}

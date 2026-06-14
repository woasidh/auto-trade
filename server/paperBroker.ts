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

export const paperFillDelayMs = 5_000;

export type PaperExecutionResult = BrokerExecutionResult;

export class PaperBroker implements TradingBroker {
  readonly mode = "PAPER";

  executeDecision(db: SqliteDatabase, strategy: Strategy, decision: TradeDecision, currentPrice: number): PaperExecutionResult {
    return executePaperDecision(db, strategy, decision, currentPrice);
  }

  syncOpenOrders(db: SqliteDatabase, strategy: Strategy, currentPrice: number, now = new Date()): PaperExecutionResult[] {
    return syncReadyPaperOrders(db, strategy, currentPrice, now);
  }

  cancelOrder(db: SqliteDatabase, strategy: Strategy, order: TradingOrder, reason: string): BrokerCancelResult {
    return cancelPaperOrder(db, strategy, order, reason);
  }

  reconcileAccount(db: SqliteDatabase, strategy: Strategy, now = new Date()): BrokerReconciliationResult {
    assertPaperStrategy(strategy, "reconcile");
    const openOrderCount = listOrders(db, strategy.id).filter((order) => order.status === "ACCEPTED").length;

    return {
      mode: "PAPER",
      strategyId: strategy.id,
      checkedAt: now.toISOString(),
      openOrderCount,
      adjustments: []
    };
  }
}

export function executePaperDecision(db: SqliteDatabase, strategy: Strategy, decision: TradeDecision, currentPrice: number): PaperExecutionResult {
  assertPaperStrategy(strategy, "execute");

  const execute = db.transaction(() => {
    if (decision.action === "BUY") {
      return acceptPaperBuy(db, strategy, decision.slot, currentPrice, decision.reason);
    }

    return acceptPaperSell(db, strategy, decision.slot, currentPrice, decision.reason);
  });

  return execute();
}

export function syncReadyPaperOrders(db: SqliteDatabase, strategy: Strategy, currentPrice: number, now = new Date()): PaperExecutionResult[] {
  assertPaperStrategy(strategy, "sync");

  const sync = db.transaction(() => {
    const slotsById = new Map(listSlots(db, strategy.id).map((slot) => [slot.id, slot]));
    const readyOrders = listOrders(db, strategy.id)
      .filter((order) => order.status === "ACCEPTED" && isPaperOrderReady(order, now) && isSupportedPaperOrder(order))
      .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));

    const results: PaperExecutionResult[] = [];
    for (const order of readyOrders) {
      const slot = slotsById.get(order.slotId);
      if (!slot) {
        continue;
      }

      const result = isPaperOrderFillable(order, currentPrice)
        ? order.side === "BUY"
          ? fillPaperBuy(db, strategy, slot, order, currentPrice, now)
          : fillPaperSell(db, strategy, slot, order, currentPrice, now)
        : cancelUnfilledPaperOrder(db, strategy, slot, order, currentPrice, now);
      results.push(result);
      const updatedSlot = listSlots(db, strategy.id).find((candidate) => candidate.id === order.slotId);
      if (updatedSlot) {
        slotsById.set(order.slotId, updatedSlot);
      }
    }

    return results;
  });

  return sync();
}

function acceptPaperBuy(db: SqliteDatabase, strategy: Strategy, slot: TradingSlot, currentPrice: number, reason: string): PaperExecutionResult {
  if (slot.status !== "EMPTY") {
    throw new Error(`Slot ${slot.slotNumber} is not ready to buy`);
  }

  const now = new Date().toISOString();
  const orderId = randomUUID();
  const clientOrderId = createPaperClientOrderId(strategy.id, slot.slotNumber, "buy");
  const order = saveOrder(db, {
    id: orderId,
    strategyId: strategy.id,
    slotId: slot.id,
    brokerOrderId: `paper-${orderId}`,
    clientOrderId,
    market: strategy.market,
    side: "BUY",
    orderType: "paper-limit",
    price: slot.buyPrice,
    amount: slot.budget,
    status: "ACCEPTED",
    requestedAt: now,
    acceptedAt: now,
    rawRequest: {
      mode: "PAPER",
      action: "BUY",
      reason,
      orderType: "paper-limit",
      fillDelayMs: paperFillDelayMs
    },
    rawResponse: {
      accepted: true,
      limitPrice: slot.buyPrice,
      fillAfter: new Date(new Date(now).getTime() + paperFillDelayMs).toISOString()
    }
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
      mode: "PAPER",
      slotNumber: slot.slotNumber,
      orderStatus: "ACCEPTED",
      limitPrice: slot.buyPrice,
      fillDelayMs: paperFillDelayMs
    }
  });

  return { orderId: order.id, slotId: slot.id };
}

function acceptPaperSell(db: SqliteDatabase, strategy: Strategy, slot: TradingSlot, currentPrice: number, reason: string): PaperExecutionResult {
  if (slot.status !== "HOLDING") {
    throw new Error(`Slot ${slot.slotNumber} is not ready to sell`);
  }

  if (slot.quantity <= 0) {
    throw new Error(`Slot ${slot.slotNumber} has no quantity to sell`);
  }

  const now = new Date().toISOString();
  const orderId = randomUUID();
  const grossAmount = slot.quantity * slot.targetSellPrice;
  const clientOrderId = createPaperClientOrderId(strategy.id, slot.slotNumber, "sell");
  const order = saveOrder(db, {
    id: orderId,
    strategyId: strategy.id,
    slotId: slot.id,
    brokerOrderId: `paper-${orderId}`,
    clientOrderId,
    market: strategy.market,
    side: "SELL",
    orderType: "paper-limit",
    price: slot.targetSellPrice,
    quantity: slot.quantity,
    amount: grossAmount,
    status: "ACCEPTED",
    requestedAt: now,
    acceptedAt: now,
    rawRequest: {
      mode: "PAPER",
      action: "SELL",
      reason,
      orderType: "paper-limit",
      fillDelayMs: paperFillDelayMs
    },
    rawResponse: {
      accepted: true,
      limitPrice: slot.targetSellPrice,
      fillAfter: new Date(new Date(now).getTime() + paperFillDelayMs).toISOString()
    }
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
      mode: "PAPER",
      slotNumber: slot.slotNumber,
      orderStatus: "ACCEPTED",
      limitPrice: slot.targetSellPrice,
      fillDelayMs: paperFillDelayMs
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
  const amount = order.amount ?? slot.budget;
  const fillPrice = getPaperFillPrice(order, currentPrice);
  const grossAmount = amount / (1 + strategy.feeRate);
  const fee = amount - grossAmount;
  const quantity = grossAmount / fillPrice;
  const filledOrder = saveOrder(db, {
    ...order,
    price: fillPrice,
    quantity,
    amount,
    status: "FILLED",
    acceptedAt: order.acceptedAt,
    rawRequest: order.rawRequest,
    rawResponse: {
      mode: "PAPER",
      filled: true,
      requestedPrice: order.price,
      fillPrice,
      quantity,
      fee,
      filledAt: nowIso
    }
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
      mode: "PAPER",
      side: "BUY"
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
    currentPrice: fillPrice,
    action: "BUY",
    reason: "paper buy order filled after 5 seconds",
    snapshot: {
      mode: "PAPER",
      slotNumber: slot.slotNumber,
      requestedPrice: order.price,
      fillPrice,
      targetSellPrice: calculateTargetSellPrice(strategy, fillPrice),
      quantity,
      fee
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
  const filledOrder = saveOrder(db, {
    ...order,
    price: fillPrice,
    quantity,
    amount: grossAmount,
    status: "FILLED",
    acceptedAt: order.acceptedAt,
    rawRequest: order.rawRequest,
    rawResponse: {
      mode: "PAPER",
      filled: true,
      requestedPrice: order.price,
      fillPrice,
      quantity,
      fee,
      grossAmount,
      filledAt: nowIso
    }
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
      mode: "PAPER",
      side: "SELL"
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
    currentPrice: fillPrice,
    action: "SELL",
    reason: "paper sell order filled after 5 seconds",
    snapshot: {
      mode: "PAPER",
      slotNumber: slot.slotNumber,
      requestedPrice: order.price,
      fillPrice,
      quantity,
      fee,
      grossAmount
    }
  });

  return { orderId: filledOrder.id, fillId: fill.id, slotId: slot.id };
}

function isPaperOrderReady(order: TradingOrder, now: Date): boolean {
  const acceptedAt = new Date(order.acceptedAt ?? order.requestedAt).getTime();
  return Number.isFinite(acceptedAt) && now.getTime() - acceptedAt >= paperFillDelayMs;
}

function isSupportedPaperOrder(order: TradingOrder): boolean {
  return order.orderType === "paper-limit" || order.orderType === "paper-market";
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
  return order.orderType === "paper-limit" && order.price ? order.price : currentPrice;
}

function cancelUnfilledPaperOrder(db: SqliteDatabase, strategy: Strategy, slot: TradingSlot, order: TradingOrder, currentPrice: number, now: Date): PaperExecutionResult {
  const nowIso = now.toISOString();
  const canceledOrder = saveOrder(db, {
    ...order,
    status: "CANCELED",
    acceptedAt: order.acceptedAt,
    rawRequest: order.rawRequest,
    rawResponse: {
      mode: "PAPER",
      canceled: true,
      limitPrice: order.price,
      currentPrice,
      canceledAt: nowIso,
      reason: "paper limit order was not fillable after the delay"
    },
    errorMessage: "Paper limit order was not fillable after the delay"
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
    currentPrice,
    action: "HOLD",
    reason: `paper ${order.side.toLowerCase()} limit order canceled because current price ${currentPrice} did not satisfy limit price ${order.price}`,
    snapshot: {
      mode: "PAPER",
      slotNumber: slot.slotNumber,
      orderStatus: "CANCELED",
      side: order.side,
      limitPrice: order.price
    }
  });

  return { orderId: canceledOrder.id, slotId: slot.id };
}

export function cancelPaperOrder(db: SqliteDatabase, strategy: Strategy, order: TradingOrder, reason = "paper order canceled"): BrokerCancelResult {
  assertPaperStrategy(strategy, "cancel");

  const cancel = db.transaction(() => {
    const slot = listSlots(db, strategy.id).find((candidate) => candidate.id === order.slotId);
    if (!slot) {
      throw new Error(`Slot not found for paper order ${order.id}`);
    }

    if (order.status !== "ACCEPTED") {
      appendDecisionLog(db, {
        strategyId: strategy.id,
        slotId: slot.id,
        orderId: order.id,
        market: strategy.market,
        action: "HOLD",
        reason: `paper order ${order.id} was not canceled because status is ${order.status}`,
        snapshot: {
          mode: "PAPER",
          orderStatus: order.status,
          requestedReason: reason
        }
      });

      return { orderId: order.id, slotId: slot.id, canceled: false };
    }

    const nowIso = new Date().toISOString();
    const canceledOrder = saveOrder(db, {
      ...order,
      status: "CANCELED",
      acceptedAt: order.acceptedAt,
      rawRequest: order.rawRequest,
      rawResponse: {
        mode: "PAPER",
        canceled: true,
        canceledAt: nowIso,
        reason
      },
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
        mode: "PAPER",
        orderStatus: "CANCELED",
        side: order.side
      }
    });

    return { orderId: canceledOrder.id, slotId: slot.id, canceled: true };
  });

  return cancel();
}

function createPaperClientOrderId(strategyId: string, slotNumber: number, side: "buy" | "sell"): string {
  return `paper-${strategyId.slice(0, 8)}-${slotNumber}-${side}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function assertPaperStrategy(strategy: Strategy, operation: string): void {
  if (strategy.mode !== "PAPER") {
    throw new Error(`Paper broker can only ${operation} PAPER strategies`);
  }
}

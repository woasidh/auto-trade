import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./db";
import type { Strategy, TradingSlot } from "./tradingRepository";
import { appendDecisionLog, saveFill, saveOrder, saveSlot } from "./tradingRepository";
import type { TradeDecision } from "./strategyEngine";

export interface PaperExecutionResult {
  orderId: string;
  fillId: string;
  slotId: string;
}

export function executePaperDecision(db: SqliteDatabase, strategy: Strategy, decision: TradeDecision, currentPrice: number): PaperExecutionResult {
  if (strategy.mode !== "PAPER") {
    throw new Error("Paper broker can only execute PAPER strategies");
  }

  const execute = db.transaction(() => {
    if (decision.action === "BUY") {
      return executePaperBuy(db, strategy, decision.slot, currentPrice, decision.reason);
    }

    return executePaperSell(db, strategy, decision.slot, currentPrice, decision.reason);
  });

  return execute();
}

function executePaperBuy(db: SqliteDatabase, strategy: Strategy, slot: TradingSlot, currentPrice: number, reason: string): PaperExecutionResult {
  const now = new Date().toISOString();
  const orderId = randomUUID();
  const fillId = randomUUID();
  const grossAmount = slot.budget / (1 + strategy.feeRate);
  const fee = slot.budget - grossAmount;
  const quantity = grossAmount / currentPrice;
  const clientOrderId = createPaperClientOrderId(strategy.id, slot.slotNumber, "buy");

  const order = saveOrder(db, {
    id: orderId,
    strategyId: strategy.id,
    slotId: slot.id,
    brokerOrderId: `paper-${orderId}`,
    clientOrderId,
    market: strategy.market,
    side: "BUY",
    orderType: "paper-market",
    price: currentPrice,
    quantity,
    amount: slot.budget,
    status: "FILLED",
    requestedAt: now,
    acceptedAt: now,
    rawRequest: {
      mode: "PAPER",
      action: "BUY",
      reason
    },
    rawResponse: {
      filled: true,
      price: currentPrice,
      quantity,
      fee
    }
  });
  const fill = saveFill(db, {
    id: fillId,
    orderId: order.id,
    strategyId: strategy.id,
    slotId: slot.id,
    brokerFillId: `paper-fill-${fillId}`,
    price: currentPrice,
    quantity,
    fee,
    filledAt: now,
    rawResponse: {
      mode: "PAPER",
      side: "BUY"
    }
  });

  saveSlot(db, {
    ...slot,
    status: "HOLDING",
    entryPrice: currentPrice,
    quantity,
    entryGrossAmount: grossAmount,
    entryFee: fee,
    currentOrderId: undefined,
    lastBuyAt: now
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
      quantity,
      fee
    }
  });

  return { orderId: order.id, fillId: fill.id, slotId: slot.id };
}

function executePaperSell(db: SqliteDatabase, strategy: Strategy, slot: TradingSlot, currentPrice: number, reason: string): PaperExecutionResult {
  if (slot.quantity <= 0) {
    throw new Error(`Slot ${slot.slotNumber} has no quantity to sell`);
  }

  const now = new Date().toISOString();
  const orderId = randomUUID();
  const fillId = randomUUID();
  const grossAmount = slot.quantity * currentPrice;
  const fee = grossAmount * strategy.feeRate;
  const clientOrderId = createPaperClientOrderId(strategy.id, slot.slotNumber, "sell");

  const order = saveOrder(db, {
    id: orderId,
    strategyId: strategy.id,
    slotId: slot.id,
    brokerOrderId: `paper-${orderId}`,
    clientOrderId,
    market: strategy.market,
    side: "SELL",
    orderType: "paper-market",
    price: currentPrice,
    quantity: slot.quantity,
    amount: grossAmount,
    status: "FILLED",
    requestedAt: now,
    acceptedAt: now,
    rawRequest: {
      mode: "PAPER",
      action: "SELL",
      reason
    },
    rawResponse: {
      filled: true,
      price: currentPrice,
      quantity: slot.quantity,
      fee
    }
  });
  const fill = saveFill(db, {
    id: fillId,
    orderId: order.id,
    strategyId: strategy.id,
    slotId: slot.id,
    brokerFillId: `paper-fill-${fillId}`,
    price: currentPrice,
    quantity: slot.quantity,
    fee,
    filledAt: now,
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
    lastSellAt: now
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
      quantity: slot.quantity,
      fee,
      grossAmount
    }
  });

  return { orderId: order.id, fillId: fill.id, slotId: slot.id };
}

function createPaperClientOrderId(strategyId: string, slotNumber: number, side: "buy" | "sell"): string {
  return `paper-${strategyId.slice(0, 8)}-${slotNumber}-${side}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

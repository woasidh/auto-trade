import type { SqliteDatabase } from "./db";
import type { TradeDecision } from "./strategyEngine";
import type { Strategy, StrategyMode, TradingOrder } from "./tradingRepository";

export type MaybePromise<T> = T | Promise<T>;

export interface BrokerExecutionResult {
  orderId: string;
  fillId?: string;
  slotId: string;
}

export interface BrokerCancelResult {
  orderId: string;
  slotId: string;
  canceled: boolean;
}

export interface BrokerReconciliationResult {
  mode: StrategyMode;
  strategyId: string;
  checkedAt: string;
  openOrderCount: number;
  adjustments: string[];
}

export interface TradingBroker {
  readonly mode: StrategyMode;

  executeDecision(
    db: SqliteDatabase,
    strategy: Strategy,
    decision: TradeDecision,
    currentPrice: number
  ): MaybePromise<BrokerExecutionResult>;

  syncOpenOrders(
    db: SqliteDatabase,
    strategy: Strategy,
    currentPrice: number,
    now?: Date
  ): MaybePromise<BrokerExecutionResult[]>;

  cancelOrder(
    db: SqliteDatabase,
    strategy: Strategy,
    order: TradingOrder,
    reason: string
  ): MaybePromise<BrokerCancelResult>;

  reconcileAccount(
    db: SqliteDatabase,
    strategy: Strategy,
    now?: Date
  ): MaybePromise<BrokerReconciliationResult>;
}

export type BrokerRegistry = Partial<Record<StrategyMode, TradingBroker>>;

import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./db";

export type StrategyMode = "PAPER" | "LIVE";
export type StrategyStatus = "ACTIVE" | "PAUSED" | "STOPPED";
export type TradingSlotStatus = "EMPTY" | "HOLDING" | "BUY_PENDING" | "SELL_PENDING" | "PAUSED";
export type OrderSide = "BUY" | "SELL";
export type OrderStatus = "REQUESTED" | "ACCEPTED" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED" | "REJECTED" | "FAILED" | "UNKNOWN";
export type DecisionAction = "BUY" | "SELL" | "HOLD" | "PAUSE" | "ERROR" | "RECOVER";
export type RunnerStatus = "RUNNING" | "PAUSED" | "RECOVERING" | "STOPPED";

export interface Strategy {
  id: string;
  market: string;
  upperPrice: number;
  lowerPrice: number;
  slotCount: number;
  totalBudget: number;
  slotBudget: number;
  targetProfitRate: number;
  feeRate: number;
  slippageRate: number;
  mode: StrategyMode;
  status: StrategyStatus;
  config: unknown;
  createdAt: string;
  updatedAt: string;
  activatedAt?: string;
  stoppedAt?: string;
}

export interface TradingSlot {
  id: string;
  strategyId: string;
  slotNumber: number;
  buyPrice: number;
  targetSellPrice: number;
  budget: number;
  status: TradingSlotStatus;
  entryPrice?: number;
  quantity: number;
  entryGrossAmount: number;
  entryFee: number;
  currentOrderId?: string;
  lastBuyAt?: string;
  lastSellAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TradingOrder {
  id: string;
  strategyId: string;
  slotId: string;
  brokerOrderId?: string;
  clientOrderId: string;
  market: string;
  side: OrderSide;
  orderType: string;
  price?: number;
  quantity?: number;
  amount?: number;
  status: OrderStatus;
  requestedAt: string;
  acceptedAt?: string;
  updatedAt: string;
  rawRequest?: unknown;
  rawResponse?: unknown;
  errorMessage?: string;
}

export interface TradingFill {
  id: string;
  orderId: string;
  strategyId: string;
  slotId: string;
  brokerFillId?: string;
  price: number;
  quantity: number;
  fee: number;
  tax: number;
  filledAt: string;
  rawResponse?: unknown;
  createdAt: string;
}

export interface DecisionLog {
  id: number;
  strategyId?: string;
  slotId?: string;
  orderId?: string;
  market?: string;
  currentPrice?: number;
  action: DecisionAction;
  reason: string;
  snapshot: unknown;
  createdAt: string;
}

export interface RunnerState {
  status: RunnerStatus;
  activeStrategyId?: string;
  autoTradingEnabled: boolean;
  killSwitchEnabled: boolean;
  heartbeatAt?: string;
  lastTickAt?: string;
  lastMarketPollAt?: string;
  lastOrderSyncAt?: string;
  lastReconcileAt?: string;
  lastError?: string;
  updatedAt: string;
}

export interface TradingPersistenceSnapshot {
  runnerState: RunnerState;
  strategies: Strategy[];
  slots: TradingSlot[];
  orders: TradingOrder[];
  fills: TradingFill[];
  decisionLogs: DecisionLog[];
}

interface StrategyRow {
  id: string;
  market: string;
  upper_price: number;
  lower_price: number;
  slot_count: number;
  total_budget: number;
  slot_budget: number;
  target_profit_rate: number;
  fee_rate: number;
  slippage_rate: number;
  mode: StrategyMode;
  status: StrategyStatus;
  config_json: string;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
  stopped_at: string | null;
}

interface SlotRow {
  id: string;
  strategy_id: string;
  slot_number: number;
  buy_price: number;
  target_sell_price: number;
  budget: number;
  status: TradingSlotStatus;
  entry_price: number | null;
  quantity: number;
  entry_gross_amount: number;
  entry_fee: number;
  current_order_id: string | null;
  last_buy_at: string | null;
  last_sell_at: string | null;
  created_at: string;
  updated_at: string;
}

interface OrderRow {
  id: string;
  strategy_id: string;
  slot_id: string;
  broker_order_id: string | null;
  client_order_id: string;
  market: string;
  side: OrderSide;
  order_type: string;
  price: number | null;
  quantity: number | null;
  amount: number | null;
  status: OrderStatus;
  requested_at: string;
  accepted_at: string | null;
  updated_at: string;
  raw_request_json: string | null;
  raw_response_json: string | null;
  error_message: string | null;
}

interface FillRow {
  id: string;
  order_id: string;
  strategy_id: string;
  slot_id: string;
  broker_fill_id: string | null;
  price: number;
  quantity: number;
  fee: number;
  tax: number;
  filled_at: string;
  raw_response_json: string | null;
  created_at: string;
}

interface DecisionLogRow {
  id: number;
  strategy_id: string | null;
  slot_id: string | null;
  order_id: string | null;
  market: string | null;
  current_price: number | null;
  action: DecisionAction;
  reason: string;
  snapshot_json: string;
  created_at: string;
}

interface RunnerStateRow {
  status: RunnerStatus;
  active_strategy_id: string | null;
  auto_trading_enabled: number;
  kill_switch_enabled: number;
  heartbeat_at: string | null;
  last_tick_at: string | null;
  last_market_poll_at: string | null;
  last_order_sync_at: string | null;
  last_reconcile_at: string | null;
  last_error: string | null;
  updated_at: string;
}

export interface SaveStrategyInput {
  id?: string;
  market: string;
  upperPrice: number;
  lowerPrice: number;
  slotCount: number;
  totalBudget: number;
  slotBudget?: number;
  targetProfitRate: number;
  feeRate?: number;
  slippageRate?: number;
  mode?: StrategyMode;
  status?: StrategyStatus;
  config?: unknown;
  activatedAt?: string;
  stoppedAt?: string;
}

export interface SaveSlotInput {
  id?: string;
  strategyId: string;
  slotNumber: number;
  buyPrice: number;
  targetSellPrice: number;
  budget: number;
  status?: TradingSlotStatus;
  entryPrice?: number;
  quantity?: number;
  entryGrossAmount?: number;
  entryFee?: number;
  currentOrderId?: string;
  lastBuyAt?: string;
  lastSellAt?: string;
}

export interface SaveOrderInput {
  id?: string;
  strategyId: string;
  slotId: string;
  brokerOrderId?: string;
  clientOrderId: string;
  market: string;
  side: OrderSide;
  orderType: string;
  price?: number;
  quantity?: number;
  amount?: number;
  status?: OrderStatus;
  requestedAt?: string;
  acceptedAt?: string;
  rawRequest?: unknown;
  rawResponse?: unknown;
  errorMessage?: string;
}

export interface SaveFillInput {
  id?: string;
  orderId: string;
  strategyId: string;
  slotId: string;
  brokerFillId?: string;
  price: number;
  quantity: number;
  fee?: number;
  tax?: number;
  filledAt?: string;
  rawResponse?: unknown;
}

export interface AppendDecisionLogInput {
  strategyId?: string;
  slotId?: string;
  orderId?: string;
  market?: string;
  currentPrice?: number;
  action: DecisionAction;
  reason: string;
  snapshot?: unknown;
}

export interface UpdateRunnerStateInput {
  status?: RunnerStatus;
  activeStrategyId?: string | null;
  autoTradingEnabled?: boolean;
  killSwitchEnabled?: boolean;
  heartbeatAt?: string | null;
  lastTickAt?: string | null;
  lastMarketPollAt?: string | null;
  lastOrderSyncAt?: string | null;
  lastReconcileAt?: string | null;
  lastError?: string | null;
}

export function getTradingPersistenceSnapshot(db: SqliteDatabase): TradingPersistenceSnapshot {
  return {
    runnerState: getRunnerState(db),
    strategies: listStrategies(db),
    slots: listSlots(db),
    orders: listOrders(db),
    fills: listFills(db),
    decisionLogs: listDecisionLogs(db, 100)
  };
}

export function listStrategies(db: SqliteDatabase): Strategy[] {
  const rows = db.prepare("SELECT * FROM strategies ORDER BY created_at DESC, id DESC").all() as StrategyRow[];
  return rows.map(rowToStrategy);
}

export function listSlots(db: SqliteDatabase, strategyId?: string): TradingSlot[] {
  const rows = strategyId
    ? db.prepare("SELECT * FROM slots WHERE strategy_id = ? ORDER BY slot_number ASC").all(strategyId)
    : db.prepare("SELECT * FROM slots ORDER BY strategy_id ASC, slot_number ASC").all();
  return (rows as SlotRow[]).map(rowToSlot);
}

export function listOrders(db: SqliteDatabase, strategyId?: string): TradingOrder[] {
  const rows = strategyId
    ? db.prepare("SELECT * FROM orders WHERE strategy_id = ? ORDER BY requested_at DESC, id DESC").all(strategyId)
    : db.prepare("SELECT * FROM orders ORDER BY requested_at DESC, id DESC").all();
  return (rows as OrderRow[]).map(rowToOrder);
}

export function listFills(db: SqliteDatabase, strategyId?: string): TradingFill[] {
  const rows = strategyId
    ? db.prepare("SELECT * FROM fills WHERE strategy_id = ? ORDER BY filled_at DESC, id DESC").all(strategyId)
    : db.prepare("SELECT * FROM fills ORDER BY filled_at DESC, id DESC").all();
  return (rows as FillRow[]).map(rowToFill);
}

export function listDecisionLogs(db: SqliteDatabase, limit = 100): DecisionLog[] {
  const rows = db.prepare("SELECT * FROM decision_logs ORDER BY created_at DESC, id DESC LIMIT ?").all(clampLimit(limit)) as DecisionLogRow[];
  return rows.map(rowToDecisionLog);
}

export function getRunnerState(db: SqliteDatabase): RunnerState {
  ensureRunnerState(db);
  const row = db.prepare("SELECT * FROM runner_state WHERE id = 1").get() as RunnerStateRow;
  return rowToRunnerState(row);
}

export function saveStrategy(db: SqliteDatabase, input: SaveStrategyInput): Strategy {
  const now = new Date().toISOString();
  const id = input.id ?? randomUUID();
  const slotBudget = input.slotBudget ?? input.totalBudget / input.slotCount;

  db.prepare(`
    INSERT INTO strategies (
      id,
      market,
      upper_price,
      lower_price,
      slot_count,
      total_budget,
      slot_budget,
      target_profit_rate,
      fee_rate,
      slippage_rate,
      mode,
      status,
      config_json,
      created_at,
      updated_at,
      activated_at,
      stopped_at
    )
    VALUES (
      @id,
      @market,
      @upperPrice,
      @lowerPrice,
      @slotCount,
      @totalBudget,
      @slotBudget,
      @targetProfitRate,
      @feeRate,
      @slippageRate,
      @mode,
      @status,
      @configJson,
      @now,
      @now,
      @activatedAt,
      @stoppedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      market = excluded.market,
      upper_price = excluded.upper_price,
      lower_price = excluded.lower_price,
      slot_count = excluded.slot_count,
      total_budget = excluded.total_budget,
      slot_budget = excluded.slot_budget,
      target_profit_rate = excluded.target_profit_rate,
      fee_rate = excluded.fee_rate,
      slippage_rate = excluded.slippage_rate,
      mode = excluded.mode,
      status = excluded.status,
      config_json = excluded.config_json,
      updated_at = excluded.updated_at,
      activated_at = excluded.activated_at,
      stopped_at = excluded.stopped_at
  `).run({
    id,
    market: normalizeMarket(input.market),
    upperPrice: input.upperPrice,
    lowerPrice: input.lowerPrice,
    slotCount: input.slotCount,
    totalBudget: input.totalBudget,
    slotBudget,
    targetProfitRate: input.targetProfitRate,
    feeRate: input.feeRate ?? 0,
    slippageRate: input.slippageRate ?? 0,
    mode: input.mode ?? "PAPER",
    status: input.status ?? "PAUSED",
    configJson: jsonToText(input.config ?? {}),
    now,
    activatedAt: input.activatedAt ?? null,
    stoppedAt: input.stoppedAt ?? null
  });

  return getStrategyById(db, id);
}

export function saveSlot(db: SqliteDatabase, input: SaveSlotInput): TradingSlot {
  const now = new Date().toISOString();
  const id = input.id ?? `${input.strategyId}:slot:${input.slotNumber}`;

  db.prepare(`
    INSERT INTO slots (
      id,
      strategy_id,
      slot_number,
      buy_price,
      target_sell_price,
      budget,
      status,
      entry_price,
      quantity,
      entry_gross_amount,
      entry_fee,
      current_order_id,
      last_buy_at,
      last_sell_at,
      created_at,
      updated_at
    )
    VALUES (
      @id,
      @strategyId,
      @slotNumber,
      @buyPrice,
      @targetSellPrice,
      @budget,
      @status,
      @entryPrice,
      @quantity,
      @entryGrossAmount,
      @entryFee,
      @currentOrderId,
      @lastBuyAt,
      @lastSellAt,
      @now,
      @now
    )
    ON CONFLICT(id) DO UPDATE SET
      buy_price = excluded.buy_price,
      target_sell_price = excluded.target_sell_price,
      budget = excluded.budget,
      status = excluded.status,
      entry_price = excluded.entry_price,
      quantity = excluded.quantity,
      entry_gross_amount = excluded.entry_gross_amount,
      entry_fee = excluded.entry_fee,
      current_order_id = excluded.current_order_id,
      last_buy_at = excluded.last_buy_at,
      last_sell_at = excluded.last_sell_at,
      updated_at = excluded.updated_at
  `).run({
    id,
    strategyId: input.strategyId,
    slotNumber: input.slotNumber,
    buyPrice: input.buyPrice,
    targetSellPrice: input.targetSellPrice,
    budget: input.budget,
    status: input.status ?? "EMPTY",
    entryPrice: input.entryPrice ?? null,
    quantity: input.quantity ?? 0,
    entryGrossAmount: input.entryGrossAmount ?? 0,
    entryFee: input.entryFee ?? 0,
    currentOrderId: input.currentOrderId ?? null,
    lastBuyAt: input.lastBuyAt ?? null,
    lastSellAt: input.lastSellAt ?? null,
    now
  });

  return getSlotById(db, id);
}

export function saveOrder(db: SqliteDatabase, input: SaveOrderInput): TradingOrder {
  const now = new Date().toISOString();
  const id = input.id ?? randomUUID();

  db.prepare(`
    INSERT INTO orders (
      id,
      strategy_id,
      slot_id,
      broker_order_id,
      client_order_id,
      market,
      side,
      order_type,
      price,
      quantity,
      amount,
      status,
      requested_at,
      accepted_at,
      updated_at,
      raw_request_json,
      raw_response_json,
      error_message
    )
    VALUES (
      @id,
      @strategyId,
      @slotId,
      @brokerOrderId,
      @clientOrderId,
      @market,
      @side,
      @orderType,
      @price,
      @quantity,
      @amount,
      @status,
      @requestedAt,
      @acceptedAt,
      @now,
      @rawRequestJson,
      @rawResponseJson,
      @errorMessage
    )
    ON CONFLICT(id) DO UPDATE SET
      broker_order_id = excluded.broker_order_id,
      market = excluded.market,
      side = excluded.side,
      order_type = excluded.order_type,
      price = excluded.price,
      quantity = excluded.quantity,
      amount = excluded.amount,
      status = excluded.status,
      accepted_at = excluded.accepted_at,
      updated_at = excluded.updated_at,
      raw_request_json = excluded.raw_request_json,
      raw_response_json = excluded.raw_response_json,
      error_message = excluded.error_message
  `).run({
    id,
    strategyId: input.strategyId,
    slotId: input.slotId,
    brokerOrderId: input.brokerOrderId ?? null,
    clientOrderId: input.clientOrderId,
    market: normalizeMarket(input.market),
    side: input.side,
    orderType: input.orderType,
    price: input.price ?? null,
    quantity: input.quantity ?? null,
    amount: input.amount ?? null,
    status: input.status ?? "REQUESTED",
    requestedAt: input.requestedAt ?? now,
    acceptedAt: input.acceptedAt ?? null,
    now,
    rawRequestJson: nullableJsonToText(input.rawRequest),
    rawResponseJson: nullableJsonToText(input.rawResponse),
    errorMessage: input.errorMessage ?? null
  });

  return getOrderById(db, id);
}

export function saveFill(db: SqliteDatabase, input: SaveFillInput): TradingFill {
  const now = new Date().toISOString();
  const id = input.id ?? randomUUID();

  db.prepare(`
    INSERT INTO fills (
      id,
      order_id,
      strategy_id,
      slot_id,
      broker_fill_id,
      price,
      quantity,
      fee,
      tax,
      filled_at,
      raw_response_json,
      created_at
    )
    VALUES (
      @id,
      @orderId,
      @strategyId,
      @slotId,
      @brokerFillId,
      @price,
      @quantity,
      @fee,
      @tax,
      @filledAt,
      @rawResponseJson,
      @now
    )
    ON CONFLICT(id) DO UPDATE SET
      broker_fill_id = excluded.broker_fill_id,
      price = excluded.price,
      quantity = excluded.quantity,
      fee = excluded.fee,
      tax = excluded.tax,
      filled_at = excluded.filled_at,
      raw_response_json = excluded.raw_response_json
  `).run({
    id,
    orderId: input.orderId,
    strategyId: input.strategyId,
    slotId: input.slotId,
    brokerFillId: input.brokerFillId ?? null,
    price: input.price,
    quantity: input.quantity,
    fee: input.fee ?? 0,
    tax: input.tax ?? 0,
    filledAt: input.filledAt ?? now,
    rawResponseJson: nullableJsonToText(input.rawResponse),
    now
  });

  return getFillById(db, id);
}

export function appendDecisionLog(db: SqliteDatabase, input: AppendDecisionLogInput): DecisionLog {
  const createdAt = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO decision_logs (
      strategy_id,
      slot_id,
      order_id,
      market,
      current_price,
      action,
      reason,
      snapshot_json,
      created_at
    )
    VALUES (
      @strategyId,
      @slotId,
      @orderId,
      @market,
      @currentPrice,
      @action,
      @reason,
      @snapshotJson,
      @createdAt
    )
  `).run({
    strategyId: input.strategyId ?? null,
    slotId: input.slotId ?? null,
    orderId: input.orderId ?? null,
    market: input.market ? normalizeMarket(input.market) : null,
    currentPrice: input.currentPrice ?? null,
    action: input.action,
    reason: input.reason,
    snapshotJson: jsonToText(input.snapshot ?? {}),
    createdAt
  });

  const id = Number(result.lastInsertRowid);
  const row = db.prepare("SELECT * FROM decision_logs WHERE id = ?").get(id) as DecisionLogRow;
  return rowToDecisionLog(row);
}

export function updateRunnerState(db: SqliteDatabase, input: UpdateRunnerStateInput): RunnerState {
  const current = getRunnerState(db);
  const next = {
    status: input.status ?? current.status,
    activeStrategyId: input.activeStrategyId === undefined ? current.activeStrategyId ?? null : input.activeStrategyId,
    autoTradingEnabled: input.autoTradingEnabled ?? current.autoTradingEnabled,
    killSwitchEnabled: input.killSwitchEnabled ?? current.killSwitchEnabled,
    heartbeatAt: input.heartbeatAt === undefined ? current.heartbeatAt ?? null : input.heartbeatAt,
    lastTickAt: input.lastTickAt === undefined ? current.lastTickAt ?? null : input.lastTickAt,
    lastMarketPollAt: input.lastMarketPollAt === undefined ? current.lastMarketPollAt ?? null : input.lastMarketPollAt,
    lastOrderSyncAt: input.lastOrderSyncAt === undefined ? current.lastOrderSyncAt ?? null : input.lastOrderSyncAt,
    lastReconcileAt: input.lastReconcileAt === undefined ? current.lastReconcileAt ?? null : input.lastReconcileAt,
    lastError: input.lastError === undefined ? current.lastError ?? null : input.lastError,
    updatedAt: new Date().toISOString()
  };

  db.prepare(`
    UPDATE runner_state SET
      status = @status,
      active_strategy_id = @activeStrategyId,
      auto_trading_enabled = @autoTradingEnabled,
      kill_switch_enabled = @killSwitchEnabled,
      heartbeat_at = @heartbeatAt,
      last_tick_at = @lastTickAt,
      last_market_poll_at = @lastMarketPollAt,
      last_order_sync_at = @lastOrderSyncAt,
      last_reconcile_at = @lastReconcileAt,
      last_error = @lastError,
      updated_at = @updatedAt
    WHERE id = 1
  `).run({
    ...next,
    autoTradingEnabled: next.autoTradingEnabled ? 1 : 0,
    killSwitchEnabled: next.killSwitchEnabled ? 1 : 0
  });

  return getRunnerState(db);
}

function getStrategyById(db: SqliteDatabase, id: string): Strategy {
  const row = db.prepare("SELECT * FROM strategies WHERE id = ?").get(id) as StrategyRow | undefined;
  if (!row) {
    throw new Error(`Strategy not found: ${id}`);
  }

  return rowToStrategy(row);
}

function getSlotById(db: SqliteDatabase, id: string): TradingSlot {
  const row = db.prepare("SELECT * FROM slots WHERE id = ?").get(id) as SlotRow | undefined;
  if (!row) {
    throw new Error(`Slot not found: ${id}`);
  }

  return rowToSlot(row);
}

function getOrderById(db: SqliteDatabase, id: string): TradingOrder {
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow | undefined;
  if (!row) {
    throw new Error(`Order not found: ${id}`);
  }

  return rowToOrder(row);
}

function getFillById(db: SqliteDatabase, id: string): TradingFill {
  const row = db.prepare("SELECT * FROM fills WHERE id = ?").get(id) as FillRow | undefined;
  if (!row) {
    throw new Error(`Fill not found: ${id}`);
  }

  return rowToFill(row);
}

function ensureRunnerState(db: SqliteDatabase): void {
  db.prepare(`
    INSERT OR IGNORE INTO runner_state (
      id,
      status,
      auto_trading_enabled,
      kill_switch_enabled,
      updated_at
    )
    VALUES (
      1,
      'STOPPED',
      0,
      0,
      @updatedAt
    )
  `).run({ updatedAt: new Date().toISOString() });
}

function rowToStrategy(row: StrategyRow): Strategy {
  return {
    id: row.id,
    market: row.market,
    upperPrice: row.upper_price,
    lowerPrice: row.lower_price,
    slotCount: row.slot_count,
    totalBudget: row.total_budget,
    slotBudget: row.slot_budget,
    targetProfitRate: row.target_profit_rate,
    feeRate: row.fee_rate,
    slippageRate: row.slippage_rate,
    mode: row.mode,
    status: row.status,
    config: parseJson(row.config_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activatedAt: row.activated_at ?? undefined,
    stoppedAt: row.stopped_at ?? undefined
  };
}

function rowToSlot(row: SlotRow): TradingSlot {
  return {
    id: row.id,
    strategyId: row.strategy_id,
    slotNumber: row.slot_number,
    buyPrice: row.buy_price,
    targetSellPrice: row.target_sell_price,
    budget: row.budget,
    status: row.status,
    entryPrice: row.entry_price ?? undefined,
    quantity: row.quantity,
    entryGrossAmount: row.entry_gross_amount,
    entryFee: row.entry_fee,
    currentOrderId: row.current_order_id ?? undefined,
    lastBuyAt: row.last_buy_at ?? undefined,
    lastSellAt: row.last_sell_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToOrder(row: OrderRow): TradingOrder {
  return {
    id: row.id,
    strategyId: row.strategy_id,
    slotId: row.slot_id,
    brokerOrderId: row.broker_order_id ?? undefined,
    clientOrderId: row.client_order_id,
    market: row.market,
    side: row.side,
    orderType: row.order_type,
    price: row.price ?? undefined,
    quantity: row.quantity ?? undefined,
    amount: row.amount ?? undefined,
    status: row.status,
    requestedAt: row.requested_at,
    acceptedAt: row.accepted_at ?? undefined,
    updatedAt: row.updated_at,
    rawRequest: parseNullableJson(row.raw_request_json),
    rawResponse: parseNullableJson(row.raw_response_json),
    errorMessage: row.error_message ?? undefined
  };
}

function rowToFill(row: FillRow): TradingFill {
  return {
    id: row.id,
    orderId: row.order_id,
    strategyId: row.strategy_id,
    slotId: row.slot_id,
    brokerFillId: row.broker_fill_id ?? undefined,
    price: row.price,
    quantity: row.quantity,
    fee: row.fee,
    tax: row.tax,
    filledAt: row.filled_at,
    rawResponse: parseNullableJson(row.raw_response_json),
    createdAt: row.created_at
  };
}

function rowToDecisionLog(row: DecisionLogRow): DecisionLog {
  return {
    id: row.id,
    strategyId: row.strategy_id ?? undefined,
    slotId: row.slot_id ?? undefined,
    orderId: row.order_id ?? undefined,
    market: row.market ?? undefined,
    currentPrice: row.current_price ?? undefined,
    action: row.action,
    reason: row.reason,
    snapshot: parseJson(row.snapshot_json),
    createdAt: row.created_at
  };
}

function rowToRunnerState(row: RunnerStateRow): RunnerState {
  return {
    status: row.status,
    activeStrategyId: row.active_strategy_id ?? undefined,
    autoTradingEnabled: row.auto_trading_enabled === 1,
    killSwitchEnabled: row.kill_switch_enabled === 1,
    heartbeatAt: row.heartbeat_at ?? undefined,
    lastTickAt: row.last_tick_at ?? undefined,
    lastMarketPollAt: row.last_market_poll_at ?? undefined,
    lastOrderSyncAt: row.last_order_sync_at ?? undefined,
    lastReconcileAt: row.last_reconcile_at ?? undefined,
    lastError: row.last_error ?? undefined,
    updatedAt: row.updated_at
  };
}

function normalizeMarket(value: string): string {
  const market = value.trim().toUpperCase();
  if (!/^[A-Z0-9]+-[A-Z0-9]+$/.test(market)) {
    throw new Error(`Invalid market: ${value}`);
  }

  return market;
}

function jsonToText(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function nullableJsonToText(value: unknown): string | null {
  return value === undefined ? null : jsonToText(value);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function parseNullableJson(value: string | null): unknown | undefined {
  return value === null ? undefined : parseJson(value);
}

function clampLimit(value: number): number {
  return Math.min(500, Math.max(1, Math.round(Number.isFinite(value) ? value : 100)));
}

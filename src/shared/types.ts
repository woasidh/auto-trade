export type SlotStatus = "EMPTY" | "HOLDING";
export type TradeType = "BUY" | "SELL";

export interface RawBithumbCandle {
  market: string;
  candle_date_time_utc: string;
  candle_date_time_kst: string;
  opening_price: number;
  high_price: number;
  low_price: number;
  trade_price: number;
  timestamp: number;
  candle_acc_trade_price: number;
  candle_acc_trade_volume: number;
  unit: number;
}

export interface Candle {
  market: string;
  time: string;
  epochSeconds: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  accTradePrice: number;
  synthetic?: boolean;
}

export interface DatasetDate {
  date: string;
  count: number;
  missing: number;
}

export interface DatasetResponse {
  datasets: Array<{
    market: string;
    intervals: Array<{
      interval: string;
      dates: DatasetDate[];
    }>;
  }>;
}

export interface SimulationSettings {
  slotCount: number;
  upperPrice: number;
  lowerPrice: number;
  totalBudget: number;
  targetProfitRate: number;
  feeRate: number;
}

export interface SlotConfig {
  slotNumber: number;
  buyPrice: number;
  targetSellPrice: number;
  budget: number;
}

export interface TradeEvent {
  id: string;
  slotNumber: number;
  type: TradeType;
  time: string;
  epochSeconds: number;
  price: number;
  quantity: number;
  grossAmount: number;
  fee: number;
  profit?: number;
}

export interface SlotResult extends SlotConfig {
  status: SlotStatus;
  quantity: number;
  entryPrice?: number;
  entryTime?: string;
  entryGrossAmount: number;
  entryFee: number;
  realizedProfit: number;
  unrealizedProfit: number;
  totalProfit: number;
  roi: number;
  tradeCount: number;
  trades: TradeEvent[];
}

export interface SimulationResult {
  settings: SimulationSettings;
  slots: SlotResult[];
  events: TradeEvent[];
  summary: {
    realizedProfit: number;
    unrealizedProfit: number;
    totalProfit: number;
    roi: number;
    buyCount: number;
    sellCount: number;
    endingPrice: number;
  };
}

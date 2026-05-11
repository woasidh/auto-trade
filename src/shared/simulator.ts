import type {
  Candle,
  SimulationResult,
  SimulationSettings,
  SlotConfig,
  SlotResult,
  SlotStatus,
  TradeEvent
} from "./types";

interface MutableSlot extends SlotConfig {
  status: SlotStatus;
  quantity: number;
  entryPrice?: number;
  entryTime?: string;
  entryGrossAmount: number;
  entryFee: number;
  realizedProfit: number;
  trades: TradeEvent[];
}

export function createSlots(settings: SimulationSettings): SlotConfig[] {
  validateSettings(settings);

  const step = (settings.upperPrice - settings.lowerPrice) / (settings.slotCount - 1);
  const budget = settings.totalBudget / settings.slotCount;

  return Array.from({ length: settings.slotCount }, (_, index) => {
    const buyPrice = settings.upperPrice - step * index;
    return {
      slotNumber: index + 1,
      buyPrice,
      targetSellPrice: buyPrice * (1 + settings.targetProfitRate),
      budget
    };
  });
}

export function simulateSevenSplit(candles: Candle[], settings: SimulationSettings): SimulationResult {
  validateSettings(settings);

  if (candles.length === 0) {
    throw new Error("No candles to simulate");
  }

  const slots: MutableSlot[] = createSlots(settings).map((slot) => ({
    ...slot,
    status: "EMPTY",
    quantity: 0,
    entryGrossAmount: 0,
    entryFee: 0,
    realizedProfit: 0,
    trades: []
  }));

  const events: TradeEvent[] = [];

  for (const candle of candles) {
    const soldThisCandle = new Set<number>();

    for (const slot of slots) {
      if (slot.status !== "HOLDING") {
        continue;
      }

      if (candle.high >= slot.targetSellPrice) {
        const grossAmount = slot.quantity * slot.targetSellPrice;
        const fee = grossAmount * settings.feeRate;
        const profit = grossAmount - fee - slot.entryGrossAmount - slot.entryFee;
        const event: TradeEvent = {
          id: `${candle.time}-${slot.slotNumber}-sell-${slot.trades.length}`,
          slotNumber: slot.slotNumber,
          type: "SELL",
          time: candle.time,
          epochSeconds: candle.epochSeconds,
          price: slot.targetSellPrice,
          quantity: slot.quantity,
          grossAmount,
          fee,
          profit
        };

        slot.status = "EMPTY";
        slot.quantity = 0;
        slot.entryPrice = undefined;
        slot.entryTime = undefined;
        slot.entryGrossAmount = 0;
        slot.entryFee = 0;
        slot.realizedProfit += profit;
        slot.trades.push(event);
        events.push(event);
        soldThisCandle.add(slot.slotNumber);
      }
    }

    for (const slot of slots) {
      if (slot.status !== "EMPTY" || soldThisCandle.has(slot.slotNumber)) {
        continue;
      }

      if (candle.low <= slot.buyPrice) {
        const grossAmount = slot.budget / (1 + settings.feeRate);
        const fee = slot.budget - grossAmount;
        const quantity = grossAmount / slot.buyPrice;
        const event: TradeEvent = {
          id: `${candle.time}-${slot.slotNumber}-buy-${slot.trades.length}`,
          slotNumber: slot.slotNumber,
          type: "BUY",
          time: candle.time,
          epochSeconds: candle.epochSeconds,
          price: slot.buyPrice,
          quantity,
          grossAmount,
          fee
        };

        slot.status = "HOLDING";
        slot.quantity = quantity;
        slot.entryPrice = slot.buyPrice;
        slot.entryTime = candle.time;
        slot.entryGrossAmount = grossAmount;
        slot.entryFee = fee;
        slot.trades.push(event);
        events.push(event);
      }
    }
  }

  const endingPrice = candles[candles.length - 1].close;
  const finalizedSlots: SlotResult[] = slots.map((slot) => {
    const unrealizedProfit =
      slot.status === "HOLDING"
        ? slot.quantity * endingPrice * (1 - settings.feeRate) - slot.entryGrossAmount - slot.entryFee
        : 0;
    const totalProfit = slot.realizedProfit + unrealizedProfit;

    return {
      ...slot,
      unrealizedProfit,
      totalProfit,
      roi: totalProfit / slot.budget,
      tradeCount: slot.trades.length
    };
  });

  const realizedProfit = finalizedSlots.reduce((sum, slot) => sum + slot.realizedProfit, 0);
  const unrealizedProfit = finalizedSlots.reduce((sum, slot) => sum + slot.unrealizedProfit, 0);
  const totalProfit = realizedProfit + unrealizedProfit;

  return {
    settings,
    slots: finalizedSlots,
    events,
    summary: {
      realizedProfit,
      unrealizedProfit,
      totalProfit,
      roi: totalProfit / settings.totalBudget,
      buyCount: events.filter((event) => event.type === "BUY").length,
      sellCount: events.filter((event) => event.type === "SELL").length,
      endingPrice
    }
  };
}

export function validateSettings(settings: SimulationSettings): void {
  if (!Number.isInteger(settings.slotCount) || settings.slotCount < 2 || settings.slotCount > 20) {
    throw new Error("Slot count must be an integer from 2 to 20");
  }

  if (settings.upperPrice <= settings.lowerPrice) {
    throw new Error("Upper price must be greater than lower price");
  }

  if (settings.totalBudget <= 0) {
    throw new Error("Total budget must be greater than 0");
  }

  if (settings.targetProfitRate <= 0) {
    throw new Error("Target profit rate must be greater than 0");
  }

  if (settings.feeRate < 0) {
    throw new Error("Fee rate cannot be negative");
  }
}

import type { Strategy, TradingSlot } from "./tradingRepository";

export interface SlotSeed {
  slotNumber: number;
  buyPrice: number;
  targetSellPrice: number;
  budget: number;
}

export type TradeDecision =
  | {
      action: "BUY";
      slot: TradingSlot;
      reason: string;
    }
  | {
      action: "SELL";
      slot: TradingSlot;
      reason: string;
    };

export function createStrategySlots(strategy: Pick<Strategy, "upperPrice" | "lowerPrice" | "slotCount" | "slotBudget" | "targetProfitRate">): SlotSeed[] {
  if (strategy.slotCount <= 0) {
    throw new Error("Slot count must be greater than 0");
  }

  if (strategy.upperPrice <= strategy.lowerPrice) {
    throw new Error("Upper price must be greater than lower price");
  }

  const step = strategy.slotCount === 1 ? 0 : (strategy.upperPrice - strategy.lowerPrice) / (strategy.slotCount - 1);

  return Array.from({ length: strategy.slotCount }, (_, index) => {
    const buyPrice = index === strategy.slotCount - 1 ? strategy.lowerPrice : strategy.upperPrice - step * index;
    return {
      slotNumber: index + 1,
      buyPrice,
      targetSellPrice: buyPrice * (1 + strategy.targetProfitRate),
      budget: strategy.slotBudget
    };
  });
}

export function evaluateSevenSplit(strategy: Strategy, slots: TradingSlot[], currentPrice: number): TradeDecision[] {
  if (strategy.status !== "ACTIVE") {
    return [];
  }

  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    throw new Error("Current price must be greater than 0");
  }

  const decisions: TradeDecision[] = [];
  const orderedSlots = [...slots].sort((left, right) => left.slotNumber - right.slotNumber);

  for (const slot of orderedSlots) {
    if (slot.status !== "HOLDING") {
      continue;
    }

    if (currentPrice >= slot.targetSellPrice) {
      decisions.push({
        action: "SELL",
        slot,
        reason: `current price ${currentPrice} reached target sell price ${slot.targetSellPrice}`
      });
    }
  }

  for (const slot of orderedSlots) {
    if (slot.status !== "EMPTY") {
      continue;
    }

    if (currentPrice <= slot.buyPrice) {
      decisions.push({
        action: "BUY",
        slot,
        reason: `current price ${currentPrice} reached buy price ${slot.buyPrice}`
      });
    }
  }

  return decisions;
}

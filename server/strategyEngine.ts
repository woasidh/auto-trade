import type { Strategy, TradingSlot } from "./tradingRepository";

const maxStrategySlotCount = 100;
export const defaultMaxBuyPriceGap = 10;

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

export interface SevenSplitEvaluationContext {
  previousPrice?: number;
  maxBuyPriceGap?: number;
  retryBuySlotIds?: ReadonlySet<string>;
}

export interface StrategySlotPlanInput {
  upperPrice: number;
  lowerPrice: number;
  slotCount?: number;
  slotPriceOffset?: number;
}

export function createStrategyBuyPrices(input: StrategySlotPlanInput): number[] {
  if (input.upperPrice <= input.lowerPrice) {
    throw new Error("Upper price must be greater than lower price");
  }

  if (Number.isFinite(input.slotPriceOffset)) {
    const slotPriceOffset = Math.round(input.slotPriceOffset ?? 0);
    if (slotPriceOffset <= 0) {
      throw new Error("Slot price offset must be greater than 0");
    }

    const upperPrice = Math.floor(input.upperPrice);
    const lowerPrice = Math.floor(input.lowerPrice);
    if (upperPrice <= lowerPrice) {
      throw new Error("Upper price must be at least one integer price unit greater than lower price");
    }

    const buyPrices: number[] = [];
    for (let buyPrice = upperPrice; buyPrice > lowerPrice; buyPrice -= slotPriceOffset) {
      if (buyPrices.length >= maxStrategySlotCount) {
        throw new Error(`Slot count cannot exceed ${maxStrategySlotCount}`);
      }
      buyPrices.push(buyPrice);
    }

    if (buyPrices[buyPrices.length - 1] !== lowerPrice) {
      if (buyPrices.length >= maxStrategySlotCount) {
        throw new Error(`Slot count cannot exceed ${maxStrategySlotCount}`);
      }
      buyPrices.push(lowerPrice);
    }

    return buyPrices;
  }

  const slotCount = input.slotCount ?? 0;
  if (slotCount <= 0) {
    throw new Error("Slot count must be greater than 0");
  }

  if (slotCount > maxStrategySlotCount) {
    throw new Error(`Slot count cannot exceed ${maxStrategySlotCount}`);
  }

  const step = slotCount === 1 ? 0 : (input.upperPrice - input.lowerPrice) / (slotCount - 1);
  return Array.from({ length: slotCount }, (_, index) => (index === slotCount - 1 ? input.lowerPrice : input.upperPrice - step * index));
}

export function createStrategySlots(strategy: Pick<Strategy, "upperPrice" | "lowerPrice" | "slotCount" | "slotBudget" | "targetProfitRate" | "config">): SlotSeed[] {
  const buyPrices = createStrategyBuyPrices({
    upperPrice: strategy.upperPrice,
    lowerPrice: strategy.lowerPrice,
    slotCount: strategy.slotCount,
    slotPriceOffset: getSlotPriceOffset(strategy.config)
  });

  return buyPrices.map((buyPrice, index) => {
    const targetSellPrice = calculateTargetSellPrice(strategy, buyPrice);

    return {
      slotNumber: index + 1,
      buyPrice,
      targetSellPrice,
      budget: strategy.slotBudget
    };
  });
}

export function calculateTargetSellPrice(strategy: Pick<Strategy, "targetProfitRate" | "config">, entryPrice: number): number {
  const targetProfitPriceUnit = getTargetProfitPriceUnit(strategy.config);
  return targetProfitPriceUnit ? entryPrice + targetProfitPriceUnit : entryPrice * (1 + strategy.targetProfitRate);
}

function getSlotPriceOffset(config: unknown) {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return undefined;
  }

  const value = (config as { slotPriceOffset?: unknown }).slotPriceOffset;
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : undefined;
}

function getTargetProfitPriceUnit(config: unknown) {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return undefined;
  }

  const value = (config as { targetProfitPriceUnit?: unknown }).targetProfitPriceUnit;
  const normalized = Math.round(Number(value));
  return Number.isFinite(normalized) && normalized > 0 ? normalized : undefined;
}

export function evaluateSevenSplit(strategy: Strategy, slots: TradingSlot[], currentPrice: number, context: SevenSplitEvaluationContext = {}): TradeDecision[] {
  if (strategy.status !== "ACTIVE") {
    return [];
  }

  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    throw new Error("Current price must be greater than 0");
  }

  const decisions: TradeDecision[] = [];
  const orderedSlots = [...slots].sort((left, right) => left.slotNumber - right.slotNumber);
  const previousPrice = context.previousPrice ?? currentPrice;
  const maxBuyPriceGap = context.maxBuyPriceGap ?? defaultMaxBuyPriceGap;
  const buyGap = Math.abs(currentPrice - previousPrice);
  const canEvaluateBuys = buyGap <= maxBuyPriceGap;

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

    if (!canEvaluateBuys) {
      continue;
    }

    const touchedBuyPrice = isPriceTouched(previousPrice, currentPrice, slot.buyPrice);
    const canRetryBuy = context.retryBuySlotIds?.has(slot.id) === true && currentPrice <= slot.buyPrice;
    if (touchedBuyPrice || canRetryBuy) {
      decisions.push({
        action: "BUY",
        slot,
        reason: touchedBuyPrice
          ? `price moved from ${previousPrice} to ${currentPrice} through buy price ${slot.buyPrice}`
          : `retrying buy because current price ${currentPrice} is at or below buy price ${slot.buyPrice}`
      });
    }
  }

  return decisions;
}

function isPriceTouched(previousPrice: number, currentPrice: number, targetPrice: number): boolean {
  return Math.min(previousPrice, currentPrice) <= targetPrice && Math.max(previousPrice, currentPrice) >= targetPrice;
}

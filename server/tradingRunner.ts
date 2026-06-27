import type { SqliteDatabase } from "./db";
import { PaperBroker } from "./paperBroker";
import { createStrategySlots } from "./strategyEngine";
import {
  appendDecisionLog,
  clearTradingPersistence,
  getRunnerState,
  getTradingPersistenceSnapshot,
  listSlots,
  listStrategies,
  saveSlot,
  saveStrategy,
  updateRunnerState
} from "./tradingRepository";
import type { SaveStrategyInput, Strategy, TradingPersistenceSnapshot } from "./tradingRepository";
import type { BrokerRegistry, TradingBroker } from "./tradingBroker";

type PriceFetcher = (market: string) => Promise<number>;

export interface CreatePaperStrategyInput extends Omit<SaveStrategyInput, "mode" | "status" | "slotBudget"> {
  slotBudget?: number;
  slotPriceOffset?: number;
  targetProfitPriceUnit?: number;
}

export class TradingRunner {
  private timer: NodeJS.Timeout | null = null;
  private tickInProgress = false;
  private readonly brokers: BrokerRegistry;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly fetchPrice: PriceFetcher,
    private readonly intervalMs = 10_000,
    brokers: BrokerRegistry = {}
  ) {
    this.brokers = {
      PAPER: new PaperBroker(),
      ...brokers
    };
  }

  async recover(): Promise<TradingPersistenceSnapshot> {
    const state = getRunnerState(this.db);
    if (state.autoTradingEnabled && state.activeStrategyId && !state.killSwitchEnabled) {
      updateRunnerState(this.db, {
        status: "RECOVERING",
        heartbeatAt: new Date().toISOString(),
        lastObservedPrice: null,
        lastObservedPriceAt: null,
        lastError: null
      });
      appendDecisionLog(this.db, {
        strategyId: state.activeStrategyId,
        action: "RECOVER",
        reason: "server restarted with trading runner enabled"
      });
      await this.start(state.activeStrategyId);
    }

    return getTradingPersistenceSnapshot(this.db);
  }

  createPaperStrategy(input: CreatePaperStrategyInput): TradingPersistenceSnapshot {
    const strategy = saveStrategy(this.db, {
      ...input,
      slotBudget: input.slotBudget ?? input.totalBudget / input.slotCount,
      mode: "PAPER",
      status: "PAUSED",
      config: {
        ...(isRecord(input.config) ? input.config : {}),
        ...(input.slotPriceOffset ? { slotPriceOffset: input.slotPriceOffset } : {}),
        ...(input.targetProfitPriceUnit ? { targetProfitPriceUnit: input.targetProfitPriceUnit } : {}),
        mvp: true
      }
    });
    const slots = createStrategySlots(strategy);

    for (const slot of slots) {
      saveSlot(this.db, {
        strategyId: strategy.id,
        slotNumber: slot.slotNumber,
        buyPrice: slot.buyPrice,
        targetSellPrice: slot.targetSellPrice,
        budget: slot.budget,
        status: "EMPTY"
      });
    }

    updateRunnerState(this.db, {
      activeStrategyId: strategy.id,
      status: "PAUSED",
      autoTradingEnabled: false,
      lastObservedPrice: null,
      lastObservedPriceAt: null,
      lastError: null
    });
    appendDecisionLog(this.db, {
      strategyId: strategy.id,
      market: strategy.market,
      action: "PAUSE",
      reason: "paper strategy created and waiting to start",
      snapshot: {
        slotCount: slots.length
      }
    });

    return getTradingPersistenceSnapshot(this.db);
  }

  async start(strategyId?: string): Promise<TradingPersistenceSnapshot> {
    const strategy = this.resolveStrategy(strategyId);
    this.resolveBroker(strategy);

    const activeStrategy = saveStrategy(this.db, {
      ...strategy,
      config: strategy.config,
      status: "ACTIVE",
      activatedAt: strategy.activatedAt ?? new Date().toISOString(),
      stoppedAt: undefined
    });
    updateRunnerState(this.db, {
      status: "RUNNING",
      activeStrategyId: activeStrategy.id,
      autoTradingEnabled: true,
      killSwitchEnabled: false,
      heartbeatAt: new Date().toISOString(),
      lastError: null
    });
    this.ensureTimer();
    await this.tick();
    return getTradingPersistenceSnapshot(this.db);
  }

  pause(reason = "paper runner paused"): TradingPersistenceSnapshot {
    this.clearTimer();
    const state = updateRunnerState(this.db, {
      status: "PAUSED",
      autoTradingEnabled: false,
      heartbeatAt: new Date().toISOString()
    });
    const strategy = state.activeStrategyId ? this.findStrategy(state.activeStrategyId) : undefined;
    if (strategy) {
      saveStrategy(this.db, { ...strategy, config: strategy.config, status: "PAUSED" });
    }
    appendDecisionLog(this.db, {
      strategyId: state.activeStrategyId,
      action: "PAUSE",
      reason
    });

    return getTradingPersistenceSnapshot(this.db);
  }

  stop(reason = "paper runner stopped"): TradingPersistenceSnapshot {
    this.clearTimer();
    const previousState = getRunnerState(this.db);
    const strategy = previousState.activeStrategyId ? this.findStrategy(previousState.activeStrategyId) : undefined;
    if (strategy) {
      saveStrategy(this.db, {
        ...strategy,
        config: strategy.config,
        status: "STOPPED",
        stoppedAt: new Date().toISOString()
      });
    }
    updateRunnerState(this.db, {
      status: "STOPPED",
      autoTradingEnabled: false,
      heartbeatAt: new Date().toISOString()
    });
    appendDecisionLog(this.db, {
      strategyId: previousState.activeStrategyId,
      action: "PAUSE",
      reason
    });

    return getTradingPersistenceSnapshot(this.db);
  }

  resetTradingData(): TradingPersistenceSnapshot {
    this.clearTimer();
    return clearTradingPersistence(this.db);
  }

  async tick(): Promise<TradingPersistenceSnapshot> {
    if (this.tickInProgress) {
      return getTradingPersistenceSnapshot(this.db);
    }

    this.tickInProgress = true;
    try {
      const state = getRunnerState(this.db);
      if (!state.autoTradingEnabled || state.status !== "RUNNING" || state.killSwitchEnabled || !state.activeStrategyId) {
        return getTradingPersistenceSnapshot(this.db);
      }

      const strategy = this.resolveStrategy(state.activeStrategyId);
      const broker = this.resolveBroker(strategy);

      const currentPrice = await this.fetchPrice(strategy.market);
      if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
        throw new Error("Current price must be greater than 0");
      }
      const observedAt = new Date().toISOString();
      updateRunnerState(this.db, {
        lastMarketPollAt: observedAt,
        lastObservedPrice: currentPrice,
        lastObservedPriceAt: observedAt,
        heartbeatAt: observedAt
      });

      const results = await broker.syncOpenOrders(this.db, strategy, currentPrice);
      if (results.length === 0) {
        const slots = listSlots(this.db, strategy.id);
        appendDecisionLog(this.db, {
          strategyId: strategy.id,
          market: strategy.market,
          currentPrice,
          action: "HOLD",
          reason: "no broker order sync or replenishment was needed",
          snapshot: {
            emptySlots: slots.filter((slot) => slot.status === "EMPTY").length,
            holdingSlots: slots.filter((slot) => slot.status === "HOLDING").length,
            pendingSlots: slots.filter((slot) => slot.status === "BUY_PENDING" || slot.status === "SELL_PENDING").length
          }
        });
      }

      updateRunnerState(this.db, {
        status: "RUNNING",
        heartbeatAt: new Date().toISOString(),
        lastTickAt: new Date().toISOString(),
        lastOrderSyncAt: new Date().toISOString(),
        lastError: null
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected runner error";
      this.clearTimer();
      const state = updateRunnerState(this.db, {
        status: "PAUSED",
        autoTradingEnabled: false,
        heartbeatAt: new Date().toISOString(),
        lastError: message
      });
      appendDecisionLog(this.db, {
        strategyId: state.activeStrategyId,
        action: "ERROR",
        reason: message
      });
      throw error;
    } finally {
      this.tickInProgress = false;
    }

    return getTradingPersistenceSnapshot(this.db);
  }

  private ensureTimer(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      this.tick().catch(() => {
        // tick() records and pauses on errors.
      });
    }, this.intervalMs);
  }

  private clearTimer(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  private resolveStrategy(strategyId?: string): Strategy {
    const state = getRunnerState(this.db);
    const id = strategyId ?? state.activeStrategyId ?? listStrategies(this.db)[0]?.id;
    if (!id) {
      throw new Error("No paper strategy is available");
    }

    return this.findStrategy(id);
  }

  private findStrategy(strategyId: string): Strategy {
    const strategy = listStrategies(this.db).find((item) => item.id === strategyId);
    if (!strategy) {
      throw new Error(`Strategy not found: ${strategyId}`);
    }

    return strategy;
  }

  private resolveBroker(strategy: Strategy): TradingBroker {
    const broker = this.brokers[strategy.mode];
    if (!broker) {
      throw new Error(`${strategy.mode} strategy execution is disabled because no broker is configured`);
    }

    if (broker.mode !== strategy.mode) {
      throw new Error(`Configured ${broker.mode} broker cannot execute ${strategy.mode} strategy`);
    }

    return broker;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

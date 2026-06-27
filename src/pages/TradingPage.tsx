import { Eye, Pause, Play, Plus, RefreshCw, Square, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { UIEvent } from "react";
import PriceChart from "../components/PriceChart";
import { formatKstIso, normalizeRawCandle } from "../shared/candles";
import { defaultTradingSettings } from "../shared/settings";
import { createSlots } from "../shared/simulator";
import type { Candle, RawBithumbCandle, SlotConfig, TradeEvent } from "../shared/types";

type RunnerStatus = "RUNNING" | "PAUSED" | "RECOVERING" | "STOPPED";
type StrategyStatus = "ACTIVE" | "PAUSED" | "STOPPED";
type SlotStatus = "EMPTY" | "HOLDING" | "BUY_PENDING" | "SELL_PENDING" | "PAUSED";

interface RunnerState {
  status: RunnerStatus;
  activeStrategyId?: string;
  autoTradingEnabled: boolean;
  killSwitchEnabled: boolean;
  heartbeatAt?: string;
  lastTickAt?: string;
  lastMarketPollAt?: string;
  lastOrderSyncAt?: string;
  lastObservedPrice?: number;
  lastObservedPriceAt?: string;
  lastError?: string;
}

interface Strategy {
  id: string;
  market: string;
  upperPrice: number;
  lowerPrice: number;
  slotCount: number;
  totalBudget: number;
  slotBudget: number;
  targetProfitRate: number;
  feeRate: number;
  mode: "PAPER" | "LIVE";
  status: StrategyStatus;
  config?: unknown;
  createdAt: string;
  updatedAt: string;
  activatedAt?: string;
  stoppedAt?: string;
}

interface TradingSlot {
  id: string;
  strategyId: string;
  slotNumber: number;
  buyPrice: number;
  targetSellPrice: number;
  budget: number;
  status: SlotStatus;
  entryPrice?: number;
  quantity: number;
  entryGrossAmount: number;
  entryFee: number;
}

interface TradingOrder {
  id: string;
  strategyId: string;
  slotId: string;
  clientOrderId: string;
  market: string;
  side: "BUY" | "SELL";
  orderType: string;
  price?: number;
  quantity?: number;
  amount?: number;
  status: string;
  requestedAt: string;
  acceptedAt?: string;
  updatedAt: string;
  errorMessage?: string;
}

interface TradingFill {
  id: string;
  orderId: string;
  strategyId: string;
  slotId: string;
  price: number;
  quantity: number;
  fee: number;
  tax: number;
  filledAt: string;
}

interface DecisionLog {
  id: number;
  strategyId?: string;
  slotId?: string;
  market?: string;
  currentPrice?: number;
  action: string;
  reason: string;
  createdAt: string;
}

interface TickerInfo {
  market: string;
  trade_price: number;
  signed_change_rate?: number;
  signed_change_price?: number;
  acc_trade_price_24h?: number;
  acc_trade_volume_24h?: number;
  timestamp?: number;
}

interface ApiEnvelope<T> {
  data?: T;
  error?: string;
}

interface TradingSnapshot {
  runnerState: RunnerState;
  strategies: Strategy[];
  slots: TradingSlot[];
  orders: TradingOrder[];
  fills: TradingFill[];
  decisionLogs: DecisionLog[];
  server?: {
    startedAt: string;
  };
}

interface DecisionLogPage {
  logs: DecisionLog[];
  nextOffset: number;
  hasMore: boolean;
}

interface CycleHistoryRow {
  id: string;
  slotNumber?: number;
  sequence: number;
  status: string;
  buy?: OrderLegSummary;
  sell?: OrderLegSummary;
  quantity?: number;
  totalFee: number;
  profit?: number;
  roi?: number;
  updatedAt: string;
  reason?: string;
}

interface OrderFillSummary {
  id: string;
  price: number;
  quantity: number;
  grossAmount: number;
  fee: number;
  tax: number;
  filledAt: string;
}

interface OrderAttemptSummary {
  orderId: string;
  clientOrderId: string;
  side: "BUY" | "SELL";
  status: string;
  orderType: string;
  orderPrice?: number;
  orderQuantity?: number;
  orderAmount?: number;
  fillQuantity: number;
  fillGrossAmount: number;
  fillFee: number;
  requestedAt: string;
  acceptedAt?: string;
  updatedAt: string;
  reason?: string;
  fills: OrderFillSummary[];
}

interface OrderLegSummary {
  orderId: string;
  status: string;
  orderType: string;
  attemptCount: number;
  orderPrice?: number;
  orderQuantity?: number;
  orderAmount?: number;
  fillPrice?: number;
  fillQuantity: number;
  fillGrossAmount: number;
  fillFee: number;
  requestedAt: string;
  completedAt?: string;
  reason?: string;
  attempts: OrderAttemptSummary[];
}

interface StrategyForm {
  market: string;
  upperPrice: number;
  lowerPrice: number;
  slotPriceOffset: number;
  slotBudget: number;
  targetProfitPriceUnit: number;
  feePercent: number;
}

const defaultForm: StrategyForm = {
  ...defaultTradingSettings
};
const decisionLogPageSize = 40;
const cyclePageSize = 40;
const bithumbMinuteCandlePageSize = 200;
const maxTradingChartPages = 240;
const minuteMs = 60_000;
const terminalOrderStatuses = new Set(["FILLED", "CANCELED", "REJECTED", "FAILED"]);
const orderStatusLabels: Record<string, string> = {
  REQUESTED: "요청",
  ACCEPTED: "접수",
  PARTIALLY_FILLED: "부분체결",
  FILLED: "체결",
  CANCELED: "취소",
  REJECTED: "거절",
  FAILED: "실패",
  UNKNOWN: "확인필요"
};
const emptySlotProfit = {
  realizedProfit: 0,
  unrealizedProfit: 0,
  totalProfit: 0
};

export default function TradingPage() {
  const [snapshot, setSnapshot] = useState<TradingSnapshot | null>(null);
  const [form, setForm] = useState<StrategyForm>(defaultForm);
  const [isLoading, setIsLoading] = useState(true);
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [ticker, setTicker] = useState<TickerInfo | null>(null);
  const [tickerError, setTickerError] = useState("");
  const [tickerUpdatedAt, setTickerUpdatedAt] = useState("");
  const [decisionLogs, setDecisionLogs] = useState<DecisionLog[]>([]);
  const [isDecisionLogsLoading, setIsDecisionLogsLoading] = useState(false);
  const [decisionLogHasMore, setDecisionLogHasMore] = useState(true);
  const [visibleCycleCount, setVisibleCycleCount] = useState(cyclePageSize);
  const [selectedCycleId, setSelectedCycleId] = useState<string | null>(null);
  const [tradingCandles, setTradingCandles] = useState<Candle[]>([]);
  const [isTradingChartLoading, setIsTradingChartLoading] = useState(false);
  const [tradingChartError, setTradingChartError] = useState("");
  const decisionLogOffsetRef = useRef(0);
  const isDecisionLogsLoadingRef = useRef(false);
  const decisionLogHasMoreRef = useRef(true);
  const tradingChartRequestRef = useRef(0);

  const activeStrategy = useMemo(() => {
    if (!snapshot) {
      return null;
    }

    return snapshot.strategies.find((strategy) => strategy.id === snapshot.runnerState.activeStrategyId) ?? snapshot.strategies[0] ?? null;
  }, [snapshot]);
  const activeSlots = useMemo(
    () => snapshot?.slots.filter((slot) => slot.strategyId === activeStrategy?.id).sort((left, right) => left.slotNumber - right.slotNumber) ?? [],
    [activeStrategy, snapshot]
  );
  const allActiveOrders = useMemo(
    () => snapshot?.orders.filter((order) => order.strategyId === activeStrategy?.id) ?? [],
    [activeStrategy, snapshot]
  );
  const cycleRows = useMemo(
    () => createCycleRows(allActiveOrders, activeSlots, snapshot?.fills ?? []),
    [allActiveOrders, activeSlots, snapshot]
  );
  const visibleCycleRows = useMemo(() => cycleRows.slice(0, visibleCycleCount), [cycleRows, visibleCycleCount]);
  const selectedCycle = useMemo(
    () => (selectedCycleId ? cycleRows.find((cycle) => cycle.id === selectedCycleId) ?? null : null),
    [cycleRows, selectedCycleId]
  );
  const slotProfitById = useMemo(
    () => calculateSlotProfits(activeSlots, snapshot?.orders ?? [], snapshot?.fills ?? [], activeStrategy?.feeRate ?? 0, ticker?.trade_price),
    [activeSlots, activeStrategy, snapshot, ticker]
  );
  const completedCycleCountBySlotNumber = useMemo(() => countCompletedCyclesBySlotNumber(cycleRows), [cycleRows]);
  const latestCycleBySlotNumber = useMemo(() => createLatestCycleBySlotNumber(cycleRows), [cycleRows]);
  const formSlotPreview = useMemo(() => createSlotPreview(form), [form]);
  const targetReturnPreview = useMemo(() => getTargetReturnPreview(formSlotPreview), [formSlotPreview]);
  const activeSlotPriceOffset = useMemo(() => getSlotPriceOffset(activeStrategy, activeSlots), [activeStrategy, activeSlots]);
  const activeTargetProfitPriceUnit = useMemo(() => getTargetProfitPriceUnit(activeStrategy, activeSlots), [activeStrategy, activeSlots]);
  const tickerMarket = (activeStrategy?.market ?? form.market).trim().toUpperCase();
  const tradingChartStartedAt = getTradingChartStartedAt(activeStrategy);
  const tradingChartCandles = useMemo(
    () => mergeRealtimeTickerCandle(tradingCandles, ticker, tradingChartStartedAt),
    [ticker, tradingCandles, tradingChartStartedAt]
  );
  const tradingChartEvents = useMemo(
    () => createTradingChartEvents(activeSlots, snapshot?.orders ?? [], snapshot?.fills ?? [], tradingChartStartedAt),
    [activeSlots, snapshot, tradingChartStartedAt]
  );
  const tradingChartStatus = getTradingChartStatus(tradingChartStartedAt, tradingChartCandles, isTradingChartLoading);

  useEffect(() => {
    loadSnapshot();
    loadDecisionLogs({ reset: true }).catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : "판단 로그 조회 실패");
    });
    const timer = window.setInterval(() => {
      loadSnapshot({ quiet: true });
    }, 5_000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setVisibleCycleCount(cyclePageSize);
    setSelectedCycleId(null);
  }, [activeStrategy?.id]);

  useEffect(() => {
    let isMounted = true;

    async function pollTicker() {
      if (!/^[A-Z0-9]+-[A-Z0-9]+$/.test(tickerMarket)) {
        if (isMounted) {
          setTicker(null);
          setTickerError("마켓 형식을 확인하세요.");
        }
        return;
      }

      try {
        const payload = await fetchJson<ApiEnvelope<TickerInfo[]>>(`/api/bithumb/ticker?markets=${encodeURIComponent(tickerMarket)}`);
        const nextTicker = Array.isArray(payload.data) ? payload.data[0] : null;
        if (!nextTicker) {
          throw new Error("현재가 응답 없음");
        }

        if (isMounted) {
          setTicker(nextTicker);
          setTickerError("");
          setTickerUpdatedAt(formatUpdatedAt(new Date()));
        }
      } catch (tickerLoadError) {
        if (isMounted) {
          setTickerError(tickerLoadError instanceof Error ? tickerLoadError.message : "현재가 조회 실패");
        }
      }
    }

    pollTicker();
    const timer = window.setInterval(pollTicker, 3_000);

    return () => {
      isMounted = false;
      window.clearInterval(timer);
    };
  }, [tickerMarket]);

  useEffect(() => {
    const requestId = tradingChartRequestRef.current + 1;
    tradingChartRequestRef.current = requestId;
    setTradingCandles([]);
    setTradingChartError("");

    if (!tradingChartStartedAt || !/^[A-Z0-9]+-[A-Z0-9]+$/.test(tickerMarket)) {
      setIsTradingChartLoading(false);
      return;
    }

    let isMounted = true;

    async function refreshTradingCandles(options: { quiet?: boolean } = {}) {
      if (!options.quiet) {
        setIsTradingChartLoading(true);
      }

      try {
        const candles = await loadTradingCandles(tickerMarket, tradingChartStartedAt);
        if (isMounted && tradingChartRequestRef.current === requestId) {
          setTradingCandles(candles);
          setTradingChartError("");
        }
      } catch (chartLoadError) {
        if (isMounted && tradingChartRequestRef.current === requestId) {
          setTradingChartError(chartLoadError instanceof Error ? chartLoadError.message : "차트 데이터 조회 실패");
        }
      } finally {
        if (isMounted && tradingChartRequestRef.current === requestId) {
          setIsTradingChartLoading(false);
        }
      }
    }

    refreshTradingCandles();
    const timer = window.setInterval(() => {
      refreshTradingCandles({ quiet: true });
    }, minuteMs);

    return () => {
      isMounted = false;
      window.clearInterval(timer);
    };
  }, [tickerMarket, tradingChartStartedAt]);

  async function loadSnapshot(options: { quiet?: boolean } = {}) {
    if (!options.quiet) {
      setIsLoading(true);
      setError("");
    }

    try {
      setSnapshot(await fetchJson<TradingSnapshot>("/api/trading/persistence"));
    } catch (loadError) {
      if (!options.quiet) {
        setError(loadError instanceof Error ? loadError.message : "상태 조회 실패");
      }
    } finally {
      if (!options.quiet) {
        setIsLoading(false);
      }
    }
  }

  async function loadDecisionLogs(options: { reset?: boolean } = {}) {
    if (isDecisionLogsLoadingRef.current) {
      return;
    }

    if (!options.reset && !decisionLogHasMoreRef.current) {
      return;
    }

    const offset = options.reset ? 0 : decisionLogOffsetRef.current;
    isDecisionLogsLoadingRef.current = true;
    setIsDecisionLogsLoading(true);

    try {
      const params = new URLSearchParams({
        limit: String(decisionLogPageSize),
        offset: String(offset)
      });
      const payload = await fetchJson<DecisionLogPage>(`/api/trading/decision-logs?${params.toString()}`);

      setDecisionLogs((current) => (options.reset ? payload.logs : mergeLogs(current, payload.logs)));
      decisionLogOffsetRef.current = payload.nextOffset;
      decisionLogHasMoreRef.current = payload.hasMore;
      setDecisionLogHasMore(payload.hasMore);
    } finally {
      isDecisionLogsLoadingRef.current = false;
      setIsDecisionLogsLoading(false);
    }
  }

  async function createStrategy() {
    setIsWorking(true);
    setError("");
    setStatus("");

    if (formSlotPreview.length === 0) {
      setError("슬롯 간격, 목표 수익 단위, 가격 밴드를 확인하세요.");
      setIsWorking(false);
      return;
    }

    try {
      const payload = await postJson<TradingSnapshot>("/api/trading/strategy", form);
      setSnapshot(payload);
      await loadDecisionLogs({ reset: true });
      setStatus("PAPER 전략 생성 완료");
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "전략 생성 실패");
    } finally {
      setIsWorking(false);
    }
  }

  async function controlRunner(action: "start" | "pause" | "stop" | "tick") {
    setIsWorking(true);
    setError("");
    setStatus("");

    try {
      const payload = await postJson<TradingSnapshot>(`/api/trading/${action}`, {
        strategyId: activeStrategy?.id
      });
      setSnapshot(payload);
      await loadDecisionLogs({ reset: true });
      setStatus(actionLabel(action));
    } catch (controlError) {
      setError(controlError instanceof Error ? controlError.message : "러너 제어 실패");
    } finally {
      setIsWorking(false);
    }
  }

  async function resetTradingData() {
    const shouldReset = window.confirm("전략, 슬롯, 주문, 체결, 판단 로그를 모두 초기화할까요?");
    if (!shouldReset) {
      return;
    }

    setIsWorking(true);
    setError("");
    setStatus("");

    try {
      const payload = await postJson<TradingSnapshot>("/api/trading/reset", {});
      setSnapshot(payload);
      setDecisionLogs([]);
      decisionLogOffsetRef.current = 0;
      decisionLogHasMoreRef.current = false;
      setDecisionLogHasMore(false);
      setStatus("테스트 데이터 초기화 완료");
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : "테스트 데이터 초기화 실패");
    } finally {
      setIsWorking(false);
    }
  }

  const runner = snapshot?.runnerState;
  const holdingSlots = activeSlots.filter(isPositionSlot).length;
  const pendingSlots = activeSlots.filter((slot) => slot.status === "BUY_PENDING" || slot.status === "SELL_PENDING").length;

  function handleDecisionLogScroll(event: UIEvent<HTMLDivElement>) {
    const target = event.currentTarget;
    if (target.scrollTop + target.clientHeight >= target.scrollHeight - 48) {
      loadDecisionLogs().catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : "판단 로그 조회 실패");
      });
    }
  }

  function handleCycleScroll(event: UIEvent<HTMLDivElement>) {
    const target = event.currentTarget;
    if (target.scrollTop + target.clientHeight >= target.scrollHeight - 48) {
      setVisibleCycleCount((current) => Math.min(current + cyclePageSize, cycleRows.length));
    }
  }

  return (
    <main className="appShell">
      <header className="topBar">
        <div>
          <h1>자동매매</h1>
          <p>PAPER ONLY · {activeStrategy?.market ?? "전략 없음"}</p>
        </div>
        <div className="summaryStrip compact">
          <Metric label="현재가" value={ticker ? money(ticker.trade_price) : "조회 중"} tone={profitTone(ticker?.signed_change_rate ?? 0)} />
          <Metric label="러너" value={runner?.status ?? "조회 전"} tone={runner?.status === "RUNNING" ? "good" : undefined} />
          <Metric label="보유/접수" value={`${holdingSlots}/${pendingSlots}/${activeSlots.length}`} />
        </div>
      </header>

      <section className="tradingLayout">
        <aside className="controlPanel">
          <div className="sectionHeader compactHeader">
            <h2>전략 생성</h2>
            <span className="muted">PAPER</span>
          </div>

          <div className="fieldGrid single">
            <TextField label="마켓" value={form.market} onChange={(market) => updateForm("market", market.toUpperCase())} />
          </div>
          <div className="fieldGrid">
            <NumberField label="슬롯 간격" value={form.slotPriceOffset} min={1} step={1} onChange={(slotPriceOffset) => updateForm("slotPriceOffset", Math.max(1, Math.round(slotPriceOffset)))} />
            <NumberField label="슬롯별 투자금" value={form.slotBudget} min={1000} step={10000} onChange={(slotBudget) => updateForm("slotBudget", slotBudget)} />
            <NumberField label="상단 가격" value={form.upperPrice} step={1} onChange={(upperPrice) => updateForm("upperPrice", Math.floor(upperPrice))} />
            <NumberField label="하단 가격" value={form.lowerPrice} step={1} onChange={(lowerPrice) => updateForm("lowerPrice", Math.floor(lowerPrice))} />
            <NumberField label="목표 수익 단위" value={form.targetProfitPriceUnit} min={1} step={1} onChange={(targetProfitPriceUnit) => updateForm("targetProfitPriceUnit", Math.max(1, Math.round(targetProfitPriceUnit)))} />
            <NumberField label="수수료 %" value={form.feePercent} min={0} step={0.01} onChange={(feePercent) => updateForm("feePercent", feePercent)} />
          </div>

          <div className="dataNote">
            <span>예상 슬롯 {formSlotPreview.length.toLocaleString("ko-KR")}개</span>
            <span>총 PAPER 예산 {money(form.slotBudget * formSlotPreview.length)}</span>
          </div>

          {targetReturnPreview && (
            <div className="returnFormula">
              <span>평균 기준 정수 수익률 - 수수료</span>
              <strong className={profitClass(targetReturnPreview.netRate)}>
                {percent(targetReturnPreview.grossRate)} - {percent(targetReturnPreview.feeImpactRate)} = {percent(targetReturnPreview.netRate)}
              </strong>
            </div>
          )}

          <div className="slotPreview">
            <h2>슬롯 가격 ({formSlotPreview.length}개)</h2>
            <table>
              <thead>
                <tr>
                  <th>슬롯</th>
                  <th>매수</th>
                  <th>목표</th>
                  <th>순수익률</th>
                </tr>
              </thead>
              <tbody>
                {formSlotPreview.map((slot) => (
                  <tr key={slot.slotNumber}>
                    <td>S{slot.slotNumber}</td>
                    <td>{money(slot.buyPrice)}</td>
                    <td>{money(slot.targetSellPrice)}</td>
                    <td className={profitClass(slot.netTargetProfitRate)}>{percent(slot.netTargetProfitRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button className="primaryButton fullWidthButton" disabled={isWorking} onClick={createStrategy} type="button">
            <Plus size={16} />
            전략 생성
          </button>

          <div className="buttonRow">
            <button className="primaryButton" disabled={!activeStrategy || isWorking} onClick={() => controlRunner("start")} type="button">
              <Play size={16} />
              시작
            </button>
            <button className="ghostButton" disabled={!activeStrategy || isWorking} onClick={() => controlRunner("pause")} title="일시정지" type="button">
              <Pause size={16} />
            </button>
            <button className="ghostButton" disabled={!activeStrategy || isWorking} onClick={() => controlRunner("stop")} title="중지" type="button">
              <Square size={16} />
            </button>
          </div>

          <button className="secondaryButton" disabled={isLoading || isWorking} onClick={() => loadSnapshot()} type="button">
            <RefreshCw size={16} />
            새로고침
          </button>
          <button className="secondaryButton spacedButton" disabled={!activeStrategy || isWorking} onClick={() => controlRunner("tick")} type="button">
            1회 실행
          </button>
          <button className="dangerButton spacedButton" disabled={isWorking} onClick={resetTradingData} type="button">
            <Trash2 size={16} />
            테스트 초기화
          </button>

          {status && <p className="statusText">{status}</p>}
          {error && <p className="errorText">{error}</p>}
          {tickerError && <p className="errorText">{tickerError}</p>}
          {runner?.lastError && <p className="errorText">{runner.lastError}</p>}
        </aside>

        <section className="tradingMain">
          <article className="dashboardPanel wide tradingChartPanel">
            <div className="sectionHeader">
              <h2>전략 실행 차트</h2>
              <span className="muted">{tradingChartStatus}</span>
            </div>
            {!tradingChartStartedAt ? (
              <div className="emptyResult">전략을 시작하면 실행 시각부터 현재까지의 차트가 표시됩니다.</div>
            ) : (
              <>
                <PriceChart candles={tradingChartCandles} events={tradingChartEvents} />
                {tradingChartError && <p className="errorText">{tradingChartError}</p>}
              </>
            )}
          </article>

          <article className="dashboardPanel wide">
            <div className="sectionHeader">
              <h2>실시간 시세</h2>
              <span className="muted">{tickerUpdatedAt ? `최근 갱신 ${tickerUpdatedAt}` : "조회 전"}</span>
            </div>
            <div className="summaryTable">
              <div><span>마켓</span><strong>{tickerMarket}</strong></div>
              <div><span>현재가</span><strong>{ticker ? money(ticker.trade_price) : "-"}</strong></div>
              <div><span>전일 대비</span><strong className={profitClass(ticker?.signed_change_rate ?? 0)}>{ticker ? percent(ticker.signed_change_rate ?? 0) : "-"}</strong></div>
              <div><span>변동 금액</span><strong className={profitClass(ticker?.signed_change_price ?? 0)}>{ticker ? money(ticker.signed_change_price ?? 0) : "-"}</strong></div>
              <div><span>24h 거래대금</span><strong>{ticker ? money(ticker.acc_trade_price_24h ?? 0) : "-"}</strong></div>
              <div><span>최근 갱신</span><strong>{tickerUpdatedAt || "-"}</strong></div>
            </div>
          </article>

          <article className="dashboardPanel wide">
            <div className="sectionHeader">
              <h2>전략 상태</h2>
              <span className="muted">{activeStrategy ? activeStrategy.id.slice(0, 8) : "없음"}</span>
            </div>
            {!activeStrategy ? (
              <div className="emptyResult">PAPER 전략을 생성하면 슬롯과 주문 상태가 표시됩니다.</div>
            ) : (
              <div className="summaryTable">
                <div><span>마켓</span><strong>{activeStrategy.market}</strong></div>
                <div><span>모드</span><strong>{activeStrategy.mode}</strong></div>
                <div><span>상태</span><strong>{activeStrategy.status}</strong></div>
                <div><span>가격 밴드</span><strong>{money(activeStrategy.lowerPrice)} - {money(activeStrategy.upperPrice)}</strong></div>
                <div><span>슬롯 간격</span><strong>{activeSlotPriceOffset === null ? "-" : money(activeSlotPriceOffset)}</strong></div>
                <div><span>슬롯 개수</span><strong>{activeStrategy.slotCount.toLocaleString("ko-KR")}개</strong></div>
                <div><span>슬롯 예산</span><strong>{money(activeStrategy.slotBudget)}</strong></div>
                <div><span>목표 수익 단위</span><strong>{activeTargetProfitPriceUnit === null ? percent(activeStrategy.targetProfitRate) : money(activeTargetProfitPriceUnit)}</strong></div>
              </div>
            )}
          </article>

          <article className="dashboardPanel wide">
            <div className="sectionHeader">
              <h2>슬롯</h2>
              <span className="muted">{activeSlots.length.toLocaleString("ko-KR")}개</span>
            </div>
            <div className="tableScroller">
              <table className="assetTable tradingSlotTable">
                <thead>
                  <tr>
                    <th>슬롯</th>
                    <th>상태</th>
                    <th>매수가</th>
                    <th>목표가</th>
                    <th>예산</th>
                    <th>진입가</th>
                    <th>수량</th>
                    <th>매도건수</th>
                    <th>실현</th>
                    <th>평가</th>
                    <th>합산</th>
                    <th>이력</th>
                  </tr>
                </thead>
                <tbody>
                  {activeSlots.map((slot) => {
                    const profit = slotProfitById.get(slot.id) ?? emptySlotProfit;
                    const completedCycleCount = completedCycleCountBySlotNumber.get(slot.slotNumber) ?? 0;
                    const latestCycle = latestCycleBySlotNumber.get(slot.slotNumber);
                    return (
                      <tr key={slot.id}>
                        <td>S{slot.slotNumber}</td>
                        <td><StatusBadge status={slot.status} /></td>
                        <td>{money(slot.buyPrice)}</td>
                        <td>{money(slot.targetSellPrice)}</td>
                        <td>{money(slot.budget)}</td>
                        <td>{slot.entryPrice ? money(slot.entryPrice) : "-"}</td>
                        <td>{slot.quantity ? decimal(slot.quantity) : "-"}</td>
                        <td>{completedCycleCount.toLocaleString("ko-KR")}</td>
                        <td className={profitClass(profit.realizedProfit)}>{money(profit.realizedProfit)}</td>
                        <td className={isPositionSlot(slot) ? profitClass(profit.unrealizedProfit) : "mutedValue"}>{isPositionSlot(slot) ? money(profit.unrealizedProfit) : "-"}</td>
                        <td className={profitClass(profit.totalProfit)}>{money(profit.totalProfit)}</td>
                        <td>
                          <button className="tableActionButton" disabled={!latestCycle} onClick={() => latestCycle && setSelectedCycleId(latestCycle.id)} type="button">
                            <Eye size={14} />
                            상세
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </article>

          <article className="dashboardPanel wide">
            <div className="sectionHeader">
              <h2>사이클 이력</h2>
              <span className="muted">{visibleCycleRows.length.toLocaleString("ko-KR")} / {cycleRows.length.toLocaleString("ko-KR")}건</span>
            </div>
            <div className="tableScroller cycleHistoryScroller" onScroll={handleCycleScroll}>
              <table className="assetTable cycleHistoryTable">
                <thead>
                  <tr>
                    <th>슬롯</th>
                    <th>상태</th>
                    <th>매수 주문</th>
                    <th>매수 체결</th>
                    <th>매도 주문</th>
                    <th>매도 체결</th>
                    <th>수량</th>
                    <th>수수료</th>
                    <th>순손익</th>
                    <th>수익률</th>
                    <th>최근시각</th>
                    <th>상세</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleCycleRows.length === 0 ? (
                    <tr>
                      <td className="mutedValue" colSpan={12}>사이클 없음</td>
                    </tr>
                  ) : (
                    visibleCycleRows.map((cycle) => (
                      <tr className="clickableTableRow" key={cycle.id} onDoubleClick={() => setSelectedCycleId(cycle.id)}>
                        <td>
                          <strong>{cycle.slotNumber ? `S${cycle.slotNumber}` : "-"}</strong>
                          <span>{cycle.sequence}회차</span>
                        </td>
                        <td><StatusBadge status={cycle.status} /></td>
                        <td><OrderLegCell leg={cycle.buy} /></td>
                        <td><OrderFillCell leg={cycle.buy} /></td>
                        <td><OrderLegCell leg={cycle.sell} /></td>
                        <td><OrderFillCell leg={cycle.sell} /></td>
                        <td>{cycle.quantity ? decimal(cycle.quantity) : "-"}</td>
                        <td>{cycle.totalFee ? money(cycle.totalFee) : "-"}</td>
                        <td className={cycle.profit === undefined ? "mutedValue" : profitClass(cycle.profit)}>{cycle.profit === undefined ? "-" : money(cycle.profit)}</td>
                        <td className={cycle.roi === undefined ? "mutedValue" : profitClass(cycle.roi)}>{cycle.roi === undefined ? "-" : percent(cycle.roi)}</td>
                        <td>{shortTime(cycle.updatedAt)}</td>
                        <td>
                          <button className="tableActionButton" onClick={() => setSelectedCycleId(cycle.id)} type="button">
                            <Eye size={14} />
                            상세
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
              <div className="cycleMobileList">
                {visibleCycleRows.length === 0 ? (
                  <div className="emptyResult small">사이클 없음</div>
                ) : (
                  visibleCycleRows.map((cycle) => (
                    <button className="cycleMobileCard" key={cycle.id} onClick={() => setSelectedCycleId(cycle.id)} type="button">
                      <span className="cycleMobileCardHeader">
                        <span>
                          <strong>{cycle.slotNumber ? `S${cycle.slotNumber}` : "-"}</strong>
                          <em>{cycle.sequence}회차</em>
                        </span>
                        <StatusBadge status={cycle.status} />
                      </span>
                      <span className="cycleMobileCardGrid">
                        <span><em>매수</em><strong>{cycle.buy?.fillPrice ? money(cycle.buy.fillPrice) : cycle.buy ? orderValue(cycle.buy) : "-"}</strong></span>
                        <span><em>매도</em><strong>{cycle.sell?.fillPrice ? money(cycle.sell.fillPrice) : cycle.sell ? orderValue(cycle.sell) : "-"}</strong></span>
                        <span><em>수량</em><strong>{cycle.quantity ? decimal(cycle.quantity) : "-"}</strong></span>
                        <span><em>손익</em><strong className={cycle.profit === undefined ? "" : profitClass(cycle.profit)}>{cycle.profit === undefined ? "-" : money(cycle.profit)}</strong></span>
                      </span>
                      <span className="cycleMobileCardFooter">
                        <span>{shortTime(cycle.updatedAt)}</span>
                        <span>{cycle.roi === undefined ? "-" : percent(cycle.roi)}</span>
                      </span>
                    </button>
                  ))
                )}
              </div>
              {cycleRows.length > 0 && visibleCycleCount < cycleRows.length ? (
                <button className="tableLoadMoreButton" onClick={() => setVisibleCycleCount((current) => Math.min(current + cyclePageSize, cycleRows.length))} type="button">
                  더 보기
                </button>
              ) : (
                cycleRows.length > 0 && <div className="miniListStatus">마지막 사이클</div>
              )}
            </div>
          </article>

          <article className="dashboardPanel">
            <div className="sectionHeader">
              <h2>판단 로그</h2>
            </div>
            <div className="miniList decisionLogList" onScroll={handleDecisionLogScroll}>
              {decisionLogs.length === 0 && !isDecisionLogsLoading ? (
                <div className="emptyResult small">로그 없음</div>
              ) : (
                decisionLogs.map((log) => (
                  <div className="miniListRow" key={log.id}>
                    <div>
                      <strong>{log.action}</strong>
                      <span>{shortTime(log.createdAt)}</span>
                    </div>
                    <div>
                      <strong>{log.currentPrice ? money(log.currentPrice) : "-"}</strong>
                      <span>{log.reason}</span>
                    </div>
                  </div>
                ))
              )}
              {isDecisionLogsLoading && <div className="miniListStatus">불러오는 중</div>}
              {!decisionLogHasMore && decisionLogs.length > 0 && <div className="miniListStatus">마지막 로그</div>}
            </div>
          </article>
        </section>
      </section>
      {selectedCycle && (
        <div className="modalBackdrop" role="dialog" aria-modal="true" onClick={() => setSelectedCycleId(null)}>
          <div className="modalPanel" onClick={(event) => event.stopPropagation()}>
            <div className="modalHeader">
              <div>
                <h2>{selectedCycle.slotNumber ? `S${selectedCycle.slotNumber}` : "-"} {selectedCycle.sequence}회차 상세</h2>
                <span className="muted">{selectedCycle.status} · 최근 {shortTime(selectedCycle.updatedAt)}</span>
              </div>
              <button className="ghostButton modalCloseButton" onClick={() => setSelectedCycleId(null)} title="닫기" type="button">
                <X size={16} />
              </button>
            </div>
            <div className="cycleDetailBody">
              <div className="summaryTable cycleSummaryTable">
                <div><span>상태</span><strong><StatusBadge status={selectedCycle.status} /></strong></div>
                <div><span>매수 체결</span><strong>{selectedCycle.buy?.fillQuantity ? `${decimal(selectedCycle.buy.fillQuantity)} · ${money(selectedCycle.buy.fillGrossAmount)}` : "-"}</strong></div>
                <div><span>매도 체결</span><strong>{selectedCycle.sell?.fillQuantity ? `${decimal(selectedCycle.sell.fillQuantity)} · ${money(selectedCycle.sell.fillGrossAmount)}` : "-"}</strong></div>
                <div><span>총 수수료</span><strong>{selectedCycle.totalFee ? money(selectedCycle.totalFee) : "-"}</strong></div>
                <div><span>순손익</span><strong className={selectedCycle.profit === undefined ? "" : profitClass(selectedCycle.profit)}>{selectedCycle.profit === undefined ? "-" : money(selectedCycle.profit)}</strong></div>
                <div><span>수익률</span><strong className={selectedCycle.roi === undefined ? "" : profitClass(selectedCycle.roi)}>{selectedCycle.roi === undefined ? "-" : percent(selectedCycle.roi)}</strong></div>
                <div className="wideSummaryCell"><span>사유</span><strong>{selectedCycle.reason ?? "-"}</strong></div>
              </div>
              <div className="cycleDetailGrid">
                <CycleLegDetail title="매수 상세" leg={selectedCycle.buy} />
                <CycleLegDetail title="매도 상세" leg={selectedCycle.sell} />
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );

  function updateForm<K extends keyof StrategyForm>(key: K, value: StrategyForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }
}

function mergeLogs(current: DecisionLog[], next: DecisionLog[]) {
  const seen = new Set(current.map((log) => log.id));
  return [...current, ...next.filter((log) => !seen.has(log.id))];
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`orderStatusBadge ${statusBadgeToneClass(status)}`}>{statusBadgeLabel(status)}</span>;
}

function OrderLegCell({ leg }: { leg?: OrderLegSummary }) {
  if (!leg) {
    return <span className="mutedValue">-</span>;
  }

  return (
    <div className="orderLegCell">
      <strong>{orderValue(leg)}</strong>
      <span>{orderStatusLabel(leg.status)} · {shortTime(leg.requestedAt)}</span>
      <span>{leg.orderType}{leg.attemptCount > 1 ? ` · 시도 ${leg.attemptCount}회` : ""}</span>
    </div>
  );
}

function OrderFillCell({ leg }: { leg?: OrderLegSummary }) {
  if (!leg || leg.fillQuantity <= 0) {
    return <span className="mutedValue">-</span>;
  }

  return (
    <div className="orderLegCell">
      <strong>{leg.fillPrice ? money(leg.fillPrice) : "-"}</strong>
      <span>{decimal(leg.fillQuantity)} · {money(leg.fillGrossAmount)}</span>
      <span>{leg.completedAt ? shortTime(leg.completedAt) : "-"}</span>
    </div>
  );
}

function CycleLegDetail({ title, leg }: { title: string; leg?: OrderLegSummary }) {
  return (
    <section className="cycleLegDetail">
      <div className="sectionHeader compactHeader">
        <h3>{title}</h3>
        <span className="muted">
          {leg ? `${leg.attemptCount.toLocaleString("ko-KR")}회 시도 · 체결 ${decimal(leg.fillQuantity)}` : "내역 없음"}
        </span>
      </div>
      <div className="tableScroller">
        <table className="assetTable cycleDetailTable">
          <thead>
            <tr>
              <th>주문</th>
              <th>상태</th>
              <th>주문값</th>
              <th>체결</th>
              <th>시각</th>
              <th>사유</th>
            </tr>
          </thead>
          <tbody>
            {!leg ? (
              <tr>
                <td className="mutedValue" colSpan={6}>내역 없음</td>
              </tr>
            ) : (
              leg.attempts.map((attempt, index) => (
                <tr key={attempt.orderId}>
                  <td>
                    <strong>{attempt.side === "BUY" ? "매수" : "매도"} {index + 1}</strong>
                    <span>{attempt.clientOrderId}</span>
                  </td>
                  <td><StatusBadge status={attempt.status} /></td>
                  <td><OrderAttemptValueCell attempt={attempt} /></td>
                  <td><OrderAttemptFillCell attempt={attempt} /></td>
                  <td>
                    <div className="orderLegCell">
                      <strong>{shortTime(attempt.requestedAt)}</strong>
                      <span>접수 {attempt.acceptedAt ? shortTime(attempt.acceptedAt) : "-"}</span>
                      <span>갱신 {shortTime(attempt.updatedAt)}</span>
                    </div>
                  </td>
                  <td>{attempt.reason ?? "-"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function OrderAttemptValueCell({ attempt }: { attempt: OrderAttemptSummary }) {
  return (
    <div className="orderLegCell">
      <strong>{orderAttemptValue(attempt)}</strong>
      <span>{attempt.orderType}</span>
      <span>{attempt.orderId.slice(0, 8)}</span>
    </div>
  );
}

function OrderAttemptFillCell({ attempt }: { attempt: OrderAttemptSummary }) {
  if (attempt.fills.length === 0) {
    return <span className="mutedValue">-</span>;
  }

  return (
    <div className="orderLegCell">
      <strong>{attempt.fillQuantity > 0 ? money(attempt.fillGrossAmount / attempt.fillQuantity) : "-"}</strong>
      {attempt.fills.map((fill) => (
        <span key={fill.id}>
          {shortTime(fill.filledAt)} · {money(fill.price)} · {decimal(fill.quantity)} · {money(fill.grossAmount)} · 수수료 {money(fill.fee + fill.tax)}
        </span>
      ))}
    </div>
  );
}

function createCycleRows(orders: TradingOrder[], slots: TradingSlot[], fills: TradingFill[]): CycleHistoryRow[] {
  const slotsById = new Map(slots.map((slot) => [slot.id, slot]));
  const fillsByOrderId = new Map<string, TradingFill[]>();
  for (const fill of fills) {
    const next = fillsByOrderId.get(fill.orderId) ?? [];
    next.push(fill);
    fillsByOrderId.set(fill.orderId, next);
  }

  const ordersBySlotId = new Map<string, TradingOrder[]>();
  for (const order of orders) {
    const next = ordersBySlotId.get(order.slotId) ?? [];
    next.push(order);
    ordersBySlotId.set(order.slotId, next);
  }

  const rows: CycleHistoryRow[] = [];
  for (const [slotId, slotOrders] of ordersBySlotId) {
    const slot = slotsById.get(slotId);
    let sequence = 0;
    let current: OrderGroupDraft | undefined;
    const sortedOrders = [...slotOrders].sort(compareOrderAsc);

    for (const order of sortedOrders) {
      const leg = createOrderLegSummary(order, fillsByOrderId.get(order.id) ?? []);

      if (order.side === "BUY") {
        if (!current) {
          sequence += 1;
          current = createOrderGroupDraft(slotId, slot?.slotNumber, sequence, leg);
          continue;
        }

        if (!current.sell && !isFilledLeg(current.buy)) {
          current.buy = mergeOrderLegAttempt(current.buy, leg);
          continue;
        }

        rows.push(finalizeOrderHistoryRow(current));
        sequence += 1;
        current = createOrderGroupDraft(slotId, slot?.slotNumber, sequence, leg);
        continue;
      }

      if (!current || !current.buy) {
        sequence += 1;
        rows.push(finalizeOrderHistoryRow({
          id: `${slotId}:${sequence}:${order.id}`,
          slotNumber: slot?.slotNumber,
          sequence,
          sell: leg
        }));
        continue;
      }

      if (!current.sell || !isFilledLeg(current.sell)) {
        current.sell = mergeOrderLegAttempt(current.sell, leg);
        continue;
      }

      rows.push(finalizeOrderHistoryRow(current));
      sequence += 1;
      rows.push(finalizeOrderHistoryRow({
        id: `${slotId}:${sequence}:${order.id}`,
        slotNumber: slot?.slotNumber,
        sequence,
        sell: leg
      }));
      current = undefined;
    }

    if (current) {
      rows.push(finalizeOrderHistoryRow(current));
    }
  }

  return rows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
}

interface OrderGroupDraft {
  id: string;
  slotNumber?: number;
  sequence: number;
  buy?: OrderLegSummary;
  sell?: OrderLegSummary;
}

function createOrderGroupDraft(slotId: string, slotNumber: number | undefined, sequence: number, buy: OrderLegSummary): OrderGroupDraft {
  return {
    id: `${slotId}:${sequence}:${buy.orderId}`,
    slotNumber,
    sequence,
    buy
  };
}

function createOrderLegSummary(order: TradingOrder, orderFills: TradingFill[]): OrderLegSummary {
  const sortedFills = [...orderFills].sort((left, right) => left.filledAt.localeCompare(right.filledAt) || left.id.localeCompare(right.id));
  const fillSummaries = sortedFills.map((fill): OrderFillSummary => ({
    id: fill.id,
    price: fill.price,
    quantity: fill.quantity,
    grossAmount: fill.price * fill.quantity,
    fee: fill.fee,
    tax: fill.tax,
    filledAt: fill.filledAt
  }));
  const fillQuantity = sortedFills.reduce((sum, fill) => sum + fill.quantity, 0);
  const fillGrossAmount = sortedFills.reduce((sum, fill) => sum + fill.price * fill.quantity, 0);
  const fillFee = sortedFills.reduce((sum, fill) => sum + fill.fee + fill.tax, 0);
  const latestFill = sortedFills[sortedFills.length - 1];
  const attempt: OrderAttemptSummary = {
    orderId: order.id,
    clientOrderId: order.clientOrderId,
    side: order.side,
    status: order.status,
    orderType: order.orderType,
    orderPrice: order.price,
    orderQuantity: order.quantity,
    orderAmount: order.amount,
    fillQuantity,
    fillGrossAmount,
    fillFee,
    requestedAt: order.requestedAt,
    acceptedAt: order.acceptedAt,
    updatedAt: order.updatedAt,
    reason: order.errorMessage,
    fills: fillSummaries
  };

  return {
    orderId: order.id,
    status: order.status,
    orderType: order.orderType,
    attemptCount: 1,
    orderPrice: order.price,
    orderQuantity: order.quantity,
    orderAmount: order.amount,
    fillPrice: fillQuantity > 0 ? fillGrossAmount / fillQuantity : undefined,
    fillQuantity,
    fillGrossAmount,
    fillFee,
    requestedAt: order.requestedAt,
    completedAt: latestFill?.filledAt ?? (terminalOrderStatuses.has(order.status) ? order.updatedAt : undefined),
    reason: order.errorMessage,
    attempts: [attempt]
  };
}

function mergeOrderLegAttempt(current: OrderLegSummary | undefined, next: OrderLegSummary): OrderLegSummary {
  if (!current) {
    return next;
  }

  const fillQuantity = current.fillQuantity + next.fillQuantity;
  const fillGrossAmount = current.fillGrossAmount + next.fillGrossAmount;
  const fillFee = current.fillFee + next.fillFee;
  return {
    ...next,
    attemptCount: current.attemptCount + next.attemptCount,
    fillPrice: fillQuantity > 0 ? fillGrossAmount / fillQuantity : undefined,
    fillQuantity,
    fillGrossAmount,
    fillFee,
    completedAt: latestIso([current.completedAt, next.completedAt]),
    reason: next.reason ?? current.reason,
    attempts: [...current.attempts, ...next.attempts]
  };
}

function finalizeOrderHistoryRow(group: OrderGroupDraft): CycleHistoryRow {
  const buy = group.buy;
  const sell = group.sell;
  const profitSummary = calculateOrderGroupProfit(buy, sell);

  return {
    id: group.id,
    slotNumber: group.slotNumber,
    sequence: group.sequence,
    status: orderGroupStatus(buy, sell),
    buy,
    sell,
    quantity: sell?.fillQuantity || buy?.fillQuantity || undefined,
    totalFee: (buy?.fillFee ?? 0) + (sell?.fillFee ?? 0),
    profit: profitSummary?.profit,
    roi: profitSummary?.roi,
    updatedAt: latestIso([
      buy?.completedAt,
      buy?.requestedAt,
      sell?.completedAt,
      sell?.requestedAt
    ]),
    reason: orderGroupReason(buy, sell)
  };
}

function calculateOrderGroupProfit(buy?: OrderLegSummary, sell?: OrderLegSummary) {
  if (!buy || !sell || buy.fillQuantity <= 0 || sell.fillQuantity <= 0) {
    return undefined;
  }

  const matchedQuantity = Math.min(buy.fillQuantity, sell.fillQuantity);
  const buyCost = ((buy.fillGrossAmount + buy.fillFee) / buy.fillQuantity) * matchedQuantity;
  const sellProceeds = ((sell.fillGrossAmount - sell.fillFee) / sell.fillQuantity) * matchedQuantity;
  const profit = sellProceeds - buyCost;

  return {
    profit,
    roi: buyCost > 0 ? profit / buyCost : 0
  };
}

function orderGroupStatus(buy?: OrderLegSummary, sell?: OrderLegSummary) {
  if (sell) {
    if (sell.status === "FILLED") {
      return "완료";
    }

    return `매도 ${orderStatusLabel(sell.status)}`;
  }

  if (buy) {
    if (buy.status === "FILLED") {
      return "보유";
    }

    return `매수 ${orderStatusLabel(buy.status)}`;
  }

  return "-";
}

function orderGroupReason(buy?: OrderLegSummary, sell?: OrderLegSummary) {
  const reasons = [
    buy?.reason ? `매수: ${buy.reason}` : "",
    sell?.reason ? `매도: ${sell.reason}` : ""
  ].filter(Boolean);

  return reasons.length > 0 ? reasons.join(" / ") : undefined;
}

function orderValue(leg: OrderLegSummary) {
  if (leg.orderPrice !== undefined) {
    return money(leg.orderPrice);
  }

  if (leg.orderAmount !== undefined) {
    return money(leg.orderAmount);
  }

  if (leg.orderQuantity !== undefined) {
    return decimal(leg.orderQuantity);
  }

  return "-";
}

function orderAttemptValue(attempt: OrderAttemptSummary) {
  if (attempt.orderPrice !== undefined) {
    return money(attempt.orderPrice);
  }

  if (attempt.orderAmount !== undefined) {
    return money(attempt.orderAmount);
  }

  if (attempt.orderQuantity !== undefined) {
    return decimal(attempt.orderQuantity);
  }

  return "-";
}

function orderStatusLabel(status: string) {
  return orderStatusLabels[status] ?? status;
}

function statusBadgeLabel(status: string) {
  const slotStatusLabels: Record<string, string> = {
    EMPTY: "대기",
    HOLDING: "보유",
    BUY_PENDING: "매수 접수",
    SELL_PENDING: "매도 대기",
    PAUSED: "일시정지"
  };

  return slotStatusLabels[status] ?? orderStatusLabel(status);
}

function statusBadgeToneClass(status: string) {
  const label = statusBadgeLabel(status);
  const normalized = status.toUpperCase();

  if (normalized.includes("FAILED") || normalized.includes("REJECTED") || label.includes("실패") || label.includes("거절")) {
    return "statusBadgeBad";
  }

  if (normalized.includes("CANCELED") || normalized.includes("PAUSED") || label.includes("취소") || label.includes("일시정지")) {
    return "statusBadgeMuted";
  }

  if (normalized.includes("UNKNOWN") || label.includes("확인")) {
    return "statusBadgeWarn";
  }

  if (normalized.includes("PARTIALLY") || label.includes("부분")) {
    return "statusBadgePartial";
  }

  if (normalized.includes("FILLED") || label === "완료" || label === "체결") {
    return "statusBadgeDone";
  }

  if (normalized.includes("HOLDING") || label.includes("보유")) {
    return "statusBadgeHolding";
  }

  if (normalized.includes("SELL_PENDING") || label.includes("매도")) {
    return "statusBadgeSell";
  }

  if (normalized.includes("BUY_PENDING") || normalized.includes("REQUESTED") || normalized.includes("ACCEPTED") || label.includes("매수") || label.includes("요청") || label.includes("접수")) {
    return "statusBadgePending";
  }

  return "statusBadgeIdle";
}

function isFilledLeg(leg?: OrderLegSummary) {
  return leg?.status === "FILLED" && leg.fillQuantity > 0;
}

function compareOrderAsc(left: TradingOrder, right: TradingOrder) {
  return left.requestedAt.localeCompare(right.requestedAt) || left.id.localeCompare(right.id);
}

function latestIso(values: Array<string | undefined>) {
  const sortedValues = values.filter((value): value is string => Boolean(value)).sort((left, right) => left.localeCompare(right));
  return sortedValues[sortedValues.length - 1] ?? "";
}

async function loadTradingCandles(market: string, startedAt: string): Promise<Candle[]> {
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) {
    return [];
  }

  const startedMinuteMs = Math.floor(startedMs / minuteMs) * minuteMs;
  const candleByEpochSecond = new Map<number, Candle>();
  let to = "";

  for (let page = 0; page < maxTradingChartPages; page += 1) {
    const params = new URLSearchParams({
      unit: "1",
      market,
      count: String(bithumbMinuteCandlePageSize)
    });
    if (to) {
      params.set("to", to);
    }

    const payload = await fetchJson<ApiEnvelope<RawBithumbCandle[]>>(`/api/bithumb/candles/minutes?${params.toString()}`);
    if (!Array.isArray(payload.data)) {
      throw new Error(payload.error ?? "차트 응답 없음");
    }

    const candles = payload.data
      .map(normalizeRawCandle)
      .sort((left, right) => left.epochSeconds - right.epochSeconds);
    if (candles.length === 0) {
      break;
    }

    for (const candle of candles) {
      if (candle.epochSeconds * 1000 >= startedMinuteMs) {
        candleByEpochSecond.set(candle.epochSeconds, candle);
      }
    }

    const oldest = candles[0];
    if (oldest.epochSeconds * 1000 <= startedMinuteMs || candles.length < bithumbMinuteCandlePageSize) {
      break;
    }

    to = oldest.time.replace("T", " ");
  }

  return [...candleByEpochSecond.values()].sort((left, right) => left.epochSeconds - right.epochSeconds);
}

function mergeRealtimeTickerCandle(candles: Candle[], ticker: TickerInfo | null, startedAt: string) {
  const startedMs = Date.parse(startedAt);
  const startedMinuteMs = Math.floor(startedMs / minuteMs) * minuteMs;
  const sortedCandles = [...candles]
    .filter((candle) => !Number.isFinite(startedMs) || candle.epochSeconds * 1000 >= startedMinuteMs)
    .sort((left, right) => left.epochSeconds - right.epochSeconds);

  if (!ticker || !Number.isFinite(startedMs) || !Number.isFinite(ticker.trade_price) || ticker.trade_price <= 0) {
    return sortedCandles;
  }

  const observedMs = getTickerObservedMs(ticker);
  const currentMinuteMs = Math.floor(observedMs / minuteMs) * minuteMs;
  if (currentMinuteMs < startedMinuteMs) {
    return sortedCandles;
  }

  const latestBaseMs = sortedCandles[sortedCandles.length - 1]?.epochSeconds * 1000;
  if (latestBaseMs && currentMinuteMs < latestBaseMs) {
    return sortedCandles;
  }

  const next = sortedCandles.filter((candle) => candle.epochSeconds * 1000 <= currentMinuteMs);
  let previousClose = next[next.length - 1]?.close ?? ticker.trade_price;
  const fillFromMs = next.length > 0 ? next[next.length - 1].epochSeconds * 1000 + minuteMs : currentMinuteMs;

  for (let epochMs = fillFromMs; epochMs < currentMinuteMs; epochMs += minuteMs) {
    next.push(createSyntheticCandle(ticker.market, epochMs, previousClose));
  }

  const currentEpochSeconds = Math.floor(currentMinuteMs / 1000);
  const currentIndex = next.findIndex((candle) => candle.epochSeconds === currentEpochSeconds);
  if (currentIndex >= 0) {
    const current = next[currentIndex];
    next[currentIndex] = {
      ...current,
      high: Math.max(current.high, ticker.trade_price),
      low: Math.min(current.low, ticker.trade_price),
      close: ticker.trade_price
    };
    return next;
  }

  next.push(createSyntheticCandle(ticker.market, currentMinuteMs, ticker.trade_price, previousClose));
  return next;
}

function createSyntheticCandle(market: string, epochMs: number, close: number, open = close): Candle {
  return {
    market,
    time: formatKstIso(epochMs),
    epochSeconds: Math.floor(epochMs / 1000),
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume: 0,
    accTradePrice: 0,
    synthetic: true
  };
}

function createTradingChartEvents(slots: TradingSlot[], orders: TradingOrder[], fills: TradingFill[], startedAt: string): TradeEvent[] {
  const startedMs = Date.parse(startedAt);
  const slotsById = new Map(slots.map((slot) => [slot.id, slot]));
  const ordersById = new Map(orders.map((order) => [order.id, order]));

  return fills
    .map((fill): TradeEvent | null => {
      const order = ordersById.get(fill.orderId);
      const slot = slotsById.get(fill.slotId);
      const filledMs = Date.parse(fill.filledAt);
      if (!order || !slot || !Number.isFinite(filledMs) || (Number.isFinite(startedMs) && filledMs < startedMs)) {
        return null;
      }

      return {
        id: fill.id,
        slotNumber: slot.slotNumber,
        type: order.side,
        time: fill.filledAt,
        epochSeconds: Math.floor(filledMs / 1000),
        price: fill.price,
        quantity: fill.quantity,
        grossAmount: fill.price * fill.quantity,
        fee: fill.fee
      };
    })
    .filter((event): event is TradeEvent => event !== null)
    .sort((left, right) => left.epochSeconds - right.epochSeconds || left.id.localeCompare(right.id));
}

function getTradingChartStartedAt(strategy: Strategy | null) {
  return strategy?.activatedAt ?? "";
}

function getTradingChartStatus(startedAt: string, candles: Candle[], isLoading: boolean) {
  if (!startedAt) {
    return "실행 전";
  }

  if (isLoading && candles.length === 0) {
    return "불러오는 중";
  }

  const candleCount = candles.length.toLocaleString("ko-KR");
  return `${shortTime(startedAt)} ~ 현재 · ${candleCount}개`;
}

function getTickerObservedMs(ticker: TickerInfo) {
  return Number.isFinite(ticker.timestamp) && ticker.timestamp ? ticker.timestamp : Date.now();
}

function calculateSlotProfits(slots: TradingSlot[], orders: TradingOrder[], fills: TradingFill[], feeRate: number, currentPrice?: number) {
  const ordersById = new Map(orders.map((order) => [order.id, order]));
  const profitBySlotId = new Map<string, typeof emptySlotProfit>();

  for (const slot of slots) {
    profitBySlotId.set(slot.id, {
      realizedProfit: 0,
      unrealizedProfit: 0,
      totalProfit: 0
    });
  }

  for (const fill of fills) {
    const order = ordersById.get(fill.orderId);
    const profit = profitBySlotId.get(fill.slotId);
    if (!order || !profit || order.side !== "SELL") {
      continue;
    }

    const buyOrder = findLatestFilledBuyBeforeSell(orders, fills, fill.slotId, fill.filledAt);
    if (!buyOrder) {
      continue;
    }

    const buyCost = (buyOrder.fill.price * buyOrder.fill.quantity) + buyOrder.fill.fee + buyOrder.fill.tax;
    const sellProceeds = (fill.price * fill.quantity) - fill.fee - fill.tax;
    profit.realizedProfit += sellProceeds - buyCost;
  }

  for (const slot of slots) {
    const profit = profitBySlotId.get(slot.id);
    if (!profit) {
      continue;
    }

    if (isPositionSlot(slot) && slot.quantity > 0 && currentPrice) {
      const sellEstimate = slot.quantity * currentPrice * (1 - feeRate);
      const buyCost = slot.entryGrossAmount + slot.entryFee;
      profit.unrealizedProfit = sellEstimate - buyCost;
    }

    profit.totalProfit = profit.realizedProfit + profit.unrealizedProfit;
  }

  return profitBySlotId;
}

function isPositionSlot(slot: TradingSlot) {
  return slot.status === "HOLDING" || slot.status === "SELL_PENDING";
}

function countCompletedCyclesBySlotNumber(cycles: CycleHistoryRow[]) {
  const counts = new Map<number, number>();
  for (const cycle of cycles) {
    if (!cycle.slotNumber || !isFilledLeg(cycle.sell)) {
      continue;
    }

    counts.set(cycle.slotNumber, (counts.get(cycle.slotNumber) ?? 0) + 1);
  }

  return counts;
}

function createLatestCycleBySlotNumber(cycles: CycleHistoryRow[]) {
  const cyclesBySlotNumber = new Map<number, CycleHistoryRow>();
  for (const cycle of cycles) {
    if (!cycle.slotNumber || cyclesBySlotNumber.has(cycle.slotNumber)) {
      continue;
    }

    cyclesBySlotNumber.set(cycle.slotNumber, cycle);
  }

  return cyclesBySlotNumber;
}

function findLatestFilledBuyBeforeSell(orders: TradingOrder[], fills: TradingFill[], slotId: string, sellFilledAt: string) {
  const ordersById = new Map(orders.map((order) => [order.id, order]));
  return fills
    .map((fill) => ({ fill, order: ordersById.get(fill.orderId) }))
    .filter((item): item is { fill: TradingFill; order: TradingOrder } => Boolean(item.order))
    .filter((item) => item.fill.slotId === slotId && item.order.side === "BUY" && item.fill.filledAt <= sellFilledAt)
    .sort((left, right) => right.fill.filledAt.localeCompare(left.fill.filledAt) || right.fill.id.localeCompare(left.fill.id))[0];
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label>
      {label}
      <input value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      {label}
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className={`metric ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const payload = (await response.json()) as T & { error?: string };

  if (!response.ok) {
    throw new Error(payload.error ?? "Request failed");
  }

  return payload;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = (await response.json()) as T & { error?: string };

  if (!response.ok) {
    throw new Error(payload.error ?? "Request failed");
  }

  return payload;
}

function actionLabel(action: "start" | "pause" | "stop" | "tick") {
  if (action === "start") {
    return "PAPER 러너 시작";
  }

  if (action === "pause") {
    return "PAPER 러너 일시정지";
  }

  if (action === "stop") {
    return "PAPER 러너 중지";
  }

  return "PAPER 러너 1회 실행";
}

function money(value: number) {
  return `${Math.round(value).toLocaleString("ko-KR")}원`;
}

function percent(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function profitClass(value: number) {
  if (value > 0) {
    return "goodText";
  }

  if (value < 0) {
    return "badText";
  }

  return "";
}

function profitTone(value: number): "good" | "bad" | undefined {
  if (value > 0) {
    return "good";
  }

  if (value < 0) {
    return "bad";
  }

  return undefined;
}

function decimal(value: number) {
  return value.toLocaleString("ko-KR", { maximumFractionDigits: 8 });
}

function shortTime(value: string) {
  return value ? new Date(value).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "-";
}

function formatUpdatedAt(value: Date) {
  return value.toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function createSlotPreview(settings: StrategyForm): SlotConfig[] {
  try {
    const slots = createSlots({
      slotPriceOffset: Math.max(1, Math.round(settings.slotPriceOffset)),
      upperPrice: settings.upperPrice,
      lowerPrice: settings.lowerPrice,
      totalBudget: 1,
      targetProfitPriceUnit: Math.max(1, Math.round(settings.targetProfitPriceUnit)),
      feeRate: settings.feePercent / 100
    });

    return slots.map((slot) => ({
      ...slot,
      budget: settings.slotBudget
    }));
  } catch {
    return [];
  }
}

function getSlotPriceOffset(strategy: Strategy | null, slots: TradingSlot[]) {
  if (strategy && isRecord(strategy.config)) {
    const configOffset = Number(strategy.config.slotPriceOffset);
    if (Number.isFinite(configOffset) && configOffset > 0) {
      return configOffset;
    }
  }

  if (slots.length >= 2) {
    return Math.abs(slots[0].buyPrice - slots[1].buyPrice);
  }

  return null;
}

function getTargetProfitPriceUnit(strategy: Strategy | null, slots: TradingSlot[]) {
  if (strategy && isRecord(strategy.config)) {
    const configUnit = Math.round(Number(strategy.config.targetProfitPriceUnit));
    if (Number.isFinite(configUnit) && configUnit > 0) {
      return configUnit;
    }
  }

  if (slots.length >= 1) {
    return Math.round(slots[0].targetSellPrice - slots[0].buyPrice);
  }

  return null;
}

function getTargetReturnPreview(slots: SlotConfig[]) {
  if (slots.length === 0) {
    return null;
  }

  const grossRate = average(slots.map((slot) => slot.grossTargetProfitRate));
  const netRate = average(slots.map((slot) => slot.netTargetProfitRate));

  return {
    grossRate,
    netRate,
    feeImpactRate: grossRate - netRate
  };
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

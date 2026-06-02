import { Pause, Play, Plus, RefreshCw, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { defaultTradingSettings } from "../shared/settings";

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
  createdAt: string;
  updatedAt: string;
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
}

interface TradingOrder {
  id: string;
  strategyId: string;
  slotId: string;
  clientOrderId: string;
  market: string;
  side: "BUY" | "SELL";
  price?: number;
  quantity?: number;
  amount?: number;
  status: string;
  requestedAt: string;
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
  fills: unknown[];
  decisionLogs: DecisionLog[];
}

interface StrategyForm {
  market: string;
  upperPrice: number;
  lowerPrice: number;
  slotCount: number;
  slotBudget: number;
  targetProfitPercent: number;
  feePercent: number;
}

const defaultForm: StrategyForm = {
  ...defaultTradingSettings
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
  const activeOrders = useMemo(
    () => snapshot?.orders.filter((order) => order.strategyId === activeStrategy?.id).slice(0, 8) ?? [],
    [activeStrategy, snapshot]
  );
  const tickerMarket = (activeStrategy?.market ?? form.market).trim().toUpperCase();

  useEffect(() => {
    loadSnapshot();
    const timer = window.setInterval(() => {
      loadSnapshot({ quiet: true });
    }, 5_000);

    return () => window.clearInterval(timer);
  }, []);

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
          setTickerUpdatedAt(new Date().toLocaleTimeString("ko-KR"));
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

  async function createStrategy() {
    setIsWorking(true);
    setError("");
    setStatus("");

    try {
      const payload = await postJson<TradingSnapshot>("/api/trading/strategy", {
        ...form,
        totalBudget: form.slotBudget * form.slotCount
      });
      setSnapshot(payload);
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
      setStatus(actionLabel(action));
    } catch (controlError) {
      setError(controlError instanceof Error ? controlError.message : "러너 제어 실패");
    } finally {
      setIsWorking(false);
    }
  }

  const runner = snapshot?.runnerState;
  const holdingSlots = activeSlots.filter((slot) => slot.status === "HOLDING").length;

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
          <Metric label="보유 슬롯" value={`${holdingSlots}/${activeSlots.length}`} />
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
            <NumberField label="상단 가격" value={form.upperPrice} step={1000} onChange={(upperPrice) => updateForm("upperPrice", upperPrice)} />
            <NumberField label="하단 가격" value={form.lowerPrice} step={1000} onChange={(lowerPrice) => updateForm("lowerPrice", lowerPrice)} />
            <NumberField label="슬롯 수" value={form.slotCount} min={2} max={20} step={1} onChange={(slotCount) => updateForm("slotCount", clampInteger(slotCount, 2, 20))} />
            <NumberField label="슬롯별 투자금" value={form.slotBudget} min={1000} step={10000} onChange={(slotBudget) => updateForm("slotBudget", slotBudget)} />
            <NumberField label="목표 %" value={form.targetProfitPercent} min={0.01} step={0.01} onChange={(targetProfitPercent) => updateForm("targetProfitPercent", targetProfitPercent)} />
            <NumberField label="수수료 %" value={form.feePercent} min={0} step={0.01} onChange={(feePercent) => updateForm("feePercent", feePercent)} />
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

          {status && <p className="statusText">{status}</p>}
          {error && <p className="errorText">{error}</p>}
          {tickerError && <p className="errorText">{tickerError}</p>}
          {runner?.lastError && <p className="errorText">{runner.lastError}</p>}
        </aside>

        <section className="tradingMain">
          <article className="dashboardPanel wide">
            <div className="sectionHeader">
              <h2>실시간 시세</h2>
              <span className="muted">{tickerUpdatedAt || "조회 전"}</span>
            </div>
            <div className="summaryTable">
              <div><span>마켓</span><strong>{tickerMarket}</strong></div>
              <div><span>현재가</span><strong>{ticker ? money(ticker.trade_price) : "-"}</strong></div>
              <div><span>전일 대비</span><strong className={profitClass(ticker?.signed_change_rate ?? 0)}>{ticker ? percent(ticker.signed_change_rate ?? 0) : "-"}</strong></div>
              <div><span>변동 금액</span><strong className={profitClass(ticker?.signed_change_price ?? 0)}>{ticker ? money(ticker.signed_change_price ?? 0) : "-"}</strong></div>
              <div><span>24h 거래대금</span><strong>{ticker ? money(ticker.acc_trade_price_24h ?? 0) : "-"}</strong></div>
              <div><span>갱신 주기</span><strong>3초</strong></div>
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
                <div><span>슬롯 예산</span><strong>{money(activeStrategy.slotBudget)}</strong></div>
                <div><span>목표</span><strong>{percent(activeStrategy.targetProfitRate)}</strong></div>
              </div>
            )}
          </article>

          <article className="dashboardPanel wide">
            <div className="sectionHeader">
              <h2>슬롯</h2>
              <span className="muted">{activeSlots.length.toLocaleString("ko-KR")}개</span>
            </div>
            <div className="tableScroller">
              <table className="assetTable">
                <thead>
                  <tr>
                    <th>슬롯</th>
                    <th>상태</th>
                    <th>매수가</th>
                    <th>목표가</th>
                    <th>예산</th>
                    <th>진입가</th>
                    <th>수량</th>
                  </tr>
                </thead>
                <tbody>
                  {activeSlots.map((slot) => (
                    <tr key={slot.id}>
                      <td>S{slot.slotNumber}</td>
                      <td>{slot.status}</td>
                      <td>{money(slot.buyPrice)}</td>
                      <td>{money(slot.targetSellPrice)}</td>
                      <td>{money(slot.budget)}</td>
                      <td>{slot.entryPrice ? money(slot.entryPrice) : "-"}</td>
                      <td>{slot.quantity ? decimal(slot.quantity) : "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>

          <article className="dashboardPanel">
            <div className="sectionHeader">
              <h2>최근 주문</h2>
            </div>
            <div className="miniList">
              {activeOrders.length === 0 ? (
                <div className="emptyResult small">주문 없음</div>
              ) : (
                activeOrders.map((order) => (
                  <div className="miniListRow" key={order.id}>
                    <div>
                      <strong>{order.side} · {order.status}</strong>
                      <span>{shortTime(order.requestedAt)}</span>
                    </div>
                    <div>
                      <strong>{order.price ? money(order.price) : "-"}</strong>
                      <span>{order.quantity ? decimal(order.quantity) : "-"}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </article>

          <article className="dashboardPanel">
            <div className="sectionHeader">
              <h2>판단 로그</h2>
            </div>
            <div className="miniList">
              {(snapshot?.decisionLogs ?? []).slice(0, 8).map((log) => (
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
              ))}
            </div>
          </article>
        </section>
      </section>
    </main>
  );

  function updateForm<K extends keyof StrategyForm>(key: K, value: StrategyForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }
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

function clampInteger(value: number, minValue: number, maxValue: number) {
  return Math.min(maxValue, Math.max(minValue, Math.round(value)));
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
  return value ? new Date(value).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-";
}

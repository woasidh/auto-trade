import { Play, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import PriceChart from "./components/PriceChart";
import { getPriceBand } from "./shared/candles";
import { createSlots, simulateSevenSplit } from "./shared/simulator";
import type { Candle, DatasetDate, DatasetResponse, SimulationResult, SimulationSettings, SlotConfig } from "./shared/types";

type DateMode = "single" | "range";

interface CandleResponse {
  market: string;
  interval: string;
  from: string;
  to: string;
  candles: Candle[];
}

const market = "KRW-USDT";
const interval = "1m";
const initialFromDate = "2025-09-01";
const initialToDate = "2026-05-10";
const initialLowerPrice = 1460;
const initialUpperPrice = 1480;
const initialTotalBudget = 10_000_000;

export default function App() {
  const [dates, setDates] = useState<DatasetDate[]>([]);
  const [dateMode, setDateMode] = useState<DateMode>("range");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [settings, setSettings] = useState({
    slotPriceOffset: 3,
    upperPrice: initialUpperPrice,
    lowerPrice: initialLowerPrice,
    totalBudget: initialTotalBudget,
    targetProfitPriceUnit: 3,
    feePercent: 0.04
  });

  useEffect(() => {
    fetch("/api/datasets")
      .then((response) => response.json())
      .then((data: DatasetResponse) => {
        const dataset = data.datasets
          .find((item) => item.market === market)
          ?.intervals.find((item) => item.interval === interval);
        const nextDates = dataset?.dates ?? [];
        const latestDate = nextDates[nextDates.length - 1]?.date ?? "";
        const hasInitialRange = nextDates.some((item) => item.date === initialFromDate) && nextDates.some((item) => item.date === initialToDate);

        setDates(nextDates);
        setFromDate(hasInitialRange ? initialFromDate : latestDate);
        setToDate(hasInitialRange ? initialToDate : latestDate);
      })
      .catch(() => setError("데이터 목록을 불러오지 못했습니다."))
      .finally(() => setIsLoading(false));
  }, []);

  useEffect(() => {
    if (!fromDate || !toDate) {
      return;
    }

    const effectiveTo = dateMode === "single" ? fromDate : toDate;
    setIsLoading(true);
    setError("");

    fetch(`/api/candles?market=${market}&interval=${interval}&from=${fromDate}&to=${effectiveTo}`)
      .then((response) => {
        if (!response.ok) {
          throw new Error("Failed to load candles");
        }
        return response.json();
      })
      .then((data: CandleResponse) => {
        setCandles(data.candles);
        setResult(null);
      })
      .catch(() => setError("캔들 데이터를 불러오지 못했습니다."))
      .finally(() => setIsLoading(false));
  }, [dateMode, fromDate, toDate]);

  const simulationSettings: SimulationSettings = useMemo(
    () => ({
      slotPriceOffset: clampInteger(settings.slotPriceOffset, 1, Number.MAX_SAFE_INTEGER),
      upperPrice: settings.upperPrice,
      lowerPrice: settings.lowerPrice,
      totalBudget: settings.totalBudget,
      targetProfitPriceUnit: clampInteger(settings.targetProfitPriceUnit, 1, Number.MAX_SAFE_INTEGER),
      feeRate: settings.feePercent / 100
    }),
    [settings]
  );

  const slotPreview = useMemo(() => {
    try {
      return createSlots(simulationSettings);
    } catch {
      return [];
    }
  }, [simulationSettings]);
  const targetReturnPreview = useMemo(() => getTargetReturnPreview(slotPreview), [slotPreview]);

  const selectedDate = dates.find((item) => item.date === fromDate);
  const selectedToDate = dates.find((item) => item.date === (dateMode === "single" ? fromDate : toDate));
  const syntheticCount = candles.filter((candle) => candle.synthetic).length;
  const averageClosePrice = useMemo(() => getAverageClosePrice(candles), [candles]);

  function runSimulation() {
    try {
      setError("");
      setResult(simulateSevenSplit(candles, simulationSettings));
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "시뮬레이션 실패");
    }
  }

  function resetBand() {
    const priceBand = getPriceBand(candles);
    if (!priceBand) {
      return;
    }

    setSettings((current) => ({
      ...current,
      ...priceBand
    }));
    setResult(null);
  }

  return (
    <main className="appShell">
      <header className="topBar">
        <div>
          <h1>Slice Trade Backtest</h1>
          <p>{market} · 1분봉 · {candles.length.toLocaleString("ko-KR")} candles</p>
        </div>
        {result && (
          <div className="summaryStrip">
            <Metric label="합산 손익" value={money(result.summary.totalProfit)} tone={profitTone(result.summary.totalProfit)} />
            <Metric label="순수이익" value={money(result.summary.realizedProfit)} tone={profitTone(result.summary.realizedProfit)} />
            <Metric label="보유 평가손익" value={money(result.summary.unrealizedProfit)} tone={profitTone(result.summary.unrealizedProfit)} />
            <Metric label="ROI(합산)" value={percent(result.summary.roi)} tone={profitTone(result.summary.roi)} />
          </div>
        )}
      </header>

      <section className="workbench">
        <aside className="controlPanel">
          <div className="fieldGroup">
            <label>기간</label>
            <div className="segmented">
              <button className={dateMode === "single" ? "active" : ""} onClick={() => setDateMode("single")}>단일</button>
              <button className={dateMode === "range" ? "active" : ""} onClick={() => setDateMode("range")}>범위</button>
            </div>
          </div>

          <div className="fieldGrid">
            <label>
              시작
              <select value={fromDate} onChange={(event) => setFromDate(event.target.value)}>
                {dates.map((date) => (
                  <option key={date.date} value={date.date}>{date.date}</option>
                ))}
              </select>
            </label>
            <label>
              종료
              <select
                value={dateMode === "single" ? fromDate : toDate}
                disabled={dateMode === "single"}
                onChange={(event) => setToDate(event.target.value)}
              >
                {dates.map((date) => (
                  <option key={date.date} value={date.date}>{date.date}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="dataNote">
            <span>원본 누락 {((selectedDate?.missing ?? 0) + (dateMode === "range" ? selectedToDate?.missing ?? 0 : 0)).toLocaleString("ko-KR")}</span>
            <span>보정 {syntheticCount.toLocaleString("ko-KR")}</span>
            {dateMode === "range" && averageClosePrice !== null && <span>평균가 {price(averageClosePrice)}</span>}
          </div>

          <div className="fieldGrid">
            <NumberField label="슬롯 간격" value={settings.slotPriceOffset} min={1} step={1} onChange={(slotPriceOffset) => updateSetting("slotPriceOffset", Math.max(1, Math.round(slotPriceOffset)))} />
            <NumberField label="총 투자금" value={settings.totalBudget} min={1000} step={10000} onChange={(totalBudget) => updateSetting("totalBudget", totalBudget)} />
            <NumberField label="상단 가격" value={settings.upperPrice} step={1} onChange={(upperPrice) => updateSetting("upperPrice", Math.floor(upperPrice))} />
            <NumberField label="하단 가격" value={settings.lowerPrice} step={1} onChange={(lowerPrice) => updateSetting("lowerPrice", Math.floor(lowerPrice))} />
            <NumberField label="목표 수익 단위" value={settings.targetProfitPriceUnit} min={1} step={1} onChange={(targetProfitPriceUnit) => updateSetting("targetProfitPriceUnit", Math.max(1, Math.round(targetProfitPriceUnit)))} />
            <NumberField label="수수료 %" value={settings.feePercent} step={0.01} onChange={(feePercent) => updateSetting("feePercent", feePercent)} />
          </div>

          {targetReturnPreview && (
            <div className="returnFormula">
              <span>평균 기준 정수 수익률 - 수수료</span>
              <strong className={profitClass(targetReturnPreview.netRate)}>
                {percent(targetReturnPreview.grossRate)} - {percent(targetReturnPreview.feeImpactRate)} = {percent(targetReturnPreview.netRate)}
              </strong>
            </div>
          )}

          <div className="buttonRow">
            <button className="ghostButton" onClick={resetBand} title="밴드 초기화">
              <RotateCcw size={16} />
            </button>
            <button className="primaryButton" onClick={runSimulation} disabled={isLoading || candles.length === 0}>
              <Play size={16} />
              시뮬레이션 시작
            </button>
          </div>

          {error && <p className="errorText">{error}</p>}

          <div className="slotPreview">
            <h2>슬롯 가격 ({slotPreview.length}개)</h2>
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
                {slotPreview.map((slot) => (
                  <tr key={slot.slotNumber}>
                    <td>S{slot.slotNumber}</td>
                    <td>{price(slot.buyPrice)}</td>
                    <td>{price(slot.targetSellPrice)}</td>
                    <td className={profitClass(slot.netTargetProfitRate)}>{percent(slot.netTargetProfitRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </aside>

        <section className="chartPanel">
          <PriceChart candles={candles} result={result} />
        </section>
      </section>

      <section className="resultsPanel">
        <h2>슬롯별 결과</h2>
        {!result ? (
          <div className="emptyResult">시뮬레이션을 시작하면 슬롯별 손익과 거래내역이 표시됩니다.</div>
        ) : (
          <div className="resultGrid">
            {result.slots.map((slot) => (
              <article className="slotResult" key={slot.slotNumber}>
                <div className="slotHeader">
                  <strong>S{slot.slotNumber}</strong>
                  <span className={slot.status === "HOLDING" ? "holding" : "empty"}>{slot.status}</span>
                </div>
                <dl>
                  <div><dt>합산 손익</dt><dd className={profitClass(slot.totalProfit)}>{money(slot.totalProfit)}</dd></div>
                  <div><dt>순수이익</dt><dd className={profitClass(slot.realizedProfit)}>{money(slot.realizedProfit)}</dd></div>
                  <div><dt>보유 평가</dt><dd className={slot.status === "HOLDING" ? profitClass(slot.unrealizedProfit) : "mutedValue"}>{slot.status === "HOLDING" ? money(slot.unrealizedProfit) : "-"}</dd></div>
                  <div><dt>ROI</dt><dd>{percent(slot.roi)}</dd></div>
                  <div><dt>거래</dt><dd>{slot.tradeCount}</dd></div>
                  <div><dt>보유</dt><dd>{slot.quantity ? slot.quantity.toFixed(6) : "-"}</dd></div>
                </dl>
                <div className="tradeList">
                  {slot.trades.length === 0 ? (
                    <span className="muted">거래 없음</span>
                  ) : (
                    slot.trades.map((trade) => (
                      <div key={trade.id} className="tradeRow">
                        <span>{trade.type}</span>
                        <span>{trade.time.slice(5, 16).replace("T", " ")}</span>
                        <span>{price(trade.price)}</span>
                        <span>{trade.profit === undefined ? "" : money(trade.profit)}</span>
                      </div>
                    ))
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );

  function updateSetting<K extends keyof typeof settings>(key: K, value: (typeof settings)[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
    setResult(null);
  }
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

function money(value: number) {
  return `${Math.round(value).toLocaleString("ko-KR")}원`;
}

function price(value: number) {
  return Math.round(value).toLocaleString("ko-KR", { maximumFractionDigits: 0 });
}

function percent(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function getAverageClosePrice(candles: Candle[]) {
  if (candles.length === 0) {
    return null;
  }

  return candles.reduce((sum, candle) => sum + candle.close, 0) / candles.length;
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

function profitTone(value: number): "good" | "bad" | undefined {
  if (value > 0) {
    return "good";
  }

  if (value < 0) {
    return "bad";
  }

  return undefined;
}

function profitClass(value: number) {
  return profitTone(value) === "bad" ? "badText" : profitTone(value) === "good" ? "goodText" : "";
}

function clampInteger(value: number, minValue: number, maxValue: number) {
  return Math.min(maxValue, Math.max(minValue, Math.round(value)));
}

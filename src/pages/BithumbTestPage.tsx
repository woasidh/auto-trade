import { BookOpen, CandlestickChart, KeyRound, ListChecks, Play, Send, ShieldCheck, Wallet, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { defaultAppSettings, supportedMinuteUnits } from "../shared/settings";

type TestKey = "markets" | "ticker" | "orderbook" | "candles";

interface ApiResult {
  ok: boolean;
  status: number;
  endpoint: string;
  requestedAt: string;
  data?: unknown;
  error?: string;
}

interface MarketInfo {
  market: string;
  korean_name?: string;
  english_name?: string;
  market_warning?: string;
}

interface TickerInfo {
  market: string;
  trade_price: number;
  signed_change_rate?: number;
  signed_change_price?: number;
  acc_trade_volume_24h?: number;
  timestamp?: number;
}

interface OrderbookInfo {
  market: string;
  total_ask_size: number;
  total_bid_size: number;
  orderbook_units: Array<{
    ask_price: number;
    bid_price: number;
    ask_size: number;
    bid_size: number;
  }>;
}

interface MinuteCandleInfo {
  market: string;
  candle_date_time_kst: string;
  opening_price: number;
  high_price: number;
  low_price: number;
  trade_price: number;
  candle_acc_trade_volume: number;
  unit: number;
}

interface CredentialStatus {
  configured: boolean;
  accessKey: string;
  liveTrading: boolean;
  envFilePath: string;
}

const tests: Array<{
  key: TestKey;
  label: string;
  icon: typeof ListChecks;
}> = [
  { key: "markets", label: "거래 대상", icon: ListChecks },
  { key: "ticker", label: "현재가", icon: RefreshCw },
  { key: "orderbook", label: "호가", icon: BookOpen },
  { key: "candles", label: "분봉", icon: CandlestickChart }
];

export default function BithumbTestPage() {
  const [market, setMarket] = useState(defaultAppSettings.bithumb.testMarket);
  const [candleUnit, setCandleUnit] = useState(defaultAppSettings.bithumb.candleUnit);
  const [candleCount, setCandleCount] = useState(defaultAppSettings.bithumb.candleCount);
  const [activeTest, setActiveTest] = useState<TestKey | "all" | null>(null);
  const [privateAction, setPrivateAction] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [credentialStatus, setCredentialStatus] = useState<CredentialStatus | null>(null);
  const [credentialForm, setCredentialForm] = useState({
    accessKey: "",
    secretKey: "",
    liveTrading: false
  });
  const [privateResults, setPrivateResults] = useState<Record<"accounts" | "chance" | "order", ApiResult | null>>({
    accounts: null,
    chance: null,
    order: null
  });
  const [orderForm, setOrderForm] = useState({
    side: "bid",
    orderType: "limit",
    price: "",
    volume: "",
    clientOrderId: "",
    confirmLive: false
  });
  const [results, setResults] = useState<Record<TestKey, ApiResult | null>>({
    markets: null,
    ticker: null,
    orderbook: null,
    candles: null
  });

  const ticker = useMemo(() => getFirst<TickerInfo>(results.ticker?.data), [results.ticker]);

  useEffect(() => {
    loadCredentialStatus();
  }, []);

  async function loadCredentialStatus() {
    try {
      const response = await fetch("/api/bithumb/private/status");
      const payload = (await response.json()) as CredentialStatus;
      setCredentialStatus(payload);
      setCredentialForm((current) => ({ ...current, liveTrading: payload.liveTrading }));
    } catch {
      setError("인증 상태를 확인하지 못했습니다.");
    }
  }

  async function saveCredentials() {
    setPrivateAction("credentials");
    setError("");

    try {
      const response = await fetch("/api/bithumb/private/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentialForm)
      });
      const payload = (await response.json()) as CredentialStatus & { error?: string };

      if (!response.ok) {
        throw new Error(payload.error ?? "인증 정보 저장 실패");
      }

      setCredentialStatus(payload);
      setCredentialForm({ accessKey: "", secretKey: "", liveTrading: payload.liveTrading });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "인증 정보 저장 실패");
    } finally {
      setPrivateAction(null);
    }
  }

  async function runTest(test: TestKey) {
    setActiveTest(test);
    setError("");

    try {
      const result = await requestTest(test, market, candleUnit, candleCount);
      setResults((current) => ({ ...current, [test]: result }));
      if (!result.ok) {
        setError(result.error ?? "API 요청 실패");
      }
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "API 요청 실패";
      setResults((current) => ({
        ...current,
        [test]: {
          ok: false,
          status: 0,
          endpoint: getEndpoint(test, market, candleUnit, candleCount),
          requestedAt: new Date().toISOString(),
          error: message
        }
      }));
      setError(message);
    } finally {
      setActiveTest(null);
    }
  }

  async function runAllTests() {
    setActiveTest("all");
    setError("");

    try {
      for (const test of tests) {
        const result = await requestTest(test.key, market, candleUnit, candleCount);
        setResults((current) => ({ ...current, [test.key]: result }));
        if (!result.ok) {
          setError(result.error ?? "API 요청 실패");
          break;
        }
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "API 요청 실패");
    } finally {
      setActiveTest(null);
    }
  }

  async function runPrivateTest(test: "accounts" | "chance") {
    setPrivateAction(test);
    setError("");

    try {
      const endpoint =
        test === "accounts"
          ? "/api/bithumb/private/accounts"
          : `/api/bithumb/private/orders/chance?market=${encodeURIComponent(market.trim().toUpperCase())}`;
      const response = await fetch(endpoint);
      const payload = (await response.json()) as { data?: unknown; error?: string; endpoint?: string };
      const result = {
        ok: response.ok,
        status: response.status,
        endpoint: payload.endpoint ?? endpoint,
        requestedAt: new Date().toISOString(),
        data: payload.data,
        error: payload.error
      };
      setPrivateResults((current) => ({ ...current, [test]: result }));
      if (!response.ok) {
        setError(payload.error ?? "Private API 요청 실패");
      }
    } catch (privateError) {
      setError(privateError instanceof Error ? privateError.message : "Private API 요청 실패");
    } finally {
      setPrivateAction(null);
    }
  }

  async function submitOrder() {
    setPrivateAction("order");
    setError("");

    try {
      const response = await fetch("/api/bithumb/private/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          market,
          ...orderForm
        })
      });
      const payload = (await response.json()) as { data?: unknown; error?: string; endpoint?: string };
      const result = {
        ok: response.ok,
        status: response.status,
        endpoint: payload.endpoint ?? "/api/bithumb/private/orders",
        requestedAt: new Date().toISOString(),
        data: payload.data ?? payload,
        error: payload.error
      };
      setPrivateResults((current) => ({ ...current, order: result }));
      if (!response.ok) {
        setError(payload.error ?? "주문 요청 실패");
      }
    } catch (orderError) {
      setError(orderError instanceof Error ? orderError.message : "주문 요청 실패");
    } finally {
      setPrivateAction(null);
    }
  }

  return (
    <main className="appShell">
      <header className="topBar">
        <div>
          <h1>개발자 테스트</h1>
          <p>빗썸 Public/Private API · {market}</p>
        </div>
        {ticker && (
          <div className="summaryStrip compact">
            <Metric label="현재가" value={`${formatNumber(ticker.trade_price)}원`} />
            <Metric label="전일 대비" value={formatPercent(ticker.signed_change_rate ?? 0)} tone={profitTone(ticker.signed_change_rate ?? 0)} />
            <Metric label="24h 거래량" value={formatNumber(ticker.acc_trade_volume_24h ?? 0)} />
          </div>
        )}
      </header>

      <section className="testLayout">
        <aside className="controlPanel">
          <div className="fieldGrid single">
            <label>
              거래 페어
              <input value={market} onChange={(event) => setMarket(event.target.value.toUpperCase())} />
            </label>
          </div>

          <div className="fieldGrid">
            <label>
              분봉 단위
              <select value={candleUnit} onChange={(event) => setCandleUnit(Number(event.target.value))}>
                {supportedMinuteUnits.map((unit) => (
                  <option key={unit} value={unit}>{unit}분</option>
                ))}
              </select>
            </label>
            <label>
              조회 개수
              <input
                type="number"
                min={1}
                max={200}
                value={candleCount}
                onChange={(event) => setCandleCount(clampInteger(Number(event.target.value), 1, 200))}
              />
            </label>
          </div>

          <div className="buttonStack">
            <button className="primaryButton" disabled={activeTest !== null} onClick={runAllTests} type="button">
              <Play size={16} />
              전체 테스트
            </button>
            {tests.map((test) => {
              const Icon = test.icon;
              return (
                <button
                  key={test.key}
                  className="secondaryButton"
                  disabled={activeTest !== null}
                  onClick={() => runTest(test.key)}
                  type="button"
                >
                  <Icon size={16} />
                  {test.label}
                </button>
              );
            })}
          </div>

          {activeTest && <p className="statusText">요청 중...</p>}
          {privateAction && <p className="statusText">Private 요청 중...</p>}
          {error && <p className="errorText">{error}</p>}
        </aside>

        <section className="apiResultPanel">
          <ResultBlock title="거래 대상" result={results.markets}>
            <MarketsSummary data={results.markets?.data} />
          </ResultBlock>
          <ResultBlock title="현재가" result={results.ticker}>
            <TickerSummary data={results.ticker?.data} />
          </ResultBlock>
          <ResultBlock title="호가" result={results.orderbook}>
            <OrderbookSummary data={results.orderbook?.data} />
          </ResultBlock>
          <ResultBlock title="분봉" result={results.candles}>
            <CandlesSummary data={results.candles?.data} />
          </ResultBlock>
        </section>
      </section>

      <section className="privateApiLayout">
        <section className="settingsPanel">
          <div className="sectionHeader">
            <h2>Private API 인증</h2>
            <strong className={credentialStatus?.configured ? "goodText" : "badText"}>
              {credentialStatus?.configured ? "연결 정보 있음" : "미설정"}
            </strong>
          </div>

          <div className="fieldGrid">
            <label>
              API Key
              <input
                autoComplete="off"
                value={credentialForm.accessKey}
                onChange={(event) => setCredentialForm((current) => ({ ...current, accessKey: event.target.value }))}
                placeholder={credentialStatus?.accessKey || "발급받은 API Key"}
              />
            </label>
            <label>
              Secret Key
              <input
                autoComplete="off"
                type="password"
                value={credentialForm.secretKey}
                onChange={(event) => setCredentialForm((current) => ({ ...current, secretKey: event.target.value }))}
                placeholder="발급 시 한 번만 표시되는 Secret Key"
              />
            </label>
          </div>

          <label className="checkRow">
            <input
              type="checkbox"
              checked={credentialForm.liveTrading}
              onChange={(event) => setCredentialForm((current) => ({ ...current, liveTrading: event.target.checked }))}
            />
            실제 주문 허용 플래그 저장
          </label>

          <div className="buttonStack horizontal">
            <button className="secondaryButton" onClick={loadCredentialStatus} disabled={privateAction !== null} type="button">
              <ShieldCheck size={16} />
              상태 확인
            </button>
            <button className="primaryButton" onClick={saveCredentials} disabled={privateAction !== null} type="button">
              <KeyRound size={16} />
              인증 저장
            </button>
          </div>

          {credentialStatus && (
            <div className="credentialNote">
              <span>저장 위치: {credentialStatus.envFilePath}</span>
              <span>API Key: {credentialStatus.accessKey || "-"}</span>
              <span>Live: {credentialStatus.liveTrading ? "ON" : "OFF"}</span>
            </div>
          )}
        </section>

        <section className="settingsPanel">
          <div className="sectionHeader">
            <h2>계좌/주문 테스트</h2>
          </div>

          <div className="buttonStack horizontal">
            <button className="secondaryButton" onClick={() => runPrivateTest("accounts")} disabled={privateAction !== null} type="button">
              <Wallet size={16} />
              계좌 조회
            </button>
            <button className="secondaryButton" onClick={() => runPrivateTest("chance")} disabled={privateAction !== null} type="button">
              <ShieldCheck size={16} />
              주문 가능 정보
            </button>
          </div>

          <div className="orderForm">
            <div className="fieldGrid">
              <label>
                매수/매도
                <select value={orderForm.side} onChange={(event) => setOrderForm((current) => ({ ...current, side: event.target.value }))}>
                  <option value="bid">매수</option>
                  <option value="ask">매도</option>
                </select>
              </label>
              <label>
                주문 방식
                <select value={orderForm.orderType} onChange={(event) => setOrderForm((current) => ({ ...current, orderType: event.target.value }))}>
                  <option value="limit">지정가</option>
                  <option value="price">시장가 매수</option>
                  <option value="market">시장가 매도</option>
                </select>
              </label>
              <label>
                가격/매수총액
                <input value={orderForm.price} onChange={(event) => setOrderForm((current) => ({ ...current, price: event.target.value }))} placeholder="예: 80000000" />
              </label>
              <label>
                수량
                <input value={orderForm.volume} onChange={(event) => setOrderForm((current) => ({ ...current, volume: event.target.value }))} placeholder="예: 0.0001" />
              </label>
              <label>
                Client Order ID
                <input value={orderForm.clientOrderId} onChange={(event) => setOrderForm((current) => ({ ...current, clientOrderId: event.target.value }))} placeholder="선택, 1-36자" />
              </label>
            </div>

            <label className="checkRow">
              <input
                type="checkbox"
                checked={orderForm.confirmLive}
                onChange={(event) => setOrderForm((current) => ({ ...current, confirmLive: event.target.checked }))}
              />
              실제 주문 전송 확인
            </label>

            <button className="primaryButton dangerButton" onClick={submitOrder} disabled={privateAction !== null} type="button">
              <Send size={16} />
              주문 요청
            </button>
          </div>
        </section>
      </section>

      <section className="apiResultPanel privateResults">
        <ResultBlock title="계좌 조회" result={privateResults.accounts}>
          <PrivateSummary data={privateResults.accounts?.data} />
        </ResultBlock>
        <ResultBlock title="주문 가능 정보" result={privateResults.chance}>
          <PrivateSummary data={privateResults.chance?.data} />
        </ResultBlock>
        <ResultBlock title="주문 요청" result={privateResults.order}>
          <PrivateSummary data={privateResults.order?.data} />
        </ResultBlock>
      </section>
    </main>
  );
}

function ResultBlock({ title, result, children }: { title: string; result: ApiResult | null; children: ReactNode }) {
  return (
    <article className="apiResultBlock">
      <div className="resultBlockHeader">
        <div>
          <h2>{title}</h2>
          <span>{result ? `${result.status || "-"} · ${new Date(result.requestedAt).toLocaleTimeString("ko-KR")}` : "대기"}</span>
        </div>
        {result && <strong className={result.ok ? "goodText" : "badText"}>{result.ok ? "OK" : "FAIL"}</strong>}
      </div>
      {children}
      {result?.endpoint && <code className="endpointText">{result.endpoint}</code>}
      {result?.error && <p className="errorText">{result.error}</p>}
      {result?.data !== undefined && <pre className="jsonViewer">{formatJson(result.data)}</pre>}
    </article>
  );
}

function MarketsSummary({ data }: { data: unknown }) {
  const markets = Array.isArray(data) ? (data as MarketInfo[]) : [];
  if (markets.length === 0) {
    return <div className="emptyResult small">응답 없음</div>;
  }

  return (
    <div className="summaryTable">
      <div><span>전체</span><strong>{markets.length.toLocaleString("ko-KR")}</strong></div>
      <div><span>KRW</span><strong>{markets.filter((item) => item.market.startsWith("KRW-")).length.toLocaleString("ko-KR")}</strong></div>
      <div><span>유의</span><strong>{markets.filter((item) => item.market_warning === "CAUTION").length.toLocaleString("ko-KR")}</strong></div>
    </div>
  );
}

function TickerSummary({ data }: { data: unknown }) {
  const ticker = getFirst<TickerInfo>(data);
  if (!ticker) {
    return <div className="emptyResult small">응답 없음</div>;
  }

  return (
    <div className="summaryTable">
      <div><span>페어</span><strong>{ticker.market}</strong></div>
      <div><span>현재가</span><strong>{formatNumber(ticker.trade_price)}원</strong></div>
      <div><span>변동률</span><strong className={profitClass(ticker.signed_change_rate ?? 0)}>{formatPercent(ticker.signed_change_rate ?? 0)}</strong></div>
    </div>
  );
}

function OrderbookSummary({ data }: { data: unknown }) {
  const orderbook = getFirst<OrderbookInfo>(data);
  if (!orderbook) {
    return <div className="emptyResult small">응답 없음</div>;
  }

  return (
    <table className="compactTable">
      <thead>
        <tr>
          <th>호가</th>
          <th>매도</th>
          <th>매수</th>
        </tr>
      </thead>
      <tbody>
        {orderbook.orderbook_units.slice(0, 5).map((unit, index) => (
          <tr key={`${unit.ask_price}-${unit.bid_price}`}>
            <td>{index + 1}</td>
            <td>{formatNumber(unit.ask_price)} · {formatNumber(unit.ask_size)}</td>
            <td>{formatNumber(unit.bid_price)} · {formatNumber(unit.bid_size)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CandlesSummary({ data }: { data: unknown }) {
  const candles = Array.isArray(data) ? (data as MinuteCandleInfo[]) : [];
  if (candles.length === 0) {
    return <div className="emptyResult small">응답 없음</div>;
  }

  return (
    <table className="compactTable">
      <thead>
        <tr>
          <th>시각</th>
          <th>종가</th>
          <th>거래량</th>
        </tr>
      </thead>
      <tbody>
        {candles.slice(0, 8).map((candle) => (
          <tr key={`${candle.candle_date_time_kst}-${candle.trade_price}`}>
            <td>{candle.candle_date_time_kst.slice(5, 16).replace("T", " ")}</td>
            <td>{formatNumber(candle.trade_price)}</td>
            <td>{formatNumber(candle.candle_acc_trade_volume)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PrivateSummary({ data }: { data: unknown }) {
  if (data === undefined || data === null) {
    return <div className="emptyResult small">응답 없음</div>;
  }

  if (Array.isArray(data)) {
    return (
      <div className="summaryTable">
        <div><span>응답 개수</span><strong>{data.length.toLocaleString("ko-KR")}</strong></div>
        <div><span>형식</span><strong>Array</strong></div>
        <div><span>상태</span><strong>수신</strong></div>
      </div>
    );
  }

  if (typeof data === "object") {
    const keys = Object.keys(data as Record<string, unknown>);
    return (
      <div className="summaryTable">
        <div><span>필드</span><strong>{keys.length.toLocaleString("ko-KR")}</strong></div>
        <div><span>형식</span><strong>Object</strong></div>
        <div><span>상태</span><strong>수신</strong></div>
      </div>
    );
  }

  return <div className="emptyResult small">{String(data)}</div>;
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className={`metric ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

async function requestTest(test: TestKey, market: string, candleUnit: number, candleCount: number): Promise<ApiResult> {
  const endpoint = getEndpoint(test, market, candleUnit, candleCount);
  const response = await fetch(endpoint);
  const payload = (await response.json()) as { data?: unknown; error?: string; endpoint?: string };

  return {
    ok: response.ok,
    status: response.status,
    endpoint: payload.endpoint ?? endpoint,
    requestedAt: new Date().toISOString(),
    data: payload.data,
    error: payload.error
  };
}

function getEndpoint(test: TestKey, market: string, candleUnit: number, candleCount: number) {
  const normalizedMarket = encodeURIComponent(market.trim().toUpperCase());

  if (test === "markets") {
    return "/api/bithumb/markets?isDetails=true";
  }

  if (test === "ticker") {
    return `/api/bithumb/ticker?markets=${normalizedMarket}`;
  }

  if (test === "orderbook") {
    return `/api/bithumb/orderbook?markets=${normalizedMarket}`;
  }

  return `/api/bithumb/candles/minutes?unit=${candleUnit}&market=${normalizedMarket}&count=${candleCount}`;
}

function getFirst<T>(data: unknown): T | null {
  return Array.isArray(data) && data.length > 0 ? (data[0] as T) : null;
}

function formatNumber(value: number) {
  return Number(value).toLocaleString("ko-KR", { maximumFractionDigits: 8 });
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2);
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

import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

interface AccountInfo {
  currency: string;
  balance: string;
  locked: string;
  avg_buy_price: string;
  avg_buy_price_modified: boolean;
  unit_currency: string;
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

interface MarketInfo {
  market: string;
  korean_name?: string;
  english_name?: string;
  market_warning?: string;
}

interface ApiEnvelope<T> {
  data?: T;
  error?: string;
}

interface AssetRow {
  account: AccountInfo;
  market: string;
  marketInfo?: MarketInfo;
  ticker?: TickerInfo;
  quantity: number;
  locked: number;
  totalQuantity: number;
  avgBuyPrice: number;
  currentPrice: number | null;
  evaluation: number | null;
  costBasis: number | null;
  profit: number | null;
  profitRate: number | null;
}

export default function DashboardPage() {
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [tickers, setTickers] = useState<TickerInfo[]>([]);
  const [markets, setMarkets] = useState<MarketInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdatedAt, setLastUpdatedAt] = useState("");

  useEffect(() => {
    loadDashboard();
  }, []);

  const rows = useMemo(() => buildAssetRows(accounts, tickers, markets), [accounts, tickers, markets]);
  const summary = useMemo(() => buildSummary(rows), [rows]);
  const tickerMap = useMemo(() => new Map(tickers.map((ticker) => [ticker.market, ticker])), [tickers]);

  async function loadDashboard() {
    setIsLoading(true);
    setError("");

    try {
      const [accountsPayload, marketsPayload] = await Promise.all([
        fetchJson<ApiEnvelope<AccountInfo[]>>("/api/bithumb/private/accounts"),
        fetchJson<ApiEnvelope<MarketInfo[]>>("/api/bithumb/markets?isDetails=true")
      ]);

      if (accountsPayload.error || !Array.isArray(accountsPayload.data)) {
        throw new Error(accountsPayload.error ?? "계좌 조회 실패");
      }

      const nextMarkets = Array.isArray(marketsPayload.data) ? marketsPayload.data : [];
      const heldMarkets = getHeldKrwMarkets(accountsPayload.data, nextMarkets);
      const tickerPayload =
        heldMarkets.length > 0
          ? await fetchJson<ApiEnvelope<TickerInfo[]>>(`/api/bithumb/ticker?markets=${encodeURIComponent(heldMarkets.join(","))}`)
          : { data: [] };

      setAccounts(accountsPayload.data);
      setMarkets(nextMarkets);
      setTickers(Array.isArray(tickerPayload.data) ? tickerPayload.data : []);
      setLastUpdatedAt(new Date().toLocaleString("ko-KR"));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "대시보드 조회 실패");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main className="appShell">
      <header className="topBar">
        <div>
          <h1>대시보드</h1>
          <p>빗썸 계좌 · {lastUpdatedAt || "조회 전"}</p>
        </div>
        <div className="summaryStrip">
          <Metric label="총 평가금액" value={won(summary.totalEvaluation)} />
          <Metric label="가용 KRW" value={won(summary.availableKrw)} />
          <Metric label="평가손익" value={won(summary.totalProfit)} tone={profitTone(summary.totalProfit)} />
          <Metric label="보유 자산" value={`${rows.length.toLocaleString("ko-KR")}개`} />
        </div>
      </header>

      <div className="dashboardActions">
        <button className="secondaryButton" onClick={loadDashboard} disabled={isLoading} type="button">
          <RefreshCw size={16} />
          새로고침
        </button>
        {error && <p className="errorText">{error}</p>}
      </div>

      <section className="dashboardGrid">
        <article className="dashboardPanel wide">
          <div className="sectionHeader">
            <h2>자산 현황</h2>
            <span className="muted">{isLoading ? "조회 중" : `${accounts.length.toLocaleString("ko-KR")}개 계좌`}</span>
          </div>
          <div className="tableScroller">
            <table className="assetTable">
              <thead>
                <tr>
                  <th>자산</th>
                  <th>마켓</th>
                  <th>보유</th>
                  <th>주문중</th>
                  <th>평균단가</th>
                  <th>현재가</th>
                  <th>평가금액</th>
                  <th>평가손익</th>
                  <th>손익률</th>
                  <th>상태</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.account.currency}>
                    <td>
                      <strong>{row.account.currency}</strong>
                      <span>{row.marketInfo?.korean_name ?? row.account.unit_currency}</span>
                    </td>
                    <td>{row.market || "-"}</td>
                    <td>{decimal(row.quantity)}</td>
                    <td>{decimal(row.locked)}</td>
                    <td>{row.avgBuyPrice > 0 ? won(row.avgBuyPrice) : "-"}</td>
                    <td>{row.currentPrice !== null ? won(row.currentPrice) : "-"}</td>
                    <td>{row.evaluation !== null ? won(row.evaluation) : row.account.currency === "KRW" ? won(row.quantity + row.locked) : "-"}</td>
                    <td className={row.profit !== null ? profitClass(row.profit) : ""}>{row.profit !== null ? won(row.profit) : "-"}</td>
                    <td className={row.profitRate !== null ? profitClass(row.profitRate) : ""}>{row.profitRate !== null ? percent(row.profitRate) : "-"}</td>
                    <td>{row.marketInfo?.market_warning ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>

        <article className="dashboardPanel">
          <div className="sectionHeader">
            <h2>계좌 요약</h2>
          </div>
          <div className="summaryTable">
            <div><span>현금</span><strong>{won(summary.availableKrw)}</strong></div>
            <div><span>주문중 KRW</span><strong>{won(summary.lockedKrw)}</strong></div>
            <div><span>코인 평가</span><strong>{won(summary.cryptoEvaluation)}</strong></div>
            <div><span>총 매수금</span><strong>{won(summary.totalCostBasis)}</strong></div>
            <div><span>평가손익</span><strong className={profitClass(summary.totalProfit)}>{won(summary.totalProfit)}</strong></div>
            <div><span>평균 손익률</span><strong className={profitClass(summary.totalProfitRate ?? 0)}>{summary.totalProfitRate === null ? "-" : percent(summary.totalProfitRate)}</strong></div>
          </div>
        </article>

        <article className="dashboardPanel">
          <div className="sectionHeader">
            <h2>종목 상세</h2>
          </div>
          <div className="miniList">
            {rows.filter((row) => row.market).map((row) => {
              const ticker = tickerMap.get(row.market);
              return (
                <div className="miniListRow" key={row.market}>
                  <div>
                    <strong>{row.market}</strong>
                    <span>{row.marketInfo?.english_name ?? row.account.currency}</span>
                  </div>
                  <div>
                    <strong>{ticker ? won(ticker.trade_price) : "-"}</strong>
                    <span className={ticker ? profitClass(ticker.signed_change_rate ?? 0) : ""}>
                      {ticker ? percent(ticker.signed_change_rate ?? 0) : "시세 없음"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </article>

        <article className="dashboardPanel wide">
          <div className="sectionHeader">
            <h2>계좌 원본 응답</h2>
            <span className="muted">빗썸 Private API</span>
          </div>
          <pre className="jsonViewer dashboardJson">{JSON.stringify(accounts, null, 2)}</pre>
        </article>
      </section>
    </main>
  );
}

function buildAssetRows(accounts: AccountInfo[], tickers: TickerInfo[], markets: MarketInfo[]): AssetRow[] {
  const tickerMap = new Map(tickers.map((ticker) => [ticker.market, ticker]));
  const marketMap = new Map(markets.map((market) => [market.market, market]));

  return accounts.map((account) => {
    const candidateMarket = account.currency === "KRW" ? "" : `KRW-${account.currency}`;
    const market = marketMap.has(candidateMarket) || tickerMap.has(candidateMarket) ? candidateMarket : "";
    const ticker = tickerMap.get(market);
    const marketInfo = marketMap.get(market);
    const quantity = numberValue(account.balance);
    const locked = numberValue(account.locked);
    const totalQuantity = quantity + locked;
    const avgBuyPrice = numberValue(account.avg_buy_price);
    const currentPrice = ticker?.trade_price ?? null;
    const evaluation = currentPrice === null ? null : totalQuantity * currentPrice;
    const costBasis = avgBuyPrice > 0 ? totalQuantity * avgBuyPrice : null;
    const profit = evaluation !== null && costBasis !== null ? evaluation - costBasis : null;
    const profitRate = profit !== null && costBasis && costBasis > 0 ? profit / costBasis : null;

    return {
      account,
      market,
      marketInfo,
      ticker,
      quantity,
      locked,
      totalQuantity,
      avgBuyPrice,
      currentPrice,
      evaluation,
      costBasis,
      profit,
      profitRate
    };
  });
}

function buildSummary(rows: AssetRow[]) {
  const krwRow = rows.find((row) => row.account.currency === "KRW");
  const availableKrw = krwRow?.quantity ?? 0;
  const lockedKrw = krwRow?.locked ?? 0;
  const cryptoRows = rows.filter((row) => row.account.currency !== "KRW" && row.evaluation !== null);
  const cryptoEvaluation = cryptoRows.reduce((sum, row) => sum + (row.evaluation ?? 0), 0);
  const totalCostBasis = cryptoRows.reduce((sum, row) => sum + (row.costBasis ?? 0), 0);
  const totalProfit = cryptoRows.reduce((sum, row) => sum + (row.profit ?? 0), 0);
  const totalEvaluation = availableKrw + lockedKrw + cryptoEvaluation;

  return {
    availableKrw,
    lockedKrw,
    cryptoEvaluation,
    totalCostBasis,
    totalProfit,
    totalProfitRate: totalCostBasis > 0 ? totalProfit / totalCostBasis : null,
    totalEvaluation
  };
}

function getHeldKrwMarkets(accounts: AccountInfo[], markets: MarketInfo[]) {
  const marketSet = new Set(markets.map((market) => market.market));
  return accounts
    .map((account) => `KRW-${account.currency}`)
    .filter((market) => marketSet.has(market));
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const payload = (await response.json()) as T;

  if (!response.ok) {
    const error = typeof payload === "object" && payload !== null && "error" in payload ? String((payload as { error: unknown }).error) : "Request failed";
    throw new Error(error);
  }

  return payload;
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className={`metric ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function numberValue(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function decimal(value: number) {
  return value.toLocaleString("ko-KR", { maximumFractionDigits: 8 });
}

function won(value: number) {
  return `${Math.round(value).toLocaleString("ko-KR")}원`;
}

function percent(value: number) {
  return `${(value * 100).toFixed(2)}%`;
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

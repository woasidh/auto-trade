import {
  ColorType,
  CrosshairMode,
  TickMarkType,
  createChart,
  type IChartApi,
  type MouseEventParams,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { formatKstIso } from "../shared/candles";
import type { Candle, SimulationResult, TradeEvent } from "../shared/types";

interface PriceChartProps {
  candles: Candle[];
  result?: SimulationResult | null;
  events?: TradeEvent[];
}

const tradeMarkerStyles = {
  BUY: {
    color: "#2563eb",
    position: "belowBar",
    shape: "arrowUp",
    label: "B",
    actionLabel: "매수"
  },
  SELL: {
    color: "#7c3aed",
    position: "aboveBar",
    shape: "arrowDown",
    label: "S",
    actionLabel: "매도"
  }
} as const;

const maxHoverConnectionLines = 6;
const tooltipWidth = 292;
const tooltipMargin = 10;

interface TradePair {
  id: string;
  buy: TradeEvent;
  sell: TradeEvent;
  profit: number;
  roi: number;
}

interface TradeMarkerGroup {
  id: string;
  type: TradeEvent["type"];
  epochSeconds: number;
  events: TradeEvent[];
  pairs: TradePair[];
}

interface HoverTradeInfo {
  x: number;
  y: number;
  group: TradeMarkerGroup;
}

export interface HoverConnectionLineSegment {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  dashed: boolean;
}

interface HoverConnectionPair {
  id: string;
  buy: Pick<TradeEvent, "epochSeconds" | "price">;
  sell: Pick<TradeEvent, "epochSeconds" | "price">;
  profit: number;
}

interface HoverConnectionLineContext {
  chart: {
    timeScale(): {
      timeToCoordinate(time: Time): number | null;
    };
  };
  series: {
    priceToCoordinate(price: number): number | null;
  };
  availableTimes: Set<number>;
}

export default function PriceChart({ candles, events, result }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const candleTimesRef = useRef<Set<number>>(new Set());
  const markerGroupsRef = useRef<Map<string, TradeMarkerGroup>>(new Map());
  const hoverGroupIdRef = useRef<string | null>(null);
  const [hoverTrade, setHoverTrade] = useState<HoverTradeInfo | null>(null);
  const [hoverConnectionLines, setHoverConnectionLines] = useState<HoverConnectionLineSegment[]>([]);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const chart = createChart(containerRef.current, {
      height: 460,
      layout: {
        background: { type: ColorType.Solid, color: "#ffffff" },
        textColor: "#253042",
        fontFamily: "Inter, system-ui, sans-serif"
      },
      localization: {
        timeFormatter: formatChartKstDateTime
      },
      grid: {
        vertLines: { color: "#eef1f5" },
        horzLines: { color: "#eef1f5" }
      },
      crosshair: {
        mode: CrosshairMode.Normal
      },
      rightPriceScale: {
        borderColor: "#d6dce5"
      },
      timeScale: {
        borderColor: "#d6dce5",
        fixLeftEdge: true,
        fixRightEdge: true,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: formatChartKstTick
      }
    });

    const series = chart.addCandlestickSeries({
      upColor: "#15803d",
      downColor: "#c2410c",
      borderVisible: false,
      wickUpColor: "#15803d",
      wickDownColor: "#c2410c",
      priceFormat: {
        type: "price",
        precision: 0,
        minMove: 1
      }
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const handleCrosshairMove = (param: MouseEventParams<Time>) => {
      const markerId = typeof param.hoveredObjectId === "string" ? param.hoveredObjectId : "";
      const group = markerId ? markerGroupsRef.current.get(markerId) : undefined;

      if (!param.point || !group) {
        if (hoverGroupIdRef.current !== null) {
          hoverGroupIdRef.current = null;
          setHoverTrade(null);
          setHoverConnectionLines([]);
        }
        return;
      }

      const nextHoverId = `${group.id}:${Math.round(param.point.x)}:${Math.round(param.point.y)}`;
      if (hoverGroupIdRef.current === nextHoverId) {
        return;
      }

      hoverGroupIdRef.current = nextHoverId;
      setHoverConnectionLines(createHoverConnectionLineSegments(group.pairs, { chart, series, availableTimes: candleTimesRef.current }));
      setHoverTrade({
        ...positionHoverCard(param.point, containerRef.current),
        group
      });
    };
    chart.subscribeCrosshairMove(handleCrosshairMove);

    const resizeObserver = new ResizeObserver(([entry]) => {
      if (entry) {
        chart.applyOptions({ width: entry.contentRect.width });
        chart.timeScale().fitContent();
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      candleTimesRef.current = new Set();
      markerGroupsRef.current = new Map();
      hoverGroupIdRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) {
      return;
    }

    seriesRef.current.setData(
      candles.map((candle) => ({
        time: candle.epochSeconds as UTCTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close
      }))
    );
    candleTimesRef.current = new Set(candles.map((candle) => candle.epochSeconds));
    chartRef.current.timeScale().fitContent();
  }, [candles]);

  useEffect(() => {
    if (!seriesRef.current) {
      return;
    }

    const tradeEvents = result?.events ?? events ?? [];
    const { groups, groupsById } = createTradeMarkerGroups(tradeEvents, candleTimesRef.current);
    markerGroupsRef.current = groupsById;
    seriesRef.current.setMarkers(toMarkers(groups));
    hoverGroupIdRef.current = null;
    setHoverTrade(null);
    setHoverConnectionLines([]);
  }, [events, result, candles]);

  return (
    <div className="chartShell">
      <div ref={containerRef} className="chartSurface" />
      <HoverConnectionOverlay lines={hoverConnectionLines} />
      {hoverTrade && <TradeHoverCard hover={hoverTrade} />}
    </div>
  );
}

function createTradeMarkerGroups(events: TradeEvent[], availableTimes: Set<number>): { groups: TradeMarkerGroup[]; groupsById: Map<string, TradeMarkerGroup> } {
  const pairsByEventId = createTradePairsByEventId(events);
  const groupsById = new Map<string, TradeMarkerGroup>();

  for (const event of events) {
    const markerEpochSeconds = resolveChartTimeSeconds(event.epochSeconds, availableTimes);
    const id = `${event.type}:${markerEpochSeconds}`;
    const current = groupsById.get(id);
    const pair = pairsByEventId.get(event.id);
    if (current) {
      current.events.push(event);
      if (pair && !current.pairs.some((candidate) => candidate.id === pair.id)) {
        current.pairs.push(pair);
      }
      continue;
    }

    groupsById.set(id, {
      id,
      type: event.type,
      epochSeconds: markerEpochSeconds,
      events: [event],
      pairs: pair ? [pair] : []
    });
  }

  const groups = [...groupsById.values()].sort((left, right) => left.epochSeconds - right.epochSeconds || left.id.localeCompare(right.id));
  return { groups, groupsById };
}

function createTradePairsByEventId(events: TradeEvent[]): Map<string, TradePair> {
  const openBuysBySlot = new Map<number, TradeEvent[]>();
  const pairByEventId = new Map<string, TradePair>();
  const sortedEvents = [...events].sort((left, right) => left.epochSeconds - right.epochSeconds || left.id.localeCompare(right.id));

  for (const event of sortedEvents) {
    if (event.type === "BUY") {
      const buys = openBuysBySlot.get(event.slotNumber) ?? [];
      buys.push(event);
      openBuysBySlot.set(event.slotNumber, buys);
      continue;
    }

    const buys = openBuysBySlot.get(event.slotNumber) ?? [];
    const buy = buys.shift();
    if (!buy) {
      continue;
    }

    const pair = createTradePair(buy, event);
    pairByEventId.set(buy.id, pair);
    pairByEventId.set(event.id, pair);
  }

  return pairByEventId;
}

function createTradePair(buy: TradeEvent, sell: TradeEvent): TradePair {
  const matchedQuantity = Math.min(buy.quantity, sell.quantity);
  const buyCost = buy.quantity > 0 ? ((buy.grossAmount + buy.fee) / buy.quantity) * matchedQuantity : 0;
  const sellProceeds = sell.quantity > 0 ? ((sell.grossAmount - sell.fee) / sell.quantity) * matchedQuantity : 0;
  const profit = sell.profit ?? buy.profit ?? sellProceeds - buyCost;

  return {
    id: `${buy.id}:${sell.id}`,
    buy,
    sell,
    profit,
    roi: buyCost > 0 ? profit / buyCost : 0
  };
}

function toMarkers(groups: TradeMarkerGroup[]): SeriesMarker<Time>[] {
  return groups.map((group) => {
    const style = tradeMarkerStyles[group.type];
    const firstEvent = group.events[0];
    const text = group.events.length === 1 ? `${style.label}${firstEvent.slotNumber}` : `${style.label} x${group.events.length}`;
    return {
      id: group.id,
      time: group.epochSeconds as UTCTimestamp,
      position: style.position,
      color: style.color,
      shape: style.shape,
      size: group.events.length > 1 ? 1.65 : 1.45,
      text
    };
  });
}

export function createHoverConnectionLineSegments(
  pairs: HoverConnectionPair[],
  { chart, series, availableTimes }: HoverConnectionLineContext
): HoverConnectionLineSegment[] {
  return pairs.slice(0, maxHoverConnectionLines).flatMap((pair) => {
    if (pair.buy.epochSeconds === pair.sell.epochSeconds) {
      return [];
    }

    const buyTime = resolveChartTimeSeconds(pair.buy.epochSeconds, availableTimes) as UTCTimestamp;
    const sellTime = resolveChartTimeSeconds(pair.sell.epochSeconds, availableTimes) as UTCTimestamp;
    const x1 = chart.timeScale().timeToCoordinate(buyTime);
    const x2 = chart.timeScale().timeToCoordinate(sellTime);
    const y1 = series.priceToCoordinate(pair.buy.price);
    const y2 = series.priceToCoordinate(pair.sell.price);

    if (x1 === null || x2 === null || y1 === null || y2 === null) {
      return [];
    }

    return [
      {
        id: pair.id,
        x1,
        y1,
        x2,
        y2,
        color: pair.profit >= 0 ? "#0f766e" : "#dc2626",
        dashed: pair.profit < 0
      }
    ];
  });
}

function resolveChartTimeSeconds(epochSeconds: number, availableTimes: Set<number>): number {
  if (availableTimes.size === 0 || availableTimes.has(epochSeconds)) {
    return epochSeconds;
  }

  const minuteStart = Math.floor(epochSeconds / 60) * 60;
  if (availableTimes.has(minuteStart)) {
    return minuteStart;
  }

  let nearest = epochSeconds;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const availableTime of availableTimes) {
    const distance = Math.abs(availableTime - epochSeconds);
    if (distance < nearestDistance) {
      nearest = availableTime;
      nearestDistance = distance;
    }
  }

  return nearest;
}

function HoverConnectionOverlay({ lines }: { lines: HoverConnectionLineSegment[] }) {
  if (lines.length === 0) {
    return null;
  }

  return (
    <svg className="chartConnectionOverlay" aria-hidden="true">
      {lines.map((line) => (
        <line
          key={line.id}
          x1={line.x1}
          y1={line.y1}
          x2={line.x2}
          y2={line.y2}
          stroke={line.color}
          strokeWidth="2"
          strokeDasharray={line.dashed ? "5 4" : undefined}
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}

function positionHoverCard(point: { x: number; y: number }, container: HTMLDivElement | null): { x: number; y: number } {
  const width = container?.clientWidth ?? 0;
  const left = Math.min(Math.max(point.x + 16, tooltipMargin), Math.max(tooltipMargin, width - tooltipWidth - tooltipMargin));
  const top = point.y > 250 ? Math.max(tooltipMargin, point.y - 214) : point.y + 18;
  return { x: left, y: top };
}

function TradeHoverCard({ hover }: { hover: HoverTradeInfo }) {
  const { group } = hover;
  const style = tradeMarkerStyles[group.type];
  const aggregate = summarizeEvents(group.events);

  return (
    <div className="chartHoverCard" style={{ left: hover.x, top: hover.y }}>
      <div className="chartHoverHeader">
        <strong>{style.actionLabel} {group.events.length.toLocaleString("ko-KR")}건</strong>
        <span>{formatChartKstDateTime(group.epochSeconds as UTCTimestamp)}</span>
      </div>
      <div className="chartHoverMetrics">
        <span>
          평균가
          <strong>{formatPrice(aggregate.averagePrice)}</strong>
        </span>
        <span>
          수량
          <strong>{formatQuantity(aggregate.quantity)}</strong>
        </span>
        <span>
          수수료
          <strong>{formatPrice(aggregate.fee)}</strong>
        </span>
      </div>
      {group.pairs.length > 0 && (
        <div className="chartHoverPair">
          <span>왕복 {Math.min(group.pairs.length, maxHoverConnectionLines)}건 연결 표시</span>
          <strong className={aggregatePairProfit(group.pairs) >= 0 ? "goodText" : "badText"}>{formatSignedPrice(aggregatePairProfit(group.pairs))}</strong>
        </div>
      )}
      <div className="chartHoverRows">
        {group.events.slice(0, 6).map((event) => (
          <div className="chartHoverRow" key={event.id}>
            <span>S{event.slotNumber}</span>
            <strong>{formatPrice(event.price)}</strong>
            <em>{formatQuantity(event.quantity)}</em>
          </div>
        ))}
        {group.events.length > 6 && <div className="chartHoverMore">+{group.events.length - 6}건 더 있음</div>}
      </div>
    </div>
  );
}

function summarizeEvents(events: TradeEvent[]) {
  const quantity = events.reduce((sum, event) => sum + event.quantity, 0);
  const grossAmount = events.reduce((sum, event) => sum + event.grossAmount, 0);
  const fee = events.reduce((sum, event) => sum + event.fee, 0);

  return {
    quantity,
    fee,
    averagePrice: quantity > 0 ? grossAmount / quantity : events[0]?.price ?? 0
  };
}

function aggregatePairProfit(pairs: TradePair[]): number {
  return pairs.reduce((sum, pair) => sum + pair.profit, 0);
}

function formatChartKstTick(time: Time, tickMarkType: TickMarkType) {
  const kstIso = timeToKstIso(time);
  if (!kstIso) {
    return null;
  }

  const date = kstIso.slice(0, 10);
  const timeOfDay = kstIso.slice(11, 19);

  switch (tickMarkType) {
    case TickMarkType.Year:
      return date.slice(0, 4);
    case TickMarkType.Month:
      return date.slice(0, 7);
    case TickMarkType.DayOfMonth:
      return date.slice(5, 10);
    case TickMarkType.TimeWithSeconds:
      return timeOfDay;
    case TickMarkType.Time:
    default:
      return timeOfDay.slice(0, 5);
  }
}

function formatChartKstDateTime(time: Time) {
  const kstIso = timeToKstIso(time);
  return kstIso ? kstIso.slice(0, 16).replace("T", " ") : "";
}

function timeToKstIso(time: Time) {
  if (typeof time === "number") {
    return formatKstIso(time * 1000);
  }

  if (typeof time === "string") {
    const parsed = Date.parse(time);
    return Number.isFinite(parsed) ? formatKstIso(parsed) : null;
  }

  return formatKstIso(Date.UTC(time.year, time.month - 1, time.day));
}

function formatPrice(value: number) {
  return Math.round(value).toLocaleString("ko-KR", { maximumFractionDigits: 0 });
}

function formatSignedPrice(value: number) {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${formatPrice(value)}`;
}

function formatQuantity(value: number) {
  return value.toLocaleString("ko-KR", { maximumFractionDigits: 8 });
}

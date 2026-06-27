import {
  ColorType,
  CrosshairMode,
  TickMarkType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import { formatKstIso } from "../shared/candles";
import type { Candle, SimulationResult, TradeEvent } from "../shared/types";

interface PriceChartProps {
  candles: Candle[];
  result?: SimulationResult | null;
  events?: TradeEvent[];
}

const tradeMarkerStyles = {
  BUY: {
    color: "#047857",
    position: "belowBar",
    shape: "arrowUp",
    label: "BUY"
  },
  SELL: {
    color: "#dc2626",
    position: "aboveBar",
    shape: "arrowDown",
    label: "SELL"
  }
} as const;

export default function PriceChart({ candles, events, result }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

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

    const resizeObserver = new ResizeObserver(([entry]) => {
      if (entry) {
        chart.applyOptions({ width: entry.contentRect.width });
        chart.timeScale().fitContent();
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
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
    chartRef.current.timeScale().fitContent();
  }, [candles]);

  useEffect(() => {
    if (!seriesRef.current) {
      return;
    }

    seriesRef.current.setMarkers(toMarkers(result?.events ?? events ?? []));
  }, [events, result]);

  return <div ref={containerRef} className="chartSurface" />;
}

function toMarkers(events: TradeEvent[]): SeriesMarker<Time>[] {
  return events.map((event) => {
    const style = tradeMarkerStyles[event.type];
    return {
      time: event.epochSeconds as UTCTimestamp,
      position: style.position,
      color: style.color,
      shape: style.shape,
      size: 1.55,
      text: `[${style.label}] S${event.slotNumber} @ ${formatPrice(event.price)}`
    };
  });
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

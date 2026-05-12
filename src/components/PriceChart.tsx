import {
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import type { Candle, SimulationResult, TradeEvent } from "../shared/types";

interface PriceChartProps {
  candles: Candle[];
  result?: SimulationResult | null;
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

export default function PriceChart({ candles, result }: PriceChartProps) {
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
        secondsVisible: false
      }
    });

    const series = chart.addCandlestickSeries({
      upColor: "#15803d",
      downColor: "#c2410c",
      borderVisible: false,
      wickUpColor: "#15803d",
      wickDownColor: "#c2410c"
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

    seriesRef.current.setMarkers(result ? toMarkers(result.events) : []);
  }, [result]);

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

function formatPrice(value: number) {
  return Math.round(value).toLocaleString("ko-KR", { maximumFractionDigits: 0 });
}

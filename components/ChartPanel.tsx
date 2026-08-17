'use client';
import { useEffect, useRef } from 'react';
import {
  calcSMA, calcBollingerBands, calcRSI, calcMACD, calcVolumeHistogram,
  type LWCandle,
} from '@/lib/chartIndicators';
import type { SRZone } from '@/lib/supportResistance';

export type Overlay = 'sma20' | 'sma50' | 'sma200' | 'bb' | 'vwap' | 'volume' | 'rsi' | 'macd';

// Distinct from SRZone (support/resistance, always dashed green/red) —
// these are solid-line markers for an actual position's own levels
// (entry/stop/target), so they read as "this position" rather than being
// mistaken for a technical S/R zone.
export type PositionLevel = { price: number; label: string; color: string };

type Props = {
  candles: LWCandle[];
  overlays: Set<Overlay>;
  srZones: SRZone[];
  positionLevels?: PositionLevel[];
};

export function ChartPanel({ candles, overlays, srZones, positionLevels }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current || !candles.length) return;

    let destroyed = false;
    // eslint-disable-next-line prefer-const
    let chartInstance: { remove: () => void } | null = null;

    import('lightweight-charts').then(lw => {
      if (destroyed || !containerRef.current) return;

      const {
        createChart,
        CandlestickSeries,
        LineSeries,
        HistogramSeries,
        LineStyle,
      } = lw as typeof import('lightweight-charts');

      const chart = createChart(containerRef.current, {
        layout:  { background: { color: '#030712' }, textColor: '#9ca3af' },
        grid:    { vertLines: { color: '#111827' }, horzLines: { color: '#111827' } },
        crosshair: { mode: 1 },
        rightPriceScale: { borderColor: '#1f2937' },
        timeScale: { borderColor: '#1f2937', timeVisible: true, secondsVisible: false },
        autoSize: true,
      });

      // ── Pane index allocation ──────────────────────────────────────────────
      let nextPane = 1;
      const rsiPane  = overlays.has('rsi')    ? nextPane++ : -1;
      const macdPane = overlays.has('macd')   ? nextPane++ : -1;
      const volPane  = overlays.has('volume') ? nextPane++ : -1;

      // ── Candlesticks ──────────────────────────────────────────────────────
      const candle = chart.addSeries(CandlestickSeries, {
        upColor: '#10b981', downColor: '#ef4444',
        borderUpColor: '#10b981', borderDownColor: '#ef4444',
        wickUpColor: '#10b981', wickDownColor: '#ef4444',
      });
      candle.setData(candles as Parameters<typeof candle.setData>[0]);

      // ── SMA overlays ──────────────────────────────────────────────────────
      if (overlays.has('sma20')) {
        const s = chart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 1, priceLineVisible: false, crosshairMarkerVisible: false, lastValueVisible: false });
        s.setData(calcSMA(candles, 20) as Parameters<typeof s.setData>[0]);
      }
      if (overlays.has('sma50')) {
        const s = chart.addSeries(LineSeries, { color: '#a855f7', lineWidth: 1, priceLineVisible: false, crosshairMarkerVisible: false, lastValueVisible: false });
        s.setData(calcSMA(candles, 50) as Parameters<typeof s.setData>[0]);
      }
      if (overlays.has('sma200')) {
        const s = chart.addSeries(LineSeries, { color: '#3b82f6', lineWidth: 1, priceLineVisible: false, crosshairMarkerVisible: false, lastValueVisible: false });
        s.setData(calcSMA(candles, 200) as Parameters<typeof s.setData>[0]);
      }

      // ── Bollinger Bands ───────────────────────────────────────────────────
      if (overlays.has('bb')) {
        const { upper, mid, lower } = calcBollingerBands(candles);
        const opts = { priceLineVisible: false, crosshairMarkerVisible: false, lastValueVisible: false, lineStyle: LineStyle.Dashed };
        const mS = chart.addSeries(LineSeries, { ...opts, color: '#818cf8', lineStyle: LineStyle.Solid });
        const uS = chart.addSeries(LineSeries, { ...opts, color: '#818cf880' });
        const lS = chart.addSeries(LineSeries, { ...opts, color: '#818cf880' });
        mS.setData(mid   as Parameters<typeof mS.setData>[0]);
        uS.setData(upper as Parameters<typeof uS.setData>[0]);
        lS.setData(lower as Parameters<typeof lS.setData>[0]);
      }

      // ── S/R price lines ───────────────────────────────────────────────────
      for (const z of srZones) {
        candle.createPriceLine({
          price: z.price,
          color: z.type === 'support' ? '#10b981' : '#ef4444',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `${z.type === 'support' ? 'S' : 'R'}${z.strength}`,
        });
      }

      // ── Position levels (entry/stop/target) ──────────────────────────────
      for (const lvl of positionLevels ?? []) {
        candle.createPriceLine({
          price: lvl.price,
          color: lvl.color,
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: lvl.label,
        });
      }

      // ── RSI sub-pane ──────────────────────────────────────────────────────
      if (rsiPane > 0) {
        const rsiData = calcRSI(candles, 14);
        const rsiS = chart.addSeries(LineSeries, {
          color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: true,
        }, rsiPane);
        rsiS.setData(rsiData as Parameters<typeof rsiS.setData>[0]);
        rsiS.createPriceLine({ price: 70, color: '#ef444480', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '70' });
        rsiS.createPriceLine({ price: 30, color: '#10b98180', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '30' });
        rsiS.createPriceLine({ price: 50, color: '#6b728040', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' });
      }

      // ── MACD sub-pane ─────────────────────────────────────────────────────
      if (macdPane > 0) {
        const { macd: macdD, signal: sigD, hist: histD } = calcMACD(candles);
        const macdS = chart.addSeries(LineSeries, { color: '#3b82f6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, macdPane);
        const sigS  = chart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, macdPane);
        const histS = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, macdPane);
        macdS.setData(macdD as Parameters<typeof macdS.setData>[0]);
        sigS.setData(sigD   as Parameters<typeof sigS.setData>[0]);
        histS.setData(histD as Parameters<typeof histS.setData>[0]);
      }

      // ── Volume sub-pane ───────────────────────────────────────────────────
      if (volPane > 0) {
        const volS = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, volPane);
        volS.setData(calcVolumeHistogram(candles) as Parameters<typeof volS.setData>[0]);
      }

      chart.timeScale().fitContent();

      chartInstance = chart;
    });

    return () => {
      destroyed = true;
      chartInstance?.remove();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, overlays, srZones, positionLevels]);

  return (
    <div className="bg-[#030712] rounded-lg border border-gray-800 overflow-hidden">
      <div ref={containerRef} style={{ height: 480 }} />
    </div>
  );
}

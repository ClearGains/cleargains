'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, BarChart3, RefreshCw } from 'lucide-react';
import { ChartPanel, type Overlay, type PositionLevel } from '@/components/ChartPanel';
import type { LWCandle } from '@/lib/chartIndicators';

const CHART_OVERLAYS: Set<Overlay> = new Set(['sma20', 'sma50', 'bb', 'volume']);

function ModalPortal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;
  return createPortal(children, document.body);
}

export type ChartableStock = {
  symbol:         string;
  name:           string;
  price:          number;
  stopLoss:       number;
  takeProfit:     number;
  entry?:         number;         // DIP_BUY/STEADY — single current-price entry
  pullbackEntry?: number;         // MOMENTUM
  breakoutEntry?: number;         // MOMENTUM
};

export function StockChartModal({ stock, onClose }: { stock: ChartableStock | null; onClose: () => void }) {
  const [candles, setCandles] = useState<LWCandle[] | null>(null);
  const [error, setCandlesError] = useState<string | null>(null);

  useEffect(() => {
    if (!stock) return;
    setCandles(null);
    setCandlesError(null);
    // 10-day hourly — matches the position chart's own resolution choice;
    // these are day/swing-timeframe setups, recent intraday shape matters
    // more here than a long daily history.
    fetch(`/api/chart/history?symbol=${encodeURIComponent(stock.symbol)}&resolution=10DH`)
      .then(r => r.json())
      .then((d: { candles?: LWCandle[]; error?: string }) => {
        if (d.error) { setCandlesError(d.error); return; }
        setCandles(d.candles ?? []);
      })
      .catch(e => setCandlesError(String(e)));
  }, [stock]);

  if (!stock) return null;

  const levels: PositionLevel[] = stock.pullbackEntry !== undefined && stock.breakoutEntry !== undefined
    ? [
        { price: stock.pullbackEntry, label: 'Pullback', color: '#e5e7eb' },
        { price: stock.breakoutEntry, label: 'Breakout', color: '#38bdf8' },
        { price: stock.stopLoss,      label: 'Stop',     color: '#ef4444' },
        { price: stock.takeProfit,    label: 'Target',   color: '#10b981' },
      ]
    : [
        { price: stock.entry ?? stock.price, label: 'Entry',  color: '#e5e7eb' },
        { price: stock.stopLoss,             label: 'Stop',   color: '#ef4444' },
        { price: stock.takeProfit,           label: 'Target', color: '#10b981' },
      ];

  const panel = (
    <div
      className="fixed inset-0 z-[9999] flex items-start justify-center bg-black/75 px-4 overflow-y-auto"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-3xl shadow-2xl mt-[60px] mb-8"
        style={{ maxHeight: 'calc(100vh - 100px)', overflowY: 'auto' }}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-orange-500/20 flex items-center justify-center flex-shrink-0">
              <BarChart3 className="h-4 w-4 text-orange-400" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">{stock.name} ({stock.symbol})</h3>
              <p className="text-[10px] text-gray-500">Current {stock.price.toFixed(2)}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="ml-4 flex-shrink-0 text-gray-500 hover:text-white transition-colors p-1 rounded-lg hover:bg-gray-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {error ? (
          <div className="text-xs text-gray-500 py-12 text-center">{error}</div>
        ) : !candles ? (
          <div className="flex items-center justify-center py-12 text-gray-500 text-xs gap-2">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Loading chart…
          </div>
        ) : candles.length === 0 ? (
          <div className="text-xs text-gray-500 py-12 text-center">No candle data available for {stock.symbol}</div>
        ) : (
          <ChartPanel candles={candles} overlays={CHART_OVERLAYS} srZones={[]} positionLevels={levels} />
        )}
      </div>
    </div>
  );

  return <ModalPortal>{panel}</ModalPortal>;
}

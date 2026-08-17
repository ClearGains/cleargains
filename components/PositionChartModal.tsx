'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, BarChart3, RefreshCw } from 'lucide-react';
import { ChartPanel, type Overlay, type PositionLevel } from '@/components/ChartPanel';
import type { LWCandle } from '@/lib/chartIndicators';
import { epicToYahooSymbol } from '@/lib/epicToYahoo';

const CHART_OVERLAYS: Set<Overlay> = new Set(['sma20', 'sma50', 'bb', 'volume']);

function ModalPortal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;
  return createPortal(children, document.body);
}

export type ChartablePosition = {
  epic:         string;
  name:         string;
  direction:    'BUY' | 'SELL';
  entryPrice:   number;
  currentPrice: number;
  stopLevel?:   number;
  limitLevel?:  number;
};

export function PositionChartModal({ pos, onClose }: { pos: ChartablePosition | null; onClose: () => void }) {
  const [candles, setCandles] = useState<LWCandle[] | null>(null);
  const [error, setCandlesError] = useState<string | null>(null);

  const yahooSymbol = pos ? epicToYahooSymbol(pos.epic) : null;

  useEffect(() => {
    if (!pos) return;
    setCandles(null);
    setCandlesError(null);
    if (!yahooSymbol) { setCandlesError(`No chart data source known for ${pos.name} (${pos.epic})`); return; }
    // 10-day hourly — these are short-duration leveraged positions
    // (typically opened and resolved within a day or so per gemini_opinion's
    // own design), so recent intraday shape matters more than a long daily
    // history here, same resolution choice DailyBrief.tsx uses for its own
    // scalp-style setups.
    fetch(`/api/chart/history?symbol=${encodeURIComponent(yahooSymbol)}&resolution=10DH`)
      .then(r => r.json())
      .then((d: { candles?: LWCandle[]; error?: string }) => {
        if (d.error) { setCandlesError(d.error); return; }
        setCandles(d.candles ?? []);
      })
      .catch(e => setCandlesError(String(e)));
  }, [pos, yahooSymbol]);

  if (!pos) return null;

  const levels: PositionLevel[] = [
    { price: pos.entryPrice, label: 'Entry', color: '#e5e7eb' },
    ...(pos.stopLevel  !== undefined ? [{ price: pos.stopLevel,  label: 'Stop',   color: '#ef4444' }] : []),
    ...(pos.limitLevel !== undefined ? [{ price: pos.limitLevel, label: 'Target', color: '#10b981' }] : []),
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
              <h3 className="text-sm font-bold text-white">{pos.name}</h3>
              <p className="text-[10px] text-gray-500">
                {pos.direction === 'BUY' ? 'LONG' : 'SHORT'} · Entry {pos.entryPrice.toFixed(2)} · Current {pos.currentPrice.toFixed(2)}
              </p>
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
          <div className="text-xs text-gray-500 py-12 text-center">No candle data available for {yahooSymbol}</div>
        ) : (
          <ChartPanel candles={candles} overlays={CHART_OVERLAYS} srZones={[]} positionLevels={levels} />
        )}
      </div>
    </div>
  );

  return <ModalPortal>{panel}</ModalPortal>;
}

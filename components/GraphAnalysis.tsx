'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, RefreshCw, TrendingUp, ChevronDown } from 'lucide-react';
import type { LWCandle } from '@/lib/chartIndicators';
import type { SRZone } from '@/lib/supportResistance';
import type { AnalysisResult } from '@/app/api/analyse/chart/route';
import { fetchYahooHistoryByResolution, searchYahooTickers, type ChartResolution, type TickerSearchResult } from '@/lib/yahooClient';
import { ChartPanel, type Overlay } from '@/components/ChartPanel';
import { TradeCard } from '@/components/TradeCard';
import { ProAnalysis } from '@/components/ProAnalysis';

type Resolution = ChartResolution;

const RESOLUTIONS: Resolution[] = ['1D', '1W', '1M', '3M', '6M', '1Y'];

const POPULAR = ['AAPL', 'TSLA', 'NVDA', 'META', 'MSFT', 'AMZN', 'SPY', 'QQQ', 'GOOGL', 'AMD'];

const DEFAULT_OVERLAYS: Set<Overlay> = new Set(['sma20', 'sma50', 'bb', 'volume']);

const LS_KEY = 'ga_recent_tickers';

function loadRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '[]'); } catch { return []; }
}
function saveRecent(ticker: string, prev: string[]) {
  const updated = [ticker, ...prev.filter(t => t !== ticker)].slice(0, 8);
  localStorage.setItem(LS_KEY, JSON.stringify(updated));
  return updated;
}

export function GraphAnalysis() {
  const [ticker,     setTicker]     = useState('');
  const [activeTicker, setActiveTicker] = useState('');
  const [resolution, setResolution] = useState<Resolution>('3M');
  const [candles,    setCandles]    = useState<LWCandle[]>([]);
  const [srZones,    setSrZones]    = useState<SRZone[]>([]);
  const [overlays,   setOverlays]   = useState<Set<Overlay>>(new Set(DEFAULT_OVERLAYS));
  const [analysis,   setAnalysis]   = useState<AnalysisResult | null>(null);
  const [chartLoading,  setChartLoading]  = useState(false);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [chartError,  setChartError]  = useState('');
  const [searchResults, setSearchResults] = useState<TickerSearchResult[]>([]);
  const [searchOpen,    setSearchOpen]    = useState(false);
  const [recent,     setRecent]     = useState<string[]>([]);
  const searchRef = useRef<HTMLDivElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { setRecent(loadRecent()); }, []);

  // Close dropdown on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const loadChart = useCallback(async (sym: string, res: Resolution) => {
    if (!sym) return;
    setChartLoading(true);
    setChartError('');
    setAnalysis(null);
    try {
      const raw = await fetchYahooHistoryByResolution(sym, res);
      if (!raw.length) throw new Error(`No data returned for ${sym} — check the ticker symbol`);
      const lwCandles: LWCandle[] = raw.map(c => ({ ...c }));
      setCandles(lwCandles);
      const { calcSupportResistance } = await import('@/lib/supportResistance');
      setSrZones(calcSupportResistance(lwCandles));
    } catch (e) {
      setChartError(e instanceof Error ? e.message : 'Failed to load chart data');
      setCandles([]);
      setSrZones([]);
    } finally {
      setChartLoading(false);
    }
  }, []);

  const runAnalysis = useCallback(async () => {
    if (!candles.length || !activeTicker) return;
    setAnalysisLoading(true);
    try {
      const r = await fetch('/api/analyse/chart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: activeTicker, candles, resolution }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json() as AnalysisResult;
      setAnalysis(data);
    } catch (e) {
      console.error('[analyse]', e);
    } finally {
      setAnalysisLoading(false);
    }
  }, [candles, activeTicker, resolution]);

  function selectTicker(sym: string) {
    const upper = sym.toUpperCase();
    setTicker(upper);
    setActiveTicker(upper);
    setRecent(prev => saveRecent(upper, prev));
    setSearchOpen(false);
    setSearchResults([]);
    loadChart(upper, resolution);
  }

  function handleSearchInput(val: string) {
    setTicker(val);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!val.trim()) { setSearchResults([]); setSearchOpen(false); return; }
    setSearchOpen(true);
    searchTimer.current = setTimeout(async () => {
      const results = await searchYahooTickers(val);
      setSearchResults(results.slice(0, 8));
    }, 300);
  }

  function handleResolutionChange(res: Resolution) {
    setResolution(res);
    if (activeTicker) loadChart(activeTicker, res);
  }

  function toggleOverlay(o: Overlay) {
    setOverlays(prev => {
      const next = new Set(prev);
      if (next.has(o)) next.delete(o); else next.add(o);
      return next;
    });
  }

  const overlayButtons: { key: Overlay; label: string; color: string }[] = [
    { key: 'sma20',  label: 'SMA20',  color: 'text-amber-400  border-amber-400/40  bg-amber-400/10'  },
    { key: 'sma50',  label: 'SMA50',  color: 'text-purple-400 border-purple-400/40 bg-purple-400/10' },
    { key: 'sma200', label: 'SMA200', color: 'text-blue-400   border-blue-400/40   bg-blue-400/10'   },
    { key: 'bb',     label: 'BB',     color: 'text-indigo-400 border-indigo-400/40 bg-indigo-400/10' },
    { key: 'vwap',   label: 'VWAP',   color: 'text-pink-400   border-pink-400/40   bg-pink-400/10'   },
    { key: 'rsi',    label: 'RSI',    color: 'text-amber-500  border-amber-500/40  bg-amber-500/10'  },
    { key: 'macd',   label: 'MACD',   color: 'text-blue-500   border-blue-500/40   bg-blue-500/10'   },
    { key: 'volume', label: 'Vol',    color: 'text-gray-400   border-gray-400/40   bg-gray-400/10'   },
  ];

  return (
    <div className="space-y-4">
      {/* Search bar */}
      <div className="flex gap-3 flex-wrap">
        <div ref={searchRef} className="relative flex-1 min-w-48">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500 pointer-events-none" />
            <input
              className="w-full bg-gray-900 border border-gray-700 rounded-lg pl-9 pr-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 uppercase"
              placeholder="Search ticker — e.g. AAPL, NVDA, SPY"
              value={ticker}
              onChange={e => handleSearchInput(e.target.value)}
              onFocus={() => { if (ticker.length > 0) setSearchOpen(true); }}
              onKeyDown={e => { if (e.key === 'Enter' && ticker.trim()) selectTicker(ticker.trim()); }}
            />
          </div>
          {searchOpen && (searchResults.length > 0) && (
            <div className="absolute z-50 top-full mt-1 w-full bg-gray-900 border border-gray-700 rounded-lg shadow-2xl overflow-hidden">
              {searchResults.map(r => (
                <button
                  key={r.symbol}
                  className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-gray-800 text-left"
                  onClick={() => selectTicker(r.symbol)}
                >
                  <div>
                    <span className="text-sm font-bold text-white font-mono">{r.symbol}</span>
                    <span className="ml-2 text-xs text-gray-400 truncate max-w-[180px]">{r.name}</span>
                  </div>
                  <span className="text-[10px] text-gray-600 ml-2 shrink-0">{r.exchange}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Resolution tabs */}
        <div className="flex bg-gray-900 border border-gray-700 rounded-lg p-0.5 gap-0.5">
          {RESOLUTIONS.map(r => (
            <button
              key={r}
              onClick={() => handleResolutionChange(r)}
              className={`px-3 py-1.5 rounded text-xs font-mono font-semibold transition-all ${
                resolution === r
                  ? 'bg-emerald-600 text-white'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* Recent / Popular tickers */}
      <div className="flex gap-2 flex-wrap">
        {(recent.length > 0 ? recent : POPULAR).map(sym => (
          <button
            key={sym}
            onClick={() => selectTicker(sym)}
            className={`px-2.5 py-1 rounded text-xs font-mono border transition-all ${
              activeTicker === sym
                ? 'bg-emerald-600/20 text-emerald-400 border-emerald-600/40'
                : 'text-gray-500 border-gray-700 hover:text-gray-300 hover:border-gray-600'
            }`}
          >
            {sym}
          </button>
        ))}
      </div>

      {/* Overlay toggles */}
      <div className="flex gap-1.5 flex-wrap">
        {overlayButtons.map(({ key, label, color }) => (
          <button
            key={key}
            onClick={() => toggleOverlay(key)}
            className={`px-2.5 py-1 rounded border text-xs font-semibold transition-all ${
              overlays.has(key)
                ? color
                : 'text-gray-600 border-gray-800 hover:border-gray-700 hover:text-gray-500'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Chart area */}
      {chartLoading && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 h-60 flex items-center justify-center">
          <RefreshCw className="h-5 w-5 text-emerald-500 animate-spin" />
          <span className="ml-2 text-sm text-gray-500">Loading chart data…</span>
        </div>
      )}
      {chartError && (
        <div className="bg-red-950/20 border border-red-900/40 rounded-xl p-4 text-sm text-red-400">{chartError}</div>
      )}
      {!chartLoading && !chartError && !activeTicker && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 h-60 flex flex-col items-center justify-center gap-2 text-gray-600">
          <TrendingUp className="h-8 w-8" />
          <p className="text-sm">Search for a ticker or click a symbol above to load the chart</p>
        </div>
      )}
      {!chartLoading && !chartError && activeTicker && candles.length > 0 && (
        <ChartPanel candles={candles} overlays={overlays} srZones={srZones} />
      )}

      {/* Analyse button */}
      {candles.length > 0 && (
        <div className="flex justify-end">
          <button
            onClick={runAnalysis}
            disabled={analysisLoading}
            className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm font-semibold text-white transition-all"
          >
            {analysisLoading ? (
              <><RefreshCw className="h-4 w-4 animate-spin" /> Analysing…</>
            ) : (
              <><ChevronDown className="h-4 w-4" /> Run AI Analysis</>
            )}
          </button>
        </div>
      )}

      {/* Analysis results */}
      {analysis && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          {/* Left: overview */}
          <div className="xl:col-span-1 bg-gray-900 rounded-xl border border-gray-800 p-4">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-4">Market Analysis</h3>
            <ProAnalysis analysis={analysis} />
          </div>

          {/* Right: trade cards */}
          <div className="xl:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Scalp Setup</h3>
              <TradeCard trade={analysis.scalp} price={analysis.price} />
            </div>
            <div>
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Swing Setup</h3>
              <TradeCard trade={analysis.swing} price={analysis.price} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

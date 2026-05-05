'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, RefreshCw, TrendingUp, Sparkles, AlertCircle } from 'lucide-react';
import type { LWCandle } from '@/lib/chartIndicators';
import type { SRZone } from '@/lib/supportResistance';
import type { AnalysisResult } from '@/app/api/analyse/chart/route';
import { ChartPanel, type Overlay } from '@/components/ChartPanel';
import { TradeCard } from '@/components/TradeCard';
import { ProAnalysis } from '@/components/ProAnalysis';

type Resolution = '5D' | '1M' | '3M' | '6M' | '1Y' | '2Y';

type SearchResult = { symbol: string; name: string; exchange: string; type: string };

const RESOLUTIONS: Resolution[] = ['5D', '1M', '3M', '6M', '1Y', '2Y'];

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
  const [searchText,      setSearchText]      = useState('');
  const [activeTicker,    setActiveTicker]    = useState('');
  const [resolution,      setResolution]      = useState<Resolution>('3M');
  const [candles,         setCandles]         = useState<LWCandle[]>([]);
  const [srZones,         setSrZones]         = useState<SRZone[]>([]);
  const [overlays,        setOverlays]        = useState<Set<Overlay>>(new Set(DEFAULT_OVERLAYS));
  const [analysis,        setAnalysis]        = useState<AnalysisResult | null>(null);
  const [chartLoading,    setChartLoading]    = useState(false);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [chartError,      setChartError]      = useState('');
  const [analysisError,   setAnalysisError]   = useState('');
  const [searchResults,   setSearchResults]   = useState<SearchResult[]>([]);
  const [searchOpen,      setSearchOpen]      = useState(false);
  const [recent,          setRecent]          = useState<string[]>([]);
  const searchRef   = useRef<HTMLDivElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { setRecent(loadRecent()); }, []);

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
    setAnalysisError('');
    try {
      const r = await fetch(`/api/chart/history?symbol=${encodeURIComponent(sym)}&resolution=${res}`);
      const data = await r.json() as { candles?: LWCandle[]; error?: string };
      if (!r.ok || data.error) throw new Error(data.error ?? `HTTP ${r.status}`);
      if (!data.candles?.length) throw new Error(`No data found for "${sym}" — check the ticker symbol`);
      setCandles(data.candles);
      const { calcSupportResistance } = await import('@/lib/supportResistance');
      setSrZones(calcSupportResistance(data.candles));
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
    setAnalysisError('');
    setAnalysis(null);
    try {
      const r = await fetch('/api/analyse/chart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: activeTicker, candles, resolution }),
      });
      const data = await r.json() as AnalysisResult & { error?: string };
      if (!r.ok || data.error) throw new Error(data.error ?? `HTTP ${r.status}`);
      setAnalysis(data);
    } catch (e) {
      setAnalysisError(e instanceof Error ? e.message : 'Analysis failed — try again');
    } finally {
      setAnalysisLoading(false);
    }
  }, [candles, activeTicker, resolution]);

  function selectTicker(sym: string) {
    const upper = sym.toUpperCase();
    setSearchText(upper);
    setActiveTicker(upper);
    setRecent(prev => saveRecent(upper, prev));
    setSearchOpen(false);
    setSearchResults([]);
    loadChart(upper, resolution);
  }

  function handleSearchInput(val: string) {
    setSearchText(val);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!val.trim()) { setSearchResults([]); setSearchOpen(false); return; }
    setSearchOpen(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/chart/search?q=${encodeURIComponent(val)}`);
        if (!r.ok) return;
        const data = await r.json() as SearchResult[];
        setSearchResults(Array.isArray(data) ? data : []);
      } catch { /* ignore */ }
    }, 280);
  }

  function handleResolutionChange(res: Resolution) {
    setResolution(res);
    if (activeTicker) loadChart(activeTicker, res);
  }

  function toggleOverlay(o: Overlay) {
    setOverlays(prev => {
      const next = new Set(prev);
      next.has(o) ? next.delete(o) : next.add(o);
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
      {/* Search + resolution */}
      <div className="flex gap-3 flex-wrap">
        <div ref={searchRef} className="relative flex-1 min-w-64">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500 pointer-events-none" />
            <input
              className="w-full bg-gray-900 border border-gray-700 rounded-lg pl-9 pr-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 tracking-wide"
              placeholder="Search by name or ticker — Apple, NVDA, Tesla, SPY…"
              value={searchText}
              onChange={e => handleSearchInput(e.target.value)}
              onFocus={() => { if (searchText.length > 0) setSearchOpen(true); }}
              onKeyDown={e => {
                if (e.key === 'Enter' && searchText.trim()) {
                  // If there's a top result, use its symbol; otherwise treat input as ticker
                  if (searchResults.length > 0) {
                    selectTicker(searchResults[0].symbol);
                  } else {
                    selectTicker(searchText.trim());
                  }
                }
                if (e.key === 'Escape') setSearchOpen(false);
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          {searchOpen && searchResults.length > 0 && (
            <div className="absolute z-50 top-full mt-1 w-full bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden">
              {searchResults.map((r, idx) => (
                <button
                  key={`${r.symbol}-${idx}`}
                  className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-gray-800 text-left transition-colors"
                  onClick={() => selectTicker(r.symbol)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-sm font-bold text-white font-mono shrink-0">{r.symbol}</span>
                    <span className="text-xs text-gray-400 truncate">{r.name}</span>
                  </div>
                  <div className="flex items-center gap-2 ml-2 shrink-0">
                    {r.type && (
                      <span className="text-[10px] text-gray-600 bg-gray-800 px-1.5 py-0.5 rounded">{r.type}</span>
                    )}
                    <span className="text-[10px] text-gray-600">{r.exchange}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex bg-gray-900 border border-gray-700 rounded-lg p-0.5 gap-0.5">
          {RESOLUTIONS.map(r => (
            <button
              key={r}
              onClick={() => handleResolutionChange(r)}
              className={`px-3 py-1.5 rounded text-xs font-mono font-semibold transition-all ${
                resolution === r ? 'bg-emerald-600 text-white' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* Popular / recent chips */}
      <div className="flex gap-2 flex-wrap items-center">
        <span className="text-[10px] text-gray-600 uppercase tracking-wider">{recent.length > 0 ? 'Recent' : 'Popular'}</span>
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
              overlays.has(key) ? color : 'text-gray-600 border-gray-800 hover:border-gray-700 hover:text-gray-500'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Chart */}
      {chartLoading && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 h-64 flex items-center justify-center gap-2">
          <RefreshCw className="h-5 w-5 text-emerald-500 animate-spin" />
          <span className="text-sm text-gray-500">Loading chart data…</span>
        </div>
      )}
      {!chartLoading && chartError && (
        <div className="flex items-start gap-2 bg-red-950/20 border border-red-900/40 rounded-xl p-4">
          <AlertCircle className="h-4 w-4 text-red-400 mt-0.5 shrink-0" />
          <p className="text-sm text-red-400">{chartError}</p>
        </div>
      )}
      {!chartLoading && !chartError && !activeTicker && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 h-64 flex flex-col items-center justify-center gap-3 text-gray-600">
          <TrendingUp className="h-9 w-9" />
          <p className="text-sm">Search by name or ticker above, or click a symbol to load the chart</p>
        </div>
      )}
      {!chartLoading && !chartError && activeTicker && candles.length > 0 && (
        <ChartPanel candles={candles} overlays={overlays} srZones={srZones} />
      )}

      {/* Analyse button + error */}
      {candles.length > 0 && (
        <div className="flex flex-col items-end gap-2">
          {analysisError && (
            <div className="flex items-start gap-2 w-full bg-red-950/20 border border-red-900/40 rounded-lg px-3 py-2">
              <AlertCircle className="h-4 w-4 text-red-400 mt-0.5 shrink-0" />
              <p className="text-xs text-red-400">{analysisError}</p>
            </div>
          )}
          <button
            onClick={runAnalysis}
            disabled={analysisLoading}
            className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm font-semibold text-white transition-all"
          >
            {analysisLoading ? (
              <><RefreshCw className="h-4 w-4 animate-spin" />Analysing with AI…</>
            ) : (
              <><Sparkles className="h-4 w-4" />Run AI Analysis</>
            )}
          </button>
        </div>
      )}

      {/* Analysis results */}
      {analysis && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          <div className="xl:col-span-1 bg-gray-900 rounded-xl border border-gray-800 p-4">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-4">Market Analysis</h3>
            <ProAnalysis analysis={analysis} />
          </div>
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

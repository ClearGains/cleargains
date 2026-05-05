'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Search, RefreshCw, BarChart3, BookmarkPlus, BookmarkCheck,
  Trash2, Zap, AlertTriangle, X, Plus, ChevronDown, ChevronUp,
} from 'lucide-react';
import { clsx } from 'clsx';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import CandlestickChart from '@/components/CandlestickChart';
import SignalCard from '@/components/SignalCard';
import { calcIndicators } from '@/lib/indicators';
import type { Candle, IndicatorResult } from '@/lib/indicators';
import type { AISignal } from '@/lib/claudeSignal';
import type { QuoteResult } from '@/lib/yahooClient';

// Server-side proxied quote and history fetchers
async function fetchQuotes(symbols: string[]): Promise<QuoteResult[]> {
  if (!symbols.length) return [];
  try {
    const r = await fetch(`/api/market/quotes?symbols=${encodeURIComponent(symbols.join(','))}`);
    if (!r.ok) return [];
    const data = await r.json() as QuoteResult[];
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

async function fetchHistory(symbol: string) {
  try {
    const r = await fetch(`/api/chart/history?symbol=${encodeURIComponent(symbol)}&resolution=3M`);
    if (!r.ok) return [];
    const data = await r.json() as { candles?: { time: string; open: number; high: number; low: number; close: number; volume: number }[] };
    return data.candles ?? [];
  } catch { return []; }
}

// ── Stock universe ────────────────────────────────────────────────────────────

const US_UNIVERSE = [
  // Large-cap / popular
  'AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD','NFLX','PLTR',
  'COIN','RIVN','LCID','SNAP','SOFI','HOOD','OPEN','JOBY','LILM','LAZR',
  // Mid / volatile
  'F','T','BAC','XOM','CVX','UBER','LYFT','NIO','XPEV','LI',
  // Commonly penny-range
  'SNDL','MMAT','NKLA','RIDE','WKHS','TLRY','ACB','CGC','CLOV','SPCE',
  'SKLZ','ZOM','OBSV','SENS','IDEX','ATOS','FFIE','MULN','CHPT','EVGO',
];

const UK_UNIVERSE = [
  'LLOY.L','BARC.L','VOD.L','BP.L','SHEL.L','AZN.L','GSK.L','HSBA.L',
  'RR.L','NWG.L','BT-A.L','IAG.L','EZJ.L','MKS.L','JD.L','RKT.L',
  'BOO.L','OCDO.L','ITV.L','LAND.L','SBRY.L','WPP.L','STAN.L','DGE.L',
];

const WATCHLIST_KEY = 'penny_scanner_watchlist_v2';

function isPenny(q: QuoteResult): boolean {
  const isUK = q.symbol.endsWith('.L');
  if (isUK) return q.price < 500; // pence
  return q.price < 5;             // USD
}

function spreadPct(q: QuoteResult) {
  const mid = (q.bid + q.ask) / 2;
  return mid > 0 ? ((q.ask - q.bid) / mid * 100).toFixed(2) : '—';
}

// ── Analysis overlay ──────────────────────────────────────────────────────────

function AnalysisPanel({ stock, onClose }: { stock: QuoteResult; onClose: () => void }) {
  const [candles, setCandles]     = useState<Candle[] | null>(null);
  const [indicators, setInd]      = useState<IndicatorResult | null>(null);
  const [aiSignal, setAiSignal]   = useState<AISignal | null>(null);
  const [loading, setLoading]     = useState(true);
  const [aiLoading, setAiLoading] = useState(false);
  const [error, setError]         = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true); setError(null);
      try {
        const candles = await fetchHistory(stock.symbol);
        if (!candles.length) throw new Error('No historical data from Yahoo Finance');
        setCandles(candles);
        if (candles.length >= 20) setInd(calcIndicators(candles));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load chart');
      } finally { setLoading(false); }
    })();
  }, [stock.symbol]);

  // Auto-run AI after candles load
  useEffect(() => {
    if (candles && indicators && !aiSignal && !aiLoading) runAI();
  }, [candles, indicators]); // eslint-disable-line

  async function runAI() {
    if (!candles || candles.length < 20) return;
    setAiLoading(true);
    try {
      const res = await fetch('/api/ig/claude-signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          epic:           stock.symbol,
          instrumentName: stock.name,
          candles,
          bid:            stock.bid,
          offer:          stock.ask,
          percentageChange: stock.changePercent,
          currency:       stock.currency,
        }),
      });
      const data = await res.json() as { ok: boolean; signal?: AISignal; error?: string };
      if (data.ok && data.signal) setAiSignal(data.signal);
      else setError(data.error ?? 'AI signal failed');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'AI error');
    } finally { setAiLoading(false); }
  }

  const ind = indicators?.latest;

  return (
    <div className="fixed inset-0 z-40 bg-gray-950/96 overflow-y-auto">
      <div className="max-w-5xl mx-auto p-4 sm:p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-bold text-white">{stock.name}</h2>
              <span className={clsx('text-sm font-semibold', stock.changePercent >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                {stock.changePercent >= 0 ? '+' : ''}{stock.changePercent.toFixed(2)}%
              </span>
            </div>
            <p className="text-sm text-gray-500 font-mono">{stock.symbol} · {stock.currency} · {stock.price.toFixed(stock.price < 1 ? 4 : 2)}</p>
          </div>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-white bg-gray-800 rounded-lg transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-sm text-red-400 mb-4">{error}</div>}

        {loading && (
          <div className="flex items-center justify-center gap-3 py-20">
            <RefreshCw className="h-6 w-6 text-emerald-400 animate-spin" />
            <span className="text-gray-400">Loading 90 days of price data…</span>
          </div>
        )}

        {candles && indicators && !loading && (
          <div className="space-y-4">
            <Card>
              <CandlestickChart candles={candles} indicators={indicators} height={360} />
            </Card>

            {/* Indicator pills */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'RSI(14)', value: ind?.rsi?.toFixed(1) ?? '—', sub: ind?.rsiZone ?? '', col: ind?.rsiZone === 'oversold' ? 'text-emerald-400' : ind?.rsiZone === 'overbought' ? 'text-red-400' : 'text-gray-300' },
                { label: 'MACD', value: ind?.macdHist?.toFixed(3) ?? '—', sub: ind?.macdZone ?? '', col: ind?.macdZone === 'bullish' ? 'text-emerald-400' : ind?.macdZone === 'bearish' ? 'text-red-400' : 'text-gray-300' },
                { label: 'SMA Cross', value: ind?.smaCross ?? '—', sub: '', col: ind?.smaCross === 'bullish' ? 'text-emerald-400' : ind?.smaCross === 'bearish' ? 'text-red-400' : 'text-gray-400' },
                { label: 'BB', value: ind?.bbPosition ?? '—', sub: '', col: ind?.bbPosition === 'below' ? 'text-emerald-400' : ind?.bbPosition === 'above' ? 'text-red-400' : 'text-gray-300' },
              ].map(({ label, value, sub, col }) => (
                <div key={label} className="bg-gray-800/50 rounded-lg p-3 text-center">
                  <div className="text-xs text-gray-500 mb-1">{label}</div>
                  <div className={clsx('text-base font-bold font-mono capitalize', col)}>{value}</div>
                  {sub && <div className="text-xs text-gray-600 mt-0.5 capitalize">{sub}</div>}
                </div>
              ))}
            </div>

            {aiLoading && (
              <div className="flex items-center justify-center gap-3 py-8">
                <Zap className="h-5 w-5 text-purple-400 animate-pulse" />
                <span className="text-gray-400 text-sm">Generating AI signal via Claude…</span>
              </div>
            )}
            {aiSignal && !aiLoading && (
              <SignalCard signal={aiSignal} instrumentName={stock.name} epic={stock.symbol} />
            )}
            {!aiSignal && !aiLoading && candles.length >= 20 && (
              <Button onClick={runAI} icon={<Zap className="h-4 w-4" />}>Re-run AI Analysis</Button>
            )}
          </div>
        )}

        {candles && candles.length < 20 && !loading && (
          <div className="text-center py-8 text-gray-500 text-sm">
            Not enough historical data for analysis (need at least 20 trading days).
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function PennyScanner() {
  const [market, setMarket]             = useState<'US' | 'UK'>('US');
  const [quotes, setQuotes]             = useState<QuoteResult[]>([]);
  const [scanning, setScanning]         = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [selected, setSelected]         = useState<QuoteResult | null>(null);
  const [watchlist, setWatchlist]       = useState<QuoteResult[]>([]);
  const [searchTicker, setSearchTicker] = useState('');
  const [showFilters, setShowFilters]   = useState(false);
  const [filterChange, setFilterChange] = useState({ min: '', max: '' });
  const [filterPrice,  setFilterPrice]  = useState({ min: '', max: '' });
  const [onlyPenny, setOnlyPenny]       = useState(true);
  const refreshRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load watchlist
  useEffect(() => {
    try {
      const raw = localStorage.getItem(WATCHLIST_KEY);
      if (raw) setWatchlist(JSON.parse(raw) as QuoteResult[]);
    } catch { /* ignore */ }
  }, []);

  function saveWl(list: QuoteResult[]) {
    setWatchlist(list);
    try { localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list)); } catch { /* ignore */ }
  }

  const scan = useCallback(async (symbols?: string[]) => {
    const universe = symbols ?? (market === 'US' ? US_UNIVERSE : UK_UNIVERSE);
    setScanning(true); setError(null);
    try {
      const quotes = await fetchQuotes(universe);
      if (!quotes.length) throw new Error('Could not load market data — please try again in a moment.');
      setQuotes(quotes);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Scan failed');
    } finally { setScanning(false); }
  }, [market]);

  // Auto-refresh watchlist every 30s
  useEffect(() => {
    if (refreshRef.current) clearInterval(refreshRef.current);
    refreshRef.current = setInterval(async () => {
      if (watchlist.length === 0) return;
      try {
        const updated = await fetchQuotes(watchlist.map(w => w.symbol));
        if (updated.length) saveWl(updated);
      } catch { /* ignore */ }
    }, 30_000);
    return () => { if (refreshRef.current) clearInterval(refreshRef.current); };
  }, [watchlist]); // eslint-disable-line

  async function searchAndAdd() {
    const sym = searchTicker.trim().toUpperCase();
    if (!sym) return;
    setScanning(true);
    try {
      const results = await fetchQuotes([sym]);
      if (results[0]) {
        setQuotes(prev => [results[0], ...prev.filter(p => p.symbol !== results[0].symbol)]);
        setSearchTicker('');
      }
    } catch { /* ignore */ }
    finally { setScanning(false); }
  }

  const filtered = quotes.filter(q => {
    if (onlyPenny && !isPenny(q)) return false;
    const mc = filterChange.min !== '' ? q.changePercent >= parseFloat(filterChange.min) : true;
    const xc = filterChange.max !== '' ? q.changePercent <= parseFloat(filterChange.max) : true;
    const mp = filterPrice.min  !== '' ? q.price >= parseFloat(filterPrice.min)  : true;
    const xp = filterPrice.max  !== '' ? q.price <= parseFloat(filterPrice.max)  : true;
    return mc && xc && mp && xp;
  });

  return (
    <div className="space-y-4">
      {selected && <AnalysisPanel stock={selected} onClose={() => setSelected(null)} />}

      {/* Controls */}
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1.5">
            {(['US', 'UK'] as const).map(m => (
              <button key={m} onClick={() => { setMarket(m); setQuotes([]); }}
                className={clsx('px-4 py-1.5 rounded-lg text-sm font-medium border transition-colors',
                  market === m ? 'bg-emerald-600/15 text-emerald-400 border-emerald-600/30' : 'text-gray-400 border-gray-700 hover:border-gray-600'
                )}
              >
                {m === 'US' ? '🇺🇸 US Market' : '🇬🇧 UK Market'}
              </button>
            ))}
          </div>

          <Button onClick={() => scan()} loading={scanning} icon={<Search className="h-4 w-4" />}>
            {scanning ? 'Scanning…' : 'Scan Market'}
          </Button>

          <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
            <input type="checkbox" checked={onlyPenny} onChange={e => setOnlyPenny(e.target.checked)}
              className="rounded border-gray-600 bg-gray-800 text-emerald-500 focus:ring-emerald-500"
            />
            Penny only ({market === 'US' ? '<$5' : '<500p'})
          </label>

          <button onClick={() => setShowFilters(v => !v)}
            className="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-200 transition-colors ml-auto"
          >
            Filters {showFilters ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        </div>

        {showFilters && (
          <div className="mt-4 pt-4 border-t border-gray-800 grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Min % Chg', val: filterChange.min, set: (v: string) => setFilterChange(f => ({ ...f, min: v })), ph: '-5' },
              { label: 'Max % Chg', val: filterChange.max, set: (v: string) => setFilterChange(f => ({ ...f, max: v })), ph: '+5' },
              { label: 'Min Price', val: filterPrice.min,  set: (v: string) => setFilterPrice(f => ({ ...f, min: v })), ph: '0' },
              { label: 'Max Price', val: filterPrice.max,  set: (v: string) => setFilterPrice(f => ({ ...f, max: v })), ph: '5' },
            ].map(({ label, val, set, ph }) => (
              <div key={label}>
                <label className="text-xs text-gray-500 block mb-1">{label}</label>
                <input type="number" placeholder={ph} value={val} onChange={e => set(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-500"
                />
              </div>
            ))}
          </div>
        )}

        {/* Manual ticker add */}
        <div className="mt-4 pt-4 border-t border-gray-800 flex gap-2">
          <input
            type="text" value={searchTicker}
            onChange={e => setSearchTicker(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && searchAndAdd()}
            placeholder="Add ticker e.g. GME, LLOY.L"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 font-mono"
          />
          <Button onClick={searchAndAdd} loading={scanning} icon={<Plus className="h-4 w-4" />}>Add</Button>
        </div>
      </Card>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-sm text-red-400 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" /> {error}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {/* Results table */}
        <div className="xl:col-span-2">
          <Card>
            <CardHeader
              title="Market Results"
              subtitle={filtered.length > 0 ? `${filtered.length} stocks${onlyPenny ? ' (penny filter on)' : ''}` : 'Click Scan Market to load'}
              icon={<BarChart3 className="h-4 w-4" />}
            />
            {filtered.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-gray-500 border-b border-gray-800">
                      <th className="text-left py-2 pr-2 font-medium">Stock</th>
                      <th className="text-right py-2 px-2 font-medium">Price</th>
                      <th className="text-right py-2 px-2 font-medium">% Chg</th>
                      <th className="text-right py-2 px-2 font-medium hidden sm:table-cell">Volume</th>
                      <th className="text-right py-2 px-2 font-medium hidden sm:table-cell">Spread</th>
                      <th className="py-2 pl-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800/60">
                    {filtered.map(q => {
                      const inWl = watchlist.some(w => w.symbol === q.symbol);
                      return (
                        <tr key={q.symbol} className="hover:bg-gray-800/30 transition-colors">
                          <td className="py-2 pr-2">
                            <div className="font-semibold text-white text-xs">{q.symbol}</div>
                            <div className="text-gray-500 text-xs truncate max-w-[140px]">{q.name}</div>
                          </td>
                          <td className="text-right py-2 px-2 font-mono text-sm text-white">
                            {q.currency === 'GBp' ? `${q.price.toFixed(2)}p` : `$${q.price.toFixed(q.price < 1 ? 4 : 2)}`}
                          </td>
                          <td className={clsx('text-right py-2 px-2 font-mono text-sm', q.changePercent >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                            {q.changePercent >= 0 ? '+' : ''}{q.changePercent.toFixed(2)}%
                          </td>
                          <td className="text-right py-2 px-2 text-gray-500 text-xs hidden sm:table-cell">
                            {q.volume > 1_000_000 ? `${(q.volume / 1_000_000).toFixed(1)}M` : q.volume > 1000 ? `${(q.volume / 1000).toFixed(0)}K` : q.volume}
                          </td>
                          <td className="text-right py-2 px-2 text-gray-600 text-xs hidden sm:table-cell">{spreadPct(q)}%</td>
                          <td className="py-2 pl-2">
                            <div className="flex items-center gap-1 justify-end">
                              <button onClick={() => setSelected(q)}
                                className="flex items-center gap-1 text-xs px-2 py-1 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/20 text-purple-400 rounded transition-colors"
                              >
                                <BarChart3 className="h-3 w-3" /> Analyse
                              </button>
                              <button
                                onClick={() => inWl ? saveWl(watchlist.filter(w => w.symbol !== q.symbol)) : saveWl([...watchlist, q])}
                                className={clsx('p-1.5 rounded transition-colors', inWl ? 'text-emerald-400 hover:text-emerald-300' : 'text-gray-600 hover:text-emerald-400')}
                              >
                                {inWl ? <BookmarkCheck className="h-3.5 w-3.5" /> : <BookmarkPlus className="h-3.5 w-3.5" />}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : !scanning ? (
              <div className="py-12 text-center text-gray-600 text-sm space-y-1">
                <BarChart3 className="h-8 w-8 mx-auto mb-3 opacity-30" />
                <p>Click "Scan Market" to fetch {market === 'US' ? 'US' : 'UK'} stock prices from Yahoo Finance</p>
                <p className="text-xs text-gray-700">Or add a ticker manually above</p>
              </div>
            ) : null}
          </Card>
        </div>

        {/* Watchlist */}
        <div>
          <Card>
            <CardHeader
              title="Research Watchlist"
              subtitle={watchlist.length > 0 ? `${watchlist.length} stocks · auto-refreshes 30s` : 'No stocks saved'}
              icon={<BookmarkCheck className="h-4 w-4" />}
            />
            {watchlist.length === 0 ? (
              <p className="text-xs text-gray-600 py-4 text-center">Bookmark stocks from scan results to track them here</p>
            ) : (
              <div className="space-y-1.5">
                {watchlist.map(q => (
                  <div key={q.symbol} className="flex items-center justify-between py-2 px-2 rounded-lg hover:bg-gray-800/40 group">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold text-white">{q.symbol}</span>
                        <span className={clsx('text-xs', q.changePercent >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                          {q.changePercent >= 0 ? '+' : ''}{q.changePercent.toFixed(2)}%
                        </span>
                      </div>
                      <div className="text-xs text-gray-500 truncate">{q.name}</div>
                      <div className="text-xs font-mono text-gray-400">
                        {q.currency === 'GBp' ? `${q.price.toFixed(1)}p` : `$${q.price.toFixed(q.price < 1 ? 4 : 2)}`}
                      </div>
                    </div>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity ml-2 flex-shrink-0">
                      <button onClick={() => setSelected(q)} className="p-1 text-purple-400 hover:text-purple-300">
                        <BarChart3 className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => saveWl(watchlist.filter(w => w.symbol !== q.symbol))} className="p-1 text-gray-500 hover:text-red-400">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

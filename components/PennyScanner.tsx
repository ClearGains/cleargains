'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Search, RefreshCw, TrendingUp, TrendingDown, BarChart3,
  BookmarkPlus, BookmarkCheck, Trash2, Zap, AlertTriangle,
  CheckCircle2, AlertCircle, X, ChevronDown, ChevronUp,
} from 'lucide-react';
import { clsx } from 'clsx';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import CandlestickChart from '@/components/CandlestickChart';
import SignalCard from '@/components/SignalCard';
import { calcIndicators } from '@/lib/indicators';
import type { Candle, IndicatorResult } from '@/lib/indicators';
import type { AISignal } from '@/lib/claudeSignal';

// ── Types ─────────────────────────────────────────────────────────────────────

type IGSession = { cst: string; securityToken: string; apiKey: string };

type ScannedStock = {
  epic:           string;
  instrumentName: string;
  bid:            number;
  offer:          number;
  percentageChange: number;
  high:           number;
  low:            number;
  currency:       'GBP' | 'USD';
};

type StockMarket = 'US' | 'UK';
type FilterState = {
  market:   'ALL' | 'US' | 'UK';
  minChange: string;
  maxChange: string;
  minPrice:  string;
  maxPrice:  string;
};

// Penny stock search terms for scanning
const US_SEARCH_TERMS = ['penny', 'small cap', 'micro cap', 'OTC', 'nano'];
const UK_SEARCH_TERMS = ['AIM', 'small cap', 'micro cap', 'junior'];

function igHeaders(s: IGSession, env: 'demo' | 'live') {
  return { 'x-ig-cst': s.cst, 'x-ig-security-token': s.securityToken, 'x-ig-api-key': s.apiKey, 'x-ig-env': env };
}

function spread(b: number, o: number) {
  const mid = (b + o) / 2;
  return mid > 0 ? ((o - b) / mid * 100).toFixed(2) : '—';
}

function isPenny(stock: ScannedStock): boolean {
  const mid = (stock.bid + stock.offer) / 2;
  if (stock.currency === 'GBP') return mid < 500;
  return mid < 5;
}

// ── Trade modal after signal ───────────────────────────────────────────────────

function TradeFromSignalModal({
  signal, stock, session, env, onClose,
}: {
  signal:  AISignal;
  stock:   ScannedStock;
  session: IGSession;
  env:     'demo' | 'live';
  onClose: () => void;
}) {
  const [size, setSize] = useState('1');
  const [placing, setPlacing]   = useState(false);
  const [result, setResult]     = useState<{ ok: boolean; message: string } | null>(null);

  const direction = signal.signal === 'SELL' ? 'SELL' : 'BUY';

  async function placeTrade() {
    setPlacing(true);
    setResult(null);
    try {
      const sl = signal.stop_loss;
      const lv = signal.take_profit;
      const res = await fetch('/api/ig/order', {
        method: 'POST',
        headers: { ...igHeaders(session, env), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          epic:         stock.epic,
          expiry:       'DFB',
          direction,
          size:         parseFloat(size) || 1,
          orderType:    'MARKET',
          currencyCode: stock.currency,
          stopLevel:    sl,
          limitLevel:   lv,
          forceOpen:    true,
        }),
      });
      const data = await res.json() as { ok: boolean; dealReference?: string; dealStatus?: string; error?: string };
      if (data.ok) {
        setResult({ ok: true, message: `Deal ${data.dealStatus ?? 'submitted'} · ref: ${data.dealReference ?? '—'}` });
      } else {
        setResult({ ok: false, message: data.error ?? 'Order failed' });
      }
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : 'Network error' });
    } finally { setPlacing(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-5 w-full max-w-sm shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-white">Open Trade from Signal</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300"><X className="h-4 w-4" /></button>
        </div>

        <div className="bg-gray-800/60 rounded-lg p-3 mb-4 space-y-1.5 text-sm">
          <div className="flex justify-between"><span className="text-gray-400">Market</span><span className="text-white">{stock.instrumentName}</span></div>
          <div className="flex justify-between"><span className="text-gray-400">Epic</span><span className="text-gray-400 font-mono text-xs">{stock.epic}</span></div>
          <div className="flex justify-between"><span className="text-gray-400">Direction</span><span className={direction === 'BUY' ? 'text-emerald-400 font-semibold' : 'text-red-400 font-semibold'}>{direction}</span></div>
          <div className="flex justify-between"><span className="text-gray-400">Entry</span><span className="text-white font-mono">{signal.entry_point}</span></div>
          <div className="flex justify-between"><span className="text-gray-400">Stop Loss</span><span className="text-red-400 font-mono">{signal.stop_loss}</span></div>
          <div className="flex justify-between"><span className="text-gray-400">Take Profit</span><span className="text-emerald-400 font-mono">{signal.take_profit}</span></div>
          <div className="flex justify-between"><span className="text-gray-400">Env</span><span className={env === 'live' ? 'text-red-400' : 'text-blue-400'}>{env.toUpperCase()}</span></div>
        </div>

        <div className="mb-4">
          <label className="text-xs text-gray-500 block mb-1">Stake (£ per point)</label>
          <input
            type="number" min="0.1" step="0.1" value={size}
            onChange={e => setSize(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
          />
        </div>

        {result && (
          <div className={clsx('flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs mb-4',
            result.ok ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border border-red-500/30 text-red-400'
          )}>
            {result.ok ? <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" /> : <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />}
            {result.message}
          </div>
        )}

        <Button onClick={placeTrade} loading={placing} fullWidth
          className={direction === 'BUY' ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-red-600 hover:bg-red-500'}
        >
          Confirm {direction} Order
        </Button>
      </div>
    </div>
  );
}

// ── Analysis panel ────────────────────────────────────────────────────────────

function AnalysisPanel({
  stock, session, env, onClose,
}: {
  stock:   ScannedStock;
  session: IGSession;
  env:     'demo' | 'live';
  onClose: () => void;
}) {
  const [candles, setCandles]     = useState<Candle[] | null>(null);
  const [indicators, setInd]      = useState<IndicatorResult | null>(null);
  const [aiSignal, setAiSignal]   = useState<AISignal | null>(null);
  const [loading, setLoading]     = useState(true);
  const [aiLoading, setAiLoading] = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [tradeModal, setTradeModal] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/ig/prices?epic=${encodeURIComponent(stock.epic)}&resolution=DAY&max=90`, {
        headers: igHeaders(session, env),
      });
      const data = await res.json() as { ok: boolean; candles?: Candle[]; error?: string };
      if (!data.ok || !data.candles) throw new Error(data.error ?? 'Failed to fetch candles');
      setCandles(data.candles);
      setInd(calcIndicators(data.candles));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load chart data');
    } finally { setLoading(false); }
  }, [stock.epic, session, env]);

  const runAI = useCallback(async () => {
    if (!candles) return;
    setAiLoading(true);
    try {
      const res = await fetch('/api/ig/claude-signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          epic:           stock.epic,
          instrumentName: stock.instrumentName,
          candles,
          bid:            stock.bid,
          offer:          stock.offer,
          percentageChange: stock.percentageChange,
          currency:       stock.currency,
        }),
      });
      const data = await res.json() as { ok: boolean; signal?: AISignal; error?: string };
      if (data.ok && data.signal) setAiSignal(data.signal);
      else setError(data.error ?? 'AI signal failed');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'AI error');
    } finally { setAiLoading(false); }
  }, [candles, stock]);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => { if (candles && !aiSignal) runAI(); }, [candles]); // eslint-disable-line

  const ind = indicators?.latest;

  return (
    <div className="fixed inset-0 z-40 bg-gray-950/95 overflow-y-auto">
      <div className="max-w-5xl mx-auto p-4 sm:p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-xl font-bold text-white">{stock.instrumentName}</h2>
            <p className="text-sm text-gray-500 font-mono">{stock.epic} · {stock.currency}</p>
          </div>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-white bg-gray-800 rounded-lg">
            <X className="h-5 w-5" />
          </button>
        </div>

        {loading && (
          <div className="flex items-center gap-3 py-16 justify-center">
            <RefreshCw className="h-6 w-6 text-emerald-400 animate-spin" />
            <span className="text-gray-400">Loading 90 days of price data…</span>
          </div>
        )}

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-sm text-red-400 mb-4">
            {error}
          </div>
        )}

        {candles && indicators && !loading && (
          <div className="space-y-4">
            {/* Chart */}
            <Card>
              <CandlestickChart candles={candles} indicators={indicators} height={380} />
            </Card>

            {/* Indicator summary */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'RSI(14)', value: ind?.rsi?.toFixed(1) ?? '—', note: ind?.rsiZone ?? '', color: ind?.rsiZone === 'oversold' ? 'text-emerald-400' : ind?.rsiZone === 'overbought' ? 'text-red-400' : 'text-gray-300' },
                { label: 'MACD', value: ind?.macdHist?.toFixed(4) ?? '—', note: ind?.macdZone ?? '', color: ind?.macdZone === 'bullish' ? 'text-emerald-400' : ind?.macdZone === 'bearish' ? 'text-red-400' : 'text-gray-300' },
                { label: 'SMA Cross', value: ind?.smaCross ?? '—', note: '', color: ind?.smaCross === 'bullish' ? 'text-emerald-400' : ind?.smaCross === 'bearish' ? 'text-red-400' : 'text-gray-400' },
                { label: 'BB Position', value: ind?.bbPosition ?? '—', note: '', color: ind?.bbPosition === 'below' ? 'text-emerald-400' : ind?.bbPosition === 'above' ? 'text-red-400' : 'text-gray-300' },
              ].map(({ label, value, note, color }) => (
                <div key={label} className="bg-gray-800/50 rounded-lg p-3 text-center">
                  <div className="text-xs text-gray-500 mb-1">{label}</div>
                  <div className={clsx('text-lg font-bold font-mono', color)}>{value}</div>
                  {note && <div className="text-xs text-gray-600 mt-0.5 capitalize">{note}</div>}
                </div>
              ))}
            </div>

            {/* AI Signal */}
            {aiLoading && (
              <div className="flex items-center gap-3 py-8 justify-center">
                <Zap className="h-5 w-5 text-purple-400 animate-pulse" />
                <span className="text-gray-400 text-sm">Generating AI signal…</span>
              </div>
            )}
            {aiSignal && !aiLoading && (
              <SignalCard
                signal={aiSignal}
                instrumentName={stock.instrumentName}
                epic={stock.epic}
                onOpenTrade={() => setTradeModal(true)}
              />
            )}
            {!aiSignal && !aiLoading && (
              <Button onClick={runAI} icon={<Zap className="h-4 w-4" />}>
                Generate AI Signal
              </Button>
            )}
          </div>
        )}
      </div>

      {tradeModal && aiSignal && (
        <TradeFromSignalModal
          signal={aiSignal} stock={stock}
          session={session} env={env}
          onClose={() => setTradeModal(false)}
        />
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

interface Props {
  session: IGSession | null;
  env:     'demo' | 'live';
  onConnect: () => void;
}

const WATCHLIST_KEY = 'penny_scanner_watchlist';

export default function PennyScanner({ session, env, onConnect }: Props) {
  const [market, setMarket]         = useState<StockMarket>('US');
  const [scanning, setScanning]     = useState(false);
  const [results, setResults]       = useState<ScannedStock[]>([]);
  const [error, setError]           = useState<string | null>(null);
  const [filter, setFilter]         = useState<FilterState>({ market: 'ALL', minChange: '', maxChange: '', minPrice: '', maxPrice: '' });
  const [selected, setSelected]     = useState<ScannedStock | null>(null);
  const [watchlist, setWatchlist]   = useState<ScannedStock[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  const refreshRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load watchlist from localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem(WATCHLIST_KEY);
      if (raw) setWatchlist(JSON.parse(raw) as ScannedStock[]);
    } catch { /* ignore */ }
  }, []);

  const addToWatchlist = useCallback((s: ScannedStock) => {
    setWatchlist(prev => {
      if (prev.find(w => w.epic === s.epic)) return prev;
      const next = [...prev, s];
      try { localStorage.setItem(WATCHLIST_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const removeFromWatchlist = useCallback((epic: string) => {
    setWatchlist(prev => {
      const next = prev.filter(w => w.epic !== epic);
      localStorage.setItem(WATCHLIST_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const fetchPrice = useCallback(async (epic: string): Promise<Partial<ScannedStock>> => {
    if (!session) return {};
    try {
      const res = await fetch(`/api/ig/price?epic=${encodeURIComponent(epic)}`, {
        headers: igHeaders(session, env),
      });
      const data = await res.json() as { ok: boolean; bid?: number; offer?: number; percentageChange?: number; high?: number; low?: number };
      if (data.ok) return { bid: data.bid ?? 0, offer: data.offer ?? 0, percentageChange: data.percentageChange ?? 0, high: data.high ?? 0, low: data.low ?? 0 };
    } catch { /* ignore */ }
    return {};
  }, [session, env]);

  const scan = useCallback(async () => {
    if (!session) return;
    setScanning(true); setError(null); setResults([]);
    const terms = market === 'US' ? US_SEARCH_TERMS : UK_SEARCH_TERMS;
    const seen = new Set<string>();
    const found: ScannedStock[] = [];

    for (const term of terms) {
      try {
        const res = await fetch(`/api/ig/markets?q=${encodeURIComponent(term)}`, {
          headers: igHeaders(session, env),
        });
        const data = await res.json() as { ok: boolean; markets?: Array<{ epic: string; instrumentName: string; instrumentType: string }> };
        if (!data.ok || !data.markets) continue;
        const shares = data.markets.filter(m => m.instrumentType === 'SHARES');
        for (const m of shares) {
          if (seen.has(m.epic)) continue;
          seen.add(m.epic);
          const price = await fetchPrice(m.epic);
          if (!price.bid || !price.offer) continue;
          const stock: ScannedStock = {
            epic:             m.epic,
            instrumentName:   m.instrumentName,
            bid:              price.bid,
            offer:            price.offer,
            percentageChange: price.percentageChange ?? 0,
            high:             price.high ?? 0,
            low:              price.low ?? 0,
            currency:         market === 'UK' ? 'GBP' : 'USD',
          };
          if (isPenny(stock)) found.push(stock);
          if (found.length >= 50) break;
        }
        if (found.length >= 50) break;
      } catch { /* ignore */ }
    }

    setResults(found);
    if (found.length === 0) setError('No penny stocks found. Try switching market or check your IG session.');
    setScanning(false);
  }, [session, env, market, fetchPrice]);

  // Auto-refresh watchlist prices every 30 s
  useEffect(() => {
    if (refreshRef.current) clearInterval(refreshRef.current);
    refreshRef.current = setInterval(async () => {
      if (!session || watchlist.length === 0) return;
      const updated = await Promise.all(
        watchlist.map(async s => {
          const p = await fetchPrice(s.epic);
          return { ...s, ...p };
        })
      );
      setWatchlist(updated);
    }, 30_000);
    return () => { if (refreshRef.current) clearInterval(refreshRef.current); };
  }, [session, watchlist, fetchPrice]);

  const filtered = results.filter(s => {
    const mid = (s.bid + s.offer) / 2;
    const mc  = filter.minChange !== '' ? s.percentageChange >= parseFloat(filter.minChange) : true;
    const xc  = filter.maxChange !== '' ? s.percentageChange <= parseFloat(filter.maxChange) : true;
    const mp  = filter.minPrice  !== '' ? mid >= parseFloat(filter.minPrice)  : true;
    const xp  = filter.maxPrice  !== '' ? mid <= parseFloat(filter.maxPrice)  : true;
    return mc && xc && mp && xp;
  });

  if (!session) {
    return (
      <Card>
        <div className="py-10 text-center">
          <Search className="h-10 w-10 text-gray-700 mx-auto mb-3" />
          <p className="text-gray-400 text-sm mb-4">Connect your IG account to use the Penny Stock Scanner</p>
          <Button onClick={onConnect}>Connect IG</Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {selected && (
        <AnalysisPanel
          stock={selected} session={session} env={env}
          onClose={() => setSelected(null)}
        />
      )}

      {/* Controls */}
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-2">
            {(['US', 'UK'] as StockMarket[]).map(m => (
              <button
                key={m}
                onClick={() => setMarket(m)}
                className={clsx('px-4 py-1.5 rounded-lg text-sm font-medium border transition-colors',
                  market === m
                    ? 'bg-emerald-600/15 text-emerald-400 border-emerald-600/30'
                    : 'text-gray-400 border-gray-700 hover:border-gray-600'
                )}
              >
                {m === 'US' ? '🇺🇸 US' : '🇬🇧 UK'} {m === 'US' ? '(<$5)' : '(<500p)'}
              </button>
            ))}
          </div>
          <Button onClick={scan} loading={scanning} icon={<Search className="h-4 w-4" />}>
            {scanning ? 'Scanning…' : 'Scan Penny Stocks'}
          </Button>
          <button
            onClick={() => setShowFilters(v => !v)}
            className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors"
          >
            Filters {showFilters ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        </div>

        {showFilters && (
          <div className="mt-4 pt-4 border-t border-gray-800 grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Min % Change', key: 'minChange' as const, placeholder: '-10' },
              { label: 'Max % Change', key: 'maxChange' as const, placeholder: '+10' },
              { label: 'Min Price', key: 'minPrice' as const, placeholder: '0' },
              { label: 'Max Price', key: 'maxPrice' as const, placeholder: '5' },
            ].map(({ label, key, placeholder }) => (
              <div key={key}>
                <label className="text-xs text-gray-500 block mb-1">{label}</label>
                <input
                  type="number" placeholder={placeholder} value={filter[key]}
                  onChange={e => setFilter(f => ({ ...f, [key]: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-500"
                />
              </div>
            ))}
          </div>
        )}
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
              title="Penny Stocks"
              subtitle={filtered.length > 0 ? `${filtered.length} results` : 'Run a scan above'}
              icon={<BarChart3 className="h-4 w-4" />}
            />
            {filtered.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-gray-500 border-b border-gray-800">
                      <th className="text-left py-2 pr-3 font-medium">Name</th>
                      <th className="text-right py-2 px-2 font-medium">Bid</th>
                      <th className="text-right py-2 px-2 font-medium">Offer</th>
                      <th className="text-right py-2 px-2 font-medium">% Chg</th>
                      <th className="text-right py-2 px-2 font-medium">Spread%</th>
                      <th className="py-2 pl-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {filtered.map(s => {
                      const inWl = watchlist.some(w => w.epic === s.epic);
                      return (
                        <tr key={s.epic} className="hover:bg-gray-800/40 transition-colors">
                          <td className="py-2 pr-3">
                            <div className="font-medium text-white text-xs leading-tight">{s.instrumentName}</div>
                            <div className="text-gray-600 font-mono text-xs">{s.epic}</div>
                          </td>
                          <td className="text-right py-2 px-2 font-mono text-sm text-red-400">{s.bid}</td>
                          <td className="text-right py-2 px-2 font-mono text-sm text-emerald-400">{s.offer}</td>
                          <td className={clsx('text-right py-2 px-2 font-mono text-sm', s.percentageChange >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                            {s.percentageChange >= 0 ? '+' : ''}{s.percentageChange.toFixed(2)}%
                          </td>
                          <td className="text-right py-2 px-2 text-gray-500 text-xs">{spread(s.bid, s.offer)}%</td>
                          <td className="py-2 pl-2">
                            <div className="flex items-center gap-1 justify-end">
                              <button
                                onClick={() => setSelected(s)}
                                className="flex items-center gap-1 text-xs px-2 py-1 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/20 text-purple-400 rounded transition-colors"
                              >
                                <BarChart3 className="h-3 w-3" /> Analyse
                              </button>
                              <button
                                onClick={() => inWl ? removeFromWatchlist(s.epic) : addToWatchlist(s)}
                                className={clsx('p-1.5 rounded transition-colors',
                                  inWl ? 'text-emerald-400 hover:text-emerald-300' : 'text-gray-600 hover:text-emerald-400'
                                )}
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
            )}
            {filtered.length === 0 && !scanning && results.length === 0 && (
              <div className="py-10 text-center text-gray-600 text-sm">
                Click "Scan Penny Stocks" to search the IG market database
              </div>
            )}
          </Card>
        </div>

        {/* Watchlist */}
        <div>
          <Card>
            <CardHeader
              title="Watchlist"
              subtitle={watchlist.length > 0 ? `${watchlist.length} stocks · refreshes every 30s` : 'No stocks saved'}
              icon={<BookmarkCheck className="h-4 w-4" />}
            />
            {watchlist.length === 0 ? (
              <p className="text-xs text-gray-600 py-4 text-center">Click the bookmark icon to save stocks here</p>
            ) : (
              <div className="space-y-2">
                {watchlist.map(s => (
                  <div key={s.epic} className="flex items-center justify-between py-2 px-2 rounded-lg hover:bg-gray-800/50 group">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-white truncate">{s.instrumentName}</div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="font-mono text-xs text-gray-400">{s.bid} / {s.offer}</span>
                        <span className={clsx('text-xs font-mono', s.percentageChange >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                          {s.percentageChange >= 0 ? '+' : ''}{s.percentageChange.toFixed(2)}%
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity ml-2 flex-shrink-0">
                      <button onClick={() => setSelected(s)} className="p-1 text-purple-400 hover:text-purple-300">
                        <BarChart3 className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => removeFromWatchlist(s.epic)} className="p-1 text-gray-500 hover:text-red-400">
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

      <div className="text-xs text-gray-600 flex items-center gap-1.5">
        <AlertTriangle className="h-3 w-3" />
        Penny stocks carry significant risk. AI signals are for educational purposes only — not financial advice.
      </div>
    </div>
  );
}

'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  Search, RefreshCw, TrendingUp, TrendingDown,
  ArrowUpDown, Scale, BarChart2, AlertTriangle, ChevronUp, ChevronDown,
} from 'lucide-react';
import { clsx } from 'clsx';
import type { DepthData, SRLevel } from '@/app/api/market/depth/route';

type SearchResult = { symbol: string; name: string; exchange: string; type: string };

function fmtPrice(n: number, currency = 'USD') {
  const sym = currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : '$';
  return `${sym}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}
function fmtNum(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}
function fmtPct(n: number) { return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }

function BarSplit({ leftPct, leftLabel, rightLabel, leftColor, rightColor }: {
  leftPct: number; leftLabel: string; rightLabel: string;
  leftColor: string; rightColor: string;
}) {
  const rPct = 100 - leftPct;
  return (
    <div className="space-y-1.5">
      <div className="flex rounded-full overflow-hidden h-4">
        <div className={clsx('transition-all duration-700', leftColor)} style={{ width: `${leftPct}%` }} />
        <div className={clsx('transition-all duration-700', rightColor)} style={{ width: `${rPct}%` }} />
      </div>
      <div className="flex justify-between text-xs font-semibold">
        <span className={leftColor.includes('emerald') ? 'text-emerald-400' : 'text-blue-400'}>
          {leftLabel} {leftPct.toFixed(1)}%
        </span>
        <span className={rightColor.includes('red') ? 'text-red-400' : 'text-orange-400'}>
          {rightLabel} {rPct.toFixed(1)}%
        </span>
      </div>
    </div>
  );
}

function LevelRow({ level, price }: { level: SRLevel; price: number }) {
  const isRes   = level.type === 'resistance';
  const distPct = ((level.price - price) / price) * 100;
  const stars   = Math.min(level.strength, 5);

  return (
    <div className={clsx(
      'flex items-center gap-3 px-3 py-2.5 rounded-lg border text-sm',
      isRes
        ? 'border-red-500/20 bg-red-950/20'
        : 'border-emerald-500/20 bg-emerald-950/20',
    )}>
      <div className="flex-shrink-0">
        {isRes
          ? <ChevronUp   className="h-4 w-4 text-red-400" />
          : <ChevronDown className="h-4 w-4 text-emerald-400" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-bold text-white">{fmtPrice(level.price)}</span>
          <span className={clsx('text-[10px] font-semibold px-1.5 py-0.5 rounded',
            isRes ? 'bg-red-500/15 text-red-400' : 'bg-emerald-500/15 text-emerald-400')}>
            {isRes ? 'RESISTANCE' : 'SUPPORT'}
          </span>
          <span className="text-gray-500 text-xs">
            {distPct > 0 ? `+${distPct.toFixed(1)}%` : `${distPct.toFixed(1)}%`} away
          </span>
        </div>
        <p className="text-xs text-gray-500 mt-0.5 truncate">{level.note}</p>
      </div>
      <div className="flex gap-0.5 flex-shrink-0">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className={clsx('w-1.5 h-4 rounded-sm',
            i < stars
              ? isRes ? 'bg-red-400' : 'bg-emerald-400'
              : 'bg-gray-700'
          )} />
        ))}
      </div>
    </div>
  );
}

export function MarketDepth() {
  const [query,       setQuery]       = useState('');
  const [symbol,      setSymbol]      = useState('');
  const [data,        setData]        = useState<DepthData | null>(null);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState('');
  const [suggestions, setSuggestions] = useState<SearchResult[]>([]);
  const [showDrop,    setShowDrop]    = useState(false);
  const [searchBusy,  setSearchBusy]  = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapRef     = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setShowDrop(false);
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, []);

  // Debounced search-as-you-type
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < 2) { setSuggestions([]); setShowDrop(false); return; }
    debounceRef.current = setTimeout(async () => {
      setSearchBusy(true);
      try {
        const res = await fetch(`/api/chart/search?q=${encodeURIComponent(q)}`);
        const results = await res.json() as SearchResult[];
        setSuggestions(results);
        setShowDrop(results.length > 0);
      } catch { setSuggestions([]); }
      finally { setSearchBusy(false); }
    }, 300);
  }, [query]);

  const fetchDepth = useCallback(async (sym: string, force = false) => {
    const s = sym.toUpperCase().trim();
    if (!s) return;
    setLoading(true); setError(''); setShowDrop(false);
    try {
      const res = await fetch(`/api/market/depth?symbol=${encodeURIComponent(s)}${force ? '&force=1' : ''}`);
      const json = await res.json() as DepthData & { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json);
      setSymbol(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) void fetchDepth(query);
  };

  const selectSuggestion = (r: SearchResult) => {
    setQuery(r.symbol);
    setSuggestions([]);
    setShowDrop(false);
    void fetchDepth(r.symbol);
  };

  // Derived values
  const bidPct = data?.bidSize != null && data.askSize != null && (data.bidSize + data.askSize) > 0
    ? (data.bidSize / (data.bidSize + data.askSize)) * 100 : null;
  const callPct = data?.callVolume != null && data.putVolume != null && (data.callVolume + data.putVolume) > 0
    ? (data.callVolume / (data.callVolume + data.putVolume)) * 100 : null;
  const callOIPct = data?.callOI != null && data.putOI != null && (data.callOI + data.putOI) > 0
    ? (data.callOI / (data.callOI + data.putOI)) * 100 : null;

  const resistance = data?.levels.filter(l => l.type === 'resistance')
    .sort((a, b) => a.price - b.price) ?? [];
  const support    = data?.levels.filter(l => l.type === 'support')
    .sort((a, b) => b.price - a.price) ?? [];

  const isPositive = (data?.changePercent ?? 0) >= 0;

  const pcrSentiment = data?.putCallRatio == null ? null
    : data.putCallRatio < 0.7  ? { label: 'Strongly Bullish', color: 'text-emerald-400' }
    : data.putCallRatio < 0.9  ? { label: 'Bullish', color: 'text-emerald-400' }
    : data.putCallRatio < 1.1  ? { label: 'Neutral', color: 'text-yellow-400' }
    : data.putCallRatio < 1.3  ? { label: 'Bearish', color: 'text-red-400' }
    : { label: 'Strongly Bearish', color: 'text-red-400' };

  return (
    <div className="space-y-6">

      {/* Search */}
      <form onSubmit={handleSearch} className="flex gap-2">
        <div className="relative flex-1" ref={wrapRef}>
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500 z-10" />
          {searchBusy && (
            <RefreshCw className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-500 animate-spin z-10" />
          )}
          <input
            type="text"
            value={query}
            onChange={e => { setQuery(e.target.value); setShowDrop(true); }}
            onFocus={() => suggestions.length > 0 && setShowDrop(true)}
            placeholder="Ticker or name — e.g. AAPL, Apple, FTSE, GBP/USD"
            className="w-full pl-9 pr-4 py-2.5 bg-gray-900 border border-gray-700 rounded-xl text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 transition"
          />
          {showDrop && suggestions.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-gray-900 border border-gray-700 rounded-xl shadow-xl z-50 overflow-hidden max-h-60 overflow-y-auto">
              {suggestions.map(r => (
                <button
                  key={r.symbol}
                  type="button"
                  onClick={() => selectSuggestion(r)}
                  className="w-full flex items-center justify-between px-3 py-2 text-left text-sm hover:bg-gray-800 transition"
                >
                  <div>
                    <span className="font-semibold text-white">{r.symbol}</span>
                    <span className="text-gray-400 ml-2 text-xs">{r.name}</span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 ml-2">
                    <span className="text-[10px] text-gray-500">{r.exchange}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-400">{r.type}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold disabled:opacity-50 transition"
        >
          {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : 'Search'}
        </button>
        {data && (
          <button
            type="button"
            onClick={() => void fetchDepth(symbol, true)}
            disabled={loading}
            className="px-3 py-2.5 rounded-xl bg-gray-800 text-gray-400 hover:text-gray-200 border border-gray-700 transition disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw className={clsx('h-4 w-4', loading && 'animate-spin')} />
          </button>
        )}
      </form>

      {/* Error */}
      {error && (
        <div className="bg-red-950/30 border border-red-500/30 rounded-xl p-4 flex items-center gap-2 text-sm text-red-400">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Empty state */}
      {!data && !loading && !error && (
        <div className="text-center py-20 text-gray-600">
          <Scale className="h-12 w-12 mx-auto mb-4 opacity-20" />
          <p className="font-medium text-gray-500">Search by name or ticker</p>
          <p className="text-sm mt-1">Type a company name, index, or ticker — e.g. "Apple", "AAPL", "FTSE", "GBP/USD"</p>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !data && (
        <div className="space-y-4 animate-pulse">
          <div className="h-24 bg-gray-900 rounded-xl border border-gray-800" />
          <div className="h-40 bg-gray-900 rounded-xl border border-gray-800" />
          <div className="h-40 bg-gray-900 rounded-xl border border-gray-800" />
        </div>
      )}

      {data && (
        <div className="space-y-5">

          {/* Stock header */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center justify-between gap-4 flex-wrap">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-2xl font-bold text-white">{data.symbol}</span>
                <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded">{data.exchange}</span>
              </div>
              <p className="text-sm text-gray-400 mt-0.5">{data.name}</p>
              <p className="text-[11px] text-gray-600 mt-0.5">
                Updated {new Date(data.scannedAt).toLocaleTimeString()}
              </p>
            </div>
            <div className="text-right">
              <div className="text-3xl font-bold text-white">{fmtPrice(data.price, data.currency)}</div>
              <div className={clsx('flex items-center justify-end gap-1 text-base font-semibold mt-0.5',
                isPositive ? 'text-emerald-400' : 'text-red-400')}>
                {isPositive ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                {fmtPct(data.changePercent)} today
              </div>
            </div>
          </div>

          {/* ── SECTION 1: Order Book (Bid vs Ask) ── */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
            <div className="flex items-center gap-2">
              <ArrowUpDown className="h-4 w-4 text-blue-400" />
              <h2 className="text-sm font-bold text-white uppercase tracking-wide">Best Bid vs Best Ask</h2>
              <span className="text-[10px] text-gray-500">(L1 order book — top of book only)</span>
            </div>

            <div className="grid grid-cols-3 gap-3 text-center">
              {/* Bid */}
              <div className="bg-emerald-950/30 border border-emerald-500/20 rounded-xl p-4">
                <div className="text-[10px] text-emerald-500 uppercase tracking-widest font-semibold mb-1">
                  Best Bid (Buyers offering)
                </div>
                <div className="text-2xl font-bold text-emerald-400">
                  {data.bid != null ? fmtPrice(data.bid, data.currency) : '—'}
                </div>
                {data.bidSize != null && (
                  <div className="text-xs text-gray-500 mt-1">{fmtNum(data.bidSize)} shares</div>
                )}
              </div>

              {/* Spread */}
              <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-4 flex flex-col items-center justify-center">
                <div className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold mb-1">Spread</div>
                <div className="text-lg font-bold text-white">
                  {data.spread != null ? fmtPrice(data.spread, data.currency) : '—'}
                </div>
                {data.spreadPct != null && (
                  <div className="text-xs text-gray-500 mt-1">{data.spreadPct.toFixed(3)}%</div>
                )}
                <div className="text-[10px] text-gray-600 mt-1">cost to trade</div>
              </div>

              {/* Ask */}
              <div className="bg-red-950/30 border border-red-500/20 rounded-xl p-4">
                <div className="text-[10px] text-red-400 uppercase tracking-widest font-semibold mb-1">
                  Best Ask (Sellers wanting)
                </div>
                <div className="text-2xl font-bold text-red-400">
                  {data.ask != null ? fmtPrice(data.ask, data.currency) : '—'}
                </div>
                {data.askSize != null && (
                  <div className="text-xs text-gray-500 mt-1">{fmtNum(data.askSize)} shares</div>
                )}
              </div>
            </div>

            {bidPct != null && (
              <div className="space-y-1.5">
                <div className="text-xs text-gray-500">Immediate buying vs selling pressure at top of book</div>
                <BarSplit
                  leftPct={bidPct}
                  leftLabel="Buy side"
                  rightLabel="Sell side"
                  leftColor="bg-emerald-500"
                  rightColor="bg-red-500"
                />
              </div>
            )}

            {data.bid == null && data.ask == null && (
              <p className="text-xs text-gray-500 text-center py-2">
                Bid/ask data not available — market may be closed or this stock has no live quote
              </p>
            )}
          </div>

          {/* ── SECTION 2: Options Bets ── */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <Scale className="h-4 w-4 text-purple-400" />
                <h2 className="text-sm font-bold text-white uppercase tracking-wide">Options Market — Directional Bets</h2>
              </div>
              {data.nearestExpiry && (
                <span className="text-[11px] text-gray-500">Nearest expiries incl. {data.nearestExpiry}</span>
              )}
            </div>

            {data.callVolume == null && data.putVolume == null ? (
              <div className="text-center py-6 text-gray-500 text-sm">
                <BarChart2 className="h-8 w-8 mx-auto mb-2 opacity-20" />
                <p>No options data available</p>
                <p className="text-xs mt-1">Options data is only available for US-listed stocks</p>
              </div>
            ) : (
              <>
                {/* Today's Volume */}
                {callPct != null && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-gray-400 font-semibold">TODAY'S VOLUME (active bets placed today)</span>
                      {pcrSentiment && data.putCallRatio != null && (
                        <span className={clsx('text-xs font-bold', pcrSentiment.color)}>
                          PCR {data.putCallRatio.toFixed(2)} — {pcrSentiment.label}
                        </span>
                      )}
                    </div>
                    <BarSplit
                      leftPct={callPct}
                      leftLabel={`Calls (bullish) ${data.callVolume != null ? fmtNum(data.callVolume) : ''}`}
                      rightLabel={`Puts (bearish) ${data.putVolume != null ? fmtNum(data.putVolume) : ''}`}
                      leftColor="bg-emerald-500"
                      rightColor="bg-red-500"
                    />
                    <p className="text-[11px] text-gray-600">
                      Put/Call Ratio below 0.7 = bullish sentiment · above 1.2 = bearish sentiment · 0.7–1.2 = neutral
                    </p>
                  </div>
                )}

                {/* Open Interest */}
                {callOIPct != null && (
                  <div className="space-y-2 pt-2 border-t border-gray-800">
                    <span className="text-xs text-gray-400 font-semibold">OPEN INTEREST (all outstanding positions)</span>
                    <BarSplit
                      leftPct={callOIPct}
                      leftLabel={`Call OI ${data.callOI != null ? fmtNum(data.callOI) : ''}`}
                      rightLabel={`Put OI ${data.putOI != null ? fmtNum(data.putOI) : ''}`}
                      leftColor="bg-blue-500"
                      rightColor="bg-orange-500"
                    />
                    <p className="text-[11px] text-gray-600">
                      Open interest shows total money parked in each direction — high put OI near a price = strong floor (put wall)
                    </p>
                  </div>
                )}
              </>
            )}
          </div>

          {/* ── SECTION 3: Key Price Levels ── */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
            <div className="flex items-center gap-2">
              <BarChart2 className="h-4 w-4 text-yellow-400" />
              <h2 className="text-sm font-bold text-white uppercase tracking-wide">Key Price Levels</h2>
              <span className="text-[10px] text-gray-500">(from 6 months of candle data + moving averages)</span>
            </div>

            {data.levels.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-4">Not enough candle data to compute price levels</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">

                {/* Resistance */}
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-red-400 uppercase tracking-wide">
                    <ChevronUp className="h-3.5 w-3.5" />
                    Resistance — where people avoid / sell
                  </div>
                  {resistance.length === 0 && (
                    <p className="text-xs text-gray-600 py-2">No resistance zones found above current price</p>
                  )}
                  {resistance.map((l, i) => (
                    <LevelRow key={i} level={l} price={data.price} />
                  ))}
                </div>

                {/* Current price marker */}
                <div className="hidden md:flex col-span-full items-center gap-3 py-1">
                  <div className="flex-1 h-px bg-blue-500/30" />
                  <span className="text-sm font-bold text-blue-400 flex-shrink-0">
                    ▶ {fmtPrice(data.price, data.currency)} current price
                  </span>
                  <div className="flex-1 h-px bg-blue-500/30" />
                </div>

                {/* Support */}
                <div className="space-y-2 md:col-start-1">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-400 uppercase tracking-wide">
                    <ChevronDown className="h-3.5 w-3.5" />
                    Support — where buyers step in
                  </div>
                  {support.length === 0 && (
                    <p className="text-xs text-gray-600 py-2">No support zones found below current price</p>
                  )}
                  {support.map((l, i) => (
                    <LevelRow key={i} level={l} price={data.price} />
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Disclaimer */}
          <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-4 text-xs text-gray-500 leading-relaxed">
            <strong className="text-gray-400">Data note:</strong> Bid/ask shows the best available price only — not the full
            order book depth. Options data covers the nearest expiry dates. Support/resistance levels are calculated from
            6 months of daily candle highs/lows and moving averages. All data is from Yahoo Finance and is delayed.
          </div>
        </div>
      )}
    </div>
  );
}

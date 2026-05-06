'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, TrendingUp, TrendingDown, Zap, AlertCircle, BarChart2, Clock } from 'lucide-react';
import { clsx } from 'clsx';
import type { Mover } from '@/app/api/market/movers/route';
import type { PredictedMover } from '@/app/api/market/predicted/route';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPrice(price: number, currency: string) {
  if (currency === 'GBp') return `${price.toFixed(1)}p`;
  return `$${price.toLocaleString(undefined, { maximumFractionDigits: price < 1 ? 4 : 2 })}`;
}

function fmtVol(v: number) {
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000)     return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)         return `${(v / 1_000).toFixed(0)}K`;
  return v.toString();
}

function fmtCap(v?: number) {
  if (!v) return '—';
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9)  return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6)  return `$${(v / 1e6).toFixed(0)}M`;
  return `$${v}`;
}

const SIGNAL_STYLE: Record<string, { bg: string; text: string; label: string }> = {
  STRONG_BUY:  { bg: 'bg-emerald-500/20 border-emerald-500/40', text: 'text-emerald-400', label: 'STRONG BUY'  },
  BUY:         { bg: 'bg-emerald-500/10 border-emerald-500/20', text: 'text-emerald-500', label: 'BUY'         },
  WATCH:       { bg: 'bg-amber-500/10  border-amber-500/20',   text: 'text-amber-400',   label: 'WATCH'        },
  SELL:        { bg: 'bg-red-500/10    border-red-500/20',     text: 'text-red-500',     label: 'SELL'         },
  STRONG_SELL: { bg: 'bg-red-500/20    border-red-500/40',     text: 'text-red-400',     label: 'STRONG SELL'  },
};

// ── Mover row ─────────────────────────────────────────────────────────────────

function MoverRow({ q, showSignal }: { q: Mover & Partial<PredictedMover>; showSignal?: boolean }) {
  const sig = showSignal && q.signal ? SIGNAL_STYLE[q.signal] : null;

  return (
    <tr className="border-b border-gray-800/50 hover:bg-gray-800/20 transition-colors">
      <td className="py-3 pr-3">
        <div className="font-bold text-white text-sm font-mono">{q.symbol}</div>
        <div className="text-gray-500 text-xs truncate max-w-[160px]">{q.name}</div>
      </td>
      <td className="py-3 px-2 text-right font-mono text-sm text-white">
        {fmtPrice(q.price, q.currency)}
      </td>
      <td className={clsx('py-3 px-2 text-right font-mono text-sm font-semibold', q.changePercent >= 0 ? 'text-emerald-400' : 'text-red-400')}>
        {q.changePercent >= 0 ? '+' : ''}{q.changePercent.toFixed(2)}%
      </td>
      <td className="py-3 px-2 text-right text-xs text-gray-500 hidden sm:table-cell">
        {fmtVol(q.volume)}
        {q.volumeRatio > 1.5 && (
          <span className="ml-1 text-amber-500 font-semibold">{q.volumeRatio.toFixed(1)}×</span>
        )}
      </td>
      <td className="py-3 px-2 text-right text-xs text-gray-600 hidden md:table-cell">
        {fmtCap(q.marketCap)}
      </td>
      <td className="py-3 pl-2 text-right hidden lg:table-cell">
        <div className="flex items-center justify-end gap-1 text-[10px]">
          <span className={clsx('w-2 h-2 rounded-full', q.aboveSma50 ? 'bg-emerald-500' : 'bg-red-500')} title="vs SMA50" />
          <span className={clsx('w-2 h-2 rounded-full', q.aboveSma200 ? 'bg-emerald-500' : 'bg-red-500')} title="vs SMA200" />
          <span className={clsx('text-[10px]', q.goldenCross ? 'text-emerald-600' : 'text-red-600')}>
            {q.goldenCross ? 'GC' : 'DC'}
          </span>
        </div>
      </td>
      {showSignal && (
        <td className="py-3 pl-2">
          {sig && (
            <span className={clsx('text-[10px] font-bold px-2 py-0.5 rounded border', sig.bg, sig.text)}>
              {sig.label}
            </span>
          )}
        </td>
      )}
    </tr>
  );
}

function MoverTable({ rows, showSignal, loading, error }: {
  rows: (Mover & Partial<PredictedMover>)[];
  showSignal?: boolean;
  loading: boolean;
  error: string;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-gray-500">
        <RefreshCw className="h-4 w-4 animate-spin" />
        <span className="text-sm">Loading…</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 bg-red-950/20 border border-red-900/30 rounded-lg m-4">
        <AlertCircle className="h-4 w-4 text-red-400 shrink-0" />
        <p className="text-sm text-red-400">{error}</p>
      </div>
    );
  }
  if (!rows.length) return <p className="text-center text-gray-600 text-sm py-12">No data — click refresh</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[10px] text-gray-500 uppercase tracking-wide border-b border-gray-800">
            <th className="text-left py-2 pr-3">Stock</th>
            <th className="text-right py-2 px-2">Price</th>
            <th className="text-right py-2 px-2">Change</th>
            <th className="text-right py-2 px-2 hidden sm:table-cell">Volume</th>
            <th className="text-right py-2 px-2 hidden md:table-cell">Mkt Cap</th>
            <th className="text-right py-2 pl-2 hidden lg:table-cell">Trend</th>
            {showSignal && <th className="py-2 pl-2">Signal</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map(q => <MoverRow key={q.symbol} q={q} showSignal={showSignal} />)}
        </tbody>
      </table>
    </div>
  );
}

// ── Predicted mover card ──────────────────────────────────────────────────────

function PredictedCard({ q }: { q: PredictedMover }) {
  const sig = SIGNAL_STYLE[q.signal];
  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-3 hover:border-gray-700 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-bold text-white font-mono">{q.symbol}</span>
            <span className={clsx('text-xs font-semibold', q.changePercent >= 0 ? 'text-emerald-400' : 'text-red-400')}>
              {q.changePercent >= 0 ? '+' : ''}{q.changePercent.toFixed(2)}%
            </span>
          </div>
          <div className="text-xs text-gray-500 truncate max-w-[200px]">{q.name}</div>
        </div>
        <span className={clsx('text-[10px] font-bold px-2 py-1 rounded border shrink-0', sig.bg, sig.text)}>
          {sig.label}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs font-mono">
        <div className="bg-gray-800/60 rounded p-2">
          <div className="text-gray-500 text-[10px]">Price</div>
          <div className="text-white font-semibold">{fmtPrice(q.price, q.currency)}</div>
        </div>
        <div className="bg-gray-800/60 rounded p-2">
          <div className="text-gray-500 text-[10px]">Volume ratio</div>
          <div className={clsx('font-semibold', q.volumeRatio > 2 ? 'text-amber-400' : 'text-white')}>
            {q.volumeRatio.toFixed(1)}× avg
          </div>
        </div>
        <div className="bg-gray-800/60 rounded p-2">
          <div className="text-gray-500 text-[10px]">From 52w High</div>
          <div className={clsx('font-semibold', q.fromHigh > -10 ? 'text-emerald-400' : 'text-gray-300')}>
            {q.fromHigh.toFixed(1)}%
          </div>
        </div>
        <div className="bg-gray-800/60 rounded p-2">
          <div className="text-gray-500 text-[10px]">From 52w Low</div>
          <div className={clsx('font-semibold', q.fromLow < 10 ? 'text-amber-400' : 'text-gray-300')}>
            +{q.fromLow.toFixed(1)}%
          </div>
        </div>
      </div>

      {q.signalReasons && q.signalReasons.length > 0 && (
        <ul className="space-y-1">
          {q.signalReasons.map((r: string, i: number) => (
            <li key={i} className="flex gap-1.5 text-xs text-gray-400">
              <span className="text-emerald-600 shrink-0 mt-0.5">▸</span>
              {r}
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2 text-[10px] text-gray-600 pt-1 border-t border-gray-800">
        <span className={clsx('flex items-center gap-1', q.goldenCross ? 'text-emerald-600' : 'text-red-600')}>
          {q.goldenCross ? '▲ Golden cross' : '▼ Death cross'}
        </span>
        <span>·</span>
        <span>SMA50: {q.aboveSma50 ? 'above' : 'below'}</span>
        <span>·</span>
        <span>SMA200: {q.aboveSma200 ? 'above' : 'below'}</span>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

type Tab = 'daily' | 'predicted';
type MoverType = 'gainers' | 'losers' | 'active';
type Market = 'US' | 'UK';
type Interval = 15 | 30 | 60 | 1440;

const INTERVAL_LABELS: Record<Interval, string> = { 15: '15 min', 30: '30 min', 60: '1 hour', 1440: 'Daily' };

export function MarketMovers() {
  const [tab,          setTab]          = useState<Tab>('daily');
  const [moverType,    setMoverType]    = useState<MoverType>('gainers');
  const [predMarket,   setPredMarket]   = useState<Market>('US');
  const [interval,     setScanInterval] = useState<Interval>(30);
  const [dailyRows,    setDailyRows]    = useState<Mover[]>([]);
  const [predicted,    setPredicted]    = useState<PredictedMover[]>([]);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [predLoading,  setPredLoading]  = useState(false);
  const [dailyError,   setDailyError]   = useState('');
  const [predError,    setPredError]    = useState('');
  const [lastRefresh,  setLastRefresh]  = useState<Date | null>(null);
  const [countdown,    setCountdown]    = useState<number | null>(null);
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef   = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadDaily = useCallback(async (type: MoverType) => {
    setDailyLoading(true);
    setDailyError('');
    try {
      const r = await fetch(`/api/market/movers?type=${type}`, { cache: 'no-store' });
      const data = await r.json() as Mover[] | { error: string };
      if (!r.ok || 'error' in data) throw new Error('error' in data ? data.error : `HTTP ${r.status}`);
      setDailyRows(data as Mover[]);
      setLastRefresh(new Date());
    } catch (e) {
      setDailyError(e instanceof Error ? e.message : 'Failed to load movers');
    } finally {
      setDailyLoading(false);
    }
  }, []);

  const loadPredicted = useCallback(async (market: Market, iv: Interval) => {
    setPredLoading(true);
    setPredError('');
    try {
      const r = await fetch(`/api/market/predicted?market=${market}&interval=${iv}`, { cache: 'no-store' });
      const data = await r.json() as PredictedMover[] | { error: string };
      if (!r.ok || 'error' in data) throw new Error('error' in data ? data.error : `HTTP ${r.status}`);
      setPredicted(data as PredictedMover[]);
      setLastRefresh(new Date());
    } catch (e) {
      setPredError(e instanceof Error ? e.message : 'Failed to load predictions');
    } finally {
      setPredLoading(false);
    }
  }, []);

  // Auto-refresh daily movers every 30s
  useEffect(() => {
    if (tab !== 'daily') return;
    const t = globalThis.setInterval(() => loadDaily(moverType), 30_000);
    return () => globalThis.clearInterval(t);
  }, [tab, moverType, loadDaily]);

  // Auto-refresh for predicted tab when interval < daily
  useEffect(() => {
    if (tab !== 'predicted' || interval === 1440) {
      if (autoRefreshRef.current) clearInterval(autoRefreshRef.current);
      if (countdownRef.current)   clearInterval(countdownRef.current);
      setCountdown(null);
      return;
    }
    const intervalMs = interval * 60 * 1000;
    setCountdown(interval * 60);

    autoRefreshRef.current = setInterval(() => {
      loadPredicted(predMarket, interval);
      setCountdown(interval * 60);
    }, intervalMs);

    countdownRef.current = setInterval(() => {
      setCountdown(c => (c !== null && c > 0 ? c - 1 : 0));
    }, 1000);

    return () => {
      if (autoRefreshRef.current) clearInterval(autoRefreshRef.current);
      if (countdownRef.current)   clearInterval(countdownRef.current);
    };
  }, [tab, interval, predMarket, loadPredicted]);

  useEffect(() => {
    if (tab === 'daily') loadDaily(moverType);
    else loadPredicted(predMarket, interval);
  }, [tab]); // eslint-disable-line

  return (
    <div className="space-y-4">
      {/* Tab switcher */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex bg-gray-900 border border-gray-800 rounded-lg p-0.5 gap-0.5">
          <button
            onClick={() => { setTab('daily'); loadDaily(moverType); }}
            className={clsx('flex items-center gap-2 px-4 py-2 rounded text-sm font-semibold transition-all', tab === 'daily' ? 'bg-emerald-600 text-white' : 'text-gray-500 hover:text-gray-300')}
          >
            <TrendingUp className="h-4 w-4" /> Daily Movers
          </button>
          <button
            onClick={() => { setTab('predicted'); loadPredicted(predMarket, interval); }}
            className={clsx('flex items-center gap-2 px-4 py-2 rounded text-sm font-semibold transition-all', tab === 'predicted' ? 'bg-purple-600 text-white' : 'text-gray-500 hover:text-gray-300')}
          >
            <Zap className="h-4 w-4" /> Predicted Movers
          </button>
        </div>
        <div className="flex items-center gap-2">
          {lastRefresh && (
            <span className="text-xs text-gray-600">Updated {lastRefresh.toLocaleTimeString()}</span>
          )}
          <button
            onClick={() => tab === 'daily' ? loadDaily(moverType) : loadPredicted(predMarket, interval)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-lg text-xs text-gray-400 transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
      </div>

      {/* Daily movers */}
      {tab === 'daily' && (
        <div className="space-y-3">
          {/* Type selector */}
          <div className="flex gap-2 flex-wrap">
            {([['gainers', '↑ Top Gainers', 'text-emerald-400 border-emerald-600/40 bg-emerald-600/10'],
               ['losers',  '↓ Top Losers',  'text-red-400   border-red-600/40   bg-red-600/10'],
               ['active',  '⚡ Most Active', 'text-amber-400 border-amber-600/40 bg-amber-600/10']] as const
            ).map(([type, label, activeClass]) => (
              <button
                key={type}
                onClick={() => { setMoverType(type); loadDaily(type); }}
                className={clsx('px-3 py-1.5 rounded-lg text-sm font-semibold border transition-all',
                  moverType === type ? activeClass : 'text-gray-500 border-gray-700 hover:border-gray-600'
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
              <BarChart2 className="h-4 w-4 text-gray-500" />
              <span className="text-sm font-semibold text-gray-300 capitalize">{moverType} — US Markets</span>
              <span className="text-xs text-gray-600 ml-auto">Auto-refreshes every 30s · S&P 500 / NASDAQ</span>
            </div>
            <MoverTable rows={dailyRows} loading={dailyLoading} error={dailyError} />
          </div>
        </div>
      )}

      {/* Predicted movers */}
      {tab === 'predicted' && (
        <div className="space-y-3">
          <div className="flex items-start justify-between flex-wrap gap-3">
            <div>
              <div className="flex gap-1.5">
                {(['US', 'UK'] as const).map(m => (
                  <button key={m}
                    onClick={() => { setPredMarket(m); loadPredicted(m, interval); }}
                    className={clsx('px-3 py-1.5 rounded-lg text-sm font-semibold border transition-all',
                      predMarket === m
                        ? 'bg-purple-600/20 text-purple-400 border-purple-600/40'
                        : 'text-gray-500 border-gray-700 hover:border-gray-600'
                    )}
                  >
                    {m === 'US' ? '🇺🇸 US' : '🇬🇧 UK'}
                  </button>
                ))}
              </div>
              {/* Interval selector */}
              <div className="flex items-center gap-1.5 mt-2">
                <Clock className="h-3 w-3 text-gray-600" />
                <span className="text-xs text-gray-600">Refresh every</span>
                {([15, 30, 60, 1440] as Interval[]).map(iv => (
                  <button key={iv}
                    onClick={() => { setScanInterval(iv); loadPredicted(predMarket, iv); }}
                    className={clsx('text-xs px-2 py-0.5 rounded border transition-all',
                      interval === iv
                        ? 'bg-purple-600/20 text-purple-400 border-purple-600/40'
                        : 'text-gray-500 border-gray-700 hover:border-gray-600'
                    )}
                  >
                    {INTERVAL_LABELS[iv]}
                  </button>
                ))}
              </div>
              <p className="text-xs text-gray-600 mt-1.5">
                Signals from volume, 52-week range, SMA structure and momentum.
                {predicted.length > 0 && predicted[0].scannedAt
                  ? ` Data as of ${new Date(predicted[0].scannedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
                  : ''}
                {countdown !== null && interval < 1440 && (
                  <span className="ml-2 text-purple-400 font-medium">
                    · next scan in {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, '0')}
                  </span>
                )}
              </p>
              {interval === 1440 && (
                <p className="text-xs text-amber-600 mt-1">
                  ⚠ Daily mode: % changes are from the last scan and may be hours old. Use 15–60 min for up-to-date figures.
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2 text-[10px]">
              {Object.entries(SIGNAL_STYLE).map(([k, v]) => (
                <span key={k} className={clsx('px-2 py-0.5 rounded border font-bold', v.bg, v.text)}>{v.label}</span>
              ))}
            </div>
          </div>

          {predLoading && (
            <div className="flex items-center justify-center gap-2 py-16 text-gray-500">
              <RefreshCw className="h-4 w-4 animate-spin" />
              <span className="text-sm">Loading today&apos;s {predMarket} predictions…</span>
            </div>
          )}
          {predError && !predLoading && (
            <div className="flex items-center gap-2 px-4 py-3 bg-red-950/20 border border-red-900/30 rounded-lg">
              <AlertCircle className="h-4 w-4 text-red-400 shrink-0" />
              <p className="text-sm text-red-400">{predError}</p>
            </div>
          )}
          {!predLoading && !predError && predicted.length > 0 && (
            <>
              {/* Strong signals at top */}
              {predicted.filter(q => q.signal === 'STRONG_BUY' || q.signal === 'STRONG_SELL').length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                    High-Conviction Signals
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {predicted.filter(q => q.signal === 'STRONG_BUY' || q.signal === 'STRONG_SELL').map(q => (
                      <PredictedCard key={q.symbol} q={q} />
                    ))}
                  </div>
                </div>
              )}
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  All Signals
                </h3>
                <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
                  <MoverTable rows={predicted} showSignal loading={false} error="" />
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

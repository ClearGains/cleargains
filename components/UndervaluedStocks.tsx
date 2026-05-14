'use client';

import { useState, useEffect, useCallback } from 'react';
import { Gem, RefreshCw, TrendingDown, TrendingUp, Activity, CheckCircle, BarChart2, ArrowDownRight } from 'lucide-react';
import { clsx } from 'clsx';
import type { PredictedMover } from '@/app/api/market/predicted/route';

type FilterMode = 'all' | 'near-low' | 'buy-signal' | 'oversold';
type MarketTab = 'US' | 'UK';

function fmtPct(n: number) {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}
function fmtPrice(n: number, currency: string) {
  const sym = currency === 'GBP' ? '£' : '$';
  return `${sym}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtCap(n?: number) {
  if (!n) return '—';
  if (n >= 1e12) return `$${(n / 1e12).toFixed(1)}T`;
  if (n >= 1e9)  return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6)  return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n.toLocaleString()}`;
}

function undervalOpportunity(m: PredictedMover): { level: 'strong' | 'good' | 'watch'; reasons: string[] } {
  const reasons: string[] = [];
  let level: 'strong' | 'good' | 'watch' = 'watch';

  if (m.fromLow < 5) {
    reasons.push('Within 5% of 52-week low — major support zone');
    level = 'strong';
  } else if (m.fromLow < 10) {
    reasons.push(`${m.fromLow.toFixed(1)}% above 52-week low — near support`);
    if (level === 'watch') level = 'good';
  } else if (m.fromLow < 20) {
    reasons.push(`${m.fromLow.toFixed(1)}% above 52-week low`);
  }

  if (m.changePercent < -10) {
    reasons.push(`Down ${Math.abs(m.changePercent).toFixed(1)}% today — oversold, bounce candidate`);
    if (level === 'watch') level = 'good';
  } else if (m.changePercent < -5) {
    reasons.push(`Down ${Math.abs(m.changePercent).toFixed(1)}% — dip entry opportunity`);
  } else if (m.changePercent < -3) {
    reasons.push(`Down ${Math.abs(m.changePercent).toFixed(1)}% from yesterday`);
  }

  if (m.signal === 'STRONG_BUY') { reasons.push('AI signal: STRONG BUY'); level = 'strong'; }
  else if (m.signal === 'BUY')   { reasons.push('AI signal: BUY'); if (level === 'watch') level = 'good'; }

  if (m.goldenCross && m.aboveSma50) {
    reasons.push('Golden cross + above SMA50 — strong uptrend base');
  } else if (m.aboveSma200) {
    reasons.push('Above SMA200 — long-term uptrend intact despite dip');
  }

  if (m.volumeRatio > 3)        reasons.push(`Volume ${m.volumeRatio.toFixed(1)}× average — accumulation signal`);
  else if (m.volumeRatio > 1.5) reasons.push(`Volume ${m.volumeRatio.toFixed(1)}× average — elevated interest`);

  const overnight = m.extendedChangePercent ?? 0;
  if (overnight < -5) reasons.push(`Down ${Math.abs(overnight).toFixed(1)}% overnight — gap-down, check catalyst first`);

  return { level, reasons: reasons.slice(0, 5) };
}

function isUndervalued(m: PredictedMover): boolean {
  return (
    m.signal === 'STRONG_BUY' ||
    m.signal === 'BUY' ||
    m.fromLow < 15 ||
    (m.changePercent < -5 && m.score >= 0)
  );
}

function passesFilter(m: PredictedMover, filter: FilterMode): boolean {
  if (filter === 'near-low')   return m.fromLow < 10;
  if (filter === 'buy-signal') return m.signal === 'BUY' || m.signal === 'STRONG_BUY';
  if (filter === 'oversold')   return m.changePercent < -5;
  return true;
}

const LEVEL_STYLES = {
  strong: 'border-emerald-500/60 bg-emerald-950/30',
  good:   'border-blue-500/50 bg-blue-950/20',
  watch:  'border-gray-600/40 bg-gray-900/30',
};
const LEVEL_BADGE = {
  strong: 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30',
  good:   'bg-blue-500/15 text-blue-400 border border-blue-500/30',
  watch:  'bg-gray-600/15 text-gray-400 border border-gray-600/30',
};
const LEVEL_LABEL = {
  strong: 'STRONG VALUE',
  good:   'GOOD VALUE',
  watch:  'WATCH',
};

function StockCard({ mover }: { mover: PredictedMover }) {
  const { level, reasons } = undervalOpportunity(mover);
  const isPositive = mover.changePercent >= 0;
  const overnight  = mover.extendedChangePercent;

  return (
    <div className={clsx('rounded-xl border p-4 space-y-3', LEVEL_STYLES[level])}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-base font-bold text-white">{mover.symbol}</span>
            <span className={clsx('text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide', LEVEL_BADGE[level])}>
              {LEVEL_LABEL[level]}
            </span>
          </div>
          <p className="text-xs text-gray-400 mt-0.5 truncate">{mover.name}</p>
          <p className="text-[11px] text-gray-600 mt-0.5">{mover.exchange} · {fmtCap(mover.marketCap)}</p>
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-base font-bold text-white">{fmtPrice(mover.price, mover.currency)}</div>
          <div className={clsx('text-sm font-semibold', isPositive ? 'text-emerald-400' : 'text-red-400')}>
            {isPositive
              ? <TrendingUp className="inline h-3.5 w-3.5 mr-0.5" />
              : <TrendingDown className="inline h-3.5 w-3.5 mr-0.5" />}
            {fmtPct(mover.changePercent)}
          </div>
          {overnight !== undefined && Math.abs(overnight) >= 1 && (
            <div className="text-[11px] text-gray-500 mt-0.5">
              {mover.extendedLabel ?? 'EXT'} {fmtPct(overnight)}
            </div>
          )}
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="bg-gray-900/60 rounded-lg py-1.5 px-2">
          <div className="text-[10px] text-gray-500 uppercase tracking-wide">From Low</div>
          <div className={clsx('text-sm font-semibold', mover.fromLow < 10 ? 'text-emerald-400' : 'text-gray-300')}>
            +{mover.fromLow.toFixed(1)}%
          </div>
        </div>
        <div className="bg-gray-900/60 rounded-lg py-1.5 px-2">
          <div className="text-[10px] text-gray-500 uppercase tracking-wide">Vol Ratio</div>
          <div className={clsx('text-sm font-semibold', mover.volumeRatio > 2 ? 'text-blue-400' : 'text-gray-300')}>
            {mover.volumeRatio.toFixed(1)}×
          </div>
        </div>
        <div className="bg-gray-900/60 rounded-lg py-1.5 px-2">
          <div className="text-[10px] text-gray-500 uppercase tracking-wide">AI Score</div>
          <div className={clsx('text-sm font-semibold', mover.score >= 3 ? 'text-emerald-400' : mover.score > 0 ? 'text-blue-400' : 'text-gray-400')}>
            {mover.score > 0 ? '+' : ''}{mover.score}
          </div>
        </div>
      </div>

      {/* Opportunity reasons */}
      <div className="space-y-1">
        {reasons.map((r, i) => (
          <div key={i} className="flex items-start gap-1.5 text-xs text-gray-400">
            <CheckCircle className="h-3 w-3 text-emerald-500 flex-shrink-0 mt-0.5" />
            <span>{r}</span>
          </div>
        ))}
      </div>

      {/* Signal footer */}
      <div className="flex items-center justify-between pt-1 border-t border-gray-800">
        <span className={clsx(
          'text-xs font-semibold px-2 py-0.5 rounded',
          mover.signal === 'STRONG_BUY' ? 'bg-emerald-500/20 text-emerald-400' :
          mover.signal === 'BUY'        ? 'bg-blue-500/15 text-blue-400' :
          mover.signal === 'WATCH'      ? 'bg-yellow-600/15 text-yellow-400' :
          'bg-gray-700 text-gray-400'
        )}>
          {mover.signal}
        </span>
        <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
          <span
            className={clsx('w-2 h-2 rounded-full', mover.aboveSma50 ? 'bg-emerald-500' : 'bg-gray-600')}
            title={mover.aboveSma50 ? 'Above SMA50' : 'Below SMA50'}
          />
          <span
            className={clsx('w-2 h-2 rounded-full', mover.aboveSma200 ? 'bg-emerald-400' : 'bg-gray-600')}
            title={mover.aboveSma200 ? 'Above SMA200' : 'Below SMA200'}
          />
          <span>{mover.aboveSma50 ? 'Above SMA50' : 'Below SMA50'}</span>
        </div>
      </div>
    </div>
  );
}

const FILTER_OPTIONS: { value: FilterMode; label: string }[] = [
  { value: 'all',        label: 'All Undervalued' },
  { value: 'near-low',   label: 'Near 52-Wk Low' },
  { value: 'buy-signal', label: 'BUY Signals' },
  { value: 'oversold',   label: 'Oversold Dips' },
];

export function UndervaluedStocks() {
  const [market, setMarket]     = useState<MarketTab>('US');
  const [filter, setFilter]     = useState<FilterMode>('all');
  const [movers, setMovers]     = useState<PredictedMover[]>([]);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [scannedAt, setScannedAt] = useState('');

  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError('');
    try {
      const url = `/api/market/predicted?market=${market}${force ? '&force=1' : ''}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as PredictedMover[];
      const uv = data.filter(isUndervalued);
      uv.sort((a, b) => b.score - a.score || a.fromLow - b.fromLow);
      setMovers(uv);
      if (data[0]?.scannedAt) setScannedAt(data[0].scannedAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [market]);

  useEffect(() => { void load(); }, [load]);

  const filtered      = movers.filter(m => passesFilter(m, filter));
  const strongCount   = movers.filter(m => undervalOpportunity(m).level === 'strong').length;
  const goodCount     = movers.filter(m => undervalOpportunity(m).level === 'good').length;
  const nearLowCount  = movers.filter(m => m.fromLow < 10).length;
  const buyCount      = movers.filter(m => m.signal === 'BUY' || m.signal === 'STRONG_BUY').length;

  return (
    <div className="space-y-5">
      {/* Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {(['US', 'UK'] as MarketTab[]).map(m => (
            <button
              key={m}
              onClick={() => setMarket(m)}
              className={clsx(
                'px-4 py-1.5 rounded-lg text-sm font-semibold transition-all',
                market === m
                  ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/30'
                  : 'bg-gray-800 text-gray-400 hover:text-gray-200 border border-gray-700'
              )}
            >
              {m}
            </button>
          ))}
        </div>

        <button
          onClick={() => load(true)}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-800 text-gray-400 hover:text-gray-200 border border-gray-700 text-sm transition-all disabled:opacity-50"
        >
          <RefreshCw className={clsx('h-3.5 w-3.5', loading && 'animate-spin')} />
          {loading ? 'Scanning…' : 'Refresh'}
        </button>
      </div>

      {/* Summary stats */}
      {movers.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Total Found',    value: movers.length, icon: Activity,      color: 'text-white' },
            { label: 'Strong Value',   value: strongCount,   icon: Gem,           color: 'text-emerald-400' },
            { label: 'Good Value',     value: goodCount,     icon: CheckCircle,   color: 'text-blue-400' },
            { label: 'Near 52-Wk Low', value: nearLowCount,  icon: ArrowDownRight, color: 'text-yellow-400' },
          ].map(({ label, value, icon: Icon, color }) => (
            <div key={label} className="bg-gray-900 border border-gray-800 rounded-xl p-3 flex items-center gap-3">
              <Icon className={clsx('h-5 w-5 flex-shrink-0', color)} />
              <div>
                <div className={clsx('text-xl font-bold', color)}>{value}</div>
                <div className="text-xs text-gray-500">{label}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex flex-wrap gap-2">
        {FILTER_OPTIONS.map(opt => (
          <button
            key={opt.value}
            onClick={() => setFilter(opt.value)}
            className={clsx(
              'px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all',
              filter === opt.value
                ? 'bg-emerald-600/15 text-emerald-400 border-emerald-500/30'
                : 'bg-gray-800 text-gray-400 border-gray-700 hover:text-gray-200'
            )}
          >
            {opt.label}
            {opt.value === 'all' && movers.length > 0 && (
              <span className="ml-1.5 bg-gray-700 text-gray-300 rounded-full px-1.5 py-0.5 text-[10px]">{movers.length}</span>
            )}
            {opt.value === 'buy-signal' && buyCount > 0 && (
              <span className="ml-1.5 bg-emerald-800/40 text-emerald-400 rounded-full px-1.5 py-0.5 text-[10px]">{buyCount}</span>
            )}
            {opt.value === 'near-low' && nearLowCount > 0 && (
              <span className="ml-1.5 bg-blue-800/40 text-blue-400 rounded-full px-1.5 py-0.5 text-[10px]">{nearLowCount}</span>
            )}
          </button>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-950/30 border border-red-500/30 rounded-xl p-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && movers.length === 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map(i => (
            <div key={i} className="rounded-xl border border-gray-800 p-4 space-y-3 animate-pulse">
              <div className="flex justify-between">
                <div className="space-y-2">
                  <div className="h-4 w-20 bg-gray-800 rounded" />
                  <div className="h-3 w-32 bg-gray-800 rounded" />
                </div>
                <div className="space-y-2 text-right">
                  <div className="h-4 w-16 bg-gray-800 rounded" />
                  <div className="h-3 w-12 bg-gray-800 rounded ml-auto" />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {[1,2,3].map(j => <div key={j} className="h-10 bg-gray-800 rounded-lg" />)}
              </div>
              <div className="space-y-2">
                {[1,2,3].map(j => <div key={j} className="h-3 bg-gray-800 rounded" />)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && filtered.length === 0 && !error && (
        <div className="text-center py-16 text-gray-500">
          <BarChart2 className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="font-medium">No undervalued stocks found</p>
          <p className="text-sm mt-1">Markets may be near highs or data is still loading.</p>
        </div>
      )}

      {/* Results */}
      {filtered.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(m => <StockCard key={m.symbol} mover={m} />)}
        </div>
      )}

      {/* Footer */}
      {scannedAt && (
        <p className="text-xs text-gray-600 text-center">
          Scanned {new Date(scannedAt).toLocaleTimeString()} · Data from Yahoo Finance + Finnhub
        </p>
      )}

      {/* Disclaimer */}
      <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-4 text-xs text-gray-500 leading-relaxed">
        <strong className="text-gray-400">Undervaluation Disclaimer:</strong> Stocks flagged here are near 52-week lows,
        oversold, or carry BUY signals from the AI scanner. A low price does not guarantee a recovery — some stocks
        continue to fall. Always check for fundamental reasons behind the drop before entering a position.
      </div>
    </div>
  );
}

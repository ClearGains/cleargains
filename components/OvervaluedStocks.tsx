'use client';

import { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, RefreshCw, TrendingDown, TrendingUp, Activity, Zap, BarChart2 } from 'lucide-react';
import { clsx } from 'clsx';
import type { PredictedMover } from '@/app/api/market/predicted/route';

type FilterMode = 'all' | 'parabolic' | 'near-high' | 'sell-signal';
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
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n.toLocaleString()}`;
}

function overvalRisk(m: PredictedMover): { level: 'extreme' | 'high' | 'moderate'; reasons: string[] } {
  const reasons: string[] = [];
  let level: 'extreme' | 'high' | 'moderate' = 'moderate';

  if (m.changePercent > 15) { reasons.push(`Up ${m.changePercent.toFixed(1)}% today — extreme move`); level = 'extreme'; }
  else if (m.changePercent > 8) { reasons.push(`Up ${m.changePercent.toFixed(1)}% today — parabolic`); level = 'high'; }
  else if (m.changePercent > 4) { reasons.push(`Up ${m.changePercent.toFixed(1)}% — stretched`); }

  if (m.fromHigh > -2) { reasons.push('At 52-week high — selling pressure zone'); if (level === 'moderate') level = 'high'; }
  else if (m.fromHigh > -5) { reasons.push(`${Math.abs(m.fromHigh).toFixed(1)}% from 52-week high`); }

  if (m.volumeRatio > 4) { reasons.push(`Volume ${m.volumeRatio.toFixed(1)}× avg — spike`); }
  else if (m.volumeRatio > 2) { reasons.push(`Volume ${m.volumeRatio.toFixed(1)}× avg — elevated`); }

  if (!m.aboveSma50 && m.changePercent > 6) { reasons.push('Rally but below SMA50 — weak foundation'); }
  if (m.goldenCross === false && m.changePercent > 5) { reasons.push('Death cross setup — trend still down'); }

  const overnight = m.extendedChangePercent ?? 0;
  if (overnight > 8) { reasons.push(`+${overnight.toFixed(1)}% overnight — gap-up risk`); if (level === 'moderate') level = 'high'; }

  if (m.signal === 'STRONG_SELL') { reasons.push('AI signal: STRONG SELL'); level = 'extreme'; }
  else if (m.signal === 'SELL') { reasons.push('AI signal: SELL'); if (level === 'moderate') level = 'high'; }

  return { level, reasons: reasons.slice(0, 5) };
}

function isOvervalued(m: PredictedMover): boolean {
  return (
    m.parabolicRisk === true ||
    m.changePercent >= 5 ||
    (m.fromHigh > -3 && (m.signal === 'SELL' || m.signal === 'STRONG_SELL')) ||
    m.signal === 'STRONG_SELL'
  );
}

function passesFilter(m: PredictedMover, filter: FilterMode): boolean {
  if (filter === 'parabolic') return m.parabolicRisk === true || m.changePercent >= 8;
  if (filter === 'near-high') return m.fromHigh > -5;
  if (filter === 'sell-signal') return m.signal === 'SELL' || m.signal === 'STRONG_SELL';
  return true;
}

const LEVEL_STYLES = {
  extreme: 'border-red-500/60 bg-red-950/30',
  high:    'border-orange-500/50 bg-orange-950/20',
  moderate:'border-yellow-600/40 bg-yellow-950/15',
};
const LEVEL_BADGE = {
  extreme: 'bg-red-500/20 text-red-400 border border-red-500/30',
  high:    'bg-orange-500/15 text-orange-400 border border-orange-500/30',
  moderate:'bg-yellow-600/15 text-yellow-400 border border-yellow-600/30',
};
const LEVEL_LABEL = {
  extreme: 'EXTREME RISK',
  high:    'HIGH RISK',
  moderate:'WATCH',
};

function StockCard({ mover }: { mover: PredictedMover }) {
  const { level, reasons } = overvalRisk(mover);
  const isPositive = mover.changePercent >= 0;
  const overnight = mover.extendedChangePercent;

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
            {mover.parabolicRisk && (
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30 uppercase tracking-wide flex items-center gap-1">
                <Zap className="h-2.5 w-2.5" /> Parabolic
              </span>
            )}
          </div>
          <p className="text-xs text-gray-400 mt-0.5 truncate">{mover.name}</p>
          <p className="text-[11px] text-gray-600 mt-0.5">{mover.exchange} · {fmtCap(mover.marketCap)}</p>
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-base font-bold text-white">{fmtPrice(mover.price, mover.currency)}</div>
          <div className={clsx('text-sm font-semibold', isPositive ? 'text-red-400' : 'text-emerald-400')}>
            {isPositive ? <TrendingUp className="inline h-3.5 w-3.5 mr-0.5" /> : <TrendingDown className="inline h-3.5 w-3.5 mr-0.5" />}
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
          <div className="text-[10px] text-gray-500 uppercase tracking-wide">From High</div>
          <div className={clsx('text-sm font-semibold', mover.fromHigh > -5 ? 'text-red-400' : 'text-gray-300')}>
            {mover.fromHigh.toFixed(1)}%
          </div>
        </div>
        <div className="bg-gray-900/60 rounded-lg py-1.5 px-2">
          <div className="text-[10px] text-gray-500 uppercase tracking-wide">Vol Ratio</div>
          <div className={clsx('text-sm font-semibold', mover.volumeRatio > 2 ? 'text-orange-400' : 'text-gray-300')}>
            {mover.volumeRatio.toFixed(1)}×
          </div>
        </div>
        <div className="bg-gray-900/60 rounded-lg py-1.5 px-2">
          <div className="text-[10px] text-gray-500 uppercase tracking-wide">AI Score</div>
          <div className={clsx('text-sm font-semibold', mover.score < 0 ? 'text-red-400' : 'text-gray-300')}>
            {mover.score > 0 ? '+' : ''}{mover.score}
          </div>
        </div>
      </div>

      {/* Risk reasons */}
      <div className="space-y-1">
        {reasons.map((r, i) => (
          <div key={i} className="flex items-start gap-1.5 text-xs text-gray-400">
            <AlertTriangle className="h-3 w-3 text-orange-400 flex-shrink-0 mt-0.5" />
            <span>{r}</span>
          </div>
        ))}
      </div>

      {/* Signal footer */}
      <div className="flex items-center justify-between pt-1 border-t border-gray-800">
        <span className={clsx(
          'text-xs font-semibold px-2 py-0.5 rounded',
          mover.signal === 'STRONG_SELL' ? 'bg-red-500/20 text-red-400' :
          mover.signal === 'SELL'        ? 'bg-orange-500/15 text-orange-400' :
          mover.signal === 'WATCH'       ? 'bg-yellow-600/15 text-yellow-400' :
          'bg-gray-700 text-gray-400'
        )}>
          {mover.signal}
        </span>
        <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
          <span className={clsx('w-2 h-2 rounded-full', mover.aboveSma50 ? 'bg-orange-500' : 'bg-gray-600')} title={mover.aboveSma50 ? 'Above SMA50' : 'Below SMA50'} />
          <span className={clsx('w-2 h-2 rounded-full', mover.aboveSma200 ? 'bg-orange-400' : 'bg-gray-600')} title={mover.aboveSma200 ? 'Above SMA200' : 'Below SMA200'} />
          <span>{mover.aboveSma50 ? 'Above SMA50' : 'Below SMA50'}</span>
        </div>
      </div>
    </div>
  );
}

const FILTER_OPTIONS: { value: FilterMode; label: string }[] = [
  { value: 'all',         label: 'All Overvalued' },
  { value: 'parabolic',   label: 'Parabolic Moves' },
  { value: 'near-high',   label: 'Near 52-Wk High' },
  { value: 'sell-signal', label: 'SELL Signals' },
];

export function OvervaluedStocks() {
  const [market, setMarket] = useState<MarketTab>('US');
  const [filter, setFilter] = useState<FilterMode>('all');
  const [movers, setMovers] = useState<PredictedMover[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [scannedAt, setScannedAt] = useState('');

  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError('');
    try {
      const url = `/api/market/predicted?market=${market}${force ? '&force=1' : ''}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as PredictedMover[];
      const ovr = data.filter(isOvervalued);
      ovr.sort((a, b) => b.changePercent - a.changePercent);
      setMovers(ovr);
      if (data[0]?.scannedAt) setScannedAt(data[0].scannedAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [market]);

  useEffect(() => { void load(); }, [load]);

  const filtered = movers.filter(m => passesFilter(m, filter));
  const extremeCount  = movers.filter(m => overvalRisk(m).level === 'extreme').length;
  const highCount     = movers.filter(m => overvalRisk(m).level === 'high').length;
  const parabolicCount = movers.filter(m => m.parabolicRisk).length;

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
                  ? 'bg-red-600/20 text-red-400 border border-red-500/30'
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
            { label: 'Total Flagged', value: movers.length, icon: Activity, color: 'text-white' },
            { label: 'Extreme Risk', value: extremeCount, icon: AlertTriangle, color: 'text-red-400' },
            { label: 'High Risk', value: highCount, icon: TrendingUp, color: 'text-orange-400' },
            { label: 'Parabolic', value: parabolicCount, icon: Zap, color: 'text-yellow-400' },
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
                ? 'bg-red-600/15 text-red-400 border-red-500/30'
                : 'bg-gray-800 text-gray-400 border-gray-700 hover:text-gray-200'
            )}
          >
            {opt.label}
            {opt.value === 'all' && movers.length > 0 && (
              <span className="ml-1.5 bg-gray-700 text-gray-300 rounded-full px-1.5 py-0.5 text-[10px]">{movers.length}</span>
            )}
            {opt.value === 'parabolic' && parabolicCount > 0 && (
              <span className="ml-1.5 bg-red-800/40 text-red-400 rounded-full px-1.5 py-0.5 text-[10px]">{parabolicCount}</span>
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

      {/* Results */}
      {!loading && filtered.length === 0 && !error && (
        <div className="text-center py-16 text-gray-500">
          <BarChart2 className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="font-medium">No overvalued stocks found</p>
          <p className="text-sm mt-1">Markets may be calm or data is still loading.</p>
        </div>
      )}

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
        <strong className="text-gray-400">Overvaluation Risk Disclaimer:</strong> Stocks flagged here have made large moves
        that historically increase reversal probability. This is not a guarantee of a price fall — momentum can persist.
        Always use stop-losses and confirm signals with your own analysis before trading.
      </div>
    </div>
  );
}

'use client';
import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, TrendingUp, TrendingDown, Zap, AlertCircle, BarChart2, ChevronDown } from 'lucide-react';
import { clsx } from 'clsx';
import type { Mover } from '@/app/api/market/movers/route';
import type { PredictedMover } from '@/app/api/market/predicted/route';
import { NewsStrip } from '@/components/ui/NewsStrip';

function RankBadge({ rank }: { rank: number }) {
  const cls =
    rank === 1 ? 'text-yellow-400 border-yellow-500/50 bg-yellow-500/10' :
    rank === 2 ? 'text-slate-300  border-slate-400/50  bg-slate-500/10'  :
    rank === 3 ? 'text-orange-400 border-orange-500/50 bg-orange-600/10' :
                 'text-gray-600   border-gray-700/50   bg-gray-800/40';
  return <span className={clsx('text-[9px] font-bold px-1.5 py-0.5 rounded border shrink-0 tabular-nums', cls)}>#{rank}</span>;
}

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

// ── Trade level calculator ────────────────────────────────────────────────────

type TradeDirection = 'LONG' | 'SHORT';

function calcTradeLevels(
  q: Pick<Mover, 'price' | 'dayHigh' | 'dayLow' | 'currency'>,
  direction: TradeDirection,
) {
  const entry = q.price;
  const dec   = entry < 1 ? 4 : entry < 10 ? 3 : 2;

  let stopLoss: number;
  if (direction === 'LONG') {
    // Stop 1% below day's low; cap at 8% from entry so stops aren't absurdly wide
    const raw  = (q.dayLow > 0 ? q.dayLow : entry) * 0.99;
    stopLoss   = (entry - raw) / entry <= 0.08 ? raw : entry * 0.95;
  } else {
    // Stop 1% above day's high; cap at 8% above entry
    const raw  = (q.dayHigh > 0 ? q.dayHigh : entry) * 1.01;
    stopLoss   = (raw - entry) / entry <= 0.08 ? raw : entry * 1.05;
  }

  const risk       = Math.abs(entry - stopLoss);
  const takeProfit = direction === 'LONG' ? entry + risk * 2 : entry - risk * 2;

  return {
    direction,
    entry:      parseFloat(entry.toFixed(dec)),
    stopLoss:   parseFloat(stopLoss.toFixed(dec)),
    takeProfit: parseFloat(takeProfit.toFixed(dec)),
    stopPts:    parseFloat(risk.toFixed(dec)),
    tpPts:      parseFloat((risk * 2).toFixed(dec)),
  };
}

function TradeLevelsPanel({
  q,
  direction,
}: {
  q: Pick<Mover, 'price' | 'dayHigh' | 'dayLow' | 'currency'>;
  direction: TradeDirection;
}) {
  const lvl = calcTradeLevels(q, direction);
  const cur = q.currency;

  return (
    <div className="space-y-2 pt-1">
      <div className="flex items-center gap-2">
        <span className={clsx(
          'text-[10px] font-bold px-1.5 py-0.5 rounded',
          direction === 'LONG'
            ? 'bg-emerald-500/20 text-emerald-400'
            : 'bg-red-500/20 text-red-400',
        )}>
          {direction === 'LONG' ? '↑ LONG' : '↓ SHORT'}
        </span>
        <span className="text-[10px] text-gray-500 uppercase tracking-wide font-semibold">Suggested levels</span>
        <span className="text-[10px] text-gray-700 ml-auto">
          Day {fmtPrice(q.dayLow, cur)} – {fmtPrice(q.dayHigh, cur)}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-1.5 text-xs font-mono">
        <div className="bg-blue-950/30 rounded-lg p-2 border border-blue-900/20">
          <div className="text-[9px] text-blue-400 font-semibold mb-0.5">ENTRY</div>
          <div className="text-white font-bold">{fmtPrice(lvl.entry, cur)}</div>
          <div className="text-[9px] text-blue-900">current price</div>
        </div>
        <div className="bg-red-950/30 rounded-lg p-2 border border-red-900/20">
          <div className="text-[9px] text-red-400 font-semibold mb-0.5">STOP LOSS</div>
          <div className="text-red-400 font-bold">{fmtPrice(lvl.stopLoss, cur)}</div>
          <div className="text-[9px] text-red-800">{lvl.stopPts.toFixed(2)} pts away</div>
        </div>
        <div className="bg-emerald-950/30 rounded-lg p-2 border border-emerald-900/20">
          <div className="text-[9px] text-emerald-400 font-semibold mb-0.5">TAKE PROFIT</div>
          <div className="text-emerald-400 font-bold">{fmtPrice(lvl.takeProfit, cur)}</div>
          <div className="text-[9px] text-emerald-800">{lvl.tpPts.toFixed(2)} pts away</div>
        </div>
      </div>

      {/* Spread bet P&L at two common stake sizes */}
      <div className="text-[10px] font-mono bg-gray-800/50 rounded px-2.5 py-1.5 text-gray-500 flex flex-wrap gap-x-4 gap-y-0.5">
        <span>
          <span className="text-gray-400">@£1/pt</span>: risk{' '}
          <span className="text-red-400">£{lvl.stopPts.toFixed(2)}</span>
          {' · '}reward{' '}
          <span className="text-emerald-400">£{lvl.tpPts.toFixed(2)}</span>
        </span>
        <span>
          <span className="text-gray-400">@£5/pt</span>: risk{' '}
          <span className="text-red-400">£{(lvl.stopPts * 5).toFixed(2)}</span>
          {' · '}reward{' '}
          <span className="text-emerald-400">£{(lvl.tpPts * 5).toFixed(2)}</span>
        </span>
        <span className="text-gray-600">· 2:1 R:R</span>
      </div>
    </div>
  );
}

const SIGNAL_STYLE: Record<string, { bg: string; text: string; label: string }> = {
  STRONG_BUY:  { bg: 'bg-emerald-500/20 border-emerald-500/40', text: 'text-emerald-400', label: 'STRONG BUY'  },
  BUY:         { bg: 'bg-emerald-500/10 border-emerald-500/20', text: 'text-emerald-500', label: 'BUY'         },
  WATCH:       { bg: 'bg-amber-500/10  border-amber-500/20',   text: 'text-amber-400',   label: 'WATCH'        },
  SELL:        { bg: 'bg-red-500/10    border-red-500/20',     text: 'text-red-500',     label: 'SELL'         },
  STRONG_SELL: { bg: 'bg-red-500/20    border-red-500/40',     text: 'text-red-400',     label: 'STRONG SELL'  },
};

// ── Mover row ─────────────────────────────────────────────────────────────────

function MoverRow({ q, showSignal, showExtended, rank }: {
  q: Mover & Partial<PredictedMover>;
  showSignal?: boolean;
  showExtended?: boolean;
  rank?: number;
}) {
  const [open, setOpen] = useState(false);
  const sig       = showSignal && q.signal ? SIGNAL_STYLE[q.signal] : null;
  const ext       = (q as Mover).extendedChangePercent;
  const extLabel  = (q as Mover).extendedLabel;
  const direction: TradeDirection =
    (q.signal === 'SELL' || q.signal === 'STRONG_SELL') ? 'SHORT' : 'LONG';

  return (
    <>
      <tr
        className={clsx(
          'border-b border-gray-800/50 hover:bg-gray-800/20 transition-colors cursor-pointer select-none',
          open && 'bg-gray-800/10',
        )}
        onClick={() => setOpen(o => !o)}
      >
        <td className="py-3 pr-3">
          <div className="flex items-center gap-1.5 mb-0.5">
            {rank !== undefined && <RankBadge rank={rank} />}
            <div className="font-bold text-white text-sm font-mono">{q.symbol}</div>
          </div>
          <div className="text-gray-500 text-xs truncate max-w-[160px]">{q.name}</div>
        </td>
        <td className="py-3 px-2 text-right font-mono text-sm text-white">
          {fmtPrice(q.price, q.currency)}
        </td>
        <td className="py-3 px-2 text-right font-mono text-sm">
          <div className="text-gray-400 text-xs">{fmtPrice(q.closePrice ?? q.price, q.currency)}</div>
          <span className={clsx('font-semibold', q.changePercent >= 0 ? 'text-emerald-400' : 'text-red-400')}>
            {q.changePercent >= 0 ? '+' : ''}{q.changePercent.toFixed(2)}%
          </span>
        </td>
        {showExtended && (
          <td className="py-3 px-2 text-right font-mono text-sm font-semibold hidden sm:table-cell">
            {ext != null ? (
              <span className={clsx(ext >= 0 ? 'text-orange-400' : 'text-red-400')}>
                {ext >= 0 ? '+' : ''}{ext.toFixed(2)}%
                <span className="ml-1 text-[9px] opacity-60">{extLabel}</span>
              </span>
            ) : (
              <span className="text-gray-700">—</span>
            )}
          </td>
        )}
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
        <td className="py-3 pl-2 w-6">
          <ChevronDown className={clsx(
            'h-3.5 w-3.5 text-gray-600 transition-transform ml-auto',
            open && 'rotate-180',
          )} />
        </td>
      </tr>
      {open && (
        <tr className="border-b border-gray-800/30 bg-gray-900/60">
          <td colSpan={99} className="px-4 pb-4 space-y-3">
            <TradeLevelsPanel q={q} direction={direction} />
            <div className="border-t border-gray-800 pt-3">
              <NewsStrip symbol={q.symbol} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function MoverTable({ rows, showSignal, showExtended, loading, error }: {
  rows: (Mover & Partial<PredictedMover>)[];
  showSignal?: boolean;
  showExtended?: boolean;
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
            <th className="text-right py-2 px-2">Current</th>
            <th className="text-right py-2 px-2">At Close</th>
            {showExtended && <th className="text-right py-2 px-2 hidden sm:table-cell">Overnight</th>}
            <th className="text-right py-2 px-2 hidden sm:table-cell">Volume</th>
            <th className="text-right py-2 px-2 hidden md:table-cell">Mkt Cap</th>
            <th className="text-right py-2 pl-2 hidden lg:table-cell">Trend</th>
            {showSignal && <th className="py-2 pl-2">Signal</th>}
            <th className="py-2 pl-2 w-6"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((q, i) => <MoverRow key={q.symbol} q={q} showSignal={showSignal} showExtended={showExtended} rank={i + 1} />)}
        </tbody>
      </table>
    </div>
  );
}

// ── Predicted mover card ──────────────────────────────────────────────────────

function PredictedCard({ q, rank, total }: { q: PredictedMover; rank?: number; total?: number }) {
  const sig      = SIGNAL_STYLE[q.signal];
  const overnight = q.extendedChangePercent;
  const hasLargeOvernight = overnight != null && Math.abs(overnight) > 4;

  return (
    <div className={clsx(
      'bg-gray-900 rounded-xl border p-4 space-y-3 hover:border-gray-700 transition-colors',
      hasLargeOvernight && overnight! > 0 ? 'border-orange-700/50' : hasLargeOvernight ? 'border-red-700/50' : 'border-gray-800'
    )}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            {rank !== undefined && <RankBadge rank={rank} />}
            <span className="font-bold text-white font-mono">{q.symbol}</span>
            <span className={clsx('text-xs font-semibold', q.changePercent >= 0 ? 'text-emerald-400' : 'text-red-400')}>
              {q.changePercent >= 0 ? '+' : ''}{q.changePercent.toFixed(2)}% close
            </span>
            {overnight != null && (
              <span className={clsx('text-xs font-semibold', overnight >= 0 ? 'text-orange-400' : 'text-red-400')}>
                {overnight >= 0 ? '+' : ''}{overnight.toFixed(2)}% {q.extendedLabel ?? 'ext'}
              </span>
            )}
          </div>
          <div className="text-xs text-gray-500 truncate max-w-[200px]">{q.name}</div>
        </div>
        <span className={clsx('text-[10px] font-bold px-2 py-1 rounded border shrink-0', sig.bg, sig.text)}>
          {sig.label}
        </span>
      </div>

      {/* Warning banner when overnight move is significant */}
      {hasLargeOvernight && (
        <div className={clsx(
          'text-[10px] font-semibold px-2 py-1.5 rounded flex items-center gap-1.5',
          overnight! > 0
            ? 'bg-orange-500/10 border border-orange-500/30 text-orange-400'
            : 'bg-red-500/10 border border-red-500/30 text-red-400'
        )}>
          ⚠ Already moved {overnight! > 0 ? '+' : ''}{overnight!.toFixed(1)}% in extended hours — entry price is {overnight! > 0 ? 'above' : 'below'} close
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 text-xs font-mono">
        <div className="bg-gray-800/60 rounded p-2">
          <div className="text-gray-500 text-[10px]">Current</div>
          <div className="text-white font-semibold">{fmtPrice(q.price, q.currency)}</div>
          {q.closePrice != null && q.closePrice !== q.price && (
            <div className="text-gray-600 text-[10px]">Close {fmtPrice(q.closePrice, q.currency)}</div>
          )}
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

      {/* Trade levels */}
      {q.signal !== 'WATCH' && (
        <div className="border-t border-gray-800 pt-3">
          <TradeLevelsPanel
            q={q}
            direction={q.signal === 'SELL' || q.signal === 'STRONG_SELL' ? 'SHORT' : 'LONG'}
          />
        </div>
      )}

      <div className="flex items-center gap-2 text-[10px] text-gray-600 pt-1 border-t border-gray-800">
        <span className={clsx('flex items-center gap-1', q.goldenCross ? 'text-emerald-600' : 'text-red-600')}>
          {q.goldenCross ? '▲ Golden cross' : '▼ Death cross'}
        </span>
        <span>·</span>
        <span>SMA50: {q.aboveSma50 ? 'above' : 'below'}</span>
        <span>·</span>
        <span>SMA200: {q.aboveSma200 ? 'above' : 'below'}</span>
        {rank !== undefined && total !== undefined && (
          <span className="ml-auto text-gray-700">Ranked #{rank} of {total} · score {q.score ?? '—'}</span>
        )}
      </div>

      <div className="border-t border-gray-800/60 pt-2">
        <NewsStrip symbol={q.symbol} />
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

type Tab = 'daily' | 'predicted';
type MoverType = 'gainers' | 'losers' | 'active';
type Market = 'US' | 'UK';

export function MarketMovers() {
  const [tab,          setTab]          = useState<Tab>('daily');
  const [moverType,    setMoverType]    = useState<MoverType>('gainers');
  const [predMarket,   setPredMarket]   = useState<Market>('US');
  const [dailyRows,    setDailyRows]    = useState<Mover[]>([]);
  const [predicted,    setPredicted]    = useState<PredictedMover[]>([]);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [predLoading,  setPredLoading]  = useState(false);
  const [dailyError,   setDailyError]   = useState('');
  const [predError,    setPredError]    = useState('');
  const [lastRefresh,  setLastRefresh]  = useState<Date | null>(null);
  const [predScannedAt, setPredScannedAt] = useState<string | null>(null);

  const loadDaily = useCallback(async (type: MoverType, silent = false) => {
    if (!silent) setDailyLoading(true);
    setDailyError('');
    try {
      const r = await fetch(`/api/market/movers?type=${type}`, { cache: 'no-store' });
      const data = await r.json() as Mover[] | { error: string };
      if (!r.ok || 'error' in data) throw new Error('error' in data ? data.error : `HTTP ${r.status}`);
      setDailyRows(data as Mover[]);
      setLastRefresh(new Date());
    } catch (e) {
      if (!silent) setDailyError(e instanceof Error ? e.message : 'Failed to load movers');
    } finally {
      if (!silent) setDailyLoading(false);
    }
  }, []);

  // Predicted movers — force=true bypasses the server cache for truly fresh data
  const loadPredicted = useCallback(async (market: Market, force = false) => {
    setPredLoading(true);
    setPredError('');
    try {
      const url = `/api/market/predicted?market=${market}${force ? '&force=1' : ''}`;
      const r = await fetch(url, { cache: 'no-store' });
      const data = await r.json() as PredictedMover[] | { error: string };
      if (!r.ok || 'error' in data) throw new Error('error' in data ? data.error : `HTTP ${r.status}`);
      const rows = data as PredictedMover[];
      setPredicted(rows);
      setLastRefresh(new Date());
      if (rows.length > 0 && rows[0].scannedAt) setPredScannedAt(rows[0].scannedAt);
    } catch (e) {
      setPredError(e instanceof Error ? e.message : 'Failed to load predictions');
    } finally {
      setPredLoading(false);
    }
  }, []);

  // Auto-refresh daily movers every 5s (silent — no spinner, table stays visible)
  useEffect(() => {
    if (tab !== 'daily') return;
    const t = globalThis.setInterval(() => loadDaily(moverType, true), 5_000);
    return () => globalThis.clearInterval(t);
  }, [tab, moverType, loadDaily]);

  // Initial load on tab switch
  useEffect(() => {
    if (tab === 'daily') loadDaily(moverType);
    else loadPredicted(predMarket);
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
            onClick={() => { setTab('predicted'); loadPredicted(predMarket); }}
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
            onClick={() => tab === 'daily' ? loadDaily(moverType) : loadPredicted(predMarket, true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-lg text-xs text-gray-400 transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
      </div>

      {/* Daily movers */}
      {tab === 'daily' && (
        <div className="space-y-3">
          <div className="flex gap-2 flex-wrap">
            {([['gainers', '↑ Top Gainers', 'text-emerald-400 border-emerald-600/40 bg-emerald-600/10'],
               ['losers',  '↓ Top Losers',  'text-red-400   border-red-600/40   bg-red-600/10'],
               ['active',  '⚡ Most Active', 'text-amber-400 border-amber-600/40 bg-amber-600/10']] as const
            ).map(([type, label, activeClass]) => (
              <button
                key={type}
                onClick={() => { setMoverType(type); loadDaily(type, false); }}
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
              <div className="ml-auto flex items-center gap-2">
                <span className="flex items-center gap-1.5 text-xs text-emerald-400 font-semibold">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  LIVE
                </span>
                {lastRefresh && (
                  <span className="text-xs text-gray-600">
                    · updated {lastRefresh.toLocaleTimeString()}
                  </span>
                )}
              </div>
            </div>
            <MoverTable rows={dailyRows} showExtended loading={dailyLoading} error={dailyError} />
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
                    onClick={() => { setPredMarket(m); loadPredicted(m); }}
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
              <p className="text-xs text-gray-600 mt-1.5">
                Signals from volume, 52-week range, SMA structure and momentum.
                {predScannedAt
                  ? ` Scanned at ${new Date(predScannedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
                  : ''}
                {' · Click Refresh for the latest signals.'}
              </p>
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
              <span className="text-sm">Scanning {predMarket} universe…</span>
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
              {predicted.filter(q => q.signal === 'STRONG_BUY' || q.signal === 'STRONG_SELL').length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                    High-Conviction Signals
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {predicted.filter(q => q.signal === 'STRONG_BUY' || q.signal === 'STRONG_SELL').map(q => (
                      <PredictedCard key={q.symbol} q={q} rank={predicted.indexOf(q) + 1} total={predicted.length} />
                    ))}
                  </div>
                </div>
              )}
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  All Signals
                </h3>
                <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
                  <MoverTable rows={predicted} showSignal showExtended loading={false} error="" />
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

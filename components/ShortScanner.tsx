'use client';
import { useState, useCallback } from 'react';
import { RefreshCw, AlertTriangle, AlertCircle, TrendingDown, Zap, Search } from 'lucide-react';
import { clsx } from 'clsx';
import type { ShortCandidate, ShortsApiResponse } from '@/app/api/market/shorts/route';
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

// ── Trade level calculator ─────────────────────────────────────────────────────
// bufferPct: % above day high to place stop
// maxCapPct: max stop distance from entry
function calcShortLevels(price: number, dayHigh: number, bufferPct = 0.01, maxCapPct = 0.08) {
  const dec  = price < 1 ? 4 : price < 10 ? 3 : 2;
  const raw  = (dayHigh > 0 ? dayHigh : price) * (1 + bufferPct);
  const stop = (raw - price) / price <= maxCapPct ? raw : price * (1 + maxCapPct);
  const risk = stop - price;
  const tp   = price - risk * 2;
  return {
    entry:      parseFloat(price.toFixed(dec)),
    stopLoss:   parseFloat(stop.toFixed(dec)),
    takeProfit: parseFloat(tp.toFixed(dec)),
    stopPts:    parseFloat(risk.toFixed(dec)),
    tpPts:      parseFloat((risk * 2).toFixed(dec)),
  };
}

function ShortLevelsPanel({
  price, dayHigh, currency,
  bufferPct = 0.01, maxCapPct = 0.08,
}: {
  price: number; dayHigh: number; currency: string;
  bufferPct?: number; maxCapPct?: number;
}) {
  const lvl = calcShortLevels(price, dayHigh, bufferPct, maxCapPct);
  return (
    <div className="space-y-2 pt-1">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">
          ↓ SHORT
        </span>
        <span className="text-[10px] text-gray-500 uppercase tracking-wide font-semibold">Levels</span>
        <span className="text-[10px] text-gray-700 ml-auto">Day high: {fmtPrice(dayHigh, currency)}</span>
      </div>
      <div className="grid grid-cols-3 gap-1.5 text-xs font-mono">
        <div className="bg-blue-950/30 rounded-lg p-2 border border-blue-900/20">
          <div className="text-[9px] text-blue-400 font-semibold mb-0.5">ENTRY</div>
          <div className="text-white font-bold">{fmtPrice(lvl.entry, currency)}</div>
          <div className="text-[9px] text-blue-900">current price</div>
        </div>
        <div className="bg-red-950/30 rounded-lg p-2 border border-red-900/20">
          <div className="text-[9px] text-red-400 font-semibold mb-0.5">STOP LOSS</div>
          <div className="text-red-400 font-bold">{fmtPrice(lvl.stopLoss, currency)}</div>
          <div className="text-[9px] text-red-800">{lvl.stopPts.toFixed(2)} pts above</div>
        </div>
        <div className="bg-emerald-950/30 rounded-lg p-2 border border-emerald-900/20">
          <div className="text-[9px] text-emerald-400 font-semibold mb-0.5">TAKE PROFIT</div>
          <div className="text-emerald-400 font-bold">{fmtPrice(lvl.takeProfit, currency)}</div>
          <div className="text-[9px] text-emerald-800">{lvl.tpPts.toFixed(2)} pts below</div>
        </div>
      </div>
      <div className="text-[10px] font-mono bg-gray-800/50 rounded px-2.5 py-1.5 text-gray-500 flex flex-wrap gap-x-4 gap-y-0.5">
        <span>
          <span className="text-gray-400">@£1/pt</span>: risk{' '}
          <span className="text-red-400">£{lvl.stopPts.toFixed(2)}</span>
          {' · '}profit{' '}
          <span className="text-emerald-400">£{lvl.tpPts.toFixed(2)}</span>
        </span>
        <span>
          <span className="text-gray-400">@£5/pt</span>: risk{' '}
          <span className="text-red-400">£{(lvl.stopPts * 5).toFixed(2)}</span>
          {' · '}profit{' '}
          <span className="text-emerald-400">£{(lvl.tpPts * 5).toFixed(2)}</span>
        </span>
        <span className="text-gray-600">· 2:1 R:R</span>
      </div>
    </div>
  );
}

// ── Signal styles ─────────────────────────────────────────────────────────────

const SIG_STYLE = {
  STRONG_SHORT: { bg: 'bg-red-500/20 border-red-500/40',     text: 'text-red-300',   label: 'STRONG SHORT', card: 'border-red-800/60'  },
  SHORT:        { bg: 'bg-rose-500/10 border-rose-500/20',   text: 'text-rose-400',  label: 'SHORT',        card: 'border-rose-800/40' },
  WATCH:        { bg: 'bg-amber-500/10 border-amber-500/20', text: 'text-amber-400', label: 'WATCH',        card: 'border-gray-800'    },
  AVOID:        { bg: 'bg-gray-700/20 border-gray-700/30',   text: 'text-gray-500',  label: 'AVOID',        card: 'border-gray-900'    },
} as const;

// ── Short card ────────────────────────────────────────────────────────────────

function ShortCard({ q, rank, total }: { q: ShortCandidate; rank?: number; total?: number }) {
  const sig       = SIG_STYLE[q.shortSignal];
  const overnight = q.extendedChangePercent;
  const isDayTrade  = q.category === 'daytrade';
  const isSmallCap  = q.category === 'smallcap';

  // Day trades: tighter stop (0.5% above day high, 3% cap)
  // Small caps: slightly wider (1.5% above day high, 12% cap)
  // Conviction: standard (1% above day high, 8% cap)
  const bufferPct = isDayTrade ? 0.005 : isSmallCap ? 0.015 : 0.01;
  const maxCapPct = isDayTrade ? 0.03  : isSmallCap ? 0.12  : 0.08;

  return (
    <div className={clsx('bg-gray-900 rounded-xl border p-4 space-y-3 hover:border-gray-600 transition-colors', sig.card)}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            {rank !== undefined && <RankBadge rank={rank} />}
            <span className="font-bold text-white font-mono">{q.symbol}</span>
            {isDayTrade  && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400 border border-yellow-500/30">⚡ INTRADAY</span>}
            {isSmallCap  && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400 border border-purple-500/30">🔬 SMALL CAP</span>}
            <span className={clsx('text-xs font-semibold', q.changePercent >= 0 ? 'text-emerald-400' : 'text-red-400')}>
              {q.changePercent >= 0 ? '+' : ''}{q.changePercent.toFixed(2)}%
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

      {/* Squeeze risk warning */}
      {q.squeezeRisk && (
        <div className="text-[10px] font-semibold px-2 py-1.5 rounded flex items-center gap-1.5 bg-amber-500/10 border border-amber-500/30 text-amber-400">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          {isSmallCap
            ? 'Near 52w low — small caps can spike 50%+ on news. Very high squeeze risk.'
            : 'Within 10% of 52w low — short-squeeze risk. Use tight stop.'}
        </div>
      )}

      {/* Day trade note */}
      {isDayTrade && (
        <div className="text-[10px] px-2 py-1.5 rounded bg-yellow-500/5 border border-yellow-500/20 text-yellow-600">
          Intraday setup — enter at open, target within session. Close position before market close to avoid overnight charges.
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 gap-2 text-xs font-mono">
        <div className="bg-gray-800/60 rounded p-2">
          <div className="text-gray-500 text-[10px]">Current price</div>
          <div className="text-white font-semibold">{fmtPrice(q.price, q.currency)}</div>
          {q.closePrice != null && q.closePrice !== q.price && (
            <div className="text-gray-600 text-[10px]">Close {fmtPrice(q.closePrice, q.currency)}</div>
          )}
        </div>
        <div className="bg-gray-800/60 rounded p-2">
          <div className="text-gray-500 text-[10px]">Volume ratio</div>
          <div className={clsx('font-semibold', q.volumeRatio > 2 ? 'text-red-400' : 'text-white')}>
            {q.volumeRatio.toFixed(1)}× avg
          </div>
          <div className="text-gray-600 text-[10px]">{fmtVol(q.volume)}</div>
        </div>
        <div className="bg-gray-800/60 rounded p-2">
          <div className="text-gray-500 text-[10px]">From 52w High</div>
          <div className={clsx('font-semibold', q.fromHigh > -10 ? 'text-red-400' : 'text-gray-300')}>
            {q.fromHigh.toFixed(1)}%
          </div>
        </div>
        <div className="bg-gray-800/60 rounded p-2">
          <div className="text-gray-500 text-[10px]">From 52w Low</div>
          <div className={clsx('font-semibold', q.fromLow < 10 ? 'text-amber-400' : 'text-gray-400')}>
            +{q.fromLow.toFixed(1)}%
          </div>
        </div>
      </div>

      {/* Reasons */}
      {q.shortReasons.length > 0 && (
        <ul className="space-y-1">
          {q.shortReasons.map((r, i) => (
            <li key={i} className="flex gap-1.5 text-xs text-gray-400">
              <span className="text-red-600 shrink-0 mt-0.5">▸</span>{r}
            </li>
          ))}
        </ul>
      )}

      {/* Trade levels */}
      <div className="border-t border-gray-800 pt-3">
        <ShortLevelsPanel
          price={q.price} dayHigh={q.dayHigh} currency={q.currency}
          bufferPct={bufferPct} maxCapPct={maxCapPct}
        />
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 text-[10px] text-gray-600 pt-1 border-t border-gray-800">
        <span className={clsx(q.goldenCross ? 'text-emerald-700' : 'text-red-700')}>
          {q.goldenCross ? '▲ Golden cross' : '▼ Death cross'}
        </span>
        <span>· SMA50: {q.aboveSma50 ? 'above' : 'below'}</span>
        <span>· SMA200: {q.aboveSma200 ? 'above' : 'below'}</span>
        {rank !== undefined && total !== undefined && (
          <span className="ml-auto text-gray-700">#{rank} of {total} · score {q.shortScore}</span>
        )}
      </div>

      <div className="border-t border-gray-800/60 pt-2">
        <NewsStrip symbol={q.symbol} />
      </div>
    </div>
  );
}

// ── Section wrapper ───────────────────────────────────────────────────────────

function Section({
  title, subtitle, icon: Icon, count, color, strong, regular, watches,
}: {
  title: string; subtitle: string;
  icon: React.ElementType; count: number; color: string;
  strong: ShortCandidate[]; regular: ShortCandidate[]; watches: ShortCandidate[];
}) {
  if (count === 0) return null;
  return (
    <section className="space-y-3">
      <div className={clsx('flex items-center gap-3 pb-2 border-b', color === 'red' ? 'border-red-900/30' : color === 'yellow' ? 'border-yellow-900/30' : 'border-purple-900/30')}>
        <Icon className={clsx('h-5 w-5', color === 'red' ? 'text-red-500' : color === 'yellow' ? 'text-yellow-500' : 'text-purple-500')} />
        <div>
          <h2 className={clsx('text-sm font-bold', color === 'red' ? 'text-red-400' : color === 'yellow' ? 'text-yellow-400' : 'text-purple-400')}>
            {title} <span className="font-normal text-gray-500 text-xs">({count})</span>
          </h2>
          <p className="text-[10px] text-gray-600">{subtitle}</p>
        </div>
      </div>

      {(strong.length > 0 || regular.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {[...strong, ...regular].map((q, i) => (
            <ShortCard key={`${q.symbol}-${q.category}`} q={q} rank={i + 1} total={strong.length + regular.length} />
          ))}
        </div>
      )}

      {watches.length > 0 && (
        <div>
          <p className="text-[10px] text-gray-600 mb-1.5 uppercase tracking-wide font-semibold">Watch — developing setups</p>
          <div className="bg-gray-900 rounded-xl border border-gray-800 divide-y divide-gray-800/50">
            {watches.map(q => (
              <div key={`${q.symbol}-${q.category}`} className="px-4 py-3 flex items-center gap-3 hover:bg-gray-800/20 transition-colors">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-white text-sm font-mono">{q.symbol}</span>
                    <span className={clsx('text-xs font-semibold', q.changePercent >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                      {q.changePercent >= 0 ? '+' : ''}{q.changePercent.toFixed(2)}%
                    </span>
                    {q.squeezeRisk && <span className="text-[9px] text-amber-500 font-semibold">⚠ SQ</span>}
                  </div>
                  <div className="text-xs text-gray-600 truncate">{q.name}</div>
                </div>
                <div className="text-xs font-mono text-gray-400 shrink-0">{fmtPrice(q.price, q.currency)}</div>
                <div className="text-xs text-gray-600 shrink-0 hidden sm:block">Vol {q.volumeRatio.toFixed(1)}×</div>
                <span className={clsx('text-[10px] font-bold px-2 py-0.5 rounded border shrink-0', SIG_STYLE.WATCH.bg, SIG_STYLE.WATCH.text)}>WATCH</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

type Market = 'US' | 'UK';

export function ShortScanner() {
  const [market,    setMarket]    = useState<Market>('US');
  const [result,    setResult]    = useState<ShortsApiResponse | null>(null);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState('');

  const load = useCallback(async (m: Market, force = false) => {
    setLoading(true);
    setError('');
    try {
      const r   = await fetch(`/api/market/shorts?market=${m}${force ? '&force=1' : ''}`, { cache: 'no-store' });
      const raw = await r.json() as ShortsApiResponse | { error: string };
      if (!r.ok || 'error' in raw) throw new Error('error' in raw ? raw.error : `HTTP ${r.status}`);
      setResult(raw as ShortsApiResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  const conviction = result?.conviction ?? [];
  const dayTrade   = result?.dayTrade   ?? [];
  const smallCap   = result?.smallCap   ?? [];
  const totalCount = conviction.length + dayTrade.length + smallCap.length;

  return (
    <div className="space-y-6">
      {/* Risk disclaimer */}
      <div className="flex items-start gap-3 px-4 py-3 bg-red-950/20 border border-red-900/30 rounded-xl text-xs text-red-400">
        <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
        <span>
          <strong>Short selling &amp; spread betting risk:</strong> Losses on short positions are theoretically unlimited if the price rises.
          Spread betting losses can exceed your deposit. Always use stop losses.
          Small cap stocks in particular can triple in hours on news — treat squeeze risk warnings seriously.
          These are technical signals only — not financial advice.
        </span>
      </div>

      {/* Controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex gap-1.5">
            {(['US', 'UK'] as const).map(m => (
              <button key={m}
                onClick={() => { setMarket(m); load(m); }}
                className={clsx('px-3 py-1.5 rounded-lg text-sm font-semibold border transition-all',
                  market === m ? 'bg-red-600/20 text-red-400 border-red-600/40' : 'text-gray-500 border-gray-700 hover:border-gray-600'
                )}
              >
                {m === 'US' ? '🇺🇸 US' : '🇬🇧 UK'}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5 text-[10px]">
            {(['STRONG_SHORT','SHORT','WATCH'] as const).map(s => (
              <span key={s} className={clsx('px-2 py-0.5 rounded border font-bold', SIG_STYLE[s].bg, SIG_STYLE[s].text)}>
                {SIG_STYLE[s].label}
              </span>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {result?.scannedAt && (
            <span className="text-xs text-gray-600">
              Scanned {new Date(result.scannedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button
            onClick={() => load(market, true)}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-lg text-xs text-gray-400 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={clsx('h-3.5 w-3.5', loading && 'animate-spin')} />
            {loading ? 'Scanning…' : 'Scan Now'}
          </button>
        </div>
      </div>

      {/* Empty / initial state */}
      {!loading && !error && !result && (
        <div className="text-center py-16 space-y-3">
          <TrendingDown className="h-10 w-10 text-gray-700 mx-auto" />
          <p className="text-gray-500 text-sm">Click <strong className="text-gray-400">Scan Now</strong> to find short candidates across {market} markets.</p>
          <p className="text-xs text-gray-700">Scans ~140 symbols across large-cap, day-trade, and small-cap universes.</p>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 px-4 py-3 bg-red-950/20 border border-red-900/30 rounded-lg">
          <AlertCircle className="h-4 w-4 text-red-400 shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center gap-2 py-16 text-gray-500">
          <RefreshCw className="h-4 w-4 animate-spin" />
          <span className="text-sm">Scanning {market} universe — conviction shorts, day trades &amp; small caps…</span>
        </div>
      )}

      {!loading && !error && result && totalCount === 0 && (
        <p className="text-center text-gray-600 text-sm py-12">No short candidates found — market conditions may be bullish across all categories.</p>
      )}

      {/* ── Three sections ── */}
      {!loading && !error && result && (
        <>
          <Section
            title="Conviction Shorts"
            subtitle="Liquid large/mid-cap stocks and ETFs with strong bearish technical setups"
            icon={TrendingDown}
            color="red"
            count={conviction.length}
            strong={conviction.filter(q => q.shortSignal === 'STRONG_SHORT')}
            regular={conviction.filter(q => q.shortSignal === 'SHORT')}
            watches={conviction.filter(q => q.shortSignal === 'WATCH')}
          />

          <Section
            title="Day Trade Shorts"
            subtitle="High-volume intraday setups — enter and close within the same session"
            icon={Zap}
            color="yellow"
            count={dayTrade.length}
            strong={dayTrade.filter(q => q.shortSignal === 'STRONG_SHORT')}
            regular={dayTrade.filter(q => q.shortSignal === 'SHORT')}
            watches={dayTrade.filter(q => q.shortSignal === 'WATCH')}
          />

          <Section
            title="Small Cap &amp; Unknown Shorts"
            subtitle="Micro/small-cap speculative stocks — higher risk, wider stops, extreme squeeze risk near 52w lows"
            icon={Search}
            color="purple"
            count={smallCap.length}
            strong={smallCap.filter(q => q.shortSignal === 'STRONG_SHORT')}
            regular={smallCap.filter(q => q.shortSignal === 'SHORT')}
            watches={smallCap.filter(q => q.shortSignal === 'WATCH')}
          />
        </>
      )}
    </div>
  );
}

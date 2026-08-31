'use client';

import { useState, useEffect } from 'react';
import { AlertTriangle, BarChart3, RefreshCw } from 'lucide-react';
import { clsx } from 'clsx';
import { Card, CardHeader } from '@/components/ui/Card';

type StrategyPerf = {
  trades: number; wins: number; winRate: number; totalPl: number;
  avgWin: number; avgLoss: number; avgPlPct: number; last30dPl: number;
  curve: Array<{ ts: string; cum: number }>;
};
type StrategyRow = { strategy: string; lifetime: StrategyPerf; currentEra?: StrategyPerf; cutoff?: string };
type ModePerf = {
  mode: string; currency: '$' | '£';
  totalPl: number; last30dPl: number; trades: number;
  strategies: StrategyRow[];
};
type Summary = { modes: ModePerf[]; error?: string };

const MODE_LABEL: Record<string, string> = {
  'paper': 'Alpaca — Paper', 'live': 'Alpaca — Live',
  'ig-demo': 'IG — Demo', 'ig-live': 'IG — Live',
  't212-demo': 'T212 — Demo', 't212-live': 'T212 — Live (ISA)',
};

function pl(v: number, cur: string): string {
  return `${v >= 0 ? '+' : '−'}${cur}${Math.abs(v).toFixed(2)}`;
}
function plColor(v: number): string {
  return v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-gray-500';
}

function Sparkline({ curve }: { curve: Array<{ ts: string; cum: number }> }) {
  if (curve.length < 2) return <span className="text-[10px] text-gray-700">—</span>;
  const w = 120, h = 28;
  const vals = curve.map(p => p.cum);
  const min = Math.min(0, ...vals), max = Math.max(0, ...vals);
  const range = max - min || 1;
  const pts = curve.map((p, i) => `${(i / (curve.length - 1)) * w},${h - ((p.cum - min) / range) * h}`).join(' ');
  const zeroY = h - ((0 - min) / range) * h;
  const last = vals[vals.length - 1];
  return (
    <svg width={w} height={h} className="overflow-visible">
      <line x1={0} y1={zeroY} x2={w} y2={zeroY} stroke="#374151" strokeWidth={0.5} strokeDasharray="2 2" />
      <polyline points={pts} fill="none" stroke={last >= 0 ? '#34d399' : '#f87171'} strokeWidth={1.5} />
    </svg>
  );
}

function PerfCells({ p, cur }: { p: StrategyPerf; cur: string }) {
  return (
    <>
      <td className="px-2 py-2 text-right tabular-nums">{p.trades}</td>
      <td className="px-2 py-2 text-right tabular-nums">{p.trades ? `${p.winRate.toFixed(0)}%` : '—'}</td>
      <td className="px-2 py-2 text-right tabular-nums text-emerald-400/80">{p.avgWin ? `${cur}${p.avgWin.toFixed(2)}` : '—'}</td>
      <td className="px-2 py-2 text-right tabular-nums text-red-400/80">{p.avgLoss ? `${cur}${p.avgLoss.toFixed(2)}` : '—'}</td>
      <td className={clsx('px-2 py-2 text-right tabular-nums font-semibold', plColor(p.last30dPl))}>{pl(p.last30dPl, cur)}</td>
      <td className={clsx('px-2 py-2 text-right tabular-nums font-bold', plColor(p.totalPl))}>{pl(p.totalPl, cur)}</td>
      <td className="px-2 py-2"><Sparkline curve={p.curve} /></td>
    </>
  );
}

export default function PerformancePage() {
  const [data, setData]   = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const fetchIt = async () => {
      try {
        const res = await fetch('/api/performance');
        const d = await res.json() as Summary;
        if (!alive) return;
        if (d.error) { setError(d.error); return; }
        setData(d);
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Failed to load');
      }
    };
    void fetchIt();
    const t = setInterval(() => { void fetchIt(); }, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  return (
    <main className="max-w-screen-2xl mx-auto px-4 py-6 space-y-4">
      <div className="flex items-baseline gap-3 mb-2 flex-wrap">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-amber-400" />
          <h1 className="text-xl font-bold text-white">Bot Performance</h1>
        </div>
        <span className="text-xs text-gray-500">
          Every bot&apos;s closed trades, rolled up from all journals. Where a strategy was materially rewritten, &quot;current era&quot; shows only trades since the rewrite — the row to judge it by.
        </span>
      </div>

      {error && (
        <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-xs text-red-400">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {!data && !error && (
        <div className="flex items-center gap-2 text-xs text-gray-500 py-8 justify-center">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Loading journals…
        </div>
      )}

      {/* Per-account totals */}
      {data && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {data.modes.map(m => (
            <div key={m.mode} className="rounded-xl border border-gray-800 bg-gray-900/60 p-3">
              <p className="text-[10px] text-gray-500 uppercase tracking-wide">{MODE_LABEL[m.mode] ?? m.mode}</p>
              <p className={clsx('text-lg font-bold tabular-nums mt-1', plColor(m.totalPl))}>{pl(m.totalPl, m.currency)}</p>
              <p className="text-[10px] text-gray-600 mt-0.5">{m.trades} closed · 30d {pl(m.last30dPl, m.currency)}</p>
            </div>
          ))}
        </div>
      )}

      {data?.modes.map(m => (
        <Card key={m.mode}>
          <CardHeader
            title={MODE_LABEL[m.mode] ?? m.mode}
            subtitle={`${m.trades} closed trades · lifetime ${pl(m.totalPl, m.currency)}`}
            icon={<BarChart3 className="h-4 w-4" />}
          />
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] text-gray-300">
              <thead>
                <tr className="text-gray-500 border-b border-gray-800 text-left">
                  <th className="px-2 py-2 font-medium">Strategy</th>
                  <th className="px-2 py-2 font-medium text-right">Trades</th>
                  <th className="px-2 py-2 font-medium text-right">Win rate</th>
                  <th className="px-2 py-2 font-medium text-right">Avg win</th>
                  <th className="px-2 py-2 font-medium text-right">Avg loss</th>
                  <th className="px-2 py-2 font-medium text-right">Last 30d</th>
                  <th className="px-2 py-2 font-medium text-right">Total P&L</th>
                  <th className="px-2 py-2 font-medium">Equity</th>
                </tr>
              </thead>
              <tbody>
                {m.strategies.map(s => (
                  <>
                    <tr key={s.strategy} className="border-b border-gray-800/50">
                      <td className="px-2 py-2 font-semibold text-white">
                        {s.strategy}
                        {s.cutoff && <span className="ml-2 text-[9px] text-gray-600 font-normal">lifetime (incl. pre-rewrite)</span>}
                      </td>
                      <PerfCells p={s.lifetime} cur={m.currency} />
                    </tr>
                    {s.currentEra && (
                      <tr key={`${s.strategy}-era`} className="border-b border-gray-800/50 bg-sky-500/5">
                        <td className="px-2 py-2 pl-5 text-sky-300">
                          ↳ current era <span className="text-[9px] text-gray-600">since {s.cutoff?.slice(0, 10)}</span>
                        </td>
                        <PerfCells p={s.currentEra} cur={m.currency} />
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}

      {data && data.modes.length === 0 && (
        <p className="text-xs text-gray-600 py-8 text-center">No closed trades in any journal yet.</p>
      )}
    </main>
  );
}

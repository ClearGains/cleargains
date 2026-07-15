'use client';

import { useCallback, useEffect, useState } from 'react';
import { NotebookPen, RefreshCw, TrendingUp, TrendingDown, AlertTriangle } from 'lucide-react';
import { clsx } from 'clsx';
import { Card, CardHeader } from '@/components/ui/Card';

type JournalEvent = {
  id:       string;
  ts:       string;
  mode:     'paper' | 'live';
  event:    'entry' | 'exit';
  symbol:   string;
  strategy: string;
  side:     'long' | 'short';
  qty:      number;
  price:    number;
  reason:   string;
  plUsd?:   number;
  plPct?:   number;
};

type StrategyAggregate = {
  strategy:   string;
  entries:    number;
  exits:      number;
  wins:       number;
  losses:     number;
  totalPlUsd: number;
  avgPlPct:   number;
  winRate:    number;
};

const STRATEGY_LABELS: Record<string, string> = {
  rsi_mean_reversion:  'RSI Mean Reversion',
  ema_crossover:       'EMA Crossover',
  orb:                 'Opening Range Breakout',
  vwap:                'VWAP Reversion',
  weekly_momentum:     'Weekly Momentum',
  options_directional: 'Options Directional',
};

function fmtUsd(v: number) {
  return `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

export default function BotJournalPage() {
  const [mode, setMode] = useState<'paper' | 'live'>('paper');
  const [records, setRecords] = useState<JournalEvent[]>([]);
  const [aggregates, setAggregates] = useState<StrategyAggregate[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (m: 'paper' | 'live') => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/alpaca?mode=${m}&action=journal`);
      const data = await res.json() as { records?: JournalEvent[]; aggregates?: StrategyAggregate[]; error?: string };
      if (!res.ok || data.error) {
        setError(data.error ?? `Journal fetch failed (${res.status})`);
        setRecords([]); setAggregates([]);
      } else {
        setRecords(data.records ?? []);
        setAggregates(data.aggregates ?? []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Fetch failed');
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(mode); }, [mode, load]);

  const totalPl = aggregates.reduce((s, a) => s + a.totalPlUsd, 0);
  const totalExits = aggregates.reduce((s, a) => s + a.exits, 0);

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <NotebookPen className="h-6 w-6 text-indigo-400" />
            Bot Journal
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Every bot trade, persisted across restarts — see which strategies actually make money
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg overflow-hidden border border-gray-700 text-xs">
            {(['paper', 'live'] as const).map(m => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={clsx(
                  'px-3 py-1.5 font-medium capitalize',
                  mode === m
                    ? m === 'live' ? 'bg-rose-600 text-white' : 'bg-indigo-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700',
                )}
              >
                {m === 'live' ? '🔴 Live' : '📄 Paper'}
              </button>
            ))}
          </div>
          <button
            onClick={() => { void load(mode); }}
            className="p-2 rounded bg-gray-800 hover:bg-gray-700 text-gray-400"
            title="Refresh"
          >
            <RefreshCw className={clsx('w-4 h-4', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-4 py-3 mb-6 flex items-start gap-3">
          <AlertTriangle className="h-4 w-4 text-yellow-500 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-yellow-400">
            {error} — the journal lives on the bot server; make sure it&apos;s running and reachable.
          </p>
        </div>
      )}

      {/* Per-strategy performance */}
      {aggregates.length > 0 && (
        <Card className="mb-6">
          <CardHeader
            title="Strategy Performance"
            subtitle={`${totalExits} closed trades · ${fmtUsd(totalPl)} total realized P&L`}
          />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-500 text-left">
                <tr>
                  <th className="py-2 pr-3">Strategy</th>
                  <th className="pr-3 text-right">Closed</th>
                  <th className="pr-3 text-right">Win rate</th>
                  <th className="pr-3 text-right">Avg P&L</th>
                  <th className="pr-3 text-right">Total P&L</th>
                  <th className="text-right">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {aggregates.map(a => (
                  <tr key={a.strategy} className="border-t border-gray-800">
                    <td className="py-2.5 pr-3 text-gray-200 font-medium">
                      {STRATEGY_LABELS[a.strategy] ?? a.strategy}
                      <span className="text-gray-600 text-xs ml-2">{a.entries} entries</span>
                    </td>
                    <td className="pr-3 text-right font-mono text-gray-300">{a.exits}</td>
                    <td className={clsx('pr-3 text-right font-mono', a.winRate >= 50 ? 'text-emerald-400' : 'text-gray-300')}>
                      {a.exits ? `${a.winRate.toFixed(0)}%` : '—'}
                    </td>
                    <td className={clsx('pr-3 text-right font-mono', a.avgPlPct >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                      {a.exits ? `${a.avgPlPct >= 0 ? '+' : ''}${a.avgPlPct.toFixed(2)}%` : '—'}
                    </td>
                    <td className={clsx('pr-3 text-right font-mono font-bold', a.totalPlUsd >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                      {fmtUsd(a.totalPlUsd)}
                    </td>
                    <td className="text-right">
                      {a.exits >= 10 ? (
                        a.totalPlUsd > 0
                          ? <TrendingUp className="h-4 w-4 text-emerald-400 inline" />
                          : <TrendingDown className="h-4 w-4 text-rose-400 inline" />
                      ) : (
                        <span className="text-[10px] text-gray-600">need {10 - a.exits} more</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Trade log */}
      <Card>
        <CardHeader title="Trade Log" subtitle={`${records.length} most recent events`} />
        {records.length === 0 && !error ? (
          <div className="text-center text-gray-600 text-sm py-8">
            No trades recorded yet — the journal fills as the bot trades
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[32rem] overflow-y-auto">
            <table className="w-full text-xs font-mono">
              <thead className="text-gray-500 text-left sticky top-0 bg-[#111118]">
                <tr>
                  <th className="py-2 pr-3">Time</th>
                  <th className="pr-3">Event</th>
                  <th className="pr-3">Symbol</th>
                  <th className="pr-3">Strategy</th>
                  <th className="pr-3 text-right">Qty</th>
                  <th className="pr-3 text-right">Price</th>
                  <th className="pr-3 text-right">P&L</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {records.map(r => (
                  <tr key={r.id} className="border-t border-gray-800/60">
                    <td className="py-1.5 pr-3 text-gray-500 whitespace-nowrap">{r.ts.slice(0, 16).replace('T', ' ')}</td>
                    <td className={clsx('pr-3', r.event === 'entry' ? 'text-blue-400' : 'text-purple-400')}>
                      {r.event === 'entry' ? `▶ ${r.side}` : '◀ exit'}
                    </td>
                    <td className="pr-3 text-white">{r.symbol}</td>
                    <td className="pr-3 text-gray-400">{STRATEGY_LABELS[r.strategy] ?? r.strategy}</td>
                    <td className="pr-3 text-right text-gray-300">{r.qty}</td>
                    <td className="pr-3 text-right text-gray-300">{r.price.toFixed(2)}</td>
                    <td className={clsx('pr-3 text-right', (r.plUsd ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                      {r.plUsd !== undefined ? fmtUsd(r.plUsd) : ''}
                    </td>
                    <td className="text-gray-500 max-w-[16rem] truncate" title={r.reason}>{r.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

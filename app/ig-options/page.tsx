'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Power, AlertTriangle, RefreshCw, TrendingUp, Clock, Brain, Shield } from 'lucide-react';
import { clsx } from 'clsx';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

type Mode = 'demo' | 'live';

type Tracked = {
  dealId: string; epic: string; underlyingEpic: string; name: string;
  optionType: 'call' | 'put'; strike: number; expiry: string; expiryMs: number;
  premium: number; size: number; enteredAt: number; peakPlPct: number;
};
type Position = { dealId: string; epic: string; instrumentName: string; direction: 'BUY' | 'SELL'; size: number; level: number; upl: number; bid?: number | null };
type LogEntry = { id: string; ts: string; type: 'info' | 'enter' | 'exit' | 'wait' | 'error'; epic: string; msg: string };

type Status = {
  running: boolean; underlyings: string[]; log: LogEntry[];
  nextRunMs: number | null; lastPollTs: string | null;
  tracked: Record<string, Tracked>; positions?: Position[];
  error?: string;
};

function relTime(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.round((ms - Date.now()) / 1000);
  if (s <= 0) return 'due now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
function agoTime(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
function logColor(type: LogEntry['type']): string {
  switch (type) {
    case 'enter': return 'text-emerald-400';
    case 'exit':  return 'text-amber-400';
    case 'error': return 'text-red-400';
    case 'wait':  return 'text-gray-500';
    default:      return 'text-sky-400';
  }
}

export default function IgOptionsPage() {
  const [mode, setMode]       = useState<Mode>('demo');
  const [status, setStatus]   = useState<Status | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res  = await fetch(`/api/ig-options/bot?mode=${mode}`);
      const data = await res.json() as Status & { ok?: boolean };
      if (data.error) { setError(data.error); return; }
      setStatus(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reach bot server');
    }
  }, [mode]);

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    void fetchStatus();
    pollRef.current = setInterval(() => { void fetchStatus(); }, 10_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchStatus]);

  const post = async (action: 'start' | 'stop') => {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch(`/api/ig-options/bot?mode=${mode}&action=${action}`, { method: 'POST' });
      const data = await res.json() as { ok: boolean; error?: string };
      if (!data.ok && data.error) setError(data.error);
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  };

  const posByDealId = new Map((status?.positions ?? []).map(p => [p.dealId, p]));
  const tracked = Object.values(status?.tracked ?? {});

  return (
    <main className="max-w-screen-2xl mx-auto px-4 py-6 space-y-4">

      <div className="flex items-baseline gap-3 mb-2 flex-wrap">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-teal-400" />
          <h1 className="text-xl font-bold text-white">IG Options Bot</h1>
        </div>
        <span className="text-xs text-gray-500">
          Trend-following monthly index options (FTSE, US 500, Wall Street, Germany 40) — buys calls in confirmed uptrends, puts in confirmed downtrends, AI-confirmed entries. Max loss per trade is the premium paid, capped by construction.
        </span>
      </div>

      {/* Demo / Live tabs */}
      <div className="flex border-b border-gray-800">
        {(['demo', 'live'] as const).map(tab => (
          <button key={tab}
            onClick={() => setMode(tab)}
            className={clsx(
              'relative px-6 py-3 text-sm font-semibold transition-all',
              mode === tab
                ? tab === 'live'
                  ? 'text-red-300 after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-red-400'
                  : 'text-teal-300 after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-teal-400'
                : 'text-gray-500 hover:text-gray-300',
            )}>
            {tab === 'live' ? (
              <span className="flex items-center gap-2">
                Live
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-500/30">REAL MONEY</span>
              </span>
            ) : 'Demo'}
          </button>
        ))}
      </div>

      {/* Controls */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 text-xs text-gray-500">
          {status?.running && (
            <span className="flex items-center gap-1.5 text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" /> Running
            </span>
          )}
          {status && !status.running && <span className="text-gray-500">Stopped</span>}
          {status?.lastPollTs && <span>Last check {agoTime(status.lastPollTs)}</span>}
          {status?.running && status.nextRunMs !== null && (
            <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> Next in {relTime(status.nextRunMs)}</span>
          )}
          <span className="flex items-center gap-1 text-sky-400"><Brain className="h-3 w-3" /> AI-confirmed entries (70%+)</span>
          <span className="flex items-center gap-1 text-teal-400"><Shield className="h-3 w-3" /> Risk = premium only, no stop needed</span>
        </div>
        <Button
          onClick={() => void post(status?.running ? 'stop' : 'start')}
          loading={loading}
          variant={status?.running ? 'danger' : 'primary'}
          icon={<Power className="h-4 w-4" />}
        >
          {status?.running ? 'Stop Bot' : 'Start Bot'}
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-xs text-red-400">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        <div className="lg:col-span-1 space-y-4">
          <Card>
            <CardHeader title="Underlyings scanned" subtitle={`${status?.underlyings?.length ?? 0} instrument(s)`} icon={<TrendingUp className="h-4 w-4" />} />
            <div className="flex flex-wrap gap-1.5">
              {(status?.underlyings ?? []).map(u => (
                <span key={u} className="text-[10px] text-gray-500 bg-gray-800/80 border border-gray-700/50 rounded px-1.5 py-0.5">{u}</span>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader title="Open option positions" subtitle={`${tracked.length} open`} icon={<TrendingUp className="h-4 w-4" />} />
            {tracked.length === 0 ? (
              <p className="text-xs text-gray-600 py-4 text-center">No positions open</p>
            ) : (
              <div className="space-y-2">
                {tracked.map(t => {
                  const p = posByDealId.get(t.dealId);
                  const pl = p?.upl ?? 0;
                  const bid = typeof p?.bid === 'number' ? p.bid : null;
                  const plPct = bid !== null && t.premium > 0 ? ((bid - t.premium) / t.premium) * 100 : null;
                  const dte = Math.max(0, (t.expiryMs - Date.now()) / 86_400_000);
                  return (
                    <div key={t.dealId} className="rounded-lg border border-gray-800 bg-gray-900/60 p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-bold text-white">{t.name}</span>
                        <span className={clsx('text-xs font-semibold tabular-nums', pl >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                          {pl >= 0 ? '+' : ''}£{pl.toFixed(2)}{plPct !== null ? ` (${plPct >= 0 ? '+' : ''}${plPct.toFixed(0)}%)` : ''}
                        </span>
                      </div>
                      <p className="text-[10px] text-gray-500 mt-0.5">
                        {t.optionType.toUpperCase()} · premium {t.premium.toFixed(1)} × {t.size}/pt · max loss £{(t.premium * t.size).toFixed(2)} · {dte.toFixed(0)}d to {t.expiry}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>

        <div className="lg:col-span-2">
          <Card>
            <CardHeader title="Activity" icon={<RefreshCw className="h-4 w-4" />} />
            {!status?.log?.length ? (
              <p className="text-xs text-gray-600 py-8 text-center">No activity yet</p>
            ) : (
              <div className="space-y-1 max-h-[70vh] overflow-y-auto font-mono text-[11px]">
                {status.log.map(l => (
                  <div key={l.id} className="flex gap-2 py-1 border-b border-gray-800/50">
                    <span className="text-gray-600 flex-shrink-0">{l.ts}</span>
                    <span className={clsx('flex-shrink-0 w-10 uppercase', logColor(l.type))}>{l.type}</span>
                    {l.epic !== '—' && <span className="text-gray-400 flex-shrink-0 w-24 truncate">{l.epic}</span>}
                    <span className="text-gray-300">{l.msg}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

      </div>
    </main>
  );
}

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Power, AlertTriangle, RefreshCw, Flame, Clock, ShieldCheck, Coins } from 'lucide-react';
import { clsx } from 'clsx';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

type TrackedPosition = {
  mint: string; symbol: string; pairAddress: string; chainId: string;
  costSol: number; qtyRaw: string; enteredAt: number; peakPlPct: number;
  rugStrikes: number; entryReason: string;
};
type LogEntry = { id: string; ts: string; type: 'info' | 'enter' | 'exit' | 'wait' | 'error'; symbol: string; msg: string };

type Status = {
  running: boolean; balanceSol: number; tracked: Record<string, TrackedPosition>;
  log: LogEntry[]; nextScanMs: number | null; lastScanTs: string | null;
  lunarcrushConfigured: boolean; redditConfigured: boolean;
  error?: string;
};

function relTime(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.round((ms - Date.now()) / 1000);
  if (s <= 0) return 'due now';
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m`;
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

export default function MemeCoinBotPage() {
  const [status, setStatus]   = useState<Status | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res  = await fetch('/api/meme-coin/bot');
      const data = await res.json() as Status & { ok?: boolean };
      if (data.error) { setError(data.error); return; }
      setStatus(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reach bot server');
    }
  }, []);

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    void fetchStatus();
    pollRef.current = setInterval(() => { void fetchStatus(); }, 8_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchStatus]);

  const post = async (action: 'start' | 'stop') => {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch(`/api/meme-coin/bot?action=${action}`, { method: 'POST' });
      const data = await res.json() as { ok: boolean; error?: string };
      if (!data.ok && data.error) setError(data.error);
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  };

  const tracked = Object.values(status?.tracked ?? {});

  return (
    <main className="max-w-screen-2xl mx-auto px-4 py-6 space-y-4">

      <div className="flex items-baseline gap-3 mb-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Flame className="h-5 w-5 text-orange-400" />
          <h1 className="text-xl font-bold text-white">Meme Coin Bot</h1>
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-400 border border-sky-500/30">PAPER ONLY</span>
        </div>
        <span className="text-xs text-gray-500">
          Brand-new, social-hype Solana tokens (pump.fun-style). Every fill — entry and exit — comes from a live Jupiter quote for the exact size, never a reference price, so a dead pool shows up as a failed quote, not an invented one.
        </span>
      </div>

      {/* Controls */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 text-xs text-gray-500 flex-wrap">
          {status?.running && (
            <span className="flex items-center gap-1.5 text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" /> Running
            </span>
          )}
          {status && !status.running && <span className="text-gray-500">Stopped</span>}
          {status?.lastScanTs && <span>Last scan {agoTime(status.lastScanTs)}</span>}
          {status?.running && status.nextScanMs !== null && (
            <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> Next scan in {relTime(status.nextScanMs)}</span>
          )}
          <span className="flex items-center gap-1 text-teal-400">
            <Coins className="h-3 w-3" /> {status ? status.balanceSol.toFixed(3) : '—'} SOL paper balance
          </span>
          <span className={clsx('flex items-center gap-1', status?.lunarcrushConfigured ? 'text-emerald-400' : 'text-gray-600')}>
            <ShieldCheck className="h-3 w-3" /> LunarCrush {status?.lunarcrushConfigured ? 'active' : 'not configured (using DexScreener proxy)'}
          </span>
          <span className={clsx('flex items-center gap-1', status?.redditConfigured ? 'text-emerald-400' : 'text-gray-600')}>
            <ShieldCheck className="h-3 w-3" /> Reddit {status?.redditConfigured ? 'active' : 'not configured'}
          </span>
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
            <CardHeader title="Open positions" subtitle={`${tracked.length} open`} icon={<Flame className="h-4 w-4" />} />
            {tracked.length === 0 ? (
              <p className="text-xs text-gray-600 py-4 text-center">No positions open</p>
            ) : (
              <div className="space-y-2">
                {tracked.map(t => {
                  const heldHours = (Date.now() - t.enteredAt) / 3_600_000;
                  return (
                    <div key={t.mint} className="rounded-lg border border-gray-800 bg-gray-900/60 p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-bold text-white">{t.symbol}</span>
                        <span className={clsx('text-xs font-semibold tabular-nums', t.peakPlPct >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                          peak +{t.peakPlPct.toFixed(0)}%
                        </span>
                      </div>
                      <p className="text-[10px] text-gray-500 mt-0.5">
                        {t.costSol} SOL in · {heldHours.toFixed(1)}h held
                        {t.rugStrikes > 0 && <span className="text-red-400"> · ⚠ {t.rugStrikes} liquidity strike(s)</span>}
                      </p>
                      <p className="text-[10px] text-gray-600 mt-1 truncate" title={t.entryReason}>{t.entryReason}</p>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="How this works" icon={<ShieldCheck className="h-4 w-4" />} />
            <ul className="text-[10px] text-gray-500 space-y-1.5 list-disc pl-4">
              <li>Discovery: DexScreener boosted Solana tokens, filtered for real organic volume/txn velocity (not just paid promotion)</li>
              <li>Safety: RugCheck + GoPlus combined hard veto — mint/freeze authority, known rug flags, composite risk score</li>
              <li>Hype: LunarCrush score when configured, DexScreener volume proxy otherwise, Reddit mentions as a supplementary signal</li>
              <li>Entry/exit: every fill priced from a live Jupiter quote — a failed quote is a failed trade, never an invented price</li>
              <li>Exit: fixed 50% profit floor (protects once earned, runs free above it), 2-strike rug confirmation, 48h max hold</li>
            </ul>
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
                    {l.symbol !== '—' && <span className="text-gray-400 flex-shrink-0 w-20 truncate">{l.symbol}</span>}
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

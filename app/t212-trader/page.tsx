'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Power, AlertTriangle, RefreshCw, TrendingUp, TrendingDown,
  Lock, Sparkles, Clock, Wallet, Brain,
} from 'lucide-react';
import { clsx } from 'clsx';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

// ── Types (mirrors bot-server's t212Bot.ts status shape) ────────────────────

type T212Mode = 'demo' | 'live';

type T212Position = {
  ticker:          string;
  quantity:        number;
  averagePrice:    number;
  currentPrice?:   number;
  ppl?:            number;
};

type BotOpenedEntry = {
  enteredAt:  number;
  budgetGbp:  number;
  avgPrice:   number;
  lastVerdict?: { action: string; confidence: number; reason: string; engine: string; at: number };
  aiReviewPaused?: boolean;
};

type LogEntry = { id: string; ts: string; type: 'info' | 'enter' | 'exit' | 'wait' | 'error'; symbol: string; msg: string };

type T212Status = {
  running:      boolean;
  log:          LogEntry[];
  nextRunMs:    number | null;
  lastPollTs:   string | null;
  preExisting:  string[];
  botOpened:    Record<string, BotOpenedEntry>;
  cash?:        { free: number; total: number };
  positions?:   T212Position[];
  aiPaused:     boolean;
  totalBudgetGbp: number;
  error?:       string;
};

// ── Helpers ───────────────────────────────────────────────────────────────

function tickerName(t: string): string { return t.replace(/_[A-Z]{2}_EQ$/, '').replace(/l$/, ''); }

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

// ── Page ──────────────────────────────────────────────────────────────────

export default function T212TraderPage() {
  const [mode, setMode]       = useState<T212Mode>('live');
  const [status, setStatus]   = useState<T212Status | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res  = await fetch(`/api/t212/bot?mode=${mode}`);
      const data = await res.json() as T212Status & { ok?: boolean };
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
      const res  = await fetch(`/api/t212/bot?mode=${mode}&action=${action}`, { method: 'POST' });
      const data = await res.json() as { ok: boolean; error?: string };
      if (!data.ok && data.error) setError(data.error);
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  };

  const toggleAiPaused = async () => {
    try {
      await fetch(`/api/t212/bot?mode=${mode}&action=ai-pause`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ paused: !status?.aiPaused }),
      });
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
    }
  };

  const togglePositionAiPaused = async (ticker: string, currentlyPaused: boolean) => {
    try {
      await fetch(`/api/t212/bot?mode=${mode}&action=position-ai-pause&ticker=${encodeURIComponent(ticker)}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ paused: !currentlyPaused }),
      });
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
    }
  };

  const [budgetInput, setBudgetInput] = useState('');
  const [budgetSaving, setBudgetSaving] = useState(false);
  const updateBudget = async () => {
    const gbp = Number(budgetInput);
    if (!Number.isFinite(gbp) || gbp <= 0) { setError('Enter a valid budget amount'); return; }
    setBudgetSaving(true);
    setError(null);
    try {
      const res  = await fetch(`/api/t212/bot?mode=${mode}&action=budget`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ gbp }),
      });
      const data = await res.json() as { ok: boolean; error?: string };
      if (!data.ok) { setError(data.error ?? 'Failed to update budget'); return; }
      setBudgetInput('');
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setBudgetSaving(false);
    }
  };

  const posByTicker = new Map((status?.positions ?? []).map(p => [p.ticker, p]));
  const preExisting  = status?.preExisting ?? [];
  const botOpened    = status?.botOpened ?? {};
  const budgetUsed   = Object.values(botOpened).reduce((s, e) => s + e.budgetGbp, 0);

  return (
    <main className="max-w-screen-2xl mx-auto px-4 py-6 space-y-4">

      <div className="flex items-baseline gap-3 mb-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-purple-400" />
          <h1 className="text-xl font-bold text-white">T212 Stocks ISA Bot</h1>
        </div>
        <span className="text-xs text-gray-500">
          Fully autonomous, long-horizon (months-to-years) selection — trend + news backing, not swing timing. Never touches your pre-existing holdings.
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
                  : 'text-purple-300 after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-purple-400'
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
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => void toggleAiPaused()}
            variant={status?.aiPaused ? 'danger' : 'secondary'}
            icon={<Brain className="h-4 w-4" />}
          >
            {status?.aiPaused ? 'AI Paused — Resume' : 'Pause AI'}
          </Button>
          <Button
            onClick={() => void post(status?.running ? 'stop' : 'start')}
            loading={loading}
            variant={status?.running ? 'danger' : 'primary'}
            icon={<Power className="h-4 w-4" />}
          >
            {status?.running ? 'Stop Bot' : 'Start Bot'}
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-xs text-red-400">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* Left: budget + bot-opened + pre-existing */}
        <div className="lg:col-span-1 space-y-4">

          <Card>
            <CardHeader title="Account" icon={<Wallet className="h-4 w-4" />} />
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-[10px] text-gray-500 uppercase tracking-wider">Free cash</p>
                <p className="text-white font-bold tabular-nums">£{status?.cash?.free.toFixed(0) ?? '—'}</p>
              </div>
              <div>
                <p className="text-[10px] text-gray-500 uppercase tracking-wider">Total value</p>
                <p className="text-white font-bold tabular-nums">£{status?.cash?.total.toFixed(0) ?? '—'}</p>
              </div>
              <div className="col-span-2 pt-1 border-t border-gray-800">
                <p className="text-[10px] text-gray-500 uppercase tracking-wider">Bot budget deployed</p>
                <p className="text-white font-semibold tabular-nums">£{budgetUsed.toFixed(0)} / £{(status?.totalBudgetGbp ?? 3000).toLocaleString()}</p>
              </div>
              <div className="col-span-2 pt-2">
                <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">
                  Set total budget {status?.cash?.total !== undefined && <span className="text-gray-600">(up to £{status.cash.total.toFixed(0)} balance)</span>}
                </p>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={status?.cash?.total}
                    placeholder={`${status?.totalBudgetGbp ?? 3000}`}
                    value={budgetInput}
                    onChange={e => setBudgetInput(e.target.value)}
                    className="w-28 bg-gray-900 border border-gray-800 rounded-lg px-2 py-1.5 text-sm text-white tabular-nums focus:outline-none focus:border-purple-500/50"
                  />
                  <Button onClick={() => void updateBudget()} loading={budgetSaving} variant="secondary">
                    Update
                  </Button>
                </div>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Bot-opened positions" subtitle={`${Object.keys(botOpened).length} open`} icon={<TrendingUp className="h-4 w-4" />} />
            {Object.keys(botOpened).length === 0 ? (
              <p className="text-xs text-gray-600 py-4 text-center">No positions opened yet</p>
            ) : (
              <div className="space-y-2">
                {Object.entries(botOpened).map(([ticker, e]) => {
                  const pos = posByTicker.get(ticker);
                  const pl = pos?.ppl ?? 0;
                  return (
                    <div key={ticker} className="rounded-lg border border-gray-800 bg-gray-900/60 p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-bold text-white">{tickerName(ticker)}</span>
                        <span className={clsx('text-xs font-semibold tabular-nums', pl >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                          {pl >= 0 ? '+' : ''}£{pl.toFixed(2)}
                        </span>
                      </div>
                      <p className="text-[10px] text-gray-500 mt-0.5">£{e.budgetGbp} · opened {agoTime(new Date(e.enteredAt).toISOString())}</p>
                      {e.lastVerdict && (
                        <p className="text-[10px] text-gray-600 mt-1 truncate" title={e.lastVerdict.reason}>
                          Last check ({e.lastVerdict.engine}): {e.lastVerdict.action} {e.lastVerdict.confidence}% — {e.lastVerdict.reason}
                        </p>
                      )}
                      <button
                        onClick={() => void togglePositionAiPaused(ticker, !!e.aiReviewPaused)}
                        className={clsx(
                          'mt-2 flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border',
                          e.aiReviewPaused
                            ? 'text-amber-300 bg-amber-500/10 border-amber-500/30'
                            : 'text-sky-300 bg-sky-500/10 border-sky-500/30 hover:bg-sky-500/20',
                        )}
                      >
                        <Brain className="h-3 w-3" />
                        {e.aiReviewPaused ? 'AI watch paused — resume' : 'AI watching — pause'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="Your existing holdings" subtitle={`${preExisting.length} protected — never sold by the bot`} icon={<Lock className="h-4 w-4" />} />
            <div className="flex flex-wrap gap-1.5">
              {preExisting.map(t => (
                <span key={t} className="text-[10px] text-gray-500 bg-gray-800/80 border border-gray-700/50 rounded px-1.5 py-0.5">{tickerName(t)}</span>
              ))}
            </div>
          </Card>

        </div>

        {/* Right: log */}
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
                    {l.symbol !== '—' && <span className="text-gray-400 flex-shrink-0 w-14 truncate">{l.symbol}</span>}
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

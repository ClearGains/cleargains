'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Play, Pause, Square, Activity, AlertTriangle, Server, Wifi, WifiOff, RefreshCw } from 'lucide-react';
import { clsx } from 'clsx';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { DEFAULT_WATCHLIST } from '@/lib/igStrategyEngine';

const AVAILABLE_INSTRUMENTS = DEFAULT_WATCHLIST.filter(m => m.enabled).map(m => ({ epic: m.epic, name: m.name }));
const ALL_EPICS = AVAILABLE_INSTRUMENTS.map(m => m.epic);
const POLL_INTERVAL = 5_000;

type AccountKey = 'demo' | 'live';

type LogEntry = {
  id:   string;
  ts:   string;
  type: 'info' | 'enter' | 'exit' | 'hold' | 'wait' | 'error' | 'cooldown';
  epic: string;
  msg:  string;
};

type EpicStatus = {
  state:        string;
  entryPrice:   number;
  pnlPct:       number | null;
  lastPrice:    number;
  reds:         number;
  formingIsRed: boolean | null;
};

type BotStatus = {
  running:         boolean;
  paused:          boolean;
  streamConnected: boolean;
  epics:           string[];
  recentLosses:    number;
  epicStatuses:    Record<string, EpicStatus>;
  log:             LogEntry[];
  sessionOk:       boolean;
  sessionExpiry:   string | null;
};

const logTypeStyle: Record<LogEntry['type'], string> = {
  enter:    'text-emerald-400',
  exit:     'text-red-400',
  hold:     'text-gray-400',
  wait:     'text-gray-500',
  error:    'text-red-500 font-semibold',
  cooldown: 'text-yellow-400',
  info:     'text-blue-400',
};

// ── Per-account panel ─────────────────────────────────────────────────────────

function AccountPanel({ account, serverOnline }: { account: AccountKey; serverOnline: boolean | null }) {
  const [status, setStatus]         = useState<BotStatus | null>(null);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [selectedEpics, setSelected] = useState<string[]>(ALL_EPICS);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch(`/api/ig/bot?action=account-status&account=${account}`);
      if (!r.ok) { setError(`HTTP ${r.status}`); return; }
      const d = await r.json() as BotStatus;
      setStatus(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Fetch failed');
    }
  }, [account]);

  useEffect(() => { void fetchStatus(); }, [fetchStatus]);

  useEffect(() => {
    if (status?.running) {
      pollRef.current = setInterval(() => { void fetchStatus(); }, POLL_INTERVAL);
    } else {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [status?.running, fetchStatus]);

  async function call(action: string, body?: unknown) {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/ig/bot?action=${action}&account=${account}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const d = await r.json() as { ok?: boolean; error?: string };
      if (d.ok === false) setError(d.error ?? 'Failed');
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setLoading(false);
    }
  }

  const running = status?.running ?? false;
  const paused  = status?.paused  ?? false;
  const isLive  = account === 'live';

  return (
    <div className={clsx(
      'rounded-lg border p-4 space-y-3',
      isLive
        ? 'border-orange-500/30 bg-orange-500/5'
        : 'border-blue-500/30 bg-blue-500/5'
    )}>
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-white uppercase tracking-wider">
            {isLive ? '🔴 Live' : '🔵 Demo'}
          </span>
          <span className={clsx(
            'text-[9px] px-1.5 py-0.5 rounded font-bold border',
            running && !paused
              ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30 animate-pulse'
              : running && paused
              ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
              : 'bg-gray-700 text-gray-400 border-gray-600'
          )}>
            {running && !paused ? 'RUNNING' : running && paused ? 'PAUSED' : 'STOPPED'}
          </span>
          {status?.streamConnected === false && running && (
            <span className="text-[9px] text-yellow-400 flex items-center gap-1">
              <AlertTriangle className="h-2.5 w-2.5" /> Stream disconnected
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <button onClick={() => void fetchStatus()} className="text-gray-600 hover:text-gray-400" title="Refresh">
            <RefreshCw className="h-3 w-3" />
          </button>

          {/* Pause / Resume */}
          {running && (
            <Button
              size="sm"
              variant="ghost"
              icon={paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
              onClick={() => void call(paused ? 'account-resume' : 'account-pause')}
              disabled={loading || serverOnline === false}
            >
              {paused ? 'Resume' : 'Pause'}
            </Button>
          )}

          {/* Start / Stop */}
          <Button
            size="sm"
            variant={running ? 'danger' : isLive ? 'primary' : 'secondary'}
            icon={running ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
            onClick={() => void (running
              ? call('account-stop')
              : call('account-start', { epics: selectedEpics })
            )}
            disabled={loading || serverOnline === false || serverOnline === null}
          >
            {loading ? '...' : running ? 'Stop' : `Start ${isLive ? 'Live' : 'Demo'}`}
          </Button>
        </div>
      </div>

      {/* Live warning */}
      {isLive && !running && (
        <div className="text-[10px] text-orange-400 bg-orange-500/10 border border-orange-500/20 rounded px-2 py-1.5">
          ⚠ This trades with real money. Make sure your strategy is tested on demo first.
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="text-[10px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1.5">
          {error}
        </div>
      )}

      {/* Instrument selector — only when stopped */}
      {!running && (
        <div className="bg-gray-900/50 border border-gray-800 rounded p-2.5 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider">Instruments</p>
            <div className="flex gap-1.5">
              <button onClick={() => setSelected(ALL_EPICS)} className="text-[9px] text-gray-500 hover:text-gray-300">All</button>
              <button onClick={() => setSelected([])} className="text-[9px] text-gray-500 hover:text-gray-300">None</button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {AVAILABLE_INSTRUMENTS.map(ins => (
              <button
                key={ins.epic}
                onClick={() => setSelected(prev =>
                  prev.includes(ins.epic) ? prev.filter(e => e !== ins.epic) : [...prev, ins.epic]
                )}
                className={clsx(
                  'text-[10px] px-2 py-1 rounded border transition-all',
                  selectedEpics.includes(ins.epic)
                    ? isLive
                      ? 'bg-orange-500/20 text-orange-400 border-orange-500/40'
                      : 'bg-blue-500/20 text-blue-400 border-blue-500/40'
                    : 'bg-gray-800 text-gray-500 border-gray-700 hover:border-gray-500'
                )}
              >
                {ins.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Status grid */}
      {status && running && Object.keys(status.epicStatuses).length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Epic statuses */}
          <div className="space-y-1">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider">Positions</p>
            {Object.entries(status.epicStatuses).map(([epic, s]) => {
              const name = AVAILABLE_INSTRUMENTS.find(i => i.epic === epic)?.name ?? epic.split('.').slice(0,3).join('.');
              return (
                <div key={epic} className="flex items-center justify-between bg-gray-900/60 rounded px-2 py-1">
                  <span className="text-[10px] text-gray-300">{name}</span>
                  <div className="flex items-center gap-2 text-[10px]">
                    {s.reds > 0 && <span className="text-red-400">{s.reds}🔴</span>}
                    <span className={clsx('font-medium',
                      s.state === 'IN_POSITION' ? 'text-emerald-400' :
                      s.state === 'COOLDOWN'    ? 'text-yellow-400' : 'text-gray-400'
                    )}>{s.state}</span>
                    {s.pnlPct !== null && (
                      <span className={s.pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                        {s.pnlPct >= 0 ? '+' : ''}{s.pnlPct.toFixed(3)}%
                      </span>
                    )}
                    {s.formingIsRed !== null && (
                      <span className={s.formingIsRed ? 'text-red-400' : 'text-emerald-400'}>
                        {s.formingIsRed ? '▼' : '▲'}
                      </span>
                    )}
                    <span className="text-gray-600">{s.lastPrice > 0 ? s.lastPrice.toFixed(1) : '—'}</span>
                  </div>
                </div>
              );
            })}
            {paused && (
              <div className="text-[10px] text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded px-2 py-1 mt-1">
                ⏸ Paused — monitoring open positions, no new entries.
              </div>
            )}
            <div className="text-[10px] text-gray-600 mt-1 space-y-0.5">
              {status.sessionExpiry && (
                <div>Session {status.sessionOk ? 'valid' : 'expired'} · renews {new Date(status.sessionExpiry).toLocaleTimeString()}</div>
              )}
              {status.recentLosses > 0 && (
                <div className="text-yellow-600">⚠ {status.recentLosses} recent loss{status.recentLosses > 1 ? 'es' : ''} — cooldown auto-scaled</div>
              )}
            </div>
          </div>

          {/* Log */}
          <div>
            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Bot log</p>
            <div className="h-44 overflow-y-auto space-y-0.5 bg-gray-950/60 border border-gray-800 rounded p-2">
              {status.log.length === 0 && (
                <p className="text-[10px] text-gray-600 text-center mt-6">No entries yet</p>
              )}
              {status.log.map(entry => (
                <div key={entry.id} className="flex gap-1.5 text-[10px] font-mono">
                  <span className="text-gray-600 shrink-0">{entry.ts}</span>
                  <span className="text-gray-500 shrink-0">[{entry.epic.slice(0, 10)}]</span>
                  <span className={logTypeStyle[entry.type]}>{entry.msg}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function IGServerBot() {
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);

  const checkHealth = useCallback(async () => {
    try {
      const r = await fetch('/api/ig/bot?action=health');
      setServerOnline(r.ok);
    } catch {
      setServerOnline(false);
    }
  }, []);

  useEffect(() => { void checkHealth(); }, [checkHealth]);

  return (
    <Card className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-purple-400" />
          <span className="text-sm font-semibold text-white">Server Scalper Bot</span>
          <span className={clsx('text-[9px] flex items-center gap-1',
            serverOnline === true  ? 'text-emerald-400' :
            serverOnline === false ? 'text-red-400' : 'text-gray-500'
          )}>
            {serverOnline === true  ? <Wifi className="h-2.5 w-2.5" /> :
             serverOnline === false ? <WifiOff className="h-2.5 w-2.5" /> :
             <Activity className="h-2.5 w-2.5 animate-pulse" />}
            {serverOnline === true  ? 'Oracle VM online' :
             serverOnline === false ? 'Oracle VM offline' : 'Checking...'}
          </span>
        </div>
        <button onClick={() => void checkHealth()} className="text-gray-600 hover:text-gray-400">
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {serverOnline === false && (
        <div className="text-[10px] text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded px-3 py-2">
          Oracle VM is not reachable. Make sure the bot server is running: <code className="bg-gray-900 px-1 rounded">pm2 start ecosystem.config.cjs</code>
        </div>
      )}

      {/* Demo + Live panels */}
      <AccountPanel account="demo" serverOnline={serverOnline} />
      <AccountPanel account="live" serverOnline={serverOnline} />

      <p className="text-[9px] text-gray-600">
        Runs 24/7 on Oracle Cloud — browser and device can be closed. Credentials stored as env vars on the VM, never sent to the browser.
      </p>
    </Card>
  );
}

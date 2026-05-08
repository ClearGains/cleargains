'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Play, Square, Activity, AlertTriangle, Server, Wifi, WifiOff, RefreshCw } from 'lucide-react';
import { clsx } from 'clsx';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { DEFAULT_WATCHLIST } from '@/lib/igStrategyEngine';
import { DEFAULT_CONFIG, type ScalperConfig } from '@/lib/scalperStrategy';

const AVAILABLE_INSTRUMENTS = DEFAULT_WATCHLIST.map(m => ({ epic: m.epic, name: m.name }));

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
  streamConnected: boolean;
  epics:           string[];
  tradeSize:       number;
  config:          ScalperConfig;
  epicStatuses:    Record<string, EpicStatus>;
  log:             LogEntry[];
  sessionOk:       boolean;
  sessionExpiry:   string | null;
};

const POLL_INTERVAL = 5_000;  // poll server status every 5s when running

export function IGServerBot() {
  const [status, setStatus]           = useState<BotStatus | null>(null);
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);  // null = unknown
  const [configuring, setConfiguring] = useState(false);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState<string | null>(null);

  const [selectedEpics, setSelectedEpics] = useState<string[]>(['IX.D.FTSE.DAILY.IP']);
  const [tradeSize, setTradeSize]         = useState(0.5);
  const [config, setConfig]               = useState<ScalperConfig>(DEFAULT_CONFIG);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/ig/bot?action=status');
      if (!r.ok) {
        const d = await r.json() as { error?: string };
        setError(d.error ?? `HTTP ${r.status}`);
        setServerOnline(false);
        return;
      }
      const d = await r.json() as BotStatus;
      setStatus(d);
      setServerOnline(true);
      setError(null);
    } catch (e) {
      setServerOnline(false);
      setError(e instanceof Error ? e.message : 'Cannot reach bot server');
    }
  }, []);

  const checkHealth = useCallback(async () => {
    try {
      const r = await fetch('/api/ig/bot?action=health');
      setServerOnline(r.ok);
      if (!r.ok) setError(`Bot server returned ${r.status}`);
      else setError(null);
    } catch {
      setServerOnline(false);
    }
  }, []);

  // Initial health check + status fetch
  useEffect(() => {
    void checkHealth();
    void fetchStatus();
  }, [checkHealth, fetchStatus]);

  // Poll while bot is running
  useEffect(() => {
    if (status?.running) {
      pollRef.current = setInterval(() => { void fetchStatus(); }, POLL_INTERVAL);
    } else {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [status?.running, fetchStatus]);

  async function handleStart() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/ig/bot?action=start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ epics: selectedEpics, tradeSize, config }),
      });
      const d = await r.json() as { ok: boolean; error?: string };
      if (!d.ok) { setError(d.error ?? 'Start failed'); return; }
      await fetchStatus();
      setConfiguring(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Start failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleStop() {
    setLoading(true);
    try {
      await fetch('/api/ig/bot?action=stop', { method: 'POST' });
      await fetchStatus();
    } finally {
      setLoading(false);
    }
  }

  const logTypeStyle: Record<LogEntry['type'], string> = {
    enter:    'text-emerald-400',
    exit:     'text-red-400',
    hold:     'text-gray-400',
    wait:     'text-gray-500',
    error:    'text-red-500 font-semibold',
    cooldown: 'text-yellow-400',
    info:     'text-blue-400',
  };

  const running = status?.running ?? false;

  return (
    <Card className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-purple-400" />
          <span className="text-sm font-semibold text-white">Server Scalper Bot</span>
          <span className={clsx(
            'text-[9px] px-1.5 py-0.5 rounded font-bold border',
            running
              ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30 animate-pulse'
              : 'bg-gray-700 text-gray-400 border-gray-600'
          )}>
            {running ? 'LIVE' : 'STOPPED'}
          </span>

          {/* Server online indicator */}
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

          {status?.streamConnected === false && running && (
            <span className="text-[9px] text-yellow-400 flex items-center gap-1">
              <AlertTriangle className="h-2.5 w-2.5" /> Stream disconnected
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button onClick={() => void fetchStatus()} className="text-gray-600 hover:text-gray-400" title="Refresh status">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          {!running && (
            <Button size="sm" variant="ghost" onClick={() => setConfiguring(c => !c)}>
              {configuring ? 'Cancel' : 'Configure'}
            </Button>
          )}
          <Button
            size="sm"
            variant={running ? 'danger' : 'primary'}
            icon={running ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
            onClick={running ? handleStop : handleStart}
            disabled={loading || serverOnline === false || (serverOnline === null)}
          >
            {loading ? '...' : running ? 'Stop' : 'Start Bot'}
          </Button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="text-[10px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">
          {error}
        </div>
      )}

      {/* Server offline instructions */}
      {serverOnline === false && (
        <div className="text-[10px] text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded px-3 py-2 space-y-1">
          <p className="font-semibold">Oracle VM is not reachable</p>
          <p>Make sure the bot server is running: <code className="bg-gray-900 px-1 rounded">pm2 start ecosystem.config.cjs</code></p>
          <p>And that <code className="bg-gray-900 px-1 rounded">BOT_SERVER_URL</code> is set in Vercel environment variables.</p>
        </div>
      )}

      {/* Config panel (shown when not running and configure clicked) */}
      {configuring && !running && (
        <div className="bg-gray-900/50 border border-gray-800 rounded p-3 space-y-3">
          <p className="text-[10px] text-gray-400 font-semibold uppercase tracking-wider">Bot configuration</p>

          <div className="flex items-center gap-3 flex-wrap">
            <div>
              <label className="text-[10px] text-gray-500 block mb-1">£/pt per trade</label>
              <input type="number" value={tradeSize} onChange={e => setTradeSize(Math.max(0.1, Number(e.target.value)))}
                min={0.1} step={0.1} className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white outline-none" />
            </div>
            <div>
              <label className="text-[10px] text-gray-500 block mb-1">Stop loss %</label>
              <input type="number" value={config.stopLossPct} onChange={e => setConfig(c => ({ ...c, stopLossPct: Math.max(0.1, Number(e.target.value)) }))}
                min={0.1} step={0.1} className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white outline-none" />
            </div>
            <div>
              <label className="text-[10px] text-gray-500 block mb-1">Cooldown (min)</label>
              <input type="number" value={config.cooldownMs / 60_000} onChange={e => setConfig(c => ({ ...c, cooldownMs: Math.max(1, Number(e.target.value)) * 60_000 }))}
                min={1} step={1} className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white outline-none" />
            </div>
          </div>

          <div>
            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1.5">Instruments</p>
            <div className="flex flex-wrap gap-1.5">
              {AVAILABLE_INSTRUMENTS.map(ins => (
                <button
                  key={ins.epic}
                  onClick={() => setSelectedEpics(prev =>
                    prev.includes(ins.epic) ? prev.filter(e => e !== ins.epic) : [...prev, ins.epic]
                  )}
                  className={clsx(
                    'text-[10px] px-2 py-1 rounded border transition-all',
                    selectedEpics.includes(ins.epic)
                      ? 'bg-orange-500/20 text-orange-400 border-orange-500/40'
                      : 'bg-gray-800 text-gray-500 border-gray-700 hover:border-gray-500'
                  )}
                >
                  {ins.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Live status */}
      {status && (running || Object.keys(status.epicStatuses).length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Epic statuses */}
          <div className="space-y-1">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider">Live status</p>
            {Object.entries(status.epicStatuses).map(([epic, s]) => {
              const name = AVAILABLE_INSTRUMENTS.find(i => i.epic === epic)?.name ?? epic;
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
            {Object.keys(status.epicStatuses).length === 0 && (
              <p className="text-[10px] text-gray-600">No active instruments</p>
            )}

            {/* Session info */}
            {status.sessionExpiry && (
              <div className="text-[10px] text-gray-600 mt-2">
                Session {status.sessionOk ? 'valid' : 'expired'} · auto-renews {new Date(status.sessionExpiry).toLocaleTimeString()}
              </div>
            )}
          </div>

          {/* Log */}
          <div>
            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1.5">Bot log</p>
            <div className="h-52 overflow-y-auto space-y-0.5 bg-gray-950/60 border border-gray-800 rounded p-2">
              {status.log.length === 0 && (
                <p className="text-[10px] text-gray-600 text-center mt-8">No log entries yet</p>
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

      <p className="text-[9px] text-gray-600">
        Runs 24/7 on Oracle Cloud — browser and device can be closed. Credentials stored as env vars on the VM, never sent to the browser.
      </p>
    </Card>
  );
}

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Play, Square, Pause, Activity, AlertTriangle, Server, Wifi, WifiOff, RefreshCw, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { clsx } from 'clsx';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { DEFAULT_WATCHLIST } from '@/lib/igStrategyEngine';

const AVAILABLE_INSTRUMENTS = DEFAULT_WATCHLIST.filter(m => m.enabled).map(m => ({ epic: m.epic, name: m.name }));
const ALL_EPICS = AVAILABLE_INSTRUMENTS.map(m => m.epic);
const POLL_INTERVAL = 8_000;

// FX scalper — separate bot from the Lightstreamer data-only streams below:
// this one actually places real orders (fxScalperBot.ts on the bot server).
// Also trades 4 indices alongside the 5 FX majors (marketHours.ts already
// has real session hours defined for these — previously only used by the
// signal-only Lightstreamer displays, never wired into this trading bot).
const FX_PAIRS = [
  { epic: 'CS.D.GBPUSD.TODAY.IP', name: 'GBP/USD' },
  { epic: 'CS.D.EURUSD.TODAY.IP', name: 'EUR/USD' },
  { epic: 'CS.D.USDJPY.TODAY.IP', name: 'USD/JPY' },
  { epic: 'CS.D.EURGBP.TODAY.IP', name: 'EUR/GBP' },
  { epic: 'CS.D.AUDUSD.TODAY.IP', name: 'AUD/USD' },
  { epic: 'IX.D.FTSE.DAILY.IP',   name: 'FTSE 100' },
  { epic: 'IX.D.DAX.DAILY.IP',    name: 'Germany 40' },
  { epic: 'IX.D.DOW.DAILY.IP',    name: 'Wall Street' },
  { epic: 'IX.D.NIKKEI.DAILY.IP', name: 'Japan 225' },
];
const FX_EPICS = FX_PAIRS.map(p => p.epic);

type AccountKey = 'demo' | 'live';

type LogEntry = {
  id:   string;
  ts:   string;
  type: 'info' | 'enter' | 'exit' | 'hold' | 'wait' | 'error' | 'cooldown';
  epic: string;
  msg:  string;
};

type PriceEntry = {
  bid:           number;
  mid:           number;
  changePercent: number;
  candleCount:   number;
  rsi:           number | null;
  macd:          number | null;
  atr:           number | null;
  signal:        'BUY' | 'SELL' | 'NEUTRAL';
  signalState:   string;
};

type EpicStatus = {
  state:        string;
  entryPrice:   number;
  pnlPct:       number | null;
  lastPrice:    number;
  reds:         number;
  formingIsRed: boolean | null;
};

type AccountStatus = {
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

// ── Indicator bar ──────────────────────────────────────────────────────────────
function RsiBar({ rsi }: { rsi: number | null }) {
  if (rsi === null) return <span className="text-gray-600 text-[10px]">RSI —</span>;
  const color = rsi > 65 ? 'text-red-400' : rsi < 35 ? 'text-emerald-400' : 'text-gray-400';
  return <span className={clsx('text-[10px] font-mono', color)}>RSI {rsi.toFixed(0)}</span>;
}

function MacdDot({ macd }: { macd: number | null }) {
  if (macd === null) return <span className="text-gray-600 text-[10px]">MACD —</span>;
  const color = macd > 0.0002 ? 'text-red-400' : macd < -0.0002 ? 'text-emerald-400' : 'text-gray-500';
  const label = macd > 0.0002 ? '↑' : macd < -0.0002 ? '↓' : '→';
  return <span className={clsx('text-[10px]', color)}>MACD {label}</span>;
}

// ── Per-account stream control panel ─────────────────────────────────────────

function AccountPanel({ account, serverOnline }: { account: AccountKey; serverOnline: boolean | null }) {
  const [status, setStatus]          = useState<AccountStatus | null>(null);
  const [loading, setLoading]        = useState(false);
  const [error, setError]            = useState<string | null>(null);
  const [selectedEpics, setSelected] = useState<string[]>(ALL_EPICS);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch(`/api/ig/bot?action=account-status&account=${account}`);
      if (!r.ok) { setError(`HTTP ${r.status}`); return; }
      const d = await r.json() as AccountStatus;
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
      'rounded-lg border p-3 space-y-2.5',
      isLive ? 'border-orange-500/30 bg-orange-500/5' : 'border-blue-500/30 bg-blue-500/5'
    )}>
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-white uppercase tracking-wider">
            {isLive ? '🔴 Live' : '🔵 Demo'} Stream
          </span>
          <span className={clsx(
            'text-[9px] px-1.5 py-0.5 rounded font-bold border',
            running && !paused
              ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30 animate-pulse'
              : running && paused
              ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
              : 'bg-gray-700 text-gray-400 border-gray-600'
          )}>
            {running && !paused ? 'STREAMING' : running && paused ? 'PAUSED' : 'OFF'}
          </span>
          {status?.streamConnected === false && running && (
            <span className="text-[9px] text-yellow-400 flex items-center gap-1">
              <AlertTriangle className="h-2.5 w-2.5" /> Disconnected
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <button onClick={() => void fetchStatus()} className="text-gray-600 hover:text-gray-400">
            <RefreshCw className="h-3 w-3" />
          </button>
          {running && (
            <Button size="sm" variant="ghost"
              icon={paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
              onClick={() => void call(paused ? 'account-resume' : 'account-pause')}
              disabled={loading || serverOnline === false}
            >
              {paused ? 'Resume' : 'Pause'}
            </Button>
          )}
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
            {loading ? '…' : running ? 'Stop' : `Start ${isLive ? 'Live' : 'Demo'}`}
          </Button>
        </div>
      </div>

      {error && (
        <div className="text-[10px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1">{error}</div>
      )}

      {/* Instrument selector — only when stopped */}
      {!running && (
        <div className="bg-gray-900/50 border border-gray-800 rounded p-2 space-y-1.5">
          <div className="flex items-center justify-between">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider">Instruments to track</p>
            <div className="flex gap-1.5">
              <button onClick={() => setSelected(ALL_EPICS)} className="text-[9px] text-gray-500 hover:text-gray-300">All</button>
              <button onClick={() => setSelected([])} className="text-[9px] text-gray-500 hover:text-gray-300">None</button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1">
            {AVAILABLE_INSTRUMENTS.map(ins => (
              <button
                key={ins.epic}
                onClick={() => setSelected(prev =>
                  prev.includes(ins.epic) ? prev.filter(e => e !== ins.epic) : [...prev, ins.epic]
                )}
                className={clsx(
                  'text-[10px] px-2 py-0.5 rounded border transition-all',
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

      {/* Signal states + analysis log — two columns */}
      {status && running && Object.keys(status.epicStatuses).length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">

          {/* Signal states */}
          <div className="space-y-1">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider">Signal States</p>
            {Object.entries(status.epicStatuses).map(([epic, s]) => {
              const name = AVAILABLE_INSTRUMENTS.find(i => i.epic === epic)?.name ?? epic.split('.').slice(0, 3).join('.');
              return (
                <div key={epic} className="flex items-center justify-between bg-gray-900/60 rounded px-2 py-1">
                  <span className="text-[10px] text-gray-300">{name}</span>
                  <div className="flex items-center gap-2 text-[10px]">
                    {s.reds > 0 && <span className="text-red-400">{s.reds}🔴</span>}
                    <span className={clsx('font-medium',
                      s.state === 'IN_POSITION' ? 'text-emerald-400' :
                      s.state === 'COOLDOWN'    ? 'text-yellow-400' : 'text-gray-400'
                    )}>
                      {s.state === 'IN_POSITION' ? '⚡ SIGNAL' : s.state}
                    </span>
                    {s.formingIsRed !== null && (
                      <span className={s.formingIsRed ? 'text-red-400' : 'text-emerald-400'}>
                        {s.formingIsRed ? '▼' : '▲'}
                      </span>
                    )}
                    <span className="text-gray-600 font-mono">
                      {s.lastPrice > 0 ? (s.lastPrice > 100 ? s.lastPrice.toFixed(1) : s.lastPrice.toFixed(4)) : '—'}
                    </span>
                  </div>
                </div>
              );
            })}
            {paused && (
              <div className="text-[10px] text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded px-2 py-1 mt-1">
                ⏸ Paused — monitoring, signals suppressed
              </div>
            )}
            <div className="text-[10px] text-gray-600 mt-1 space-y-0.5">
              {status.sessionExpiry && (
                <div>Session {status.sessionOk ? 'valid' : 'expired'} · renews {new Date(status.sessionExpiry).toLocaleTimeString()}</div>
              )}
              {status.recentLosses > 0 && (
                <div className="text-yellow-600">⚠ {status.recentLosses} signal loss{status.recentLosses > 1 ? 'es' : ''} — cooldown scaled</div>
              )}
            </div>
          </div>

          {/* Analysis log */}
          <div>
            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Analysis log</p>
            <div className="h-44 overflow-y-auto space-y-0.5 bg-gray-950/60 border border-gray-800 rounded p-2">
              {status.log.length === 0 && (
                <p className="text-[10px] text-gray-600 text-center mt-6">Waiting for candles…</p>
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

// ── Market intelligence grid ──────────────────────────────────────────────────

function MarketGrid({ serverOnline }: { serverOnline: boolean | null }) {
  const [prices, setPrices] = useState<Record<string, PriceEntry>>({});
  const [ts, setTs] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchPrices = useCallback(async () => {
    try {
      const r = await fetch('/api/ig/bot?action=prices');
      if (!r.ok) return;
      const d = await r.json() as { ok: boolean; prices: Record<string, PriceEntry>; ts: string };
      if (d.ok) { setPrices(d.prices); setTs(d.ts); }
    } catch {}
  }, []);

  useEffect(() => {
    if (serverOnline) {
      void fetchPrices();
      pollRef.current = setInterval(() => { void fetchPrices(); }, POLL_INTERVAL);
    } else {
      setPrices({});
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [serverOnline, fetchPrices]);

  const entries = Object.entries(prices);
  if (!entries.length) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-white">Market Intelligence</p>
        {ts && <span className="text-[9px] text-gray-600">{new Date(ts).toLocaleTimeString()}</span>}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {entries.map(([epic, p]) => {
          const name = AVAILABLE_INSTRUMENTS.find(i => i.epic === epic)?.name ?? epic.split('.').slice(0, 3).join('.');
          const pctStr = `${p.changePercent >= 0 ? '+' : ''}${p.changePercent.toFixed(3)}%`;
          const Signal =
            p.signal === 'BUY'  ? <TrendingUp className="h-3 w-3 text-emerald-400" /> :
            p.signal === 'SELL' ? <TrendingDown className="h-3 w-3 text-red-400" />  :
            <Minus className="h-3 w-3 text-gray-500" />;
          const signalColor =
            p.signal === 'BUY'  ? 'text-emerald-400' :
            p.signal === 'SELL' ? 'text-red-400'      : 'text-gray-500';
          const cardBorder =
            p.signal === 'BUY'  ? 'border-emerald-500/25 bg-emerald-500/5' :
            p.signal === 'SELL' ? 'border-red-500/25 bg-red-500/5'        :
            'border-gray-800 bg-gray-900/30';

          return (
            <div key={epic} className={clsx('rounded-lg border p-2.5 space-y-1', cardBorder)}>
              <div className="flex items-start justify-between gap-1">
                <p className="text-[11px] font-semibold text-white leading-tight">{name}</p>
                <div className="flex items-center gap-0.5">{Signal}
                  <span className={clsx('text-[9px] font-bold', signalColor)}>{p.signal}</span>
                </div>
              </div>
              <p className="text-sm font-bold text-white tabular-nums">
                {p.mid > 100
                  ? p.mid.toLocaleString('en-GB', { maximumFractionDigits: 1 })
                  : p.mid.toFixed(4)}
              </p>
              <p className={clsx('text-[10px] font-semibold', p.changePercent >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                {pctStr} session
              </p>
              <div className="flex gap-2 flex-wrap">
                <RsiBar rsi={p.rsi} />
                <MacdDot macd={p.macd} />
                {p.atr !== null && (
                  <span className="text-[10px] text-gray-500 font-mono">ATR {p.atr.toFixed(1)}</span>
                )}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[9px] text-gray-600">{p.candleCount} candles</span>
                {p.signalState === 'IN_POSITION' && (
                  <span className="text-[9px] px-1 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                    ⚡ Active signal
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── FX scalper panel — real order execution, separate from the data-only
// Lightstreamer streams above ─────────────────────────────────────────────────

type FxEpicStatus = {
  state:      string;
  direction:  'BUY' | 'SELL';
  entryPrice: number;
  lastPrice:  number;
  dealId:     string;
  pnlPct:     number | null;
};

type FxStatus = {
  mode:             AccountKey;
  running:          boolean;
  paused:           boolean;
  streamConnected:  boolean;
  epics:            string[];
  maxRiskGbp:       number;
  epicStatuses:     Record<string, FxEpicStatus>;
  log:              LogEntry[];
  sessionOk:        boolean;
  sessionExpiry:    string | null;
};

function FxScalperAccountPanel({ account, serverOnline }: { account: AccountKey; serverOnline: boolean | null }) {
  const [status, setStatus]         = useState<FxStatus | null>(null);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [selectedEpics, setSelected] = useState<string[]>(FX_EPICS);
  const [maxRiskGbp, setMaxRiskGbp] = useState(5);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch(`/api/fx-scalper?mode=${account}`);
      if (!r.ok) { setError(`HTTP ${r.status}`); return; }
      const d = await r.json() as FxStatus;
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
    } else if (pollRef.current) {
      clearInterval(pollRef.current); pollRef.current = null;
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [status?.running, fetchStatus]);

  async function call(action: string, body?: unknown) {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/fx-scalper?mode=${account}&action=${action}`, {
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
      'rounded-lg border p-3 space-y-2.5',
      isLive ? 'border-orange-500/30 bg-orange-500/5' : 'border-cyan-500/30 bg-cyan-500/5'
    )}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-white uppercase tracking-wider">
            {isLive ? '🔴 Live' : '🔵 Demo'} FX Scalper
          </span>
          <span className={clsx(
            'text-[9px] px-1.5 py-0.5 rounded font-bold border',
            running && !paused
              ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30 animate-pulse'
              : running && paused
              ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
              : 'bg-gray-700 text-gray-400 border-gray-600'
          )}>
            {running && !paused ? 'TRADING' : running && paused ? 'PAUSED' : 'OFF'}
          </span>
          {status?.streamConnected === false && running && (
            <span className="text-[9px] text-yellow-400 flex items-center gap-1">
              <AlertTriangle className="h-2.5 w-2.5" /> Disconnected
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <button onClick={() => void fetchStatus()} className="text-gray-600 hover:text-gray-400">
            <RefreshCw className="h-3 w-3" />
          </button>
          {running && (
            <Button size="sm" variant="ghost"
              icon={paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
              onClick={() => void call(paused ? 'resume' : 'pause')}
              disabled={loading || serverOnline === false}
            >
              {paused ? 'Resume' : 'Pause'}
            </Button>
          )}
          <Button
            size="sm"
            variant={running ? 'danger' : isLive ? 'primary' : 'secondary'}
            icon={running ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
            onClick={() => void (running
              ? call('stop')
              : call('start', { epics: selectedEpics, maxRiskGbp })
            )}
            disabled={loading || serverOnline === false || serverOnline === null}
          >
            {loading ? '…' : running ? 'Stop' : `Start ${isLive ? 'Live' : 'Demo'}`}
          </Button>
        </div>
      </div>

      {error && (
        <div className="text-[10px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1">{error}</div>
      )}

      {/* Pair + risk selector — only when stopped */}
      {!running && (
        <div className="bg-gray-900/50 border border-gray-800 rounded p-2 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider">Instruments to trade</p>
            <div className="flex gap-1.5">
              <button onClick={() => setSelected(FX_EPICS)} className="text-[9px] text-gray-500 hover:text-gray-300">All</button>
              <button onClick={() => setSelected([])} className="text-[9px] text-gray-500 hover:text-gray-300">None</button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1">
            {FX_PAIRS.map(pair => (
              <button
                key={pair.epic}
                onClick={() => setSelected(prev =>
                  prev.includes(pair.epic) ? prev.filter(e => e !== pair.epic) : [...prev, pair.epic]
                )}
                className={clsx(
                  'text-[10px] px-2 py-0.5 rounded border transition-all',
                  selectedEpics.includes(pair.epic)
                    ? isLive
                      ? 'bg-orange-500/20 text-orange-400 border-orange-500/40'
                      : 'bg-cyan-500/20 text-cyan-400 border-cyan-500/40'
                    : 'bg-gray-800 text-gray-500 border-gray-700 hover:border-gray-500'
                )}
              >
                {pair.name}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-[10px] text-gray-500">
            Max risk £ per trade
            <input
              type="number" min={0.5} step={0.5} value={maxRiskGbp}
              onChange={e => setMaxRiskGbp(Number(e.target.value))}
              className="w-16 bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-gray-200 text-[10px]"
            />
          </label>
        </div>
      )}

      {/* Per-pair states + log */}
      {status && running && Object.keys(status.epicStatuses).length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-1">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider">Pair States</p>
            {Object.entries(status.epicStatuses).map(([epic, s]) => {
              const name = FX_PAIRS.find(p => p.epic === epic)?.name ?? epic.split('.').slice(0, 3).join('.');
              return (
                <div key={epic} className="flex items-center justify-between bg-gray-900/60 rounded px-2 py-1">
                  <span className="text-[10px] text-gray-300">{name}</span>
                  <div className="flex items-center gap-2 text-[10px]">
                    {s.state === 'IN_POSITION' && (
                      <span className={s.direction === 'BUY' ? 'text-emerald-400' : 'text-red-400'}>
                        {s.direction}
                      </span>
                    )}
                    <span className={clsx('font-medium',
                      s.state === 'IN_POSITION' ? 'text-emerald-400' :
                      s.state === 'COOLDOWN'    ? 'text-yellow-400' : 'text-gray-400'
                    )}>
                      {s.state}
                    </span>
                    {s.pnlPct !== null && (
                      <span className={s.pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                        {s.pnlPct >= 0 ? '+' : ''}{s.pnlPct.toFixed(3)}%
                      </span>
                    )}
                    <span className="text-gray-600 font-mono">{s.lastPrice.toFixed(1)}</span>
                  </div>
                </div>
              );
            })}
            {paused && (
              <div className="text-[10px] text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded px-2 py-1 mt-1">
                ⏸ Paused — monitoring open positions, no new entries
              </div>
            )}
            <div className="text-[10px] text-gray-600 mt-1">
              Max risk £{status.maxRiskGbp}/trade
              {status.sessionExpiry && ` · session ${status.sessionOk ? 'valid' : 'expired'}, renews ${new Date(status.sessionExpiry).toLocaleTimeString()}`}
            </div>
          </div>

          <div>
            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Trade log</p>
            <div className="h-44 overflow-y-auto space-y-0.5 bg-gray-950/60 border border-gray-800 rounded p-2">
              {status.log.length === 0 && (
                <p className="text-[10px] text-gray-600 text-center mt-6">Waiting for candles…</p>
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
          <span className="text-sm font-semibold text-white">Market Intelligence Bot</span>
          <span className={clsx('text-[9px] flex items-center gap-1',
            serverOnline === true  ? 'text-emerald-400' :
            serverOnline === false ? 'text-red-400'     : 'text-gray-500'
          )}>
            {serverOnline === true  ? <Wifi className="h-2.5 w-2.5" />    :
             serverOnline === false ? <WifiOff className="h-2.5 w-2.5" /> :
             <Activity className="h-2.5 w-2.5 animate-pulse" />}
            {serverOnline === true  ? 'Oracle VM online' :
             serverOnline === false ? 'Oracle VM offline' : 'Checking…'}
          </span>
        </div>
        <button onClick={() => void checkHealth()} className="text-gray-600 hover:text-gray-400">
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {serverOnline === false && (
        <div className="text-[10px] text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded px-3 py-2">
          Oracle VM not reachable. Start the bot server: <code className="bg-gray-900 px-1 rounded">pm2 start ecosystem.config.cjs</code>
        </div>
      )}

      {/* Market intelligence grid — live RSI/MACD/ATR from Lightstreamer */}
      <MarketGrid serverOnline={serverOnline} />

      {/* FX scalper — real order execution, separate bot from the streams below */}
      <div className="space-y-2">
        <p className="text-[10px] text-gray-500 uppercase tracking-wider">FX Scalper — places real orders</p>
        <FxScalperAccountPanel account="demo" serverOnline={serverOnline} />
        <FxScalperAccountPanel account="live" serverOnline={serverOnline} />
      </div>

      {/* Stream controls (one per account) */}
      <div className="space-y-2">
        <p className="text-[10px] text-gray-500 uppercase tracking-wider">Lightstreamer Data Streams (signal-only)</p>
        <AccountPanel account="demo" serverOnline={serverOnline} />
        <AccountPanel account="live" serverOnline={serverOnline} />
      </div>

      <p className="text-[9px] text-gray-600">
        FX Scalper places real orders via fxScalperBot.ts (own risk/loss controls, Gemini-confirmed entries). The Lightstreamer Data Streams below are signal-only — RSI/MACD/ATR computed live, exported to the IG Spread Bet tab, no order placement.
      </p>
    </Card>
  );
}

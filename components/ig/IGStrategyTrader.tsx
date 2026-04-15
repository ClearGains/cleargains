'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Play, Square, Save, Trash2, Plus, RefreshCw, Search,
  AlertCircle, CheckCircle2, Clock, BarChart3, Target,
  TrendingUp, TrendingDown, Minus, Wifi, X, Zap,
  ArrowUpDown, Settings, Activity, ChevronDown, ChevronUp, Edit2,
} from 'lucide-react';
import { clsx } from 'clsx';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  type Timeframe, type IGSavedStrategy, type StrategySignal,
  type WatchlistMarket, type MarketType,
  loadStrategies, saveStrategy, deleteStrategy,
  TIMEFRAME_CONFIG, DEFAULT_WATCHLIST, getMarketType,
} from '@/lib/igStrategyEngine';

// ── Types ─────────────────────────────────────────────────────────────────────

type IGSession = { cst: string; securityToken: string; accountId: string; apiKey: string };

type IGPosition = {
  dealId:         string;
  direction:      string;
  size:           number;
  level:          number;
  upl:            number;
  currency:       string;
  epic:           string;
  instrumentName: string;
  bid:            number;
  offer:          number;
  stopLevel?:     number;
  limitLevel?:    number;
  contractSize?:  number;
  createdDate?:   string;
};

type IGWorkingOrder = {
  dealId:         string;
  epic:           string;
  instrumentName: string;
  direction:      string;
  size:           number;
  orderType:      string;
  level:          number;
  stopLevel?:     number;
  limitLevel?:    number;
  currency:       string;
  createdAt?:     string;
  timeInForce?:   string;
};

type MarketScan = {
  epic: string;
  name: string;
  signal: StrategySignal | null;
  price?: number;
  changePercent?: number;
  source?: string;
  scanning: boolean;
  status: 'idle' | 'ok' | 'error';
  error?: string;
  lastScanned?: string;
};

type RunLog = { id: string; ts: string; type: 'info'|'buy'|'sell'|'close'|'error'|'signal'; msg: string };
type PositionMap = Record<'demo'|'live', IGPosition[]>;

function uid() { return Math.random().toString(36).slice(2, 9); }
function fmt(n: number) { return `£${Math.abs(n).toFixed(2)}`; }
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── API helpers ───────────────────────────────────────────────────────────────

function makeHeaders(s: IGSession, env: 'demo'|'live', extra?: Record<string,string>) {
  return { 'x-ig-cst': s.cst, 'x-ig-security-token': s.securityToken, 'x-ig-api-key': s.apiKey, 'x-ig-env': env, ...extra };
}

const SESSION_TTL_MS = 5 * 60 * 60 * 1000; // 5 hours — matches server-side cache

async function connectIG(env: 'demo'|'live', forceRefresh = false): Promise<IGSession|null> {
  const credKey = env === 'demo' ? 'ig_demo_credentials' : 'ig_live_credentials';
  const sessKey = `ig_session_${env}`;
  try {
    const raw = localStorage.getItem(credKey);
    if (!raw) return null;
    const c = JSON.parse(raw) as { username:string; password:string; apiKey:string; connected?:boolean };
    if (!c.connected) return null;

    // Return cached session if still fresh (< 5 hours old)
    if (!forceRefresh) {
      const cachedRaw = localStorage.getItem(sessKey);
      if (cachedRaw) {
        const cached = JSON.parse(cachedRaw) as { cst:string; securityToken:string; accountId:string; apiKey:string; authenticatedAt:number };
        if (cached.cst && cached.securityToken && (Date.now() - cached.authenticatedAt) < SESSION_TTL_MS) {
          return { cst:cached.cst, securityToken:cached.securityToken, accountId:cached.accountId, apiKey:cached.apiKey };
        }
      }
    }

    // Fresh auth — pass forceRefresh so the server also bypasses its in-memory cache
    const r = await fetch('/api/ig/session', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ username:c.username, password:c.password, apiKey:c.apiKey, env, forceRefresh }) });
    const d = await r.json() as { ok:boolean; cst?:string; securityToken?:string; accountId?:string };
    if (d.ok && d.cst && d.securityToken) {
      const sess: IGSession = { cst:d.cst, securityToken:d.securityToken, accountId:d.accountId??'', apiKey:c.apiKey };
      // Cache the fresh session
      localStorage.setItem(sessKey, JSON.stringify({ ...sess, authenticatedAt: Date.now() }));
      return sess;
    }
  } catch {}
  return null;
}

// ── Small UI pieces ───────────────────────────────────────────────────────────

function DirectionBadge({ dir, size='sm' }: { dir: string; size?: 'sm'|'xs' }) {
  const base = size === 'xs' ? 'text-[9px] px-1 py-0' : 'text-[10px] px-1.5 py-0.5';
  return (
    <span className={clsx('font-bold rounded', base,
      dir === 'BUY'  ? 'bg-emerald-500/20 text-emerald-400' :
      dir === 'SELL' ? 'bg-red-500/20 text-red-400' :
      'bg-gray-700 text-gray-400'
    )}>{dir}</span>
  );
}

function StrengthBar({ strength, dir }: { strength: number; dir: string }) {
  return (
    <div className="h-1 bg-gray-800 rounded-full overflow-hidden w-16 flex-shrink-0">
      <div className={clsx('h-full rounded-full transition-all',
        dir === 'BUY' ? 'bg-emerald-500' : dir === 'SELL' ? 'bg-red-500' : 'bg-gray-600'
      )} style={{ width: `${strength}%` }} />
    </div>
  );
}

function MarketSearch({ session, env, onSelect }: {
  session: IGSession; env: 'demo'|'live'; onSelect: (m:{epic:string;instrumentName:string}) => void;
}) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<{epic:string;instrumentName:string;bid:number;offer:number}[]>([]);
  const [busy, setBusy] = useState(false);
  async function go() {
    if (!q.trim()) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/ig/markets?q=${encodeURIComponent(q)}`, { headers: makeHeaders(session, env) });
      const d = await r.json() as { ok:boolean; markets?: typeof res };
      if (d.ok) setRes(d.markets ?? []);
    } catch {}
    setBusy(false);
  }
  return (
    <div>
      <div className="flex gap-2">
        <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key==='Enter' && void go()}
          placeholder="Search market…"
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-orange-500" />
        <Button size="sm" onClick={go} loading={busy} icon={<Search className="h-3.5 w-3.5" />}>Find</Button>
      </div>
      {res.length > 0 && (
        <div className="mt-1.5 border border-gray-700 rounded-lg divide-y divide-gray-800 max-h-40 overflow-y-auto">
          {res.slice(0,8).map(m => (
            <button key={m.epic} onClick={() => { onSelect(m); setRes([]); setQ(''); }}
              className="w-full flex items-center justify-between px-3 py-2 text-left text-xs hover:bg-gray-800/80">
              <div>
                <p className="font-semibold text-white">{m.instrumentName}</p>
                <p className="text-gray-500 font-mono text-[10px]">{m.epic}</p>
              </div>
              <p className="text-gray-400 font-mono">{m.bid}/{m.offer}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Market-type helpers ───────────────────────────────────────────────────────

/** Stop/limit distances in POINTS (IG spread-bet "points" = pips for forex). */
function getStopLimitDist(mType: MarketType): { stopDist: number; limitDist: number } {
  switch (mType) {
    case 'INDEX':     return { stopDist: 20, limitDist: 40 };
    case 'FOREX':     return { stopDist: 20, limitDist: 40 };
    case 'COMMODITY': return { stopDist: 2,  limitDist: 4  };
    case 'CRYPTO':    return { stopDist: 50, limitDist: 100 };
  }
}

/**
 * Calibrated signal scoring for spread-bet markets.
 * Indices / forex move much less than individual stocks, so the
 * thresholds are scaled per asset class.
 */
function calibrateSignal(
  changePercent: number,
  rawSignal: 'BUY' | 'SELL' | 'NEUTRAL',
  mType: MarketType,
): { direction: 'BUY' | 'SELL' | 'HOLD'; strength: number } {
  const pct = Math.abs(changePercent);
  const dir: 'BUY' | 'SELL' | 'HOLD' =
    rawSignal === 'BUY' ? 'BUY' : rawSignal === 'SELL' ? 'SELL' : 'HOLD';

  let strength: number;
  switch (mType) {
    case 'INDEX':
      strength = pct >= 1.0 ? 85 : pct >= 0.5 ? 75 : pct >= 0.3 ? 65 : Math.round((pct / 0.3) * 60);
      break;
    case 'FOREX':
      strength = pct >= 0.3 ? 85 : pct >= 0.2 ? 75 : pct >= 0.1 ? 65 : Math.round((pct / 0.1) * 60);
      break;
    case 'COMMODITY':
      strength = pct >= 2.0 ? 85 : pct >= 1.0 ? 75 : pct >= 0.5 ? 65 : Math.round((pct / 0.5) * 60);
      break;
    case 'CRYPTO':
      strength = pct >= 3.0 ? 85 : pct >= 2.0 ? 75 : pct >= 1.0 ? 65 : Math.round((pct / 1.0) * 60);
      break;
  }
  return { direction: dir, strength: Math.min(99, Math.max(0, strength)) };
}

// ── Main component ────────────────────────────────────────────────────────────

export function IGStrategyTrader() {

  // ── Sessions ───────────────────────────────────────────────────────────────
  const [sessions, setSessions]     = useState<Partial<Record<'demo'|'live', IGSession>>>({});
  const [connecting, setConnecting] = useState<Partial<Record<'demo'|'live', boolean>>>({});

  // ── Positions ──────────────────────────────────────────────────────────────
  const [positions, setPositions] = useState<PositionMap>({ demo:[], live:[] });
  const [loadingPos, setLoadingPos] = useState(false);
  const [closingId, setClosingId]   = useState<string|null>(null);
  const [posError, setPosError]     = useState<string|null>(null);
  const posRefreshRef = useRef<ReturnType<typeof setInterval>|null>(null);

  // ── Strategies ─────────────────────────────────────────────────────────────
  const [strategies, setStrategies]     = useState<IGSavedStrategy[]>([]);
  const [activeStratId, setActiveStratId] = useState<string|null>(null);
  const [isRunning, setIsRunning]       = useState(false);
  const timerRef    = useRef<ReturnType<typeof setInterval>|null>(null);
  const posTimerRef = useRef<ReturnType<typeof setInterval>|null>(null);
  const runningRef  = useRef(false);

  // ── Active demo/live mode ──────────────────────────────────────────────────
  const [activeMode, setActiveModeState] = useState<'demo'|'live'>('demo');
  const [showLiveConfirm, setShowLiveConfirm] = useState(false);
  const [pendingRunAction, setPendingRunAction] = useState<(() => void)|null>(null);

  // ── First-live-trade disclaimer (shown once ever) ──────────────────────────
  const liveTradeAckedRef   = useRef(false);
  const liveTradeResolveRef = useRef<((ok: boolean) => void)|null>(null);
  const [showLiveTradeDisclaimer, setShowLiveTradeDisclaimer] = useState(false);

  // ── Test-run mode (single cycle, max 1 position) ───────────────────────────
  const [testRunning, setTestRunning] = useState(false);

  // ── Test Order (single £1/pt S&P 500 BUY on demo to verify end-to-end) ────
  const [testOrderBusy, setTestOrderBusy] = useState(false);

  // ── Scan frequency settings ────────────────────────────────────────────────
  const [signalScanMs, setSignalScanMs] = useState(5 * 60_000);
  const [posMonitorMs, setPosMonitorMs] = useState(60_000);
  const signalStartRef = useRef<number|null>(null);
  const posStartRef    = useRef<number|null>(null);
  const [signalCountdown, setSignalCountdown] = useState('');
  const [posCountdown, setPosCountdown]       = useState('');

  // ── Market scanner state ───────────────────────────────────────────────────
  const [scans, setScans] = useState<Record<string, MarketScan>>({});
  const [scanProgress, setScanProgress] = useState<string>('');

  // ── Working orders ─────────────────────────────────────────────────────────
  const [workingOrders, setWorkingOrders] = useState<Record<'demo'|'live', IGWorkingOrder[]>>({ demo:[], live:[] });
  const [cancellingOrder, setCancellingOrder] = useState<string|null>(null);

  // ── Position management modals ─────────────────────────────────────────────
  type SlTpModal = { env: 'demo'|'live'; pos: IGPosition };
  const [slModal, setSlModal] = useState<SlTpModal|null>(null);
  const [tpModal, setTpModal] = useState<SlTpModal|null>(null);
  const [slInput, setSlInput] = useState('');
  const [tpInput, setTpInput] = useState('');
  const [updatingPos, setUpdatingPos] = useState<string|null>(null);
  const [reversingPos, setReversingPos] = useState<string|null>(null);

  // ── Tab (positions vs working orders) ─────────────────────────────────────
  const [posTab, setPosTab] = useState<'positions'|'orders'>('positions');

  // ── Builder ────────────────────────────────────────────────────────────────
  const [showBuilder, setShowBuilder]       = useState(false);
  const [editId, setEditId]                 = useState<string|null>(null);
  const [bName, setBName]                   = useState('');
  const [bTimeframe, setBTimeframe]         = useState<Timeframe>('daily');
  const [bSize, setBSize]                   = useState(1);
  const [bMaxPos, setBMaxPos]               = useState(3);
  const [bMinStrength, setBMinStrength]     = useState(55);
  const [bAccounts, setBAccounts]           = useState<('demo'|'live')[]>(['demo']);
  const [bAutoClose, setBAutoClose]         = useState(true);
  const [bWatchlist, setBWatchlist]         = useState<WatchlistMarket[]>([...DEFAULT_WATCHLIST]);
  const [bSignalScanMs, setBSignalScanMs]   = useState(5 * 60_000);
  const [bPosMonitorMs, setBPosMonitorMs]   = useState(60_000);

  // ── Manual trade ───────────────────────────────────────────────────────────
  const [showManual, setShowManual]     = useState(false);
  const [manualEpic, setManualEpic]     = useState('');
  const [manualName, setManualName]     = useState('');
  const [manualDir, setManualDir]       = useState<'BUY'|'SELL'>('BUY');
  const [manualSize, setManualSize]     = useState(1);
  const [manualStop, setManualStop]     = useState<number|''>('');
  const [manualLimit, setManualLimit]   = useState<number|''>('');
  const [manualEnv, setManualEnv]       = useState<'demo'|'live'>('demo');
  const [placingManual, setPlacingManual] = useState(false);

  // ── Log ────────────────────────────────────────────────────────────────────
  const [runLog, setRunLog] = useState<RunLog[]>([]);

  // ── Toast ──────────────────────────────────────────────────────────────────
  const [toast, setToast] = useState<{ok:boolean;msg:string}|null>(null);
  function showToast(ok:boolean, msg:string) { setToast({ok,msg}); setTimeout(() => setToast(null), 4000); }
  function log(type: RunLog['type'], msg: string) {
    setRunLog(p => [{ id:uid(), ts:new Date().toISOString(), type, msg }, ...p].slice(0,200));
  }

  function setActiveMode(mode: 'demo'|'live') {
    setActiveModeState(mode);
    localStorage.setItem('ig_active_mode', mode);
  }

  /** Returns true if the trade should proceed. For live, shows a one-time disclaimer first. */
  function confirmLiveTrade(): Promise<boolean> {
    if (liveTradeAckedRef.current) return Promise.resolve(true);
    return new Promise(resolve => {
      liveTradeResolveRef.current = resolve;
      setShowLiveTradeDisclaimer(true);
    });
  }

  // ── Connect on mount ───────────────────────────────────────────────────────
  useEffect(() => {
    setStrategies(loadStrategies());
    liveTradeAckedRef.current = localStorage.getItem('ig_live_first_trade_ack') === '1';
    const savedMode = localStorage.getItem('ig_active_mode') as 'demo'|'live'|null;
    (['demo','live'] as const).forEach(env => {
      setConnecting(c => ({...c,[env]:true}));
      connectIG(env).then(sess => {
        if (sess) {
          setSessions(s => ({...s,[env]:sess}));
          // Only restore saved live mode once we confirm a live session actually exists
          if (env === 'live' && savedMode === 'live') setActiveModeState('live');
        }
        setConnecting(c => ({...c,[env]:false}));
      });
    });
    // Always restore demo mode immediately (no credential check needed)
    if (savedMode === 'demo') setActiveModeState('demo');
  }, []);

  // ── Countdown ticker ───────────────────────────────────────────────────────
  useEffect(() => {
    const t = setInterval(() => {
      if (!isRunning) { setSignalCountdown(''); setPosCountdown(''); return; }
      const fmt = (ms: number) => {
        const s = Math.max(0, Math.ceil(ms / 1000));
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      };
      if (signalStartRef.current !== null) {
        const rem = signalScanMs - (Date.now() - signalStartRef.current);
        setSignalCountdown(fmt(rem));
      }
      if (posStartRef.current !== null) {
        const rem = posMonitorMs - (Date.now() - posStartRef.current);
        setPosCountdown(fmt(rem));
      }
    }, 1000);
    return () => clearInterval(t);
  }, [isRunning, signalScanMs, posMonitorMs]);

  // ── Load positions ─────────────────────────────────────────────────────────
  const loadPositions = useCallback(async (envFilter?: 'demo'|'live') => {
    const envs: ('demo'|'live')[] = envFilter ? [envFilter] : ['demo','live'];
    setLoadingPos(true);
    setPosError(null);
    for (const env of envs) {
      let sess = sessions[env];
      if (!sess) continue;
      try {
        let r = await fetch('/api/ig/positions', { headers: makeHeaders(sess, env) });
        // 401 → clear stale cache, re-authenticate fresh and retry once
        if (r.status === 401) {
          localStorage.removeItem(`ig_session_${env}`);
          const fresh = await connectIG(env, true);
          if (fresh) { setSessions(s => ({...s,[env]:fresh})); sess = fresh; }
          r = await fetch('/api/ig/positions', { headers: makeHeaders(sess, env) });
        }
        const d = await r.json() as { ok:boolean; positions?: IGPosition[]; error?:string; detail?:string };
        if (d.ok) {
          setPositions(p => ({...p, [env]: d.positions ?? []}));
        } else {
          const msg = `[${env.toUpperCase()}] Positions error: ${d.error ?? 'unknown'}${d.detail ? ` — ${d.detail}` : ''}`;
          setPosError(msg);
        }
      } catch (e) {
        setPosError(`[${env.toUpperCase()}] Failed to fetch positions: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setLoadingPos(false);
  }, [sessions]);

  useEffect(() => {
    if (Object.values(sessions).some(Boolean)) {
      void loadPositions();
      void loadWorkingOrders();
      // Auto-refresh positions every 30 seconds
      if (posRefreshRef.current) clearInterval(posRefreshRef.current);
      posRefreshRef.current = setInterval(() => { void loadPositions(); }, 30_000);
    }
    return () => { if (posRefreshRef.current) clearInterval(posRefreshRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions]);

  // ── Load working orders ────────────────────────────────────────────────────
  const loadWorkingOrders = useCallback(async (envFilter?: 'demo'|'live') => {
    const envs: ('demo'|'live')[] = envFilter ? [envFilter] : ['demo','live'];
    for (const env of envs) {
      const sess = sessions[env];
      if (!sess) continue;
      try {
        const r = await fetch('/api/ig/workingorders', { headers: makeHeaders(sess, env) });
        const d = await r.json() as { ok:boolean; workingOrders?: IGWorkingOrder[] };
        if (d.ok) setWorkingOrders(p => ({...p, [env]: d.workingOrders ?? []}));
      } catch {}
    }
  }, [sessions]);

  // ── Update stop/limit levels on open position ──────────────────────────────
  async function updatePositionSL(env: 'demo'|'live', pos: IGPosition, stopLevel: number|null, limitLevel: number|null) {
    const sess = sessions[env];
    if (!sess) return { ok: false, error: `No ${env} session` };
    const r = await fetch('/api/ig/order', {
      method: 'PATCH',
      headers: { ...makeHeaders(sess, env), 'Content-Type': 'application/json' },
      body: JSON.stringify({ dealId: pos.dealId, stopLevel, limitLevel }),
    });
    return r.json() as Promise<{ok:boolean;error?:string}>;
  }

  // ── Cancel working order ───────────────────────────────────────────────────
  async function cancelWorkingOrder(env: 'demo'|'live', dealId: string) {
    setCancellingOrder(dealId);
    const sess = sessions[env];
    if (!sess) { setCancellingOrder(null); return; }
    try {
      const r = await fetch('/api/ig/workingorders', {
        method: 'DELETE',
        headers: { ...makeHeaders(sess, env), 'Content-Type': 'application/json' },
        body: JSON.stringify({ dealId }),
      });
      const d = await r.json() as { ok:boolean; error?:string };
      if (d.ok) {
        log('info', `[${env.toUpperCase()}] Working order ${dealId} cancelled`);
        showToast(true, 'Order cancelled');
        await loadWorkingOrders(env);
      } else {
        showToast(false, d.error ?? 'Cancel failed');
      }
    } catch { showToast(false, 'Cancel failed'); }
    setCancellingOrder(null);
  }

  // ── Reverse position (close + open opposite) ───────────────────────────────
  async function reversePosition(env: 'demo'|'live', pos: IGPosition) {
    setReversingPos(pos.dealId);
    const closeDir = pos.direction === 'BUY' ? 'SELL' : 'BUY';
    // Step 1: close current position
    const cr = await closePos(env, pos);
    if (!cr.ok) { showToast(false, `Close failed: ${cr.error ?? 'unknown'}`); setReversingPos(null); return; }
    log('close', `[${env.toUpperCase()}] Reversed: closed ${pos.direction} ${pos.instrumentName ?? pos.epic}`);
    await loadPositions(env);
    // Step 2: open opposite direction
    const or = await placeOrder(env, pos.epic, closeDir, pos.size);
    if (or.ok) {
      log(closeDir === 'BUY' ? 'buy' : 'sell', `[${env.toUpperCase()}] Reversed → opened ${closeDir} ${pos.instrumentName ?? pos.epic}`);
      showToast(true, `Reversed to ${closeDir}`);
      await loadPositions(env);
    } else {
      log('error', `[${env.toUpperCase()}] Reverse open failed: ${or.error ?? 'unknown'}`);
      showToast(false, `Close succeeded but open failed: ${or.error ?? 'unknown'}`);
    }
    setReversingPos(null);
  }

  // Pre-populate scanner with idle cards when a strategy is selected/changed
  useEffect(() => {
    if (!activeStratId) return;
    const strat = strategies.find(s => s.id === activeStratId);
    if (!strat) return;
    const markets = (strat.watchlist?.length ? strat.watchlist : DEFAULT_WATCHLIST).filter(m => m.enabled);
    setScans(prev => {
      const next = { ...prev };
      markets.forEach(m => {
        if (!next[m.epic]) {
          next[m.epic] = { epic: m.epic, name: m.name, signal: null, scanning: false, status: 'idle' };
        }
      });
      return next;
    });
  }, [activeStratId, strategies]);

  // ── Place / close ──────────────────────────────────────────────────────────

  /**
   * Returns a guaranteed-fresh session for `env`.
   * Proactively re-auths if the cached token is ≥ 5h old.
   * Clears stale localStorage cache before re-authing.
   */
  async function freshSession(env: 'demo'|'live'): Promise<IGSession|null> {
    // Check stored timestamp
    try {
      const raw = localStorage.getItem(`ig_session_${env}`);
      if (raw) {
        const meta = JSON.parse(raw) as { authenticatedAt?: number };
        if (meta.authenticatedAt && (Date.now() - meta.authenticatedAt) >= SESSION_TTL_MS) {
          // Proactively expire before IG does
          localStorage.removeItem(`ig_session_${env}`);
          const fresh = await connectIG(env, true);
          if (fresh) setSessions(s => ({...s,[env]:fresh}));
          return fresh;
        }
      }
    } catch {}
    // Session still fresh — return from state (connectIG cached it on mount)
    return sessions[env] ?? null;
  }

  async function placeOrder(env: 'demo'|'live', epic:string, direction:'BUY'|'SELL', size:number, stopDist?:number, limitDist?:number) {
    // Proactive freshness check (spec: validate before every IG call)
    let sess = await freshSession(env);
    if (!sess) return { ok:false as const, error:`No ${env} session`, epic, sentPayload: null, igBody: null };

    const orderBody = { epic, direction, size, stopDistance: stopDist, profitDistance: limitDist, currencyCode:'GBP' };
    let r = await fetch('/api/ig/order', {
      method:'POST',
      headers: { ...makeHeaders(sess, env), 'Content-Type':'application/json' },
      body: JSON.stringify(orderBody),
    });

    // 401 / 403 → clear cache, re-auth, retry once
    if (r.status === 401 || r.status === 403) {
      localStorage.removeItem(`ig_session_${env}`);
      const fresh = await connectIG(env, true);
      if (fresh) {
        sess = fresh;
        setSessions(s => ({...s,[env]:fresh}));
        r = await fetch('/api/ig/order', {
          method:'POST',
          headers: { ...makeHeaders(fresh, env), 'Content-Type':'application/json' },
          body: JSON.stringify(orderBody),
        });
      }
    }

    return r.json() as Promise<{ok:boolean;dealReference?:string;dealId?:string;dealStatus?:string;level?:number;reason?:string;error?:string;epic?:string;resolvedVia?:string;sentPayload?:unknown;igBody?:unknown;igStatus?:number}>;
  }

  async function closePos(env: 'demo'|'live', pos: IGPosition) {
    let sess = sessions[env];
    if (!sess) return { ok:false, error:`No ${env} session` };
    const closeBody = { dealId:pos.dealId, direction: pos.direction==='BUY'?'SELL':'BUY', size:pos.size };

    let r = await fetch('/api/ig/order', {
      method:'DELETE',
      headers: { ...makeHeaders(sess, env), 'Content-Type':'application/json' },
      body: JSON.stringify(closeBody),
    });

    // 401 / 403 → re-auth and retry once
    if (r.status === 401 || r.status === 403) {
      localStorage.removeItem(`ig_session_${env}`);
      const fresh = await connectIG(env, true);
      if (fresh) {
        sess = fresh;
        setSessions(s => ({...s,[env]:fresh}));
        r = await fetch('/api/ig/order', {
          method:'DELETE',
          headers: { ...makeHeaders(fresh, env), 'Content-Type':'application/json' },
          body: JSON.stringify(closeBody),
        });
      }
    }

    return r.json() as Promise<{ok:boolean;error?:string}>;
  }

  // ── Fetch market snapshot via Yahoo Finance (no IG historical data used) ───
  async function fetchSnapshot(name: string): Promise<{price:number;changePercent:number;signal:'BUY'|'SELL'|'NEUTRAL';source:string;error?:string}|null> {
    try {
      const r = await fetch(`/api/ig/candles?name=${encodeURIComponent(name)}`);
      const d = await r.json() as { ok:boolean; price?:number; changePercent?:number; signal?:'BUY'|'SELL'|'NEUTRAL'; source?:string; error?:string };
      if (!d.ok) return { price:0, changePercent:0, signal:'NEUTRAL', source:'yahoo', error: d.error ?? `HTTP ${r.status}` };
      return { price: d.price ?? 0, changePercent: d.changePercent ?? 0, signal: d.signal ?? 'NEUTRAL', source: d.source ?? 'yahoo' };
    } catch (e) { return { price:0, changePercent:0, signal:'NEUTRAL', source:'yahoo', error: e instanceof Error ? e.message : 'Fetch failed' }; }
  }

  // ── Scan one market + execute ──────────────────────────────────────────────
  async function scanMarket(strat: IGSavedStrategy, market: WatchlistMarket): Promise<StrategySignal|null> {
    setScans(p => ({ ...p, [market.epic]: { epic:market.epic, name:market.name, signal:null, scanning:true, status:'idle' } }));
    const envs = strat.accounts.filter(e => sessions[e]);

    const snapshot = await fetchSnapshot(market.name);

    if (!snapshot || snapshot.error) {
      const errMsg = snapshot?.error ?? 'Failed to fetch market data';
      setScans(p => ({ ...p, [market.epic]: { epic:market.epic, name:market.name, signal:null, scanning:false, status:'error', error: errMsg } }));
      log('error', `${market.name}: ${errMsg}`);
      return null;
    }

    // ── Calibrated signal scoring by market type ──────────────────────────────
    const mType = market.marketType ?? getMarketType(market.epic);
    const { stopDist, limitDist } = getStopLimitDist(mType);
    const { direction, strength } = calibrateSignal(snapshot.changePercent, snapshot.signal, mType);
    const pctStr = `${snapshot.changePercent >= 0 ? '+' : ''}${snapshot.changePercent.toFixed(2)}%`;

    const sig: StrategySignal = {
      direction,
      strength,
      reason: `Daily ${pctStr} (${mType})`,
      stopPoints:   stopDist,
      targetPoints: limitDist,
      riskReward:   `1:${(limitDist / stopDist).toFixed(1)}`,
      indicators: [
        { label: 'Daily Change', value: pctStr,                   status: direction === 'BUY' ? 'bullish' : direction === 'SELL' ? 'bearish' : 'neutral' },
        { label: 'Type',        value: mType,                     status: 'neutral' },
        { label: 'Stop dist',   value: `${stopDist}pt`,           status: 'neutral' },
        { label: 'TP dist',     value: `${limitDist}pt`,          status: 'neutral' },
        { label: 'Max loss',    value: `£${strat.size * stopDist}`, status: 'neutral' },
      ],
    };

    setScans(p => ({
      ...p,
      [market.epic]: {
        epic: market.epic, name: market.name, signal: sig,
        price: snapshot.price, changePercent: snapshot.changePercent, source: snapshot.source,
        scanning: false, status: 'ok', lastScanned: new Date().toISOString(),
      },
    }));

    // ── Decide whether to trade ───────────────────────────────────────────────
    // forceOpen = trade regardless of signal strength; always use snapshot direction
    const forceOpen = market.forceOpen === true;
    const tradeDir: 'BUY' | 'SELL' | null =
      forceOpen
        ? (direction !== 'HOLD' ? direction : snapshot.changePercent >= 0 ? 'BUY' : 'SELL')
        : direction !== 'HOLD' && strength >= strat.minStrength ? direction
        : null;

    if (!strat.autoTrade || !tradeDir) {
      if (direction !== 'HOLD' && !forceOpen)
        log('signal', `${market.name} (${market.epic}) → ${direction} ${strength}% ${forceOpen ? '' : `(min ${strat.minStrength}% — no trade)`}`);
    } else {
      for (const env of envs) {
        const envPos = positions[env];
        const opposite = tradeDir === 'BUY' ? 'SELL' : 'BUY';

        // Auto-close opposing positions
        if (strat.autoClose) {
          for (const opp of envPos.filter(p => p.epic === market.epic && p.direction === opposite)) {
            log('close', `[${env.toUpperCase()}] Auto-closing ${opp.direction} ${market.name} — signal reversed`);
            const cr = await closePos(env, opp);
            if (cr.ok) log('close', `[${env.toUpperCase()}] ✅ Closed ${market.name}`);
            else log('error', `[${env.toUpperCase()}] Close failed: ${cr.error ?? 'unknown'}`);
          }
          await loadPositions(env);
        }

        // Don't exceed max positions
        const openCount = positions[env].filter(p => p.epic !== market.epic).length;
        if (openCount >= strat.maxPositions) {
          log('info', `[${env.toUpperCase()}] Max ${strat.maxPositions} positions reached — skip ${market.name}`);
          continue;
        }

        // Don't open if already same direction
        if (positions[env].some(p => p.epic === market.epic && p.direction === tradeDir)) continue;

        // One-time disclaimer before first live trade
        if (env === 'live') {
          const ok = await confirmLiveTrade();
          if (!ok) { log('info', `[LIVE] Disclaimer declined — skipping ${market.name}`); continue; }
        }

        const maxLoss = strat.size * stopDist;
        log(tradeDir === 'BUY' ? 'buy' : 'sell',
          `[${env.toUpperCase()}] → ${tradeDir} ${market.name} | epic: ${market.epic} | £${strat.size}/pt | SL ${stopDist}pt TP ${limitDist}pt | max loss £${maxLoss} | signal ${strength}%${forceOpen ? ' (FORCE)' : ''}`);

        const or = await placeOrder(env, market.epic, tradeDir, strat.size, stopDist, limitDist);

        if (or.ok) {
          log(tradeDir === 'BUY' ? 'buy' : 'sell',
            `[${env.toUpperCase()}] ✅ ${or.dealStatus ?? 'ACCEPTED'} — ref ${or.dealReference ?? 'n/a'} · dealId ${or.dealId ?? 'pending'} · filled @ ${or.level ?? '?'} · epic: ${or.epic ?? market.epic}`);
          showToast(true, `[${env}] ${tradeDir} ${market.name}`);
          // Small delay then refresh so IG has time to register the position
          await sleep(1500);
          await loadPositions(env);
          await loadWorkingOrders(env);
        } else {
          log('error', `[${env.toUpperCase()}] ❌ ${market.name} FAILED — ${or.error ?? 'unknown'}`);
          log('error', `  epic: ${or.epic ?? market.epic}${or.reason ? ` | reason: ${or.reason}` : ''}`);
          if (or.sentPayload) log('error', `  sent: ${JSON.stringify(or.sentPayload)}`);
          if (or.igBody)      log('error', `  ig:   ${JSON.stringify(or.igBody)}`);
        }
      }
    }

    return sig;
  }

  // ── Signal scan: scan markets + execute trades ────────────────────────────
  const runSignalScan = useCallback(async (strat: IGSavedStrategy) => {
    if (!runningRef.current) return;
    const markets = (strat.watchlist?.length ? strat.watchlist : DEFAULT_WATCHLIST).filter(m => m.enabled);
    log('info', `📡 Signal scan — ${markets.length} markets…`);

    for (let i = 0; i < markets.length; i++) {
      if (!runningRef.current) break;
      const m = markets[i];
      setScanProgress(`${m.name} (${i+1}/${markets.length})`);
      await scanMarket(strat, m);
      if (i < markets.length - 1) await sleep(800);
    }

    setScanProgress('');
    const env: 'demo'|'live' = strat.accounts.includes('live') ? 'live' : 'demo';
    const updated: IGSavedStrategy = { ...strat, lastRunAt: new Date().toISOString(), lastRunEnv: env };
    saveStrategy(updated);
    setStrategies(loadStrategies());
    const scanMs = strat.signalScanMs ?? signalScanMs;
    log('info', `Signal scan complete — next in ${Math.round(scanMs / 60_000)}min`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, positions, signalScanMs]);

  // ── Position monitor: trailing stops + SL/TP refresh ─────────────────────
  const runPositionMonitor = useCallback(async (strat: IGSavedStrategy) => {
    if (!runningRef.current) return;
    await loadPositions();
    const envs = strat.accounts.filter(e => sessions[e]);
    for (const env of envs) {
      for (const pos of positions[env]) {
        if (!pos.level || !pos.bid || !pos.offer) continue;
        const currentPx = pos.direction === 'BUY' ? pos.bid : pos.offer;
        const entryPx   = pos.level;
        const pnlPct    = pos.direction === 'BUY'
          ? ((currentPx - entryPx) / entryPx) * 100
          : ((entryPx - currentPx) / entryPx) * 100;

        let newStop: number | null = null;
        let reason = '';

        if (pnlPct >= 3 && pnlPct < 5) {
          const breakevenStop = entryPx;
          if (!pos.stopLevel || (pos.direction === 'BUY' ? pos.stopLevel < breakevenStop : pos.stopLevel > breakevenStop)) {
            newStop = breakevenStop;
            reason = `+${pnlPct.toFixed(1)}% → SL to breakeven ${breakevenStop}`;
          }
        }
        if (pnlPct >= 5) {
          const lockStop = pos.direction === 'BUY' ? entryPx * 1.02 : entryPx * 0.98;
          if (!pos.stopLevel || (pos.direction === 'BUY' ? pos.stopLevel < lockStop : pos.stopLevel > lockStop)) {
            newStop = Math.round(lockStop * 100) / 100;
            reason = `+${pnlPct.toFixed(1)}% → SL to lock +2% at ${newStop}`;
          }
        }

        if (newStop !== null) {
          const r = await updatePositionSL(env, pos, newStop, pos.limitLevel ?? null);
          if (r.ok) log('info', `[${env.toUpperCase()}] ${pos.instrumentName ?? pos.epic}: ${reason}`);
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, positions]);

  // ── Start / stop auto-run ──────────────────────────────────────────────────
  function startAutoRun(strat: IGSavedStrategy) {
    // Clear any existing intervals first
    if (timerRef.current)    { clearInterval(timerRef.current);    timerRef.current    = null; }
    if (posTimerRef.current) { clearInterval(posTimerRef.current); posTimerRef.current = null; }

    runningRef.current = true;
    setIsRunning(true);

    const sScanMs = strat.signalScanMs ?? signalScanMs;
    const pMonMs  = strat.posMonitorMs ?? posMonitorMs;
    const modeLabel = strat.accounts.includes('live') ? '⚠️ LIVE' : 'demo';

    log('info', `▶ Auto-trader started — "${strat.name}" · ${modeLabel} · signals every ${Math.round(sScanMs/60_000)}min · positions every ${Math.round(pMonMs/1000)}s`);

    // Run immediately on start
    signalStartRef.current = Date.now();
    void runSignalScan(strat);
    posStartRef.current = Date.now();
    void runPositionMonitor(strat);

    timerRef.current = setInterval(() => {
      signalStartRef.current = Date.now();
      void runSignalScan(strat);
    }, sScanMs);

    posTimerRef.current = setInterval(() => {
      posStartRef.current = Date.now();
      void runPositionMonitor(strat);
    }, pMonMs);
  }

  // ── Test run: one scan cycle, max 1 position opened, then stops ───────────
  async function runTestScan(strat: IGSavedStrategy) {
    if (testRunning || isRunning) return;
    setTestRunning(true);
    runningRef.current = true;
    const testStrat: IGSavedStrategy = { ...strat, maxPositions: 1 };
    log('info', `🧪 Test run started — "${strat.name}" · max 1 position · scanning…`);
    const markets = (strat.watchlist?.length ? strat.watchlist : DEFAULT_WATCHLIST).filter(m => m.enabled);
    let placed = 0;
    for (let i = 0; i < markets.length; i++) {
      if (!runningRef.current || placed >= 1) break;
      const m = markets[i];
      setScanProgress(`${m.name} (${i+1}/${markets.length})`);
      const sig = await scanMarket(testStrat, m);
      if (sig && sig.direction !== 'HOLD' && sig.strength >= strat.minStrength) placed++;
      if (i < markets.length - 1) await sleep(500);
    }
    setScanProgress('');
    runningRef.current = false;
    setTestRunning(false);
    log('info', placed > 0
      ? `🧪 Test complete — ${placed} position opened. Check Positions tab.`
      : `🧪 Test complete — no signals met the ${strat.minStrength}% threshold this scan.`
    );
  }

  function stopAutoRun() {
    runningRef.current = false;
    if (timerRef.current)    { clearInterval(timerRef.current);    timerRef.current    = null; }
    if (posTimerRef.current) { clearInterval(posTimerRef.current); posTimerRef.current = null; }
    setIsRunning(false);
    setScanProgress('');
    setSignalCountdown('');
    setPosCountdown('');
    log('info', '⏹ Auto-trader stopped');
  }

  useEffect(() => () => {
    if (timerRef.current)      clearInterval(timerRef.current);
    if (posTimerRef.current)   clearInterval(posTimerRef.current);
    if (posRefreshRef.current) clearInterval(posRefreshRef.current);
  }, []);

  // ── Test Order: fresh auth → £1/pt BUY S&P 500 on demo ───────────────────
  async function runTestOrder() {
    if (testOrderBusy) return;
    setTestOrderBusy(true);
    log('info', '🧪 Test Order: fresh auth + £1/pt BUY S&P 500 (demo)…');
    try {
      // Force a fresh session (bypass cache) to test auth end-to-end
      const freshSess = await connectIG('demo', true);
      if (!freshSess) {
        log('error', '🧪 Test Order failed: could not authenticate demo session. Check Settings → Accounts.');
        showToast(false, 'No demo session — check credentials');
        setTestOrderBusy(false);
        return;
      }
      setSessions(s => ({...s, demo: freshSess}));
      log('info', `🧪 Auth OK — CST: ${freshSess.cst.slice(0,8)}… accountId: ${freshSess.accountId}`);

      // Place a £1/pt BUY on S&P 500 (verified epic)
      const epic = 'IX.D.SPTRD.DAILY.IP';
      const body = { epic, direction: 'BUY', size: 1, currencyCode: 'GBP' };
      log('info', `🧪 Placing order: ${JSON.stringify(body)}`);
      const r = await fetch('/api/ig/order', {
        method: 'POST',
        headers: { ...makeHeaders(freshSess, 'demo'), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json() as { ok:boolean; dealReference?:string; dealId?:string; dealStatus?:string; level?:number; error?:string; reason?:string; sentPayload?:unknown; igBody?:unknown };
      if (d.ok) {
        log('buy', `🧪 ✅ Test Order ACCEPTED — ref: ${d.dealReference ?? 'n/a'} · dealId: ${d.dealId ?? 'pending'} · status: ${d.dealStatus ?? 'UNKNOWN'} · filled @ ${d.level ?? '?'}`);
        showToast(true, `Test order placed — check Positions tab`);
        await sleep(1500);
        await loadPositions('demo');
      } else {
        log('error', `🧪 ❌ Test Order FAILED: ${d.error ?? 'unknown'}${d.reason ? ` (${d.reason})` : ''}`);
        if (d.sentPayload) log('error', `  sent: ${JSON.stringify(d.sentPayload)}`);
        if (d.igBody)      log('error', `  ig:   ${JSON.stringify(d.igBody)}`);
        showToast(false, d.error ?? 'Test order failed');
      }
    } catch (e) {
      log('error', `🧪 Test Order exception: ${e instanceof Error ? e.message : String(e)}`);
      showToast(false, 'Test order exception');
    }
    setTestOrderBusy(false);
  }

  // ── Manual close ───────────────────────────────────────────────────────────
  async function handleClose(env:'demo'|'live', pos: IGPosition) {
    setClosingId(pos.dealId);
    const r = await closePos(env, pos);
    if (r.ok) {
      log('close', `[${env.toUpperCase()}] Closed ${pos.direction} ${pos.instrumentName ?? pos.epic}`);
      showToast(true, 'Position closed');
      await loadPositions(env);
      await loadWorkingOrders(env);
    } else showToast(false, r.error ?? 'Close failed');
    setClosingId(null);
  }

  // ── Update SL from modal ───────────────────────────────────────────────────
  async function handleUpdateSL() {
    if (!slModal) return;
    const val = parseFloat(slInput);
    if (isNaN(val) || val <= 0) { showToast(false, 'Enter a valid stop-loss price'); return; }
    setUpdatingPos(slModal.pos.dealId);
    const r = await updatePositionSL(slModal.env, slModal.pos, val, slModal.pos.limitLevel ?? null);
    if (r.ok) {
      log('info', `[${slModal.env.toUpperCase()}] Stop-loss updated to ${val} on ${slModal.pos.instrumentName ?? slModal.pos.epic}`);
      showToast(true, `Stop-loss moved to ${val}`);
      await loadPositions(slModal.env);
      setSlModal(null); setSlInput('');
    } else {
      showToast(false, r.error ?? 'Update failed');
    }
    setUpdatingPos(null);
  }

  // ── Update TP from modal ───────────────────────────────────────────────────
  async function handleUpdateTP() {
    if (!tpModal) return;
    const val = parseFloat(tpInput);
    if (isNaN(val) || val <= 0) { showToast(false, 'Enter a valid take-profit price'); return; }
    setUpdatingPos(tpModal.pos.dealId);
    const r = await updatePositionSL(tpModal.env, tpModal.pos, tpModal.pos.stopLevel ?? null, val);
    if (r.ok) {
      log('info', `[${tpModal.env.toUpperCase()}] Take-profit updated to ${val} on ${tpModal.pos.instrumentName ?? tpModal.pos.epic}`);
      showToast(true, `Take-profit moved to ${val}`);
      await loadPositions(tpModal.env);
      setTpModal(null); setTpInput('');
    } else {
      showToast(false, r.error ?? 'Update failed');
    }
    setUpdatingPos(null);
  }

  // ── Manual open ────────────────────────────────────────────────────────────
  async function handleManualOpen() {
    if (!manualEpic) { showToast(false, 'Select a market first'); return; }
    if (!sessions[manualEnv]) { showToast(false, `Not connected to ${manualEnv}`); return; }
    setPlacingManual(true);
    const r = await placeOrder(manualEnv, manualEpic, manualDir, manualSize,
      manualStop !== '' ? Number(manualStop) : undefined,
      manualLimit !== '' ? Number(manualLimit) : undefined);
    if (r.ok) {
      log(manualDir === 'BUY' ? 'buy' : 'sell',
        `[${manualEnv.toUpperCase()}] Manual ${manualDir} £${manualSize}/pt ${manualName || manualEpic} — ${r.dealStatus ?? 'ACCEPTED'} · ref ${r.dealReference ?? 'n/a'} · dealId ${r.dealId ?? 'pending'}`);
      showToast(true, `${manualDir} placed on ${manualName || manualEpic}`);
      await sleep(1500);
      await loadPositions(manualEnv);
    } else {
      log('error', `[${manualEnv.toUpperCase()}] Manual order failed: ${r.error ?? 'unknown'}${r.reason ? ` (${r.reason})` : ''}`);
      if (r.sentPayload) log('error', `  sent: ${JSON.stringify(r.sentPayload)}`);
      if (r.igBody)      log('error', `  ig:   ${JSON.stringify(r.igBody)}`);
      showToast(false, r.error ?? 'Order failed');
    }
    setPlacingManual(false);
  }

  // ── Builder helpers ────────────────────────────────────────────────────────
  function openBuilder(existing?: IGSavedStrategy) {
    if (existing) {
      setEditId(existing.id); setBName(existing.name); setBTimeframe(existing.timeframe);
      setBSize(existing.size); setBMaxPos(existing.maxPositions);
      setBMinStrength(existing.minStrength ?? 55);
      setBAccounts(existing.accounts); setBAutoClose(existing.autoClose ?? true);
      setBWatchlist(existing.watchlist?.length ? existing.watchlist : [...DEFAULT_WATCHLIST]);
      setBSignalScanMs(existing.signalScanMs ?? 5 * 60_000);
      setBPosMonitorMs(existing.posMonitorMs ?? 60_000);
    } else {
      setEditId(null); setBName(''); setBTimeframe('daily'); setBSize(1); setBMaxPos(3);
      setBMinStrength(60);
      // Only default to live if we actually have a live session
      setBAccounts([sessions[activeMode] ? activeMode : 'demo']);
      setBAutoClose(true);
      setBWatchlist([...DEFAULT_WATCHLIST]);
      setBSignalScanMs(5 * 60_000);
      setBPosMonitorMs(60_000);
    }
    setShowBuilder(true);
    setShowManual(false);
  }

  function handleSave() {
    if (!bName.trim()) { showToast(false, 'Strategy name is required'); return; }
    if (bAccounts.length === 0) { showToast(false, 'Select at least one account'); return; }
    const s: IGSavedStrategy = {
      id: editId ?? uid(),
      name: bName.trim(),
      epic: '', instrumentName: '', // legacy fields, unused in auto mode
      watchlist: bWatchlist,
      minStrength: bMinStrength,
      timeframe: bTimeframe,
      size: bSize,
      maxPositions: bMaxPos,
      accounts: bAccounts,
      autoTrade: true,
      autoClose: bAutoClose,
      createdAt: new Date().toISOString(),
      signalScanMs: bSignalScanMs,
      posMonitorMs: bPosMonitorMs,
    };
    saveStrategy(s);
    setStrategies(loadStrategies());
    setShowBuilder(false);
    showToast(true, `Strategy "${s.name}" ${editId ? 'updated' : 'saved'}`);
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const anyConnected  = Object.values(sessions).some(Boolean);
  const isConnecting  = Object.values(connecting).some(Boolean);
  const activeStrat   = strategies.find(s => s.id === activeStratId) ?? null;
  const allPositions  = [...positions.demo, ...positions.live];
  const totalPnL      = allPositions.reduce((acc, p) => acc + (p.upl ?? 0), 0);
  const builderSession = sessions['demo'] ?? sessions['live'];

  // Show scanner for the active strategy's markets (even before first run)
  const activeScanMarkets = activeStrat
    ? (activeStrat.watchlist?.length ? activeStrat.watchlist : DEFAULT_WATCHLIST).filter(m => m.enabled).map(m => m.epic)
    : [];
  const scanEntries = activeScanMarkets.length > 0
    ? activeScanMarkets.map(epic => scans[epic] ?? { epic, name: (activeStrat!.watchlist?.find(m=>m.epic===epic) ?? DEFAULT_WATCHLIST.find(m=>m.epic===epic))?.name ?? epic, signal:null, scanning:false, status:'idle' as const })
    : Object.values(scans);

  // ── Not connected ──────────────────────────────────────────────────────────
  if (!anyConnected && !isConnecting) {
    return (
      <div className="max-w-xl space-y-4">
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-orange-500/20 flex items-center justify-center text-2xl">🤖</div>
            <div>
              <h3 className="text-sm font-semibold text-white">IG Auto-Trader</h3>
              <p className="text-xs text-gray-500">Fully automated spread-bet strategy engine</p>
            </div>
          </div>
          <p className="text-xs text-gray-400 mb-4">
            Connect your IG account in{' '}
            <a href="/settings/accounts" className="text-orange-400 hover:underline">Settings → Accounts</a>{' '}
            to start automated trading across FTSE, S&P 500, Gold, FX and more.
          </p>
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2.5 text-xs text-amber-400">
            ⚠️ Spread bets are complex instruments. 68% of retail accounts lose money. Only trade with money you can afford to lose.
          </div>
        </Card>
      </div>
    );
  }

  if (isConnecting && !anyConnected) {
    return <div className="flex items-center gap-3 text-gray-400 py-8"><RefreshCw className="h-5 w-5 animate-spin" /> Connecting to IG accounts…</div>;
  }

  // ── Connected view ─────────────────────────────────────────────────────────
  return (
    <div className="space-y-4 max-w-3xl">

      {/* Toast */}
      {toast && (
        <div className={clsx('flex items-center gap-2 rounded-lg px-3 py-2.5 text-xs font-medium',
          toast.ok ? 'bg-emerald-500/15 border border-emerald-500/25 text-emerald-400' : 'bg-red-500/15 border border-red-500/25 text-red-400'
        )}>
          {toast.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
          {toast.msg}
        </div>
      )}

      {/* ── LIVE mode banner ─────────────────────────────────────────────── */}
      {activeMode === 'live' && (
        <div className="bg-amber-500/15 border border-amber-500/40 rounded-lg px-3 py-2.5 flex items-center gap-2 text-xs font-semibold text-amber-400">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          LIVE MODE — Trades will use real money on your IG Live account
        </div>
      )}

      {/* ── Connection status bar ───────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          {/* Demo / Live mode selector */}
          <div className="flex items-center gap-0.5 bg-gray-800/60 rounded-full p-0.5">
            {(['demo','live'] as const).map(env => {
              const hasSession = !!sessions[env];
              const isLiveNoCredentials = env === 'live' && !hasSession && !connecting[env];
              return (
                <button key={env}
                  disabled={isLiveNoCredentials}
                  title={isLiveNoCredentials ? 'Add IG Live credentials in Settings → Accounts first' : undefined}
                  onClick={() => {
                    if (env === 'live') { setShowLiveConfirm(true); }
                    else { setActiveMode('demo'); }
                  }}
                  className={clsx('flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full transition-all',
                    isLiveNoCredentials ? 'opacity-30 cursor-not-allowed text-gray-600' :
                    activeMode === env
                      ? env === 'demo' ? 'bg-blue-500 text-white shadow' : 'bg-amber-500 text-black shadow'
                      : 'text-gray-500 hover:text-gray-300'
                  )}>
                  {env === 'live' && <span className="text-[9px]">⚠️</span>}
                  IG {env === 'demo' ? 'Demo' : 'Live'}
                  {hasSession
                    ? <span className={clsx('w-1.5 h-1.5 rounded-full', env==='demo' ? 'bg-blue-300' : 'bg-amber-300')} />
                    : connecting[env]
                      ? <RefreshCw className="h-2.5 w-2.5 animate-spin" />
                      : <span className="w-1.5 h-1.5 rounded-full bg-gray-600" />
                  }
                </button>
              );
            })}
          </div>
          {/* Connection chips */}
          {(['demo','live'] as const).map(env => sessions[env] && (
            <div key={env} className={clsx('flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full',
              env==='demo' ? 'bg-blue-500/15 text-blue-400' : 'bg-amber-500/15 text-amber-400'
            )}>
              <Wifi className="h-2.5 w-2.5" />
              #{sessions[env]!.accountId}
            </div>
          ))}
          <span className="text-[10px] text-gray-600 px-2 py-1 bg-gray-800/50 rounded-full">
            Signal: Yahoo Finance · Execution: IG
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => void loadPositions()} loading={loadingPos}>Refresh</Button>
          <Button size="sm" variant="outline" loading={testOrderBusy} disabled={!sessions.demo}
            title="Place a test £1/pt BUY on S&P 500 (demo) to verify order placement end-to-end"
            onClick={() => void runTestOrder()}>
            Test Order
          </Button>
          <Button size="sm" variant="outline" icon={<ArrowUpDown className="h-3.5 w-3.5" />} onClick={() => { setShowManual(v => !v); setShowBuilder(false); }}>Manual</Button>
          <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => { openBuilder(); }}>New Strategy</Button>
        </div>
      </div>

      {/* ── Live mode confirmation modal ────────────────────────────────── */}
      {showLiveConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="bg-gray-900 border border-amber-500/40 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center text-xl">⚠️</div>
              <div>
                <h3 className="text-sm font-bold text-white">Switch to LIVE Trading?</h3>
                <p className="text-xs text-amber-400">Real money will be used</p>
              </div>
            </div>
            <p className="text-xs text-gray-400 mb-5">
              You are switching to LIVE mode. Any strategies that trade on your Live IG account will open real spread-bet positions with real money. Make sure you have tested on Demo first.
            </p>
            <div className="flex gap-2">
              <Button fullWidth variant="outline" onClick={() => setShowLiveConfirm(false)}>Cancel</Button>
              <Button fullWidth className="bg-amber-500 hover:bg-amber-400 text-black font-bold"
                onClick={() => { setActiveMode('live'); setShowLiveConfirm(false); if (pendingRunAction) { pendingRunAction(); setPendingRunAction(null); } }}>
                Confirm — Use Live
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── First live trade disclaimer modal ──────────────────────────── */}
      {showLiveTradeDisclaimer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="bg-gray-900 border border-red-500/50 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-red-500/20 flex items-center justify-center text-xl">⚠️</div>
              <div>
                <h3 className="text-sm font-bold text-white">First Live Trade Warning</h3>
                <p className="text-xs text-red-400">Real money — read carefully</p>
              </div>
            </div>
            <div className="space-y-2 text-xs text-gray-300 mb-5">
              <p>Your strategy is about to open a <span className="text-white font-semibold">real spread-bet position</span> on your IG Live account.</p>
              <p>Spread bets are leveraged products. You can lose more than your initial deposit.</p>
              <p className="text-amber-400">This warning will only appear once. All future live trades will execute automatically without prompting.</p>
            </div>
            <div className="flex gap-2">
              <Button fullWidth variant="outline" onClick={() => {
                liveTradeResolveRef.current?.(false);
                liveTradeResolveRef.current = null;
                setShowLiveTradeDisclaimer(false);
              }}>Cancel Trade</Button>
              <Button fullWidth className="bg-red-600 hover:bg-red-500 text-white font-bold"
                onClick={() => {
                  liveTradeAckedRef.current = true;
                  localStorage.setItem('ig_live_first_trade_ack', '1');
                  liveTradeResolveRef.current?.(true);
                  liveTradeResolveRef.current = null;
                  setShowLiveTradeDisclaimer(false);
                }}>
                I Understand — Place Trade
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Risk warning */}
      <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 text-xs text-amber-400">
        ⚠️ Spread bets are complex. 68% of retail accounts lose money. Use Demo first. Not financial advice.
      </div>

      {/* ── Manual trade panel ─────────────────────────────────────────── */}
      {showManual && (
        <Card>
          <CardHeader title="Manual Trade" subtitle="Open a position directly on any market"
            icon={<ArrowUpDown className="h-4 w-4" />}
            action={<button onClick={() => setShowManual(false)}><X className="h-4 w-4 text-gray-500 hover:text-white" /></button>}
          />
          <div className="space-y-3">
            <div className="flex gap-2">
              {(['demo','live'] as const).map(env => (
                <button key={env} disabled={!sessions[env]} onClick={() => setManualEnv(env)}
                  className={clsx('flex-1 py-2 rounded-lg text-sm font-medium border transition-all',
                    !sessions[env] ? 'opacity-30 cursor-not-allowed bg-gray-800 text-gray-600 border-gray-700' :
                    manualEnv === env
                      ? env==='demo' ? 'bg-blue-500/20 text-blue-300 border-blue-500/40' : 'bg-red-500/20 text-red-300 border-red-500/40'
                      : 'bg-gray-800 text-gray-400 border-gray-700 hover:text-gray-200'
                  )}>{env==='demo' ? 'Demo' : '⚠️ Live'}</button>
              ))}
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1.5 block">Market</label>
              {builderSession
                ? <MarketSearch session={builderSession} env={manualEnv} onSelect={m => { setManualEpic(m.epic); setManualName(m.instrumentName); }} />
                : <p className="text-xs text-gray-500">No session</p>}
              {manualEpic && (
                <div className="mt-1.5 flex items-center gap-2 bg-orange-500/10 border border-orange-500/20 rounded-lg px-3 py-1.5 text-xs text-orange-300">
                  <CheckCircle2 className="h-3 w-3" /><span className="font-semibold">{manualName}</span>
                  <span className="font-mono opacity-60 text-[10px]">{manualEpic}</span>
                  <button onClick={() => { setManualEpic(''); setManualName(''); }} className="ml-auto text-gray-500 hover:text-white"><X className="h-3 w-3" /></button>
                </div>
              )}
            </div>
            <div className="grid grid-cols-4 gap-2">
              <div className="col-span-2">
                <label className="text-xs text-gray-400 mb-1.5 block">Direction</label>
                <div className="flex gap-1">
                  {(['BUY','SELL'] as const).map(d => (
                    <button key={d} onClick={() => setManualDir(d)} className={clsx('flex-1 py-2 rounded-lg text-sm font-bold border transition-all',
                      manualDir === d ? d==='BUY' ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' : 'bg-red-500/20 text-red-300 border-red-500/40'
                      : 'bg-gray-800 text-gray-500 border-gray-700')}>{d}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">£/pt</label>
                <input type="number" min={0.5} step={0.5} value={manualSize} onChange={e => setManualSize(Number(e.target.value))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-orange-500" />
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Stop (pt)</label>
                <input type="number" value={manualStop} onChange={e => setManualStop(e.target.value===''?'':Number(e.target.value))}
                  placeholder="opt"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-orange-500" />
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1.5 block">Take Profit (pts, optional)</label>
              <input type="number" value={manualLimit} onChange={e => setManualLimit(e.target.value===''?'':Number(e.target.value))} placeholder="Leave blank for no limit"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-orange-500" />
            </div>
            {manualEnv === 'live' && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-xs text-red-400">
                ⚠️ This opens a REAL position on your live IG account.
              </div>
            )}
            <Button fullWidth loading={placingManual} disabled={!manualEpic}
              className={manualDir==='BUY' ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-red-600 hover:bg-red-500 text-white'}
              icon={manualDir==='BUY' ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
              onClick={handleManualOpen}>
              {manualDir} £{manualSize}/pt {manualName || (manualEpic ? `(${manualEpic})` : '— pick market')} ({manualEnv})
            </Button>
          </div>
        </Card>
      )}

      {/* ── Strategy builder ───────────────────────────────────────────── */}
      {showBuilder && (
        <Card>
          <CardHeader title={editId ? 'Edit Strategy' : 'New Auto-Strategy'}
            subtitle="The strategy scans all enabled markets and trades the best signals automatically"
            icon={<Zap className="h-4 w-4" />}
            action={<button onClick={() => setShowBuilder(false)}><X className="h-4 w-4 text-gray-500 hover:text-white" /></button>}
          />
          <div className="space-y-4">

            {/* Name + timeframe */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Strategy Name *</label>
                <input value={bName} onChange={e => setBName(e.target.value)} placeholder="e.g. Daily Swing Bot"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-orange-500" />
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Timeframe</label>
                <select value={bTimeframe} onChange={e => setBTimeframe(e.target.value as Timeframe)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500">
                  <option value="rsi2">⭐ RSI(2) Mean Reversion — lowest API usage · scans once/day</option>
                  <option value="daily">Daily Swing — EMA20/50 + MACD · scans every 4hr</option>
                  <option value="longterm">Long-term — Golden/Death Cross · scans every 12hr</option>
                  <option value="hourly">Hourly Scalp — EMA9/21 + RSI · high API usage</option>
                </select>
              </div>
            </div>

            <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2 text-xs text-blue-300">
              {TIMEFRAME_CONFIG[bTimeframe].description} — Stop loss and take profit are set automatically from the signal.
            </div>

            {/* Risk per trade + max positions */}
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Size £/point</label>
                <input type="number" min={0.5} step={0.5} value={bSize} onChange={e => setBSize(Number(e.target.value))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500" />
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Max positions</label>
                <input type="number" min={1} max={20} value={bMaxPos} onChange={e => setBMaxPos(Number(e.target.value))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500" />
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Min signal strength</label>
                <div className="flex items-center gap-2">
                  <input type="range" min={40} max={95} step={5} value={bMinStrength} onChange={e => setBMinStrength(Number(e.target.value))}
                    className="flex-1 accent-orange-500" />
                  <span className="text-sm font-mono text-orange-400 w-8">{bMinStrength}%</span>
                </div>
              </div>
            </div>

            {/* Accounts */}
            <div>
              <label className="text-xs text-gray-400 mb-1.5 block">Trade on accounts</label>
              <div className="flex gap-2">
                {(['demo','live'] as const).map(acc => (
                  <button key={acc} disabled={!sessions[acc]}
                    onClick={() => setBAccounts(p => p.includes(acc) ? p.filter(a=>a!==acc) : [...p,acc])}
                    className={clsx('flex-1 py-2 rounded-lg text-sm font-medium border transition-all',
                      !sessions[acc] ? 'opacity-30 cursor-not-allowed bg-gray-800 text-gray-600 border-gray-700' :
                      bAccounts.includes(acc)
                        ? acc==='demo' ? 'bg-blue-500/20 text-blue-300 border-blue-500/40' : 'bg-red-500/20 text-red-300 border-red-500/40'
                        : 'bg-gray-800 text-gray-500 border-gray-700 hover:text-gray-300'
                    )}>
                    {acc==='demo' ? 'Demo' : '⚠️ Live (real money)'}
                    {!sessions[acc] && <span className="block text-[10px] opacity-50">not connected</span>}
                  </button>
                ))}
              </div>
            </div>

            {/* Auto-close toggle */}
            <div className="flex items-center justify-between bg-gray-800/40 rounded-lg px-3 py-2.5">
              <div>
                <p className="text-xs font-medium text-white">Auto-close on reversal</p>
                <p className="text-[11px] text-gray-500">Close opposing positions automatically when signal flips</p>
              </div>
              <button onClick={() => setBAutoClose(v => !v)}
                className={clsx('w-11 h-6 rounded-full transition-all relative flex-shrink-0', bAutoClose ? 'bg-orange-500' : 'bg-gray-700')}>
                <span className={clsx('absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all', bAutoClose ? 'left-5' : 'left-0.5')} />
              </button>
            </div>

            {/* Scan frequency */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Signal scan interval</label>
                <select value={bSignalScanMs} onChange={e => setBSignalScanMs(Number(e.target.value))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500">
                  <option value={5 * 60_000}>5 minutes</option>
                  <option value={10 * 60_000}>10 minutes</option>
                  <option value={15 * 60_000}>15 minutes</option>
                  <option value={30 * 60_000}>30 minutes</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Position monitor interval</label>
                <select value={bPosMonitorMs} onChange={e => setBPosMonitorMs(Number(e.target.value))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500">
                  <option value={30_000}>30 seconds</option>
                  <option value={60_000}>60 seconds</option>
                  <option value={2 * 60_000}>2 minutes</option>
                </select>
              </div>
            </div>

            {/* Watchlist */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-gray-400">Markets to scan</label>
                <span className="text-[10px] text-gray-600">
                  {bWatchlist.filter(m=>m.enabled).length} enabled · signals via Yahoo Finance
                </span>
              </div>
              <div className="space-y-1 max-h-56 overflow-y-auto border border-gray-800 rounded-lg divide-y divide-gray-800/50">
                {bWatchlist.map((m, i) => (
                  <div key={m.epic} className="flex items-center justify-between px-3 py-2 gap-2">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <button onClick={() => setBWatchlist(p => p.map((x,xi) => xi===i ? {...x,enabled:!x.enabled} : x))}
                        className={clsx('w-4 h-4 rounded flex items-center justify-center flex-shrink-0 transition-all',
                          m.enabled ? 'bg-orange-500' : 'bg-gray-700 border border-gray-600')}>
                        {m.enabled && <span className="text-white text-[8px] font-bold">✓</span>}
                      </button>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-white font-medium">{m.name}</p>
                        <p className="text-[10px] text-gray-500 font-mono truncate">{m.epic}</p>
                      </div>
                    </div>
                    {/* Force Trade toggle */}
                    <button
                      onClick={() => setBWatchlist(p => p.map((x,xi) => xi===i ? {...x,forceOpen:!x.forceOpen} : x))}
                      title={m.forceOpen ? 'Force: always trade this market regardless of signal' : 'Signal only: trade when signal meets threshold'}
                      className={clsx('text-[9px] px-1.5 py-0.5 rounded border flex-shrink-0 transition-all font-semibold',
                        m.forceOpen
                          ? 'bg-orange-500/25 text-orange-400 border-orange-500/40'
                          : 'bg-gray-800 text-gray-600 border-gray-700 hover:text-gray-400'
                      )}>
                      {m.forceOpen ? 'FORCE' : 'signal'}
                    </button>
                    <button onClick={() => setBWatchlist(p => p.filter((_,xi) => xi!==i))}
                      className="text-gray-600 hover:text-red-400 transition-colors flex-shrink-0">
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
              {/* Add custom market */}
              {builderSession && (
                <div className="mt-2">
                  <p className="text-[10px] text-gray-500 mb-1.5">Add a market to the watchlist:</p>
                  <MarketSearch session={builderSession} env={bAccounts.includes('live') ? 'live' : 'demo'}
                    onSelect={m => {
                      if (!bWatchlist.some(x => x.epic === m.epic))
                        setBWatchlist(p => [...p, { epic: m.epic, name: m.instrumentName, enabled: true }]);
                    }}
                  />
                </div>
              )}
            </div>

            {bAccounts.includes('live') && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-xs text-red-400">
                ⚠️ Auto-trading on LIVE will open real positions with real money. Always test on Demo first.
              </div>
            )}

            <Button fullWidth icon={<Save className="h-4 w-4" />} onClick={handleSave}>
              {editId ? 'Update Strategy' : 'Save Strategy'}
            </Button>
          </div>
        </Card>
      )}

      {/* ── Strategies + run controls ───────────────────────────────────── */}
      {strategies.length === 0 && !showBuilder ? (
        <div className="text-center py-10 text-gray-500 border border-dashed border-gray-800 rounded-xl">
          <Target className="h-12 w-12 mx-auto mb-3 opacity-20" />
          <p className="text-sm font-medium">No strategies yet</p>
          <p className="text-xs mt-1 mb-4">Create a strategy and the bot will scan markets and trade automatically</p>
          <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => openBuilder()}>Create First Strategy</Button>
        </div>
      ) : (
        <div className="space-y-2">
          {strategies.map(strat => {
            const isActive = strat.id === activeStratId;
            const enabledMarkets = (strat.watchlist?.length ? strat.watchlist : DEFAULT_WATCHLIST).filter(m => m.enabled);
            const cfg = TIMEFRAME_CONFIG[strat.timeframe];
            return (
              <Card key={strat.id} className={clsx(isActive && 'border-orange-500/40 bg-orange-500/[0.03]')}>
                <div className="flex items-start justify-between gap-3">
                  {/* Strategy info */}
                  <button className="flex-1 text-left min-w-0" onClick={() => setActiveStratId(isActive ? null : strat.id)}>
                    <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                      <p className="text-sm font-bold text-white">{strat.name}</p>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-300">{cfg.label}</span>
                      {strat.accounts.map(a => (
                        <span key={a} className={clsx('text-[10px] px-1.5 py-0.5 rounded-full',
                          a==='demo' ? 'bg-blue-500/20 text-blue-400' : 'bg-red-500/20 text-red-400')}>{a}</span>
                      ))}
                      {strat.autoClose && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-500/20 text-purple-400">AutoClose</span>}
                    </div>
                    <p className="text-[11px] text-gray-500">
                      {enabledMarkets.length} markets · £{strat.size}/pt · max {strat.maxPositions} pos · min {strat.minStrength ?? 55}% signal
                      {strat.lastRunAt && (
                        <span> · last {fmtTime(strat.lastRunAt)}
                          {strat.lastRunEnv && (
                            <span className={strat.lastRunEnv === 'live' ? ' text-amber-400' : ' text-blue-400'}>
                              {' '}on {strat.lastRunEnv === 'live' ? 'LIVE' : 'demo'}
                            </span>
                          )}
                        </span>
                      )}
                    </p>
                  </button>

                  {/* Controls */}
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {isActive && isRunning ? (
                      <Button size="sm" className="bg-red-600 hover:bg-red-500 text-white" icon={<Square className="h-3.5 w-3.5" />} onClick={stopAutoRun}>
                        Stop
                      </Button>
                    ) : (
                      <Button size="sm"
                        className={strat.accounts.includes('live') ? 'bg-amber-600 hover:bg-amber-500 text-black font-bold' : 'bg-orange-600 hover:bg-orange-500 text-white'}
                        icon={<Play className="h-3.5 w-3.5" />}
                        onClick={() => {
                          const doRun = () => { setActiveStratId(strat.id); startAutoRun(strat); };
                          if (strat.accounts.includes('live')) {
                            setPendingRunAction(() => doRun);
                            setShowLiveConfirm(true);
                          } else {
                            doRun();
                          }
                        }}>
                        {strat.accounts.includes('live') ? '⚠️ Run Live' : (isActive ? 'Start' : 'Run')}
                      </Button>
                    )}
                    <Button size="sm" variant="outline"
                      loading={testRunning && isActive}
                      disabled={isRunning || testRunning}
                      onClick={() => { setActiveStratId(strat.id); void runTestScan(strat); }}
                      title="Run one scan cycle — opens max 1 position">
                      Test
                    </Button>
                    <button onClick={() => openBuilder(strat)} className="p-1.5 text-gray-600 hover:text-orange-400 transition-colors"><Edit2 className="h-3.5 w-3.5" /></button>
                    <button onClick={() => { deleteStrategy(strat.id); setStrategies(loadStrategies()); if (activeStratId===strat.id) stopAutoRun(); }}
                      className="p-1.5 text-gray-600 hover:text-red-400 transition-colors"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                </div>

                {/* Running status */}
                {isActive && isRunning && (
                  <div className="mt-2 bg-orange-500/10 border border-orange-500/20 rounded-lg px-3 py-2 space-y-1">
                    <div className="flex items-center gap-2">
                      <Activity className="h-3.5 w-3.5 text-orange-400 animate-pulse flex-shrink-0" />
                      <span className="text-xs text-orange-300 font-medium">
                        {scanProgress ? `Scanning: ${scanProgress}` : 'Running'}
                      </span>
                    </div>
                    <div className="flex items-center gap-4 text-[11px] text-gray-500 pl-5">
                      {signalCountdown && <span>Next signal scan in: <span className="text-orange-400 font-mono">{signalCountdown}</span></span>}
                      {posCountdown && <span>Position check in: <span className="text-blue-400 font-mono">{posCountdown}</span></span>}
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* ── Market Scanner Grid ─────────────────────────────────────────── */}
      {scanEntries.length > 0 && (
        <Card>
          <CardHeader
            title="Market Scanner"
            subtitle={
              scanEntries.some(s => s.status === 'ok')
                ? `Yahoo Finance · ${scanEntries.filter(s=>s.status==='ok').length}/${scanEntries.length} markets · last ${fmtTime(scanEntries.find(s=>s.lastScanned)?.lastScanned ?? new Date().toISOString())}`
                : `Yahoo Finance · ${scanEntries.length} markets ready — click Run to start`
            }
            icon={<Settings className="h-4 w-4" />}
          />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {scanEntries.map(scan => (
              <div key={scan.epic} className={clsx('rounded-lg border p-2.5 transition-all',
                scan.scanning                    ? 'border-orange-500/40 bg-orange-500/5 animate-pulse' :
                scan.status === 'error'          ? 'border-red-500/30 bg-red-500/5' :
                scan.signal?.direction === 'BUY' ? 'border-emerald-500/30 bg-emerald-500/5' :
                scan.signal?.direction === 'SELL'? 'border-red-500/30 bg-red-500/5' :
                scan.status === 'idle'           ? 'border-gray-700/50 bg-gray-800/10' :
                'border-gray-800 bg-gray-800/20'
              )}>
                {/* Header row: name + signal badge / spinner */}
                <div className="flex items-start justify-between gap-1 mb-1.5">
                  <p className="text-xs font-semibold text-white leading-tight">{scan.name}</p>
                  {scan.scanning
                    ? <RefreshCw className="h-3 w-3 text-orange-400 animate-spin flex-shrink-0 mt-0.5" />
                    : scan.status === 'error'
                      ? <AlertCircle className="h-3 w-3 text-red-400 flex-shrink-0 mt-0.5" />
                      : scan.status === 'idle'
                        ? <Minus className="h-3 w-3 text-gray-600 flex-shrink-0 mt-0.5" />
                        : scan.signal && <DirectionBadge dir={scan.signal.direction} size="xs" />
                  }
                </div>

                {/* Idle */}
                {scan.status === 'idle' && !scan.scanning && (
                  <p className="text-[10px] text-gray-600">Waiting for scan…</p>
                )}

                {/* OK: price + % change + source badge */}
                {scan.status === 'ok' && scan.signal && !scan.scanning && (
                  <div className="space-y-1">
                    {/* Price */}
                    {scan.price !== undefined && (
                      <p className="text-sm font-bold text-white tabular-nums">
                        {scan.price > 100
                          ? scan.price.toLocaleString('en-GB', { maximumFractionDigits: 1 })
                          : scan.price.toFixed(4)}
                      </p>
                    )}
                    {/* Daily change */}
                    {scan.changePercent !== undefined && (
                      <p className={clsx('text-[11px] font-semibold flex items-center gap-0.5',
                        scan.changePercent >= 0 ? 'text-emerald-400' : 'text-red-400'
                      )}>
                        {scan.changePercent >= 0
                          ? <TrendingUp className="h-3 w-3" />
                          : <TrendingDown className="h-3 w-3" />}
                        {scan.changePercent >= 0 ? '+' : ''}{scan.changePercent.toFixed(2)}%
                      </p>
                    )}
                    {/* Source badge */}
                    <span className="inline-block text-[9px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-500 border border-gray-700/50">
                      Yahoo Finance
                    </span>
                  </div>
                )}

                {/* Error */}
                {scan.status === 'error' && (
                  <div>
                    <p className="text-[10px] text-red-400 mt-0.5 break-all leading-relaxed">{scan.error}</p>
                    <p className="text-[9px] text-gray-600 mt-1">Auto-retry on next run</p>
                  </div>
                )}
              </div>
            ))}
          </div>
          {scanEntries.some(s => s.status === 'error') && (
            <p className="text-[11px] text-amber-400 mt-3 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
              ⚠️ Some markets failed to load from Yahoo Finance. Market may be closed or temporarily unavailable. The bot will retry on the next run.
            </p>
          )}
        </Card>
      )}

      {/* ── SL Modal ──────────────────────────────────────────────────── */}
      {slModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            <h3 className="text-sm font-bold text-white mb-1">Move Stop-Loss</h3>
            <p className="text-xs text-gray-500 mb-4">{slModal.pos.instrumentName ?? slModal.pos.epic} · current SL: {slModal.pos.stopLevel ?? 'none'}</p>
            <input type="number" value={slInput} onChange={e => setSlInput(e.target.value)}
              placeholder="New stop-loss price" autoFocus
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-orange-500 mb-3" />
            <div className="flex gap-2">
              <Button fullWidth variant="outline" onClick={() => { setSlModal(null); setSlInput(''); }}>Cancel</Button>
              <Button fullWidth loading={updatingPos === slModal.pos.dealId} onClick={handleUpdateSL}
                className="bg-orange-600 hover:bg-orange-500 text-white">Update SL</Button>
            </div>
          </div>
        </div>
      )}

      {/* ── TP Modal ──────────────────────────────────────────────────── */}
      {tpModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            <h3 className="text-sm font-bold text-white mb-1">Move Take-Profit</h3>
            <p className="text-xs text-gray-500 mb-4">{tpModal.pos.instrumentName ?? tpModal.pos.epic} · current TP: {tpModal.pos.limitLevel ?? 'none'}</p>
            <input type="number" value={tpInput} onChange={e => setTpInput(e.target.value)}
              placeholder="New take-profit price" autoFocus
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-orange-500 mb-3" />
            <div className="flex gap-2">
              <Button fullWidth variant="outline" onClick={() => { setTpModal(null); setTpInput(''); }}>Cancel</Button>
              <Button fullWidth loading={updatingPos === tpModal.pos.dealId} onClick={handleUpdateTP}
                className="bg-emerald-600 hover:bg-emerald-500 text-white">Update TP</Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Positions + Working Orders ─────────────────────────────────── */}
      <Card>
        {/* Tab bar */}
        <div className="flex items-center gap-0.5 mb-4 bg-gray-800/50 rounded-lg p-1 w-fit">
          {(['positions','orders'] as const).map(tab => {
            const count = tab === 'positions' ? allPositions.length : [...workingOrders.demo, ...workingOrders.live].length;
            return (
              <button key={tab} onClick={() => setPosTab(tab)}
                className={clsx('px-3 py-1.5 text-xs font-medium rounded-md transition-all flex items-center gap-1.5',
                  posTab === tab ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
                )}>
                {tab === 'positions' ? <BarChart3 className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
                {tab === 'positions' ? 'Positions' : 'Working Orders'}
                {count > 0 && <span className={clsx('text-[9px] px-1 rounded-full', posTab===tab ? 'bg-orange-500/30 text-orange-300' : 'bg-gray-700 text-gray-500')}>{count}</span>}
              </button>
            );
          })}
          <button onClick={() => { void loadPositions(); void loadWorkingOrders(); }}
            className="ml-1 p-1.5 text-gray-600 hover:text-white transition-colors" title="Refresh">
            <RefreshCw className={clsx('h-3 w-3', loadingPos && 'animate-spin')} />
          </button>
        </div>

        {/* Positions tab */}
        {posTab === 'positions' && (
          <>
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs text-gray-500">{allPositions.length} open · P&L: <span className={clsx('font-semibold', totalPnL>=0?'text-emerald-400':'text-red-400')}>{totalPnL>=0?'+':''}{fmt(totalPnL)}</span></p>
              <span className="text-[10px] text-gray-600">Auto-refresh every 30s</span>
            </div>
            {posError && (
              <div className="mb-3 flex items-start gap-2 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-xs text-red-400">
                <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                <span className="break-all">{posError}</span>
              </div>
            )}
            {allPositions.length === 0 ? (
              <p className="text-sm text-gray-500 py-3 text-center">No open positions</p>
            ) : (
              <div className="space-y-4">
                {(['demo','live'] as const).map(env => positions[env].length > 0 && (
                  <div key={env}>
                    <p className={clsx('text-[10px] font-bold uppercase tracking-wider mb-2',
                      env==='demo' ? 'text-blue-400' : 'text-red-400')}>{env}</p>
                    <div className="space-y-2">
                      {positions[env].map(pos => (
                        <PositionCard key={pos.dealId} pos={pos} env={env}
                          closingId={closingId} reversingId={reversingPos}
                          onClose={handleClose}
                          onMoveSL={p => { setSlModal({env,pos:p}); setSlInput(p.stopLevel?.toString()??''); }}
                          onMoveTP={p => { setTpModal({env,pos:p}); setTpInput(p.limitLevel?.toString()??''); }}
                          onReverse={reversePosition}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* Working Orders tab */}
        {posTab === 'orders' && (
          <>
            <p className="text-xs text-gray-500 mb-3">Pending LIMIT and STOP orders waiting to be triggered</p>
            {[...workingOrders.demo.map(o=>({...o,env:'demo' as const})), ...workingOrders.live.map(o=>({...o,env:'live' as const}))].length === 0 ? (
              <p className="text-sm text-gray-500 py-3 text-center">No pending working orders</p>
            ) : (
              <div className="space-y-3">
                {(['demo','live'] as const).map(env => workingOrders[env].length > 0 && (
                  <div key={env}>
                    <p className={clsx('text-[10px] font-bold uppercase tracking-wider mb-2',
                      env==='demo' ? 'text-blue-400' : 'text-red-400')}>{env}</p>
                    <div className="space-y-1.5">
                      {workingOrders[env].map(wo => (
                        <div key={wo.dealId} className="bg-gray-800/40 rounded-lg px-3 py-2.5 flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className={clsx('text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0',
                              wo.orderType === 'LIMIT' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'
                            )}>{wo.orderType}</span>
                            <DirectionBadge dir={wo.direction} size="xs" />
                            <div className="min-w-0">
                              <p className="text-xs font-semibold text-white truncate">{wo.instrumentName || wo.epic}</p>
                              <p className="text-[10px] text-gray-500">
                                £{wo.size}/pt · trigger @ {wo.level}
                                {wo.stopLevel ? ` · SL ${wo.stopLevel}` : ''}
                                {wo.limitLevel ? ` · TP ${wo.limitLevel}` : ''}
                              </p>
                            </div>
                          </div>
                          <button onClick={() => void cancelWorkingOrder(env, wo.dealId)}
                            disabled={cancellingOrder === wo.dealId}
                            className="text-xs text-red-400 border border-red-500/30 px-2 py-1 rounded-lg hover:bg-red-500/10 transition-colors shrink-0 disabled:opacity-50">
                            {cancellingOrder === wo.dealId ? '…' : 'Cancel'}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Card>

      {/* ── Activity Log ────────────────────────────────────────────────── */}
      {runLog.length > 0 && (
        <Card>
          <CardHeader title="Activity Log" subtitle={`${runLog.length} entries`} icon={<Clock className="h-4 w-4" />}
            action={<button onClick={() => setRunLog([])} className="text-xs text-gray-500 hover:text-white">Clear</button>}
          />
          <div className="space-y-0.5 max-h-64 overflow-y-auto font-mono">
            {runLog.map(e => (
              <div key={e.id} className="flex gap-2 text-[11px] py-0.5">
                <span className="text-gray-600 flex-shrink-0 tabular-nums">{fmtTime(e.ts)}</span>
                <span className={clsx('flex-1 break-all leading-relaxed',
                  e.type==='buy'    ? 'text-emerald-400' :
                  e.type==='sell'   ? 'text-red-400' :
                  e.type==='close'  ? 'text-blue-400' :
                  e.type==='error'  ? 'text-red-500' :
                  e.type==='signal' ? 'text-amber-400' : 'text-gray-400'
                )}>{e.msg}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <p className="text-[10px] text-gray-600 text-center">
        Spread betting profits are exempt from UK CGT and Income Tax · Losses cannot be offset against gains
      </p>
    </div>
  );
}

// ── Position card ─────────────────────────────────────────────────────────────

function PositionCard({ pos, env, closingId, reversingId, onClose, onMoveSL, onMoveTP, onReverse }: {
  pos:        IGPosition;
  env:        'demo'|'live';
  closingId:  string|null;
  reversingId:string|null;
  onClose:    (env:'demo'|'live', pos:IGPosition) => void;
  onMoveSL:   (pos:IGPosition) => void;
  onMoveTP:   (pos:IGPosition) => void;
  onReverse:  (env:'demo'|'live', pos:IGPosition) => void;
}) {
  const [exp, setExp] = useState(false);
  const currentPx = pos.direction === 'BUY' ? (pos.bid ?? pos.level) : (pos.offer ?? pos.level);
  const entryPx   = pos.level ?? 0;
  const pnlPct    = entryPx > 0
    ? pos.direction === 'BUY'
      ? ((currentPx - entryPx) / entryPx) * 100
      : ((entryPx - currentPx) / entryPx) * 100
    : 0;

  return (
    <div className="bg-gray-800/40 rounded-lg overflow-hidden">
      {/* Main row */}
      <div className="flex items-start justify-between px-3 py-2.5 gap-3">
        <button className="flex-1 min-w-0 text-left flex items-start gap-2" onClick={() => setExp(v=>!v)}>
          <DirectionBadge dir={pos.direction} />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-white truncate">{pos.instrumentName ?? pos.epic}</p>
            <div className="flex items-center gap-3 flex-wrap mt-0.5">
              <span className="text-[10px] text-gray-500">£{pos.size}/pt</span>
              <span className="text-[10px] text-gray-500">Entry: <span className="text-white font-mono">{entryPx}</span></span>
              <span className="text-[10px] text-gray-500">Now: <span className="font-mono text-white">{currentPx}</span></span>
              {pos.stopLevel  && <span className="text-[10px] text-red-400">SL: {pos.stopLevel}</span>}
              {pos.limitLevel && <span className="text-[10px] text-emerald-400">TP: {pos.limitLevel}</span>}
            </div>
          </div>
          {exp ? <ChevronUp className="h-3 w-3 text-gray-600 flex-shrink-0 mt-1" /> : <ChevronDown className="h-3 w-3 text-gray-600 flex-shrink-0 mt-1" />}
        </button>
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          {/* P&L */}
          <div className="text-right">
            <p className={clsx('text-sm font-bold font-mono', (pos.upl??0)>=0 ? 'text-emerald-400' : 'text-red-400')}>
              {(pos.upl??0)>=0?'+':''}{fmt(pos.upl??0)}
            </p>
            <p className={clsx('text-[10px]', pnlPct>=0?'text-emerald-400/70':'text-red-400/70')}>
              {pnlPct>=0?'+':''}{pnlPct.toFixed(2)}%
            </p>
          </div>
        </div>
      </div>

      {/* Action buttons */}
      <div className="px-3 pb-2.5 flex items-center gap-1.5 flex-wrap">
        <Button size="sm" variant="outline" loading={closingId===pos.dealId}
          onClick={() => onClose(env, pos)} className="text-red-400 border-red-500/30 hover:bg-red-500/10 text-[11px]">
          Close
        </Button>
        <button onClick={() => onMoveSL(pos)}
          className="text-[11px] px-2 py-1 rounded-lg border border-gray-700 text-gray-400 hover:text-orange-400 hover:border-orange-500/30 transition-colors">
          Move SL
        </button>
        <button onClick={() => onMoveTP(pos)}
          className="text-[11px] px-2 py-1 rounded-lg border border-gray-700 text-gray-400 hover:text-emerald-400 hover:border-emerald-500/30 transition-colors">
          Move TP
        </button>
        <button onClick={() => onReverse(env, pos)} disabled={reversingId === pos.dealId}
          className="text-[11px] px-2 py-1 rounded-lg border border-gray-700 text-gray-400 hover:text-purple-400 hover:border-purple-500/30 transition-colors disabled:opacity-50">
          {reversingId === pos.dealId ? '…' : 'Reverse'}
        </button>
      </div>

      {/* Expanded details */}
      {exp && (
        <div className="px-3 pb-2.5 pt-2 grid grid-cols-3 gap-2 text-[11px] border-t border-gray-700/30">
          <div><p className="text-gray-600">Bid</p><p className="text-white font-mono">{pos.bid}</p></div>
          <div><p className="text-gray-600">Offer</p><p className="text-white font-mono">{pos.offer}</p></div>
          <div><p className="text-gray-600">Currency</p><p className="text-white">{pos.currency} <span className="text-emerald-400 text-[9px]">TAX FREE</span></p></div>
          <div><p className="text-gray-600">Stop</p><p className={clsx('font-mono', pos.stopLevel ? 'text-red-400' : 'text-gray-600')}>{pos.stopLevel ?? '—'}</p></div>
          <div><p className="text-gray-600">Limit</p><p className={clsx('font-mono', pos.limitLevel ? 'text-emerald-400' : 'text-gray-600')}>{pos.limitLevel ?? '—'}</p></div>
          <div><p className="text-gray-600">Risk:Reward</p><p className="text-white">{pos.stopLevel && pos.limitLevel && pos.level ? `1:${((Math.abs(pos.limitLevel-pos.level))/(Math.abs(pos.stopLevel-pos.level))).toFixed(1)}` : '—'}</p></div>
          <div className="col-span-3"><p className="text-gray-600">Deal ID</p><p className="text-gray-400 font-mono text-[10px] break-all">{pos.dealId}</p></div>
        </div>
      )}
    </div>
  );
}

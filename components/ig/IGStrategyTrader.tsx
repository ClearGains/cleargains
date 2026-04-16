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
  TIMEFRAME_CONFIG, DEFAULT_WATCHLIST, CFD_WATCHLIST, getMarketType,
} from '@/lib/igStrategyEngine';
import {
  IG_ACCOUNT_CFD, IG_ACCOUNT_SPREADBET,
  type AccountType,
  accountLabel, accountTypeOf,
  EPIC_TABLE, epicForAccount, toCfdEpic, toSpreadbetEpic,
  getStopDistances, MIN_STRENGTH,
} from '@/lib/igConfig';
import { igQueue } from '@/lib/igApiQueue';

// ── Types ─────────────────────────────────────────────────────────────────────

type IGSession = { cst: string; securityToken: string; accountId: string; apiKey: string; accountType?: string };

type IGSubAccount = {
  accountId:   string;
  accountName: string;
  accountType: string;  // 'SPREADBET' | 'CFD' | 'SHARES'
  balance?: { balance: number; available: number };
};

type IGPosition = {
  dealId:           string;
  direction:        string;
  size:             number;
  level:            number;
  upl:              number;
  currency:         string;
  epic:             string;
  instrumentName:   string;
  bid:              number;
  offer:            number;
  stopLevel?:       number;
  limitLevel?:      number;
  contractSize?:    number;
  createdDate?:     string;
  subAccountId?:    string;   // which IG sub-account this position belongs to
  subAccountType?:  string;   // 'SPREADBET' | 'CFD' | 'SHARES'
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

// PERMISSION: Dynamic position sizing based on available capital.
// Caps order size to at most 5% of available funds, minimum 0.1 £/pt.
// Returns 0 (skip trade) if available falls below £100.
function calcDynamicSize(requestedSize: number, available: number): number {
  if (available < 100) return 0;       // pause if critically low
  if (available < 500) return 0.1;     // minimum viable size when funds low
  const pctBased = Math.floor((available * 0.05) * 10) / 10; // 5% of available, rounded to 0.1 steps
  return Math.min(requestedSize, Math.max(0.1, pctBased));
}

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

    // Build auth body: use stored credentials if available, otherwise let the
    // server fall back to its IG_USERNAME / IG_PASSWORD / IG_API_KEY env vars.
    let authBody: Record<string, unknown>;
    if (raw) {
      const c = JSON.parse(raw) as { username:string; password:string; apiKey:string; connected?:boolean };
      if (!c.connected) return null;
      authBody = { username: c.username, password: c.password, apiKey: c.apiKey, env, forceRefresh };
    } else {
      // No stored credentials — use server env vars (IG_USERNAME / IG_PASSWORD / IG_API_KEY)
      authBody = { env, forceRefresh, useEnvCredentials: true };
    }

    const r = await igQueue.enqueue(() =>
      fetch('/api/ig/session', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(authBody) }),
    );
    const d = await r.json() as { ok:boolean; cst?:string; securityToken?:string; accountId?:string; accounts?: unknown[] };
    if (d.ok && d.cst && d.securityToken) {
      const apiKey = raw ? (JSON.parse(raw) as { apiKey: string }).apiKey : '';
      const sess: IGSession = { cst:d.cst, securityToken:d.securityToken, accountId:d.accountId??'', apiKey };
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
    case 'INDEX':     return { stopDist: 20,  limitDist: 40  };
    case 'FOREX':     return { stopDist: 20,  limitDist: 40  };
    case 'COMMODITY': return { stopDist: 2,   limitDist: 4   };
    case 'CRYPTO':    return { stopDist: 50,  limitDist: 100 };
    case 'STOCK':     return { stopDist: 50,  limitDist: 100 };
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
    case 'STOCK':
      strength = pct >= 3.0 ? 85 : pct >= 2.0 ? 75 : pct >= 1.0 ? 65 : Math.round((pct / 1.0) * 60);
      break;
  }
  return { direction: dir, strength: Math.min(99, Math.max(0, strength)) };
}

// ── Trade history ─────────────────────────────────────────────────────────────

const IG_TRADE_HISTORY_KEY = 'ig_trade_history';

export interface IGTradeRecord {
  id:            string;
  portfolioName: string;
  market:        string;
  epic:          string;
  direction:     'BUY' | 'SELL';
  size:          number;
  entryLevel:    number;
  exitLevel:     number | null;
  openedAt:      string;
  closedAt:      string | null;
  status:        'OPEN' | 'CLOSED' | 'REJECTED';
  dealReference: string;
  dealId:        string;
  pnl:           number | null;
  closeReason:   'STOP_LOSS' | 'TAKE_PROFIT' | 'MANUAL' | 'STRATEGY' | 'STALE' | null;
  accountType:   'demo' | 'live';
}

function loadIGTradeHistory(): IGTradeRecord[] {
  try {
    const raw = typeof window !== 'undefined' ? localStorage.getItem(IG_TRADE_HISTORY_KEY) : null;
    if (!raw) return [];
    return JSON.parse(raw) as IGTradeRecord[];
  } catch { return []; }
}

function saveIGTradeHistory(records: IGTradeRecord[]): void {
  try { localStorage.setItem(IG_TRADE_HISTORY_KEY, JSON.stringify(records.slice(0, 500))); } catch {}
}

function recordTradeOpen(
  prev: IGTradeRecord[],
  rec: Omit<IGTradeRecord, 'id'>,
): IGTradeRecord[] {
  const next = [{ ...rec, id: Date.now().toString() }, ...prev];
  saveIGTradeHistory(next);
  return next;
}

function recordTradeClose(
  prev: IGTradeRecord[],
  dealId: string,
  exitLevel: number,
  pnl: number,
  closeReason: IGTradeRecord['closeReason'],
  closedAt: string,
): IGTradeRecord[] {
  const next = prev.map(r =>
    (r.dealId === dealId || (r.dealId === '' && r.status === 'OPEN')) && r.status === 'OPEN'
      ? { ...r, exitLevel, pnl, closeReason, closedAt, status: 'CLOSED' as const }
      : r
  );
  saveIGTradeHistory(next);
  return next;
}

// ── Main component ────────────────────────────────────────────────────────────

export function IGStrategyTrader() {

  // ── Sessions ───────────────────────────────────────────────────────────────
  const [sessions, setSessions]     = useState<Partial<Record<'demo'|'live', IGSession>>>({});
  const [connecting, setConnecting] = useState<Partial<Record<'demo'|'live', boolean>>>({});

  /**
   * Mutable ref mirror of `sessions` — always holds the latest tokens.
   * React state updates are async so stale closures inside setInterval/useCallback
   * would otherwise read old CST/securityToken values.  Every write to sessions
   * must go through `storeSession()` which keeps ref + state + localStorage in sync.
   */
  const sessionsRef  = useRef<Partial<Record<'demo'|'live', IGSession>>>({});

  /**
   * Trade lock — ensures IG orders are placed sequentially.
   * IG rejects concurrent requests on the same session.
   */
  const tradeLockRef = useRef(false);

  /**
   * Re-auth cooldown — tracks when we last forced a full re-login per env.
   * We never re-auth more than once per 30 seconds; 403 (rate limit) never
   * triggers a re-auth at all.
   */
  const lastReauthRef = useRef<Partial<Record<'demo'|'live', number>>>({});

  // ── Sub-accounts ───────────────────────────────────────────────────────────
  const [subAccounts, setSubAccounts]         = useState<Partial<Record<'demo'|'live', IGSubAccount[]>>>({});
  const [selectedSubAccount, setSelectedSubAccount] = useState<Partial<Record<'demo'|'live', string>>>({});

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

  // ── Test Order / Diagnostic ───────────────────────────────────────────────
  const [testOrderBusy, setTestOrderBusy] = useState(false);
  const [diagModal, setDiagModal]         = useState(false);
  const [diagLines, setDiagLines]         = useState<string[]>([]);

  // ── Funds management ───────────────────────────────────────────────────────
  // PERMISSION: igFundsRef holds freshly-fetched balance data across closures
  // (useRef avoids stale-closure issues with React state in callbacks).
  const igFundsRef = useRef<Partial<Record<'demo'|'live', { available: number; balance: number }>>>({});
  const [igFundsDisplay, setIgFundsDisplay] = useState<Partial<Record<'demo'|'live', { available: number; balance: number }>>>({});

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

  // ── Tab (positions / working orders / trade history) ──────────────────────
  const [posTab, setPosTab] = useState<'positions'|'orders'|'history'>('positions');

  // ── Trade history ──────────────────────────────────────────────────────────
  const [tradeHistory, setTradeHistory] = useState<IGTradeRecord[]>([]);

  // ── Builder ────────────────────────────────────────────────────────────────
  const [showBuilder, setShowBuilder]       = useState(false);
  const [editId, setEditId]                 = useState<string|null>(null);
  const [bName, setBName]                   = useState('');
  const [bTimeframe, setBTimeframe]         = useState<Timeframe>('daily');
  const [bSize, setBSize]                   = useState(1);
  const [bMaxPos, setBMaxPos]               = useState(3);
  const [bMinStrength, setBMinStrength]     = useState(55);
  const [bAccounts, setBAccounts]           = useState<('demo'|'live')[]>(['demo']);
  const [bAccountId, setBAccountId]         = useState<string>('');
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

  // ── API call counter (igQueue telemetry) ────────────────────────────────────
  const [apiCallCount, setApiCallCount]     = useState(0);
  const [rateLimitPause, setRateLimitPause] = useState(0);

  // ── Toast ──────────────────────────────────────────────────────────────────
  const [toast, setToast] = useState<{ok:boolean;msg:string}|null>(null);
  function showToast(ok:boolean, msg:string) { setToast({ok,msg}); setTimeout(() => setToast(null), 4000); }
  function log(type: RunLog['type'], msg: string) {
    setRunLog(p => [{ id:uid(), ts:new Date().toISOString(), type, msg }, ...p].slice(0,200));
  }

  /** "[CFD | Z6AFSH]" or "[SPREADBET | Z6AFSI]" for activity log prefixes. */
  function acctTypeLabel(env: 'demo'|'live'): string {
    const id = sessionsRef.current[env]?.accountId;
    if (!id) return '';
    return ` [${accountLabel(id)}]`;
  }

  /** Atomically write a fresh session to ref + React state + localStorage. */
  function storeSession(env: 'demo'|'live', sess: IGSession) {
    sessionsRef.current  = { ...sessionsRef.current, [env]: sess };
    setSessions(s        => ({ ...s, [env]: sess }));
    localStorage.setItem(`ig_session_${env}`, JSON.stringify({ ...sess, authenticatedAt: Date.now() }));
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
    setTradeHistory(loadIGTradeHistory());
    liveTradeAckedRef.current = localStorage.getItem('ig_live_first_trade_ack') === '1';
    const savedMode = localStorage.getItem('ig_active_mode') as 'demo'|'live'|null;

    // Load sub-accounts and selected defaults from localStorage
    (['demo','live'] as const).forEach(env => {
      const accsKey    = `ig_${env}_accounts`;
      const defaultKey = `ig_${env}_default_account`;
      try {
        const rawAccs = localStorage.getItem(accsKey);
        if (rawAccs) {
          const accs = JSON.parse(rawAccs) as IGSubAccount[];
          setSubAccounts(s => ({ ...s, [env]: accs }));
        }
      } catch {}
      const defaultId = localStorage.getItem(defaultKey);
      if (defaultId) setSelectedSubAccount(s => ({ ...s, [env]: defaultId }));
    });

    (['demo','live'] as const).forEach(env => {
      setConnecting(c => ({...c,[env]:true}));
      connectIG(env).then(sess => {
        if (sess) {
          storeSession(env, sess);
          // Only restore saved live mode once we confirm a live session actually exists
          if (env === 'live' && savedMode === 'live') setActiveModeState('live');
        }
        setConnecting(c => ({...c,[env]:false}));
      });
    });
    // Always restore demo mode immediately (no credential check needed)
    if (savedMode === 'demo') setActiveModeState('demo');
  }, []);

  // ── igQueue telemetry — update API call counter every second ──────────────
  useEffect(() => {
    const unsub = igQueue.subscribe?.(() => {
      setApiCallCount(igQueue.recentCalls ?? 0);
      setRateLimitPause(igQueue.pauseRemaining ?? 0);
    });
    // Also tick every second so the pause countdown stays live
    const ticker = setInterval(() => {
      setApiCallCount(igQueue.recentCalls ?? 0);
      setRateLimitPause(igQueue.pauseRemaining ?? 0);
    }, 1_000);
    return () => { unsub?.(); clearInterval(ticker); };
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

  // ── Helper: switch session to a specific sub-account ─────────────────────
  async function switchSessionTo(
    env: 'demo'|'live',
    currentSess: IGSession,
    accountId: string,
  ): Promise<IGSession> {
    const credKey = env === 'demo' ? 'ig_demo_credentials' : 'ig_live_credentials';
    const rawCred = localStorage.getItem(credKey);
    const apiKey  = rawCred ? (JSON.parse(rawCred) as { apiKey?: string }).apiKey ?? currentSess.apiKey : currentSess.apiKey;

    // Look up account type from stored sub-accounts list
    const acctType = (subAccounts[env] ?? []).find(a => a.accountId === accountId)?.accountType;

    async function doSwitch(sess: IGSession): Promise<{ ok: boolean; sess: IGSession; error?: string }> {
      try {
        const swRes = await igQueue.enqueue(() => fetch('/api/ig/switch-account', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cst: sess.cst, securityToken: sess.securityToken, apiKey, env, accountId }),
        }));
        const swData = await swRes.json() as { ok: boolean; cst?: string; securityToken?: string; accountId?: string; error?: string };
        if (swData.ok && swData.cst && swData.securityToken) {
          const switched: IGSession = {
            cst: swData.cst,
            securityToken: swData.securityToken,
            accountId: swData.accountId ?? accountId,
            apiKey: sess.apiKey,
            accountType: acctType,
          };
          storeSession(env, switched);
          return { ok: true, sess: switched };
        }
        return { ok: false, sess, error: swData.error ?? `Switch returned ok:false (HTTP ${swRes.status})` };
      } catch (e) {
        return { ok: false, sess, error: e instanceof Error ? e.message : String(e) };
      }
    }

    // First attempt
    const first = await doSwitch(currentSess);
    if (first.ok) return first.sess;

    // 403 = rate limited — re-authing won't help and will make the quota worse.
    // Just log and return; the caller will get the current (wrong) accountId and bail.
    if (first.error?.includes('403') || first.error?.includes('exceeded-api-key-allowance')) {
      log('error', `[${env.toUpperCase()}] ⛔ Rate limited (403) switching to ${accountId} — aborting, not retrying`);
      return currentSess;
    }

    // Re-auth cooldown: never re-auth more than once per 30 seconds
    const lastReauth = lastReauthRef.current[env] ?? 0;
    if (Date.now() - lastReauth < 30_000) {
      log('error', `[${env.toUpperCase()}] Switch to ${accountId} failed (${first.error ?? 'unknown'}) — re-auth cooldown active, skipping retry`);
      return currentSess;
    }

    // Switch failed — log actual error then re-authenticate before retrying once
    log('error', `[${env.toUpperCase()}] ⚠️ Switch to ${accountId} failed: ${first.error ?? 'unknown'} — re-authenticating…`);
    try {
      lastReauthRef.current[env] = Date.now();
      localStorage.removeItem(`ig_session_${env}`);
      const reauthed = await connectIG(env, true);
      if (!reauthed) {
        log('error', `[${env.toUpperCase()}] Re-auth failed — cannot switch to ${accountId}`);
        return currentSess;
      }
      storeSession(env, reauthed);

      const retry = await doSwitch(reauthed);
      if (retry.ok) {
        log('info', `[${env.toUpperCase()}] ✅ Switched to ${accountId} (${acctType ?? 'unknown type'}) after re-auth`);
        return retry.sess;
      }
      log('error', `[${env.toUpperCase()}] ❌ Still failed to switch to ${accountId} after re-auth: ${retry.error ?? 'unknown'}`);
      // Return the freshly re-authed session even if switch failed — caller checks accountId
      return reauthed;
    } catch (e) {
      log('error', `[${env.toUpperCase()}] Re-auth exception: ${e instanceof Error ? e.message : String(e)}`);
      return currentSess;
    }
  }

  // ── Load positions — iterates ALL sub-accounts so both SB and CFD show ───
  const loadPositions = useCallback(async (envFilter?: 'demo'|'live') => {
    const envs: ('demo'|'live')[] = envFilter ? [envFilter] : ['demo','live'];
    setLoadingPos(true);
    setPosError(null);
    for (const env of envs) {
      let sess = sessions[env];
      if (!sess) continue;
      const accs = subAccounts[env] ?? [];

      // Fetch positions from the currently active sub-account only.
      // Iterating all sub-accounts (switching between them) caused rate-limit 403s
      // because each switch + fetch costs 2 IG API calls, multiplied by every timer tick.
      // Positions are tagged with the current session's accountId/accountType so
      // closePos() knows which account to switch to when closing.
      try {
        const sessCurrent = sess;
        let r = await igQueue.enqueue(() => fetch('/api/ig/positions', { headers: makeHeaders(sessCurrent, env) }));
        // 403 = rate limited — igQueue already pauses 60s; just skip display
        if (r.status === 403) {
          setPosError(`[${env.toUpperCase()}] Rate limited by IG — will retry next cycle`);
          continue;
        }
        // 401 = genuine auth expiry → silently re-auth once and retry.
        // If cooldown is active, skip this cycle without showing an error.
        if (r.status === 401) {
          const lastReauth = lastReauthRef.current[env] ?? 0;
          if (Date.now() - lastReauth < 30_000) {
            continue;
          }
          lastReauthRef.current[env] = Date.now();
          localStorage.removeItem(`ig_session_${env}`);
          const fresh = await connectIG(env, true);
          if (!fresh) {
            setPosError(`[${env.toUpperCase()}] Session expired — reconnect in Settings → Accounts`);
            continue;
          }
          storeSession(env, fresh);
          sess = fresh;
          r = await igQueue.enqueue(() => fetch('/api/ig/positions', { headers: makeHeaders(sess!, env) }));
        }
        const d = await r.json() as { ok:boolean; positions?: IGPosition[]; error?:string; detail?:string };
        if (d.ok) {
          const acctType = sess.accountType ?? accs.find(a => a.accountId === sess!.accountId)?.accountType;
          setPositions(p => ({...p, [env]: (d.positions ?? []).map(pos => ({
            ...pos,
            subAccountId:   sess!.accountId,
            subAccountType: acctType,
          }))}));
        } else {
          const msg = `[${env.toUpperCase()}] Positions error: ${d.error ?? 'unknown'}${d.detail ? ` — ${d.detail}` : ''}`;
          setPosError(msg);
        }
      } catch (e) {
        setPosError(`[${env.toUpperCase()}] Failed to fetch positions: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setLoadingPos(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, subAccounts, selectedSubAccount]);

  useEffect(() => {
    if (Object.values(sessions).some(Boolean)) {
      void loadPositions();
      void loadWorkingOrders();
      // Auto-refresh positions every 60 seconds (30s was too frequent — caused rate-limit 403s)
      if (posRefreshRef.current) clearInterval(posRefreshRef.current);
      posRefreshRef.current = setInterval(() => { void loadPositions(); }, 60_000);
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
        const r = await igQueue.enqueue(() => fetch('/api/ig/workingorders', { headers: makeHeaders(sess, env) }));
        const d = await r.json() as { ok:boolean; workingOrders?: IGWorkingOrder[] };
        if (d.ok) setWorkingOrders(p => ({...p, [env]: d.workingOrders ?? []}));
      } catch {}
    }
  }, [sessions]);

  // ── Update stop/limit levels on open position ──────────────────────────────
  async function updatePositionSL(env: 'demo'|'live', pos: IGPosition, stopLevel: number|null, limitLevel: number|null) {
    const sess = sessions[env];
    if (!sess) return { ok: false, error: `No ${env} session` };
    const r = await igQueue.enqueue(() => fetch('/api/ig/order', {
      method: 'PATCH',
      headers: { ...makeHeaders(sess, env), 'Content-Type': 'application/json' },
      body: JSON.stringify({ dealId: pos.dealId, stopLevel, limitLevel }),
    }));
    return r.json() as Promise<{ok:boolean;error?:string}>;
  }

  // ── Cancel working order ───────────────────────────────────────────────────
  async function cancelWorkingOrder(env: 'demo'|'live', dealId: string) {
    setCancellingOrder(dealId);
    const sess = sessions[env];
    if (!sess) { setCancellingOrder(null); return; }
    try {
      const r = await igQueue.enqueue(() => fetch('/api/ig/workingorders', {
        method: 'DELETE',
        headers: { ...makeHeaders(sess, env), 'Content-Type': 'application/json' },
        body: JSON.stringify({ dealId }),
      }));
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
    // Check stored timestamp — proactively expire before IG's 6h window closes
    try {
      const raw = localStorage.getItem(`ig_session_${env}`);
      if (raw) {
        const meta = JSON.parse(raw) as { authenticatedAt?: number };
        if (meta.authenticatedAt && (Date.now() - meta.authenticatedAt) >= SESSION_TTL_MS) {
          localStorage.removeItem(`ig_session_${env}`);
          const fresh = await connectIG(env, true);
          if (fresh) storeSession(env, fresh);
          return fresh;
        }
      }
    } catch {}
    // Read from ref (not React state) — always holds the latest tokens even inside
    // stale setInterval closures where `sessions` state would lag behind.
    return sessionsRef.current[env] ?? null;
  }

  type OrderResult = { ok: boolean; dealReference?: string; dealId?: string; dealStatus?: string; level?: number; reason?: string; error?: string; epic?: string; resolvedVia?: string; sentPayload?: unknown; igBody?: unknown; igStatus?: number; freshCst?: string; freshSecurityToken?: string };

  async function placeOrder(
    env: 'demo'|'live', epic: string, direction: 'BUY'|'SELL', size: number,
    stopDist?: number, limitDist?: number, targetAccountId?: string,
  ): Promise<OrderResult> {

    // ── Serialize: IG rejects concurrent requests on the same session ─────────
    // Spin-wait max 15 s (150 × 100 ms) for any in-flight trade to finish.
    for (let i = 0; i < 150 && tradeLockRef.current; i++) await sleep(100);
    tradeLockRef.current = true;

    try {
      return await _placeOrderInner(env, epic, direction, size, stopDist, limitDist, targetAccountId);
    } finally {
      // 500 ms cooldown after every order so IG's rate limiter doesn't trip
      await sleep(500);
      tradeLockRef.current = false;
    }
  }

  async function _placeOrderInner(
    env: 'demo'|'live', epic: string, direction: 'BUY'|'SELL', size: number,
    stopDist?: number, limitDist?: number, targetAccountId?: string,
  ): Promise<OrderResult> {

    // ── 1. Get a fresh session ────────────────────────────────────────────────
    let sess = await freshSession(env);
    if (!sess) return { ok: false, error: `No ${env} session`, epic };

    // ── 2. ALWAYS switch to targetAccountId before every order ───────────────
    // IG may reset the active sub-account between API calls — never trust
    // `sess.accountId` to still be the right one.
    if (targetAccountId) {
      sess = await switchSessionTo(env, sess, targetAccountId);
      if (sess.accountId !== targetAccountId) {
        return { ok: false, error: `Failed to switch to account ${targetAccountId}`, epic };
      }
    }

    // ── 3. Place order ────────────────────────────────────────────────────────
    // currencyCode is omitted here — order/route.ts adds it only for SB epics.
    const orderBody = { epic, direction, size, stopDistance: stopDist, profitDistance: limitDist };
    // Use non-null assertion: sess is guaranteed non-null here (checked on line 868 + any switch)
    let activeSess: IGSession = sess;
    let r = await igQueue.enqueue(() => fetch('/api/ig/order', {
      method: 'POST',
      headers: { ...makeHeaders(activeSess, env), 'Content-Type': 'application/json' },
      body: JSON.stringify(orderBody),
    }));

    // ── 4. Error detection ────────────────────────────────────────────────────
    // 401 / account-token-invalid → genuine auth expiry → re-auth + retry
    // 403 → rate limit (exceeded-api-key-allowance)  → ABORT, do NOT re-auth
    const isAuthErr = (status: number, body?: string) =>
      status === 401 ||
      (body?.includes('account-token-invalid') ?? false) ||
      (body?.includes('INVALID_TOKEN') ?? false);

    const rawText = await r.text();

    // Rate-limit: don't re-auth (it burns more quota), just surface the error
    if (r.status === 403 || rawText.includes('exceeded-api-key-allowance')) {
      return { ok: false, error: `IG rate limit (403) — wait before retrying`, epic };
    }

    if (isAuthErr(r.status, rawText)) {
      // Re-auth cooldown — never re-auth more than once per 30s
      const lastReauth = lastReauthRef.current[env] ?? 0;
      if (Date.now() - lastReauth < 30_000) {
        return { ok: false, error: `Auth error but re-auth cooldown active — aborting`, epic };
      }
      lastReauthRef.current[env] = Date.now();
      // Re-authenticate from scratch
      localStorage.removeItem(`ig_session_${env}`);
      const fresh = await connectIG(env, true);
      if (!fresh) return { ok: false, error: `Re-auth failed after token expiry`, epic };
      storeSession(env, fresh);
      sess = fresh;

      // Re-switch to the target sub-account after re-auth (login lands on SPREADBET)
      if (targetAccountId) {
        sess = await switchSessionTo(env, sess, targetAccountId);
        if (sess.accountId !== targetAccountId) {
          return { ok: false, error: `Re-auth succeeded but re-switch to ${targetAccountId} failed`, epic };
        }
      }

      // Retry the order once with fresh tokens
      activeSess = sess;
      r = await igQueue.enqueue(() => fetch('/api/ig/order', {
        method: 'POST',
        headers: { ...makeHeaders(activeSess, env), 'Content-Type': 'application/json' },
        body: JSON.stringify(orderBody),
      }));
      const retryText = await r.text();
      let retryResult: OrderResult;
      try { retryResult = JSON.parse(retryText) as OrderResult; } catch { return { ok: false, error: retryText.slice(0, 200), epic }; }
      if (retryResult.ok && retryResult.freshCst && retryResult.freshSecurityToken) {
        storeSession(env, { ...sess, cst: retryResult.freshCst, securityToken: retryResult.freshSecurityToken });
      }
      return retryResult;
    }

    let result: OrderResult;
    try { result = JSON.parse(rawText) as OrderResult; } catch { return { ok: false, error: rawText.slice(0, 200), epic }; }

    // Capture token rotation — IG issues fresh CST/X-SECURITY-TOKEN after every call.
    // Storing them now prevents "account-token-invalid" on the next switch/order.
    if (result.ok && result.freshCst && result.freshSecurityToken) {
      storeSession(env, { ...sess, cst: result.freshCst, securityToken: result.freshSecurityToken });
    }

    return result;
  }

  async function closePos(env: 'demo'|'live', pos: IGPosition) {
    // Read from ref — avoids stale closure issue in setInterval callbacks
    let sess = sessionsRef.current[env];
    if (!sess) return { ok: false, error: `No ${env} session` };

    // Switch to the sub-account that owns this position before closing
    if (pos.subAccountId && pos.subAccountId !== sess.accountId) {
      sess = await switchSessionTo(env, sess, pos.subAccountId);
    }

    const closeBody = { dealId: pos.dealId, direction: pos.direction === 'BUY' ? 'SELL' : 'BUY', size: pos.size };

    const doClose = (s: IGSession) => igQueue.enqueue(() => fetch('/api/ig/order', {
      method: 'DELETE',
      headers: { ...makeHeaders(s, env), 'Content-Type': 'application/json' },
      body: JSON.stringify(closeBody),
    }));

    let r = await doClose(sess);

    // 403 = rate limit — do NOT re-auth (burns more quota), just return error
    if (r.status === 403) {
      return { ok: false, error: `IG rate limit (403) — wait before closing` };
    }
    // 401 = genuine auth expiry → re-auth once (respecting cooldown)
    if (r.status === 401) {
      const lastReauth = lastReauthRef.current[env] ?? 0;
      if (Date.now() - lastReauth >= 30_000) {
        lastReauthRef.current[env] = Date.now();
        localStorage.removeItem(`ig_session_${env}`);
        const fresh = await connectIG(env, true);
        if (fresh) {
          storeSession(env, fresh);
          sess = fresh;
          if (pos.subAccountId && pos.subAccountId !== sess.accountId) {
            sess = await switchSessionTo(env, sess, pos.subAccountId);
          }
          r = await doClose(sess);
        }
      }
    }

    return r.json() as Promise<{ ok: boolean; error?: string }>;
  }

  // ── Fetch IG account funds ─────────────────────────────────────────────────
  // PERMISSION: Fetches available funds before each scan cycle so the strategy
  // can size positions dynamically and skip markets when funds are low.
  async function fetchIGFunds(env: 'demo'|'live'): Promise<{ available: number; balance: number } | null> {
    const sess = sessions[env];
    if (!sess) return null;
    try {
      const r = await igQueue.enqueue(() => fetch('/api/ig/account', { headers: makeHeaders(sess, env) }));
      const d = await r.json() as { ok: boolean; available?: number; balance?: number };
      if (d.ok) {
        const funds = { available: d.available ?? 0, balance: d.balance ?? 0 };
        igFundsRef.current = { ...igFundsRef.current, [env]: funds };
        setIgFundsDisplay(prev => ({ ...prev, [env]: funds }));
        return funds;
      }
    } catch {}
    return null;
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

    // ── Calibrated signal scoring by market type + account type ──────────────
    const mType = market.marketType ?? getMarketType(market.epic);
    // Determine account type from strategy's target account ID
    const acctType: AccountType = strat.accountId ? accountTypeOf(strat.accountId) : 'SPREADBET';
    const { stopDist, limitDist } = getStopDistances(mType, acctType);
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
    // Use the higher of: strategy's configured minStrength vs account-type floor.
    // CFD floor = 75%, SPREADBET floor = 65%
    const effectiveMinStrength = Math.max(strat.minStrength, MIN_STRENGTH[acctType]);
    const forceOpen = market.forceOpen === true;
    const tradeDir: 'BUY' | 'SELL' | null =
      forceOpen
        ? (direction !== 'HOLD' ? direction : snapshot.changePercent >= 0 ? 'BUY' : 'SELL')
        : direction !== 'HOLD' && strength >= effectiveMinStrength ? direction
        : null;

    if (!strat.autoTrade || !tradeDir) {
      if (direction !== 'HOLD' && !forceOpen)
        log('signal', `${market.name} (${market.epic}) → ${direction} ${strength}% ${forceOpen ? '' : `(need ${effectiveMinStrength}% [${acctType}] — no trade)`}`);
    } else {
      for (const env of envs) {
        const envPos = positions[env];
        const opposite = tradeDir === 'BUY' ? 'SELL' : 'BUY';

        // Auto-close opposing positions — wait for each to settle before continuing
        if (strat.autoClose) {
          for (const opp of envPos.filter(p => p.epic === market.epic && p.direction === opposite)) {
            log('close', `[${env.toUpperCase()}] Auto-closing ${opp.direction} ${market.name} — signal reversed`);
            const cr = await closePos(env, opp);
            if (cr.ok) {
              log('close', `[${env.toUpperCase()}] ✅ Closed ${market.name}`);
              const exitPx = opp.direction === 'BUY' ? (opp.bid ?? opp.level) : (opp.offer ?? opp.level);
              setTradeHistory(prev => recordTradeClose(prev, opp.dealId, exitPx, opp.upl ?? 0, 'STRATEGY', new Date().toISOString()));
              // Give IG time to settle the close before we open a new position on the same account
              await sleep(1000);
            } else log('error', `[${env.toUpperCase()}] Close failed: ${cr.error ?? 'unknown'}`);
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

        // PERMISSION: Dynamic position sizing — cap size to 5% of available funds.
        // Fetch latest funds from ref (populated at scan-cycle start).
        const fundsNow = igFundsRef.current[env];
        const available = fundsNow?.available ?? Infinity;
        const orderSize = calcDynamicSize(strat.size, available);

        if (orderSize === 0) {
          log('error', `[${env.toUpperCase()}] ⚠️ Insufficient funds (£${available.toFixed(2)} available) — pausing trades. Top up at ig.com.`);
          showToast(false, `⚠️ Low funds in IG ${env} — skipping`);
          continue;
        }

        // PERMISSION: Intelligent order management — if funds are tight (< £500),
        // close the worst-losing open position (open > 24h) to free capital.
        if (available < 500 && positions[env].length > 0) {
          const now = Date.now();
          const oldLosers = positions[env]
            .filter(p => p.upl < 0 && p.createdDate && (now - new Date(p.createdDate).getTime()) > 24 * 3_600_000)
            .sort((a, b) => a.upl - b.upl); // most negative first
          if (oldLosers.length > 0) {
            const worst = oldLosers[0];
            log('close', `[${env.toUpperCase()}] 💡 Freeing capital: closing worst loser ${worst.instrumentName ?? worst.epic} (P&L £${worst.upl.toFixed(2)}, open >24h)`);
            const cr = await closePos(env, worst);
            if (cr.ok) {
              log('close', `[${env.toUpperCase()}] ✅ Freed capital by closing ${worst.instrumentName ?? worst.epic}`);
              const exitPx = worst.direction === 'BUY' ? (worst.bid ?? worst.level) : (worst.offer ?? worst.level);
              setTradeHistory(prev => recordTradeClose(prev, worst.dealId, exitPx, worst.upl ?? 0, 'STRATEGY', new Date().toISOString()));
              await loadPositions(env);
              // Refresh funds after close
              await fetchIGFunds(env);
            }
          }
        }

        // Resolve correct epic for this account type from central table
        const resolvedEpic = epicForAccount(market.name, acctType) ?? market.epic;
        if (resolvedEpic !== market.epic) {
          log('info', `  ↳ Epic resolved: ${market.epic} → ${resolvedEpic} for [${acctType}]`);
        }

        const maxLoss = orderSize * stopDist;
        const acctTag = strat.accountId ? ` [${accountLabel(strat.accountId)}]` : acctTypeLabel(env);
        log(tradeDir === 'BUY' ? 'buy' : 'sell',
          `[${env.toUpperCase()}]${acctTag} → ${tradeDir} ${market.name} | epic: ${resolvedEpic} | ${acctType === 'CFD' ? `${orderSize} unit(s)` : `£${orderSize}/pt`} | SL ${stopDist}pt TP ${limitDist}pt | max loss £${maxLoss.toFixed(2)} | signal ${strength}%${forceOpen ? ' (FORCE)' : ''}`);

        const or = await placeOrder(env, resolvedEpic, tradeDir, orderSize, stopDist, limitDist, strat.accountId);

        if (or.ok) {
          log(tradeDir === 'BUY' ? 'buy' : 'sell',
            `[${env.toUpperCase()}]${acctTag} ✅ ${or.dealStatus ?? 'ACCEPTED'} — ref ${or.dealReference ?? 'n/a'} · dealId ${or.dealId ?? 'pending'} · filled @ ${or.level ?? '?'} · epic: ${or.epic ?? resolvedEpic}`);
          showToast(true, `[${env}] ${tradeDir} ${market.name}`);
          // Record open trade in history
          setTradeHistory(prev => recordTradeOpen(prev, {
            portfolioName: strat.name, market: market.name, epic: resolvedEpic,
            direction: tradeDir, size: orderSize, entryLevel: or.level ?? 0,
            exitLevel: null, openedAt: new Date().toISOString(), closedAt: null,
            status: 'OPEN', dealReference: or.dealReference ?? '', dealId: or.dealId ?? '',
            pnl: null, closeReason: null, accountType: env,
          }));
          // Small delay then refresh so IG has time to register the position
          await sleep(1500);
          await loadPositions(env);
          await loadWorkingOrders(env);
        } else {
          // ── Special-case: insufficient funds ──────────────────────────────
          const errStr = (or.error ?? '').toLowerCase();
          if (errStr.includes('insufficient_funds') || errStr.includes('insufficient funds') || errStr.includes('insufficient fund')) {
            log('error', `[${env.toUpperCase()}] ⚠️ IG ${env === 'demo' ? 'Demo' : 'Live'} has insufficient funds. Go to ig.com → ${env === 'demo' ? 'Demo account →' : ''} My Account → Add virtual funds`);
            showToast(false, `⚠️ Insufficient funds in IG ${env} — skipping`);
            continue; // skip this market, continue scanning others
          }
          // ── Epic mismatch — show actionable explanation ────────────────────
          if ((or.reason ?? '').toUpperCase() === 'UNKNOWN' || errStr.includes('instrument_not_found') || errStr.includes('epic')) {
            const sbEpic = market.epic;
            const cfdEpic = toCfdEpic(sbEpic);
            const sbFromCfd = toSpreadbetEpic(sbEpic);
            const hint = cfdEpic
              ? `Epic mismatch: "${sbEpic}" is a SPREADBET epic — for CFD use "${cfdEpic}"`
              : sbFromCfd
              ? `Epic mismatch: "${sbEpic}" is a CFD epic — for SPREADBET use "${sbFromCfd}"`
              : `Epic "${sbEpic}" was rejected — check it exists on your ${acctType} account`;
            log('error', `[${env.toUpperCase()}]${acctTag} ⚠️ ${hint}`);
          }
          log('error', `[${env.toUpperCase()}]${acctTag} ❌ ${market.name} FAILED — ${or.error ?? 'unknown'}`);
          log('error', `  epic: ${or.epic ?? resolvedEpic}${or.reason ? ` | reason: ${or.reason}` : ''}`);
          if (or.sentPayload) log('error', `  sent: ${JSON.stringify(or.sentPayload)}`);
          if (or.igBody)      log('error', `  ig:   ${JSON.stringify(or.igBody)}`);
          // Record rejected trade
          setTradeHistory(prev => recordTradeOpen(prev, {
            portfolioName: strat.name, market: market.name, epic: market.epic,
            direction: tradeDir, size: orderSize, entryLevel: 0,
            exitLevel: null, openedAt: new Date().toISOString(), closedAt: new Date().toISOString(),
            status: 'REJECTED', dealReference: '', dealId: '',
            pnl: null, closeReason: null, accountType: env,
          }));
        }
      }
    }

    return sig;
  }

  // ── Signal scan: scan markets + execute trades ────────────────────────────
  const runSignalScan = useCallback(async (strat: IGSavedStrategy) => {
    if (!runningRef.current) return;
    const markets = (strat.watchlist?.length ? strat.watchlist : DEFAULT_WATCHLIST).filter(m => m.enabled);

    // PERMISSION: Fetch account balances at the start of each scan cycle so
    // calcDynamicSize() has up-to-date fund data when sizing positions.
    const envs = strat.accounts.filter(e => sessions[e]) as ('demo'|'live')[];
    for (const env of envs) {
      const funds = await fetchIGFunds(env);
      if (funds) log('info', `[${env.toUpperCase()}] 💰 Available: £${funds.available.toFixed(2)} | Balance: £${funds.balance.toFixed(2)}`);
    }

    log('info', `📡 Signal scan — ${markets.length} markets…`);

    for (let i = 0; i < markets.length; i++) {
      if (!runningRef.current) break;
      const m = markets[i];
      setScanProgress(`${m.name} (${i+1}/${markets.length})`);
      await scanMarket(strat, m);
      if (i < markets.length - 1) await sleep(1500); // 1.5s between markets — respects IG rate limits
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

  // ── Position monitor: trailing stops + SL/TP refresh + stale recycling ────
  const runPositionMonitor = useCallback(async (strat: IGSavedStrategy) => {
    if (!runningRef.current) return;
    await loadPositions();
    const envs = strat.accounts.filter(e => sessions[e]) as ('demo'|'live')[];
    for (const env of envs) {
      for (const pos of positions[env]) {
        if (!pos.level || !pos.bid || !pos.offer) continue;
        const currentPx = pos.direction === 'BUY' ? pos.bid : pos.offer;
        const entryPx   = pos.level;
        const pnlPct    = pos.direction === 'BUY'
          ? ((currentPx - entryPx) / entryPx) * 100
          : ((entryPx - currentPx) / entryPx) * 100;

        // PERMISSION: Stale position recycling — close positions open > 48h
        // that have not moved more than ±0.5%. Frees capital for better signals.
        if (pos.createdDate && strat.autoClose) {
          const ageMs = Date.now() - new Date(pos.createdDate).getTime();
          if (ageMs > 48 * 3_600_000 && Math.abs(pnlPct) < 0.5) {
            log('close', `[${env.toUpperCase()}] ♻️ Recycling stale position: ${pos.instrumentName ?? pos.epic} (${ageMs > 86_400_000 ? Math.floor(ageMs / 86_400_000) + 'd' : Math.floor(ageMs / 3_600_000) + 'h'} open, ${pnlPct.toFixed(2)}% P&L)`);
            const cr = await closePos(env, pos);
            if (cr.ok) {
              log('close', `[${env.toUpperCase()}] ✅ Stale position recycled — capital freed`);
              const exitPx = pos.direction === 'BUY' ? (pos.bid ?? currentPx) : (pos.offer ?? currentPx);
              setTradeHistory(prev => recordTradeClose(prev, pos.dealId, exitPx, pos.upl ?? 0, 'STALE', new Date().toISOString()));
            } else log('error', `[${env.toUpperCase()}] Recycle close failed: ${cr.error ?? 'unknown'}`);
            continue;
          }
        }

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

  // ── Test Order: 5-step full diagnostic ────────────────────────────────────
  async function runTestOrder() {
    if (testOrderBusy) return;
    setTestOrderBusy(true);
    const lines: string[] = [];
    function diag(line: string) {
      lines.push(line);
      setDiagLines([...lines]);
      log('info', line);
    }
    setDiagLines([]);
    setDiagModal(true);

    diag('══════════════════════════════════════════');
    diag('🧪 IG DIAGNOSTIC — ' + new Date().toLocaleTimeString('en-GB'));
    diag('══════════════════════════════════════════');

    // ── STEP 1: Read stored credentials ──────────────────────────────────
    diag('');
    diag('STEP 1 — Read stored credentials');
    let creds: { username: string; password: string; apiKey: string } | null = null;
    try {
      const raw = typeof window !== 'undefined' ? localStorage.getItem('ig_demo_credentials') : null;
      if (!raw) {
        diag('  ✗ No credentials found in localStorage (key: ig_demo_credentials)');
        diag('    → Go to Settings → Accounts → IG Demo and connect first');
        setTestOrderBusy(false);
        return;
      }
      creds = JSON.parse(raw) as { username: string; password: string; apiKey: string };
      diag(`  ✓ Found: username="${creds.username}", apiKey="${creds.apiKey.slice(0, 8)}…"`);
    } catch (e) {
      diag(`  ✗ Failed to read credentials: ${e instanceof Error ? e.message : String(e)}`);
      setTestOrderBusy(false);
      return;
    }

    // ── STEP 2: Fresh login ───────────────────────────────────────────────
    diag('');
    diag('STEP 2 — Fresh login');
    diag(`  → POST https://demo-api.ig.com/gateway/deal/session`);
    diag(`     identifier: "${creds.username}", apiKey: "${creds.apiKey.slice(0, 8)}…"`);
    let cst = '';
    let secToken = '';
    try {
      const loginRes = await igQueue.enqueue(() => fetch('/api/ig/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: creds.username, password: creds.password, apiKey: creds.apiKey, env: 'demo', forceRefresh: true }),
      }));
      const loginData = await loginRes.json() as { ok: boolean; cst?: string; securityToken?: string; accountId?: string; spreadbetAccountId?: string; accounts?: { accountId: string; accountName: string; accountType: string }[]; error?: string };
      diag(`  ← HTTP ${loginRes.status}`);
      if (!loginData.ok || !loginData.cst) {
        diag(`  ✗ Login FAILED: ${loginData.error ?? 'unknown error'}`);
        setTestOrderBusy(false);
        return;
      }
      cst      = loginData.cst;
      secToken = loginData.securityToken ?? '';
      diag(`  ✓ CST: "${cst.slice(0, 10)}…"`);
      diag(`  ✓ X-SECURITY-TOKEN: "${secToken.slice(0, 10)}…"`);
      diag(`  ✓ accountId: ${loginData.accountId ?? 'n/a'}`);
      if (loginData.spreadbetAccountId) diag(`  ✓ Switched to SPREADBET: ${loginData.spreadbetAccountId}`);
      if (loginData.accounts?.length) {
        diag(`  ✓ All accounts: ${loginData.accounts.map(a => `${a.accountId}(${a.accountType})`).join(', ')}`);
      }
    } catch (e) {
      diag(`  ✗ Login exception: ${e instanceof Error ? e.message : String(e)}`);
      setTestOrderBusy(false);
      return;
    }

    // ── STEP 3: Fetch accounts list ───────────────────────────────────────
    diag('');
    diag('STEP 3 — Fetch all accounts');
    diag(`  → GET https://demo-api.ig.com/gateway/deal/accounts`);
    type AccEntry = { accountId: string; accountName: string; accountType: string; preferred: boolean; balance: { balance: number; available: number } };
    let accountsList: AccEntry[] = [];
    try {
      const accRes = await fetch('/api/portfolio/ig', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: creds.apiKey, cst, securityToken: secToken, env: 'demo' }),
      });
      const accData = await accRes.json() as { ok: boolean; accounts?: AccEntry[]; positions?: unknown[]; summary?: { positionCount: number } };
      diag(`  ← HTTP ${accRes.status}`);
      if (accData.accounts?.length) {
        accountsList = accData.accounts;
        accData.accounts.forEach(a => {
          diag(`  · ${a.accountId} | ${a.accountType.padEnd(12)} | ${a.accountName} | balance: £${a.balance?.balance?.toFixed(2) ?? 'n/a'} | avail: £${a.balance?.available?.toFixed(2) ?? 'n/a'}${a.preferred ? ' ★ preferred' : ''}`);
        });
      } else {
        diag('  (no accounts returned)');
      }
      if (accData.summary) {
        diag(`  → Total positions across all accounts: ${accData.summary.positionCount}`);
      }
    } catch (e) {
      diag(`  ✗ Accounts fetch exception: ${e instanceof Error ? e.message : String(e)}`);
    }

    // ── STEP 4: Positions on current account (no switching) ───────────────
    diag('');
    diag('STEP 4 — Fetch positions (direct, no account switching)');
    diag(`  → GET https://demo-api.ig.com/gateway/deal/positions/otc`);
    let sess = sessions.demo;
    if (!sess) {
      // Build a fresh session object from the tokens we just got
      sess = { cst, securityToken: secToken, accountId: '', apiKey: creds.apiKey };
    }
    try {
      const posRes = await igQueue.enqueue(() => fetch('/api/ig/positions', {
        headers: {
          'x-ig-cst':            cst,
          'x-ig-security-token': secToken,
          'x-ig-api-key':        creds.apiKey,
          'x-ig-env':            'demo',
        },
      }));
      diag(`  ← HTTP ${posRes.status}`);
      const posData = await posRes.json() as { ok: boolean; positions?: { dealId: string; direction: string; instrumentName: string; size: number; level: number; upl: number }[]; error?: string };
      if (posData.ok) {
        diag(`  ✓ ${posData.positions?.length ?? 0} position(s) found`);
        (posData.positions ?? []).slice(0, 5).forEach(p => {
          diag(`  · ${p.dealId} | ${p.direction} ${p.size} | ${p.instrumentName} | entry ${p.level} | UPL ${p.upl >= 0 ? '+' : ''}${p.upl.toFixed(2)}`);
        });
        if ((posData.positions?.length ?? 0) > 5) diag(`  … and ${(posData.positions?.length ?? 0) - 5} more`);
      } else {
        diag(`  ✗ Error: ${posData.error ?? 'unknown'}`);
      }
    } catch (e) {
      diag(`  ✗ Positions fetch exception: ${e instanceof Error ? e.message : String(e)}`);
    }

    // ── STEP 5: Test order ────────────────────────────────────────────────
    diag('');
    diag('STEP 5 — Test order: BUY 1 unit S&P 500 (IX.D.SPTRD.DAILY.IP)');
    const epic   = 'IX.D.SPTRD.DAILY.IP';
    const orderBody = { epic, direction: 'BUY', size: 1, currencyCode: 'GBP' };
    diag(`  → POST /api/ig/order`);
    diag(`     body: ${JSON.stringify(orderBody)}`);
    try {
      const freshSess: IGSession = { cst, securityToken: secToken, accountId: accountsList[0]?.accountId ?? '', apiKey: creds.apiKey };
      setSessions(s => ({ ...s, demo: freshSess }));
      const orderRes = await igQueue.enqueue(() => fetch('/api/ig/order', {
        method: 'POST',
        headers: { ...makeHeaders(freshSess, 'demo'), 'Content-Type': 'application/json' },
        body: JSON.stringify(orderBody),
      }));
      const orderData = await orderRes.json() as { ok: boolean; dealReference?: string; dealId?: string; dealStatus?: string; level?: number; error?: string; reason?: string; sentPayload?: unknown; igBody?: unknown };
      diag(`  ← HTTP ${orderRes.status}`);
      if (orderData.ok) {
        diag(`  ✓ ACCEPTED`);
        diag(`    dealReference: ${orderData.dealReference ?? 'n/a'}`);
        diag(`    dealId:        ${orderData.dealId ?? 'pending'}`);
        diag(`    dealStatus:    ${orderData.dealStatus ?? 'UNKNOWN'}`);
        diag(`    filled @:      ${orderData.level ?? '?'}`);
        showToast(true, 'Test order placed — check Positions tab');
        await sleep(1500);
        await loadPositions('demo');
      } else {
        diag(`  ✗ REJECTED: ${orderData.error ?? 'unknown'}${orderData.reason ? ` (${orderData.reason})` : ''}`);
        if (orderData.sentPayload) diag(`    sent:   ${JSON.stringify(orderData.sentPayload)}`);
        if (orderData.igBody)      diag(`    ig resp: ${JSON.stringify(orderData.igBody)}`);
        showToast(false, orderData.error ?? 'Test order rejected');
      }
    } catch (e) {
      diag(`  ✗ Order exception: ${e instanceof Error ? e.message : String(e)}`);
      showToast(false, 'Test order exception');
    }

    diag('');
    diag('══════════════════════════════════════════');
    diag('🧪 Diagnostic complete');
    diag('══════════════════════════════════════════');
    setTestOrderBusy(false);
  }

  // ── Manual close ───────────────────────────────────────────────────────────
  async function handleClose(env:'demo'|'live', pos: IGPosition) {
    setClosingId(pos.dealId);
    const r = await closePos(env, pos);
    if (r.ok) {
      log('close', `[${env.toUpperCase()}] Closed ${pos.direction} ${pos.instrumentName ?? pos.epic}`);
      showToast(true, 'Position closed');
      const exitPx = pos.direction === 'BUY' ? (pos.bid ?? pos.level) : (pos.offer ?? pos.level);
      setTradeHistory(prev => recordTradeClose(prev, pos.dealId, exitPx, pos.upl ?? 0, 'MANUAL', new Date().toISOString()));
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
      setTradeHistory(prev => recordTradeOpen(prev, {
        portfolioName: 'Manual', market: manualName || manualEpic, epic: manualEpic,
        direction: manualDir, size: manualSize, entryLevel: r.level ?? 0,
        exitLevel: null, openedAt: new Date().toISOString(), closedAt: null,
        status: 'OPEN', dealReference: r.dealReference ?? '', dealId: r.dealId ?? '',
        pnl: null, closeReason: null, accountType: manualEnv,
      }));
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
      setBAccounts(existing.accounts); setBAccountId(existing.accountId ?? ''); setBAutoClose(existing.autoClose ?? true);
      setBWatchlist(existing.watchlist?.length ? existing.watchlist : [...DEFAULT_WATCHLIST]);
      setBSignalScanMs(existing.signalScanMs ?? 5 * 60_000);
      setBPosMonitorMs(existing.posMonitorMs ?? 60_000);
    } else {
      setEditId(null); setBName(''); setBTimeframe('daily'); setBSize(1); setBMaxPos(3);
      setBMinStrength(55);
      // Only default to live if we actually have a live session
      setBAccounts([sessions[activeMode] ? activeMode : 'demo']);
      // Default accountId to the selected sub-account for the active mode
      setBAccountId(selectedSubAccount[activeMode] ?? '');
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
      accountId: bAccountId || undefined,
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
          {/* Connection chips + funds + sub-account selector */}
          {(['demo','live'] as const).map(env => sessions[env] && (
            <div key={env} className="flex items-center gap-1 flex-wrap">
              <div className={clsx('flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full',
                env==='demo' ? 'bg-blue-500/15 text-blue-400' : 'bg-amber-500/15 text-amber-400'
              )}>
                <Wifi className="h-2.5 w-2.5" />
                #{sessions[env]!.accountId}
                {igFundsDisplay[env] && (
                  <span className="ml-1 opacity-80">£{igFundsDisplay[env]!.available.toFixed(0)} avail</span>
                )}
              </div>
              {/* Sub-account selector buttons */}
              {(subAccounts[env] ?? []).length > 1 && (subAccounts[env] ?? []).map(acct => {
                const isSelected = (selectedSubAccount[env] ?? sessions[env]!.accountId) === acct.accountId;
                const typeLabel  = acct.accountType === 'SPREADBET' ? 'SB' : acct.accountType === 'CFD' ? 'CFD' : acct.accountType;
                return (
                  <button key={acct.accountId}
                    title={`${acct.accountName} (${acct.accountId})`}
                    onClick={() => {
                      setSelectedSubAccount(s => ({ ...s, [env]: acct.accountId }));
                      localStorage.setItem(`ig_${env}_default_account`, acct.accountId);
                    }}
                    className={clsx('text-[10px] px-1.5 py-0.5 rounded font-semibold border transition-all',
                      isSelected
                        ? env === 'demo' ? 'bg-blue-500/30 text-blue-300 border-blue-500/40' : 'bg-amber-500/30 text-amber-300 border-amber-500/40'
                        : 'bg-gray-800 text-gray-500 border-gray-700 hover:text-gray-300'
                    )}>
                    {typeLabel}
                  </button>
                );
              })}
            </div>
          ))}
          <span className="text-[10px] text-gray-600 px-2 py-1 bg-gray-800/50 rounded-full">
            Signal: Yahoo Finance · Execution: IG
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => void loadPositions()} loading={loadingPos}>Refresh</Button>
          <Button size="sm" variant="outline" loading={testOrderBusy}
            title="Run full 5-step diagnostic: credentials → auth → accounts → positions → test order"
            onClick={() => void runTestOrder()}>
            🧪 Diagnose
          </Button>
          {diagLines.length > 0 && !diagModal && (
            <button onClick={() => setDiagModal(true)} className="text-[10px] text-blue-400 hover:underline">View last diagnostic</button>
          )}
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

            {/* Sub-account picker */}
            {bAccounts.map(env => (subAccounts[env] ?? []).length > 1 && (
              <div key={env}>
                <label className="text-xs text-gray-400 mb-1.5 block">
                  Sub-account for {env === 'demo' ? 'Demo' : 'Live'} trades
                </label>
                <div className="flex gap-2 flex-wrap">
                  {(subAccounts[env] ?? []).map(acct => {
                    const typeLabel = acct.accountType === 'SPREADBET' ? 'Spread Bet' : acct.accountType === 'CFD' ? 'CFD' : acct.accountType;
                    const taxLabel  = acct.accountType === 'SPREADBET' ? '(tax-free)' : acct.accountType === 'CFD' ? '(taxable)' : '';
                    return (
                      <button key={acct.accountId}
                        onClick={() => setBAccountId(acct.accountId)}
                        className={clsx('flex-1 min-w-[140px] px-3 py-2 rounded-lg border text-left transition-all',
                          bAccountId === acct.accountId
                            ? 'bg-orange-500/20 text-orange-300 border-orange-500/40'
                            : 'bg-gray-800 text-gray-400 border-gray-700 hover:text-gray-200'
                        )}>
                        <p className="text-xs font-semibold">{typeLabel} <span className="text-[10px] opacity-60">{taxLabel}</span></p>
                        <p className="text-[10px] font-mono opacity-60">{acct.accountId}</p>
                        {acct.balance && <p className="text-[10px] opacity-70">£{acct.balance.available.toFixed(0)} avail</p>}
                      </button>
                    );
                  })}
                  <button
                    onClick={() => setBAccountId('')}
                    className={clsx('px-3 py-2 rounded-lg border text-xs transition-all',
                      bAccountId === ''
                        ? 'bg-gray-600 text-gray-200 border-gray-500'
                        : 'bg-gray-800 text-gray-500 border-gray-700 hover:text-gray-300'
                    )}>
                    Auto
                  </button>
                </div>
              </div>
            ))}

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
              {/* Preset CFD watchlist button */}
              <div className="mt-2 flex gap-2 flex-wrap">
                <button
                  onClick={() => setBWatchlist(p => {
                    const existing = new Set(p.map(x => x.epic));
                    const toAdd = CFD_WATCHLIST.filter(m => !existing.has(m.epic));
                    return [...p, ...toAdd];
                  })}
                  className="text-[10px] px-2.5 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-gray-400 hover:text-white transition-colors">
                  + Add CFD stocks &amp; index epics
                </button>
                <button
                  onClick={() => setBWatchlist([...DEFAULT_WATCHLIST])}
                  className="text-[10px] px-2.5 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-gray-400 hover:text-white transition-colors">
                  Reset to spread-bet defaults
                </button>
              </div>
              {/* Add custom market */}
              {builderSession && (
                <div className="mt-2">
                  <p className="text-[10px] text-gray-500 mb-1.5">Search and add any market:</p>
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

      {/* ── Positions + Working Orders + Trade History ──────────────────── */}
      <Card>
        {/* Tab bar */}
        <div className="flex items-center gap-0.5 mb-4 bg-gray-800/50 rounded-lg p-1 w-fit flex-wrap">
          {([
            { id: 'positions' as const, label: 'Positions',      icon: <BarChart3 className="h-3 w-3" />, count: allPositions.length },
            { id: 'orders'   as const, label: 'Working Orders',  icon: <Clock className="h-3 w-3" />,    count: [...workingOrders.demo, ...workingOrders.live].length },
            { id: 'history'  as const, label: 'Trade History',   icon: <Activity className="h-3 w-3" />, count: tradeHistory.length },
          ]).map(({ id, label, icon, count }) => (
            <button key={id} onClick={() => setPosTab(id)}
              className={clsx('px-3 py-1.5 text-xs font-medium rounded-md transition-all flex items-center gap-1.5',
                posTab === id ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
              )}>
              {icon}
              {label}
              {count > 0 && <span className={clsx('text-[9px] px-1 rounded-full', posTab===id ? 'bg-orange-500/30 text-orange-300' : 'bg-gray-700 text-gray-500')}>{count}</span>}
            </button>
          ))}
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

        {/* Trade History tab */}
        {posTab === 'history' && (() => {
          const closed   = tradeHistory.filter(r => r.status === 'CLOSED');
          const wins     = closed.filter(r => (r.pnl ?? 0) > 0);
          const losses   = closed.filter(r => (r.pnl ?? 0) < 0);
          const totalPnLH = closed.reduce((s, r) => s + (r.pnl ?? 0), 0);
          const winRate  = closed.length > 0 ? Math.round((wins.length / closed.length) * 100) : 0;
          const avgWin   = wins.length   > 0 ? wins.reduce((s, r) => s + (r.pnl ?? 0), 0) / wins.length : 0;
          const avgLoss  = losses.length > 0 ? losses.reduce((s, r) => s + (r.pnl ?? 0), 0) / losses.length : 0;
          const bestPnL  = closed.length > 0 ? Math.max(...closed.map(r => r.pnl ?? 0)) : 0;
          const worstPnL = closed.length > 0 ? Math.min(...closed.map(r => r.pnl ?? 0)) : 0;
          return (
            <>
              {/* Stats */}
              {tradeHistory.length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
                  {[
                    { label: 'Total Trades', value: tradeHistory.length.toString() },
                    { label: 'Win Rate',     value: closed.length > 0 ? `${winRate}%` : '—', color: winRate >= 50 ? 'text-emerald-400' : 'text-red-400' },
                    { label: 'Total P&L',    value: `${totalPnLH >= 0 ? '+' : ''}£${Math.abs(totalPnLH).toFixed(2)}`, color: totalPnLH >= 0 ? 'text-emerald-400' : 'text-red-400' },
                    { label: 'Avg Win',      value: avgWin  > 0 ? `+£${avgWin.toFixed(2)}`  : '—', color: 'text-emerald-400' },
                    { label: 'Avg Loss',     value: avgLoss < 0 ? `-£${Math.abs(avgLoss).toFixed(2)}` : '—', color: 'text-red-400' },
                    { label: 'Best Trade',   value: bestPnL  > 0 ? `+£${bestPnL.toFixed(2)}`  : '—', color: 'text-emerald-400' },
                    { label: 'Worst Trade',  value: worstPnL < 0 ? `-£${Math.abs(worstPnL).toFixed(2)}` : '—', color: 'text-red-400' },
                    { label: 'Open',         value: tradeHistory.filter(r=>r.status==='OPEN').length.toString() },
                  ].map(s => (
                    <div key={s.label} className="bg-gray-800/40 rounded-lg px-3 py-2">
                      <p className="text-[9px] text-gray-500 uppercase tracking-wider">{s.label}</p>
                      <p className={clsx('text-sm font-bold tabular-nums', s.color ?? 'text-white')}>{s.value}</p>
                    </div>
                  ))}
                </div>
              )}

              {/* Clear button */}
              {tradeHistory.length > 0 && (
                <div className="flex justify-end mb-3">
                  <button
                    onClick={() => { if (confirm('Clear all trade history?')) { setTradeHistory([]); saveIGTradeHistory([]); } }}
                    className="text-[10px] text-gray-600 hover:text-red-400 transition-colors"
                  >
                    Clear history
                  </button>
                </div>
              )}

              {tradeHistory.length === 0 ? (
                <p className="text-sm text-gray-500 py-6 text-center">No trades recorded yet — run a strategy to start building history</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-gray-800">
                        {['Opened', 'Strategy', 'Market', 'Dir', 'Size', 'Entry', 'Exit', 'P&L', 'Status', 'Reason', 'Ref'].map(h => (
                          <th key={h} className="px-2 py-2 text-[9px] text-gray-500 font-medium uppercase tracking-wider whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {tradeHistory.map(r => (
                        <tr key={r.id} className="border-t border-gray-800/50 hover:bg-gray-800/20 text-xs">
                          <td className="px-2 py-2 text-[10px] text-gray-500 whitespace-nowrap">
                            {new Date(r.openedAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}
                          </td>
                          <td className="px-2 py-2 text-[10px] text-gray-400 max-w-[80px] truncate">{r.portfolioName}</td>
                          <td className="px-2 py-2">
                            <p className="text-white font-medium truncate max-w-[100px]">{r.market}</p>
                            <p className="text-[9px] text-gray-600 font-mono">{r.epic}</p>
                          </td>
                          <td className="px-2 py-2">
                            <span className={clsx('text-[9px] font-bold px-1.5 py-0.5 rounded',
                              r.direction === 'BUY' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                            )}>{r.direction}</span>
                          </td>
                          <td className="px-2 py-2 text-gray-300 tabular-nums">£{r.size}</td>
                          <td className="px-2 py-2 text-gray-300 tabular-nums">{r.entryLevel > 0 ? r.entryLevel.toLocaleString() : '—'}</td>
                          <td className="px-2 py-2 text-gray-300 tabular-nums">
                            {r.exitLevel != null ? r.exitLevel.toLocaleString() : <span className="text-blue-400">Open</span>}
                          </td>
                          <td className="px-2 py-2">
                            {r.pnl != null ? (
                              <span className={clsx('font-semibold tabular-nums', r.pnl >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                                {r.pnl >= 0 ? '+' : ''}£{Math.abs(r.pnl).toFixed(2)}
                              </span>
                            ) : <span className="text-gray-600">—</span>}
                          </td>
                          <td className="px-2 py-2">
                            <span className={clsx('text-[9px] font-bold px-1.5 py-0.5 rounded',
                              r.status === 'OPEN'     ? 'bg-blue-500/20 text-blue-400' :
                              r.status === 'CLOSED'   ? 'bg-gray-700 text-gray-300' :
                              'bg-red-500/20 text-red-400'
                            )}>{r.status}</span>
                          </td>
                          <td className="px-2 py-2 text-[10px] text-gray-500">
                            {r.closeReason ? r.closeReason.replace('_', ' ') : '—'}
                          </td>
                          <td className="px-2 py-2 text-[9px] text-gray-600 font-mono truncate max-w-[70px]">{r.dealReference || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          );
        })()}
      </Card>

      {/* ── Activity Log ────────────────────────────────────────────────── */}
      {runLog.length > 0 && (
        <Card>
          <CardHeader title="Activity Log" subtitle={`${runLog.length} entries`} icon={<Clock className="h-4 w-4" />}
            action={
              <div className="flex items-center gap-3">
                {/* IG API rate-limit counter */}
                <span className={clsx('text-[10px] font-mono px-1.5 py-0.5 rounded',
                  rateLimitPause > 0
                    ? 'bg-red-500/20 text-red-400'
                    : apiCallCount >= 15
                    ? 'bg-yellow-500/20 text-yellow-400'
                    : 'bg-gray-800 text-gray-500',
                )}>
                  {rateLimitPause > 0
                    ? `⛔ rate-limit ${Math.ceil(rateLimitPause / 1000)}s`
                    : `${apiCallCount}/20 calls/min`}
                </span>
                <button onClick={() => setRunLog([])} className="text-xs text-gray-500 hover:text-white">Clear</button>
              </div>
            }
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

      {/* ── Diagnostic modal ─────────────────────────────────────────────── */}
      {diagModal && (
        <div className="fixed inset-0 z-[9999] flex items-start justify-center bg-black/80 px-4 overflow-y-auto" onClick={e => { if (e.target === e.currentTarget) setDiagModal(false); }}>
          <div className="bg-gray-950 border border-gray-700 rounded-2xl w-full max-w-2xl mt-[80px] mb-8 shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-white">🧪 IG Diagnostic</span>
                {testOrderBusy && <span className="text-[10px] text-blue-400 animate-pulse">Running…</span>}
              </div>
              <button onClick={() => setDiagModal(false)} className="text-gray-500 hover:text-white p-1 rounded-lg hover:bg-gray-800 transition-colors">
                <X className="h-4 w-4" />
              </button>
            </div>
            <pre className="p-4 text-[11px] font-mono text-gray-300 whitespace-pre-wrap break-all leading-relaxed max-h-[60vh] overflow-y-auto bg-gray-950">
              {diagLines.length ? diagLines.join('\n') : 'Starting diagnostic…'}
            </pre>
            {!testOrderBusy && (
              <div className="px-4 py-3 border-t border-gray-800 flex gap-2">
                <button onClick={() => void runTestOrder()} className="text-xs px-3 py-1.5 rounded-lg bg-blue-600/20 border border-blue-500/30 text-blue-300 hover:bg-blue-600/30 transition-colors">
                  Run Again
                </button>
                <button onClick={() => setDiagModal(false)} className="text-xs px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-gray-400 hover:text-white transition-colors">
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      )}
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
            <div className="flex items-center gap-1.5">
              <p className="text-xs font-semibold text-white truncate">{pos.instrumentName ?? pos.epic}</p>
              {pos.subAccountType && (
                <span className={clsx('text-[9px] font-bold px-1 py-0 rounded flex-shrink-0',
                  pos.subAccountType === 'SPREADBET' ? 'bg-purple-500/20 text-purple-400' :
                  pos.subAccountType === 'CFD'       ? 'bg-blue-500/20 text-blue-400' :
                  'bg-gray-700 text-gray-400'
                )}>
                  {pos.subAccountType === 'SPREADBET' ? 'SB' : pos.subAccountType}
                </span>
              )}
            </div>
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

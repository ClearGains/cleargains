'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Play, Square, Save, Trash2, Plus, RefreshCw, Search,
  AlertCircle, CheckCircle2, Clock, Target,
  TrendingUp, TrendingDown, Wifi, X, Zap,
  ArrowUpDown, Activity, ChevronDown, ChevronUp, Edit2,
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
  type AccountType,
  epicForAccount, toCfdEpic, toSpreadbetEpic,
  getStopDistances, MIN_STRENGTH,
} from '@/lib/igConfig';
import { igQueue } from '@/lib/igApiQueue';

// ── Types ─────────────────────────────────────────────────────────────────────

interface IGAccountPanelProps {
  accountId: string;
  accountType: AccountType;
  env: 'demo' | 'live';
}

type IGSession = {
  cst: string; securityToken: string; accountId: string;
  apiKey: string; accountType?: string;
};

type IGPosition = {
  dealId: string; direction: string; size: number; level: number;
  upl: number; currency: string; epic: string; instrumentName: string;
  bid: number; offer: number; stopLevel?: number; limitLevel?: number;
  contractSize?: number; createdDate?: string;
  subAccountId?: string; subAccountType?: string;
};

type IGWorkingOrder = {
  dealId: string; epic: string; instrumentName: string;
  direction: string; size: number; orderType: string; level: number;
  stopLevel?: number; limitLevel?: number; currency: string;
  createdAt?: string; timeInForce?: string;
};

type MarketScan = {
  epic: string; name: string; signal: StrategySignal | null;
  price?: number; changePercent?: number; source?: string;
  scanning: boolean; status: 'idle' | 'ok' | 'error';
  error?: string; lastScanned?: string;
};

type RunLog = { id: string; ts: string; type: 'info'|'buy'|'sell'|'close'|'error'|'signal'; msg: string };

type OrderResult = {
  ok: boolean; dealReference?: string; dealId?: string; dealStatus?: string;
  level?: number; reason?: string; error?: string; epic?: string;
  resolvedVia?: string; sentPayload?: unknown; igBody?: unknown;
  igStatus?: number; freshCst?: string; freshSecurityToken?: string;
};

export interface IGTradeRecord {
  id: string; portfolioName: string; market: string; epic: string;
  direction: 'BUY'|'SELL'; size: number; entryLevel: number;
  exitLevel: number|null; openedAt: string; closedAt: string|null;
  status: 'OPEN'|'CLOSED'|'REJECTED'; dealReference: string; dealId: string;
  pnl: number|null;
  closeReason: 'STOP_LOSS'|'TAKE_PROFIT'|'MANUAL'|'STRATEGY'|'STALE'|null;
  accountType: 'demo'|'live';
}

// ── Module-level helpers ───────────────────────────────────────────────────────

function makeHeaders(s: IGSession, env: 'demo'|'live', extra?: Record<string,string>) {
  return {
    'x-ig-cst': s.cst, 'x-ig-security-token': s.securityToken,
    'x-ig-api-key': s.apiKey, 'x-ig-env': env, ...extra,
  };
}

const SESSION_TTL_MS = 5 * 60 * 60 * 1000;
function uid() { return Math.random().toString(36).slice(2, 9); }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function fmt(n: number) { return `£${Math.abs(n).toFixed(2)}`; }
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
}

function calcDynamicSize(requestedSize: number, available: number): number {
  if (available < 100) return 0;
  if (available < 500) return 0.1;
  const pctBased = Math.floor((available * 0.05) * 10) / 10;
  return Math.min(requestedSize, Math.max(0.1, pctBased));
}

function calibrateSignal(
  changePercent: number,
  rawSignal: 'BUY'|'SELL'|'NEUTRAL',
  mType: MarketType,
): { direction: 'BUY'|'SELL'|'HOLD'; strength: number } {
  const pct = Math.abs(changePercent);
  const dir: 'BUY'|'SELL'|'HOLD' =
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
    default:
      strength = pct >= 3.0 ? 85 : pct >= 2.0 ? 75 : pct >= 1.0 ? 65 : Math.round((pct / 1.0) * 60);
  }
  return { direction: dir, strength: Math.min(99, Math.max(0, strength)) };
}

// ── Trade history ─────────────────────────────────────────────────────────────

const IG_TRADE_HISTORY_KEY = 'ig_trade_history';

function loadIGTradeHistory(): IGTradeRecord[] {
  try {
    const raw = typeof window !== 'undefined' ? localStorage.getItem(IG_TRADE_HISTORY_KEY) : null;
    if (!raw) return [];
    return JSON.parse(raw) as IGTradeRecord[];
  } catch { return []; }
}
function saveIGTradeHistory(r: IGTradeRecord[]) {
  try { localStorage.setItem(IG_TRADE_HISTORY_KEY, JSON.stringify(r.slice(0, 500))); } catch {}
}
function recordTradeOpen(prev: IGTradeRecord[], rec: Omit<IGTradeRecord,'id'>): IGTradeRecord[] {
  const next = [{ ...rec, id: Date.now().toString() }, ...prev];
  saveIGTradeHistory(next); return next;
}
function recordTradeClose(
  prev: IGTradeRecord[], dealId: string, exitLevel: number,
  pnl: number, closeReason: IGTradeRecord['closeReason'], closedAt: string,
): IGTradeRecord[] {
  const next = prev.map(r =>
    (r.dealId === dealId || (r.dealId === '' && r.status === 'OPEN')) && r.status === 'OPEN'
      ? { ...r, exitLevel, pnl, closeReason, closedAt, status: 'CLOSED' as const }
      : r,
  );
  saveIGTradeHistory(next); return next;
}

// ── Sub-components ────────────────────────────────────────────────────────────

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
  session: IGSession; env: 'demo'|'live';
  onSelect: (m: { epic: string; instrumentName: string }) => void;
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
          {res.slice(0, 8).map(m => (
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

// ── Main component ────────────────────────────────────────────────────────────

export function IGAccountPanel({ accountId, accountType, env }: IGAccountPanelProps) {

  // ── Session ────────────────────────────────────────────────────────────────
  const [session, setSession] = useState<IGSession|null>(null);
  const [connecting, setConnecting] = useState(false);
  const sessionRef  = useRef<IGSession|null>(null);
  const tradeLockRef = useRef(false);
  const lastReauthRef = useRef(0);

  // ── Positions ──────────────────────────────────────────────────────────────
  const [positions, setPositions] = useState<IGPosition[]>([]);
  const positionsRef = useRef<IGPosition[]>([]);
  const [loadingPos, setLoadingPos] = useState(false);
  const [closingId, setClosingId]   = useState<string|null>(null);
  const [posError, setPosError]     = useState<string|null>(null);
  const posRefreshRef = useRef<ReturnType<typeof setInterval>|null>(null);

  // ── Working orders ─────────────────────────────────────────────────────────
  const [workingOrders, setWorkingOrders] = useState<IGWorkingOrder[]>([]);
  const [cancellingOrder, setCancellingOrder] = useState<string|null>(null);

  // ── Strategies ─────────────────────────────────────────────────────────────
  const defaultWatchlist = accountType === 'CFD' ? CFD_WATCHLIST : DEFAULT_WATCHLIST;
  const [strategies, setStrategies]   = useState<IGSavedStrategy[]>([]);
  const [activeStratId, setActiveStratId] = useState<string|null>(null);
  const [isRunning, setIsRunning]     = useState(false);
  const [testRunning, setTestRunning] = useState(false);
  const timerRef    = useRef<ReturnType<typeof setInterval>|null>(null);
  const posTimerRef = useRef<ReturnType<typeof setInterval>|null>(null);
  const runningRef  = useRef(false);

  // ── Scanner ────────────────────────────────────────────────────────────────
  const [scans, setScans]               = useState<Record<string, MarketScan>>({});
  const [scanProgress, setScanProgress] = useState('');

  // ── Funds ──────────────────────────────────────────────────────────────────
  const igFundsRef = useRef<{available:number;balance:number}|null>(null);
  const [igFundsDisplay, setIgFundsDisplay] = useState<{available:number;balance:number}|null>(null);

  // ── Timers ─────────────────────────────────────────────────────────────────
  const [signalScanMs, setSignalScanMs] = useState(5 * 60_000);
  const [posMonitorMs, setPosMonitorMs] = useState(60_000);
  const signalStartRef = useRef<number|null>(null);
  const posStartRef    = useRef<number|null>(null);
  const [signalCountdown, setSignalCountdown] = useState('');
  const [posCountdown, setPosCountdown]       = useState('');

  // ── API counter ────────────────────────────────────────────────────────────
  const [apiCallCount, setApiCallCount]     = useState(0);
  const [rateLimitPause, setRateLimitPause] = useState(0);

  // ── Trade history ──────────────────────────────────────────────────────────
  const [tradeHistory, setTradeHistory] = useState<IGTradeRecord[]>([]);

  // ── Live trade disclaimer ──────────────────────────────────────────────────
  const liveTradeAckedRef   = useRef(false);
  const liveTradeResolveRef = useRef<((ok: boolean) => void)|null>(null);
  const [showLiveTradeDisclaimer, setShowLiveTradeDisclaimer] = useState(false);

  // ── UI state ───────────────────────────────────────────────────────────────
  const [posTab, setPosTab] = useState<'positions'|'orders'|'history'>('positions');
  const [runLog, setRunLog] = useState<RunLog[]>([]);
  const [toast, setToast]   = useState<{ok:boolean;msg:string}|null>(null);

  // ── Builder ────────────────────────────────────────────────────────────────
  const [showBuilder, setShowBuilder]     = useState(false);
  const [editId, setEditId]               = useState<string|null>(null);
  const [bName, setBName]                 = useState('');
  const [bTimeframe, setBTimeframe]       = useState<Timeframe>('daily');
  const [bSize, setBSize]                 = useState(1);
  const [bMaxPos, setBMaxPos]             = useState(3);
  const [bMinStrength, setBMinStrength]   = useState(55);
  const [bAutoClose, setBAutoClose]       = useState(true);
  const [bWatchlist, setBWatchlist]       = useState<WatchlistMarket[]>([...defaultWatchlist]);
  const [bSignalScanMs, setBSignalScanMs] = useState(5 * 60_000);
  const [bPosMonitorMs, setBPosMonitorMs] = useState(60_000);

  // ── Manual trade ───────────────────────────────────────────────────────────
  const [showManual, setShowManual]       = useState(false);
  const [manualEpic, setManualEpic]       = useState('');
  const [manualName, setManualName]       = useState('');
  const [manualDir, setManualDir]         = useState<'BUY'|'SELL'>('BUY');
  const [manualSize, setManualSize]       = useState(1);
  const [manualStop, setManualStop]       = useState<number|''>('');
  const [manualLimit, setManualLimit]     = useState<number|''>('');
  const [placingManual, setPlacingManual] = useState(false);

  // ── Diagnostic ─────────────────────────────────────────────────────────────
  const [testOrderBusy, setTestOrderBusy] = useState(false);
  const [diagModal, setDiagModal]         = useState(false);
  const [diagLines, setDiagLines]         = useState<string[]>([]);

  // ── SL/TP modals ───────────────────────────────────────────────────────────
  type SlTpModal = { pos: IGPosition };
  const [slModal, setSlModal]   = useState<SlTpModal|null>(null);
  const [tpModal, setTpModal]   = useState<SlTpModal|null>(null);
  const [slInput, setSlInput]   = useState('');
  const [tpInput, setTpInput]   = useState('');
  const [updatingPos, setUpdatingPos]   = useState<string|null>(null);
  const [reversingPos, setReversingPos] = useState<string|null>(null);

  // ── Helpers ────────────────────────────────────────────────────────────────

  function showToast(ok: boolean, msg: string) {
    setToast({ ok, msg });
    setTimeout(() => setToast(null), 4000);
  }

  function log(type: RunLog['type'], msg: string) {
    setRunLog(p => [{ id: uid(), ts: new Date().toISOString(), type, msg }, ...p].slice(0, 200));
  }

  const acctTag = ` [${accountType} | ${accountId}]`;

  function storeSession(sess: IGSession) {
    sessionRef.current = sess;
    setSession(sess);
    localStorage.setItem(`ig_session_${accountId}`, JSON.stringify({ ...sess, authenticatedAt: Date.now() }));
  }

  function loadStrategiesForAccount(): IGSavedStrategy[] {
    return loadStrategies().filter(s => !s.accountId || s.accountId === accountId);
  }

  // ── connectForAccount: always logs in + switches to accountId atomically ───
  async function connectForAccount(forceRefresh = false): Promise<IGSession|null> {
    const credKey = env === 'demo' ? 'ig_demo_credentials' : 'ig_live_credentials';
    const sessKey = `ig_session_${accountId}`;
    try {
      const raw = localStorage.getItem(credKey);

      if (!forceRefresh) {
        const cachedRaw = localStorage.getItem(sessKey);
        if (cachedRaw) {
          const cached = JSON.parse(cachedRaw) as {
            cst:string; securityToken:string; accountId:string;
            apiKey:string; accountType?:string; authenticatedAt:number;
          };
          if (cached.cst && cached.securityToken && (Date.now() - cached.authenticatedAt) < SESSION_TTL_MS) {
            return { cst:cached.cst, securityToken:cached.securityToken, accountId:cached.accountId, apiKey:cached.apiKey, accountType:cached.accountType };
          }
        }
      }

      let authBody: Record<string, unknown>;
      if (raw) {
        const c = JSON.parse(raw) as { username:string; password:string; apiKey:string; connected?:boolean };
        if (!c.connected) return null;
        authBody = { username:c.username, password:c.password, apiKey:c.apiKey, env, forceRefresh, targetAccountId: accountId };
      } else {
        authBody = { env, forceRefresh, useEnvCredentials: true, targetAccountId: accountId };
      }

      const r = await igQueue.enqueue(
        () => fetch('/api/ig/session', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(authBody) }),
        accountId,
      );
      const d = await r.json() as { ok:boolean; cst?:string; securityToken?:string; accountId?:string; accountType?:string };
      if (d.ok && d.cst && d.securityToken) {
        const apiKey = raw ? (JSON.parse(raw) as { apiKey:string }).apiKey : '';
        const sess: IGSession = { cst:d.cst, securityToken:d.securityToken, accountId:d.accountId ?? accountId, apiKey, accountType:d.accountType ?? accountType };
        localStorage.setItem(sessKey, JSON.stringify({ ...sess, authenticatedAt: Date.now() }));
        return sess;
      }
    } catch {}
    return null;
  }

  async function freshSession(): Promise<IGSession|null> {
    try {
      const raw = localStorage.getItem(`ig_session_${accountId}`);
      if (raw) {
        const meta = JSON.parse(raw) as { authenticatedAt?:number };
        if (meta.authenticatedAt && (Date.now() - meta.authenticatedAt) >= SESSION_TTL_MS) {
          localStorage.removeItem(`ig_session_${accountId}`);
          const fresh = await connectForAccount(true);
          if (fresh) storeSession(fresh);
          return fresh;
        }
      }
    } catch {}
    return sessionRef.current;
  }

  // ── igQueue telemetry ──────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = igQueue.subscribe?.(() => {
      setApiCallCount(igQueue.recentCallsFor?.(accountId) ?? igQueue.recentCalls ?? 0);
      setRateLimitPause(igQueue.pauseRemaining ?? 0);
    });
    const ticker = setInterval(() => {
      setApiCallCount(igQueue.recentCallsFor?.(accountId) ?? igQueue.recentCalls ?? 0);
      setRateLimitPause(igQueue.pauseRemaining ?? 0);
    }, 1_000);
    return () => { unsub?.(); clearInterval(ticker); };
  }, [accountId]);

  // ── Countdown ticker ───────────────────────────────────────────────────────
  useEffect(() => {
    const t = setInterval(() => {
      if (!isRunning) { setSignalCountdown(''); setPosCountdown(''); return; }
      const fmtMs = (ms: number) => {
        const s = Math.max(0, Math.ceil(ms / 1000));
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      };
      if (signalStartRef.current !== null)
        setSignalCountdown(fmtMs(signalScanMs - (Date.now() - signalStartRef.current)));
      if (posStartRef.current !== null)
        setPosCountdown(fmtMs(posMonitorMs - (Date.now() - posStartRef.current)));
    }, 1000);
    return () => clearInterval(t);
  }, [isRunning, signalScanMs, posMonitorMs]);

  // ── Mount: connect + load strategies/history ───────────────────────────────
  useEffect(() => {
    setStrategies(loadStrategiesForAccount());
    setTradeHistory(loadIGTradeHistory());
    liveTradeAckedRef.current = localStorage.getItem('ig_live_first_trade_ack') === '1';
    setConnecting(true);
    connectForAccount().then(sess => {
      if (sess) storeSession(sess);
      setConnecting(false);
    });
    return () => {
      if (timerRef.current)      clearInterval(timerRef.current);
      if (posTimerRef.current)   clearInterval(posTimerRef.current);
      if (posRefreshRef.current) clearInterval(posRefreshRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Auto-refresh positions when session arrives ────────────────────────────
  useEffect(() => {
    if (!session) return;
    void loadPositions();
    void loadWorkingOrders();
    if (posRefreshRef.current) clearInterval(posRefreshRef.current);
    posRefreshRef.current = setInterval(() => void loadPositions(), 60_000);
    return () => { if (posRefreshRef.current) clearInterval(posRefreshRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // ── Pre-populate scan cards when strategy selected ────────────────────────
  useEffect(() => {
    if (!activeStratId) return;
    const strat = strategies.find(s => s.id === activeStratId);
    if (!strat) return;
    const markets = (strat.watchlist?.length ? strat.watchlist : defaultWatchlist).filter(m => m.enabled);
    setScans(prev => {
      const next = { ...prev };
      markets.forEach(m => {
        if (!next[m.epic])
          next[m.epic] = { epic:m.epic, name:m.name, signal:null, scanning:false, status:'idle' };
      });
      return next;
    });
  }, [activeStratId, strategies]);

  // ── Load positions ─────────────────────────────────────────────────────────
  const loadPositions = useCallback(async () => {
    const sess = sessionRef.current;
    if (!sess) return;
    setLoadingPos(true); setPosError(null);
    try {
      let r = await igQueue.enqueue(() => fetch('/api/ig/positions', { headers: makeHeaders(sess, env) }), accountId);
      if (r.status === 403) {
        setPosError('Rate limited — retrying next cycle'); setLoadingPos(false); return;
      }
      if (r.status === 401) {
        if (Date.now() - lastReauthRef.current < 30_000) { setLoadingPos(false); return; }
        lastReauthRef.current = Date.now();
        localStorage.removeItem(`ig_session_${accountId}`);
        const fresh = await connectForAccount(true);
        if (!fresh) { setPosError('Session expired — reconnect in Settings'); setLoadingPos(false); return; }
        storeSession(fresh);
        const freshSess = fresh;
        r = await igQueue.enqueue(() => fetch('/api/ig/positions', { headers: makeHeaders(freshSess, env) }), accountId);
      }
      const d = await r.json() as { ok:boolean; positions?:IGPosition[]; error?:string; detail?:string };
      if (d.ok) {
        const list = (d.positions ?? []).map(p => ({ ...p, subAccountId: accountId, subAccountType: accountType }));
        positionsRef.current = list;
        setPositions(list);
      } else {
        setPosError(`Positions error: ${d.error ?? 'unknown'}${d.detail ? ` — ${d.detail}` : ''}`);
      }
    } catch (e) {
      setPosError(`Failed to fetch positions: ${e instanceof Error ? e.message : String(e)}`);
    }
    setLoadingPos(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Load working orders ────────────────────────────────────────────────────
  const loadWorkingOrders = useCallback(async () => {
    const sess = sessionRef.current;
    if (!sess) return;
    try {
      const r = await igQueue.enqueue(() => fetch('/api/ig/workingorders', { headers: makeHeaders(sess, env) }), accountId);
      const d = await r.json() as { ok:boolean; workingOrders?:IGWorkingOrder[] };
      if (d.ok) setWorkingOrders(d.workingOrders ?? []);
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Update SL/TP ───────────────────────────────────────────────────────────
  async function updatePositionSL(pos: IGPosition, stopLevel: number|null, limitLevel: number|null) {
    const sess = sessionRef.current;
    if (!sess) return { ok:false, error:'No session' };
    const r = await igQueue.enqueue(() => fetch('/api/ig/order', {
      method:'PATCH',
      headers:{ ...makeHeaders(sess, env), 'Content-Type':'application/json' },
      body: JSON.stringify({ dealId:pos.dealId, stopLevel, limitLevel }),
    }), accountId);
    return r.json() as Promise<{ok:boolean;error?:string}>;
  }

  // ── Cancel working order ───────────────────────────────────────────────────
  async function cancelWorkingOrder(dealId: string) {
    setCancellingOrder(dealId);
    const sess = sessionRef.current;
    if (!sess) { setCancellingOrder(null); return; }
    try {
      const r = await igQueue.enqueue(() => fetch('/api/ig/workingorders', {
        method:'DELETE',
        headers:{ ...makeHeaders(sess, env), 'Content-Type':'application/json' },
        body: JSON.stringify({ dealId }),
      }), accountId);
      const d = await r.json() as { ok:boolean; error?:string };
      if (d.ok) { log('info', `${acctTag} Working order ${dealId} cancelled`); showToast(true, 'Order cancelled'); await loadWorkingOrders(); }
      else showToast(false, d.error ?? 'Cancel failed');
    } catch { showToast(false, 'Cancel failed'); }
    setCancellingOrder(null);
  }

  // ── Close position ─────────────────────────────────────────────────────────
  async function closePos(pos: IGPosition): Promise<{ok:boolean;error?:string}> {
    let sess = sessionRef.current;
    if (!sess) return { ok:false, error:'No session' };
    const closeBody = { dealId:pos.dealId, direction: pos.direction === 'BUY' ? 'SELL' : 'BUY', size:pos.size };
    const doClose = (s: IGSession) => igQueue.enqueue(() => fetch('/api/ig/order', {
      method:'DELETE',
      headers:{ ...makeHeaders(s, env), 'Content-Type':'application/json' },
      body: JSON.stringify(closeBody),
    }), accountId);
    let r = await doClose(sess);
    if (r.status === 403) return { ok:false, error:'Rate limit (403)' };
    if (r.status === 401) {
      if (Date.now() - lastReauthRef.current >= 30_000) {
        lastReauthRef.current = Date.now();
        localStorage.removeItem(`ig_session_${accountId}`);
        const fresh = await connectForAccount(true);
        if (fresh) { storeSession(fresh); sess = fresh; r = await doClose(sess); }
      }
    }
    return r.json() as Promise<{ok:boolean;error?:string}>;
  }

  // ── Fetch funds ────────────────────────────────────────────────────────────
  async function fetchIGFunds(): Promise<{available:number;balance:number}|null> {
    const sess = sessionRef.current;
    if (!sess) return null;
    try {
      const r = await igQueue.enqueue(() => fetch('/api/ig/account', { headers: makeHeaders(sess, env) }), accountId);
      const d = await r.json() as { ok:boolean; available?:number; balance?:number };
      if (d.ok) {
        const funds = { available: d.available ?? 0, balance: d.balance ?? 0 };
        igFundsRef.current = funds;
        setIgFundsDisplay(funds);
        return funds;
      }
    } catch {}
    return null;
  }

  // ── Fetch market snapshot ──────────────────────────────────────────────────
  async function fetchSnapshot(name: string) {
    try {
      const r = await fetch(`/api/ig/candles?name=${encodeURIComponent(name)}`);
      const d = await r.json() as { ok:boolean; price?:number; changePercent?:number; signal?:'BUY'|'SELL'|'NEUTRAL'; source?:string; error?:string };
      if (!d.ok) return { price:0, changePercent:0, signal:'NEUTRAL' as const, source:'yahoo', error: d.error ?? `HTTP ${r.status}` };
      return { price:d.price ?? 0, changePercent:d.changePercent ?? 0, signal:d.signal ?? 'NEUTRAL' as const, source:d.source ?? 'yahoo' };
    } catch (e) { return { price:0, changePercent:0, signal:'NEUTRAL' as const, source:'yahoo', error: e instanceof Error ? e.message : 'Fetch failed' }; }
  }

  // ── Place order ────────────────────────────────────────────────────────────
  async function placeOrder(
    epic: string, direction: 'BUY'|'SELL', size: number,
    stopDist?: number, limitDist?: number,
  ): Promise<OrderResult> {
    for (let i = 0; i < 150 && tradeLockRef.current; i++) await sleep(100);
    tradeLockRef.current = true;
    try { return await _placeOrderInner(epic, direction, size, stopDist, limitDist); }
    finally { await sleep(500); tradeLockRef.current = false; }
  }

  async function _placeOrderInner(
    epic: string, direction: 'BUY'|'SELL', size: number,
    stopDist?: number, limitDist?: number,
  ): Promise<OrderResult> {
    let sess = await freshSession();
    if (!sess) return { ok:false, error:`No ${env} session`, epic };

    const orderBody = { epic, direction, size, stopDistance: stopDist, profitDistance: limitDist };
    let activeSess: IGSession = sess;
    let r = await igQueue.enqueue(() => fetch('/api/ig/order', {
      method:'POST',
      headers:{ ...makeHeaders(activeSess, env), 'Content-Type':'application/json' },
      body: JSON.stringify(orderBody),
    }), accountId);

    const rawText = await r.text();

    if (r.status === 403 || rawText.includes('exceeded-api-key-allowance'))
      return { ok:false, error:'IG rate limit (403) — wait before retrying', epic };

    const isAuthErr = (status: number, body?: string) =>
      status === 401 || (body?.includes('account-token-invalid') ?? false) || (body?.includes('INVALID_TOKEN') ?? false);

    if (isAuthErr(r.status, rawText)) {
      if (Date.now() - lastReauthRef.current < 30_000)
        return { ok:false, error:'Auth error — re-auth cooldown active', epic };
      lastReauthRef.current = Date.now();
      localStorage.removeItem(`ig_session_${accountId}`);
      const fresh = await connectForAccount(true);
      if (!fresh) return { ok:false, error:'Re-auth failed', epic };
      storeSession(fresh); sess = fresh; activeSess = sess;
      r = await igQueue.enqueue(() => fetch('/api/ig/order', {
        method:'POST',
        headers:{ ...makeHeaders(activeSess, env), 'Content-Type':'application/json' },
        body: JSON.stringify(orderBody),
      }), accountId);
      const retryText = await r.text();
      let retryResult: OrderResult;
      try { retryResult = JSON.parse(retryText) as OrderResult; }
      catch { return { ok:false, error: retryText.slice(0, 200), epic }; }
      if (retryResult.ok && retryResult.freshCst && retryResult.freshSecurityToken)
        storeSession({ ...sess, cst: retryResult.freshCst, securityToken: retryResult.freshSecurityToken });
      return retryResult;
    }

    let result: OrderResult;
    try { result = JSON.parse(rawText) as OrderResult; }
    catch { return { ok:false, error: rawText.slice(0, 200), epic }; }
    if (result.ok && result.freshCst && result.freshSecurityToken)
      storeSession({ ...sess, cst: result.freshCst, securityToken: result.freshSecurityToken });
    return result;
  }

  // ── Reverse position ───────────────────────────────────────────────────────
  async function reversePosition(pos: IGPosition) {
    setReversingPos(pos.dealId);
    const closeDir = pos.direction === 'BUY' ? 'SELL' : 'BUY';
    const cr = await closePos(pos);
    if (!cr.ok) { showToast(false, `Close failed: ${cr.error ?? 'unknown'}`); setReversingPos(null); return; }
    log('close', `${acctTag} Reversed: closed ${pos.direction} ${pos.instrumentName ?? pos.epic}`);
    await loadPositions();
    const or = await placeOrder(pos.epic, closeDir, pos.size);
    if (or.ok) {
      log(closeDir === 'BUY' ? 'buy' : 'sell', `${acctTag} Reversed → opened ${closeDir} ${pos.instrumentName ?? pos.epic}`);
      showToast(true, `Reversed to ${closeDir}`);
      await loadPositions();
    } else {
      log('error', `${acctTag} Reverse open failed: ${or.error ?? 'unknown'}`);
      showToast(false, `Close succeeded but open failed: ${or.error ?? 'unknown'}`);
    }
    setReversingPos(null);
  }

  // ── Scan one market ────────────────────────────────────────────────────────
  async function scanMarket(strat: IGSavedStrategy, market: WatchlistMarket): Promise<StrategySignal|null> {
    setScans(p => ({ ...p, [market.epic]: { epic:market.epic, name:market.name, signal:null, scanning:true, status:'idle' } }));

    const snapshot = await fetchSnapshot(market.name);
    if (!snapshot || snapshot.error) {
      const errMsg = snapshot?.error ?? 'Failed to fetch market data';
      setScans(p => ({ ...p, [market.epic]: { epic:market.epic, name:market.name, signal:null, scanning:false, status:'error', error:errMsg } }));
      log('error', `${market.name}: ${errMsg}`);
      return null;
    }

    const mType = market.marketType ?? getMarketType(market.epic);
    const { stopDist, limitDist } = getStopDistances(mType, accountType);
    const { direction, strength } = calibrateSignal(snapshot.changePercent, snapshot.signal, mType);
    const pctStr = `${snapshot.changePercent >= 0 ? '+' : ''}${snapshot.changePercent.toFixed(2)}%`;

    const sig: StrategySignal = {
      direction, strength,
      reason: `Daily ${pctStr} (${mType})`,
      stopPoints: stopDist, targetPoints: limitDist,
      riskReward: `1:${(limitDist / stopDist).toFixed(1)}`,
      indicators: [
        { label:'Daily Change', value:pctStr, status: direction==='BUY'?'bullish':direction==='SELL'?'bearish':'neutral' },
        { label:'Type',        value:mType,   status:'neutral' },
        { label:'Stop dist',   value:`${stopDist}pt`, status:'neutral' },
        { label:'TP dist',     value:`${limitDist}pt`, status:'neutral' },
        { label:'Max loss',    value:`£${strat.size * stopDist}`, status:'neutral' },
      ],
    };

    setScans(p => ({ ...p, [market.epic]: {
      epic:market.epic, name:market.name, signal:sig,
      price:snapshot.price, changePercent:snapshot.changePercent,
      source:snapshot.source, scanning:false, status:'ok', lastScanned:new Date().toISOString(),
    }}));

    const effectiveMinStrength = Math.max(strat.minStrength, MIN_STRENGTH[accountType]);
    const forceOpen = market.forceOpen === true;
    const tradeDir: 'BUY'|'SELL'|null =
      forceOpen
        ? (direction !== 'HOLD' ? direction : snapshot.changePercent >= 0 ? 'BUY' : 'SELL')
        : direction !== 'HOLD' && strength >= effectiveMinStrength ? direction
        : null;

    if (!strat.autoTrade || !tradeDir) {
      if (direction !== 'HOLD' && !forceOpen)
        log('signal', `${market.name} → ${direction} ${strength}% (need ${effectiveMinStrength}% — no trade)`);
      return sig;
    }

    // ── Decide whether to trade ───────────────────────────────────────────────
    const envPositions = positionsRef.current;
    const opposite = tradeDir === 'BUY' ? 'SELL' : 'BUY';

    if (strat.autoClose) {
      for (const opp of envPositions.filter(p => p.epic === market.epic && p.direction === opposite)) {
        log('close', `${acctTag} Auto-closing ${opp.direction} ${market.name} — signal reversed`);
        const cr = await closePos(opp);
        if (cr.ok) {
          log('close', `${acctTag} ✅ Closed ${market.name}`);
          const exitPx = opp.direction === 'BUY' ? (opp.bid ?? opp.level) : (opp.offer ?? opp.level);
          setTradeHistory(prev => recordTradeClose(prev, opp.dealId, exitPx, opp.upl ?? 0, 'STRATEGY', new Date().toISOString()));
          await sleep(1000);
        } else log('error', `${acctTag} Close failed: ${cr.error ?? 'unknown'}`);
      }
      await loadPositions();
    }

    const openCount = positionsRef.current.filter(p => p.epic !== market.epic).length;
    if (openCount >= strat.maxPositions) {
      log('info', `${acctTag} Max ${strat.maxPositions} positions reached — skip ${market.name}`); return sig;
    }
    if (positionsRef.current.some(p => p.epic === market.epic && p.direction === tradeDir)) return sig;

    if (env === 'live') {
      const ok = await confirmLiveTrade();
      if (!ok) { log('info', `${acctTag} Disclaimer declined — skipping ${market.name}`); return sig; }
    }

    const fundsNow = igFundsRef.current;
    const available = fundsNow?.available ?? Infinity;
    const orderSize = calcDynamicSize(strat.size, available);

    if (orderSize === 0) {
      log('error', `${acctTag} ⚠️ Insufficient funds (£${available.toFixed(2)}) — pausing trades`);
      showToast(false, `⚠️ Low funds — skipping`);
      return sig;
    }

    if (available < 500 && positionsRef.current.length > 0) {
      const now = Date.now();
      const oldLosers = positionsRef.current
        .filter(p => p.upl < 0 && p.createdDate && (now - new Date(p.createdDate).getTime()) > 24 * 3_600_000)
        .sort((a, b) => a.upl - b.upl);
      if (oldLosers.length > 0) {
        const worst = oldLosers[0];
        log('close', `${acctTag} 💡 Freeing capital: closing worst loser ${worst.instrumentName ?? worst.epic}`);
        const cr = await closePos(worst);
        if (cr.ok) {
          const exitPx = worst.direction === 'BUY' ? (worst.bid ?? worst.level) : (worst.offer ?? worst.level);
          setTradeHistory(prev => recordTradeClose(prev, worst.dealId, exitPx, worst.upl ?? 0, 'STRATEGY', new Date().toISOString()));
          await loadPositions();
          await fetchIGFunds();
        }
      }
    }

    // Always resolve the correct epic for this account type
    const resolvedEpic = epicForAccount(market.name, accountType) ?? market.epic;
    if (resolvedEpic !== market.epic)
      log('info', `  ↳ Epic: ${market.epic} → ${resolvedEpic} [${accountType}]`);

    const maxLoss = orderSize * stopDist;
    const sizeLabel = accountType === 'CFD' ? `${orderSize} unit(s)` : `£${orderSize}/pt`;
    log(tradeDir === 'BUY' ? 'buy' : 'sell',
      `${acctTag} → ${tradeDir} ${market.name} | ${resolvedEpic} | ${sizeLabel} | SL ${stopDist}pt TP ${limitDist}pt | max loss £${maxLoss.toFixed(2)} | ${strength}%${forceOpen?' (FORCE)':''}`);

    const or = await placeOrder(resolvedEpic, tradeDir, orderSize, stopDist, limitDist);

    if (or.ok) {
      log(tradeDir === 'BUY' ? 'buy' : 'sell',
        `${acctTag} ✅ ${or.dealStatus ?? 'ACCEPTED'} — ref ${or.dealReference ?? 'n/a'} · dealId ${or.dealId ?? 'pending'} · @ ${or.level ?? '?'}`);
      showToast(true, `[${accountType}] ${tradeDir} ${market.name}`);
      setTradeHistory(prev => recordTradeOpen(prev, {
        portfolioName:strat.name, market:market.name, epic:resolvedEpic,
        direction:tradeDir, size:orderSize, entryLevel:or.level ?? 0,
        exitLevel:null, openedAt:new Date().toISOString(), closedAt:null,
        status:'OPEN', dealReference:or.dealReference ?? '', dealId:or.dealId ?? '',
        pnl:null, closeReason:null, accountType:env,
      }));
      await sleep(1500);
      await loadPositions();
      await loadWorkingOrders();
    } else {
      const errStr = (or.error ?? '').toLowerCase();
      if (errStr.includes('insufficient_funds') || errStr.includes('insufficient funds')) {
        log('error', `${acctTag} ⚠️ Insufficient funds — skipping`);
        showToast(false, `⚠️ Insufficient funds — skipping`);
        return sig;
      }
      if ((or.reason ?? '').toUpperCase() === 'UNKNOWN' || errStr.includes('instrument_not_found') || errStr.includes('epic')) {
        const hint = accountType === 'CFD'
          ? `Epic mismatch? Sent "${resolvedEpic}" to CFD account. Check EPIC_TABLE has correct CFD epic.`
          : `Epic mismatch? Sent "${resolvedEpic}" to SPREADBET account.`;
        log('error', `${acctTag} ⚠️ ${hint}`);
      }
      log('error', `${acctTag} ❌ ${market.name} FAILED — ${or.error ?? 'unknown'}`);
      if (or.reason)      log('error', `  reason: ${or.reason}`);
      if (or.sentPayload) log('error', `  sent: ${JSON.stringify(or.sentPayload)}`);
      if (or.igBody)      log('error', `  ig: ${JSON.stringify(or.igBody)}`);
      setTradeHistory(prev => recordTradeOpen(prev, {
        portfolioName:strat.name, market:market.name, epic:market.epic,
        direction:tradeDir, size:orderSize, entryLevel:0,
        exitLevel:null, openedAt:new Date().toISOString(), closedAt:new Date().toISOString(),
        status:'REJECTED', dealReference:'', dealId:'',
        pnl:null, closeReason:null, accountType:env,
      }));
    }
    return sig;
  }

  // ── Signal scan ────────────────────────────────────────────────────────────
  const runSignalScan = useCallback(async (strat: IGSavedStrategy) => {
    if (!runningRef.current) return;
    const markets = (strat.watchlist?.length ? strat.watchlist : defaultWatchlist).filter(m => m.enabled);
    const funds = await fetchIGFunds();
    if (funds) log('info', `💰 Available: £${funds.available.toFixed(2)} | Balance: £${funds.balance.toFixed(2)}`);
    log('info', `📡 Scan — ${markets.length} markets…`);
    for (let i = 0; i < markets.length; i++) {
      if (!runningRef.current) break;
      setScanProgress(`${markets[i].name} (${i+1}/${markets.length})`);
      await scanMarket(strat, markets[i]);
      if (i < markets.length - 1) await sleep(1500);
    }
    setScanProgress('');
    saveStrategy({ ...strat, lastRunAt:new Date().toISOString(), lastRunEnv:env });
    setStrategies(loadStrategiesForAccount());
    log('info', `Scan complete — next in ${Math.round((strat.signalScanMs ?? signalScanMs) / 60_000)}min`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, positions, signalScanMs]);

  // ── Position monitor ───────────────────────────────────────────────────────
  const runPositionMonitor = useCallback(async (strat: IGSavedStrategy) => {
    if (!runningRef.current) return;
    await loadPositions();
    for (const pos of positionsRef.current) {
      if (!pos.level || !pos.bid || !pos.offer) continue;
      const currentPx = pos.direction === 'BUY' ? pos.bid : pos.offer;
      const entryPx   = pos.level;
      const pnlPct    = pos.direction === 'BUY'
        ? ((currentPx - entryPx) / entryPx) * 100
        : ((entryPx - currentPx) / entryPx) * 100;

      if (pos.createdDate && strat.autoClose) {
        const ageMs = Date.now() - new Date(pos.createdDate).getTime();
        if (ageMs > 48 * 3_600_000 && Math.abs(pnlPct) < 0.5) {
          log('close', `${acctTag} ♻️ Recycling stale: ${pos.instrumentName ?? pos.epic} (${pnlPct.toFixed(2)}% P&L)`);
          const cr = await closePos(pos);
          if (cr.ok) {
            const exitPx = pos.direction === 'BUY' ? (pos.bid ?? currentPx) : (pos.offer ?? currentPx);
            setTradeHistory(prev => recordTradeClose(prev, pos.dealId, exitPx, pos.upl ?? 0, 'STALE', new Date().toISOString()));
          } else log('error', `${acctTag} Recycle failed: ${cr.error ?? 'unknown'}`);
          continue;
        }
      }

      let newStop: number|null = null, reason = '';
      if (pnlPct >= 3 && pnlPct < 5) {
        const be = entryPx;
        if (!pos.stopLevel || (pos.direction === 'BUY' ? pos.stopLevel < be : pos.stopLevel > be)) { newStop = be; reason = `+${pnlPct.toFixed(1)}% → SL to breakeven`; }
      }
      if (pnlPct >= 5) {
        const lock = pos.direction === 'BUY' ? entryPx * 1.02 : entryPx * 0.98;
        if (!pos.stopLevel || (pos.direction === 'BUY' ? pos.stopLevel < lock : pos.stopLevel > lock)) { newStop = Math.round(lock * 100) / 100; reason = `+${pnlPct.toFixed(1)}% → SL lock +2%`; }
      }
      if (newStop !== null) {
        const r = await updatePositionSL(pos, newStop, pos.limitLevel ?? null);
        if (r.ok) log('info', `${acctTag} ${pos.instrumentName ?? pos.epic}: ${reason}`);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, positions]);

  // ── Start / stop ───────────────────────────────────────────────────────────
  function startAutoRun(strat: IGSavedStrategy) {
    if (timerRef.current)    clearInterval(timerRef.current);
    if (posTimerRef.current) clearInterval(posTimerRef.current);
    runningRef.current = true; setIsRunning(true);
    const sScanMs = strat.signalScanMs ?? signalScanMs;
    const pMonMs  = strat.posMonitorMs ?? posMonitorMs;
    log('info', `▶ Auto-trader started — "${strat.name}" · ${accountType} | ${accountId} · signals every ${Math.round(sScanMs/60_000)}min`);
    signalStartRef.current = Date.now();
    void runSignalScan(strat);
    posStartRef.current = Date.now();
    void runPositionMonitor(strat);
    timerRef.current = setInterval(() => { signalStartRef.current = Date.now(); void runSignalScan(strat); }, sScanMs);
    posTimerRef.current = setInterval(() => { posStartRef.current = Date.now(); void runPositionMonitor(strat); }, pMonMs);
  }

  function stopAutoRun() {
    runningRef.current = false;
    if (timerRef.current)    { clearInterval(timerRef.current);    timerRef.current    = null; }
    if (posTimerRef.current) { clearInterval(posTimerRef.current); posTimerRef.current = null; }
    setIsRunning(false); setScanProgress(''); setSignalCountdown(''); setPosCountdown('');
    log('info', '⏹ Auto-trader stopped');
  }

  async function runTestScan(strat: IGSavedStrategy) {
    if (testRunning || isRunning) return;
    setTestRunning(true); runningRef.current = true;
    const testStrat = { ...strat, maxPositions:1 };
    log('info', `🧪 Test run — "${strat.name}" · max 1 position`);
    const markets = (strat.watchlist?.length ? strat.watchlist : defaultWatchlist).filter(m => m.enabled);
    let placed = 0;
    for (let i = 0; i < markets.length; i++) {
      if (!runningRef.current || placed >= 1) break;
      setScanProgress(`${markets[i].name} (${i+1}/${markets.length})`);
      const sig = await scanMarket(testStrat, markets[i]);
      if (sig && sig.direction !== 'HOLD' && sig.strength >= strat.minStrength) placed++;
      if (i < markets.length - 1) await sleep(500);
    }
    setScanProgress('');
    runningRef.current = false; setTestRunning(false);
    log('info', placed > 0 ? `🧪 Test done — ${placed} position opened.` : `🧪 Test done — no signals met ${strat.minStrength}% threshold.`);
  }

  // ── Live trade disclaimer ──────────────────────────────────────────────────
  function confirmLiveTrade(): Promise<boolean> {
    if (liveTradeAckedRef.current) return Promise.resolve(true);
    return new Promise(resolve => { liveTradeResolveRef.current = resolve; setShowLiveTradeDisclaimer(true); });
  }

  // ── Manual open ────────────────────────────────────────────────────────────
  async function handleManualOpen() {
    if (!manualEpic) { showToast(false, 'Select a market first'); return; }
    if (!session) { showToast(false, 'Not connected'); return; }
    setPlacingManual(true);
    const r = await placeOrder(manualEpic, manualDir, manualSize,
      manualStop !== '' ? Number(manualStop) : undefined,
      manualLimit !== '' ? Number(manualLimit) : undefined);
    if (r.ok) {
      log(manualDir === 'BUY' ? 'buy' : 'sell', `${acctTag} Manual ${manualDir} ${manualName || manualEpic} — ${r.dealStatus ?? 'ACCEPTED'} · ref ${r.dealReference ?? 'n/a'}`);
      showToast(true, `${manualDir} placed on ${manualName || manualEpic}`);
      setTradeHistory(prev => recordTradeOpen(prev, {
        portfolioName:'Manual', market:manualName||manualEpic, epic:manualEpic,
        direction:manualDir, size:manualSize, entryLevel:r.level ?? 0,
        exitLevel:null, openedAt:new Date().toISOString(), closedAt:null,
        status:'OPEN', dealReference:r.dealReference ?? '', dealId:r.dealId ?? '',
        pnl:null, closeReason:null, accountType:env,
      }));
      await sleep(1500); await loadPositions();
    } else {
      log('error', `${acctTag} Manual order failed: ${r.error ?? 'unknown'}`);
      showToast(false, r.error ?? 'Order failed');
    }
    setPlacingManual(false);
  }

  async function handleClose(pos: IGPosition) {
    setClosingId(pos.dealId);
    const r = await closePos(pos);
    if (r.ok) {
      log('close', `${acctTag} Closed ${pos.direction} ${pos.instrumentName ?? pos.epic}`);
      showToast(true, 'Position closed');
      const exitPx = pos.direction === 'BUY' ? (pos.bid ?? pos.level) : (pos.offer ?? pos.level);
      setTradeHistory(prev => recordTradeClose(prev, pos.dealId, exitPx, pos.upl ?? 0, 'MANUAL', new Date().toISOString()));
      await loadPositions(); await loadWorkingOrders();
    } else showToast(false, r.error ?? 'Close failed');
    setClosingId(null);
  }

  async function handleUpdateSL() {
    if (!slModal) return;
    const val = parseFloat(slInput);
    if (isNaN(val) || val <= 0) { showToast(false, 'Enter a valid stop-loss price'); return; }
    setUpdatingPos(slModal.pos.dealId);
    const r = await updatePositionSL(slModal.pos, val, slModal.pos.limitLevel ?? null);
    if (r.ok) { showToast(true, `Stop-loss moved to ${val}`); await loadPositions(); setSlModal(null); setSlInput(''); }
    else showToast(false, r.error ?? 'Update failed');
    setUpdatingPos(null);
  }

  async function handleUpdateTP() {
    if (!tpModal) return;
    const val = parseFloat(tpInput);
    if (isNaN(val) || val <= 0) { showToast(false, 'Enter a valid take-profit price'); return; }
    setUpdatingPos(tpModal.pos.dealId);
    const r = await updatePositionSL(tpModal.pos, tpModal.pos.stopLevel ?? null, val);
    if (r.ok) { showToast(true, `Take-profit moved to ${val}`); await loadPositions(); setTpModal(null); setTpInput(''); }
    else showToast(false, r.error ?? 'Update failed');
    setUpdatingPos(null);
  }

  // ── Builder ────────────────────────────────────────────────────────────────
  function openBuilder(existing?: IGSavedStrategy) {
    if (existing) {
      setEditId(existing.id); setBName(existing.name); setBTimeframe(existing.timeframe);
      setBSize(existing.size); setBMaxPos(existing.maxPositions);
      setBMinStrength(existing.minStrength ?? 55); setBAutoClose(existing.autoClose ?? true);
      setBWatchlist(existing.watchlist?.length ? existing.watchlist : [...defaultWatchlist]);
      setBSignalScanMs(existing.signalScanMs ?? 5*60_000); setBPosMonitorMs(existing.posMonitorMs ?? 60_000);
    } else {
      setEditId(null); setBName(''); setBTimeframe('daily'); setBSize(1); setBMaxPos(3);
      setBMinStrength(MIN_STRENGTH[accountType]); setBAutoClose(true);
      setBWatchlist([...defaultWatchlist]); setBSignalScanMs(5*60_000); setBPosMonitorMs(60_000);
    }
    setShowBuilder(true); setShowManual(false);
  }

  function handleSave() {
    if (!bName.trim()) { showToast(false, 'Strategy name is required'); return; }
    const s: IGSavedStrategy = {
      id: editId ?? uid(), name: bName.trim(), epic:'', instrumentName:'',
      watchlist: bWatchlist, minStrength: bMinStrength, timeframe: bTimeframe,
      size: bSize, maxPositions: bMaxPos, accounts:[env], accountId,
      autoTrade: true, autoClose: bAutoClose, createdAt: new Date().toISOString(),
      signalScanMs: bSignalScanMs, posMonitorMs: bPosMonitorMs,
    };
    saveStrategy(s);
    setStrategies(loadStrategiesForAccount());
    setShowBuilder(false);
    showToast(true, `Strategy "${s.name}" ${editId ? 'updated' : 'saved'}`);
  }

  // ── Diagnostic ─────────────────────────────────────────────────────────────
  async function runTestOrder() {
    if (testOrderBusy) return;
    setTestOrderBusy(true);
    const lines: string[] = [];
    function diag(line: string) { lines.push(line); setDiagLines([...lines]); log('info', line); }
    setDiagLines([]); setDiagModal(true);
    diag('══════════════════════════════════════════');
    diag(`🧪 IG DIAGNOSTIC [${accountType} | ${accountId}] — ` + new Date().toLocaleTimeString('en-GB'));
    diag('══════════════════════════════════════════');

    diag('\nSTEP 1 — Credentials');
    const credKey = env === 'demo' ? 'ig_demo_credentials' : 'ig_live_credentials';
    const raw = localStorage.getItem(credKey);
    type CredShape = { username:string; password:string; apiKey:string };
    let creds: CredShape|null = null;
    if (!raw) {
      diag('  ✗ No credentials in localStorage — using server env vars (IG_USERNAME/IG_API_KEY)');
    } else {
      try { creds = JSON.parse(raw) as CredShape; diag(`  ✓ username="${creds?.username}" apiKey="${creds?.apiKey?.slice(0,8)}…"`); } catch {}
    }

    diag('\nSTEP 2 — Login + switch to ' + accountId);
    let cst = '', secToken = '';
    try {
      const loginRes = await igQueue.enqueue(() => fetch('/api/ig/session', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(creds
          ? { username:creds.username, password:creds.password, apiKey:creds.apiKey, env, forceRefresh:true, targetAccountId:accountId }
          : { env, forceRefresh:true, useEnvCredentials:true, targetAccountId:accountId }),
      }), accountId);
      const d = await loginRes.json() as { ok:boolean; cst?:string; securityToken?:string; accountId?:string; accountType?:string; error?:string };
      diag(`  ← HTTP ${loginRes.status}`);
      if (!d.ok || !d.cst) { diag(`  ✗ Login failed: ${d.error ?? 'unknown'}`); setTestOrderBusy(false); return; }
      cst = d.cst; secToken = d.securityToken ?? '';
      diag(`  ✓ CST: "${cst.slice(0,12)}…"`);
      diag(`  ✓ accountId: ${d.accountId} | accountType: ${d.accountType}`);
      if (d.accountId !== accountId) diag(`  ⚠️ Expected ${accountId} but got ${d.accountId} — switch may have failed`);
    } catch (e) { diag(`  ✗ Exception: ${e instanceof Error ? e.message : String(e)}`); setTestOrderBusy(false); return; }

    diag('\nSTEP 3 — Fetch positions');
    try {
      const posRes = await igQueue.enqueue(() => fetch('/api/ig/positions', {
        headers: { 'x-ig-cst':cst, 'x-ig-security-token':secToken, 'x-ig-api-key':creds?.apiKey ?? '', 'x-ig-env':env },
      }), accountId);
      diag(`  ← HTTP ${posRes.status}`);
      const d = await posRes.json() as { ok:boolean; positions?:{ dealId:string; direction:string; instrumentName:string; upl:number }[]; error?:string };
      if (d.ok) { diag(`  ✓ ${d.positions?.length ?? 0} position(s)`); d.positions?.slice(0,3).forEach(p => diag(`  · ${p.dealId} | ${p.direction} | ${p.instrumentName} | UPL ${p.upl.toFixed(2)}`)); }
      else diag(`  ✗ Error: ${d.error ?? 'unknown'}`);
    } catch (e) { diag(`  ✗ Exception: ${e instanceof Error ? e.message : String(e)}`); }

    diag('\nSTEP 4 — Test epic resolution');
    const testMarket = accountType === 'CFD' ? 'FTSE 100' : 'FTSE 100';
    const testEpic = epicForAccount(testMarket, accountType) ?? 'NOT FOUND';
    diag(`  Market: "${testMarket}" → epic for ${accountType}: ${testEpic}`);

    diag('\n══════════════════════════════════════════');
    diag('🧪 Diagnostic complete');
    diag('══════════════════════════════════════════');
    setTestOrderBusy(false);
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const activeStrat = strategies.find(s => s.id === activeStratId) ?? null;
  const totalPnL    = positions.reduce((acc, p) => acc + (p.upl ?? 0), 0);
  const isCFD       = accountType === 'CFD';
  const accentColor = isCFD ? 'blue' : 'purple';

  const activeScanMarkets = activeStrat
    ? (activeStrat.watchlist?.length ? activeStrat.watchlist : defaultWatchlist).filter(m => m.enabled).map(m => m.epic)
    : [];
  const scanEntries = activeScanMarkets.length > 0
    ? activeScanMarkets.map(epic => scans[epic] ?? { epic, name:(activeStrat!.watchlist?.find(m=>m.epic===epic) ?? defaultWatchlist.find(m=>m.epic===epic))?.name ?? epic, signal:null, scanning:false, status:'idle' as const })
    : Object.values(scans);

  const sizeUnit = isCFD ? 'units' : '£/pt';

  // ── Not connected ──────────────────────────────────────────────────────────
  if (!session && !connecting) {
    return (
      <div className="space-y-4 max-w-3xl p-4">
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className={clsx('w-10 h-10 rounded-xl flex items-center justify-center text-2xl', isCFD ? 'bg-blue-500/20' : 'bg-purple-500/20')}>
              {isCFD ? '📊' : '📈'}
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">{accountType} Account</h3>
              <p className="text-xs text-gray-500 font-mono">{accountId} · {env}</p>
            </div>
          </div>
          <p className="text-xs text-gray-400 mb-3">
            Not connected. Add IG credentials in{' '}
            <a href="/settings/accounts" className="text-orange-400 hover:underline">Settings → Accounts</a>{' '}
            or ensure <code className="text-xs bg-gray-800 px-1 rounded">IG_USERNAME</code> env var is set.
          </p>
          <Button size="sm" onClick={() => { setConnecting(true); connectForAccount().then(s => { if (s) storeSession(s); setConnecting(false); }); }}>Reconnect</Button>
        </Card>
      </div>
    );
  }

  if (connecting && !session) {
    return (
      <div className="flex items-center gap-3 text-gray-400 py-8 px-4">
        <RefreshCw className="h-5 w-5 animate-spin" />
        Connecting to {accountType} account {accountId}…
      </div>
    );
  }

  // ── Connected view ─────────────────────────────────────────────────────────
  return (
    <div className="space-y-4 max-w-3xl p-4">

      {/* Toast */}
      {toast && (
        <div className={clsx('flex items-center gap-2 rounded-lg px-3 py-2.5 text-xs font-medium',
          toast.ok ? 'bg-emerald-500/15 border border-emerald-500/25 text-emerald-400' : 'bg-red-500/15 border border-red-500/25 text-red-400'
        )}>
          {toast.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
          {toast.msg}
        </div>
      )}

      {/* Live trade disclaimer */}
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
            <p className="text-xs text-gray-300 mb-5">Your strategy is about to open a <span className="text-white font-semibold">real position</span> on your IG Live {accountType} account. Leveraged products can result in losses exceeding your deposit.</p>
            <div className="flex gap-2">
              <Button fullWidth variant="outline" onClick={() => { liveTradeResolveRef.current?.(false); liveTradeResolveRef.current = null; setShowLiveTradeDisclaimer(false); }}>Cancel Trade</Button>
              <Button fullWidth className="bg-red-600 hover:bg-red-500 text-white font-bold"
                onClick={() => { liveTradeAckedRef.current = true; localStorage.setItem('ig_live_first_trade_ack','1'); liveTradeResolveRef.current?.(true); liveTradeResolveRef.current = null; setShowLiveTradeDisclaimer(false); }}>
                I Understand — Trade
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Diagnostic modal */}
      {diagModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-2xl shadow-2xl flex flex-col max-h-[80vh]">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
              <h3 className="text-sm font-semibold text-white">🧪 Diagnostic — {accountType} | {accountId}</h3>
              <button onClick={() => setDiagModal(false)} className="text-gray-500 hover:text-white"><X className="h-4 w-4" /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 font-mono text-[11px] text-gray-300 space-y-0.5">
              {diagLines.map((l, i) => <p key={i} className={clsx(l.includes('✓')?'text-emerald-400':l.includes('✗')||l.includes('⚠️')?'text-red-400':'')}>{l}</p>)}
              {testOrderBusy && <p className="text-yellow-400 animate-pulse">Running…</p>}
            </div>
          </div>
        </div>
      )}

      {/* SL modal */}
      {slModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-5 w-full max-w-xs shadow-2xl">
            <h3 className="text-sm font-semibold text-white mb-3">Update Stop-Loss — {slModal.pos.instrumentName ?? slModal.pos.epic}</h3>
            <input type="number" value={slInput} onChange={e => setSlInput(e.target.value)} placeholder="Stop-loss price"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white mb-3 focus:outline-none focus:border-orange-500" />
            <div className="flex gap-2">
              <Button fullWidth variant="outline" onClick={() => { setSlModal(null); setSlInput(''); }}>Cancel</Button>
              <Button fullWidth loading={!!updatingPos} onClick={handleUpdateSL}>Update SL</Button>
            </div>
          </div>
        </div>
      )}

      {/* TP modal */}
      {tpModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-5 w-full max-w-xs shadow-2xl">
            <h3 className="text-sm font-semibold text-white mb-3">Update Take-Profit — {tpModal.pos.instrumentName ?? tpModal.pos.epic}</h3>
            <input type="number" value={tpInput} onChange={e => setTpInput(e.target.value)} placeholder="Take-profit price"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white mb-3 focus:outline-none focus:border-orange-500" />
            <div className="flex gap-2">
              <Button fullWidth variant="outline" onClick={() => { setTpModal(null); setTpInput(''); }}>Cancel</Button>
              <Button fullWidth loading={!!updatingPos} onClick={handleUpdateTP}>Update TP</Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Connection header ────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <div className={clsx('flex items-center gap-1.5 text-[10px] px-2.5 py-1 rounded-full font-medium',
            isCFD ? 'bg-blue-500/15 text-blue-400' : 'bg-purple-500/15 text-purple-400'
          )}>
            <Wifi className="h-2.5 w-2.5" />
            {accountType} · #{accountId}
            {igFundsDisplay && <span className="ml-1 opacity-80">£{igFundsDisplay.available.toFixed(0)} avail</span>}
          </div>
          <span className={clsx('text-[10px] font-mono px-1.5 py-0.5 rounded',
            rateLimitPause > 0 ? 'bg-red-500/20 text-red-400' :
            apiCallCount >= 8  ? 'bg-amber-500/20 text-amber-400' :
            'bg-gray-800 text-gray-500'
          )}>
            {rateLimitPause > 0 ? `⛔ rate-limit ${Math.ceil(rateLimitPause/1000)}s` : `${apiCallCount}/10 calls/min`}
          </span>
          <span className="text-[10px] text-gray-600 px-1.5 py-0.5 bg-gray-800/50 rounded-full">
            Signal: Yahoo · Execution: IG
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => void loadPositions()} loading={loadingPos}>Refresh</Button>
          <Button size="sm" variant="outline" loading={testOrderBusy} title="Run connection diagnostic" onClick={() => void runTestOrder()}>🧪 Diagnose</Button>
          {diagLines.length > 0 && !diagModal && <button onClick={() => setDiagModal(true)} className="text-[10px] text-blue-400 hover:underline">View last diagnostic</button>}
          <Button size="sm" variant="outline" icon={<ArrowUpDown className="h-3.5 w-3.5" />} onClick={() => { setShowManual(v => !v); setShowBuilder(false); }}>Manual</Button>
          <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => openBuilder()}>New Strategy</Button>
        </div>
      </div>

      {/* Risk warning */}
      <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 text-xs text-amber-400">
        ⚠️ {isCFD ? 'CFDs are complex leveraged instruments.' : 'Spread bets are complex instruments.'} 68% of retail accounts lose money. Use Demo first. Not financial advice.
      </div>

      {/* ── Manual trade ──────────────────────────────────────────────────── */}
      {showManual && (
        <Card>
          <CardHeader title="Manual Trade" subtitle={`Open a position on your ${accountType} account`}
            icon={<ArrowUpDown className="h-4 w-4" />}
            action={<button onClick={() => setShowManual(false)}><X className="h-4 w-4 text-gray-500 hover:text-white" /></button>}
          />
          <div className="space-y-3">
            {session && <MarketSearch session={session} env={env} onSelect={m => { setManualEpic(m.epic); setManualName(m.instrumentName); }} />}
            {manualEpic && (
              <div className="flex items-center gap-2 bg-orange-500/10 border border-orange-500/20 rounded-lg px-3 py-1.5 text-xs text-orange-300">
                <CheckCircle2 className="h-3 w-3" />
                <span className="font-semibold">{manualName}</span>
                <span className="font-mono opacity-60 text-[10px]">{manualEpic}</span>
                <button onClick={() => { setManualEpic(''); setManualName(''); }} className="ml-auto text-gray-500 hover:text-white"><X className="h-3 w-3" /></button>
              </div>
            )}
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
                <label className="text-xs text-gray-400 mb-1.5 block">{sizeUnit}</label>
                <input type="number" min={0.1} step={0.1} value={manualSize} onChange={e => setManualSize(Number(e.target.value))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-orange-500" />
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Stop (pt)</label>
                <input type="number" value={manualStop} onChange={e => setManualStop(e.target.value===''?'':Number(e.target.value))} placeholder="opt"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-orange-500" />
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1.5 block">Take Profit (pts, optional)</label>
              <input type="number" value={manualLimit} onChange={e => setManualLimit(e.target.value===''?'':Number(e.target.value))} placeholder="Leave blank for no limit"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-orange-500" />
            </div>
            {env === 'live' && <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-xs text-red-400">⚠️ This opens a REAL position on your live IG account.</div>}
            <Button fullWidth loading={placingManual} disabled={!manualEpic}
              className={manualDir==='BUY' ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-red-600 hover:bg-red-500 text-white'}
              icon={manualDir==='BUY' ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
              onClick={handleManualOpen}>
              {manualDir} {sizeUnit === '£/pt' ? `£${manualSize}/pt` : `${manualSize} unit(s)`} {manualName || (manualEpic ? `(${manualEpic})` : '— pick market')}
            </Button>
          </div>
        </Card>
      )}

      {/* ── Strategy builder ───────────────────────────────────────────────── */}
      {showBuilder && (
        <Card>
          <CardHeader title={editId ? 'Edit Strategy' : 'New Strategy'}
            subtitle={`Runs on ${accountType} account ${accountId} — epics auto-resolved`}
            icon={<Zap className="h-4 w-4" />}
            action={<button onClick={() => setShowBuilder(false)}><X className="h-4 w-4 text-gray-500 hover:text-white" /></button>}
          />
          <div className="space-y-4">
            {/* Locked account display */}
            <div className={clsx('flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium', isCFD ? 'bg-blue-500/10 text-blue-300 border border-blue-500/20' : 'bg-purple-500/10 text-purple-300 border border-purple-500/20')}>
              <span>{isCFD ? '📊' : '📈'}</span>
              Trading on: <strong>{accountType}</strong> account <code className="font-mono">{accountId}</code>
              <span className="opacity-60 ml-1">— {isCFD ? 'CFD epics used automatically' : 'Spread-bet epics used automatically'}</span>
            </div>

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
                  <option value="rsi2">⭐ RSI(2) — once/day · low API usage</option>
                  <option value="daily">Daily Swing — EMA20/50 + MACD</option>
                  <option value="longterm">Long-term — Golden/Death Cross</option>
                  <option value="hourly">Hourly Scalp — high API usage</option>
                </select>
              </div>
            </div>
            <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2 text-xs text-blue-300">
              {TIMEFRAME_CONFIG[bTimeframe].description}
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Size ({sizeUnit})</label>
                <input type="number" min={0.1} step={0.1} value={bSize} onChange={e => setBSize(Number(e.target.value))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500" />
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Max positions</label>
                <input type="number" min={1} max={20} value={bMaxPos} onChange={e => setBMaxPos(Number(e.target.value))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500" />
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Min strength</label>
                <div className="flex items-center gap-2">
                  <input type="range" min={40} max={95} step={5} value={bMinStrength} onChange={e => setBMinStrength(Number(e.target.value))} className="flex-1 accent-orange-500" />
                  <span className="text-sm font-mono text-orange-400 w-8">{bMinStrength}%</span>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between bg-gray-800/40 rounded-lg px-3 py-2.5">
              <div>
                <p className="text-xs font-medium text-white">Auto-close on reversal</p>
                <p className="text-[11px] text-gray-500">Close opposing positions when signal flips</p>
              </div>
              <button onClick={() => setBAutoClose(v => !v)}
                className={clsx('w-11 h-6 rounded-full transition-all relative flex-shrink-0', bAutoClose ? 'bg-orange-500' : 'bg-gray-700')}>
                <span className={clsx('absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all', bAutoClose ? 'left-5' : 'left-0.5')} />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Signal scan interval</label>
                <select value={bSignalScanMs} onChange={e => setBSignalScanMs(Number(e.target.value))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500">
                  <option value={5*60_000}>5 minutes</option>
                  <option value={10*60_000}>10 minutes</option>
                  <option value={15*60_000}>15 minutes</option>
                  <option value={30*60_000}>30 minutes</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Position monitor interval</label>
                <select value={bPosMonitorMs} onChange={e => setBPosMonitorMs(Number(e.target.value))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500">
                  <option value={30_000}>30 seconds</option>
                  <option value={60_000}>60 seconds</option>
                  <option value={2*60_000}>2 minutes</option>
                </select>
              </div>
            </div>

            {/* Watchlist */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-gray-400">Markets to scan</label>
                <span className="text-[10px] text-gray-600">{bWatchlist.filter(m=>m.enabled).length} enabled</span>
              </div>
              <div className="space-y-1 max-h-56 overflow-y-auto border border-gray-800 rounded-lg divide-y divide-gray-800/50">
                {bWatchlist.map((m, i) => (
                  <div key={m.epic} className="flex items-center justify-between px-3 py-2 gap-2">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <button onClick={() => setBWatchlist(p => p.map((x,xi) => xi===i ? {...x,enabled:!x.enabled} : x))}
                        className={clsx('w-4 h-4 rounded flex items-center justify-center flex-shrink-0 transition-all', m.enabled ? 'bg-orange-500' : 'bg-gray-700 border border-gray-600')}>
                        {m.enabled && <span className="text-white text-[8px] font-bold">✓</span>}
                      </button>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-white font-medium">{m.name}</p>
                        <p className="text-[10px] text-gray-500 font-mono truncate">
                          {epicForAccount(m.name, accountType) ?? m.epic}
                          {epicForAccount(m.name, accountType) && epicForAccount(m.name, accountType) !== m.epic && (
                            <span className="text-green-600 ml-1">✓ resolved</span>
                          )}
                        </p>
                      </div>
                    </div>
                    <button onClick={() => setBWatchlist(p => p.map((x,xi) => xi===i ? {...x,forceOpen:!x.forceOpen} : x))}
                      className={clsx('text-[9px] px-1.5 py-0.5 rounded border flex-shrink-0 transition-all font-semibold',
                        m.forceOpen ? 'bg-orange-500/25 text-orange-400 border-orange-500/40' : 'bg-gray-800 text-gray-600 border-gray-700 hover:text-gray-400')}>
                      {m.forceOpen ? 'FORCE' : 'signal'}
                    </button>
                    <button onClick={() => setBWatchlist(p => p.filter((_,xi) => xi!==i))} className="text-gray-600 hover:text-red-400"><X className="h-3 w-3" /></button>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex gap-2 flex-wrap">
                {isCFD && (
                  <button onClick={() => setBWatchlist(p => { const ex = new Set(p.map(x=>x.epic)); return [...p, ...CFD_WATCHLIST.filter(m=>!ex.has(m.epic))]; })}
                    className="text-[10px] px-2.5 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-gray-400 hover:text-white transition-colors">
                    + Add CFD stocks &amp; indices
                  </button>
                )}
                <button onClick={() => setBWatchlist([...defaultWatchlist])}
                  className="text-[10px] px-2.5 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-gray-400 hover:text-white transition-colors">
                  Reset to defaults
                </button>
                {session && (
                  <div className="w-full mt-1">
                    <p className="text-[10px] text-gray-500 mb-1.5">Add any market:</p>
                    <MarketSearch session={session} env={env} onSelect={m => { if (!bWatchlist.some(x=>x.epic===m.epic)) setBWatchlist(p=>[...p,{epic:m.epic,name:m.instrumentName,enabled:true}]); }} />
                  </div>
                )}
              </div>
            </div>

            {env === 'live' && <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-xs text-red-400">⚠️ Auto-trading on LIVE will open real positions with real money.</div>}
            <Button fullWidth icon={<Save className="h-4 w-4" />} onClick={handleSave}>{editId ? 'Update Strategy' : 'Save Strategy'}</Button>
          </div>
        </Card>
      )}

      {/* ── Strategies list ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Strategies"
          subtitle={`${accountType} account — ${strategies.length} saved`}
          icon={<Zap className="h-4 w-4" />}
          action={
            <div className="flex items-center gap-2">
              {isRunning && signalCountdown && <span className="text-[10px] text-gray-500 font-mono">next scan {signalCountdown}</span>}
              {isRunning && posCountdown    && <span className="text-[10px] text-gray-500 font-mono">pos check {posCountdown}</span>}
              {scanProgress && <span className="text-[10px] text-orange-400 animate-pulse">{scanProgress}</span>}
            </div>
          }
        />
        {strategies.length === 0 ? (
          <div className="text-center py-6 text-gray-600 text-sm">No strategies yet — create one above</div>
        ) : (
          <div className="space-y-2">
            {strategies.map(strat => {
              const isActive = strat.id === activeStratId;
              return (
                <div key={strat.id} className={clsx('border rounded-xl p-3 transition-all cursor-pointer',
                  isActive ? (isCFD ? 'border-blue-500/40 bg-blue-500/5' : 'border-purple-500/40 bg-purple-500/5') : 'border-gray-800 bg-gray-900/50 hover:border-gray-700'
                )} onClick={() => setActiveStratId(strat.id === activeStratId ? null : strat.id)}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <div className={clsx('w-2 h-2 rounded-full flex-shrink-0', isActive && isRunning ? 'bg-emerald-500 animate-pulse' : isActive ? (isCFD?'bg-blue-500':'bg-purple-500') : 'bg-gray-600')} />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-white truncate">{strat.name}</p>
                        <p className="text-[10px] text-gray-500">
                          {strat.timeframe} · {strat.size}{sizeUnit} · min {strat.minStrength}% · max {strat.maxPositions} pos
                          {strat.lastRunAt && ` · last run ${fmtTime(strat.lastRunAt)}`}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {isActive && !isRunning && !testRunning && (
                        <>
                          <Button size="sm" variant="outline" icon={<Play className="h-3 w-3" />}
                            onClick={e => { e.stopPropagation(); startAutoRun(strat); }}>Start</Button>
                          <Button size="sm" variant="outline" icon={<Activity className="h-3 w-3" />}
                            loading={testRunning}
                            onClick={e => { e.stopPropagation(); void runTestScan(strat); }}>Test</Button>
                        </>
                      )}
                      {isActive && isRunning && (
                        <Button size="sm" className="bg-red-600/20 text-red-400 border border-red-600/30 hover:bg-red-600/30"
                          icon={<Square className="h-3 w-3" />}
                          onClick={e => { e.stopPropagation(); stopAutoRun(); }}>Stop</Button>
                      )}
                      <button onClick={e => { e.stopPropagation(); openBuilder(strat); }} className="p-1.5 rounded text-gray-500 hover:text-white hover:bg-gray-800"><Edit2 className="h-3.5 w-3.5" /></button>
                      <button onClick={e => { e.stopPropagation(); if (strat.id === activeStratId && isRunning) stopAutoRun(); deleteStrategy(strat.id); setStrategies(loadStrategiesForAccount()); if (strat.id === activeStratId) setActiveStratId(null); }}
                        className="p-1.5 rounded text-gray-600 hover:text-red-400 hover:bg-gray-800"><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* ── Market scanner ─────────────────────────────────────────────────── */}
      {scanEntries.length > 0 && (
        <Card>
          <CardHeader title="Market Scanner" subtitle={`${accountType} epics · Yahoo Finance signals`} icon={<Target className="h-4 w-4" />} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {scanEntries.map(entry => (
              <div key={entry.epic} className={clsx('border rounded-lg p-2.5 text-xs',
                entry.status === 'error' ? 'border-red-900/40 bg-red-950/20' :
                entry.scanning ? 'border-gray-700 bg-gray-900/50 animate-pulse' :
                entry.signal?.direction === 'BUY'  ? 'border-emerald-900/40 bg-emerald-950/20' :
                entry.signal?.direction === 'SELL' ? 'border-red-900/40 bg-red-950/20' :
                'border-gray-800 bg-gray-900/30'
              )}>
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold text-white truncate mr-1">{entry.name}</span>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {entry.scanning && <RefreshCw className="h-2.5 w-2.5 animate-spin text-gray-400" />}
                    {entry.signal && <DirectionBadge dir={entry.signal.direction} size="xs" />}
                  </div>
                </div>
                <p className="text-[10px] font-mono text-gray-600 truncate mb-1">
                  {epicForAccount(entry.name, accountType) ?? entry.epic}
                </p>
                {entry.status === 'error' && <p className="text-red-400 text-[10px] truncate">{entry.error}</p>}
                {entry.signal && (
                  <div className="flex items-center gap-2">
                    <StrengthBar strength={entry.signal.strength} dir={entry.signal.direction} />
                    <span className={clsx('font-mono', entry.signal.direction==='BUY'?'text-emerald-400':entry.signal.direction==='SELL'?'text-red-400':'text-gray-500')}>{entry.signal.strength}%</span>
                    {entry.changePercent !== undefined && (
                      <span className={clsx('ml-auto', entry.changePercent>=0?'text-emerald-400':'text-red-400')}>
                        {entry.changePercent>=0?'+':''}{entry.changePercent.toFixed(2)}%
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── Positions / Orders / History ───────────────────────────────────── */}
      <Card>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="flex gap-1">
            {(['positions','orders','history'] as const).map(tab => (
              <button key={tab} onClick={() => setPosTab(tab)}
                className={clsx('px-3 py-1.5 rounded-lg text-xs font-medium transition-all',
                  posTab === tab ? (isCFD?'bg-blue-500/20 text-blue-300':'bg-purple-500/20 text-purple-300') : 'text-gray-500 hover:text-gray-300'
                )}>
                {tab === 'positions' ? `Positions (${positions.length})` : tab === 'orders' ? `Orders (${workingOrders.length})` : 'History'}
              </button>
            ))}
          </div>
          {positions.length > 0 && (
            <div className={clsx('text-xs font-medium px-2 py-1 rounded', totalPnL >= 0 ? 'text-emerald-400 bg-emerald-500/10' : 'text-red-400 bg-red-500/10')}>
              P&L {totalPnL >= 0 ? '+' : ''}{fmt(totalPnL)}
            </div>
          )}
        </div>

        {posError && <div className="mb-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">{posError}</div>}

        {posTab === 'positions' && (
          positions.length === 0
            ? <p className="text-center py-6 text-gray-600 text-sm">No open positions on {accountType} account</p>
            : <div className="space-y-2">
                {positions.map(pos => (
                  <div key={pos.dealId} className="border border-gray-800 rounded-xl p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <DirectionBadge dir={pos.direction} />
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-white truncate">{pos.instrumentName ?? pos.epic}</p>
                          <p className="text-[10px] text-gray-500 font-mono">{pos.epic} · {pos.size}{sizeUnit}</p>
                        </div>
                      </div>
                      <div className={clsx('text-xs font-mono font-bold', pos.upl >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                        {pos.upl >= 0 ? '+' : ''}{fmt(pos.upl)}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-gray-500 flex-wrap">
                      <span>Entry {pos.level}</span>
                      {pos.stopLevel  && <span className="text-red-400/70">SL {pos.stopLevel}</span>}
                      {pos.limitLevel && <span className="text-emerald-400/70">TP {pos.limitLevel}</span>}
                      {pos.createdDate && <span><Clock className="inline h-2.5 w-2.5 mr-0.5" />{fmtTime(pos.createdDate)}</span>}
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <Button size="sm" variant="outline" onClick={() => { setSlModal({pos}); setSlInput(pos.stopLevel?.toString()??''); }}
                        className="text-[10px] px-2 py-1 h-auto">SL</Button>
                      <Button size="sm" variant="outline" onClick={() => { setTpModal({pos}); setTpInput(pos.limitLevel?.toString()??''); }}
                        className="text-[10px] px-2 py-1 h-auto">TP</Button>
                      <Button size="sm" variant="outline" loading={reversingPos === pos.dealId}
                        onClick={() => void reversePosition(pos)}
                        className="text-[10px] px-2 py-1 h-auto">Reverse</Button>
                      <Button size="sm" loading={closingId === pos.dealId}
                        className="text-[10px] px-2 py-1 h-auto bg-red-600/20 text-red-400 border border-red-600/30 hover:bg-red-600/30"
                        onClick={() => void handleClose(pos)}>Close</Button>
                    </div>
                  </div>
                ))}
              </div>
        )}

        {posTab === 'orders' && (
          workingOrders.length === 0
            ? <p className="text-center py-6 text-gray-600 text-sm">No working orders</p>
            : <div className="space-y-2">
                {workingOrders.map(ord => (
                  <div key={ord.dealId} className="border border-gray-800 rounded-xl p-3 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <DirectionBadge dir={ord.direction} />
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-white truncate">{ord.instrumentName ?? ord.epic}</p>
                        <p className="text-[10px] text-gray-500 font-mono">{ord.orderType} @ {ord.level} · {ord.size}{sizeUnit}</p>
                      </div>
                    </div>
                    <Button size="sm" loading={cancellingOrder === ord.dealId}
                      className="text-[10px] px-2 py-1 h-auto bg-red-600/20 text-red-400 border border-red-600/30"
                      onClick={() => void cancelWorkingOrder(ord.dealId)}>Cancel</Button>
                  </div>
                ))}
              </div>
        )}

        {posTab === 'history' && (
          tradeHistory.length === 0
            ? <p className="text-center py-6 text-gray-600 text-sm">No trade history yet</p>
            : <div className="space-y-1.5 max-h-72 overflow-y-auto">
                {tradeHistory.slice(0,50).map(t => (
                  <div key={t.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-[10px] border border-gray-800/50">
                    <DirectionBadge dir={t.direction} size="xs" />
                    <span className="text-white font-medium truncate flex-1">{t.market}</span>
                    <span className={clsx('font-semibold', t.status==='OPEN'?'text-blue-400':t.status==='REJECTED'?'text-red-400':t.pnl!=null&&t.pnl>=0?'text-emerald-400':'text-red-400')}>
                      {t.status==='OPEN'?'OPEN':t.status==='REJECTED'?'REJ':t.pnl!=null?`${t.pnl>=0?'+':''}${fmt(t.pnl)}`:'—'}
                    </span>
                    <span className="text-gray-600">{fmtTime(t.openedAt)}</span>
                  </div>
                ))}
              </div>
        )}
      </Card>

      {/* ── Activity log ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Activity Log"
          subtitle={`${accountType} | ${accountId}`}
          icon={<Activity className="h-4 w-4" />}
          action={
            <div className="flex items-center gap-2">
              <span className={clsx('text-[10px] font-mono px-1.5 py-0.5 rounded',
                rateLimitPause > 0 ? 'bg-red-500/20 text-red-400' :
                apiCallCount >= 8  ? 'bg-amber-500/20 text-amber-400' :
                'bg-gray-800/60 text-gray-500'
              )}>
                {rateLimitPause > 0 ? `⛔ rate-limit ${Math.ceil(rateLimitPause/1000)}s` : `${apiCallCount}/10 calls/min`}
              </span>
              <button onClick={() => setRunLog([])} className="text-[10px] text-gray-600 hover:text-gray-400">Clear</button>
            </div>
          }
        />
        <div className="space-y-0.5 max-h-64 overflow-y-auto font-mono">
          {runLog.length === 0
            ? <p className="text-gray-600 text-xs py-3 text-center">No activity yet</p>
            : runLog.map(entry => (
                <div key={entry.id} className={clsx('flex gap-2 text-[10px] py-0.5 border-b border-gray-800/30 last:border-0',
                  entry.type === 'buy'    ? 'text-emerald-400' :
                  entry.type === 'sell'   ? 'text-red-400' :
                  entry.type === 'close'  ? 'text-orange-400' :
                  entry.type === 'signal' ? 'text-blue-400' :
                  entry.type === 'error'  ? 'text-red-400/80' :
                  'text-gray-500'
                )}>
                  <span className="text-gray-700 flex-shrink-0">{fmtTime(entry.ts)}</span>
                  <span className="break-all">{entry.msg}</span>
                </div>
              ))
          }
        </div>
      </Card>
    </div>
  );
}

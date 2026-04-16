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
  spreadbetSignalFromIndicators,
} from '@/lib/igStrategyEngine';
import {
  type AccountType,
  epicForAccount, toCfdEpic, toSpreadbetEpic,
  getStopDistances, MIN_STRENGTH,
} from '@/lib/igConfig';
import { igQueue } from '@/lib/igApiQueue';
import {
  type FinnhubCategory, CATEGORY_LABELS as FINNHUB_CATEGORY_LABELS,
  toIgEpic, toYahooSymbol,
} from '@/lib/finnhubConfig';

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

const SESSION_TTL_MS    = 6 * 60 * 60 * 1000;  // 6 hours — only re-login after this
const LOGIN_BACKOFF_MS  = [10_000, 30_000, 60_000] as const; // 10s, 30s, 60s

// Module-level login lock — one promise per (env+accountId) key, shared across renders
const loginLocks = new Map<string, Promise<IGSession|null>>();

function uid() { return Math.random().toString(36).slice(2, 9); }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function fmt(n: number) { return `£${Math.abs(n).toFixed(2)}`; }
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
}

// riskPct: fraction of available to risk per trade (default 2%)
// totalBalance: used to cap any single trade at 5% of total equity (pass 0 to skip cap)
function calcRiskBasedSize(
  available: number,
  stopDist: number,
  acctType: 'CFD' | 'SPREADBET',
  requestedSize: number,
  sizeMultiplier = 1.0,
  riskPct = 0.02,
  totalBalance = 0,
): number {
  if (available < 100) return 0;
  let size: number;
  if (acctType === 'CFD') {
    const riskAmount = available * riskPct;
    // Never risk more than 5% of total balance on one trade
    const cappedRisk = totalBalance > 0 ? Math.min(riskAmount, totalBalance * 0.05) : riskAmount;
    size = stopDist > 0 ? cappedRisk / stopDist : requestedSize;
  } else {
    if (available < 500) return 0.1;
    const pctBased = Math.floor((available * Math.min(riskPct * 2.5, 0.05)) * 10) / 10;
    size = Math.min(requestedSize, Math.max(0.1, pctBased));
  }
  size *= sizeMultiplier;
  return Math.max(0.1, Math.round(size * 10) / 10);
}

/**
 * Determine the correct currency for an IG order.
 * US stocks (no exchange suffix) → USD. UK stocks (.L) → GBP.
 * US indices / Gold / Oil → USD. FTSE → GBP.
 */
function orderCurrency(symbol: string, epic: string): string {
  // US stock CFD epic: UA.D.AAPL.CASH.IP
  if (epic.startsWith('UA.D.')) {
    // Extract the ticker and check for known UK patterns
    const ticker = epic.match(/^UA\.D\.([^.]+)\./)?.[1] ?? '';
    if (ticker.endsWith('L') && ticker.length > 2) return 'GBP'; // e.g. BARCL
    return 'USD';
  }
  // Spread-bet / CFD index epics
  if (epic.includes('FTSE') || epic.includes('UKX')) return 'GBP';
  if (epic.includes('GSPC') || epic.includes('NDX') || epic.includes('DJI') ||
      epic.includes('SPX')  || epic.includes('NAS') || epic.includes('DOW')) return 'USD';
  // Symbol-based heuristic (Finnhub symbol passed as market.name)
  const sym = symbol.toUpperCase();
  if (sym.endsWith('.L'))  return 'GBP';
  if (sym.endsWith('.DE') || sym.endsWith('.PA') || sym.endsWith('.AMS')) return 'EUR';
  // Plain ticker (AAPL, TSLA, INTC etc.) = US stock = USD
  if (/^[A-Z]{1,5}$/.test(sym)) return 'USD';
  // Gold, Oil, commodities trade in USD
  if (epic.includes('GOLD') || epic.includes('CRUDE') || epic.includes('OIL') ||
      epic.includes('SILVER') || epic.includes('NATGAS')) return 'USD';
  return 'GBP'; // safe fallback
}

/** CFD position size in units, based on instrument price tier. */
function calcCfdUnits(price: number, mType?: MarketType): number {
  if (mType === 'INDEX' || mType === 'COMMODITY' || mType === 'FOREX') return 1;
  if (price <= 50)  return 5;
  if (price <= 200) return 2;
  return 1;
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
  const sessionRef      = useRef<IGSession|null>(null);
  const sessionReadyRef = useRef(false);   // true once at least one confirmed-live session stored
  const tradeLockRef    = useRef(false);
  const lastReauthRef   = useRef(0);
  // Per-session epic validation cache — avoids repeating GET /markets/{epic} for known-good epics
  const epicValidRef    = useRef<Record<string, boolean>>({});
  // Persistent IG epic resolution cache: Finnhub symbol → actual IG epic (or null = not available)
  // Pre-seeded with confirmed-working CFD epics; persisted to localStorage across sessions
  const igEpicCacheRef = useRef<Record<string, string | null>>(
    (() => {
      const seed: Record<string, string> = {
        TSLA: 'UA.D.TSLA.CASH.IP', AAPL: 'UA.D.AAPL.CASH.IP', MSFT: 'UA.D.MSFT.CASH.IP',
        AMZN: 'UA.D.AMZN.CASH.IP', NVDA: 'UA.D.NVDA.CASH.IP', META: 'UA.D.META.CASH.IP',
        GOOGL: 'UA.D.GOOGL.CASH.IP', GOOG: 'UA.D.GOOGL.CASH.IP',
      };
      try {
        const stored = localStorage.getItem('ig_epic_cache');
        return { ...seed, ...(stored ? JSON.parse(stored) as Record<string, string|null> : {}) };
      } catch { return { ...seed }; }
    })(),
  );
  // Login backoff state
  const loginFailCountRef    = useRef(0);
  const loginBlockedUntilRef = useRef(0);
  const [loginCooldown, setLoginCooldown] = useState<string>('');

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
  const [scanStats, setScanStats]       = useState<{
    scanned:number; signals:number; traded:number;
    skippedVolatile:number; skippedConditions:number; lastScanAt:string;
  }|null>(null);
  // Mutable scan context — set at the start of each signal scan cycle
  const scanParamsRef   = useRef({ sizeMultiplier: 1.0, confidenceBoost: 0, sectorAdjust: 0 });
  const scanCountersRef = useRef({ traded: 0, skippedVolatile: 0, skippedConditions: 0 });

  // ── Funds ──────────────────────────────────────────────────────────────────
  const igFundsRef = useRef<{available:number;balance:number}|null>(null);
  const [igFundsDisplay, setIgFundsDisplay] = useState<{available:number;balance:number}|null>(null);
  // Snapshot of balance at strategy start — used for fund-level-based sizing and pause logic
  const startingBalanceRef = useRef<number>(0);

  // ── Timers ─────────────────────────────────────────────────────────────────
  const [signalScanMs, setSignalScanMs] = useState(60_000);    // default 60s
  const [posMonitorMs, setPosMonitorMs] = useState(30_000);    // default 30s
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

  // ── Performance tracking (Part 7) ─────────────────────────────────────────
  const performancePausedRef = useRef(false); // auto-set when win rate < 40%
  const [perfPauseAlert, setPerfPauseAlert] = useState<string|null>(null);

  // ── UI state ───────────────────────────────────────────────────────────────
  const [posTab, setPosTab] = useState<'positions'|'orders'|'history'|'stats'>('positions');
  const [runLog, setRunLog] = useState<RunLog[]>([]);
  const [toast, setToast]   = useState<{ok:boolean;msg:string}|null>(null);

  // ── Builder ────────────────────────────────────────────────────────────────
  const [showBuilder, setShowBuilder]     = useState(false);
  const [editId, setEditId]               = useState<string|null>(null);
  const [bName, setBName]                 = useState('');
  const [bTimeframe, setBTimeframe]       = useState<Timeframe>('daily');
  const [bSize, setBSize]                 = useState(1);
  const [bMaxPos, setBMaxPos]             = useState(0);        // 0 = unlimited
  const [bMinStrength, setBMinStrength]   = useState(55);
  const [bAutoClose, setBAutoClose]       = useState(true);
  const [bWatchlist, setBWatchlist]       = useState<WatchlistMarket[]>([...defaultWatchlist]);
  const [bSignalScanMs, setBSignalScanMs] = useState(60_000);   // default 60s
  const [bPosMonitorMs, setBPosMonitorMs] = useState(30_000);   // default 30s

  // ── Dynamic market navigator (CFD) ────────────────────────────────────────
  type IGNavNode    = { id: string; name: string };
  type IGNavMarket  = { epic: string; instrumentName: string; instrumentType: string };
  type IGNavCategory = { node: IGNavNode; markets: IGNavMarket[]; subNodes: IGNavNode[]; expanded: boolean };
  const [navCategories, setNavCategories]       = useState<IGNavCategory[]>([]);
  const [navLoading, setNavLoading]             = useState(false);
  const [navLoaded, setNavLoaded]               = useState(false);
  const [navSelectedEpics, setNavSelectedEpics] = useState<Set<string>>(new Set());

  // ── Finnhub scanner ────────────────────────────────────────────────────────
  type FinnhubRow = {
    symbol: string; description: string; category: FinnhubCategory;
    price: number; changePercent: number;
    igEpic: string | null; yahooSymbol: string | null;
    // indicators (filled in after Yahoo fetch)
    rsi14?: number; emaCross?: string; macdHistogram?: number;
    bullScore?: number; bearScore?: number; confidenceScore?: number;
    direction?: 'BUY' | 'SELL' | 'NEUTRAL';
    atr14?: number; yahooPrice?: number; vwapDeviation?: number;
    // analyst
    analystBullScore?: number;
    loading?: boolean; error?: string;
  };
  const [finnhubCategory, setFinnhubCategory]   = useState<FinnhubCategory>('US_STOCK');
  const [finnhubRows, setFinnhubRows]           = useState<FinnhubRow[]>([]);
  const [finnhubLoading, setFinnhubLoading]     = useState(false);
  const [finnhubLastScan, setFinnhubLastScan]   = useState<string>('');
  const [finnhubSearch, setFinnhubSearch]       = useState<string>('');
  const [finnhubSearchBusy, setFinnhubSearchBusy] = useState(false);
  // Pinned instruments — persisted across sessions, always scanned
  const [pinnedInstruments, setPinnedInstruments] = useState<FinnhubRow[]>(() => {
    try { return JSON.parse(typeof window !== 'undefined' ? (localStorage.getItem('ig_cfd_pinned') ?? '[]') : '[]') as FinnhubRow[]; } catch { return []; }
  });
  // Track recently scanned Finnhub symbols (for discovery expansion)
  const recentlyScannedRef = useRef<Set<string>>(new Set());

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

  // ── Inline SL/TP editing ───────────────────────────────────────────────────
  const [inlineSLEdit, setInlineSLEdit] = useState<Record<string, string>>({});
  const [inlineTPEdit, setInlineTPEdit] = useState<Record<string, string>>({});

  // ── Trailing stops ─────────────────────────────────────────────────────────
  const [trailingStops, setTrailingStops] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('ig_trailing_stops') ?? '[]') as string[]); } catch { return new Set(); }
  });
  const trailingBestPriceRef = useRef<Record<string, number>>({});

  // ── Position health ────────────────────────────────────────────────────────
  type PositionHealth = 'green' | 'amber' | 'red';
  const [positionHealth, setPositionHealth] = useState<Record<string, PositionHealth>>({});

  // ── Close all ─────────────────────────────────────────────────────────────
  const [showCloseAllConfirm, setShowCloseAllConfirm] = useState(false);
  const [closingAll, setClosingAll] = useState(false);

  // ── Portfolio management ───────────────────────────────────────────────────
  const peakPortfolioRef   = useRef<number>(0);  // highest portfolio value seen
  const portfolioAdjRef    = useRef({ sizeMultiplier: 1.0, extraMinStrength: 0 });

  // ── Helpers ────────────────────────────────────────────────────────────────

  function showToast(ok: boolean, msg: string) {
    setToast({ ok, msg });
    setTimeout(() => setToast(null), 4000);
  }

  function log(type: RunLog['type'], msg: string) {
    setRunLog(p => [{ id: uid(), ts: new Date().toISOString(), type, msg }, ...p].slice(0, 200));
  }

  const acctTag = ` [${accountType} | ${accountId}]`;

  // ── Position health scorer ─────────────────────────────────────────────────
  function computePositionHealth(
    pos: IGPosition,
    ind: IndicatorResult | null,
    pnlPct: number,
  ): PositionHealth {
    if (!ind) return pnlPct > 0.5 ? 'green' : pnlPct < -1 ? 'red' : 'amber';
    const dirAligned =
      (pos.direction === 'BUY'  && ind.direction !== 'SELL') ||
      (pos.direction === 'SELL' && ind.direction !== 'BUY');
    const rsiCritical =
      (pos.direction === 'BUY'  && ind.rsi14 > 70) ||
      (pos.direction === 'SELL' && ind.rsi14 < 30);
    const rsiWeak =
      (pos.direction === 'BUY'  && ind.rsi14 > 60) ||
      (pos.direction === 'SELL' && ind.rsi14 < 40);
    const macdAgainst =
      (pos.direction === 'BUY'  && ind.macdCross === 'bearish') ||
      (pos.direction === 'SELL' && ind.macdCross === 'bullish');
    if (!dirAligned && rsiCritical) return 'red';
    if (!dirAligned || (rsiWeak && macdAgainst)) return 'amber';
    if (pnlPct < -2) return 'red';
    if (pnlPct < 0 && rsiWeak) return 'amber';
    return 'green';
  }

  // ── Score a position (0=weakest, 100=strongest) for capital-freeing decisions ─
  function scorePositionStrength(
    pos: IGPosition,
    ind: IndicatorResult | null,
    pnlPct: number,
  ): number {
    let score = 50;
    // Profitability
    if (pnlPct > 2) score += 20; else if (pnlPct > 0) score += 10;
    else if (pnlPct < -1) score -= 20; else if (pnlPct < 0) score -= 10;
    // Age penalty
    const ageHrs = pos.createdDate ? (Date.now() - new Date(pos.createdDate).getTime()) / 3_600_000 : 0;
    if (ageHrs > 48) score -= 20; else if (ageHrs > 24) score -= 10;
    // Momentum
    if (ind) {
      const aligned = (pos.direction === 'BUY' && ind.direction !== 'SELL') ||
                      (pos.direction === 'SELL' && ind.direction !== 'BUY');
      score += aligned ? 15 : -15;
      const rsiWeak = (pos.direction === 'BUY' && ind.rsi14 > 60) || (pos.direction === 'SELL' && ind.rsi14 < 40);
      if (rsiWeak) score -= 10;
      const macdAgainst = (pos.direction === 'BUY' && ind.macdCross === 'bearish') || (pos.direction === 'SELL' && ind.macdCross === 'bullish');
      if (macdAgainst) score -= 10;
    }
    return Math.max(0, Math.min(100, score));
  }

  function storeSession(sess: IGSession) {
    sessionRef.current = sess;
    sessionReadyRef.current = true;
    setSession(sess);
    localStorage.setItem(`ig_session_${accountId}`, JSON.stringify({ ...sess, authenticatedAt: Date.now() }));
  }

  function loadStrategiesForAccount(): IGSavedStrategy[] {
    return loadStrategies().filter(s => !s.accountId || s.accountId === accountId);
  }

  // ── connectForAccount ─────────────────────────────────────────────────────
  // Never calls IG login if a valid cached token exists.
  // If a login is already in progress, waits for it rather than starting a second one.
  // Uses exponential backoff after failures; blocks after 3 consecutive failures.
  async function connectForAccount(forceRefresh = false): Promise<IGSession|null> {
    const credKey  = env === 'demo' ? 'ig_demo_credentials' : 'ig_live_credentials';
    const sessKey  = `ig_session_${accountId}`;
    const lockKey  = `${env}:${accountId}`;

    // ── 1. Return cached session immediately if still valid ────────────────
    if (!forceRefresh) {
      try {
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
      } catch {}
    }

    // ── 2. Honour backoff block ────────────────────────────────────────────
    const blockedMs = loginBlockedUntilRef.current - Date.now();
    if (blockedMs > 0) {
      const secs = Math.ceil(blockedMs / 1000);
      const msg  = `IG API cooldown — please wait ${secs}s before reconnecting`;
      setLoginCooldown(msg);
      log('error', `🚫 ${msg}`);
      return null;
    }

    // ── 3. Login lock — coalesce parallel calls into one ──────────────────
    const existing = loginLocks.get(lockKey);
    if (existing) {
      return existing;  // already logging in — wait for the same promise
    }

    const loginPromise = (async (): Promise<IGSession|null> => {
      const raw = localStorage.getItem(credKey);
      let authBody: Record<string, unknown>;
      if (raw) {
        const c = JSON.parse(raw) as { username:string; password:string; apiKey:string; connected?:boolean };
        if (!c.connected) return null;
        authBody = { username:c.username, password:c.password, apiKey:c.apiKey, env, forceRefresh: true, targetAccountId: accountId };
      } else {
        authBody = { env, forceRefresh: true, useEnvCredentials: true, targetAccountId: accountId };
      }

      try {
        const r = await igQueue.enqueue(
          () => fetch('/api/ig/session', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(authBody) }),
          accountId,
        );
        const d = await r.json() as { ok:boolean; cst?:string; securityToken?:string; accountId?:string; accountType?:string; apiKey?:string; error?:string };

        if (d.ok && d.cst && d.securityToken) {
          // Success — reset backoff
          loginFailCountRef.current = 0;
          loginBlockedUntilRef.current = 0;
          setLoginCooldown('');
          const apiKey = d.apiKey || (raw ? (JSON.parse(raw) as { apiKey:string }).apiKey : '') || '';
          const sess: IGSession = { cst:d.cst, securityToken:d.securityToken, accountId:d.accountId ?? accountId, apiKey, accountType:d.accountType ?? accountType };
          localStorage.setItem(sessKey, JSON.stringify({ ...sess, authenticatedAt: Date.now() }));
          return sess;
        }

        // Failed — apply backoff
        const attempt = loginFailCountRef.current;
        loginFailCountRef.current = attempt + 1;
        if (attempt < LOGIN_BACKOFF_MS.length) {
          const wait = LOGIN_BACKOFF_MS[attempt];
          loginBlockedUntilRef.current = Date.now() + wait;
          const msg = `Login failed (attempt ${attempt + 1}/3) — waiting ${wait / 1000}s. ${d.error ?? ''}`;
          setLoginCooldown(msg);
          log('error', `⏳ ${msg}`);
        } else {
          loginBlockedUntilRef.current = Date.now() + 5 * 60_000; // 5 min hard block
          const msg = 'IG API cooldown — please wait a few minutes before reconnecting';
          setLoginCooldown(msg);
          log('error', `🚫 ${msg}`);
        }
        return null;
      } catch {
        return null;
      } finally {
        loginLocks.delete(lockKey);
      }
    })();

    loginLocks.set(lockKey, loginPromise);
    return loginPromise;
  }

  // ── freshSession: use stored token or trigger a login if truly expired ────
  async function freshSession(): Promise<IGSession|null> {
    try {
      const raw = localStorage.getItem(`ig_session_${accountId}`);
      if (raw) {
        const meta = JSON.parse(raw) as { authenticatedAt?:number };
        if (meta.authenticatedAt && (Date.now() - meta.authenticatedAt) >= SESSION_TTL_MS) {
          // Token genuinely expired — clear and re-login
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
    // Wait for at least one confirmed session before polling
    if (!sessionReadyRef.current || !sessionRef.current) return;
    const sess = sessionRef.current;
    setLoadingPos(true); setPosError(null);
    try {
      let r = await igQueue.enqueue(() => fetch('/api/ig/positions', { headers: makeHeaders(sess, env) }), accountId);
      if (r.status === 403) {
        setPosError('Rate limited — retrying next cycle'); setLoadingPos(false); return;
      }
      if (r.status === 401) {
        // Silent re-auth: don't show error until retry also fails
        if (Date.now() - lastReauthRef.current < 30_000) { setLoadingPos(false); return; }
        lastReauthRef.current = Date.now();
        localStorage.removeItem(`ig_session_${accountId}`);
        const fresh = await connectForAccount(true);
        if (!fresh) { setPosError('Session expired — reconnect in Settings'); setLoadingPos(false); return; }
        storeSession(fresh);
        const freshSess = fresh;
        r = await igQueue.enqueue(() => fetch('/api/ig/positions', { headers: makeHeaders(freshSess, env) }), accountId);
        // If retry also 401, show error; otherwise fall through to parse positions
        if (r.status === 401) { setPosError('Re-auth failed — please reconnect'); setLoadingPos(false); return; }
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
      const r = await igQueue.enqueue(() => fetch('/api/ig/account', { headers: { ...makeHeaders(sess, env), 'x-ig-account-id': accountId } }), accountId);
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

  // ── Validate epic on this account (SPREADBET path only) ────────────────────
  async function validateEpic(epic: string): Promise<boolean> {
    if (epicValidRef.current[epic] !== undefined) return epicValidRef.current[epic];
    const sess = sessionRef.current;
    if (!sess) return true; // can't validate, allow the attempt
    try {
      const r = await igQueue.enqueue(
        () => fetch(`/api/ig/markets/${encodeURIComponent(epic)}`, { headers: makeHeaders(sess, env) }),
        accountId,
      );
      const valid = r.ok;
      epicValidRef.current[epic] = valid;
      return valid;
    } catch {
      return true; // network error — allow the attempt
    }
  }

  // ── Part 4: Trading session check (spread-bet only) ───────────────────────
  // London session: 08:00–16:30 GMT. Avoid last 30 min before close (16:00).
  // Outside these hours: low liquidity, erratic moves.
  function tradingSessionCheck(): { allowed: boolean; reason: string } {
    const now   = new Date();
    const gmtH  = now.getUTCHours();
    const gmtM  = now.getUTCMinutes();
    const mins  = gmtH * 60 + gmtM;

    const londonOpen  = 8  * 60;       // 08:00 GMT
    const londonClose = 16 * 60 + 30;  // 16:30 GMT
    const noNewPos    = 16 * 60;       // 16:00 GMT — no new positions in last 30 min

    if (mins < londonOpen)  return { allowed: false, reason: `Pre-market (${gmtH.toString().padStart(2,'0')}:${gmtM.toString().padStart(2,'0')} GMT) — London opens 08:00` };
    if (mins >= londonClose) return { allowed: false, reason: `Post-market (${gmtH.toString().padStart(2,'0')}:${gmtM.toString().padStart(2,'0')} GMT) — resumes 08:00` };
    if (mins >= noNewPos)   return { allowed: false, reason: `Last 30 min before close (${gmtH.toString().padStart(2,'0')}:${gmtM.toString().padStart(2,'0')} GMT) — no new positions` };

    const inUsOverlap = mins >= 13 * 60 + 30; // 13:30–16:00 GMT
    return { allowed: true, reason: inUsOverlap ? 'US/London overlap (highest volume)' : 'London session' };
  }

  // ── Part 6: Kelly Criterion position sizing ────────────────────────────────
  // Uses last 20 closed trades for the instrument. Falls back to £1/pt if < 10.
  function calcKellySize(market: string, history: IGTradeRecord[]): number {
    const trades = history
      .filter(t => t.market === market && t.status === 'CLOSED' && t.pnl !== null)
      .slice(0, 20);
    if (trades.length < 10) return 1.0; // insufficient history — conservative flat

    const wins   = trades.filter(t => (t.pnl ?? 0) > 0);
    const losses = trades.filter(t => (t.pnl ?? 0) <= 0);
    const winRate  = wins.length / trades.length;
    const lossRate = losses.length / trades.length;
    const avgWin   = wins.length   ? wins.reduce((s, t)   => s + (t.pnl ?? 0), 0) / wins.length   : 0;
    const avgLoss  = losses.length ? Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0) / losses.length) : 0;
    const rr       = avgLoss > 0 ? avgWin / avgLoss : 1;
    const kelly    = rr > 0 ? winRate - lossRate / rr : 0;
    const halfK    = Math.max(0, kelly / 2);

    // Map to IG £/pt: half-Kelly as fraction of a £5/pt max
    const size = halfK * 10; // e.g. kelly=0.2 → 1.0 £/pt
    return Math.min(5, Math.max(1, Math.round(size * 2) / 2)); // round to nearest 0.5
  }

  // ── Part 7: Strategy performance stats ────────────────────────────────────
  function computeStrategyStats(history: IGTradeRecord[], stratName?: string) {
    const closed = history.filter(t =>
      t.status === 'CLOSED' && t.closedAt && t.pnl !== null &&
      (!stratName || t.portfolioName === stratName),
    );
    const last20  = closed.slice(0, 20);
    const last50  = closed.slice(0, 50);
    const last100 = closed.slice(0, 100);

    function stats(trades: IGTradeRecord[]) {
      if (!trades.length) return { winRate: 0, avgWin: 0, avgLoss: 0, profitFactor: 0 };
      const wins   = trades.filter(t => (t.pnl ?? 0) > 0);
      const losses = trades.filter(t => (t.pnl ?? 0) <= 0);
      const winRate = wins.length / trades.length;
      const avgWin  = wins.length   ? wins.reduce((s, t)   => s + (t.pnl ?? 0), 0) / wins.length   : 0;
      const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0) / losses.length) : 0;
      const gp = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
      const gl = Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0));
      const profitFactor = gl > 0 ? gp / gl : gp > 0 ? Infinity : 0;
      return { winRate, avgWin, avgLoss, profitFactor };
    }

    // Max drawdown over entire closed history
    let equity = 0, peak = 0, maxDD = 0;
    for (const t of [...closed].reverse()) {
      equity += t.pnl ?? 0;
      peak = Math.max(peak, equity);
      maxDD = Math.max(maxDD, peak - equity);
    }

    // Best/worst instruments
    const byInstrument = new Map<string, number>();
    for (const t of closed) {
      byInstrument.set(t.market, (byInstrument.get(t.market) ?? 0) + (t.pnl ?? 0));
    }
    const instrArr = [...byInstrument.entries()].sort((a, b) => b[1] - a[1]);
    const bestInstr  = instrArr[0]  ? `${instrArr[0][0]} (£${instrArr[0][1].toFixed(0)})` : '—';
    const worstInstr = instrArr.at(-1) ? `${instrArr.at(-1)![0]} (£${instrArr.at(-1)![1].toFixed(0)})` : '—';

    // Sharpe estimate (daily P&L std dev)
    const pnls = closed.map(t => t.pnl ?? 0);
    const mean = pnls.length ? pnls.reduce((s, v) => s + v, 0) / pnls.length : 0;
    const variance = pnls.length > 1 ? pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / (pnls.length - 1) : 0;
    const stdDev = Math.sqrt(variance);
    const sharpe = stdDev > 0 ? (mean / stdDev) * Math.sqrt(252) : 0;

    return {
      total: closed.length,
      s20:  stats(last20),  s50:  stats(last50),  s100: stats(last100),
      maxDrawdown: maxDD, sharpe,
      bestInstr, worstInstr,
    };
  }

  // ── Resolve the actual IG epic for a Finnhub stock symbol (CFD path) ────────
  // Fix 4: known-good epics are returned immediately without any IG call.
  // Fix 2: cache hit (localStorage) → return immediately.
  // Fix 1: search GET /api/ig/markets?searchTerm={symbol}&instrumentTypes=SHARES.
  // Fix 3: null cached → symbol not on IG, never retry.
  function saveEpicCache(sym: string, epic: string | null) {
    igEpicCacheRef.current[sym] = epic;
    try {
      localStorage.setItem('ig_epic_cache', JSON.stringify(igEpicCacheRef.current));
    } catch {}
  }

  async function resolveIgEpicForSymbol(symbol: string): Promise<string | null> {
    // Fix 4 + Fix 2: cache hit (includes pre-seeded known-good epics)
    if (symbol in igEpicCacheRef.current) return igEpicCacheRef.current[symbol];

    const sess = sessionRef.current;
    if (!sess) {
      // No session — fall back to constructed epic without caching
      return `UA.D.${symbol}.CASH.IP`;
    }

    // Fix 1: search IG markets API for the actual epic
    try {
      const url = `/api/ig/markets?searchTerm=${encodeURIComponent(symbol)}&instrumentTypes=SHARES`;
      const r = await igQueue.enqueue(
        () => fetch(url, { headers: makeHeaders(sess, env) }),
        accountId,
      );
      if (r.ok) {
        const d = await r.json() as { ok: boolean; markets?: { epic: string; instrumentName: string }[] };
        if (d.ok && d.markets && d.markets.length > 0) {
          // IG search confirms this symbol is tradeable on this account.
          // Always construct UA.D.{SYMBOL}.CASH.IP — the canonical US stock CFD format.
          // Do NOT use the search result epic directly: IG can return SA.D.*, UB.D.* etc.
          // depending on the account region. UA.D.* is the correct prefix for all US stocks.
          const canonical = `UA.D.${symbol.toUpperCase()}.CASH.IP`;
          log('info', `🔍 Epic confirmed for ${symbol} → using ${canonical} (IG search returned: ${d.markets[0].epic})`);
          saveEpicCache(symbol, canonical);
          return canonical;
        }
      }
    } catch (e) {
      log('error', `Epic search error for ${symbol}: ${e instanceof Error ? e.message : e}`);
    }

    // Fix 3: not found on IG — cache null so we never retry
    log('info', `⚠️ ${symbol} not found on IG — caching as unavailable`);
    saveEpicCache(symbol, null);
    return null;
  }

  // ── Pinned instruments helpers ─────────────────────────────────────────────
  function pinInstrument(row: FinnhubRow) {
    setPinnedInstruments(prev => {
      if (prev.some(p => p.symbol === row.symbol)) return prev;
      const next = [...prev, row];
      try { localStorage.setItem('ig_cfd_pinned', JSON.stringify(next)); } catch {}
      return next;
    });
  }
  function unpinInstrument(symbol: string) {
    setPinnedInstruments(prev => {
      const next = prev.filter(p => p.symbol !== symbol);
      try { localStorage.setItem('ig_cfd_pinned', JSON.stringify(next)); } catch {}
      return next;
    });
  }
  const isPinned = (symbol: string) => pinnedInstruments.some(p => p.symbol === symbol);

  // ── Load available markets from IG market navigation (with search fallback) ─
  async function loadIGMarkets() {
    const sess = sessionRef.current;
    if (!sess) return;
    setNavLoading(true);

    type NavResp = { ok:boolean; nodes?:{id:string;name:string}[]; markets?:{epic:string;instrumentName:string;instrumentType:string}[]; error?:string; calledUrl?:string };
    type MktResp = { ok:boolean; markets?:{epic:string;instrumentName:string;instrumentType?:string;bid?:number;offer?:number}[]; error?:string };

    try {
      // ── Attempt 1: market navigation tree ──────────────────────────────────
      log('info', '🌐 Loading market navigation…');
      const topRes  = await fetch('/api/ig/marketnavigation', { headers: makeHeaders(sess, env) });
      const topData = await topRes.json() as NavResp;

      if (!topData.ok) {
        const calledUrl = topData.calledUrl ?? 'unknown';
        log('error', `Market nav failed HTTP ${topRes.status}: ${topData.error ?? 'unknown'}`);
        log('error', `  Called URL: ${calledUrl}`);
        log('info', '↩ Falling back to market search…');

        // ── Attempt 2: direct market search by instrument type ──────────────
        const SEARCHES = [
          { term: 'wall street', type: 'INDICES',     label: 'Indices'     },
          { term: 'AAPL',        type: 'SHARES',      label: 'US Shares'   },
          { term: 'Barclays',    type: 'SHARES',      label: 'UK Shares'   },
          { term: 'GBPUSD',      type: 'CURRENCIES',  label: 'Forex'       },
          { term: 'gold',        type: 'COMMODITIES', label: 'Commodities' },
          { term: 'bitcoin',     type: 'CRYPTOCURRENCIES', label: 'Crypto' },
        ];
        const fallbackCategories: IGNavCategory[] = [];
        for (const s of SEARCHES) {
          try {
            const url = `/api/ig/markets?searchTerm=${encodeURIComponent(s.term)}&instrumentTypes=${s.type}`;
            const r = await fetch(url, { headers: makeHeaders(sess, env) });
            const d = await r.json() as MktResp;
            if (d.ok && (d.markets?.length ?? 0) > 0) {
              fallbackCategories.push({
                node:     { id: `fallback_${s.type}`, name: s.label },
                markets:  (d.markets ?? []).slice(0, 30).map(m => ({
                  epic:            m.epic,
                  instrumentName:  m.instrumentName,
                  instrumentType:  m.instrumentType ?? s.type,
                })),
                subNodes: [],
                expanded: false,
              });
              log('info', `  ✓ ${s.label}: ${d.markets?.length} instruments`);
            } else {
              log('error', `  ✗ ${s.label} search: ${d.error ?? `HTTP ${r.status}`}`);
            }
          } catch (e) {
            log('error', `  ✗ ${s.label} search error: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        if (fallbackCategories.length > 0) {
          setNavCategories(fallbackCategories);
          setNavLoaded(true);
          log('info', `✅ Fallback loaded — ${fallbackCategories.length} categories via market search`);
        } else {
          log('error', '❌ Both market nav and fallback search failed — using hardcoded watchlist');
        }
        setNavLoading(false);
        return;
      }

      // Navigation succeeded — drill into relevant top-level nodes
      const topNodes = topData.nodes ?? [];
      log('info', `  Nav root: ${topNodes.length} top-level nodes`);

      const RELEVANT = ['indices', 'currenc', 'commodit', 'shares', 'crypto', 'bitcoin', 'forex', 'popular'];
      const relevantNodes = topNodes.filter(n => RELEVANT.some(k => n.name.toLowerCase().includes(k)));
      const useNodes = relevantNodes.length > 0 ? relevantNodes : topNodes.slice(0, 8);

      const categories: IGNavCategory[] = [];
      for (const node of useNodes.slice(0, 8)) {
        const nodeRes  = await fetch(`/api/ig/marketnavigation?nodeId=${node.id}`, { headers: makeHeaders(sess, env) });
        const nodeData = await nodeRes.json() as NavResp;
        if (!nodeData.ok) {
          log('error', `  Nav node ${node.name} failed: ${nodeData.error ?? `HTTP ${nodeRes.status}`}${nodeData.calledUrl ? ` (${nodeData.calledUrl})` : ''}`);
          continue;
        }

        const markets  = nodeData.markets ?? [];
        const subNodes = nodeData.nodes   ?? [];

        if (markets.length === 0 && subNodes.length > 0) {
          for (const sub of subNodes.slice(0, 4)) {
            const subRes  = await fetch(`/api/ig/marketnavigation?nodeId=${sub.id}`, { headers: makeHeaders(sess, env) });
            const subData = await subRes.json() as NavResp;
            if (!subData.ok) continue;
            const subMarkets = subData.markets ?? [];
            if (subMarkets.length > 0) {
              categories.push({
                node:     { id: sub.id, name: `${node.name} › ${sub.name}` },
                markets:  subMarkets.slice(0, 30),
                subNodes: [],
                expanded: false,
              });
            }
          }
        } else if (markets.length > 0) {
          categories.push({ node, markets: markets.slice(0, 50), subNodes, expanded: false });
        }
      }

      setNavCategories(categories);
      setNavLoaded(true);
      const totalMkts = categories.reduce((s, c) => s + c.markets.length, 0);
      log('info', `✅ Market nav loaded — ${categories.length} categories, ${totalMkts} instruments`);

    } catch (e) {
      log('error', `Market nav error: ${e instanceof Error ? e.message : String(e)}`);
    }
    setNavLoading(false);
  }

  // ── Fetch market snapshot (simple daily change — fallback only) ──────────
  async function fetchSnapshot(name: string, epic?: string) {
    try {
      const params = new URLSearchParams({ name });
      if (epic) params.set('epic', epic);
      const r = await fetch(`/api/ig/candles?${params.toString()}`);
      const d = await r.json() as { ok:boolean; price?:number; changePercent?:number; signal?:'BUY'|'SELL'|'NEUTRAL'; source?:string; error?:string };
      if (!d.ok) return { price:0, changePercent:0, signal:'NEUTRAL' as const, source:'yahoo', error: d.error ?? `HTTP ${r.status}` };
      return { price:d.price ?? 0, changePercent:d.changePercent ?? 0, signal:d.signal ?? 'NEUTRAL' as const, source:d.source ?? 'yahoo' };
    } catch (e) { return { price:0, changePercent:0, signal:'NEUTRAL' as const, source:'yahoo', error: e instanceof Error ? e.message : 'Fetch failed' }; }
  }

  // ── Fetch technical indicators (RSI, EMA, MACD, Volume, VWAP) ────────────
  type IndicatorResult = {
    price:number; previousClose:number; changePercent:number; gapPercent:number;
    rsi14:number; rsiPrev:number; rsiCrossedAbove30:boolean; rsiCrossedBelow70:boolean;
    ema20:number; ema50:number; emaCross:string;
    macdLine:number; macdSignal:number; macdHistogram:number;
    macdHistPrev1:number; macdHistPrev2:number;
    macdCross:string; macdCrossedBullRecently:boolean; macdCrossedBearRecently:boolean;
    volumeSurge:number; vwapDeviation:number; atr14:number;
    bullScore:number; bearScore:number; confidenceScore:number;
    direction:'BUY'|'SELL'|'NEUTRAL';
  };
  async function fetchIndicators(name: string, epic?: string): Promise<IndicatorResult|null> {
    try {
      const params = new URLSearchParams({ name });
      if (epic) params.set('epic', epic);
      const r = await fetch(`/api/ig/indicators?${params.toString()}`);
      const d = await r.json() as { ok:boolean } & Partial<IndicatorResult>;
      return d.ok ? d as IndicatorResult : null;
    } catch { return null; }
  }

  // ── Finnhub category scanner ──────────────────────────────────────────────
  async function loadFinnhubScreener(cat: FinnhubCategory) {
    setFinnhubLoading(true);
    setFinnhubRows([]);
    try {
      // 1. Screener: pre-filtered top movers (5-min cache, calls Finnhub quotes)
      const sr = await fetch(`/api/finnhub/screener?category=${cat}&limit=50`);
      const sd = await sr.json() as {
        ok: boolean;
        results?: Array<{
          symbol: string; description: string; category: FinnhubCategory;
          price: number; changePercent: number; volume: number;
          igEpic: string | null; yahooSymbol: string | null;
        }>;
      };
      if (!sd.ok || !sd.results) { setFinnhubLoading(false); return; }

      // Seed rows immediately so the user sees something
      const initialRows: FinnhubRow[] = sd.results.map(r => ({
        symbol: r.symbol, description: r.description, category: r.category,
        price: r.price, changePercent: r.changePercent,
        igEpic: r.igEpic, yahooSymbol: r.yahooSymbol,
        loading: true,
      }));
      setFinnhubRows(initialRows);
      setFinnhubLastScan(new Date().toLocaleTimeString('en-GB'));

      // 2. Fetch indicators for each row in parallel (batches of 5 to avoid overloading Yahoo)
      const BATCH = 5;
      const rows = [...initialRows];
      for (let i = 0; i < rows.length; i += BATCH) {
        const slice = rows.slice(i, i + BATCH);
        const results = await Promise.allSettled(slice.map(async row => {
          if (!row.yahooSymbol) return row;
          try {
            const params = new URLSearchParams({ symbol: row.yahooSymbol });
            const ir = await fetch(`/api/ig/indicators?${params.toString()}`);
            const id = await ir.json() as {
              ok: boolean; price?: number; rsi14?: number; emaCross?: string; macdHistogram?: number;
              bullScore?: number; bearScore?: number; confidenceScore?: number;
              direction?: 'BUY' | 'SELL' | 'NEUTRAL'; atr14?: number; vwapDeviation?: number;
            };
            if (id.ok) {
              return { ...row,
                price: id.price ?? row.price,
                yahooPrice: id.price,
                rsi14: id.rsi14, emaCross: id.emaCross, macdHistogram: id.macdHistogram,
                bullScore: id.bullScore, bearScore: id.bearScore,
                confidenceScore: id.confidenceScore, direction: id.direction,
                atr14: id.atr14, vwapDeviation: id.vwapDeviation,
                loading: false,
              };
            }
          } catch {}
          return { ...row, loading: false };
        }));

        results.forEach((r, j) => {
          if (r.status === 'fulfilled') rows[i + j] = r.value as FinnhubRow;
        });
        setFinnhubRows([...rows]);

        if (i + BATCH < rows.length) await new Promise(res => setTimeout(res, 300));
      }

      // 3. Fetch analyst recommendations for stocks only (US/UK) — best-effort
      if (cat === 'US_STOCK' || cat === 'UK_STOCK') {
        const recResults = await Promise.allSettled(
          rows.slice(0, 20).map(async (row, idx) => {
            try {
              const rr = await fetch(`/api/finnhub/recommendation?symbol=${encodeURIComponent(row.symbol)}`);
              const rd = await rr.json() as { ok: boolean; bullScore?: number };
              if (rd.ok && rd.bullScore !== undefined) {
                rows[idx] = { ...rows[idx], analystBullScore: rd.bullScore };
              }
            } catch {}
          })
        );
        void recResults; // just for eslint
        setFinnhubRows([...rows]);
      }

      // 4. Auto-trade: attempt trades for rows with ≥75% confidence (CFD, autoTrade strategy)
      const activeStrat = strategies.find(s => s.id === activeStratId);
      if (activeStrat?.autoTrade && accountType === 'CFD' && sessionRef.current) {
        const highConf = rows.filter(
          r => !r.loading && (r.confidenceScore ?? 0) >= 75 &&
               (r.direction === 'BUY' || r.direction === 'SELL') &&
               r.igEpic !== null,
        );
        if (highConf.length > 0) {
          log('info', `📡 Scanner found ${highConf.length} high-confidence signal(s) — attempting trades`);
        }
        for (const row of highConf) {
          if (!runningRef.current) break;
          const epic = row.igEpic ?? `UA.D.${row.symbol}.CASH.IP`;
          const px   = row.yahooPrice ?? row.price;
          const atr  = row.atr14 ?? px * 0.02;   // fallback: 2% of price
          const stop  = Math.max(1, atr * 1.5);
          const limit = stop * 2;
          const sig   = row.direction as 'BUY' | 'SELL';
          const strength = row.confidenceScore ?? 75;
          const market: WatchlistMarket = {
            epic, name: row.description || row.symbol,
            enabled: true, marketType: 'STOCK',
          };
          const signalData: SignalData = {
            market,
            sig: { direction: sig, strength, stopPoints: stop, targetPoints: limit, riskReward: '1:2', indicators: [], reason: `Scanner: ${sig} ${strength}%` },
            resolvedEpic: epic,
            stopDist: stop,
            limitDist: limit,
            scanChange: row.changePercent,
            direction: sig,
            strength,
            atrHighVolatility: (row.atr14 ?? 0) / (px || 1) > 0.02,
          };
          log('info', `Signal found: ${row.symbol} | ${sig} ${strength}% confidence`);
          await executeTrade(activeStrat, signalData);
        }
      }
    } catch (err) {
      console.error('Finnhub screener error:', err);
    }
    setFinnhubLoading(false);
  }

  // ── Search Finnhub universe for any symbol/name and enrich with indicators ──
  async function searchFinnhubSymbol(query: string) {
    if (!query.trim()) return;
    setFinnhubSearchBusy(true);
    try {
      // Determine likely category from query
      const q = query.toUpperCase().trim();
      const cat: FinnhubCategory =
        q.endsWith('.L') ? 'UK_STOCK' :
        q.includes(':') && q.includes('USD') ? 'FOREX' :
        q.includes('BTC') || q.includes('ETH') ? 'CRYPTO' : 'US_STOCK';

      // Build a candidate Finnhub row
      const igEpic     = toIgEpic(q, cat);
      const yahooSymbol = toYahooSymbol(q, cat);
      const baseRow: FinnhubRow = {
        symbol: q, description: q, category: cat,
        price: 0, changePercent: 0,
        igEpic, yahooSymbol, loading: true,
      };

      // Add to current rows (or update if already present)
      setFinnhubRows(prev => {
        const exists = prev.findIndex(r => r.symbol === q);
        if (exists >= 0) {
          const next = [...prev]; next[exists] = baseRow; return next;
        }
        return [baseRow, ...prev];
      });

      // Fetch indicators if we have a Yahoo symbol
      if (yahooSymbol) {
        const params = new URLSearchParams({ symbol: yahooSymbol });
        const ir = await fetch(`/api/ig/indicators?${params.toString()}`);
        const id = await ir.json() as {
          ok: boolean; price?: number; changePercent?: number;
          rsi14?: number; emaCross?: string; macdHistogram?: number;
          bullScore?: number; bearScore?: number; confidenceScore?: number;
          direction?: 'BUY' | 'SELL' | 'NEUTRAL';
        };
        const enriched: FinnhubRow = {
          ...baseRow,
          price: id.price ?? 0, changePercent: id.changePercent ?? 0,
          rsi14: id.rsi14, emaCross: id.emaCross, macdHistogram: id.macdHistogram,
          bullScore: id.bullScore, bearScore: id.bearScore,
          confidenceScore: id.confidenceScore, direction: id.direction,
          loading: false,
        };
        setFinnhubRows(prev => {
          const idx = prev.findIndex(r => r.symbol === q);
          const next = [...prev];
          if (idx >= 0) next[idx] = enriched; else next.unshift(enriched);
          return next;
        });
      } else {
        setFinnhubRows(prev => prev.map(r => r.symbol === q ? { ...r, loading: false } : r));
      }
    } catch (err) {
      console.error('Finnhub search error:', err);
    }
    setFinnhubSearchBusy(false);
  }

  // ── Check S&P 500 / FTSE / VIX market conditions before scanning ─────────
  async function checkMarketConditions() {
    const [sp, ftse] = await Promise.allSettled([
      fetchIndicators('S&P 500'),
      fetchIndicators('FTSE 100'),
    ]);
    const spInd   = sp.status   === 'fulfilled' ? sp.value   : null;
    const ftseInd = ftse.status === 'fulfilled' ? ftse.value : null;
    let vixPrice = 15;
    try {
      const r = await fetch('/api/ig/candles?name=VIX');
      const d = await r.json() as { ok:boolean; price?:number };
      if (d.ok && d.price) vixPrice = d.price;
    } catch {}
    const spChange   = spInd?.changePercent   ?? 0;
    const ftseChange = ftseInd?.changePercent ?? 0;
    return {
      spChange, ftseChange, vix: vixPrice,
      marketStressed: spChange < -1 || ftseChange < -1,
      vixHigh: vixPrice > 30,
    };
  }

  // ── Build full scan list from nav categories (up to 100 instruments) ─────
  function buildFullScanList(watchlist: WatchlistMarket[]): WatchlistMarket[] {
    const seen = new Set<string>();
    const out: WatchlistMarket[] = [];
    // Seed with enabled watchlist entries
    for (const m of watchlist.filter(w => w.enabled)) {
      if (!seen.has(m.epic)) { seen.add(m.epic); out.push(m); }
    }
    // Fill from nav categories
    const CAT_LIMIT: Record<string, number> = {
      us: 25, shares: 25, uk: 15, indices: 8, forex: 8, commodit: 8, crypto: 5,
    };
    for (const cat of navCategories) {
      const key = Object.keys(CAT_LIMIT).find(k => cat.node.name.toLowerCase().includes(k)) ?? '';
      const lim = CAT_LIMIT[key] ?? 10;
      for (const m of cat.markets.slice(0, lim)) {
        if (seen.has(m.epic) || out.length >= 100) continue;
        seen.add(m.epic);
        const mktType = m.instrumentType === 'CURRENCIES' ? 'FOREX' as const
          : m.instrumentType === 'INDICES'    ? 'INDEX' as const
          : m.instrumentType === 'COMMODITIES'? 'COMMODITY' as const
          : 'STOCK' as const;
        out.push({ epic: m.epic, name: m.instrumentName, enabled: true, marketType: mktType });
      }
      if (out.length >= 100) break;
    }
    return out;
  }

  // ── Sector lookup for rotation scoring ───────────────────────────────────
  function getSector(epic: string): string {
    for (const cat of navCategories) {
      if (cat.markets.some(m => m.epic === epic)) return cat.node.name;
    }
    if (epic.startsWith('CS.D.'))                             return 'Forex';
    if (epic.startsWith('IX.D.') || epic.includes('.CFD.IP')) return 'Indices';
    if (epic.startsWith('UA.D.') && epic.includes('CASH.IP')) return 'US Shares';
    return 'Other';
  }

  // ── Place order ────────────────────────────────────────────────────────────
  async function placeOrder(
    epic: string, direction: 'BUY'|'SELL', size: number,
    stopDist?: number, limitDist?: number,
    stopLevel?: number, limitLevel?: number,
    currencyCode?: string,
  ): Promise<OrderResult> {
    for (let i = 0; i < 150 && tradeLockRef.current; i++) await sleep(100);
    tradeLockRef.current = true;
    try { return await _placeOrderInner(epic, direction, size, stopDist, limitDist, stopLevel, limitLevel, currencyCode); }
    finally { await sleep(500); tradeLockRef.current = false; }
  }

  async function _placeOrderInner(
    epic: string, direction: 'BUY'|'SELL', size: number,
    stopDist?: number, limitDist?: number,
    stopLevel?: number, limitLevel?: number,
    currencyCode?: string,
  ): Promise<OrderResult> {
    let sess = await freshSession();
    if (!sess) return { ok:false, error:`No ${env} session`, epic };

    // CFD uses absolute price levels; spread-bet uses point distances
    const orderBody: Record<string, unknown> = { epic, direction, size };
    if (currencyCode)              orderBody.currencyCode  = currencyCode;
    if (stopLevel  !== undefined)  orderBody.stopLevel    = stopLevel;
    if (limitLevel !== undefined)  orderBody.limitLevel   = limitLevel;
    if (stopDist   !== undefined)  orderBody.stopDistance  = stopDist;
    if (limitDist  !== undefined)  orderBody.profitDistance = limitDist;
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

  // ── Signal data type (result of getSignal — no side-effects, safe to call in parallel) ──
  type SignalData = {
    market: WatchlistMarket;
    sig: StrategySignal;
    resolvedEpic: string;
    stopDist: number;
    limitDist: number;
    scanChange: number;
    direction: 'BUY'|'SELL'|'HOLD';
    strength: number;
    atrHighVolatility?: boolean; // Part 2: ATR > 2% → halve position size
    currentPrice?: number;       // current market price for level-based CFD SL/TP
    atr14?: number;              // raw ATR(14) for computing price levels
  };

  // ── Phase 1: Fetch indicators + compute signal — NO trade placement ────────
  async function getSignal(strat: IGSavedStrategy, market: WatchlistMarket): Promise<SignalData | null> {
    setScans(p => ({ ...p, [market.epic]: { epic:market.epic, name:market.name, signal:null, scanning:true, status:'idle' } }));

    const resolvedEpic = epicForAccount(market.name, accountType) ?? market.epic;
    const mType = market.marketType ?? getMarketType(market.epic);

    // ── Part 4: Session gate (spreadbet only) ────────────────────────────────
    if (accountType === 'SPREADBET' && strat.timeframe === 'spreadbet') {
      const sess = tradingSessionCheck();
      if (!sess.allowed) {
        const msg = `⏰ Session: ${sess.reason}`;
        setScans(p => ({ ...p, [market.epic]: { epic:market.epic, name:market.name, signal:null, scanning:false, status:'idle', error:msg } }));
        log('info', `${market.name} skipped — ${sess.reason}`);
        scanCountersRef.current.skippedConditions++;
        return null;
      }
    }

    // ── Part 5: Avoid stocks & crypto on spread bet ──────────────────────────
    if (accountType === 'SPREADBET' && (mType === 'STOCK' || mType === 'CRYPTO')) {
      const msg = `${mType} not suitable for spread betting (wide spreads) — skipped`;
      setScans(p => ({ ...p, [market.epic]: { epic:market.epic, name:market.name, signal:null, scanning:false, status:'idle', error:msg } }));
      log('info', `${market.name}: ${msg}`);
      scanCountersRef.current.skippedConditions++;
      return null;
    }

    // ── Part 7: Performance pause check ─────────────────────────────────────
    if (performancePausedRef.current) {
      const msg = '⚠️ Trading paused — win rate below 40%';
      setScans(p => ({ ...p, [market.epic]: { epic:market.epic, name:market.name, signal:null, scanning:false, status:'idle', error:msg } }));
      log('info', `${market.name} skipped — ${msg}`);
      return null;
    }

    const { stopDist: fixedStop, limitDist: fixedLimit } = getStopDistances(mType, accountType);
    const ind = await fetchIndicators(market.name, resolvedEpic);

    let direction: 'BUY'|'SELL'|'HOLD';
    let strength: number;
    let pctStr: string;
    let scanChange = 0;
    let stopDist = fixedStop;
    let limitDist = fixedLimit;
    let atrHighVolatility = false;
    let sig: StrategySignal;

    if (ind) {
      if (Math.abs(ind.gapPercent) > 3) {
        const msg = `Gap ${ind.gapPercent > 0 ? '+' : ''}${ind.gapPercent.toFixed(1)}% — too volatile`;
        setScans(p => ({ ...p, [market.epic]: { epic:market.epic, name:market.name, signal:null, scanning:false, status:'error', error:msg } }));
        log('info', `⚡ ${market.name}: ${msg}`);
        scanCountersRef.current.skippedVolatile++;
        return null;
      }
      pctStr     = `${ind.changePercent >= 0 ? '+' : ''}${ind.changePercent.toFixed(2)}%`;
      scanChange = ind.changePercent;

      if (strat.timeframe === 'spreadbet' && accountType === 'SPREADBET') {
        // ── Parts 1 & 2: Multi-confirmation spreadbet signal + ATR stops ──────
        sig = spreadbetSignalFromIndicators(ind, mType);
        direction = sig.direction === 'BUY' ? 'BUY' : sig.direction === 'SELL' ? 'SELL' : 'HOLD';
        strength  = sig.strength;

        // ATR-based stop/limit override (Part 2)
        if (ind.atr14 > 0) {
          const atrPct = (ind.atr14 / ind.price) * 100;
          if (atrPct < 0.15) {
            // Ranging market — skip entirely
            const msg = `ATR ${atrPct.toFixed(2)}% — ranging market, no trend`;
            setScans(p => ({ ...p, [market.epic]: { epic:market.epic, name:market.name, signal:null, scanning:false, status:'idle', error:msg } }));
            log('info', `${market.name}: ${msg}`);
            scanCountersRef.current.skippedConditions++;
            return null;
          }
          stopDist  = Math.round(ind.atr14 * 1.5 * 10) / 10;
          limitDist = Math.round(ind.atr14 * 3.0 * 10) / 10;
          // Enforce minimum 2:1 R:R
          if (limitDist < stopDist * 2) limitDist = stopDist * 2;
          atrHighVolatility = atrPct > 2.0; // flag: position size halved in executeTrade
        }
      } else {
        // Standard indicator-based signal
        direction = ind.direction === 'BUY' ? 'BUY' : ind.direction === 'SELL' ? 'SELL' : 'HOLD';
        strength  = Math.min(100, ind.confidenceScore + (scanParamsRef.current.sectorAdjust ?? 0));
        sig = {
          direction, strength,
          reason: `RSI ${ind.rsi14.toFixed(0)} | EMA ${ind.emaCross} | MACD ${ind.macdCross} | Vol ${ind.volumeSurge.toFixed(1)}x | ${pctStr}`,
          stopPoints: stopDist, targetPoints: limitDist,
          riskReward: `1:${(limitDist / stopDist).toFixed(1)}`,
          indicators: [
            { label:'RSI 14',    value:ind.rsi14.toFixed(1),             status:ind.rsi14<30?'bullish':ind.rsi14>70?'bearish':'neutral' },
            { label:'EMA 20/50', value:ind.emaCross,                      status:ind.emaCross==='bullish'?'bullish':'bearish' },
            { label:'MACD',      value:ind.macdCross,                     status:ind.macdCross==='bullish'?'bullish':'bearish' },
            { label:'Volume',    value:`${ind.volumeSurge.toFixed(1)}x`,  status:ind.volumeSurge>=1.5?'bullish':'neutral' },
            { label:'VWAP dev',  value:`${ind.vwapDeviation>=0?'+':''}${ind.vwapDeviation.toFixed(2)}%`, status:ind.vwapDeviation>0?'bullish':'bearish' },
            { label:'Daily Δ',   value:pctStr,                            status:direction==='BUY'?'bullish':direction==='SELL'?'bearish':'neutral' },
            { label:'Score',     value:`${ind.bullScore}↑ / ${ind.bearScore}↓`, status:'neutral' },
          ],
        };
      }
    } else {
      const snapshot = await fetchSnapshot(market.name, resolvedEpic);
      if (!snapshot || snapshot.error) {
        const errMsg = snapshot?.error ?? 'Failed to fetch market data';
        setScans(p => ({ ...p, [market.epic]: { epic:market.epic, name:market.name, signal:null, scanning:false, status:'error', error:errMsg } }));
        log('error', `${market.name}: ${errMsg}`);
        return null;
      }
      const cal  = calibrateSignal(snapshot.changePercent, snapshot.signal, mType);
      direction  = cal.direction; strength = cal.strength;
      pctStr     = `${snapshot.changePercent >= 0 ? '+' : ''}${snapshot.changePercent.toFixed(2)}%`;
      scanChange = snapshot.changePercent;
      sig = {
        direction, strength,
        reason: `Daily ${pctStr} (${mType})`,
        stopPoints: stopDist, targetPoints: limitDist,
        riskReward: `1:${(limitDist / stopDist).toFixed(1)}`,
        indicators: [
          { label:'Daily Change', value:pctStr,          status:direction==='BUY'?'bullish':direction==='SELL'?'bearish':'neutral' },
          { label:'Type',         value:mType,            status:'neutral' },
          { label:'Stop dist',    value:`${stopDist}pt`,  status:'neutral' },
          { label:'TP dist',      value:`${limitDist}pt`, status:'neutral' },
        ],
      };
    }

    setScans(p => ({ ...p, [market.epic]: {
      epic:market.epic, name:market.name, signal:sig,
      price:ind?.price ?? 0, changePercent:scanChange,
      source:'yahoo', scanning:false, status:'ok', lastScanned:new Date().toISOString(),
    }}));

    const effectiveMinStrength = Math.max(strat.minStrength, MIN_STRENGTH[accountType]) + scanParamsRef.current.confidenceBoost;
    if (direction !== 'HOLD')
      log('signal', `${market.name} → ${direction} ${strength}% | ${sig.reason}`);
    else
      log('info', `${market.name} → HOLD (no clear direction)`);

    if (direction === 'HOLD' || strength < effectiveMinStrength) return null;
    return { market, sig, resolvedEpic, stopDist, limitDist, scanChange, direction, strength, atrHighVolatility,
             currentPrice: ind?.price, atr14: ind?.atr14 };
  }

  // ── Phase 2: Execute one trade for a pre-computed signal (sequential) ─────
  // forceTop=true: top-ranked signal — bypasses duplicate and maxPositions guards
  async function executeTrade(strat: IGSavedStrategy, data: SignalData, forceTop = false): Promise<'ok'|'funds_low'|'skipped'> {
    const { market, sig, resolvedEpic, stopDist, limitDist, direction, strength } = data;
    const tradeDir = direction as 'BUY'|'SELL';

    // Step-by-step trade attempt logging
    log('info', `[EXEC] Trade attempt: ${market.name} | ${tradeDir} | strength=${strength}% | SL=${stopDist.toFixed(2)} TP=${limitDist.toFixed(2)} | epic=${resolvedEpic}${forceTop ? ' [FORCE]' : ''}`);

    // Auto-close opposite positions
    if (strat.autoClose) {
      const opposite = tradeDir === 'BUY' ? 'SELL' : 'BUY';
      for (const opp of positionsRef.current.filter(p => p.epic === market.epic && p.direction === opposite)) {
        log('close', `${acctTag} Auto-closing ${opp.direction} ${market.name} — signal reversed`);
        const cr = await closePos(opp);
        if (cr.ok) {
          const exitPx = opp.direction === 'BUY' ? (opp.bid ?? opp.level) : (opp.offer ?? opp.level);
          setTradeHistory(prev => recordTradeClose(prev, opp.dealId, exitPx, opp.upl ?? 0, 'STRATEGY', new Date().toISOString()));
        } else log('error', `${acctTag} Close failed: ${cr.error ?? 'unknown'}`);
      }
      await loadPositions();
    }

    // Skip if already long/short this instrument in same direction (bypass for force-top)
    const alreadyOpen = positionsRef.current.some(p => p.epic === market.epic && p.direction === tradeDir);
    if (alreadyOpen) {
      if (forceTop) {
        log('info', `[EXEC] Already have ${tradeDir} ${market.name} — force-top skips duplicate check`);
      } else {
        log('info', `[EXEC] Already have ${tradeDir} ${market.name} — skipping duplicate`);
        return 'skipped';
      }
    }

    // User-configured position cap (0 = unlimited) — bypass for force-top
    const openCount = positionsRef.current.filter(p => p.epic !== market.epic).length;
    if (!forceTop && strat.maxPositions > 0 && openCount >= strat.maxPositions) {
      log('info', `[EXEC] Max ${strat.maxPositions} positions reached (${openCount} open) — skip ${market.name}`);
      return 'skipped';
    } else if (strat.maxPositions > 0) {
      log('info', `[EXEC] Position count: ${openCount}/${strat.maxPositions === 0 ? '∞' : strat.maxPositions}`);
    }

    // Funds-based hard pause: < 20% of starting balance
    const fundsNow  = igFundsRef.current;
    const available = fundsNow?.available ?? Infinity;
    const startBal  = startingBalanceRef.current;
    log('info', `[EXEC] Funds check: available=£${available === Infinity ? '?' : available.toFixed(2)} startBal=£${startBal.toFixed(2)}`);
    if (startBal > 0 && available < startBal * 0.20) {
      log('info', `[EXEC] 🔴 Funds below 20% of start (£${available.toFixed(2)} / £${startBal.toFixed(2)}) — no new trades`);
      showToast(false, `⚠️ Funds below 20% — trades paused`);
      return 'funds_low';
    }

    if (env === 'live') {
      log('info', `[EXEC] Live account — requesting user confirmation…`);
      const ok = await confirmLiveTrade();
      if (!ok) { log('info', `[EXEC] Disclaimer declined — skipping ${market.name}`); return 'skipped'; }
    }

    // Dynamic sizing: 1% risk when funds < 50% of start, else 2%
    const riskPct  = startBal > 0 && available < startBal * 0.50 ? 0.01 : 0.02;
    const totalBal = fundsNow?.balance ?? 0;

    // Part 6: Kelly Criterion for SPREADBET (overrides strat.size when ≥10 trades)
    const kellySize = accountType === 'SPREADBET' ? calcKellySize(data.market.name, tradeHistory) : strat.size;
    // Part 2: ATR high volatility → halve size
    const atrMult = data.atrHighVolatility ? 0.5 : 1.0;
    const effectiveSize = accountType === 'SPREADBET'
      ? Math.max(0.5, Math.round(kellySize * atrMult * 2) / 2)
      : strat.size;
    const sizeMult = scanParamsRef.current.sizeMultiplier * atrMult;
    const orderSize = calcRiskBasedSize(available, stopDist, accountType, effectiveSize, sizeMult, riskPct, totalBal);
    log('info', `[EXEC] Sizing: acct=${accountType} available=£${available === Infinity ? '?' : available.toFixed(2)} stopDist=${stopDist} effectiveSize=${effectiveSize} → orderSize=${orderSize}`);

    if (orderSize === 0 && accountType !== 'CFD') {
      // CFD uses price-tier unit sizing computed after price fetch — never blocked by orderSize=0
      // Part 2: if signal is very strong (≥85%), try to free capital by closing weakest position
      if (strength >= 85 && positionsRef.current.length > 0) {
        log('info', `${acctTag} 🎯 Strong signal (${strength}%) but low funds — evaluating positions for redeployment`);
        const scoredPositions = await Promise.all(
          positionsRef.current.map(async p => {
            const pInd = await fetchIndicators(p.instrumentName ?? p.epic, p.epic).catch(() => null);
            const pPx = p.direction === 'BUY' ? p.bid : p.offer;
            const pPnlPct = p.level ? (p.direction === 'BUY' ? ((pPx - p.level) / p.level) * 100 : ((p.level - pPx) / p.level) * 100) : 0;
            return { pos: p, score: scorePositionStrength(p, pInd, pPnlPct), upl: p.upl ?? 0 };
          }),
        );
        const weakest = scoredPositions.sort((a, b) => a.score - b.score)[0];
        if (weakest && weakest.score < 45) {
          const wName = weakest.pos.instrumentName ?? weakest.pos.epic;
          const wUpl  = weakest.upl;
          log('close', `${acctTag} 🔄 Closing ${wName} (${wUpl >= 0 ? '+' : ''}£${Math.abs(wUpl).toFixed(2)}, score ${weakest.score}) to fund ${market.name} (${strength}% confidence)`);
          const cr = await closePos(weakest.pos);
          if (cr.ok) {
            const exitPx = weakest.pos.direction === 'BUY' ? (weakest.pos.bid ?? weakest.pos.level) : (weakest.pos.offer ?? weakest.pos.level);
            setTradeHistory(prev => recordTradeClose(prev, weakest.pos.dealId, exitPx, wUpl, 'STRATEGY', new Date().toISOString()));
            await loadPositions();
            await fetchIGFunds();
            // Re-compute size with freed capital
            const newFunds = igFundsRef.current;
            const newAvail = newFunds?.available ?? 0;
            const newRiskPct = startBal > 0 && newAvail < startBal * 0.50 ? 0.01 : 0.02;
            const newSize = calcRiskBasedSize(newAvail, stopDist, accountType, strat.size, scanParamsRef.current.sizeMultiplier, newRiskPct, newFunds?.balance ?? 0);
            if (newSize > 0) {
              // Fall through to trade with freed capital (re-assign available for subsequent checks)
              // eslint-disable-next-line no-param-reassign
              const updatedFunds = igFundsRef.current;
              const updatedAvail = updatedFunds?.available ?? 0;
              const finalSize = calcRiskBasedSize(updatedAvail, stopDist, accountType, strat.size, scanParamsRef.current.sizeMultiplier, newRiskPct, updatedFunds?.balance ?? 0);
              if (finalSize > 0) {
                const epicOkAfter = await validateEpic(resolvedEpic);
                if (epicOkAfter) {
                  log(tradeDir === 'BUY' ? 'buy' : 'sell', `${acctTag} → ${tradeDir} ${market.name} | ${resolvedEpic} | ${finalSize} | ${strength}% (redeployed capital)`);
                  const or2 = await placeOrder(resolvedEpic, tradeDir, finalSize, stopDist, limitDist);
                  if (or2.ok) {
                    scanCountersRef.current.traded++;
                    log(tradeDir === 'BUY' ? 'buy' : 'sell', `${acctTag} ✅ Redeployed → ${or2.dealStatus ?? 'ACCEPTED'} ref ${or2.dealReference ?? 'n/a'}`);
                    showToast(true, `[${accountType}] Redeployed: ${tradeDir} ${market.name}`);
                    setTradeHistory(prev => recordTradeOpen(prev, {
                      portfolioName:strat.name, market:market.name, epic:resolvedEpic,
                      direction:tradeDir, size:finalSize, entryLevel:or2.level ?? 0,
                      exitLevel:null, openedAt:new Date().toISOString(), closedAt:null,
                      status:'OPEN', dealReference:or2.dealReference ?? '', dealId:or2.dealId ?? '',
                      pnl:null, closeReason:null, accountType:env,
                    }));
                    await loadPositions();
                    return 'ok';
                  }
                }
              }
            }
          }
        }
      }
      log('error', `${acctTag} ⚠️ Insufficient funds (£${available.toFixed(2)}) — skipping ${market.name}`);
      showToast(false, `⚠️ Low funds — skipping`);
      return 'funds_low';
    }

    // Capital freeing: close worst loser if very low on funds
    if (available < 500 && positionsRef.current.length > 0) {
      const now = Date.now();
      const worst = [...positionsRef.current]
        .filter(p => p.upl < 0 && p.createdDate && (now - new Date(p.createdDate).getTime()) > 24 * 3_600_000)
        .sort((a, b) => a.upl - b.upl)[0];
      if (worst) {
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

    // Resolve to actual IG epic
    // CFD path: search-based resolution with localStorage cache (Fix 1-4)
    // SPREADBET path: keep existing validateEpic (watchlist epics are already verified)
    let actualEpic = resolvedEpic;
    if (accountType === 'CFD') {
      // Extract Finnhub ticker from UA.D.{SYM}.CASH.IP, else treat epic as ticker
      const tickerMatch = resolvedEpic.match(/^UA\.D\.([A-Z0-9]+)\.CASH\.IP$/);
      const ticker = tickerMatch ? tickerMatch[1] : resolvedEpic;
      log('info', `[EXEC] Epic lookup: searching IG for "${ticker}"...`);
      const found = await resolveIgEpicForSymbol(ticker);
      if (!found) {
        log('error', `[EXEC] ✗ Epic NOT FOUND: "${ticker}" — symbol not tradeable on IG, skipping ${market.name}`);
        setScans(p => ({ ...p, [market.epic]: { ...p[market.epic]!, status:'error', error:`${ticker} not on IG` } }));
        return 'skipped';
      }
      log('info', `[EXEC] Epic resolved: ${ticker} → ${found}`);
      actualEpic = found;
    } else {
      log('info', `[EXEC] Validating epic: ${resolvedEpic}…`);
      const epicOk = await validateEpic(resolvedEpic);
      if (!epicOk) {
        log('error', `[EXEC] ✗ Epic INVALID: ${resolvedEpic} not available on ${accountId} (${accountType}) — skipping`);
        setScans(p => ({ ...p, [market.epic]: { ...p[market.epic]!, status:'error', error:`Epic not on ${accountType}` } }));
        return 'skipped';
      }
      log('info', `[EXEC] Epic valid: ${resolvedEpic}`);
    }

    // ── CFD: fetch live price and compute absolute SL/TP price levels ─────────
    let finalSize   = orderSize;
    let cfdStopLvl: number | undefined;
    let cfdLimitLvl: number | undefined;

    if (accountType === 'CFD') {
      // 1. Get current price: use stored price, or fetch live bid/offer from IG
      let currentPx = data.currentPrice ?? 0;
      if (!currentPx && sessionRef.current) {
        try {
          const mktR = await fetch(`/api/ig/markets/${encodeURIComponent(actualEpic)}`, {
            headers: makeHeaders(sessionRef.current, env),
          });
          const mktD = await mktR.json() as { ok: boolean; snapshot?: { bid?: number; offer?: number } };
          if (mktD.ok && mktD.snapshot) {
            currentPx = tradeDir === 'BUY'
              ? (mktD.snapshot.offer ?? mktD.snapshot.bid ?? 0)
              : (mktD.snapshot.bid  ?? mktD.snapshot.offer ?? 0);
          }
        } catch { /* use fallback */ }
      }
      log('info', `[EXEC] Market price: bid/offer fetch for ${actualEpic} → ${currentPx > 0 ? currentPx.toFixed(4) : 'UNKNOWN — will use fallback'}`);

      // 2. ATR-based stop/limit as absolute price levels
      const atr = data.atr14 ?? (stopDist / 1.5);  // derive ATR from distance if not stored
      if (currentPx > 0 && atr > 0) {
        const sl = tradeDir === 'BUY' ? currentPx - atr * 1.5 : currentPx + atr * 1.5;
        const tp = tradeDir === 'BUY' ? currentPx + atr * 3.0 : currentPx - atr * 3.0;
        cfdStopLvl  = Math.round(sl * 100) / 100;
        cfdLimitLvl = Math.round(tp * 100) / 100;
        log('info', `[EXEC] Stop level: ${cfdStopLvl} | Limit level: ${cfdLimitLvl} (ATR=${atr.toFixed(4)})`);
      } else {
        log('info', `[EXEC] No price/ATR — SL/TP levels omitted from order`);
      }

      // 3. Unit-based sizing
      finalSize = calcCfdUnits(currentPx > 0 ? currentPx : 100, data.market.marketType);
      log('info', `[EXEC] CFD units: ${finalSize} (price=${currentPx.toFixed(2)})`);
    }

    // Determine correct currency for this instrument
    const ccy = orderCurrency(market.name, actualEpic);

    const sizeLabel = accountType === 'CFD' ? `${finalSize} unit(s)` : `£${orderSize}/pt`;
    const slTpLabel = accountType === 'CFD' && cfdStopLvl !== undefined
      ? `SL @ ${cfdStopLvl} TP @ ${cfdLimitLvl}`
      : `SL ${stopDist}pt TP ${limitDist}pt`;
    log(tradeDir === 'BUY' ? 'buy' : 'sell',
      `[EXEC] Placing order: ${tradeDir} ${market.name} | ${actualEpic} | ${sizeLabel} | ${slTpLabel} | ${ccy} | ${strength}%`);
    const orderPayloadStr = accountType === 'CFD'
      ? `{ epic:"${actualEpic}", dir:"${tradeDir}", size:${finalSize}, stopLevel:${cfdStopLvl ?? 'none'}, limitLevel:${cfdLimitLvl ?? 'none'}, currency:"${ccy}" }`
      : `{ epic:"${actualEpic}", dir:"${tradeDir}", size:${orderSize}, stopDist:${stopDist}, limitDist:${limitDist}, currency:"${ccy}" }`;
    log('info', `[EXEC] Order payload: ${orderPayloadStr}`);

    const or = accountType === 'CFD'
      ? await placeOrder(actualEpic, tradeDir, finalSize, undefined, undefined, cfdStopLvl, cfdLimitLvl, ccy)
      : await placeOrder(actualEpic, tradeDir, orderSize, stopDist, limitDist, undefined, undefined, ccy);
    log('info', `[EXEC] IG response: ok=${or.ok} | status=${or.dealStatus ?? '-'} | reason=${or.reason ?? '-'} | ref=${or.dealReference ?? '-'} | err=${or.error ?? 'none'}`);

    if (or.ok) {
      scanCountersRef.current.traded++;
      log(tradeDir === 'BUY' ? 'buy' : 'sell',
        `[EXEC] ✅ SUCCESS — ${or.dealStatus ?? 'ACCEPTED'} | ref ${or.dealReference ?? 'n/a'} | dealId ${or.dealId ?? 'pending'} | fill @ ${or.level ?? '?'}`);
      showToast(true, `[${accountType}] ${tradeDir} ${market.name}`);
      setTradeHistory(prev => recordTradeOpen(prev, {
        portfolioName:strat.name, market:market.name, epic:resolvedEpic,
        direction:tradeDir, size:finalSize, entryLevel:or.level ?? 0,
        exitLevel:null, openedAt:new Date().toISOString(), closedAt:null,
        status:'OPEN', dealReference:or.dealReference ?? '', dealId:or.dealId ?? '',
        pnl:null, closeReason:null, accountType:env,
      }));
      await loadPositions();
      await loadWorkingOrders();
      return 'ok';
    } else {
      const errStr = (or.error ?? '').toLowerCase();
      if (errStr.includes('insufficient_funds') || errStr.includes('insufficient funds')) {
        log('error', `[EXEC] ❌ FAILED — Insufficient funds`);
        showToast(false, `⚠️ Insufficient funds`);
        return 'funds_low';
      }
      if ((or.reason ?? '').toUpperCase() === 'UNKNOWN' || errStr.includes('instrument_not_found') || errStr.includes('epic')) {
        const hint = accountType === 'CFD'
          ? `Epic mismatch? Sent "${actualEpic}" to CFD account.`
          : `Epic mismatch? Sent "${actualEpic}" to SPREADBET account.`;
        log('error', `[EXEC] ❌ ${hint}`);
      }
      // Log and continue — do NOT abort remaining opportunities
      log('error', `[EXEC] ❌ FAILED — ${market.name}: ${or.error ?? 'unknown reason'}`);
      if (or.reason)      log('error', `  reason: ${or.reason}`);
      if (or.sentPayload) log('error', `  sent: ${JSON.stringify(or.sentPayload)}`);
      if (or.igBody)      log('error', `  ig: ${JSON.stringify(or.igBody)}`);
      setTradeHistory(prev => recordTradeOpen(prev, {
        portfolioName:strat.name, market:market.name, epic:market.epic,
        direction:tradeDir, size:finalSize, entryLevel:0,
        exitLevel:null, openedAt:new Date().toISOString(), closedAt:new Date().toISOString(),
        status:'REJECTED', dealReference:'', dealId:'',
        pnl:null, closeReason:null, accountType:env,
      }));
      return 'skipped'; // failed but not a funds issue — try next
    }
  }

  // ── Thin wrapper for test scan (sequential, max-1-position path) ──────────
  async function scanMarket(strat: IGSavedStrategy, market: WatchlistMarket): Promise<StrategySignal|null> {
    const data = await getSignal(strat, market);
    if (!data) return null;
    if (strat.autoTrade) await executeTrade(strat, data);
    return data.sig;
  }

  // ── Signal scan ────────────────────────────────────────────────────────────
  const runSignalScan = useCallback(async (strat: IGSavedStrategy) => {
    if (!runningRef.current) return;

    // ── Part 7: Win rate check — pause if below 40% over last 20 trades ─────
    {
      const stats = computeStrategyStats(tradeHistory, strat.name);
      const wr20 = stats.s20.winRate;
      if (stats.s20 && stats.total >= 20 && wr20 < 0.40) {
        if (!performancePausedRef.current) {
          performancePausedRef.current = true;
          const msg = `🚨 Win rate ${(wr20*100).toFixed(0)}% over last 20 trades — trading paused. Review strategy settings.`;
          setPerfPauseAlert(msg);
          log('error', msg);
        }
        return; // skip entire scan cycle
      } else if (performancePausedRef.current && (stats.total < 20 || wr20 >= 0.40)) {
        performancePausedRef.current = false;
        setPerfPauseAlert(null);
        log('info', `✅ Win rate ${stats.total >= 20 ? `${(wr20*100).toFixed(0)}%` : 'insufficient data'} — trading resumed`);
      }
    }

    // ── Step 1: Market condition awareness ─────────────────────────────────
    const conditions = await checkMarketConditions();
    // Reset per-scan params first
    scanParamsRef.current = {
      sizeMultiplier:  portfolioAdjRef.current.sizeMultiplier,
      confidenceBoost: portfolioAdjRef.current.extraMinStrength,
      sectorAdjust:    0,
    };
    scanCountersRef.current = { traded: 0, skippedVolatile: 0, skippedConditions: 0 };

    if (conditions.vixHigh) {
      // High VIX: reduce size + log warning but DO NOT skip — opportunities exist in volatile markets
      scanParamsRef.current.sizeMultiplier = Math.min(scanParamsRef.current.sizeMultiplier, 0.5);
      log('info', `⚠️ VIX ${conditions.vix.toFixed(0)} > 30 — high volatility: position size halved, continuing scan`);
    }
    if (conditions.marketStressed) {
      scanParamsRef.current.sizeMultiplier = Math.min(scanParamsRef.current.sizeMultiplier, 0.5);
      log('info', `⚠️ Market stress — S&P ${conditions.spChange.toFixed(1)}% FTSE ${conditions.ftseChange.toFixed(1)}% | size ×0.5`);
    } else if (!conditions.vixHigh) {
      log('info', `✅ Market healthy — S&P ${conditions.spChange.toFixed(1)}% FTSE ${conditions.ftseChange.toFixed(1)}% VIX ${conditions.vix.toFixed(0)}`);
    }
    saveStrategy({ ...strat, lastRunAt: new Date().toISOString(), lastRunEnv: env });
    setStrategies(loadStrategiesForAccount());

    // ── Step 2: Build market list ─────────────────────────────────────────────
    // CFD: let Finnhub tell us what's moving today — no hardcoded list.
    // SPREADBET: use the watchlist as before.
    let markets: WatchlistMarket[] = [];
    type OppResult = { symbol: string; igEpic: string; changePercent: number; opportunityScore: number; direction: 'BUY'|'SELL' };

    if (accountType === 'CFD') {
      log('info', '🔭 CFD mode — screening full market via Finnhub…');
      try {
        const minMove = conditions.marketStressed ? 1.0 : 0.5; // raise bar when market is stressed
        const oppRes = await fetch(`/api/finnhub/opportunities?limit=20&minMove=${minMove}`);
        const oppData = await oppRes.json() as {
          ok: boolean; opportunities?: OppResult[]; screened?: number; note?: string;
        };
        if (oppData.ok && oppData.opportunities && oppData.opportunities.length > 0) {
          log('info', `  Screened ${oppData.screened ?? '?'} instruments — ${oppData.opportunities.length} opportunities found`);
          markets = oppData.opportunities.map(o => ({
            epic: o.igEpic, name: o.symbol, enabled: true, marketType: 'STOCK' as const,
          }));
        } else {
          log('info', `  No opportunities above threshold (${oppData.note ?? 'quiet market'}) — falling back to pinned`);
        }
      } catch (e) {
        log('error', `  Opportunities fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Always prepend pinned instruments (user-chosen, always scanned)
      const pinnedAsMarkets: WatchlistMarket[] = pinnedInstruments
        .filter(p => p.igEpic)
        .map(p => ({ epic: p.igEpic!, name: p.symbol.replace(/^[^:]+:/, ''), enabled: true, marketType: 'STOCK' as const }));
      const pinnedEpics = new Set(pinnedAsMarkets.map(m => m.epic));
      markets = [...pinnedAsMarkets, ...markets.filter(m => !pinnedEpics.has(m.epic))];

      if (markets.length === 0) {
        log('info', '  No markets to scan this cycle.');
      }
    } else {
      // SPREADBET: watchlist-based (unchanged)
      const baseWatchlist = strat.watchlist?.length ? strat.watchlist : defaultWatchlist;
      markets = baseWatchlist.filter(m => m.enabled);
    }

    const funds = await fetchIGFunds();
    // Capture starting balance once per strategy run
    if (!startingBalanceRef.current && funds?.balance) startingBalanceRef.current = funds.balance;
    if (funds) log('info', `💰 Available: £${funds.available.toFixed(2)} | Balance: £${funds.balance.toFixed(2)}`);
    log('info', `📡 Fetching signals for ${markets.length} markets in parallel…`);

    // ── Step 3: Fetch ALL signals in parallel — no artificial delays ────────
    setScanProgress(`Scanning ${markets.length} markets…`);
    const rawResults = await Promise.all(markets.map(m => getSignal(strat, m)));
    markets.forEach(m => recentlyScannedRef.current.add(m.name));

    const scanned = rawResults.filter(r => r !== null).length;

    // Build ranked list: tradeable signals sorted by strength (highest first)
    const tradeable = rawResults
      .filter((r): r is SignalData => r !== null)
      .sort((a, b) => b.strength - a.strength);

    const signalsFound = tradeable.length;
    log('info', `   ${scanned}/${markets.length} fetched | ${signalsFound} tradeable signals ranked by confidence`);

    // ── Step 4: Execute trades sequentially — 1 per second ─────────────────
    if (!strat.autoTrade) {
      log('info', `ℹ️ autoTrade is OFF — signals found but not executing. Enable Auto-Trade in strategy settings.`);
    } else if (tradeable.length === 0) {
      log('info', `ℹ️ No tradeable signals above threshold this cycle`);
    } else {
      log('info', `⚡ Executing ${tradeable.length} opportunit${tradeable.length===1?'y':'ies'} in order…`);
      // Log all ranked signals upfront so we can see what's being attempted
      tradeable.forEach((d, i) => {
        log('info', `  [EXEC] #${i+1}: ${d.market.name} | ${d.direction} | Score: ${d.strength}% | Epic: ${d.resolvedEpic}`);
      });

      for (let idx = 0; idx < tradeable.length; idx++) {
        const data = tradeable[idx];
        const isTopSignal = idx === 0;

        if (!runningRef.current) {
          log('info', `[EXEC] ⛔ Strategy stopped mid-execution — aborting queue`);
          break;
        }

        log('info', `[EXEC] ▶ Starting #${idx+1}/${tradeable.length}: ${data.market.name} | ${data.direction} | ${data.strength}%${isTopSignal ? ' [TOP SIGNAL — force-attempt]' : ''}`);
        setScanProgress(`Trading ${data.market.name}…`);

        let result: 'ok'|'funds_low'|'skipped';
        try {
          result = await executeTrade(strat, data, isTopSignal);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log('error', `[EXEC] ❌ EXCEPTION in executeTrade for ${data.market.name}: ${msg}`);
          result = 'skipped';
        }

        log('info', `[EXEC] ✔ Result for ${data.market.name}: ${result.toUpperCase()}`);
        if (result === 'funds_low') {
          log('info', `${acctTag} 🔴 Funds too low — stopping execution queue`);
          break;
        }
        await sleep(1000); // 1s between executions to respect IG rate limits
      }
    }
    setScanProgress('');

    // ── Step 5: Scan summary ───────────────────────────────────────────────
    const openCount = positionsRef.current.length;
    const totalPnL  = positionsRef.current.reduce((s, p) => s + (p.upl ?? 0), 0);
    const { traded, skippedVolatile, skippedConditions } = scanCountersRef.current;
    setScanStats({ scanned, signals: signalsFound, traded, skippedVolatile, skippedConditions, lastScanAt: new Date().toISOString() });
    log('info', `📊 Scan done — ${scanned} scanned | ${signalsFound} signals | ${traded} traded | ${skippedVolatile} volatile`);
    log('info', `   Open positions: ${openCount} | Total P&L: ${totalPnL >= 0 ? '+' : ''}£${Math.abs(totalPnL).toFixed(2)}`);
    const nextMs = strat.signalScanMs ?? signalScanMs;
    const nextLabel = nextMs < 60_000 ? `${Math.round(nextMs/1000)}s` : `${Math.round(nextMs/60_000)}min`;
    log('info', `   Next scan in ${nextLabel}`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, positions, signalScanMs, navLoaded, navCategories]);

  // ── Position monitor ───────────────────────────────────────────────────────
  const runPositionMonitor = useCallback(async (strat: IGSavedStrategy) => {
    if (!runningRef.current) return;
    await loadPositions();
    const allPos = positionsRef.current;

    // ── Part 4: Portfolio-level checks ────────────────────────────────────────
    const totalUpl = allPos.reduce((s, p) => s + (p.upl ?? 0), 0);
    const totalBal = igFundsRef.current?.balance ?? 0;
    const portfolioValue = totalBal + totalUpl;

    if (portfolioValue > peakPortfolioRef.current) peakPortfolioRef.current = portfolioValue;
    const drawdownPct = peakPortfolioRef.current > 0
      ? ((peakPortfolioRef.current - portfolioValue) / peakPortfolioRef.current) * 100 : 0;
    if (drawdownPct > 3) {
      portfolioAdjRef.current.sizeMultiplier = 0.5;
      portfolioAdjRef.current.extraMinStrength = 0;
      log('info', `${acctTag} ⚠️ Portfolio down ${drawdownPct.toFixed(1)}% from peak — next cycle size ×0.5`);
    } else if (startingBalanceRef.current > 0 && totalUpl > startingBalanceRef.current * 0.05) {
      portfolioAdjRef.current.extraMinStrength = 10; // raise bar when doing well
      portfolioAdjRef.current.sizeMultiplier   = 1.0;
      log('info', `${acctTag} 🎯 Portfolio up >5% — raising confidence threshold +10% to protect gains`);
    } else {
      portfolioAdjRef.current = { sizeMultiplier: 1.0, extraMinStrength: 0 };
    }

    // Sector concentration: > 3 positions in one sector → close weakest
    const sectorMap: Record<string, IGPosition[]> = {};
    for (const p of allPos) {
      const sec = getSector(p.epic);
      (sectorMap[sec] ??= []).push(p);
    }
    for (const [sec, posInSec] of Object.entries(sectorMap)) {
      if (posInSec.length > 3) {
        const weakest = [...posInSec].sort((a, b) => (a.upl ?? 0) - (b.upl ?? 0))[0];
        log('close', `${acctTag} ♻️ Sector ${sec} has ${posInSec.length} positions — diversifying, closing weakest: ${weakest.instrumentName ?? weakest.epic}`);
        const cr = await closePos(weakest);
        if (cr.ok) {
          const exitPx = weakest.direction === 'BUY' ? (weakest.bid ?? weakest.level) : (weakest.offer ?? weakest.level);
          setTradeHistory(prev => recordTradeClose(prev, weakest.dealId, exitPx, weakest.upl ?? 0, 'STRATEGY', new Date().toISOString()));
        }
        break; // one per cycle to avoid over-closing
      }
    }

    // ── Per-position management ────────────────────────────────────────────────
    for (const pos of positionsRef.current) {
      if (!pos.level || !pos.bid || !pos.offer) continue;
      const currentPx = pos.direction === 'BUY' ? pos.bid : pos.offer;
      const entryPx   = pos.level;
      const pnlPct    = pos.direction === 'BUY'
        ? ((currentPx - entryPx) / entryPx) * 100
        : ((entryPx - currentPx) / entryPx) * 100;

      // Stale recycling — 24h with < 0.5% profit (Part 3)
      if (pos.createdDate && strat.autoClose) {
        const ageMs = Date.now() - new Date(pos.createdDate).getTime();
        if (ageMs > 24 * 3_600_000 && pnlPct < 0.5) {
          log('close', `${acctTag} ♻️ Stale 24h+: ${pos.instrumentName ?? pos.epic} (${pnlPct.toFixed(2)}% P&L) — freeing capital`);
          const cr = await closePos(pos);
          if (cr.ok) {
            const exitPx = pos.direction === 'BUY' ? (pos.bid ?? currentPx) : (pos.offer ?? currentPx);
            setTradeHistory(prev => recordTradeClose(prev, pos.dealId, exitPx, pos.upl ?? 0, 'STALE', new Date().toISOString()));
          } else log('error', `${acctTag} Stale close failed: ${cr.error ?? 'unknown'}`);
          continue;
        }
      }

      // Fetch indicators (cached 30 min — near-zero cost)
      const ind = await fetchIndicators(pos.instrumentName ?? pos.epic, pos.epic).catch(() => null);

      // Compute and cache health score
      const health = computePositionHealth(pos, ind, pnlPct);
      setPositionHealth(prev => ({ ...prev, [pos.dealId]: health }));

      const isSpreadbet = strat.timeframe === 'spreadbet';

      // ── Always track best price for 30% retrace rule ─────────────────────
      if (!trailingBestPriceRef.current[pos.dealId]) {
        trailingBestPriceRef.current[pos.dealId] = currentPx;
      }
      const prevBest = trailingBestPriceRef.current[pos.dealId];
      trailingBestPriceRef.current[pos.dealId] = pos.direction === 'BUY'
        ? Math.max(prevBest, currentPx)
        : Math.min(prevBest, currentPx);
      const bestPrice = trailingBestPriceRef.current[pos.dealId];

      // Part 3 early exit rules (spreadbet strategy)
      if (strat.autoClose && isSpreadbet && ind) {
        const pName = pos.instrumentName ?? pos.epic;

        // (a) VWAP cross against position (only close if profitable — avoid false exits)
        if (pnlPct > 0.5) {
          const vwapAgainst = (pos.direction === 'BUY' && ind.vwapDeviation < -0.3) ||
                              (pos.direction === 'SELL' && ind.vwapDeviation > 0.3);
          if (vwapAgainst && health === 'red') {
            log('close', `${acctTag} 📉 VWAP crossed against ${pos.direction} (dev ${ind.vwapDeviation.toFixed(2)}%) — ${pName}`);
            const cr = await closePos(pos);
            if (cr.ok) {
              const exitPx = pos.direction === 'BUY' ? (pos.bid ?? currentPx) : (pos.offer ?? currentPx);
              setTradeHistory(prev => recordTradeClose(prev, pos.dealId, exitPx, pos.upl ?? 0, 'STRATEGY', new Date().toISOString()));
            }
            continue;
          }
        }

        // (b) EMA cross against position direction
        const emaAgainst = (pos.direction === 'BUY' && ind.emaCross === 'bearish') ||
                           (pos.direction === 'SELL' && ind.emaCross === 'bullish');
        if (emaAgainst && health === 'red') {
          log('close', `${acctTag} 📉 EMA crossed against ${pos.direction} position — ${pName}`);
          const cr = await closePos(pos);
          if (cr.ok) {
            const exitPx = pos.direction === 'BUY' ? (pos.bid ?? currentPx) : (pos.offer ?? currentPx);
            setTradeHistory(prev => recordTradeClose(prev, pos.dealId, exitPx, pos.upl ?? 0, 'STRATEGY', new Date().toISOString()));
          }
          continue;
        }

        // (c) MACD histogram shrinking for 2 consecutive candles after being profitable
        if (pnlPct > 1) {
          const h0 = ind.macdHistogram;
          const h1 = ind.macdHistPrev1;
          const h2 = ind.macdHistPrev2;
          const histShrinkLong  = pos.direction === 'BUY'  && h2 > h1 && h1 > h0 && h0 > 0;
          const histShrinkShort = pos.direction === 'SELL' && h2 < h1 && h1 < h0 && h0 < 0;
          if ((histShrinkLong || histShrinkShort) && health !== 'green') {
            log('close', `${acctTag} 📉 MACD momentum fading (hist: ${h2.toFixed(3)} → ${h1.toFixed(3)} → ${h0.toFixed(3)}) — ${pName} at +${pnlPct.toFixed(2)}%`);
            const cr = await closePos(pos);
            if (cr.ok) {
              const exitPx = pos.direction === 'BUY' ? (pos.bid ?? currentPx) : (pos.offer ?? currentPx);
              setTradeHistory(prev => recordTradeClose(prev, pos.dealId, exitPx, pos.upl ?? 0, 'STRATEGY', new Date().toISOString()));
            }
            continue;
          }
        }

        // (d) 30% retrace from peak profit → close and take profits
        const profitFromEntry = pos.direction === 'BUY'
          ? bestPrice - entryPx
          : entryPx - bestPrice;
        const retraceFromPeak = pos.direction === 'BUY'
          ? bestPrice - currentPx
          : currentPx - bestPrice;
        if (profitFromEntry > 0 && retraceFromPeak > profitFromEntry * 0.30 && pnlPct > 0.5) {
          log('close', `${acctTag} 📉 30% retrace from peak (retrace ${retraceFromPeak.toFixed(2)}pt / peak ${profitFromEntry.toFixed(2)}pt) — ${pName} at +${pnlPct.toFixed(2)}%`);
          const cr = await closePos(pos);
          if (cr.ok) {
            const exitPx = pos.direction === 'BUY' ? (pos.bid ?? currentPx) : (pos.offer ?? currentPx);
            setTradeHistory(prev => recordTradeClose(prev, pos.dealId, exitPx, pos.upl ?? 0, 'STRATEGY', new Date().toISOString()));
          }
          continue;
        }
      }

      // RSI reversal exit — tighter thresholds for spreadbet (70/30 vs 60/40 default)
      if (strat.autoClose && ind) {
        const rsiLongLimit  = isSpreadbet ? 70 : 60;
        const rsiShortLimit = isSpreadbet ? 30 : 40;
        const rsiReversed =
          (pos.direction === 'BUY'  && ind.rsi14 > rsiLongLimit) ||
          (pos.direction === 'SELL' && ind.rsi14 < rsiShortLimit);
        if (rsiReversed && health === 'red') {
          log('close', `${acctTag} 📉 RSI ${isSpreadbet ? 'extreme' : 'reversal'} (${ind.rsi14.toFixed(0)}) — ${pos.instrumentName ?? pos.epic} health RED → closing`);
          const cr = await closePos(pos);
          if (cr.ok) {
            const exitPx = pos.direction === 'BUY' ? (pos.bid ?? currentPx) : (pos.offer ?? currentPx);
            setTradeHistory(prev => recordTradeClose(prev, pos.dealId, exitPx, pos.upl ?? 0, 'STRATEGY', new Date().toISOString()));
          }
          continue;
        }
      }

      // Trailing stop management (Part 1) — bestPrice already updated above
      if (trailingStops.has(pos.dealId)) {
        const trailDist = bestPrice * 0.015; // 1.5% trailing distance
        const trailStop = pos.direction === 'BUY'
          ? Math.round((bestPrice - trailDist) * 100) / 100
          : Math.round((bestPrice + trailDist) * 100) / 100;
        if (!pos.stopLevel || (pos.direction === 'BUY' ? trailStop > pos.stopLevel : trailStop < pos.stopLevel)) {
          const tr = await updatePositionSL(pos, trailStop, pos.limitLevel ?? null);
          if (tr.ok) log('info', `${acctTag} 🎯 Trail stop → ${trailStop} (${pos.instrumentName ?? pos.epic})`);
        }
      }

      // SL management — profit protection rules (Part 3)
      let newStop: number | null = null, reason = '';

      if (pos.limitLevel && entryPx) {
        const tpDist  = Math.abs(pos.limitLevel - entryPx);
        const curDist = pos.direction === 'BUY' ? currentPx - entryPx : entryPx - currentPx;
        const pctToTp = tpDist > 0 ? curDist / tpDist : 0;

        if (pctToTp >= 0.75) {
          // 75% toward TP — lock in 50% of profit distance
          const lockLevel = pos.direction === 'BUY'
            ? entryPx + tpDist * 0.50
            : entryPx - tpDist * 0.50;
          const lockRounded = Math.round(lockLevel * 100) / 100;
          if (!pos.stopLevel || (pos.direction === 'BUY' ? lockRounded > pos.stopLevel : lockRounded < pos.stopLevel)) {
            newStop = lockRounded;
            reason  = `${(pctToTp * 100).toFixed(0)}% to TP → SL locks 50% profit`;
          }
        } else if (pctToTp >= 0.5) {
          // 50% toward TP — move to breakeven
          const be = entryPx;
          if (!pos.stopLevel || (pos.direction === 'BUY' ? pos.stopLevel < be : pos.stopLevel > be)) {
            newStop = be;
            reason  = `${(pctToTp * 100).toFixed(0)}% to TP → SL to breakeven`;
          }
        }
      } else {
        // No TP: P&L % thresholds
        if (pnlPct >= 5) {
          const lock = pos.direction === 'BUY' ? entryPx * 1.02 : entryPx * 0.98;
          if (!pos.stopLevel || (pos.direction === 'BUY' ? pos.stopLevel < lock : pos.stopLevel > lock)) { newStop = Math.round(lock * 100) / 100; reason = `+${pnlPct.toFixed(1)}% → SL lock +2%`; }
        } else if (pnlPct >= 3) {
          const be = entryPx;
          if (!pos.stopLevel || (pos.direction === 'BUY' ? pos.stopLevel < be : pos.stopLevel > be)) { newStop = be; reason = `+${pnlPct.toFixed(1)}% → SL to breakeven`; }
        }
      }

      if (newStop !== null) {
        const r = await updatePositionSL(pos, newStop, pos.limitLevel ?? null);
        if (r.ok) log('info', `${acctTag} 🔒 ${pos.instrumentName ?? pos.epic}: ${reason}`);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, positions, trailingStops]);

  // ── Start / stop ───────────────────────────────────────────────────────────
  function startAutoRun(strat: IGSavedStrategy) {
    if (timerRef.current)    clearInterval(timerRef.current);
    if (posTimerRef.current) clearInterval(posTimerRef.current);
    runningRef.current = true; setIsRunning(true);
    startingBalanceRef.current = 0; // will be captured on first funds fetch
    const sScanMs = strat.signalScanMs ?? signalScanMs;
    const pMonMs  = strat.posMonitorMs ?? posMonitorMs;
    const sScanLabel = sScanMs < 60_000 ? `${Math.round(sScanMs/1000)}s` : `${Math.round(sScanMs/60_000)}min`;
    const pMonLabel  = pMonMs  < 60_000 ? `${Math.round(pMonMs/1000)}s`  : `${Math.round(pMonMs/60_000)}min`;
    log('info', `▶ Auto-trader started — "${strat.name}" · ${accountType} | ${accountId} · scan ${sScanLabel} · monitor ${pMonLabel}`);
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

  // ── Inline SL/TP handlers ─────────────────────────────────────────────────
  async function handleInlineSL(pos: IGPosition) {
    const raw = inlineSLEdit[pos.dealId];
    if (raw === undefined) return;
    const val = parseFloat(raw);
    setInlineSLEdit(p => { const n = { ...p }; delete n[pos.dealId]; return n; });
    if (isNaN(val) || val <= 0) return;
    setUpdatingPos(pos.dealId);
    const r = await updatePositionSL(pos, val, pos.limitLevel ?? null);
    if (r.ok) { showToast(true, `SL → ${val}`); await loadPositions(); }
    else showToast(false, r.error ?? 'SL update failed');
    setUpdatingPos(null);
  }

  async function handleInlineTP(pos: IGPosition) {
    const raw = inlineTPEdit[pos.dealId];
    if (raw === undefined) return;
    const val = parseFloat(raw);
    setInlineTPEdit(p => { const n = { ...p }; delete n[pos.dealId]; return n; });
    if (isNaN(val) || val <= 0) return;
    setUpdatingPos(pos.dealId);
    const r = await updatePositionSL(pos, pos.stopLevel ?? null, val);
    if (r.ok) { showToast(true, `TP → ${val}`); await loadPositions(); }
    else showToast(false, r.error ?? 'TP update failed');
    setUpdatingPos(null);
  }

  // ── Trailing stop toggle ───────────────────────────────────────────────────
  function toggleTrailingStop(dealId: string) {
    setTrailingStops(prev => {
      const next = new Set(prev);
      if (next.has(dealId)) next.delete(dealId); else next.add(dealId);
      try { localStorage.setItem('ig_trailing_stops', JSON.stringify([...next])); } catch {}
      return next;
    });
  }

  // ── Close all positions ────────────────────────────────────────────────────
  async function handleCloseAll() {
    setClosingAll(true);
    const toClose = [...positionsRef.current];
    for (const pos of toClose) {
      const r = await closePos(pos);
      if (r.ok) {
        const exitPx = pos.direction === 'BUY' ? (pos.bid ?? pos.level) : (pos.offer ?? pos.level);
        setTradeHistory(prev => recordTradeClose(prev, pos.dealId, exitPx, pos.upl ?? 0, 'MANUAL', new Date().toISOString()));
        log('close', `${acctTag} ✅ Closed ${pos.instrumentName ?? pos.epic} — Manual close-all`);
      } else {
        log('error', `${acctTag} Close-all: ${pos.instrumentName ?? pos.epic} failed — ${r.error ?? 'unknown'}`);
      }
    }
    await loadPositions();
    setClosingAll(false);
    setShowCloseAllConfirm(false);
    showToast(true, `Closed ${toClose.length} position(s)`);
  }

  // ── Builder ────────────────────────────────────────────────────────────────
  function openBuilder(existing?: IGSavedStrategy) {
    if (existing) {
      setEditId(existing.id); setBName(existing.name); setBTimeframe(existing.timeframe);
      setBSize(existing.size); setBMaxPos(existing.maxPositions);
      setBMinStrength(existing.minStrength ?? 55); setBAutoClose(existing.autoClose ?? true);
      setBWatchlist(existing.watchlist?.length ? existing.watchlist : [...defaultWatchlist]);
      setBSignalScanMs(existing.signalScanMs ?? 60_000); setBPosMonitorMs(existing.posMonitorMs ?? 30_000);
    } else {
      setEditId(null); setBName(''); setBTimeframe('daily'); setBSize(1); setBMaxPos(0);
      setBMinStrength(MIN_STRENGTH[accountType]); setBAutoClose(true);
      setBWatchlist([...defaultWatchlist]); setBSignalScanMs(60_000); setBPosMonitorMs(30_000);
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

    diag('\nSTEP 2 — Session for ' + accountId + ' (using cached token if valid)');
    let cst = '', secToken = '';
    try {
      // Re-use the existing cached session — do NOT force a fresh login.
      // Only hit IG if the stored token is expired or missing.
      const loginRes = await igQueue.enqueue(() => fetch('/api/ig/session', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(creds
          ? { username:creds.username, password:creds.password, apiKey:creds.apiKey, env, forceRefresh:false, targetAccountId:accountId }
          : { env, forceRefresh:false, useEnvCredentials:true, targetAccountId:accountId }),
      }), accountId);
      const d = await loginRes.json() as {
        ok:boolean; cst?:string; securityToken?:string; accountId?:string;
        accountType?:string; error?:string; confirmedAccountId?:string;
        accounts?:{accountId:string;accountType:string}[];
      };
      diag(`  ← HTTP ${loginRes.status}`);
      if (!d.ok || !d.cst) {
        diag(`  ✗ FAILED: ${d.error ?? 'unknown'}`);
        if (d.confirmedAccountId) diag(`  ℹ️ IG confirmed active account is ${d.confirmedAccountId} (switch rejected)`);
        setTestOrderBusy(false); return;
      }
      cst = d.cst; secToken = d.securityToken ?? '';
      diag(`  ✓ CST: "${cst.slice(0,12)}…"`);
      diag(`  ✓ accountId: ${d.accountId ?? '(empty)'} | accountType: ${d.accountType ?? '(empty)'}`);
      if (d.accounts?.length) diag(`  ℹ️ Accounts: ${d.accounts.map(a=>`${a.accountId}(${a.accountType})`).join(', ')}`);
      if (d.accountId !== accountId) {
        diag(`  ✗ Expected ${accountId} but got ${d.accountId ?? 'empty'} — account switch failed`);
        diag(`  ℹ️ Check server logs for the exact PUT /session response code`);
        setTestOrderBusy(false); return;
      }
      diag(`  ✓ Account confirmed: ${d.accountId} [${d.accountType}]`);
      // Propagate fresh tokens to the central store so positions panel uses them immediately
      const apiKeyForStore = creds?.apiKey ?? '';
      storeSession({ cst, securityToken: secToken, accountId: d.accountId ?? accountId, apiKey: apiKeyForStore, accountType: d.accountType ?? accountType });
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
          {loginCooldown ? (
            <div className="mb-3 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg">
              <p className="text-xs text-red-400">🚫 {loginCooldown}</p>
            </div>
          ) : (
            <p className="text-xs text-gray-400 mb-3">
              Not connected. Add IG credentials in{' '}
              <a href="/settings/accounts" className="text-orange-400 hover:underline">Settings → Accounts</a>{' '}
              or ensure <code className="text-xs bg-gray-800 px-1 rounded">IG_USERNAME</code> env var is set.
            </p>
          )}
          <Button size="sm" disabled={loginBlockedUntilRef.current > Date.now()}
            onClick={() => { setConnecting(true); connectForAccount(true).then(s => { if (s) storeSession(s); setConnecting(false); }); }}>
            {loginBlockedUntilRef.current > Date.now() ? 'Cooling down…' : 'Reconnect'}
          </Button>
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

      {/* Close All confirmation modal */}
      {showCloseAllConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-5 w-full max-w-sm shadow-2xl">
            <h3 className="text-sm font-semibold text-white mb-1">Close All Positions</h3>
            <p className="text-xs text-gray-400 mb-3">This will immediately close all {positions.length} open position(s) at market price.</p>
            <div className={clsx('rounded-lg px-3 py-2 mb-4 text-sm font-mono font-bold text-center',
              totalPnL >= 0 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400')}>
              Current P&L: {totalPnL >= 0 ? '+' : ''}{fmt(totalPnL)}
            </div>
            <div className="flex gap-2">
              <Button fullWidth variant="outline" onClick={() => setShowCloseAllConfirm(false)}>Cancel</Button>
              <Button fullWidth loading={closingAll}
                className="bg-red-600/20 text-red-400 border border-red-600/40 hover:bg-red-600/30"
                onClick={() => void handleCloseAll()}>
                Close All Now
              </Button>
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
                <label className="text-xs text-gray-400 mb-1.5 block">Max positions <span className="text-gray-600">(0 = unlimited)</span></label>
                <input type="number" min={0} max={50} value={bMaxPos} onChange={e => setBMaxPos(Number(e.target.value))}
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
                  <option value={30_000}>30 seconds</option>
                  <option value={60_000}>60 seconds</option>
                  <option value={2*60_000}>2 minutes</option>
                  <option value={5*60_000}>5 minutes</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Position monitor interval</label>
                <select value={bPosMonitorMs} onChange={e => setBPosMonitorMs(Number(e.target.value))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500">
                  <option value={30_000}>30 seconds</option>
                  <option value={60_000}>60 seconds</option>
                  <option value={2*60_000}>2 minutes</option>
                  <option value={5*60_000}>5 minutes</option>
                </select>
              </div>
            </div>

            {/* Watchlist */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2">
                  {/* Header toggle-all checkbox */}
                  <button
                    onClick={() => {
                      const allOn = bWatchlist.every(m => m.enabled);
                      setBWatchlist(p => p.map(x => ({ ...x, enabled: !allOn })));
                    }}
                    className={clsx('w-4 h-4 rounded flex items-center justify-center flex-shrink-0 transition-all',
                      bWatchlist.length > 0 && bWatchlist.every(m => m.enabled) ? 'bg-orange-500' :
                      bWatchlist.some(m => m.enabled) ? 'bg-orange-500/50' : 'bg-gray-700 border border-gray-600'
                    )}
                    title="Toggle all">
                    {bWatchlist.some(m => m.enabled) && <span className="text-white text-[8px] font-bold">✓</span>}
                  </button>
                  <label className="text-xs text-gray-400">Markets to scan</label>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => setBWatchlist(p => p.map(x => ({ ...x, enabled: true })))}
                    className="text-[10px] text-orange-400 hover:text-orange-300 transition-colors">Select all</button>
                  <span className="text-gray-700">·</span>
                  <button onClick={() => setBWatchlist(p => p.map(x => ({ ...x, enabled: false })))}
                    className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors">Deselect all</button>
                  <span className="text-[10px] text-gray-600 ml-1">{bWatchlist.filter(m=>m.enabled).length}/{bWatchlist.length} enabled</span>
                </div>
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
                {session && isCFD && (
                  <button
                    onClick={() => { if (!navLoaded) void loadIGMarkets(); setNavLoaded(p => { if (!p) void loadIGMarkets(); return p; }); }}
                    disabled={navLoading}
                    className="text-[10px] px-2.5 py-1.5 bg-blue-900/40 border border-blue-700/40 rounded-lg text-blue-400 hover:text-blue-200 transition-colors disabled:opacity-50">
                    {navLoading ? '⌛ Loading from IG…' : navLoaded ? '🔄 Reload IG markets' : '🌐 Browse all IG markets'}
                  </button>
                )}
                {session && (
                  <div className="w-full mt-1">
                    <p className="text-[10px] text-gray-500 mb-1.5">Add any market:</p>
                    <MarketSearch session={session} env={env} onSelect={m => { if (!bWatchlist.some(x=>x.epic===m.epic)) setBWatchlist(p=>[...p,{epic:m.epic,name:m.instrumentName,enabled:true}]); }} />
                  </div>
                )}
              </div>

              {/* ── Dynamic IG market browser ──────────────────────────────── */}
              {navLoaded && navCategories.length > 0 && (
                <div className="mt-3 border border-gray-700 rounded-xl overflow-hidden">
                  <div className="bg-gray-800/60 px-3 py-2 flex items-center justify-between">
                    <p className="text-[11px] font-semibold text-gray-300">IG Markets — select to add to watchlist</p>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-gray-500">{navSelectedEpics.size} selected</span>
                      {navSelectedEpics.size > 0 && (
                        <button
                          onClick={() => {
                            setBWatchlist(prev => {
                              const ex = new Set(prev.map(x => x.epic));
                              const toAdd: WatchlistMarket[] = [];
                              navCategories.forEach(cat => {
                                cat.markets.forEach(m => {
                                  if (navSelectedEpics.has(m.epic) && !ex.has(m.epic)) {
                                    const mType = m.instrumentType.includes('SHARE') || m.instrumentType.includes('STOCK') ? 'STOCK' as const
                                      : m.instrumentType.includes('INDIC') ? 'INDEX' as const
                                      : m.instrumentType.includes('CURRENC') ? 'FOREX' as const
                                      : m.instrumentType.includes('COMMODI') ? 'COMMODITY' as const
                                      : m.instrumentType.includes('CRYPTO') || m.instrumentType.includes('BITC') ? 'CRYPTO' as const
                                      : 'COMMODITY' as const;
                                    toAdd.push({ epic: m.epic, name: m.instrumentName, enabled: true, marketType: mType });
                                  }
                                });
                              });
                              return [...prev, ...toAdd];
                            });
                            setNavSelectedEpics(new Set());
                          }}
                          className="text-[10px] px-2.5 py-1 bg-orange-500/20 border border-orange-500/30 rounded-lg text-orange-400 hover:bg-orange-500/30 font-semibold transition-colors">
                          + Add {navSelectedEpics.size} to watchlist
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="max-h-72 overflow-y-auto divide-y divide-gray-800/50">
                    {navCategories.map((cat, ci) => (
                      <div key={cat.node.id}>
                        {/* Category header */}
                        <div className="flex items-center gap-2 px-3 py-2 bg-gray-800/30 sticky top-0 z-10">
                          <button
                            onClick={() => setNavCategories(p => p.map((c,i) => i===ci ? {...c, expanded:!c.expanded} : c))}
                            className="flex items-center gap-1.5 flex-1 text-left">
                            <ChevronDown className={clsx('h-3 w-3 text-gray-500 transition-transform', cat.expanded && 'rotate-180')} />
                            <span className="text-[11px] font-semibold text-gray-300">{cat.node.name}</span>
                            <span className="text-[10px] text-gray-600">({cat.markets.length})</span>
                          </button>
                          <button
                            onClick={() => {
                              const epics = cat.markets.map(m => m.epic);
                              const allSelected = epics.every(e => navSelectedEpics.has(e));
                              setNavSelectedEpics(prev => {
                                const next = new Set(prev);
                                if (allSelected) { epics.forEach(e => next.delete(e)); }
                                else { epics.forEach(e => next.add(e)); }
                                return next;
                              });
                            }}
                            className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors">
                            {cat.markets.every(m => navSelectedEpics.has(m.epic)) ? 'deselect all' : 'select all'}
                          </button>
                        </div>
                        {/* Markets within category */}
                        {cat.expanded && (
                          <div className="divide-y divide-gray-800/30">
                            {cat.markets.map(m => {
                              const sel = navSelectedEpics.has(m.epic);
                              const already = bWatchlist.some(w => w.epic === m.epic);
                              return (
                                <div key={m.epic}
                                  onClick={() => {
                                    if (already) return;
                                    setNavSelectedEpics(prev => {
                                      const next = new Set(prev);
                                      if (sel) next.delete(m.epic); else next.add(m.epic);
                                      return next;
                                    });
                                  }}
                                  className={clsx('flex items-center gap-2 px-4 py-1.5 text-xs cursor-pointer transition-colors',
                                    already ? 'opacity-40 cursor-default' : sel ? 'bg-orange-500/10' : 'hover:bg-gray-800/40')}>
                                  <div className={clsx('w-3.5 h-3.5 rounded flex-shrink-0 flex items-center justify-center',
                                    already ? 'bg-emerald-600/30 border border-emerald-600/40' : sel ? 'bg-orange-500' : 'bg-gray-700 border border-gray-600')}>
                                    {(sel || already) && <span className="text-white text-[8px] font-bold">✓</span>}
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <span className={clsx('truncate', sel ? 'text-orange-300' : already ? 'text-emerald-400' : 'text-gray-300')}>
                                      {m.instrumentName}
                                    </span>
                                    {already && <span className="ml-1 text-[9px] text-emerald-600">in watchlist</span>}
                                  </div>
                                  <span className="text-[9px] text-gray-600 font-mono truncate max-w-[90px]">{m.epic}</span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
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
                          {strat.timeframe} · {strat.size}{sizeUnit} · min {strat.minStrength}% · {strat.maxPositions > 0 ? `max ${strat.maxPositions} pos` : 'unlimited pos'}
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

      {/* ── Finnhub Market Scanner ─────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Market Scanner"
          subtitle="Finnhub universe · Yahoo Finance signals"
          icon={<Target className="h-4 w-4" />}
          action={
            <div className="flex items-center gap-2">
              {finnhubLastScan && <span className="text-[10px] text-gray-500">Last: {finnhubLastScan}</span>}
              <Button size="sm" loading={finnhubLoading}
                icon={<RefreshCw className="h-3 w-3" />}
                onClick={() => void loadFinnhubScreener(finnhubCategory)}>
                Scan
              </Button>
            </div>
          }
        />

        {/* Category tabs + search */}
        <div className="flex flex-wrap gap-1 mb-2 items-center">
          {(['US_STOCK','UK_STOCK','FOREX','CRYPTO'] as FinnhubCategory[]).map(cat => (
            <button key={cat}
              onClick={() => { setFinnhubCategory(cat); void loadFinnhubScreener(cat); }}
              className={clsx('px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all',
                finnhubCategory === cat
                  ? 'bg-orange-500/20 text-orange-300 border border-orange-500/30'
                  : 'text-gray-500 hover:text-gray-300 border border-transparent hover:border-gray-700'
              )}>
              {FINNHUB_CATEGORY_LABELS[cat]}
            </button>
          ))}
        </div>
        {/* Instrument search */}
        <div className="flex gap-2 mb-3">
          <input value={finnhubSearch} onChange={e => setFinnhubSearch(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && void searchFinnhubSymbol(finnhubSearch)}
            placeholder="Search any ticker (AAPL, BARC.L, OANDA:GBP_USD…)"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-[11px] text-white placeholder-gray-600 focus:outline-none focus:border-orange-500" />
          <Button size="sm" loading={finnhubSearchBusy}
            icon={<Search className="h-3 w-3" />}
            onClick={() => void searchFinnhubSymbol(finnhubSearch)}>Find</Button>
        </div>

        {/* Pinned instruments */}
        {pinnedInstruments.length > 0 && (
          <div className="mb-3 p-2 bg-orange-950/20 border border-orange-900/30 rounded-lg">
            <p className="text-[10px] text-orange-400 font-semibold mb-1.5">📌 Pinned (always scanned)</p>
            <div className="flex flex-wrap gap-1">
              {pinnedInstruments.map(p => (
                <div key={p.symbol} className="flex items-center gap-1 bg-gray-800 rounded px-2 py-0.5">
                  <span className="text-[10px] font-mono text-white">{p.symbol.replace(/^[^:]+:/, '')}</span>
                  {p.direction && p.direction !== 'NEUTRAL' && <DirectionBadge dir={p.direction} size="xs" />}
                  <button onClick={() => unpinInstrument(p.symbol)} className="text-gray-600 hover:text-red-400 ml-0.5"><X className="h-2.5 w-2.5" /></button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Table */}
        {finnhubRows.length === 0 && !finnhubLoading && (
          <p className="text-center text-gray-600 text-xs py-6">
            Press Scan to load top movers for {FINNHUB_CATEGORY_LABELS[finnhubCategory]}
          </p>
        )}

        {(finnhubRows.length > 0 || finnhubLoading) && (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500 text-left">
                  <th className="pb-1.5 pr-2 font-medium">Symbol</th>
                  <th className="pb-1.5 pr-2 font-medium hidden sm:table-cell">Description</th>
                  <th className="pb-1.5 pr-2 font-medium text-right">Price</th>
                  <th className="pb-1.5 pr-2 font-medium text-right">Δ%</th>
                  <th className="pb-1.5 pr-2 font-medium text-right hidden md:table-cell">RSI</th>
                  <th className="pb-1.5 pr-2 font-medium hidden md:table-cell">EMA</th>
                  <th className="pb-1.5 pr-2 font-medium text-right">Score</th>
                  <th className="pb-1.5 pr-2 font-medium">Signal</th>
                  <th className="pb-1.5 pr-2 font-medium hidden lg:table-cell">IG Epic</th>
                  <th className="pb-1.5 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {finnhubRows.map(row => (
                  <tr key={row.symbol} className={clsx('transition-colors',
                    row.direction === 'BUY'  ? 'bg-emerald-950/10 hover:bg-emerald-950/20' :
                    row.direction === 'SELL' ? 'bg-red-950/10 hover:bg-red-950/20' :
                    'hover:bg-gray-800/30'
                  )}>
                    <td className="py-1.5 pr-2 font-mono font-semibold text-white">
                      {row.symbol.replace(/^[^:]+:/, '')}
                    </td>
                    <td className="py-1.5 pr-2 text-gray-400 truncate max-w-[140px] hidden sm:table-cell">
                      {row.description !== row.symbol ? row.description : ''}
                    </td>
                    <td className="py-1.5 pr-2 text-right font-mono text-gray-300">
                      {row.price > 0 ? row.price.toLocaleString('en-GB', { maximumFractionDigits: 4 }) : '—'}
                    </td>
                    <td className={clsx('py-1.5 pr-2 text-right font-mono',
                      row.changePercent > 0 ? 'text-emerald-400' : row.changePercent < 0 ? 'text-red-400' : 'text-gray-500'
                    )}>
                      {row.changePercent !== 0 ? `${row.changePercent > 0 ? '+' : ''}${row.changePercent.toFixed(2)}%` : '—'}
                    </td>
                    <td className="py-1.5 pr-2 text-right hidden md:table-cell">
                      {row.loading ? <span className="text-gray-700">…</span> :
                        row.rsi14 !== undefined ? (
                          <span className={clsx('font-mono',
                            row.rsi14 < 30 ? 'text-emerald-400' :
                            row.rsi14 > 70 ? 'text-red-400' : 'text-gray-400'
                          )}>{row.rsi14.toFixed(0)}</span>
                        ) : <span className="text-gray-700">—</span>
                      }
                    </td>
                    <td className="py-1.5 pr-2 hidden md:table-cell">
                      {row.loading ? <span className="text-gray-700">…</span> :
                        row.emaCross ? (
                          <span className={clsx('text-[10px]',
                            row.emaCross === 'bullish' ? 'text-emerald-400' : 'text-red-400'
                          )}>{row.emaCross === 'bullish' ? '▲ bull' : '▼ bear'}</span>
                        ) : <span className="text-gray-700">—</span>
                      }
                    </td>
                    <td className="py-1.5 pr-2 text-right">
                      {row.loading ? (
                        <RefreshCw className="h-3 w-3 animate-spin text-gray-600 ml-auto" />
                      ) : row.confidenceScore !== undefined ? (
                        <div className="flex items-center justify-end gap-1">
                          <div className="w-10 h-1 bg-gray-800 rounded-full overflow-hidden">
                            <div className={clsx('h-full rounded-full',
                              row.direction === 'BUY' ? 'bg-emerald-500' :
                              row.direction === 'SELL' ? 'bg-red-500' : 'bg-gray-600'
                            )} style={{ width: `${row.confidenceScore}%` }} />
                          </div>
                          <span className={clsx('font-mono text-[10px]',
                            row.direction === 'BUY' ? 'text-emerald-400' :
                            row.direction === 'SELL' ? 'text-red-400' : 'text-gray-500'
                          )}>{row.confidenceScore}%</span>
                        </div>
                      ) : <span className="text-gray-700">—</span>}
                    </td>
                    <td className="py-1.5 pr-2">
                      {row.direction && row.direction !== 'NEUTRAL' ? (
                        <DirectionBadge dir={row.direction} size="xs" />
                      ) : row.loading ? null : (
                        <span className="text-[10px] text-gray-600">HOLD</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-2 hidden lg:table-cell">
                      {row.igEpic ? (
                        <span className="text-[10px] font-mono text-gray-600 truncate max-w-[140px] block">{row.igEpic}</span>
                      ) : (
                        <span className="text-gray-700 text-[10px]">—</span>
                      )}
                    </td>
                    {/* Actions: Pin + Trade */}
                    <td className="py-1.5">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => isPinned(row.symbol) ? unpinInstrument(row.symbol) : pinInstrument(row)}
                          className={clsx('text-[10px] px-1.5 py-0.5 rounded transition-colors',
                            isPinned(row.symbol)
                              ? 'text-orange-400 bg-orange-500/20 hover:bg-orange-500/30'
                              : 'text-gray-600 hover:text-orange-400 hover:bg-gray-800'
                          )}
                          title={isPinned(row.symbol) ? 'Unpin' : 'Pin — always scan'}>
                          📌
                        </button>
                        {row.igEpic && row.direction && row.direction !== 'NEUTRAL' && !row.loading && (
                          <button
                            onClick={() => {
                              setManualEpic(row.igEpic!);
                              setManualName(row.symbol.replace(/^[^:]+:/, ''));
                              setManualDir(row.direction === 'BUY' ? 'BUY' : 'SELL');
                              setManualSize(1);
                              setShowManual(true);
                            }}
                            className={clsx('text-[10px] px-1.5 py-0.5 rounded font-bold transition-colors',
                              row.direction === 'BUY'
                                ? 'text-emerald-400 bg-emerald-500/20 hover:bg-emerald-500/30'
                                : 'text-red-400 bg-red-500/20 hover:bg-red-500/30'
                            )}
                            title={`Open manual trade: ${row.direction} ${row.symbol}`}>
                            {row.direction}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Old scanner entries (from auto-run strategy) */}
        {scanEntries.length > 0 && (
          <div className="mt-3 pt-3 border-t border-gray-800">
            <p className="text-[10px] text-gray-600 mb-2">Strategy scan results</p>
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
          </div>
        )}
      </Card>

      {/* ── Positions / Orders / History ───────────────────────────────────── */}
      <Card>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="flex gap-1">
            {(['positions','orders','history','stats'] as const).map(tab => (
              <button key={tab} onClick={() => setPosTab(tab)}
                className={clsx('px-3 py-1.5 rounded-lg text-xs font-medium transition-all',
                  posTab === tab ? (isCFD?'bg-blue-500/20 text-blue-300':'bg-purple-500/20 text-purple-300') : 'text-gray-500 hover:text-gray-300'
                )}>
                {tab === 'positions' ? `Positions (${positions.length})` : tab === 'orders' ? `Orders (${workingOrders.length})` : tab === 'history' ? 'History' : 'Stats'}
              </button>
            ))}
          </div>
          {positions.length > 0 && (
            <div className="flex items-center gap-2">
              <div className={clsx('text-xs font-medium px-2 py-1 rounded', totalPnL >= 0 ? 'text-emerald-400 bg-emerald-500/10' : 'text-red-400 bg-red-500/10')}>
                P&L {totalPnL >= 0 ? '+' : ''}{fmt(totalPnL)}
              </div>
              <button
                onClick={() => setShowCloseAllConfirm(true)}
                className="text-[10px] px-2 py-1 rounded border border-red-600/40 text-red-400 bg-red-600/10 hover:bg-red-600/20 transition-colors font-medium">
                Close All
              </button>
            </div>
          )}
        </div>

        {posError && <div className="mb-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">{posError}</div>}

        {posTab === 'positions' && (
          positions.length === 0
            ? <p className="text-center py-6 text-gray-600 text-sm">No open positions on {accountType} account</p>
            : <div className="space-y-2">
                {positions.map(pos => {
                  const currentPx = pos.direction === 'BUY' ? pos.bid : pos.offer;
                  const pnlPct    = pos.level && currentPx
                    ? (pos.direction === 'BUY' ? ((currentPx - pos.level) / pos.level) * 100 : ((pos.level - currentPx) / pos.level) * 100)
                    : 0;
                  const health    = positionHealth[pos.dealId];
                  const isTrailing = trailingStops.has(pos.dealId);
                  return (
                    <div key={pos.dealId} className={clsx('border rounded-xl p-3 space-y-2',
                      health === 'red' ? 'border-red-500/40 bg-red-500/5' :
                      health === 'amber' ? 'border-amber-500/30 bg-amber-500/5' :
                      'border-gray-800')}>
                      {/* Row 1: name + health + P&L */}
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          {health && (
                            <span className={clsx('w-2 h-2 rounded-full flex-shrink-0',
                              health === 'green' ? 'bg-emerald-500' :
                              health === 'amber' ? 'bg-amber-400' : 'bg-red-500'
                            )} title={`Health: ${health}`} />
                          )}
                          <DirectionBadge dir={pos.direction} />
                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-white truncate">{pos.instrumentName ?? pos.epic}</p>
                            <p className="text-[10px] text-gray-500 font-mono">{pos.epic} · {pos.size}{sizeUnit}</p>
                          </div>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <p className={clsx('text-xs font-mono font-bold', pos.upl >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                            {pos.upl >= 0 ? '+' : ''}{fmt(pos.upl)}
                          </p>
                          <p className={clsx('text-[10px] font-mono', pnlPct >= 0 ? 'text-emerald-400/70' : 'text-red-400/70')}>
                            {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
                          </p>
                        </div>
                      </div>

                      {/* Row 2: entry + age + health label */}
                      <div className="flex items-center gap-2 text-[10px] text-gray-500 flex-wrap">
                        <span>Entry {pos.level}</span>
                        <span>Bid {pos.bid} / Ask {pos.offer}</span>
                        {pos.createdDate && <span><Clock className="inline h-2.5 w-2.5 mr-0.5" />{fmtTime(pos.createdDate)}</span>}
                        {health && (
                          <span className={clsx('font-medium',
                            health === 'green' ? 'text-emerald-400' :
                            health === 'amber' ? 'text-amber-400' : 'text-red-400'
                          )}>● {health === 'green' ? 'Signal valid' : health === 'amber' ? 'Signal weakening' : 'Signal reversed'}</span>
                        )}
                      </div>

                      {/* Row 3: inline SL/TP edit */}
                      <div className="flex items-center gap-2 flex-wrap">
                        {/* Stop Loss */}
                        <div className="flex items-center gap-1">
                          <span className="text-[10px] text-red-400/70 font-medium">SL</span>
                          {inlineSLEdit[pos.dealId] !== undefined ? (
                            <input
                              type="number" step="any"
                              value={inlineSLEdit[pos.dealId]}
                              onChange={e => setInlineSLEdit(p => ({ ...p, [pos.dealId]: e.target.value }))}
                              onKeyDown={e => { if (e.key === 'Enter') void handleInlineSL(pos); if (e.key === 'Escape') setInlineSLEdit(p => { const n={...p}; delete n[pos.dealId]; return n; }); }}
                              onBlur={() => void handleInlineSL(pos)}
                              autoFocus
                              className="w-20 bg-gray-800 border border-red-500/50 rounded px-1.5 py-0.5 text-[10px] text-red-400 focus:outline-none"
                            />
                          ) : (
                            <button
                              onClick={() => setInlineSLEdit(p => ({ ...p, [pos.dealId]: pos.stopLevel?.toString() ?? '' }))}
                              className={clsx('text-[10px] px-1.5 py-0.5 rounded border transition-colors',
                                pos.stopLevel ? 'border-red-600/30 text-red-400/70 hover:border-red-500 hover:text-red-400' :
                                'border-gray-700 text-gray-600 hover:border-gray-500 hover:text-gray-400'
                              )}>
                              {pos.stopLevel ?? '—'}
                            </button>
                          )}
                        </div>

                        {/* Take Profit */}
                        <div className="flex items-center gap-1">
                          <span className="text-[10px] text-emerald-400/70 font-medium">TP</span>
                          {inlineTPEdit[pos.dealId] !== undefined ? (
                            <input
                              type="number" step="any"
                              value={inlineTPEdit[pos.dealId]}
                              onChange={e => setInlineTPEdit(p => ({ ...p, [pos.dealId]: e.target.value }))}
                              onKeyDown={e => { if (e.key === 'Enter') void handleInlineTP(pos); if (e.key === 'Escape') setInlineTPEdit(p => { const n={...p}; delete n[pos.dealId]; return n; }); }}
                              onBlur={() => void handleInlineTP(pos)}
                              autoFocus
                              className="w-20 bg-gray-800 border border-emerald-500/50 rounded px-1.5 py-0.5 text-[10px] text-emerald-400 focus:outline-none"
                            />
                          ) : (
                            <button
                              onClick={() => setInlineTPEdit(p => ({ ...p, [pos.dealId]: pos.limitLevel?.toString() ?? '' }))}
                              className={clsx('text-[10px] px-1.5 py-0.5 rounded border transition-colors',
                                pos.limitLevel ? 'border-emerald-600/30 text-emerald-400/70 hover:border-emerald-500 hover:text-emerald-400' :
                                'border-gray-700 text-gray-600 hover:border-gray-500 hover:text-gray-400'
                              )}>
                              {pos.limitLevel ?? '—'}
                            </button>
                          )}
                        </div>

                        {/* Trailing stop toggle */}
                        <button
                          onClick={() => toggleTrailingStop(pos.dealId)}
                          title="Toggle trailing stop (1.5%)"
                          className={clsx('text-[10px] px-1.5 py-0.5 rounded border flex items-center gap-1 transition-colors',
                            isTrailing ? 'border-orange-500/60 text-orange-400 bg-orange-500/10' :
                            'border-gray-700 text-gray-600 hover:border-gray-500 hover:text-gray-400'
                          )}>
                          <TrendingUp className="h-2.5 w-2.5" />Trail
                        </button>
                      </div>

                      {/* Row 4: action buttons */}
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Button size="sm" variant="outline" loading={reversingPos === pos.dealId}
                          onClick={() => void reversePosition(pos)}
                          className="text-[10px] px-2 py-1 h-auto">Reverse</Button>
                        <Button size="sm" loading={closingId === pos.dealId}
                          className="text-[10px] px-2 py-1 h-auto bg-red-600/20 text-red-400 border border-red-600/30 hover:bg-red-600/30"
                          onClick={() => void handleClose(pos)}>Close Now</Button>
                      </div>
                    </div>
                  );
                })}
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

        {posTab === 'stats' && (() => {
          const activeStrat = strategies.find(s => s.id === activeStratId);
          const st = computeStrategyStats(tradeHistory, activeStrat?.name);
          const accentCls = isCFD ? 'text-blue-400' : 'text-purple-400';
          const warnCls = (v: number, threshold: number) => v < threshold ? 'text-red-400' : 'text-emerald-400';
          return st.total < 5 ? (
            <div className="text-center py-8 space-y-2">
              <p className="text-gray-400 text-sm font-medium">Insufficient data</p>
              <p className="text-gray-600 text-xs">{st.total}/5 closed trades completed</p>
              <p className="text-gray-700 text-[10px]">Stats will appear once 5 trades have closed</p>
            </div>
          ) : (
            <div className="space-y-3 py-1">
              {/* Performance pause alert */}
              {perfPauseAlert && (
                <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center justify-between gap-2">
                  <p className="text-[10px] text-red-400">{perfPauseAlert}</p>
                  <button onClick={() => { performancePausedRef.current = false; setPerfPauseAlert(null); }}
                    className="text-[9px] text-gray-500 hover:text-gray-300 flex-shrink-0">Resume</button>
                </div>
              )}
              {/* Win rate by period */}
              <div>
                <p className="text-[10px] text-gray-500 mb-1.5 font-medium uppercase tracking-wider">Win Rate</p>
                <div className="grid grid-cols-3 gap-2">
                  {([['Last 20', st.s20, 20], ['Last 50', st.s50, 50], ['Last 100', st.s100, 100]] as [string, typeof st.s20, number][]).map(([label, s, n]) => (
                    <div key={label} className="bg-gray-900/60 rounded-lg p-2 text-center">
                      <p className={clsx('text-base font-bold', st.total >= n ? warnCls(s.winRate, 0.4) : 'text-gray-600')}>{st.total >= n ? `${(s.winRate*100).toFixed(0)}%` : '—'}</p>
                      <p className="text-[9px] text-gray-600">{label}</p>
                    </div>
                  ))}
                </div>
              </div>
              {/* P&L stats */}
              <div>
                <p className="text-[10px] text-gray-500 mb-1.5 font-medium uppercase tracking-wider">Profit / Loss</p>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    ['Avg Win', st.s20.avgWin, true],
                    ['Avg Loss', st.s20.avgLoss, false],
                    ['Profit Factor', st.s20.profitFactor, null],
                    ['Max Drawdown', st.maxDrawdown, null],
                  ] as [string, number, boolean|null][]).map(([label, val, isWin]) => (
                    <div key={label} className="bg-gray-900/60 rounded-lg p-2">
                      <p className={clsx('text-sm font-bold',
                        isWin === true ? 'text-emerald-400' :
                        isWin === false ? 'text-red-400' :
                        label === 'Profit Factor' ? (val >= 1.5 ? 'text-emerald-400' : val >= 1 ? 'text-amber-400' : 'text-red-400') :
                        'text-amber-400'
                      )}>
                        {label === 'Profit Factor' ? (isFinite(val) ? val.toFixed(2) : '∞') : `£${val.toFixed(2)}`}
                      </p>
                      <p className="text-[9px] text-gray-600">{label}</p>
                    </div>
                  ))}
                </div>
              </div>
              {/* Sharpe + totals */}
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-gray-900/60 rounded-lg p-2 text-center">
                  <p className={clsx('text-sm font-bold', accentCls)}>{st.sharpe.toFixed(2)}</p>
                  <p className="text-[9px] text-gray-600">Sharpe Est.</p>
                </div>
                <div className="bg-gray-900/60 rounded-lg p-2 text-center">
                  <p className={clsx('text-sm font-bold', accentCls)}>{st.total}</p>
                  <p className="text-[9px] text-gray-600">Closed Trades</p>
                </div>
                <div className="bg-gray-900/60 rounded-lg p-2 text-center">
                  <p className="text-[10px] font-medium text-gray-400 truncate">{st.bestInstr}</p>
                  <p className="text-[9px] text-gray-600">Best Instrument</p>
                </div>
              </div>
              <div className="bg-gray-900/60 rounded-lg p-2">
                <p className="text-[10px] text-gray-500">Worst instrument: <span className="text-red-400">{st.worstInstr}</span></p>
              </div>
            </div>
          );
        })()}
      </Card>

      {/* ── Login cooldown banner (shown when backoff is active) ──────────── */}
      {loginCooldown && (
        <div className="px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center justify-between gap-3">
          <p className="text-xs text-red-400">🚫 {loginCooldown}</p>
          <button onClick={() => { loginFailCountRef.current = 0; loginBlockedUntilRef.current = 0; setLoginCooldown(''); }}
            className="text-[10px] text-gray-500 hover:text-gray-300 flex-shrink-0">Dismiss</button>
        </div>
      )}

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
        {/* Scan summary strip */}
        {scanStats && (
          <div className="grid grid-cols-5 gap-1 px-3 py-2 bg-gray-900/60 border-b border-gray-800 text-center">
            {([
              ['Scanned',    scanStats.scanned,            'text-gray-400'],
              ['Signals',    scanStats.signals,             'text-blue-400'],
              ['Traded',     scanStats.traded,              'text-emerald-400'],
              ['Volatile↑',  scanStats.skippedVolatile,    'text-yellow-500'],
              ['Conditions', scanStats.skippedConditions,  'text-orange-400'],
            ] as [string, number, string][]).map(([label, val, cls]) => (
              <div key={label}>
                <p className={clsx('text-sm font-bold', cls)}>{val}</p>
                <p className="text-[9px] text-gray-600">{label}</p>
              </div>
            ))}
          </div>
        )}
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

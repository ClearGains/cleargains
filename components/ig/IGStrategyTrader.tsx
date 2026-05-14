'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Play, Square, Pause, Save, Trash2, Plus, RefreshCw, Search,
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
import { IGStockOpportunities } from './IGStockOpportunities';

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
  parabolicRisk?: boolean;    // true when big spike signals potential reversal
  parabolicNote?: string;     // human-readable warning
};

type RunLog = { id: string; ts: string; type: 'info'|'buy'|'sell'|'close'|'error'|'signal'; msg: string };
type PositionMap = Record<'demo'|'live', IGPosition[]>;
type BotPriceEntry = {
  bid: number; mid: number; changePercent: number; candleCount: number;
  rsi: number | null; macd: number | null; atr: number | null;
  signal: 'BUY' | 'SELL' | 'NEUTRAL'; signalState: string;
  consecutiveReds?: number; consecutiveGreens?: number;
  trend5m?: 'UP' | 'DOWN' | 'NEUTRAL';
};

function uid() { return Math.random().toString(36).slice(2, 9); }
function fmt(n: number) { return `£${Math.abs(n).toFixed(2)}`; }
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// PERMISSION: Dynamic position sizing based on available capital.
// Caps order size to at most 5% of available funds, minimum 0.1 £/pt.
// Returns 0 (skip trade) if available falls below £100 OR below 15% of starting balance.
function calcDynamicSize(requestedSize: number, available: number, startingBalance?: number): number {
  if (available < 100) return 0;       // pause if critically low
  if (startingBalance && available < startingBalance * 0.15) return 0; // pause at <15% of starting balance
  if (available < 500) return 0.1;     // minimum viable size when funds low
  const pctBased = Math.floor((available * 0.05) * 10) / 10; // 5% of available, rounded to 0.1 steps
  return Math.min(requestedSize, Math.max(0.1, pctBased));
}

// Correlated instrument groups for signal confirmation (+50% size boost)
const CORRELATED_GROUPS: string[][] = [
  ['EUR/USD', 'GBP/USD', 'AUD/USD'],          // USD-weakness cluster
  ['USD/JPY', 'USD/CHF'],                      // USD-strength cluster
  ['S&P 500', 'NASDAQ 100', 'Wall Street'],    // US equity cluster
  ['FTSE 100', 'Germany 40'],                  // European equity cluster
];

function hasCorrelatedConfirmation(
  marketName: string,
  tradeDir: 'BUY' | 'SELL',
  scans: Record<string, MarketScan>,
): boolean {
  for (const group of CORRELATED_GROUPS) {
    if (!group.includes(marketName)) continue;
    const peers = group.filter(n => n !== marketName);
    const confirmed = peers.some(peerName => {
      const peerScan = Object.values(scans).find(s => s.name === peerName);
      return peerScan?.signal?.direction === tradeDir && (peerScan.signal.strength ?? 0) >= 60;
    });
    if (confirmed) return true;
  }
  return false;
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

/**
 * Auto-sizing: stop distance is derived from BOTH market type AND timeframe.
 * Size is back-calculated so hitting the stop costs exactly stopLoss £.
 * limitDist uses the timeframe's R:R ratio so the target is realistic to hit
 * within the chosen holding period (hours vs days vs weeks vs long-term).
 *
 * Timeframe multipliers vs daily baseline:
 *   hourly   → 0.5× stop, 1.5:1 R:R  (tight, same-session exits)
 *   daily    → 1.0× stop, 2.0:1 R:R  (intraday / end-of-day exits)
 *   weekly   → 2.5× stop, 2.5:1 R:R  (swing, multi-day holds)
 *   longterm → 5.0× stop, 3.0:1 R:R  (trend following, weeks/months)
 *   rsi2     → 1.2× stop, 2.0:1 R:R  (mean reversion, 1–5 days)
 */
function calcAutoSizing(
  price: number,
  mType: MarketType,
  stopLoss: number,
  timeframe: Timeframe = 'daily',
): { stopDist: number; limitDist: number; size: number } {
  // Per-timeframe: how much wider than the daily baseline, and target R:R
  const TF_PROFILE: Record<string, { mult: number; rr: number }> = {
    hourly:   { mult: 0.5,  rr: 2.0 },  // same-session exits — 2:1 realistic
    daily:    { mult: 1.0,  rr: 3.0 },  // intraday swings — 3:1 achievable with trailing
    weekly:   { mult: 2.5,  rr: 3.5 },  // multi-day trends — 3.5:1 lets winners run
    longterm: { mult: 5.0,  rr: 4.0 },  // trend following — 4:1 for big macro moves
    rsi2:     { mult: 1.2,  rr: 2.5 },  // mean reversion — 2.5:1 with tight stop
  };
  const { mult, rr } = TF_PROFILE[timeframe] ?? TF_PROFILE.daily;

  // Daily baseline stop distance per market type
  let baseStop: number;
  switch (mType) {
    case 'INDEX':
      baseStop = Math.max(8, Math.round(price * 0.003));    // 0.3% e.g. FTSE 8500 → 26pt
      break;
    case 'FOREX':
      baseStop = 25;                                         // 25 pips baseline
      break;
    case 'COMMODITY':
      baseStop = Math.max(5, Math.round(price * 0.005));    // 0.5% e.g. Gold $3300 → 17pt
      break;
    case 'CRYPTO':
      baseStop = Math.max(200, Math.round(price * 0.015));  // 1.5%
      break;
    default:                                                 // SHARES
      baseStop = Math.max(5, Math.round(price * 0.005));    // 0.5%
  }

  const stopDist  = Math.max(1, Math.round(baseStop * mult));
  const rawSize   = stopLoss / stopDist;
  const size      = Math.max(0.1, Math.round(rawSize * 10) / 10);
  const limitDist = Math.max(1, Math.round(stopDist * rr));   // R:R from timeframe, not £ target
  return { stopDist, limitDist, size };
}

/**
 * Dynamic position cap — scales with available funds and average signal quality.
 * Ensures the strategy self-limits when capital is tight or signals are weak.
 */
function calcAutoMaxPositions(available: number, avgStrength: number): number {
  // Hard cap at 3 — fewer, higher-quality positions beat a bloated book.
  const byFunds =
    available >= 3000 ? 3 :
    available >= 1500 ? 2 :
    available >= 500  ? 1 : 0;
  const confAdj = avgStrength < 60 ? -1 : 0;
  return Math.max(0, byFunds + confAdj);
}

function isEpicTradeable(epic: string): boolean {
  const { mins, day } = getUKTime(); // UK local time — correct for BST and GMT

  if (epic.startsWith('CS.D.')) {
    if (day === 6) return false;                          // Saturday — forex closed
    if (day === 0 && mins < 22 * 60) return false;       // Sunday before 22:00 UK
    if (day === 5 && mins >= 22 * 60) return false;      // Friday after 22:00 UK
    return true;
  }
  // Indices — closed all weekend
  if (day === 0 || day === 6) return false;
  // Sessions in UK local time (BST in summer, GMT in winter)
  const sessions: Record<string, [number, number, number, number]> = {
    'IX.D.FTSE.DAILY.IP':   [8,  0,  16, 30],
    'IX.D.SPTRD.DAILY.IP':  [14, 30, 21, 0 ],
    'IX.D.NASDAQ.CASH.IP':  [14, 30, 21, 0 ],
    'IX.D.DOW.DAILY.IP':    [14, 30, 21, 0 ],
    'IX.D.DAX.DAILY.IP':    [8,  0,  22, 0 ],
    'IX.D.NIKKEI.DAILY.IP': [23, 0,  6,  0 ],
    'IX.D.ASX.DAILY.IP':    [23, 50, 6,  30],
  };
  const s = sessions[epic];
  if (!s) return true;
  const [oh, om, ch, cm] = s;
  const open = oh * 60 + om, close = ch * 60 + cm;
  return open > close ? (mins >= open || mins < close) : (mins >= open && mins < close);
}

// Liquid trading window filter — only scan during high-volume periods.
// All times are UK local (handles BST/GMT via getUKTime).
function isLiquidTradingWindow(mType: MarketType): boolean {
  const { mins, day } = getUKTime();

  if (mType !== 'FOREX' && (day === 0 || day === 6)) return false;

  switch (mType) {
    case 'INDEX': {
      const inUKOpen = mins >= 8 * 60 && mins < 10 * 60 + 30;   // 08:00–10:30 UK
      const inUSOver = mins >= 14 * 60 + 30 && mins < 17 * 60 + 30; // 14:30–17:30 UK
      return inUKOpen || inUSOver;
    }
    case 'FOREX': {
      if (day === 6) return false;
      if (day === 0 && mins < 22 * 60) return false;
      if (day === 5 && mins >= 22 * 60) return false;
      return mins >= 8 * 60 && mins < 17 * 60;                  // 08:00–17:00 UK
    }
    case 'SHARES': {
      const inUK = mins >= 8 * 60 && mins < 16 * 60 + 30;
      const inUS = mins >= 14 * 60 + 30 && mins < 21 * 60;
      return inUK || inUS;
    }
    case 'COMMODITY':
      return mins >= 14 * 60 + 30 && mins < 21 * 60;
    case 'CRYPTO':
      return true;
    default:
      return true;
  }
}

/**
 * Calibrated signal scoring for spread-bet markets.
 * Indices / forex move much less than individual stocks, so the
 * thresholds are scaled per asset class.
 */
// ── Signal evaluation — three hard gates, no score tables ────────────────────
// Philosophy: fewer, clearer rules beat many fuzzy ones.
// Gate 1 — Price move: must exceed the minimum meaningful threshold for this asset class.
// Gate 2 — RSI: block overbought buys (>68) and oversold sells (<32). These are the two
//          most reliable losing trades — you're always too late when RSI is at extremes.
// Gate 3 — MACD: if momentum is pointing the other direction, skip.
// All three must pass. If any gate fails → HOLD.
// Strength is proportional to how far the move exceeds the threshold (not a magic table).
function evaluateSignal(
  changePercent: number,
  rsi:           number | null,
  macd:          number | null,
  mType:         MarketType,
): { direction: 'BUY' | 'SELL' | 'HOLD'; strength: number } {
  const minMove: Record<MarketType, number> = {
    INDEX:     0.50,  // 0.25% is daily noise; 0.50% (42 FTSE pts) = real intraday trend
    FOREX:     0.20,  // 0.10% was too small (10 pips noise); 0.20% (~26 pips) = real move
    COMMODITY: 0.40,
    CRYPTO:    0.50,
    SHARES:    0.35,
  };

  const threshold = minMove[mType];
  const absPct = Math.abs(changePercent);
  if (absPct < threshold) return { direction: 'HOLD', strength: 0 };

  const dir: 'BUY' | 'SELL' = changePercent > 0 ? 'BUY' : 'SELL';

  // Gate 2: RSI extremes
  if (rsi !== null) {
    if (dir === 'BUY'  && rsi > 68) return { direction: 'HOLD', strength: 0 };
    if (dir === 'SELL' && rsi < 32) return { direction: 'HOLD', strength: 0 };
  }

  // Gate 3: MACD direction conflict
  if (macd !== null) {
    if (dir === 'BUY'  && macd < 0) return { direction: 'HOLD', strength: 0 };
    if (dir === 'SELL' && macd > 0) return { direction: 'HOLD', strength: 0 };
  }

  // Strength: how many times larger than the threshold. 1× → 65, 2× → 78, 3× → 88, 4×+ → 95.
  const multiple = absPct / threshold;
  const strength = Math.min(95, Math.round(52 + multiple * 12));

  return { direction: dir, strength };
}

// ── UK local time helper — handles BST/GMT automatically via Intl ─────────────
// Never use getUTCHours() + hardcoded offset — that breaks in winter when UK is GMT.
function getUKTime(): { mins: number; day: number } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: 'numeric', minute: 'numeric', weekday: 'short', hour12: false,
  }).formatToParts(now);
  const h   = parseInt(parts.find(p => p.type === 'hour')?.value   ?? '0', 10);
  const m   = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
  const wdy = parts.find(p => p.type === 'weekday')?.value ?? 'Mon';
  const dayMap: Record<string, number> = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
  return { mins: h * 60 + m, day: dayMap[wdy] ?? 1 };
}

// ── Market close guard ────────────────────────────────────────────────────────
// All times are UK local (BST in summer, GMT in winter). getUKTime() handles the offset.
const INDEX_CLOSE_UK: Record<string, { h: number; m: number }> = {
  'IX.D.FTSE.DAILY.IP':   { h: 16, m: 30 },
  'IX.D.SPTRD.DAILY.IP':  { h: 21, m: 0  },
  'IX.D.NASDAQ.CASH.IP':  { h: 21, m: 0  },
  'IX.D.DOW.DAILY.IP':    { h: 21, m: 0  },
  'IX.D.DAX.DAILY.IP':    { h: 22, m: 0  },
  'IX.D.NIKKEI.DAILY.IP': { h: 6,  m: 0  },
  'IX.D.ASX.DAILY.IP':    { h: 6,  m: 30 },
};
const FOREX_EPICS_FE = new Set([
  'CS.D.GBPUSD.TODAY.IP', 'CS.D.EURUSD.TODAY.IP', 'CS.D.USDJPY.TODAY.IP',
  'CS.D.EURGBP.TODAY.IP', 'CS.D.AUDUSD.TODAY.IP',
]);
function isEpicClosingSoon(epic: string, bufferMins = 30): boolean {
  const { mins, day } = getUKTime();
  if (FOREX_EPICS_FE.has(epic)) return day === 5 && mins >= (22 * 60 - bufferMins);
  const close = INDEX_CLOSE_UK[epic];
  if (!close) return false;
  const closeMins = close.h * 60 + close.m;
  return mins >= closeMins - bufferMins && mins < closeMins;
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

  // ── Positions ──────────────────────────────────────────────────────────────
  const [positions, setPositions] = useState<PositionMap>({ demo:[], live:[] });
  // positionsRef mirrors state but is updated synchronously — scanMarket reads
  // this so it never sees stale positions after a trade is placed mid-scan.
  const positionsRef = useRef<PositionMap>({ demo:[], live:[] });
  // Refs to the latest callback versions — timers capture stale closures, so
  // they must read from refs. Updated on every render (no effect needed).
  const loadPositionsRef    = useRef<typeof loadPositions | null>(null);
  const runSignalScanRef    = useRef<((s: IGSavedStrategy) => Promise<void>) | null>(null);
  const [loadingPos, setLoadingPos] = useState(false);
  const [closingId, setClosingId]   = useState<string|null>(null);
  const [posError, setPosError]     = useState<string|null>(null);
  const posRefreshRef = useRef<ReturnType<typeof setInterval>|null>(null);

  // ── Server-side strategy runner ────────────────────────────────────────────
  const [serverMode, setServerMode]         = useState(false);
  const [serverRunning, setServerRunning]   = useState(false);
  const [serverLog, setServerLog]           = useState<Array<{ id: string; ts: string; type: string; msg: string }>>([]);
  const serverPollRef = useRef<ReturnType<typeof setInterval>|null>(null);

  async function startServerStrategy(strat: IGSavedStrategy) {
    const { YAHOO_SYMBOL_MAP } = await import('@/lib/yahooClient');
    const markets = (strat.watchlist?.length ? strat.watchlist : DEFAULT_WATCHLIST)
      .filter(m => m.enabled)
      .map(m => ({
        epic:        m.epic,
        name:        m.name,
        yahooSymbol: YAHOO_SYMBOL_MAP[m.name] ?? '',
        marketType:  (m.marketType ?? getMarketType(m.epic)) as 'INDEX' | 'FOREX' | 'COMMODITY' | 'CRYPTO' | 'SHARES',
      }))
      .filter(m => m.yahooSymbol);

    const cfg = {
      markets,
      minStrength:    strat.minStrength ?? 60,
      betSize:        0.5,
      scanIntervalMs: strat.signalScanMs ?? 5 * 60_000,
    };

    try {
      const r = await fetch('/api/ig/bot?action=strategy-start', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(cfg),
      });
      const d = await r.json() as { ok: boolean; error?: string };
      if (d.ok) {
        setServerRunning(true);
        log('info', `[SERVER] Strategy runner started on Oracle VM — ${markets.length} market(s)`);
        startServerPoll();
      } else {
        log('error', `[SERVER] Failed to start: ${d.error ?? 'unknown'}`);
      }
    } catch (e) {
      log('error', `[SERVER] Unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function stopServerStrategy() {
    void fetch('/api/ig/bot?action=strategy-stop', { method: 'POST' });
    setServerRunning(false);
    stopServerPoll();
    log('info', '[SERVER] Strategy runner stopped');
  }

  function startServerPoll() {
    if (serverPollRef.current) clearInterval(serverPollRef.current);
    serverPollRef.current = setInterval(async () => {
      try {
        const r = await fetch('/api/ig/bot?action=strategy-status');
        if (!r.ok) return;
        const d = await r.json() as { running: boolean; log?: Array<{ id: string; ts: string; type: string; msg: string }> };
        setServerRunning(d.running);
        setServerLog(d.log ?? []);
      } catch {}
    }, 30_000);
  }

  function stopServerPoll() {
    if (serverPollRef.current) { clearInterval(serverPollRef.current); serverPollRef.current = null; }
  }

  // ── Strategies ─────────────────────────────────────────────────────────────
  const [strategies, setStrategies]     = useState<IGSavedStrategy[]>([]);
  const [activeStratId, setActiveStratId] = useState<string|null>(null); // display only (scanner)
  type StratTimers = { signal: ReturnType<typeof setInterval>; pos: ReturnType<typeof setInterval> };
  const stratTimersRef  = useRef<Record<string, Partial<StratTimers>>>({});
  const stratStateRef   = useRef<Record<string, RunState>>({});
  const [stratStates, setStratStates]   = useState<Record<string, RunState>>({});
  const runningRef  = useRef(false); // test-scan only
  const newsSignalsRef     = useRef<Map<string, 'BUY'|'SELL'>>(new Map());
  const recentlyClosedRef  = useRef<Map<string, { closedAt: number; wasLoss: boolean }>>(new Map());
  // Tracks peak UPL (£) seen for each open position — used for trailing profit lock
  const peakProfitRef      = useRef<Map<string, number>>(new Map());
  // Tracks orders placed but not yet confirmed in positionsRef (race-condition guard).
  // Prevents the same epic:direction being opened twice during the ~2s loadPositions delay.
  const pendingOrdersRef   = useRef<Set<string>>(new Set());
  // Prevents concurrent scan executions: if a scan is still running when the next
  // timer fires, the new fire is silently skipped. A 20-market scan with Gemini
  // can take 3-5 min; overlapping scans are the primary cause of duplicate positions.
  const scanInProgressRef  = useRef<Set<string>>(new Set());
  // Epics locked within the current scan cycle. Set as soon as we commit to an order,
  // cleared at the start of the NEXT scan after positions are refreshed.
  // Adds a second layer of protection on top of pendingOrdersRef for same-epic dupes.
  const placedEpicsRef     = useRef<Set<string>>(new Set());
  // Bulk IG real-time snapshot pre-fetched at scan start — avoids Yahoo Finance (15-min delayed).
  // keyed by epic, populated in runSignalScan, consumed in fetchSnapshot.
  type IGSnapshotEntry = { bid: number; offer: number; mid: number; percentageChange: number; spread: number; high: number; low: number };
  const igSnapshotRef      = useRef<Record<string, IGSnapshotEntry>>({});

  // ── Active demo/live mode ──────────────────────────────────────────────────
  const [activeMode, setActiveModeState] = useState<'demo'|'live'>('demo');
  const [showLiveConfirm, setShowLiveConfirm] = useState(false);
  const [liveConfirmSkipSession, setLiveConfirmSkipSession] = useState(false);
  const [pendingRunAction, setPendingRunAction] = useState<(() => void)|null>(null);
  // Copy modals
  type CopyModal = { strat: IGSavedStrategy; direction: 'toDemo' | 'toLive' };
  const [copyModal, setCopyModal] = useState<CopyModal|null>(null);
  const [copyConfirmText, setCopyConfirmText] = useState('');
  // Sync settings modal
  const [syncModal, setSyncModal] = useState<{ demo: IGSavedStrategy; live: IGSavedStrategy }|null>(null);

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
  // Starting balance captured when auto-run begins — used for 15% capital floor check.
  const startingBalanceRef = useRef<Partial<Record<'demo'|'live', number>>>({});

  // ── Scan frequency settings ────────────────────────────────────────────────
  // ── Global paper mode — blocks ALL order placement when true ──────────────
  const [paperMode, setPaperMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const stored = localStorage.getItem('ig-paper-mode');
    return stored === null ? true : stored === 'true'; // default ON for safety
  });
  const paperModeRef = useRef(paperMode);
  useEffect(() => { paperModeRef.current = paperMode; localStorage.setItem('ig-paper-mode', String(paperMode)); }, [paperMode]);

  const [signalScanMs, setSignalScanMs] = useState(5 * 60_000);
  const [posMonitorMs, setPosMonitorMs] = useState(60_000);
  const signalStartRef = useRef<number|null>(null);
  const posStartRef    = useRef<number|null>(null);
  const [signalCountdown, setSignalCountdown] = useState('');
  const [posCountdown, setPosCountdown]       = useState('');

  // ── Market scanner state ───────────────────────────────────────────────────
  const [scans, setScans] = useState<Record<string, MarketScan>>({});
  const [scanProgress, setScanProgress] = useState<string>('');
  // Bot server real-time prices + indicators — refreshed once per scan cycle
  const botPricesRef = useRef<Record<string, BotPriceEntry>>({});
  // IG client sentiment — refreshed once per scan cycle (contrarian gate)
  const sentimentRef = useRef<Record<string, { longPct: number; shortPct: number }>>({});

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
  const [bAutoMaxPos, setBAutoMaxPos]       = useState(false);
  const [bMinStrength, setBMinStrength]     = useState(55);
  const [bAccounts, setBAccounts]           = useState<('demo'|'live')[]>(['demo']);
  const [bAutoClose, setBAutoClose]         = useState(true);
  const [bMode, setBMode]                   = useState<'LONG_ONLY' | 'SHORT_ONLY' | 'BOTH'>('BOTH');
  const [bWatchlist, setBWatchlist]         = useState<WatchlistMarket[]>([...DEFAULT_WATCHLIST]);
  const [bSignalScanMs, setBSignalScanMs]   = useState(5 * 60_000);
  const [bPosMonitorMs, setBPosMonitorMs]   = useState(60_000);
  const [bStopLoss, setBStopLoss]           = useState(5);
  const [bTakeProfit, setBTakeProfit]       = useState(30);

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

  // ── Run state: per-strategy. RUNNING=full; PAUSED=monitor only; STOPPED=idle ─
  type RunState = 'RUNNING' | 'PAUSED' | 'STOPPED';
  const runtimeStartRef                            = useRef<number|null>(null);
  const [runtimeDisplay, setRuntimeDisplay]       = useState('');
  const completedTradesRef                         = useRef(0);
  const [completedTrades, setCompletedTrades]     = useState(0);
  const todayPnLRef                                = useRef(0);
  const [todayPnL, setTodayPnL]                   = useState(0);
  const pendingRestartRef                          = useRef<string[]>([]);
  // ── Enhanced status tracking ──────────────────────────────────────────────
  const lastSignalAtRef                            = useRef<number|null>(null);
  const [lastSignalAt, setLastSignalAt]           = useState<number|null>(null);
  const [lastSignalDisplay, setLastSignalDisplay] = useState('');
  const [stoppedAt, setStoppedAt]                 = useState<string|null>(null);
  const [stopError, setStopError]                 = useState<string|null>(null);
  const [runtimeStartDisplay, setRuntimeStartDisplay] = useState<string>('');

  // ── Log ─────────────────────────────────────────────────────────────────────
  // Global log: manual trades, position management, system messages
  const [runLog, setRunLog] = useState<RunLog[]>([]);
  // Per-strategy log: one entry list per strategy ID
  const stratLogsRef = useRef<Record<string, RunLog[]>>({});
  const [stratLogs, setStratLogs] = useState<Record<string, RunLog[]>>({});

  // ── Toast ──────────────────────────────────────────────────────────────────
  const [toast, setToast] = useState<{ok:boolean;msg:string}|null>(null);
  function showToast(ok:boolean, msg:string) { setToast({ok,msg}); setTimeout(() => setToast(null), 4000); }

  // Global log (manual/UI actions)
  function log(type: RunLog['type'], msg: string) {
    setRunLog(p => [{ id:uid(), ts:new Date().toISOString(), type, msg }, ...p].slice(0, 100));
  }
  // Per-strategy log (bot activity — each card shows its own)
  function slog(stratId: string, type: RunLog['type'], msg: string) {
    const entry: RunLog = { id: uid(), ts: new Date().toISOString(), type, msg };
    const prev = stratLogsRef.current[stratId] ?? [];
    stratLogsRef.current[stratId] = [entry, ...prev].slice(0, 200);
    setStratLogs(p => ({ ...p, [stratId]: [entry, ...(p[stratId] ?? [])].slice(0, 200) }));
  }

  // ── Per-strategy state helpers ────────────────────────────────────────────
  function getStratState(id: string): RunState {
    return stratStateRef.current[id] ?? 'STOPPED';
  }
  function setStratState(id: string, state: RunState) {
    stratStateRef.current = { ...stratStateRef.current, [id]: state };
    setStratStates({ ...stratStateRef.current });
  }

  // Derived: any strategy running or paused
  const isRunning = Object.values(stratStates).some(s => s !== 'STOPPED');
  const runStratEnv = strategies.find(s => (stratStates[s.id] ?? 'STOPPED') !== 'STOPPED' && s.env === 'live') ? 'live' : null;

  function setActiveMode(mode: 'demo'|'live') {
    setActiveModeState(mode);
    localStorage.setItem('ig_active_mode', mode);
  }

  function handleSwitchToLive() {
    const alreadyConfirmed = sessionStorage.getItem('live_confirmed_this_session') === '1';
    if (alreadyConfirmed) { setActiveMode('live'); }
    else { setShowLiveConfirm(true); }
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
    setStrategies(loadStrategies('demo')); // start with demo strategies
    setTradeHistory(loadIGTradeHistory());
    liveTradeAckedRef.current = localStorage.getItem('ig_live_first_trade_ack') === '1';
    const savedMode = localStorage.getItem('ig_active_mode') as 'demo'|'live'|null;
    (['demo','live'] as const).forEach(env => {
      setConnecting(c => ({...c,[env]:true}));
      connectIG(env).then(sess => {
        if (sess) {
          setSessions(s => ({...s,[env]:sess}));
          if (env === 'live' && savedMode === 'live') setActiveModeState('live');
        }
        setConnecting(c => ({...c,[env]:false}));
      });
    });
    if (savedMode === 'demo') setActiveModeState('demo');
  }, []);

  // ── Reload env-namespaced strategies when switching Demo ↔ Live ──────────
  useEffect(() => {
    setStrategies(loadStrategies(activeMode));
    // If there's an active running strategy that belongs to the other env, keep it running but deselect
    if (activeStratId) {
      const stillVisible = loadStrategies(activeMode).find(s => s.id === activeStratId);
      if (!stillVisible) setActiveStratId(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMode]);

  // ── Auto-restart: collect all running strategy IDs on mount ─────────────
  useEffect(() => {
    const ids: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('strategy_running_id_')) ids.push(key.replace('strategy_running_id_', ''));
    }
    pendingRestartRef.current = ids;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Auto-restart: start all pending strategies once sessions connect ──────
  useEffect(() => {
    if (!pendingRestartRef.current.length) return;
    if (!Object.values(sessions).some(Boolean)) return;
    const ids = [...pendingRestartRef.current];
    pendingRestartRef.current = [];
    for (const stratId of ids) {
      const strat = loadStrategies('demo').find(s => s.id === stratId)
                 ?? loadStrategies('live').find(s => s.id === stratId);
      if (!strat) continue;
      setActiveModeState(strat.env ?? 'demo');
      setStrategies(loadStrategies(strat.env ?? 'demo'));
      log('info', `♻️ Strategy "${strat.name}" resumed — was running before page reload`);
      setActiveStratId(stratId);
      startAutoRun(strat);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions]);

  // ── Runtime + last-signal display tickers (1s resolution) ───────────────
  useEffect(() => {
    const t = setInterval(() => {
      if (runtimeStartRef.current !== null) {
        const ms = Date.now() - runtimeStartRef.current;
        const h = Math.floor(ms / 3_600_000);
        const m = Math.floor((ms % 3_600_000) / 60_000);
        const s = Math.floor((ms % 60_000) / 1000);
        if (h > 0) setRuntimeDisplay(`${h}h ${m}m ${s}s`);
        else if (m > 0) setRuntimeDisplay(`${m}m ${s}s`);
        else setRuntimeDisplay(`${s}s`);
      }
      if (lastSignalAtRef.current !== null) {
        const ms = Date.now() - lastSignalAtRef.current;
        const totalSec = Math.floor(ms / 1000);
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        setLastSignalDisplay(m > 0 ? `${m}m ${s}s ago` : `${s}s ago`);
      }
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // ── Countdown ticker ───────────────────────────────────────────────────────
  useEffect(() => {
    const t = setInterval(() => {
      if (!Object.values(stratStateRef.current).some(s => s !== 'STOPPED')) { setSignalCountdown(''); setPosCountdown(''); return; }
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
  }, [stratStates, signalScanMs, posMonitorMs]);

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
          const newList = d.positions ?? [];
          // Detect server-side closes (stop-loss / limit hit by IG).
          // Any position that existed before but is no longer in the list was closed
          // externally — mark it in recentlyClosedRef so the scan loop won't
          // immediately re-enter the same instrument in the same direction.
          const prevList = positionsRef.current[env] ?? [];
          const newIds = new Set(newList.map(p => p.dealId));
          for (const gone of prevList) {
            if (!newIds.has(gone.dealId)) {
              // Externally closed (stop / limit / rollover hit by IG).
              // Treat conservatively as a loss → 1-hour cooldown blocks re-entry.
              recentlyClosedRef.current.set(
                `${gone.epic}:${gone.direction}`,
                { closedAt: Date.now(), wasLoss: true },
              );
              // Record the close in trade history so the History tab stays current.
              const exitPx = gone.direction === 'BUY' ? (gone.bid ?? gone.level) : (gone.offer ?? gone.level);
              setTradeHistory(prev => recordTradeClose(prev, gone.dealId, exitPx, gone.upl ?? 0, 'STOP_LOSS', new Date().toISOString()));
            }
          }
          positionsRef.current = { ...positionsRef.current, [env]: newList };
          setPositions(p => ({...p, [env]: newList}));
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
  loadPositionsRef.current = loadPositions; // always keep ref current so timers use latest sessions

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

  // ── Hydrate trade history from IG activity log ────────────────────────────
  const hydrateTradeHistory = useCallback(async () => {
    type HistResp = {
      ok: boolean;
      opened: { date: string; epic: string; dealId: string; direction: string; size: number; level: number; marketName: string }[];
      closed:  { date: string; epic: string; dealId: string; dealRef: string; direction: string; size: number; level: number; marketName: string; currency: string }[];
    };
    for (const env of ['demo', 'live'] as const) {
      const sess = sessions[env];
      if (!sess) continue;
      try {
        const r = await fetch('/api/ig/history?pageSize=100', { headers: makeHeaders(sess, env) });
        if (!r.ok) { log('error', `[History] IG activity fetch failed (${r.status}) for ${env}`); continue; }
        const d = await r.json() as HistResp;
        if (!d.ok) { log('error', `[History] IG activity returned ok:false for ${env}`); continue; }
        if (!d.opened.length && !d.closed.length) continue;

        setTradeHistory(prev => {
          const existingIds    = new Set(prev.map(rec => rec.dealId).filter(Boolean));
          const closedByDealId = new Map(d.closed.map(c => [c.dealId, c]));
          const next           = [...prev];

          for (const o of d.opened) {
            if (!o.dealId || existingIds.has(o.dealId)) continue;
            const closeInfo = closedByDealId.get(o.dealId);
            const isClosed  = !!closeInfo;
            next.push({
              id: `ig_${o.dealId}`, portfolioName: env === 'live' ? 'Live Account' : 'Demo Account',
              market: o.marketName, epic: o.epic, direction: o.direction as 'BUY' | 'SELL',
              size: o.size, entryLevel: o.level, exitLevel: closeInfo?.level ?? null,
              openedAt: o.date, closedAt: closeInfo?.date ?? null,
              status: isClosed ? 'CLOSED' : 'OPEN',
              dealReference: closeInfo?.dealRef ?? '', dealId: o.dealId,
              pnl: null, closeReason: isClosed ? 'STRATEGY' : null, accountType: env,
            });
            existingIds.add(o.dealId);
          }

          const updated = next.map(rec => {
            if (rec.status !== 'OPEN' || !rec.dealId) return rec;
            const closeInfo = closedByDealId.get(rec.dealId);
            if (!closeInfo) return rec;
            return { ...rec, exitLevel: closeInfo.level, closedAt: closeInfo.date,
              status: 'CLOSED' as const, dealReference: rec.dealReference || closeInfo.dealRef,
              closeReason: rec.closeReason ?? ('STRATEGY' as const) };
          });

          const openedIds    = new Set(d.opened.map(o => o.dealId));
          const allKnownIds  = new Set(updated.map(rec => rec.dealId).filter(Boolean));
          for (const c of d.closed) {
            if (!c.dealId || openedIds.has(c.dealId) || allKnownIds.has(c.dealId)) continue;
            updated.push({
              id: `ig_closed_${c.dealId}`, portfolioName: env === 'live' ? 'Live Account' : 'Demo Account',
              market: c.marketName, epic: c.epic, direction: c.direction as 'BUY' | 'SELL',
              size: c.size, entryLevel: 0, exitLevel: c.level,
              openedAt: c.date, closedAt: c.date, status: 'CLOSED',
              dealReference: c.dealRef, dealId: c.dealId,
              pnl: null, closeReason: 'STRATEGY', accountType: env,
            });
          }

          updated.sort((a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime());
          const final = updated.slice(0, 500);
          saveIGTradeHistory(final);
          return final;
        });
      } catch (e) {
        log('error', `[History] ${env} hydration failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions]);

  // Run on session connect
  useEffect(() => { void hydrateTradeHistory(); }, [hydrateTradeHistory]);

  // Re-run whenever the history tab is opened (picks up newly closed trades)
  useEffect(() => {
    if (posTab === 'history') void hydrateTradeHistory();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posTab]);

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
    // Global paper mode — log the order but don't send it to IG
    if (paperModeRef.current) {
      console.info(`[PAPER] Would place: ${env.toUpperCase()} ${direction} ${epic} £${size}/pt SL:${stopDist ?? '—'} TP:${limitDist ?? '—'}`);
      return { ok: true as const, dealReference: 'PAPER-MODE', epic, sentPayload: null, igBody: null };
    }

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

  // ── Fetch IG account funds ─────────────────────────────────────────────────
  // PERMISSION: Fetches available funds before each scan cycle so the strategy
  // can size positions dynamically and skip markets when funds are low.
  async function fetchIGFunds(env: 'demo'|'live'): Promise<{ available: number; balance: number } | null> {
    const sess = sessions[env];
    if (!sess) return null;
    try {
      const r = await fetch('/api/ig/account', { headers: makeHeaders(sess, env) });
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

  type SnapshotResult = {
    price: number; changePercent: number; signal: 'BUY'|'SELL'|'NEUTRAL';
    source: string; error?: string;
    indicators?: { rsi: number|null; macd: number|null; atr: number|null };
  };

  // ── Fetch market snapshot — IG real-time primary, Yahoo fallback, bot indicators ──
  // Priority:
  //   1. IG bulk snapshot (pre-fetched at scan start) — real-time bid/offer, zero data cost
  //   2. Bot server RSI/MACD/ATR — attached as indicators when available (≥5 candles)
  //   3. Yahoo Finance — only when IG snapshot has no entry for this epic (shares not on IG watchlist)
  async function fetchSnapshot(name: string, epic?: string): Promise<SnapshotResult|null> {
    // ── Step 1: Bot server (real-time RSI/MACD/ATR from Lightstreamer) ──
    const botData  = epic ? botPricesRef.current[epic] : null;
    // RSI needs 14+ candles, MACD needs 26+ — below 20 the values are noise.
    // Treating unreliable indicators as null is better than using garbage RSI to block valid signals.
    const hasBot   = !!(botData && botData.candleCount >= 20 && botData.mid > 0);
    const botInds  = hasBot ? { rsi: botData!.rsi, macd: botData!.macd, atr: botData!.atr } : undefined;

    // ── Step 2: IG real-time snapshot (pre-fetched in runSignalScan) ──
    const igEntry = epic ? igSnapshotRef.current[epic] : undefined;
    if (igEntry) {
      const pct    = igEntry.percentageChange;
      const signal: 'BUY'|'SELL'|'NEUTRAL' = pct > 0.3 ? 'BUY' : pct < -0.3 ? 'SELL' : 'NEUTRAL';
      const igResult: SnapshotResult = {
        price: igEntry.mid, changePercent: pct, signal,
        source: hasBot ? 'ig+bot' : 'ig',
        ...(hasBot ? { indicators: botInds } : {}),
      };
      return igResult;
    }

    // ── Step 3: Bot server alone (fallback when IG snapshot missing this epic) ──
    if (hasBot) {
      const bd    = botData!;
      const cRed  = bd.consecutiveReds   ?? 0;
      const cGrn  = bd.consecutiveGreens ?? 0;
      const botSignal: 'BUY' | 'SELL' | 'NEUTRAL' =
        cGrn >= 2 && (bd.rsi === null || bd.rsi  < 70) ? 'BUY'  :
        cRed >= 2 && (bd.rsi === null || bd.rsi  > 30) ? 'SELL' :
        bd.macd !== null && bd.macd > 0               ? 'BUY'  :
        bd.macd !== null && bd.macd < 0               ? 'SELL' : 'NEUTRAL';
      return {
        price: bd.mid, changePercent: bd.changePercent, signal: botSignal,
        source: 'bot-server', indicators: botInds,
      };
    }

    // ── Step 4: Yahoo Finance (last resort — 15-min delayed, US/UK only) ──
    const { YAHOO_SYMBOL_MAP, fetchYahooQuotes } = await import('@/lib/yahooClient');
    const symbol = YAHOO_SYMBOL_MAP[name];

    if (symbol) {
      try {
        const quotes = await fetchYahooQuotes([symbol]);
        if (quotes.length) {
          const q = quotes[0];
          const signal: 'BUY'|'SELL'|'NEUTRAL' = q.changePercent > 0.3 ? 'BUY' : q.changePercent < -0.3 ? 'SELL' : 'NEUTRAL';
          return { price: q.price, changePercent: q.changePercent, signal, source: 'yahoo' };
        }
        log('error', `[Yahoo] ${name} (${symbol}): empty response — market may be closed or symbol invalid`);
      } catch (e) {
        log('error', `[Yahoo] ${name} (${symbol}): ${e instanceof Error ? e.message : 'fetch failed'}`);
      }
    } else {
      log('error', `[Scanner] No IG snapshot and no Yahoo symbol mapping for "${name}" — add epic to watchlist or YAHOO_SYMBOL_MAP`);
    }

    return { price: 0, changePercent: 0, signal: 'NEUTRAL', source: 'yahoo',
             error: symbol ? 'No data returned' : `No symbol or IG mapping for "${name}"` };
  }

  // ── Fetch news signals once per scan cycle ────────────────────────────────
  async function fetchNewsSignals(markets: WatchlistMarket[], envPositions: Record<string, IGPosition[]>) {
    try {
      const r = await fetch('/api/news/finnhub?category=general');
      if (!r.ok) return;
      const { articles } = await r.json() as { articles?: Array<{ headline: string; source: string; datetime: number }> };
      if (!articles?.length) return;

      const allPositions = Object.entries(envPositions).flatMap(([env, ps]) =>
        ps.map(p => ({ symbol: p.instrumentName ?? p.epic, direction: p.direction, size: p.size, env }))
      );
      const watchlistNames = markets.map(m => m.name);

      const ar = await fetch('/api/news/analyse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          headlines: articles.slice(0, 30).map(a => ({ headline: a.headline, source: a.source, datetime: a.datetime })),
          openPositions: allPositions,
          watchlist: watchlistNames,
        }),
      });
      if (!ar.ok) return;
      const { analysis } = await ar.json() as { analysis?: Array<{ action: string; confidence: number; affectedAssets: string[]; reasoning: string }> };
      if (!analysis?.length) return;

      const newMap = new Map<string, 'BUY'|'SELL'>();
      for (const sig of analysis) {
        if (sig.confidence < 70) continue;
        const dir: 'BUY'|'SELL'|null =
          sig.action === 'OPEN_LONG'  ? 'BUY'  :
          sig.action === 'OPEN_SHORT' ? 'SELL' : null;
        if (!dir) continue;
        for (const asset of sig.affectedAssets) {
          const match = watchlistNames.find(n => n.toLowerCase().includes(asset.toLowerCase()) || asset.toLowerCase().includes(n.toLowerCase()));
          if (match) {
            newMap.set(match, dir);
            log('signal', `[NEWS] ${match} → ${dir} (${sig.confidence}%) — ${sig.reasoning}`);
          }
        }
      }
      newsSignalsRef.current = newMap;
    } catch {}
  }

  // ── Scan one market + execute ──────────────────────────────────────────────
  async function scanMarket(strat: IGSavedStrategy, market: WatchlistMarket): Promise<StrategySignal|null> {
    setScans(p => ({ ...p, [market.epic]: { epic:market.epic, name:market.name, signal:null, scanning:true, status:'idle' } }));
    const envs = strat.accounts.filter(e => sessions[e]);

    const snapshot = await fetchSnapshot(market.name, market.epic);

    if (!snapshot || snapshot.error) {
      const errMsg = snapshot?.error ?? 'Failed to fetch market data';
      setScans(p => ({ ...p, [market.epic]: { epic:market.epic, name:market.name, signal:null, scanning:false, status:'error', error: errMsg } }));
      log('error', `${market.name}: ${errMsg}`);
      return null;
    }

    // ── Gate 1: Liquid trading window ─────────────────────────────────────────
    const mType = market.marketType ?? getMarketType(market.epic);
    if (!isLiquidTradingWindow(mType)) {
      // Show price data but no signal — market is outside liquid hours
      setScans(p => ({ ...p, [market.epic]: {
        epic: market.epic, name: market.name, signal: null, scanning: false, status: 'ok',
        price: snapshot.price, changePercent: snapshot.changePercent,
        source: snapshot.source, lastScanned: new Date().toISOString(),
        error: 'Outside liquid trading hours — monitoring only',
      }}));
      return null;
    }

    // ── Signal evaluation — three gates, no score tables ─────────────────────
    const stopLoss = strat.stopLoss ?? strat.stopPct ?? 5;
    const pctStr   = `${snapshot.changePercent >= 0 ? '+' : ''}${snapshot.changePercent.toFixed(2)}%`;
    const rsiVal   = snapshot.indicators?.rsi  ?? null;
    const macdVal  = snapshot.indicators?.macd ?? null;
    const atrVal   = snapshot.indicators?.atr  ?? null;
    const botEntry = botPricesRef.current[market.epic];
    const botCandleCount = botEntry?.candleCount ?? 0;

    const { direction: sigDir, strength: sigStrength } = evaluateSignal(snapshot.changePercent, rsiVal, macdVal, mType);
    let direction: 'BUY' | 'SELL' | 'HOLD' = sigDir;
    let strength = sigStrength;

    // ── Gate 2: IG Client Sentiment (contrarian) ─────────────────────────────
    // When ≥75% of retail IG clients are on one side they are almost always wrong.
    if (direction !== 'HOLD') {
      const sent = sentimentRef.current[market.epic];
      if (sent) {
        const crowded = (sent.longPct >= 75 && direction === 'BUY') || (sent.shortPct >= 75 && direction === 'SELL');
        if (crowded) { direction = 'HOLD'; strength = 0; }
      }
    }

    // ── Gate 3: 5-min trend — require active confirmation, not just block conflicts ──
    // With 20+ candles we have enough data to be selective: only trade when the
    // recent short-term trend actively agrees with the daily signal direction.
    // NEUTRAL means "unclear" — don't trade into ambiguity.
    // With < 20 candles we fall back to conflict-block only (less data, less strict).
    if (direction !== 'HOLD' && botCandleCount >= 20) {
      const trend5m = botEntry?.trend5m ?? 'NEUTRAL';
      const trendConfirms = (direction === 'BUY' && trend5m === 'UP') || (direction === 'SELL' && trend5m === 'DOWN');
      if (!trendConfirms) {
        slog(strat.id, 'signal', `[SKIP] ${market.name} — 5-min trend ${trend5m} does not confirm ${direction} signal`);
        direction = 'HOLD'; strength = 0;
      }
    } else if (direction !== 'HOLD' && botCandleCount >= 10) {
      const trend5m = botEntry?.trend5m ?? 'NEUTRAL';
      const trendConflict = (direction === 'BUY' && trend5m === 'DOWN') || (direction === 'SELL' && trend5m === 'UP');
      if (trendConflict) { direction = 'HOLD'; strength = 0; }
    }

    // ATR-based stop/TP when real-time ATR available.
    // Stop at 2.5×ATR (just outside typical candle noise) → TP at 7.5×ATR → 3:1 R:R.
    // 3:1 means we only need to be right 25% of the time to break even; at 40% win rate
    // the strategy is robustly profitable even through drawdown periods.
    let { stopDist, limitDist, size: autoSize } = calcAutoSizing(snapshot.price, mType, stopLoss, strat.timeframe);
    if (atrVal !== null && atrVal > 0) {
      const atrStop = Math.round(atrVal * 2.5);
      const atrTP   = Math.round(atrVal * 7.5);
      if (atrStop > 0 && atrTP > 0) { stopDist = atrStop; limitDist = atrTP; }
    }

    const hasBotData = snapshot.source === 'yahoo+bot' || snapshot.source === 'ig+bot' || snapshot.source === 'bot-server';
    const srcLabel   = snapshot.source.startsWith('ig') ? 'IG' : 'Daily';
    const parts      = [`${srcLabel} ${pctStr}`];
    if (rsiVal  !== null) parts.push(`RSI ${rsiVal.toFixed(0)}`);
    if (macdVal !== null) parts.push(`MACD ${macdVal > 0 ? '↑' : '↓'}`);
    const reason = parts.join(' · ');

    const sig: StrategySignal = {
      direction,
      strength,
      reason,
      stopPoints:   stopDist,
      targetPoints: limitDist,
      riskReward:   `1:${(limitDist / stopDist).toFixed(1)}`,
      indicators: [
        { label: snapshot.source.startsWith('ig') ? 'IG Change' : 'Daily Change', value: pctStr, status: (direction === 'BUY' ? 'bullish' : direction === 'SELL' ? 'bearish' : 'neutral') as 'bullish'|'bearish'|'neutral' },
        hasBotData && rsiVal !== null
          ? { label: 'RSI (live)',  value: rsiVal.toFixed(0),     status: (direction === 'BUY' ? (rsiVal < 50 ? 'bullish' : 'bearish') : (rsiVal > 50 ? 'bearish' : 'bullish')) as 'bullish'|'bearish'|'neutral' }
          : { label: 'Type',        value: mType,                 status: 'neutral' as const },
        hasBotData && macdVal !== null
          ? { label: 'MACD (live)', value: macdVal > 0 ? '↑ bullish' : '↓ bearish', status: (macdVal > 0 ? 'bullish' : 'bearish') as 'bullish'|'bearish'|'neutral' }
          : { label: 'Type',        value: mType,                 status: 'neutral' as const },
        hasBotData && atrVal !== null
          ? { label: 'ATR (live)',  value: atrVal.toFixed(1),     status: 'neutral' as const }
          : { label: 'Type',        value: mType,                 status: 'neutral' as const },
        { label: 'Stop dist',  value: `${stopDist}pt`,            status: 'neutral' as const },
        { label: 'TP dist',    value: `${limitDist}pt`,           status: 'neutral' as const },
        { label: 'Size',       value: `£${autoSize}/pt`,          status: 'neutral' as const },
        { label: 'Max loss',   value: `£${(autoSize * stopDist).toFixed(2)}`, status: 'neutral' as const },
      ],
    };

    // Parabolic risk: a big one-day spike signals potential exhaustion / reversal.
    // Thresholds per asset class — indices move less than individual stocks.
    const parabolicThreshold = mType === 'INDEX' ? 3.0 : mType === 'FOREX' ? 1.5 : 5.0;
    const parabolicRisk = snapshot.changePercent > parabolicThreshold ||
                          (rsiVal !== null && rsiVal > 72 && snapshot.changePercent > 0);
    const parabolicNote = parabolicRisk
      ? `Up ${snapshot.changePercent.toFixed(1)}% today${rsiVal !== null && rsiVal > 70 ? ` · RSI ${rsiVal.toFixed(0)} — overbought` : ''} — watch for reversal`
      : undefined;

    setScans(p => ({
      ...p,
      [market.epic]: {
        epic: market.epic, name: market.name, signal: sig,
        price: snapshot.price, changePercent: snapshot.changePercent, source: snapshot.source,
        scanning: false, status: 'ok', lastScanned: new Date().toISOString(),
        parabolicRisk, parabolicNote,
      },
    }));

    // ── Decide whether to trade ───────────────────────────────────────────────
    const newsDir   = newsSignalsRef.current.get(market.name) ?? null;
    const forceOpen = market.forceOpen === true;
    const highConf  = strength >= 90;

    // Signal threshold — fixed, no adaptive lowering. Quality over quantity:
    // a sparse portfolio does not justify taking weaker signals.
    const botModeGlobal  = strat.mode ?? 'BOTH';
    const ownedDirGlobal = botModeGlobal === 'LONG_ONLY' ? 'BUY' : botModeGlobal === 'SHORT_ONLY' ? 'SELL' : null;
    const ssGlobal = Object.values(scans).map(s => s.signal?.strength ?? 0).filter(Boolean);
    const asGlobal = ssGlobal.length ? ssGlobal.reduce((a, b) => a + b, 0) / ssGlobal.length : 65;
    const totalAllowed = envs.reduce((sum, e) => {
      const f = igFundsRef.current[e]?.available ?? 0;
      return sum + (strat.autoMaxPositions ? calcAutoMaxPositions(f, asGlobal) : strat.maxPositions);
    }, 0);
    const totalOwned = envs.reduce((sum, e) =>
      sum + (positionsRef.current[e] ?? []).filter(p => ownedDirGlobal === null || p.direction === ownedDirGlobal).length, 0);
    const globalFillRatio = totalAllowed > 0 ? totalOwned / totalAllowed : 1;
    const dynamicMinStrength = strat.minStrength ?? 65; // evaluateSignal already gates weak signals at source

    const tradeDir: 'BUY' | 'SELL' | null =
      newsDir
        ? newsDir
        : forceOpen
          ? (direction !== 'HOLD' ? direction : snapshot.changePercent >= 0 ? 'BUY' : 'SELL')
          : direction !== 'HOLD' && (strength >= dynamicMinStrength || highConf) ? direction
          : null;

    if (!strat.autoTrade || !tradeDir) {
      if (direction !== 'HOLD' && !forceOpen)
        log('signal', `${market.name} → ${direction} ${strength}% (need ${dynamicMinStrength}% — no trade)`);
      else if (direction === 'HOLD' && !forceOpen && strength === 0)
        log('signal', `${market.name} → watching (${snapshot.source}: ${pctStr} — no clear signal yet)`);
    } else {
      for (const env of envs) {
        // Always read the ref — not the stale React state — so checks see positions
        // placed earlier in the same scan loop without waiting for a re-render.
        const envPos = positionsRef.current[env];
        const opposite = tradeDir === 'BUY' ? 'SELL' : 'BUY';
        const botMode  = strat.mode ?? 'BOTH';
        const ownedDir = botMode === 'LONG_ONLY' ? 'BUY' : botMode === 'SHORT_ONLY' ? 'SELL' : null;

        // [AUTO] Close same-instrument position when signal flips direction — PROFIT ONLY.
        // Losing positions are held: the £5 hard limit is their only exit.
        // Closing losers on every flip is what destroyed P&L before.
        if (strat.autoClose) {
          const toClose = envPos.filter(p =>
            p.epic === market.epic && p.direction === opposite &&
            (ownedDir === null || p.direction === ownedDir) &&
            (p.upl ?? 0) >= 0  // never close a losing position just because signal reversed
          );
          for (const opp of toClose) {
            const exitPnl = opp.upl ?? 0;
            slog(strat.id, 'info', `[AUTO] Closing ${market.name} (in profit) — signal reversed to ${tradeDir}…`);
            const cr = await closePos(env, opp);
            if (cr.ok) {
              const exitPx = opp.direction === 'BUY' ? (opp.bid ?? opp.level) : (opp.offer ?? opp.level);
              slog(strat.id, 'close', `[AUTO] ✓ Closed ${market.name} — reversed to ${tradeDir} — P&L: £${exitPnl.toFixed(2)}`);
              setTradeHistory(prev => recordTradeClose(prev, opp.dealId, exitPx, exitPnl, 'STRATEGY', new Date().toISOString()));
              recentlyClosedRef.current.set(`${market.epic}:${opp.direction}`, { closedAt: Date.now(), wasLoss: exitPnl < 0 });
            } else slog(strat.id, 'error', `[${env.toUpperCase()}] Reversal close failed: ${cr.error ?? 'unknown'}`);
          }
          if (toClose.length) await loadPositions(env);
        }

        // Mode filter
        if (botMode === 'LONG_ONLY' && tradeDir === 'SELL') continue;
        if (botMode === 'SHORT_ONLY' && tradeDir === 'BUY') continue;

        // Prevent duplicate positions on same instrument.
        // Check both same-direction AND pending orders — covers the full window from signal
        // to position confirmation (~10s including Gemini). The key is added BEFORE any
        // async call so concurrent strategy scans can't both slip through.
        const orderKey = `${market.epic}:${tradeDir}:${env}`;
        if (positionsRef.current[env].some(p => p.epic === market.epic && p.direction === tradeDir)) continue;
        // Block if ANY direction pending for this epic — prevents race where two strategies
        // both check pendingOrdersRef before either has added its key.
        if ([...pendingOrdersRef.current].some(k => k.endsWith(`:${env}`) && k.startsWith(`${market.epic}:`))) {
          slog(strat.id, 'signal', `[SKIP] ${market.name} — order pending for this instrument, waiting`);
          continue;
        }
        if (isEpicClosingSoon(market.epic)) {
          slog(strat.id, 'signal', `[SKIP] ${market.name} — market closes in <30min, no new entries`);
          continue;
        }

        // ── Per-type concentration cap ──────────────────────────────────────────
        // Indices (FTSE/S&P/NASDAQ/DOW/DAX) are highly correlated — capped at 2 distinct instruments.
        // Commodities and crypto are volatile — capped at 1 each.
        // Forex pairs share USD/JPY exposure — capped at 2.
        // HARD RULE: exactly 1 open position per epic at all times.
        const sameEpicCount = positionsRef.current[env].filter(p => p.epic === market.epic).length;
        // Also check placedEpicsRef — catches epics ordered earlier in THIS scan cycle
        // before loadPositions has confirmed them (covers within-scan duplicates).
        if (sameEpicCount >= 1 || placedEpicsRef.current.has(`${market.epic}:${env}`)) {
          slog(strat.id, 'signal', `[SKIP] ${market.name} — already have a position on this instrument`);
          continue;
        }
        // Per-type cap: 1 per asset class. The cap is a ceiling, not a target —
        // the bot will only trade when genuinely signalled, never to "fill slots".
        const typeMax: Record<MarketType, number> = {
          INDEX:     1,
          FOREX:     1,
          SHARES:    1,
          COMMODITY: 1,
          CRYPTO:    1,
        };
        // Count confirmed positions AND in-cycle placements of the same type.
        // Without the in-cycle count, FTSE and Germany 40 can both open in the same
        // scan because positionsRef isn't updated until ~1.5s after order confirmation.
        const confirmedTypeCount = positionsRef.current[env].filter(p => getMarketType(p.epic) === mType).length;
        const inCycleTypeCount   = [...placedEpicsRef.current]
          .filter(k => k.endsWith(`:${env}`) && getMarketType(k.slice(0, k.lastIndexOf(':'))) === mType)
          .length;
        const typeCount = confirmedTypeCount + inCycleTypeCount;
        if (typeCount >= typeMax[mType]) {
          slog(strat.id, 'signal', `[SKIP] ${market.name} — ${mType} slot occupied (${confirmedTypeCount} confirmed + ${inCycleTypeCount} in-cycle, max ${typeMax[mType]})`);
          continue;
        }

        // ── Portfolio cap — count unique instruments (epics), not total position copies ───
        const ownedPositions    = positionsRef.current[env].filter(p => ownedDir === null || p.direction === ownedDir);
        const ownedUniqueEpics  = new Set(ownedPositions.map(p => p.epic)).size;
        const fundsForMax       = igFundsRef.current[env]?.available ?? 0;
        const effectiveMax      = strat.autoMaxPositions
          ? calcAutoMaxPositions(fundsForMax, asGlobal)
          : strat.maxPositions;

        if (effectiveMax > 0 && ownedUniqueEpics >= effectiveMax) {
          slog(strat.id, 'signal', `[SKIP] ${market.name} — at portfolio cap (${ownedUniqueEpics} unique instruments / ${effectiveMax} max)`);
          continue;
        }

        // Re-entry cooldown — loss closes block re-entry for 1h, profit closes for 30min.
        // Within the cooldown window the market must show 87%+ conviction to override.
        // After the cooldown expires the normal 72% threshold applies — the market has
        // "cooled down" enough that a fresh high-quality signal is valid again.
        const recentClose = recentlyClosedRef.current.get(`${market.epic}:${tradeDir}`);
        if (recentClose) {
          const cooldown = recentClose.wasLoss ? 60 * 60_000 : 30 * 60_000;
          if (Date.now() - recentClose.closedAt < cooldown) {
            // Still within cooldown.
            // Loss closes: NEVER re-enter regardless of signal strength — the losing market
            // condition has not changed in minutes; re-entering is the loss-loop bug.
            // Profit closes: allow re-entry only on extreme conviction (95%+).
            if (recentClose.wasLoss || strength < 95) {
              const label = recentClose.wasLoss ? 'loss' : 'profit';
              const remaining = Math.round((cooldown - (Date.now() - recentClose.closedAt)) / 60_000);
              slog(strat.id, 'signal', `[SKIP] ${market.name} ${tradeDir} — closed at ${label}, ${remaining}min cooldown${recentClose.wasLoss ? ' (loss — never override)' : ` (need 95%+ to override, have ${strength}%)`}`);
              continue;
            }
            slog(strat.id, 'info', `[RE-ENTRY] ${market.name} ${tradeDir} — conviction ${strength}% overrides profit-close cooldown`);
          }
        }

        // Skip when paused
        if (getStratState(strat.id) === 'PAUSED') {
          slog(strat.id, 'signal', `[PAUSED] ${market.name} → ${tradeDir} ${strength}% — monitoring only`);
          continue;
        }

        // One-time disclaimer before first live trade
        if (env === 'live') {
          const ok = await confirmLiveTrade();
          if (!ok) { slog(strat.id, 'info', `[LIVE] Disclaimer declined — skipping ${market.name}`); continue; }
        }

        // PERMISSION: Dynamic position sizing — cap size to 5% of available funds.
        // ALSO: cap to stopLoss/stopDist so max loss is guaranteed ≤ stopLoss even
        // after ATR overrides the stop distance used in calcAutoSizing.
        const fundsNow = igFundsRef.current[env];
        const available = fundsNow?.available ?? Infinity;
        const startBal  = startingBalanceRef.current[env];
        const maxLossAllowed = strat.stopLoss ?? 5;
        const sizeCapForLoss = Math.max(0.1, Math.floor((maxLossAllowed / Math.max(1, stopDist)) * 10) / 10);
        const cappedAutoSize = Math.min(autoSize, sizeCapForLoss);
        const orderSizeRaw = calcDynamicSize(cappedAutoSize, available, startBal);

        if (orderSizeRaw === 0) {
          const floorPct = startBal ? ` (floor: 15% of starting £${startBal.toFixed(0)})` : '';
          slog(strat.id, 'error', `[${env.toUpperCase()}] ⚠️ Insufficient funds (£${available.toFixed(2)} available${floorPct}) — pausing trades. Top up at ig.com.`);
          showToast(false, `⚠️ Low funds in IG ${env} — skipping`);
          continue;
        }

        // Corroborated signal: small size boost but capped so max loss stays within stopLoss
        const corroborated = hasCorrelatedConfirmation(market.name, tradeDir, scans);
        const orderSize = corroborated
          ? Math.min(Math.round(orderSizeRaw * 1.5 * 10) / 10, sizeCapForLoss)
          : orderSizeRaw;
        if (corroborated) slog(strat.id, 'info', `[AUTO] Correlated confirmation — size £${orderSize}/pt (capped to £${maxLossAllowed} max loss)`);

        // Capital-floor: if funds tight (< £500), close worst own-mode loser to free capital
        if (available < 500 && ownedPositions.length > 0) {
          const now = Date.now();
          const oldLosers = ownedPositions
            .filter(p => p.upl < 0 && p.createdDate && (now - new Date(p.createdDate).getTime()) > 24 * 3_600_000)
            .sort((a, b) => a.upl - b.upl);
          if (oldLosers.length > 0) {
            const worst = oldLosers[0];
            slog(strat.id, 'info', `[AUTO] Closing ${worst.instrumentName ?? worst.epic} — capital below £500…`);
            const cr = await closePos(env, worst);
            if (cr.ok) {
              const exitPx = worst.direction === 'BUY' ? (worst.bid ?? worst.level) : (worst.offer ?? worst.level);
              slog(strat.id, 'close', `[AUTO] ✓ Closed ${worst.instrumentName ?? worst.epic} — capital floor — P&L: £${(worst.upl ?? 0).toFixed(2)}`);
              setTradeHistory(prev => recordTradeClose(prev, worst.dealId, exitPx, worst.upl ?? 0, 'STRATEGY', new Date().toISOString()));
              await loadPositions(env); await fetchIGFunds(env);
            } else slog(strat.id, 'error', `[${env.toUpperCase()}] Capital-floor close failed: ${cr.error ?? 'unknown'}`);
          }
        }

        if (strength >= 90) slog(strat.id, 'info', `[AUTO] High-confidence signal (${strength}%) — proceeding`);

        // Reserve slot BEFORE any async call — prevents concurrent strategy scans
        // from both passing the pending check before either has added their key.
        pendingOrdersRef.current.add(orderKey);
        // Lock this epic for the rest of THIS scan cycle — protects against the
        // case where placedEpicsRef.clear() hasn't run yet and a second market
        // in the same watchlist maps to the same underlying instrument.
        placedEpicsRef.current.add(`${market.epic}:${env}`);

        // ── Final live guard — ask IG directly before committing funds ─────────
        // positionsRef can be stale if sessions refreshed mid-scan (stale closure issue).
        // This fresh fetch is the bulletproof gate: if the epic is already open in IG,
        // abort regardless of what the ref says.
        try {
          const guardSess = await freshSession(env);
          if (guardSess) {
            const guardRes = await fetch('/api/ig/positions', { headers: makeHeaders(guardSess, env) });
            if (guardRes.ok) {
              const guardData = await guardRes.json() as { ok: boolean; positions?: IGPosition[] };
              if (guardData.ok) {
                const livePos = guardData.positions ?? [];
                positionsRef.current = { ...positionsRef.current, [env]: livePos }; // sync ref
                if (livePos.some(p => p.epic === market.epic)) {
                  slog(strat.id, 'signal', `[GUARD] ${market.name} — live IG check: position already exists, releasing locks`);
                  pendingOrdersRef.current.delete(orderKey);
                  placedEpicsRef.current.delete(`${market.epic}:${env}`);
                  continue;
                }
              }
            }
          }
        } catch { /* network error — proceed with ref-based check */ }

        // Gemini second opinion — SHARES only.
        // INDEX and FOREX are driven by liquid price-action data (RSI/MACD/IG real-time).
        // Calling Gemini on them adds ~10s latency per market with no edge: Gemini has
        // no live price feed and its "opinions" on liquid markets are worse than indicators.
        let effectiveDir: 'BUY' | 'SELL' = tradeDir as 'BUY' | 'SELL';
        if (mType !== 'INDEX' && mType !== 'FOREX') {
          try {
            const gRes = await fetch('/api/gemini/verdict', {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                instrumentName: market.name,
                direction:      effectiveDir,
                strength,
                price:          snapshot.price,
                changePercent:  snapshot.changePercent,
                stopPoints:     stopDist,
                tpPoints:       limitDist,
                marketType:     mType,
              }),
              signal: AbortSignal.timeout(10_000),
            });
            if (gRes.ok) {
              const gv = await gRes.json() as { direction: 'BUY' | 'SELL' | 'SKIP'; confidence: number; reason: string; engine: string };
              slog(strat.id, 'info', `[GEMINI] ${market.name} → ${gv.direction} ${gv.confidence}% — ${gv.reason} (${gv.engine})`);
              if (gv.direction === 'SKIP' || gv.confidence < (strat.minStrength ?? 50)) {
                slog(strat.id, 'info', `[GEMINI] Skipped ${market.name} — ${gv.direction} ${gv.confidence}%`);
                pendingOrdersRef.current.delete(orderKey);
                placedEpicsRef.current.delete(`${market.epic}:${env}`); // release epic lock — no order placed
                continue;
              }
              if (gv.direction === 'BUY' || gv.direction === 'SELL') effectiveDir = gv.direction;
            }
          } catch { /* Gemini unavailable — proceed with original signal */ }
        } else {
          slog(strat.id, 'info', `[${mType}] ${market.name} — skipping Gemini, trusting indicator signal directly`);
        }

        // Hard Paper Mode block at the point of trade decision — not inside placeOrder.
        // placeOrder can be captured in stale closures; this guard runs in the current scan closure.
        if (paperModeRef.current) {
          slog(strat.id, 'info', `[PAPER] Would open: ${effectiveDir} ${market.name} £${orderSize}/pt — Paper Mode is ON, no order sent`);
          pendingOrdersRef.current.delete(orderKey);
          placedEpicsRef.current.delete(`${market.epic}:${env}`);
          continue;
        }

        const maxLoss = orderSize * stopDist;
        slog(strat.id, effectiveDir === 'BUY' ? 'buy' : 'sell',
          `[${env.toUpperCase()}] → ${effectiveDir} ${market.name} | £${orderSize}/pt | SL ${stopDist}pt TP ${limitDist}pt | max loss £${maxLoss.toFixed(2)} | ${strength}%${forceOpen ? ' (FORCE)' : ''}`);

        const or = await placeOrder(env, market.epic, effectiveDir, orderSize, stopDist, limitDist);

        if (or.ok) {
          completedTradesRef.current += 1;
          setCompletedTrades(completedTradesRef.current);
          slog(strat.id, tradeDir === 'BUY' ? 'buy' : 'sell',
            `[${env.toUpperCase()}] ✅ ${or.dealStatus ?? 'ACCEPTED'} — ref ${or.dealReference ?? 'n/a'} · filled @ ${or.level ?? '?'}`);
          showToast(true, `[${env}] ${tradeDir} ${market.name}`);
          setTradeHistory(prev => recordTradeOpen(prev, {
            portfolioName: strat.name, market: market.name, epic: market.epic,
            direction: tradeDir, size: orderSize, entryLevel: or.level ?? 0,
            exitLevel: null, openedAt: new Date().toISOString(), closedAt: null,
            status: 'OPEN', dealReference: or.dealReference ?? '', dealId: or.dealId ?? '',
            pnl: null, closeReason: null, accountType: env,
          }));
          await sleep(1500);
          await loadPositions(env);
          pendingOrdersRef.current.delete(orderKey);
          await loadWorkingOrders(env);
        } else {
          const errStr = (or.error ?? '').toLowerCase();
          if (errStr.includes('insufficient_funds') || errStr.includes('insufficient funds') || errStr.includes('insufficient fund')) {
            slog(strat.id, 'error', `[${env.toUpperCase()}] ⚠️ Insufficient funds — top up at ig.com`);
            showToast(false, `⚠️ Insufficient funds in IG ${env} — skipping`);
            continue;
          }
          slog(strat.id, 'error', `[${env.toUpperCase()}] ❌ ${market.name} FAILED — ${or.error ?? 'unknown'}${or.reason ? ` (${or.reason})` : ''}`);
          if (or.sentPayload) slog(strat.id, 'error', `  sent: ${JSON.stringify(or.sentPayload)}`);
          if (or.igBody)      slog(strat.id, 'error', `  ig:   ${JSON.stringify(or.igBody)}`);
          setTradeHistory(prev => recordTradeOpen(prev, {
            portfolioName: strat.name, market: market.name, epic: market.epic,
            direction: tradeDir, size: orderSize, entryLevel: 0,
            exitLevel: null, openedAt: new Date().toISOString(), closedAt: new Date().toISOString(),
            status: 'REJECTED', dealReference: '', dealId: '',
            pnl: null, closeReason: null, accountType: env,
          }));
          pendingOrdersRef.current.delete(orderKey);
          placedEpicsRef.current.delete(`${market.epic}:${env}`); // release epic lock — order was rejected
        }
      }
    }

    return sig;
  }

  // ── Signal scan: scan markets + execute trades ────────────────────────────
  const runSignalScan = useCallback(async (strat: IGSavedStrategy) => {
    if (getStratState(strat.id) === 'STOPPED') return;

    // ── Concurrent-scan guard ─────────────────────────────────────────────────
    // A scan with Gemini over 20 markets takes 3-5 minutes. If the 5-min timer
    // fires before the previous scan finishes, the new invocation is silently
    // dropped. Without this guard, two overlapping scans both see 0 positions
    // for an epic and both place an order — producing the duplicate-position bug.
    if (scanInProgressRef.current.has(strat.id)) {
      slog(strat.id, 'info', '[SCAN] ⏭ Previous scan still running — skipping this timer fire to prevent duplicates');
      return;
    }
    scanInProgressRef.current.add(strat.id);

    const markets = (strat.watchlist?.length ? strat.watchlist : DEFAULT_WATCHLIST).filter(m => m.enabled);

    // Always use the ref — ensures stale closures (from setInterval) call the latest loadPositions
    // which has the current sessions. Without this, a stale closure uses old sessions → 401 → empty positionsRef.
    const loadPos = loadPositionsRef.current ?? loadPositions;
    await loadPos();

    // PERMISSION: Fetch account balances at the start of each scan cycle so
    // calcDynamicSize() has up-to-date fund data when sizing positions.
    const envs = strat.accounts.filter(e => sessions[e]) as ('demo'|'live')[];

    // Clear intra-cycle epic locks ONLY for this strategy's envs.
    // A global .clear() would wipe locks placed by another concurrently-running strategy,
    // allowing it to open a duplicate that this strategy already locked.
    for (const k of [...placedEpicsRef.current]) {
      if (envs.some(e => k.endsWith(`:${e}`))) placedEpicsRef.current.delete(k);
    }
    for (const env of envs) {
      const funds = await fetchIGFunds(env);
      if (funds) slog(strat.id, 'info', `[${env.toUpperCase()}] 💰 Available: £${funds.available.toFixed(2)} | Balance: £${funds.balance.toFixed(2)}`);
    }

    // Pre-fetch real-time prices + RSI/MACD/ATR from bot server (one call for all markets)
    try {
      const pr = await fetch('/api/ig/bot?action=prices');
      if (pr.ok) {
        const pd = await pr.json() as { ok: boolean; prices: Record<string, BotPriceEntry> };
        if (pd.ok && pd.prices) {
          botPricesRef.current = pd.prices;
          const liveCount = Object.keys(pd.prices).length;
          if (liveCount > 0) slog(strat.id, 'info', `⚡ Bot server: ${liveCount} live feed(s) — RSI/MACD/ATR active`);
        }
      }
    } catch { /* bot server offline */ }

    // Guard: require live candle data before scanning.
    // Without the bot server (Lightstreamer stream OFF), there is no RSI, MACD, or
    // 5-min trend — all the quality gates that prevent bad trades are blind.
    // Trading on daily % change alone produces exactly the noise signals we're trying to avoid.
    const liveFeedCount = Object.values(botPricesRef.current).filter(e => e.candleCount >= 10).length;
    if (liveFeedCount === 0) {
      slog(strat.id, 'info', `[SCAN SKIPPED] No live bot server data — start the Lightstreamer stream in the IG Server Bot panel first`);
      scanInProgressRef.current.delete(strat.id);
      return;
    }

    // Pre-fetch IG client sentiment for all watchlist epics (contrarian gate)
    const envForSent = strat.accounts.includes('live') ? 'live' : 'demo';
    const sentSession = sessions[envForSent];
    if (sentSession) {
      try {
        const epicList = markets.map(m => m.epic).join(',');
        const sr = await fetch(
          `/api/ig/sentiment?marketIds=${encodeURIComponent(epicList)}`,
          { headers: makeHeaders(sentSession, envForSent) },
        );
        if (sr.ok) {
          const sd = await sr.json() as { ok: boolean; sentiments?: { marketId: string; longPct: number; shortPct: number }[] };
          if (sd.ok && sd.sentiments) {
            const next: Record<string, { longPct: number; shortPct: number }> = {};
            for (const s of sd.sentiments) next[s.marketId] = { longPct: s.longPct, shortPct: s.shortPct };
            sentimentRef.current = next;
          }
        }
      } catch { /* sentiment fetch failed — skip contrarian gate this cycle */ }
    }

    // Pre-fetch real-time IG prices for all watchlist epics in a single bulk call.
    // Uses IG's /v1/markets?epics=... endpoint — zero data-allowance cost, <1s, no delay.
    // Stored in igSnapshotRef so fetchSnapshot can use it instead of Yahoo's 15-min delayed data.
    if (sentSession) {
      try {
        const epicList = markets.map(m => m.epic).join(',');
        const igSnap = await fetch(
          `/api/ig/snapshot?epics=${encodeURIComponent(epicList)}`,
          { headers: makeHeaders(sentSession, envForSent) },
        );
        if (igSnap.ok) {
          const sd = await igSnap.json() as { ok: boolean; snapshot?: Record<string, IGSnapshotEntry> };
          if (sd.ok && sd.snapshot) {
            igSnapshotRef.current = sd.snapshot;
            slog(strat.id, 'info', `📊 IG snapshot: ${Object.keys(sd.snapshot).length} real-time prices loaded (replaces Yahoo)`);
          }
        }
      } catch { /* IG snapshot failed — Yahoo fallback remains active */ }
    }

    try {
      slog(strat.id, 'info', `📡 Signal scan — ${markets.length} markets… (fetching news)`);
      await fetchNewsSignals(markets, positions);

      for (let i = 0; i < markets.length; i++) {
        if (getStratState(strat.id) === 'STOPPED') break;
        const m = markets[i];
        setScanProgress(`${m.name} (${i+1}/${markets.length})`);
        await scanMarket(strat, m);
        if (i < markets.length - 1) await sleep(300);
      }

      setScanProgress('');
      const runEnv: 'demo'|'live' = strat.accounts.includes('live') ? 'live' : 'demo';
      const updated: IGSavedStrategy = { ...strat, env: strat.env ?? runEnv, lastRunAt: new Date().toISOString(), lastRunEnv: runEnv };
      saveStrategy(updated);
      setStrategies(loadStrategies(strat.env ?? activeMode));
      const scanMs = strat.signalScanMs ?? signalScanMs;
      lastSignalAtRef.current = Date.now();
      setLastSignalAt(Date.now());
      slog(strat.id, 'info', `Signal scan complete — next in ${Math.round(scanMs / 60_000)}min`);
    } finally {
      // Always release the scan lock — even if an error occurs mid-scan.
      // Without this, a thrown error would permanently block all future scans.
      scanInProgressRef.current.delete(strat.id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, positions, signalScanMs, loadPositions]);
  runSignalScanRef.current = runSignalScan; // keep ref current so the setInterval always calls latest version

  // ── Position monitor: trailing stops + SL/TP refresh + stale recycling ────
  const runPositionMonitor = useCallback(async (strat: IGSavedStrategy) => {
    if (getStratState(strat.id) === 'STOPPED') return;
    await loadPositions();

    // Refresh bot server prices — needed for real-time momentum flip detection
    try {
      const pr = await fetch('/api/ig/bot?action=prices');
      if (pr.ok) {
        const pd = await pr.json() as { ok: boolean; prices: Record<string, BotPriceEntry> };
        if (pd.ok && pd.prices) botPricesRef.current = pd.prices;
      }
    } catch { /* bot server offline — skip flip logic */ }

    const envs = strat.accounts.filter(e => sessions[e]) as ('demo'|'live')[];
    const botMode = strat.mode ?? 'BOTH';
    for (const env of envs) {
      for (const pos of positionsRef.current[env]) {
        // Mode filter: each bot only manages its own direction positions
        if (botMode === 'LONG_ONLY'  && pos.direction === 'SELL') continue;
        if (botMode === 'SHORT_ONLY' && pos.direction === 'BUY')  continue;

        if (!pos.level || !pos.bid || !pos.offer) continue;
        const currentPx = pos.direction === 'BUY' ? pos.bid : pos.offer;
        const entryPx   = pos.level;
        const pnlPct    = pos.direction === 'BUY'
          ? ((currentPx - entryPx) / entryPx) * 100
          : ((entryPx - currentPx) / entryPx) * 100;
        const ageMs = pos.createdDate ? Date.now() - new Date(pos.createdDate).getTime() : 0;
        const ageLabel = ageMs > 86_400_000 ? `${Math.floor(ageMs / 86_400_000)}d` : `${Math.floor(ageMs / 3_600_000)}h`;
        const posName  = pos.instrumentName ?? pos.epic;

        // [FLIP] Core momentum strategy: close and immediately open opposite when
        // raw candle data (from bot server as data source) shows momentum has reversed.
        // Frontend computes the reversal signal — bot server only supplies indicator values.
        // Minimum 2-minute hold prevents flipping on tiny noise candles.
        if (strat.autoClose && strat.autoTrade && ageMs > 2 * 60_000) {
          const botData = botPricesRef.current[pos.epic];
          if (botData && botData.candleCount >= 15) {
            const cRed   = botData.consecutiveReds   ?? 0;
            const cGreen = botData.consecutiveGreens ?? 0;
            // 3+ consecutive candles required (not 2) — 2 red candles is daily noise and
            // leads to closing at £0.10-0.20 profit before the position has room to run.
            const reversalToSell = cRed   >= 3 && (botData.rsi === null || botData.rsi > 30) && (botData.macd === null || botData.macd < 0.001);
            const reversalToBuy  = cGreen >= 3 && (botData.rsi === null || botData.rsi < 70) && (botData.macd === null || botData.macd > -0.001);
            const shouldFlip = (pos.direction === 'BUY'  && reversalToSell) ||
                               (pos.direction === 'SELL' && reversalToBuy);
            if (shouldFlip) {
              const uplNow = pos.upl ?? 0;
              // Minimum £2 profit before reversal close is allowed.
              // This prevents exiting at pennies — a £0.14 profit is not a win,
              // it's noise. One real loss would wipe many such exits.
              const minReversalProfit = 2.0;
              if (uplNow < minReversalProfit) {
                const consTag = pos.direction === 'BUY' ? `${cRed}xred` : `${cGreen}xgreen`;
                slog(strat.id, 'info', `[REVERSAL] Holding ${posName} (${consTag}, P&L £${uplNow.toFixed(2)}) — need ≥£${minReversalProfit} profit to exit on reversal`);
                // fall through to trailing stop logic
              } else {
                const consTag = pos.direction === 'BUY' ? `${cRed}xred` : `${cGreen}xgreen`;
                const rsiTag  = botData.rsi  !== null ? ` RSI:${botData.rsi.toFixed(0)}` : '';
                const macdTag = botData.macd !== null ? ` MACD:${botData.macd > 0 ? '+' : ''}${botData.macd.toFixed(4)}` : '';
                slog(strat.id, 'info', `[REVERSAL] Taking profit: ${posName} ${pos.direction} (${consTag}${rsiTag}${macdTag} P&L:£${uplNow.toFixed(2)})`);

                const cr = await closePos(env, pos);
                if (cr.ok) {
                  todayPnLRef.current += uplNow;
                  setTodayPnL(todayPnLRef.current);
                  slog(strat.id, 'close', `[REVERSAL] ✓ Profit taken: ${posName} @ ${currentPx.toFixed(2)} P&L: £${uplNow.toFixed(2)}`);
                  setTradeHistory(prev => recordTradeClose(prev, pos.dealId, currentPx, uplNow, 'STRATEGY', new Date().toISOString()));
                  recentlyClosedRef.current.set(`${pos.epic}:${pos.direction}`, { closedAt: Date.now(), wasLoss: false });
                } else if ((cr as { alreadyClosed?: boolean }).alreadyClosed) {
                  slog(strat.id, 'info', `[REVERSAL] ${posName} already closed by IG`);
                } else {
                  slog(strat.id, 'error', `[REVERSAL] Close failed: ${cr.error ?? 'unknown'}`);
                }
                continue;
              }
            }
          }
        }

        // [AUTO] Proportional trailing profit lock — scales with position size.
        // Bigger positions move faster in £ terms so thresholds tighten automatically.
        //   breakevenAt = £2 / √(size / 0.2)  → £2.00 at 0.2/pt, £0.89 at 1/pt, £0.63 at 2/pt
        //   trailAt     = breakevenAt × 2
        //   trailPct    = 50% + 5% × log₂(size / 0.2) → 50% at 0.2/pt, 60% at 1/pt, 65% at 2/pt
        if (strat.autoClose) {
          const uplNow    = pos.upl ?? 0;
          const peak      = peakProfitRef.current.get(pos.dealId) ?? 0;
          const newPeak   = Math.max(peak, uplNow);
          if (newPeak !== peak) peakProfitRef.current.set(pos.dealId, newPeak);

          const sizeRatio   = Math.max(1, pos.size / 0.2);
          const breakevenAt = Math.max(0.50, 2.0 / Math.sqrt(sizeRatio));
          const trailAt     = breakevenAt * 2;
          const trailPct    = Math.min(0.75, 0.50 + 0.05 * Math.log2(sizeRatio));

          const breakevenTrigger = newPeak >= breakevenAt && uplNow <= 0;
          const trailTrigger     = newPeak >= trailAt     && uplNow < newPeak * trailPct;
          // Once a position peaks above £5, protect at £5: close the moment it retreats to ≤£5.
          const fiveFloorTrigger = newPeak > 5 && uplNow >= 0 && uplNow <= 5;

          if (breakevenTrigger || trailTrigger || fiveFloorTrigger) {
            const reason = fiveFloorTrigger
              ? `£5 floor — peaked +£${newPeak.toFixed(2)}, back to £${uplNow.toFixed(2)}`
              : breakevenTrigger
              ? `Breakeven lock (≥£${breakevenAt.toFixed(2)}) — peaked +£${newPeak.toFixed(2)}, now £${uplNow.toFixed(2)}`
              : `Trail ${Math.round(trailPct * 100)}% lock (≥£${trailAt.toFixed(2)}) — peaked +£${newPeak.toFixed(2)}, now £${uplNow.toFixed(2)}`;
            slog(strat.id, 'info', `[TRAIL] ${posName}: ${reason}`);
            const cr = await closePos(env, pos);
            if (cr.ok) {
              const exitPx = pos.direction === 'BUY' ? (pos.bid ?? currentPx) : (pos.offer ?? currentPx);
              todayPnLRef.current += uplNow;
              setTodayPnL(todayPnLRef.current);
              peakProfitRef.current.delete(pos.dealId);
              slog(strat.id, 'close', `[TRAIL] ✓ ${posName} closed — P&L: £${uplNow.toFixed(2)}`);
              setTradeHistory(prev => recordTradeClose(prev, pos.dealId, exitPx, uplNow, 'TAKE_PROFIT', new Date().toISOString()));
              recentlyClosedRef.current.set(`${pos.epic}:${pos.direction}`, { closedAt: Date.now(), wasLoss: uplNow < 0 });
            } else if ((cr as {alreadyClosed?:boolean}).alreadyClosed) {
              peakProfitRef.current.delete(pos.dealId);
            } else slog(strat.id, 'error', `[TRAIL] Close failed: ${cr.error ?? 'unknown'}`);
            continue;
          }
        }

        // [AUTO] Hard £5 loss limit — the only reason we close a losing position.
        // Positions between 0 and -£5 are held for recovery. Only at -£5 do we cut.
        // This prevents death-by-a-thousand-cuts from closing losers repeatedly.
        if (strat.autoClose && (pos.upl ?? 0) < -5) {
          const closedPnl = pos.upl ?? 0;
          slog(strat.id, 'info', `[AUTO] £5 loss limit hit: ${posName} at £${closedPnl.toFixed(2)} — closing to cap the damage…`);
          const cr = await closePos(env, pos);
          if (cr.ok) {
            const exitPx = pos.direction === 'BUY' ? (pos.bid ?? currentPx) : (pos.offer ?? currentPx);
            todayPnLRef.current += closedPnl;
            setTodayPnL(todayPnLRef.current);
            slog(strat.id, 'close', `[AUTO] ✓ £5 limit closed: ${posName} — P&L: £${closedPnl.toFixed(2)}`);
            setTradeHistory(prev => recordTradeClose(prev, pos.dealId, exitPx, closedPnl, 'STOP_LOSS', new Date().toISOString()));
            peakProfitRef.current.delete(pos.dealId);
            recentlyClosedRef.current.set(`${pos.epic}:${pos.direction}`, { closedAt: Date.now(), wasLoss: true });
          } else if ((cr as {alreadyClosed?:boolean}).alreadyClosed) {
            slog(strat.id, 'info', `[AUTO] ${posName} already closed by IG`);
          } else slog(strat.id, 'error', `[${env.toUpperCase()}] £5 limit close failed: ${cr.error ?? 'unknown'}`);
          continue;
        }

        // [AUTO] Stale position recycling — PROFIT ONLY.
        // We only recycle stale positions that are in profit. Stale losers are held
        // for recovery — the £5 limit above is their only exit. Taking a stale loss
        // would mean realising avoidable P&L, defeating the profit-only close rule.
        if (pos.createdDate && strat.autoClose) {
          const uplNow = pos.upl ?? 0;
          // Only act on stale positions that are in profit
          const staleThreshold = pnlPct >= 1.0 ? 72 * 3_600_000 : 48 * 3_600_000;
          if (uplNow > 0 && ageMs > staleThreshold) {
            slog(strat.id, 'info', `[AUTO] Closing stale profitable position: ${posName} (${ageLabel} open, +£${uplNow.toFixed(2)})…`);
            const cr = await closePos(env, pos);
            if (cr.ok) {
              const exitPx = pos.direction === 'BUY' ? (pos.bid ?? currentPx) : (pos.offer ?? currentPx);
              todayPnLRef.current += uplNow;
              setTodayPnL(todayPnLRef.current);
              slog(strat.id, 'close', `[AUTO] ✓ Stale profit taken: ${posName} — P&L: £${uplNow.toFixed(2)}`);
              setTradeHistory(prev => recordTradeClose(prev, pos.dealId, exitPx, uplNow, 'STALE', new Date().toISOString()));
              peakProfitRef.current.delete(pos.dealId);
              recentlyClosedRef.current.set(`${pos.epic}:${pos.direction}`, { closedAt: Date.now(), wasLoss: false });
            } else if ((cr as {alreadyClosed?:boolean}).alreadyClosed) {
              slog(strat.id, 'info', `[AUTO] ${posName} already closed by IG (stop/limit/rollover)`);
            } else slog(strat.id, 'error', `[${env.toUpperCase()}] Stale close failed: ${cr.error ?? 'unknown'}`);
            continue;
          }
        }

        // [AUTO] 1R trailing stop ladder — uses the position's own stop distance as
        // the profit unit (1R). This adapts to each position's actual risk rather than
        // using arbitrary % thresholds that ignore volatility.
        //
        //  +1R  → SL to breakeven — zero risk, house money from here
        //  +2R  → trail SL at 1R behind price — capture meaningful gains
        //  +3R  → trail SL at 0.5R behind price — approaching target, lock most gains
        //
        // Great traders protect gains quickly and let the trailing stop do the work.
        const oneR = pos.stopLevel
          ? Math.abs(pos.level - pos.stopLevel)   // actual stop distance placed with trade
          : Math.abs(pos.level * 0.015);           // fallback: 1.5% of entry price

        const priceGain = pos.direction === 'BUY'
          ? currentPx - pos.level
          : pos.level - currentPx;
        const rMultiple = oneR > 0 ? priceGain / oneR : 0;

        let newStop: number | null = null;
        let reason = '';

        if (rMultiple >= 1.0) {
          // +1R → move to breakeven: position is free, no further downside risk
          const breakevenStop = pos.level;
          if (!pos.stopLevel || (pos.direction === 'BUY' ? pos.stopLevel < breakevenStop : pos.stopLevel > breakevenStop)) {
            newStop = breakevenStop;
            reason  = `+${rMultiple.toFixed(1)}R → SL to breakeven @ ${breakevenStop}`;
          }
        }
        if (rMultiple >= 2.0) {
          // +2R → trail at 1R behind current price: capturing real gains
          const trailStop = pos.direction === 'BUY'
            ? Math.round((currentPx - oneR) * 100) / 100
            : Math.round((currentPx + oneR) * 100) / 100;
          const improved = pos.direction === 'BUY'
            ? trailStop > (pos.stopLevel ?? -Infinity)
            : trailStop < (pos.stopLevel ?? Infinity);
          if (improved) { newStop = trailStop; reason = `+${rMultiple.toFixed(1)}R → trail 1R @ ${newStop}`; }
        }
        if (rMultiple >= 3.0) {
          // +3R → tight trail at 0.5R: near target, lock in most of the profit
          const tightStop = pos.direction === 'BUY'
            ? Math.round((currentPx - oneR * 0.5) * 100) / 100
            : Math.round((currentPx + oneR * 0.5) * 100) / 100;
          const improved = pos.direction === 'BUY'
            ? tightStop > (pos.stopLevel ?? -Infinity)
            : tightStop < (pos.stopLevel ?? Infinity);
          if (improved) { newStop = tightStop; reason = `+${rMultiple.toFixed(1)}R → tight trail 0.5R @ ${newStop}`; }
        }

        if (newStop !== null) {
          const r = await updatePositionSL(env, pos, newStop, pos.limitLevel ?? null);
          if (r.ok) slog(strat.id, 'info', `[${env.toUpperCase()}] ${pos.instrumentName ?? pos.epic}: ${reason}`);
        }
      }

      // [AUTO] Trim excess positions — if over effective max, close worst P&L first
      if (strat.autoClose) {
        const botMode2 = strat.mode ?? 'BOTH';
        const ownedDir2 = botMode2 === 'LONG_ONLY' ? 'BUY' : botMode2 === 'SHORT_ONLY' ? 'SELL' : null;
        const ownedNow = positionsRef.current[env].filter(p => ownedDir2 === null || p.direction === ownedDir2);
        const fundsNow2 = igFundsRef.current[env]?.available ?? 0;
        const scanStrengths2 = Object.values(scans).map(s => s.signal?.strength ?? 0).filter(Boolean);
        const avgStr2 = scanStrengths2.length ? scanStrengths2.reduce((a, b) => a + b, 0) / scanStrengths2.length : 60;
        const effectiveMax2 = strat.autoMaxPositions
          ? calcAutoMaxPositions(fundsNow2, avgStr2)
          : strat.maxPositions;
        if (effectiveMax2 > 0 && ownedNow.length > effectiveMax2) {
          // Trim excess — PROFIT ONLY. Sort: profitable positions first (close them
          // to take gains), then positions at the £5 limit. Never close a losing
          // position just to make room — that locks in avoidable losses.
          const excess = [...ownedNow]
            .filter(p => (p.upl ?? 0) > 0 || (p.upl ?? 0) <= -5)  // only closeable
            .sort((a, b) => {
              const aProfit = (a.upl ?? 0) > 0;
              const bProfit = (b.upl ?? 0) > 0;
              if (aProfit && !bProfit) return -1; // close profits first
              if (!aProfit && bProfit) return 1;
              return (b.upl ?? 0) - (a.upl ?? 0); // among profits: largest first
            })
            .slice(0, ownedNow.length - effectiveMax2);
          for (const weak of excess) {
            const weakUpl = weak.upl ?? 0;
            const label = weakUpl > 0 ? 'taking profit' : '£5 limit hit';
            slog(strat.id, 'info', `[AUTO] Trim (${label}): ${weak.instrumentName ?? weak.epic} P&L £${weakUpl.toFixed(2)} — over cap of ${effectiveMax2}`);
            const cr = await closePos(env, weak);
            if (cr.ok) {
              const exitPx = weak.direction === 'BUY' ? (weak.bid ?? weak.level) : (weak.offer ?? weak.level);
              todayPnLRef.current += weakUpl;
              setTodayPnL(todayPnLRef.current);
              slog(strat.id, 'close', `[AUTO] ✓ Trimmed ${weak.instrumentName ?? weak.epic} — P&L: £${weakUpl.toFixed(2)}`);
              setTradeHistory(prev => recordTradeClose(prev, weak.dealId, exitPx, weakUpl, 'STRATEGY', new Date().toISOString()));
              recentlyClosedRef.current.set(`${weak.epic}:${weak.direction}`, { closedAt: Date.now(), wasLoss: weakUpl < 0 });
            } else slog(strat.id, 'error', `[${env.toUpperCase()}] Trim close failed: ${cr.error ?? 'unknown'}`);
          }
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, positions, scans]);

  // ── Start / stop auto-run ──────────────────────────────────────────────────
  function startAutoRun(strat: IGSavedStrategy) {
    // Clear any existing timers for this strategy
    const prev = stratTimersRef.current[strat.id];
    if (prev?.signal) clearInterval(prev.signal);
    if (prev?.pos)    clearInterval(prev.pos);
    stratTimersRef.current[strat.id] = {};

    setStratState(strat.id, 'RUNNING');
    setActiveStratId(strat.id);

    // Runtime tracking
    runtimeStartRef.current = Date.now();
    completedTradesRef.current = 0;
    setCompletedTrades(0);
    todayPnLRef.current = 0;
    setTodayPnL(0);
    setRuntimeDisplay('0s');
    setStoppedAt(null);
    setStopError(null);
    lastSignalAtRef.current = null;
    setLastSignalAt(null);
    setLastSignalDisplay('');
    setRuntimeStartDisplay(new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));

    // Persist running ID for restore on page reload
    localStorage.setItem(`strategy_running_id_${strat.id}`, '1');
    localStorage.setItem(`strategy_state_${strat.id}`, JSON.stringify({
      status: 'running',
      startedAt: new Date().toISOString(),
      lastSignalAt: null,
      lastActivityAt: new Date().toISOString(),
      tradesCount: 0,
      error: null,
    }));

    const sScanMs = strat.signalScanMs ?? signalScanMs;
    const pMonMs  = strat.posMonitorMs ?? posMonitorMs;
    const modeLabel = strat.accounts.includes('live') ? '⚠️ LIVE' : 'demo';

    slog(strat.id, 'info', `▶ Auto-trader started — "${strat.name}" · ${modeLabel} · signals every ${Math.round(sScanMs/60_000)}min · positions every ${Math.round(pMonMs/1000)}s`);

    // Capture starting balance for 15% capital floor check
    const envs = strat.accounts.filter(e => sessions[e]) as ('demo'|'live')[];
    for (const env of envs) {
      const funds = igFundsRef.current[env];
      if (funds) startingBalanceRef.current = { ...startingBalanceRef.current, [env]: funds.balance };
      else {
        // Fetch now if not yet available
        fetchIGFunds(env).then(f => {
          if (f) startingBalanceRef.current = { ...startingBalanceRef.current, [env]: f.balance };
        });
      }
    }

    // Run immediately on start
    signalStartRef.current = Date.now();
    void runSignalScan(strat);
    posStartRef.current = Date.now();
    void runPositionMonitor(strat);

    stratTimersRef.current[strat.id] = {
      signal: setInterval(() => { signalStartRef.current = Date.now(); void (runSignalScanRef.current ?? runSignalScan)(strat); }, sScanMs),
      pos:    setInterval(() => { posStartRef.current    = Date.now(); void runPositionMonitor(strat); }, pMonMs),
    };

    // Also start server-side runner if server mode is enabled
    if (serverMode) void startServerStrategy(strat);
  }

  // ── Test run: one scan cycle, max 1 position opened, then stops ───────────
  async function runTestScan(strat: IGSavedStrategy) {
    if (testRunning || getStratState(strat.id) !== 'STOPPED') return;
    setTestRunning(true);
    runningRef.current = true;
    const testStrat: IGSavedStrategy = { ...strat, maxPositions: 1 };
    slog(strat.id, 'info', `🧪 Test run started — "${strat.name}" · max 1 position · scanning…`);
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
    slog(strat.id, 'info', placed > 0
      ? `🧪 Test complete — ${placed} position opened. Check Positions tab.`
      : `🧪 Test complete — no signals met the ${strat.minStrength}% threshold this scan.`
    );
  }

  function pauseAutoRun(stratId: string) {
    setStratState(stratId, 'PAUSED');
    localStorage.setItem(`strategy_state_${stratId}`, JSON.stringify({
      status: 'paused', pausedAt: new Date().toISOString(), tradesCount: completedTradesRef.current, error: null,
    }));
    const name = strategies.find(s => s.id === stratId)?.name ?? stratId;
    slog(stratId, 'info', `⏸ "${name}" PAUSED — monitoring open positions, no new entries until resumed`);
  }

  function resumeAutoRun(stratId: string) {
    setStratState(stratId, 'RUNNING');
    const name = strategies.find(s => s.id === stratId)?.name ?? stratId;
    slog(stratId, 'info', `▶ "${name}" RESUMED — scanning for new entries`);
  }

  function stopAutoRun(stratId?: string, reason?: string) {
    // If no ID given, stop all running strategies
    const ids = stratId ? [stratId] : Object.keys(stratStateRef.current).filter(id => stratStateRef.current[id] !== 'STOPPED');
    for (const id of ids) {
      setStratState(id, 'STOPPED');
      const timers = stratTimersRef.current[id];
      if (timers?.signal) clearInterval(timers.signal);
      if (timers?.pos)    clearInterval(timers.pos);
      delete stratTimersRef.current[id];
      localStorage.removeItem(`strategy_running_id_${id}`);
      localStorage.setItem(`strategy_state_${id}`, JSON.stringify({
        status: 'stopped', stoppedAt: new Date().toISOString(),
        tradesCount: completedTradesRef.current, error: reason ?? null,
      }));
    }
    setScanProgress('');
    setSignalCountdown('');
    setPosCountdown('');
    runtimeStartRef.current = null;
    setRuntimeDisplay('');
    const now = new Date().toISOString();
    setStoppedAt(now);
    if (reason) setStopError(reason);
    log('info', `⏹ ${ids.length > 1 ? 'All strategies' : 'Strategy'} stopped — ${completedTradesRef.current} trades · Today P&L: ${todayPnLRef.current >= 0 ? '+' : ''}£${todayPnLRef.current.toFixed(2)}`);
    if (serverRunning) stopServerStrategy();
  }

  async function stopAutoRunAndCloseAll() {
    stopAutoRun(undefined);
    log('info', '🔴 STOP + CLOSE ALL — closing all open positions…');
    const allPos: Array<{p: IGPosition; env: 'demo'|'live'}> = [
      ...positions.demo.map(p => ({p, env: 'demo' as const})),
      ...positions.live.map(p => ({p, env: 'live' as const})),
    ];
    for (const {p, env} of allPos) {
      const cr = await closePos(env, p);
      if (cr.ok) {
        const exitPx = p.direction === 'BUY' ? (p.bid ?? p.level) : (p.offer ?? p.level);
        log('close', `[${env.toUpperCase()}] Force-closed ${p.instrumentName ?? p.epic} — P&L: £${(p.upl??0).toFixed(2)}`);
        setTradeHistory(prev => recordTradeClose(prev, p.dealId, exitPx, p.upl??0, 'MANUAL', new Date().toISOString()));
      } else {
        log('error', `[${env.toUpperCase()}] Force-close failed: ${cr.error ?? 'unknown'}`);
      }
    }
    await loadPositions();
  }

  useEffect(() => () => {
    // Clean up all per-strategy timers on unmount
    for (const timers of Object.values(stratTimersRef.current)) {
      if (timers.signal) clearInterval(timers.signal);
      if (timers.pos)    clearInterval(timers.pos);
    }
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
      const loginRes = await fetch('/api/ig/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: creds.username, password: creds.password, apiKey: creds.apiKey, env: 'demo', forceRefresh: true }),
      });
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
      const posRes = await fetch('/api/ig/positions', {
        headers: {
          'x-ig-cst':            cst,
          'x-ig-security-token': secToken,
          'x-ig-api-key':        creds.apiKey,
          'x-ig-env':            'demo',
        },
      });
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
      const orderRes = await fetch('/api/ig/order', {
        method: 'POST',
        headers: { ...makeHeaders(freshSess, 'demo'), 'Content-Type': 'application/json' },
        body: JSON.stringify(orderBody),
      });
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
      setBAutoMaxPos(existing.autoMaxPositions ?? false);
      setBMinStrength(existing.minStrength ?? 55);
      setBAccounts(existing.accounts); setBAutoClose(existing.autoClose ?? true); setBMode(existing.mode ?? 'BOTH');
      setBWatchlist(existing.watchlist?.length ? existing.watchlist : [...DEFAULT_WATCHLIST]);
      setBSignalScanMs(existing.signalScanMs ?? 5 * 60_000);
      setBPosMonitorMs(existing.posMonitorMs ?? 60_000);
      setBStopLoss(existing.stopLoss ?? (existing.stopPct ?? 5));
      setBTakeProfit(existing.takeProfit ?? (existing.targetPct ?? 30));
    } else {
      setEditId(null); setBName(''); setBTimeframe('daily'); setBSize(1); setBMaxPos(10);
      setBAutoMaxPos(false);
      setBMinStrength(55);
      // Only default to live if we actually have a live session
      setBAccounts([sessions[activeMode] ? activeMode : 'demo']);
      setBAutoClose(true); setBMode('BOTH');
      setBWatchlist([...DEFAULT_WATCHLIST]);
      setBSignalScanMs(5 * 60_000);
      setBPosMonitorMs(60_000);
      setBStopLoss(5);
      setBTakeProfit(30);
    }
    setShowBuilder(true);
    setShowManual(false);
  }

  function handleSave() {
    if (!bName.trim()) { showToast(false, 'Strategy name is required'); return; }
    if (bAccounts.length === 0) { showToast(false, 'Select at least one account'); return; }
    const existingStrat = editId ? strategies.find(s => s.id === editId) : null;
    const s: IGSavedStrategy = {
      id: editId ?? uid(),
      name: bName.trim(),
      env: existingStrat?.env ?? activeMode, // env is locked after creation
      epic: '', instrumentName: '', // legacy fields, unused in auto mode
      watchlist: bWatchlist,
      minStrength: bMinStrength,
      timeframe: bTimeframe,
      size: bSize,
      maxPositions: bMaxPos,
      autoMaxPositions: bAutoMaxPos,
      accounts: bAccounts,
      autoTrade: true,
      autoClose: bAutoClose,
      mode: bMode,
      createdAt: existingStrat?.createdAt ?? new Date().toISOString(),
      signalScanMs: bSignalScanMs,
      posMonitorMs: bPosMonitorMs,
      stopLoss: bStopLoss,
      takeProfit: bTakeProfit,
    };
    saveStrategy(s);
    setStrategies(loadStrategies(activeMode));
    setShowBuilder(false);
    showToast(true, `Strategy "${s.name}" ${editId ? 'updated' : 'saved'}`);
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const anyConnected  = Object.values(sessions).some(Boolean);
  const isConnecting  = Object.values(connecting).some(Boolean);
  const activeStrat   = strategies.find(s => s.id === activeStratId) ?? null;
  // Positions are filtered to the active env tab for display isolation
  const allPositions  = positions[activeMode] ?? [];
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

      {/* ── Full-page fixed banner: live strategy running ────────────── */}
      {runStratEnv === 'live' && isRunning && (
        <div className="fixed top-0 left-0 right-0 z-[9998] bg-red-600 text-white text-center py-2 text-sm font-bold flex items-center justify-center gap-4">
          ⚠️ LIVE STRATEGY RUNNING — Real money trades are being placed automatically
          <button
            onClick={() => strategies.filter(s => stratStates[s.id] === 'RUNNING').forEach(s => pauseAutoRun(s.id))}
            className="text-xs bg-white/20 hover:bg-white/30 px-2 py-0.5 rounded font-medium transition-colors">
            Pause All
          </button>
        </div>
      )}

      {/* ── Paper Mode banner — full-width, impossible to miss ──────────── */}
      <div className={clsx(
        'flex items-center gap-3 rounded-lg px-4 py-3 border transition-all',
        paperMode
          ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
          : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
      )}>
        <div className="text-xl">{paperMode ? '🔒' : '⚡'}</div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold">{paperMode ? 'Paper Mode ON — Bot will not place any orders (demo or live)' : 'Paper Mode OFF — Bot is placing real orders on demo and live'}</p>
          <p className="text-[11px] opacity-70 mt-0.5">
            {paperMode
              ? 'Bot scans and logs signals only. No positions will open on demo or live accounts until you turn this off.'
              : 'Bot will open and close positions automatically on whichever accounts your strategies are set to run on.'}
          </p>
        </div>
        <button
          onClick={() => {
            if (paperMode) {
              if (!confirm('Turn off Paper Mode?\n\nThe bot will start placing real orders on your demo and/or live accounts automatically.')) return;
            }
            setPaperMode(v => !v);
          }}
          className={clsx(
            'shrink-0 px-4 py-2 rounded-lg text-xs font-bold border transition-all',
            paperMode
              ? 'bg-amber-500 hover:bg-amber-400 text-black border-amber-400'
              : 'bg-red-600/30 hover:bg-red-600/50 text-red-300 border-red-500/40'
          )}>
          {paperMode ? 'Turn Off Paper Mode (allow trading)' : 'Turn On Paper Mode (stop trading)'}
        </button>
      </div>

      {/* ── Env header badge ─────────────────────────────────────────────── */}
      {activeMode === 'demo' ? (
        <div className="flex items-center gap-2 bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2 text-xs font-semibold text-blue-300">
          <span>🎮</span>
          <span>Demo — Paper Money · IG Practice Account</span>
          <span className="ml-auto text-blue-500 text-[10px] font-normal">Demo strategies are fully isolated from Live</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-xs font-semibold text-red-300">
          <span>⚠️</span>
          <span>LIVE — Real Money · IG Live Account</span>
          <span className="ml-auto text-red-500 text-[10px] font-normal">All trades here use real funds</span>
        </div>
      )}

      {/* ── Stock Spread Bet Opportunities ──────────────────────────────── */}
      <IGStockOpportunities
        session={sessions[activeMode] ?? null}
        env={activeMode}
        availableCapital={igFundsDisplay[activeMode]?.available ?? 1000}
      />

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
                    if (env === 'live') { handleSwitchToLive(); }
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
          {/* Connection chips + funds */}
          {(['demo','live'] as const).map(env => sessions[env] && (
            <div key={env} className={clsx('flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full',
              env==='demo' ? 'bg-blue-500/15 text-blue-400' : 'bg-amber-500/15 text-amber-400'
            )}>
              <Wifi className="h-2.5 w-2.5" />
              #{sessions[env]!.accountId}
              {igFundsDisplay[env] && (
                <span className="ml-1 opacity-80">£{igFundsDisplay[env]!.available.toFixed(0)} avail</span>
              )}
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

      {/* ── Live mode confirmation modal (per-session) ──────────────── */}
      {showLiveConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4">
          <div className="bg-gray-900 border border-red-500/50 rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-xl bg-red-500/20 flex items-center justify-center text-2xl">⚠️</div>
              <div>
                <h3 className="text-base font-bold text-white">Switching to Live Trading</h3>
                <p className="text-xs text-red-400 font-semibold">Real money will be used</p>
              </div>
            </div>
            <div className="space-y-2 text-xs text-gray-300 mb-5 bg-red-500/5 border border-red-500/20 rounded-lg p-3">
              <p>• <span className="text-white font-medium">Demo strategies are NOT shown here</span></p>
              <p>• Any strategy you run here uses <span className="text-white font-medium">real funds</span></p>
              <p>• Losses are real and <span className="text-white font-medium">cannot be reversed</span></p>
              <p>• Spread bets are complex, leveraged instruments</p>
              <p className="text-gray-500 pt-1">Your demo strategies continue running safely in the background.</p>
            </div>
            <label className="flex items-center gap-2 text-xs text-gray-400 mb-4 cursor-pointer">
              <input type="checkbox" checked={liveConfirmSkipSession} onChange={e => setLiveConfirmSkipSession(e.target.checked)}
                className="w-3.5 h-3.5 accent-amber-500" />
              Don&apos;t show again this session
            </label>
            <div className="flex gap-2">
              <Button fullWidth variant="outline" onClick={() => { setShowLiveConfirm(false); setLiveConfirmSkipSession(false); }}>
                Cancel — Stay on Demo
              </Button>
              <Button fullWidth className="bg-red-600 hover:bg-red-500 text-white font-bold"
                onClick={() => {
                  if (liveConfirmSkipSession) sessionStorage.setItem('live_confirmed_this_session', '1');
                  setActiveMode('live');
                  setShowLiveConfirm(false);
                  setLiveConfirmSkipSession(false);
                  if (pendingRunAction) { pendingRunAction(); setPendingRunAction(null); }
                }}>
                I understand — Enter Live
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

      {/* ── Copy to Demo modal ──────────────────────────────────────────── */}
      {copyModal?.direction === 'toDemo' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="bg-gray-900 border border-blue-500/40 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-xl bg-blue-500/20 flex items-center justify-center text-xl">📋</div>
              <div>
                <h3 className="text-sm font-bold text-white">Copy to Demo</h3>
                <p className="text-xs text-blue-400">No live trades affected</p>
              </div>
            </div>
            <p className="text-xs text-gray-400 mb-2">
              A new identical strategy will be created on your <span className="text-white font-medium">Demo account</span>.
            </p>
            <p className="text-xs text-gray-500 mb-5">
              Strategy: <span className="text-white">{copyModal.strat.name}</span><br />
              New name: <span className="text-blue-300">{copyModal.strat.name} (Demo Copy)</span>
            </p>
            <div className="flex gap-2">
              <Button fullWidth variant="outline" onClick={() => setCopyModal(null)}>Cancel</Button>
              <Button fullWidth className="bg-blue-600 hover:bg-blue-500 text-white"
                onClick={() => {
                  const copy: IGSavedStrategy = {
                    ...copyModal.strat,
                    id: Date.now().toString(),
                    name: copyModal.strat.name + ' (Demo Copy)',
                    env: 'demo',
                    accounts: ['demo'],
                    copiedFrom: 'live',
                    copiedAt: new Date().toISOString(),
                    lastRunAt: undefined,
                    lastRunEnv: undefined,
                  };
                  saveStrategy(copy);
                  setCopyModal(null);
                  showToast(true, 'Strategy copied to Demo tab successfully');
                }}>
                Copy to Demo
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Copy to Live modal ──────────────────────────────────────────── */}
      {copyModal?.direction === 'toLive' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4">
          <div className="bg-gray-900 border border-red-500/50 rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-red-500/20 flex items-center justify-center text-xl">⚠️</div>
              <div>
                <h3 className="text-sm font-bold text-white">Copy Demo Strategy to Live?</h3>
                <p className="text-xs text-red-400">REAL money will be used when you run it</p>
              </div>
            </div>
            <div className="text-xs text-gray-400 space-y-1 mb-4 bg-red-500/5 border border-red-500/20 rounded-lg p-3">
              <p>Strategy: <span className="text-white font-medium">{copyModal.strat.name}</span></p>
              <p>Markets: <span className="text-white">{(copyModal.strat.watchlist?.length ? copyModal.strat.watchlist : DEFAULT_WATCHLIST).filter(m => m.enabled).map(m => m.name).join(', ')}</span></p>
              <p>Max loss: <span className="text-white">£{copyModal.strat.stopLoss ?? copyModal.strat.stopPct ?? 5}</span> · Target gain: <span className="text-white">£{copyModal.strat.takeProfit ?? copyModal.strat.targetPct ?? 30}</span></p>
              <p className="text-gray-600 pt-1">The strategy will NOT start automatically — you must run it manually on the Live tab.</p>
            </div>
            <div className="mb-4">
              <label className="text-xs text-gray-400 mb-1.5 block">Type <span className="text-white font-mono font-bold">CONFIRM</span> to proceed:</label>
              <input
                type="text"
                value={copyConfirmText}
                onChange={e => setCopyConfirmText(e.target.value)}
                placeholder="CONFIRM"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-red-500"
              />
            </div>
            <div className="flex gap-2">
              <Button fullWidth variant="outline" onClick={() => { setCopyModal(null); setCopyConfirmText(''); }}>Cancel</Button>
              <Button fullWidth className="bg-red-600 hover:bg-red-500 text-white font-bold"
                disabled={copyConfirmText !== 'CONFIRM'}
                onClick={() => {
                  const copy: IGSavedStrategy = {
                    ...copyModal.strat,
                    id: Date.now().toString(),
                    name: copyModal.strat.name + ' (Live)',
                    env: 'live',
                    accounts: ['live'],
                    copiedFrom: 'demo',
                    copiedAt: new Date().toISOString(),
                    lastRunAt: undefined,
                    lastRunEnv: undefined,
                  };
                  saveStrategy(copy);
                  setCopyModal(null);
                  setCopyConfirmText('');
                  showToast(true, 'Strategy copied to Live tab — go to Live tab to run it');
                }}>
                I understand — Copy to Live
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Sync Settings modal ─────────────────────────────────────────── */}
      {syncModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            <h3 className="text-sm font-bold text-white mb-3">⟳ Sync Settings</h3>
            <p className="text-xs text-gray-400 mb-3">The following settings from the Demo strategy will be applied to the Live copy:</p>
            <div className="space-y-1 text-xs mb-5 bg-gray-800 rounded-lg p-3">
              {[
                ['Max loss', `£${syncModal.demo.stopLoss ?? syncModal.demo.stopPct ?? 5}`, `£${syncModal.live.stopLoss ?? syncModal.live.stopPct ?? 5}`],
                ['Target gain', `£${syncModal.demo.takeProfit ?? syncModal.demo.targetPct ?? 30}`, `£${syncModal.live.takeProfit ?? syncModal.live.targetPct ?? 30}`],
                ['Size', `£${syncModal.demo.size}/pt`, `£${syncModal.live.size}/pt`],
                ['Min signal', `${syncModal.demo.minStrength ?? 55}%`, `${syncModal.live.minStrength ?? 55}%`],
                ['Max positions', String(syncModal.demo.maxPositions), String(syncModal.live.maxPositions)],
              ].map(([label, demoVal, liveVal]) => (
                <div key={label} className="flex items-center justify-between">
                  <span className="text-gray-500">{label}</span>
                  <span className={clsx('font-mono', demoVal !== liveVal ? 'text-amber-400' : 'text-gray-600')}>
                    {demoVal !== liveVal ? `${liveVal} → ${demoVal}` : `${demoVal} (unchanged)`}
                  </span>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <Button fullWidth variant="outline" onClick={() => setSyncModal(null)}>Cancel</Button>
              <Button fullWidth onClick={() => {
                const synced: IGSavedStrategy = {
                  ...syncModal.live,
                  stopLoss: syncModal.demo.stopLoss ?? syncModal.demo.stopPct ?? 5,
                  takeProfit: syncModal.demo.takeProfit ?? syncModal.demo.targetPct ?? 30,
                  size: syncModal.demo.size,
                  minStrength: syncModal.demo.minStrength,
                  maxPositions: syncModal.demo.maxPositions,
                  watchlist: syncModal.demo.watchlist,
                  timeframe: syncModal.demo.timeframe,
                };
                saveStrategy(synced);
                setStrategies(loadStrategies(activeMode));
                setSyncModal(null);
                showToast(true, 'Live strategy settings synced from Demo');
              }}>
                Apply Sync
              </Button>
            </div>
          </div>
        </div>
      )}

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

            {/* Env lock indicator */}
            <div className={clsx('flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold',
              activeMode === 'live' ? 'bg-red-500/10 border border-red-500/30 text-red-300' : 'bg-blue-500/10 border border-blue-500/20 text-blue-300'
            )}>
              {activeMode === 'live' ? '⚠️' : '🎮'}
              This strategy will run on: <span className="font-bold">{activeMode === 'live' ? 'LIVE — Real Money' : 'Demo — Paper Money'}</span>
              {editId && <span className="ml-auto text-[10px] opacity-60">(env locked after creation)</span>}
            </div>

            {/* Name + timeframe */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Strategy Name *</label>
                <input value={bName} onChange={e => setBName(e.target.value)} placeholder="e.g. Daily Swing Bot"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-orange-500" />
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Trading Timeframe</label>
                <select value={bTimeframe} onChange={e => setBTimeframe(e.target.value as Timeframe)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500">
                  <optgroup label="Classic Strategies">
                    <option value="hourly">⚡ Intraday (Hours) — EMA9/21 + RSI, exit same session</option>
                    <option value="daily">📅 Day Trade — EMA20/50 + MACD, exit same day</option>
                    <option value="weekly">📆 Swing (Days–Weeks) — wider stops, hold several days</option>
                    <option value="longterm">📈 Long-term Trend — Golden/Death Cross, weeks/months</option>
                    <option value="rsi2">⭐ RSI(2) Mean Reversion — lowest API usage</option>
                  </optgroup>
                  <optgroup label="Advanced Strategies (Higher Win Rate)">
                    <option value="bollinger">🎯 Bollinger Band Reversion — ~65% WR, mean reversion</option>
                    <option value="triple-ema">🚀 Triple EMA (8/21/55) — ~70% WR, trend confirmation</option>
                    <option value="supertrend">⚡ Supertrend (3,10) — ~68% WR, ATR-based trend filter</option>
                  </optgroup>
                </select>
              </div>
            </div>

            <div className="rounded-lg border border-orange-500/20 bg-orange-500/5 px-3 py-2.5 space-y-1">
              <p className="text-xs text-orange-300 font-semibold">{TIMEFRAME_CONFIG[bTimeframe].label} — stop &amp; TP sizing</p>
              <p className="text-[11px] text-orange-300/70">{TIMEFRAME_CONFIG[bTimeframe].stopNote}</p>
              <p className="text-[10px] text-gray-500">{TIMEFRAME_CONFIG[bTimeframe].description}</p>
            </div>

            {/* Risk per trade + max positions */}
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Size £/point</label>
                <div className="w-full bg-gray-800/60 border border-orange-500/30 rounded-lg px-3 py-2 text-sm text-orange-300 font-mono cursor-default" title="Auto-calculated per market from your £ stop loss">
                  Auto
                </div>
                <p className="text-[10px] text-gray-600 mt-1">£{bStopLoss} ÷ stop pts</p>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs text-gray-400">Max positions</label>
                  <button onClick={() => setBAutoMaxPos(v => !v)}
                    className={clsx('flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border transition-colors', bAutoMaxPos ? 'bg-violet-500/20 border-violet-500/50 text-violet-300' : 'bg-gray-800 border-gray-700 text-gray-500')}>
                    <span>{bAutoMaxPos ? '⚡ Auto' : 'Manual'}</span>
                  </button>
                </div>
                {bAutoMaxPos
                  ? <div className="w-full bg-gray-800/60 border border-violet-500/30 rounded-lg px-3 py-2 text-sm text-violet-300 font-mono cursor-default">Scales with funds + signal quality</div>
                  : <input type="number" min={0} max={20} value={bMaxPos} onChange={e => setBMaxPos(Number(e.target.value))}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500" />
                }
                {!bAutoMaxPos && bMaxPos === 0 && <p className="text-[10px] text-orange-400 mt-1">∞ No position limit</p>}
                {bAutoMaxPos && <p className="text-[10px] text-gray-500 mt-1">£500→2 · £1k→3 · £2k→4 · £3k→5 · +1 if signals strong</p>}
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

            {/* Direction mode */}
            <div>
              <label className="text-xs text-gray-400 mb-1.5 block">Direction mode</label>
              <div className="grid grid-cols-3 gap-2">
                {([
                  { value: 'LONG_ONLY',  label: '📈 Long only',  desc: 'BUY entries only, close on reversal' },
                  { value: 'SHORT_ONLY', label: '📉 Short only', desc: 'SELL entries only, close on reversal' },
                  { value: 'BOTH',       label: '↕ Both',        desc: 'Long and short entries' },
                ] as const).map(opt => (
                  <button key={opt.value} onClick={() => setBMode(opt.value)}
                    className={clsx('rounded-lg border px-2 py-2 text-left transition-all',
                      bMode === opt.value
                        ? opt.value === 'LONG_ONLY'  ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
                          : opt.value === 'SHORT_ONLY' ? 'bg-red-500/20 border-red-500/40 text-red-300'
                          : 'bg-orange-500/20 border-orange-500/40 text-orange-300'
                        : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-300'
                    )}>
                    <p className="text-[11px] font-semibold">{opt.label}</p>
                    <p className="text-[10px] opacity-70 mt-0.5">{opt.desc}</p>
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
                  <option value={90_000}>90 seconds</option>
                  <option value={2 * 60_000}>2 minutes</option>
                  <option value={3 * 60_000}>3 minutes</option>
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

            {/* Fixed £ stop loss and take profit */}
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-400 mb-1.5 block">Max Loss (£)</label>
                  <div className="flex items-center gap-2">
                    <input type="range" min={1} max={50} step={1} value={bStopLoss}
                      onChange={e => setBStopLoss(Number(e.target.value))}
                      className="flex-1 accent-red-500" />
                    <span className="text-sm font-mono text-red-400 w-10">£{bStopLoss}</span>
                  </div>
                </div>
                <div>
                  <label className="text-xs text-gray-400 mb-1.5 block">Target Gain (£)</label>
                  <div className="flex items-center gap-2">
                    <input type="range" min={5} max={200} step={5} value={bTakeProfit}
                      onChange={e => setBTakeProfit(Number(e.target.value))}
                      className="flex-1 accent-emerald-500" />
                    <span className="text-sm font-mono text-emerald-400 w-10">£{bTakeProfit}</span>
                  </div>
                </div>
              </div>
              <div className="bg-gray-800/40 rounded-lg px-3 py-2 text-[11px] space-y-0.5">
                <p className="text-gray-300">Risk/Reward: 1:{(bTakeProfit/bStopLoss).toFixed(1)} — risking £{bStopLoss} to gain £{bTakeProfit}</p>
                <p className="text-gray-500">Position size auto-calculated per market (e.g. FTSE stop ~24pt → £{(bStopLoss/24).toFixed(2)}/pt). IG sets SL/TP immediately after fill.</p>
              </div>
            </div>

            {/* Watchlist */}
            <div>
              {/* Header row with master checkbox + select all / deselect all */}
              <div className="flex items-center gap-2 mb-1.5">
                {/* Master toggle checkbox */}
                <button
                  onClick={() => {
                    const allOn = bWatchlist.every(m => m.enabled);
                    setBWatchlist(p => p.map(m => ({ ...m, enabled: !allOn })));
                  }}
                  title={bWatchlist.every(m => m.enabled) ? 'Deselect all' : 'Select all'}
                  className={clsx(
                    'w-4 h-4 rounded flex items-center justify-center flex-shrink-0 transition-all',
                    bWatchlist.every(m => m.enabled)
                      ? 'bg-orange-500'
                      : bWatchlist.some(m => m.enabled)
                      ? 'bg-orange-500/40 border border-orange-500/60'
                      : 'bg-gray-700 border border-gray-600',
                  )}>
                  {bWatchlist.every(m => m.enabled) && <span className="text-white text-[8px] font-bold">✓</span>}
                  {!bWatchlist.every(m => m.enabled) && bWatchlist.some(m => m.enabled) && (
                    <span className="text-orange-400 text-[8px] font-bold">−</span>
                  )}
                </button>
                <label className="text-xs text-gray-400 flex-1">Markets to scan</label>
                <span className="text-[10px] text-orange-400 font-medium">
                  {bWatchlist.filter(m => m.enabled).length} enabled
                </span>
                <span className="text-[10px] text-gray-700">·</span>
                <button
                  onClick={() => setBWatchlist(p => p.map(m => ({ ...m, enabled: true })))}
                  className="text-[10px] text-gray-500 hover:text-orange-400 transition-colors">
                  all
                </button>
                <span className="text-[10px] text-gray-700">/</span>
                <button
                  onClick={() => setBWatchlist(p => p.map(m => ({ ...m, enabled: false })))}
                  className="text-[10px] text-gray-500 hover:text-red-400 transition-colors">
                  none
                </button>
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
            const stratState = stratStates[strat.id] ?? 'STOPPED';
            const stratEnv = strat.env ?? 'demo';
            const enabledMarkets = (strat.watchlist?.length ? strat.watchlist : DEFAULT_WATCHLIST).filter(m => m.enabled);
            const cfg = TIMEFRAME_CONFIG[strat.timeframe];
            const isLiveStrat = stratEnv === 'live';
            // Cross-env guard: strategy env must match the current tab
            const canRun = stratEnv === activeMode;
            return (
              <Card key={strat.id} className={clsx(
                stratState !== 'STOPPED' && (isLiveStrat ? 'border-red-500/40 bg-red-500/[0.03]' : 'border-blue-500/40 bg-blue-500/[0.03]'),
                stratState === 'STOPPED' && (isLiveStrat ? 'border-red-900/40' : 'border-blue-900/30')
              )}>
                {/* Env left border accent */}
                <div className={clsx('absolute left-0 top-0 bottom-0 w-0.5 rounded-l-xl', isLiveStrat ? 'bg-red-500/60' : 'bg-blue-500/60')} />
                <div className="flex items-start justify-between gap-3">
                  {/* Strategy info */}
                  <button className="flex-1 text-left min-w-0" onClick={() => setActiveStratId(activeStratId === strat.id ? null : strat.id)}>
                    <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                      <p className="text-sm font-bold text-white">{strat.name}</p>
                      {/* Env badge */}
                      {isLiveStrat
                        ? <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400 font-semibold">⚠️ Live</span>
                        : <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/20 text-blue-400 font-semibold">🎮 Demo</span>
                      }
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-300">{cfg.label}</span>
                      {strat.autoClose && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-500/20 text-purple-400">AutoClose</span>}
                      {strat.mode === 'LONG_ONLY'  && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400">📈 Long only</span>}
                      {strat.mode === 'SHORT_ONLY' && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400">📉 Short only</span>}
                      {strat.copiedFrom && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-700 text-gray-400">
                          📋 Copied from {strat.copiedFrom}{strat.copiedAt ? ` · ${new Date(strat.copiedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-gray-500">
                      {enabledMarkets.length} markets · {strat.maxPositions === 0 ? '∞ no pos limit' : `max ${strat.maxPositions} pos`} · min {strat.minStrength ?? 55}% signal · {cfg.stopNote}
                      {strat.lastRunAt && (
                        <span> · last {fmtTime(strat.lastRunAt)}
                          {strat.lastRunEnv && (
                            <span className={strat.lastRunEnv === 'live' ? ' text-red-400' : ' text-blue-400'}>
                              {' '}on {strat.lastRunEnv === 'live' ? 'LIVE' : 'demo'}
                            </span>
                          )}
                        </span>
                      )}
                    </p>
                  </button>

                  {/* Controls — per-strategy */}
                  <div className="flex items-center gap-1.5 flex-shrink-0 flex-wrap">
                    {/* Running state badge */}
                    {stratState !== 'STOPPED' && (
                      <span className={clsx('text-[9px] px-1.5 py-0.5 rounded font-bold border',
                        stratState === 'RUNNING'
                          ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30 animate-pulse'
                          : 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
                      )}>
                        {stratState === 'RUNNING' ? 'LIVE' : 'PAUSED'}
                      </span>
                    )}

                    {stratState !== 'STOPPED' ? (
                      <>
                        {stratState === 'PAUSED' ? (
                          <Button size="sm" variant="outline" className="text-amber-400 border-amber-500/40"
                            icon={<Play className="h-3.5 w-3.5" />}
                            onClick={() => resumeAutoRun(strat.id)}>
                            Resume
                          </Button>
                        ) : (
                          <Button size="sm" variant="outline" icon={<Pause className="h-3.5 w-3.5" />}
                            onClick={() => pauseAutoRun(strat.id)}>
                            Pause
                          </Button>
                        )}
                        <Button size="sm" className="bg-red-600 hover:bg-red-500 text-white"
                          icon={<Square className="h-3.5 w-3.5" />}
                          onClick={() => stopAutoRun(strat.id)}>
                          Stop
                        </Button>
                        <button
                          onClick={() => { if (confirm('Stop trading AND close ALL open positions immediately?')) void stopAutoRunAndCloseAll(); }}
                          className="text-[10px] px-2 py-1 rounded border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors whitespace-nowrap">
                          Stop+Close All
                        </button>
                      </>
                    ) : canRun ? (
                      <Button size="sm"
                        className={isLiveStrat ? 'bg-red-600 hover:bg-red-500 text-white font-bold' : 'bg-blue-600 hover:bg-blue-500 text-white'}
                        icon={<Play className="h-3.5 w-3.5" />}
                        onClick={() => {
                          const doRun = () => { setActiveStratId(strat.id); startAutoRun(strat); };
                          if (isLiveStrat) {
                            if (confirm(`▶ Run LIVE strategy "${strat.name}" with real money? This will place real spread-bet orders.`)) doRun();
                          } else { doRun(); }
                        }}>
                        {isLiveStrat ? '▶ Run LIVE — Real Money' : '▶ Run on Demo'}
                      </Button>
                    ) : (
                      <span className="text-[10px] text-gray-600 px-2 py-1 border border-gray-800 rounded italic">
                        Switch to {stratEnv} tab to run
                      </span>
                    )}
                    {stratState === 'STOPPED' && canRun && (
                      <>
                        <Button size="sm" variant="outline"
                          loading={testRunning && strat.id === activeStratId}
                          disabled={testRunning}
                          onClick={() => { setActiveStratId(strat.id); void runTestScan(strat); }}
                          title="Run one scan cycle — opens max 1 position">
                          Test
                        </Button>
                        <button onClick={() => openBuilder(strat)} className="p-1.5 text-gray-600 hover:text-orange-400 transition-colors"><Edit2 className="h-3.5 w-3.5" /></button>
                        <button onClick={() => { deleteStrategy(strat.id, strat.env ?? activeMode); setStrategies(loadStrategies(activeMode)); stopAutoRun(strat.id); }}
                          className="p-1.5 text-gray-600 hover:text-red-400 transition-colors"><Trash2 className="h-3.5 w-3.5" /></button>
                      </>
                    )}
                    {/* Copy buttons */}
                    {stratState === 'STOPPED' && (
                      isLiveStrat ? (
                        <button onClick={() => { setCopyModal({ strat, direction: 'toDemo' }); setCopyConfirmText(''); }}
                          className="text-[10px] px-2 py-1 rounded border border-blue-500/30 text-blue-400 hover:bg-blue-500/10 transition-colors whitespace-nowrap">
                          📋 Copy to Demo
                        </button>
                      ) : (
                        <button onClick={() => { setCopyModal({ strat, direction: 'toLive' }); setCopyConfirmText(''); }}
                          className="text-[10px] px-2 py-1 rounded border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors whitespace-nowrap">
                          🔴 Copy to Live
                        </button>
                      )
                    )}
                    {/* Server mode toggle — keeps strategy alive even when browser is closed */}
                    {stratState === 'STOPPED' && canRun && (
                      <label className="flex items-center gap-1.5 cursor-pointer select-none" title="Run on Oracle VM server — strategy continues even if you close the browser">
                        <input
                          type="checkbox"
                          checked={serverMode}
                          onChange={e => setServerMode(e.target.checked)}
                          className="w-3 h-3 accent-violet-500"
                        />
                        <span className="text-[10px] text-gray-400">Run on server</span>
                      </label>
                    )}
                    {stratState !== 'STOPPED' && serverRunning && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-violet-500/20 border border-violet-500/30 text-violet-300">VM running</span>
                    )}

                    {/* Sync settings button — only for copied strategies */}
                    {stratState === 'STOPPED' && strat.copiedFrom && (
                      (() => {
                        const srcEnv = strat.copiedFrom as 'demo' | 'live';
                        const origName = strat.name.replace(/ \((Demo Copy|Live)\)$/, '');
                        const srcStrat = loadStrategies(srcEnv).find(s => s.name === origName || s.name === origName + (srcEnv === 'live' ? ' (Live)' : ' (Demo Copy)'));
                        if (!srcStrat) return null;
                        return (
                          <button onClick={() => setSyncModal(strat.env === 'live' ? { demo: srcStrat, live: strat } : { demo: strat, live: srcStrat })}
                            className="text-[10px] px-2 py-1 rounded border border-gray-700 text-gray-500 hover:text-gray-300 hover:border-gray-600 transition-colors whitespace-nowrap">
                            ⟳ Sync Settings
                          </button>
                        );
                      })()
                    )}
                  </div>
                </div>

                {/* ── Status display (RUNNING / PAUSED / STOPPED / not-started) ── */}
                {stratState === 'RUNNING' && (
                  <div className="mt-2 rounded-lg px-3 py-2.5 space-y-2 border bg-emerald-500/[0.06] border-emerald-500/25">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
                      </span>
                      <span className="text-xs font-bold text-emerald-300">
                        ● LIVE — {scanProgress ? `Scanning: ${scanProgress}` : 'Running'}
                      </span>
                      {runtimeDisplay && <span className="text-[10px] text-gray-500 ml-auto font-mono">Runtime: {runtimeDisplay}</span>}
                    </div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-gray-500">
                      {runtimeStartDisplay && <span>Running since <span className="text-gray-300 font-mono">{runtimeStartDisplay}</span></span>}
                      {lastSignalDisplay ? <span>Last signal: <span className="text-amber-400 font-mono">{lastSignalDisplay}</span></span>
                        : <span className="text-gray-600">Last signal: awaiting…</span>}
                      <span>Trades today: <span className="text-white font-semibold">{completedTrades}</span></span>
                      <span>Today P&L: <span className={clsx('font-semibold', todayPnL >= 0 ? 'text-emerald-400' : 'text-red-400')}>{todayPnL >= 0 ? '+' : ''}£{Math.abs(todayPnL).toFixed(2)}</span></span>
                      {strat.accounts.map(env => igFundsDisplay[env] && (
                        <span key={env}>Deployed: <span className="text-emerald-400 font-semibold">£{(igFundsDisplay[env]!.balance - igFundsDisplay[env]!.available).toFixed(0)} / £{igFundsDisplay[env]!.balance.toFixed(0)}</span></span>
                      ))}
                      {signalCountdown && <span>Next scan: <span className="text-emerald-400 font-mono">{signalCountdown}</span></span>}
                      {posCountdown && <span>Pos check: <span className="text-blue-400 font-mono">{posCountdown}</span></span>}
                    </div>
                    {/* Mini activity log — last 5 entries for this strategy */}
                    {(stratLogs[strat.id] ?? []).slice(0, 5).length > 0 && (
                      <div className="pt-1.5 border-t border-emerald-500/10 space-y-0.5">
                        {(stratLogs[strat.id] ?? []).slice(0, 5).map(entry => (
                          <p key={entry.id} className={clsx('text-[10px] leading-tight truncate',
                            entry.type === 'buy' ? 'text-emerald-400' :
                            entry.type === 'sell' || entry.type === 'close' ? 'text-red-400' :
                            entry.type === 'error' ? 'text-red-500' :
                            entry.type === 'signal' ? 'text-amber-400' :
                            'text-gray-600'
                          )}>
                            <span className="text-gray-700">{fmtTime(entry.ts)} </span>{entry.msg}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {stratState === 'PAUSED' && (
                  <div className="mt-2 rounded-lg px-3 py-2.5 space-y-1.5 border bg-amber-500/[0.06] border-amber-500/25">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
                        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500" />
                      </span>
                      <span className="text-xs font-bold text-amber-300">● PAUSED — monitoring only, no new entries</span>
                      {runtimeDisplay && <span className="text-[10px] text-gray-500 ml-auto font-mono">Runtime: {runtimeDisplay}</span>}
                    </div>
                    <div className="flex gap-4 text-[11px] text-gray-500 flex-wrap">
                      <span>{(positions.demo.length + positions.live.length)} position(s) still open and monitored</span>
                      <span>Trades: <span className="text-white font-semibold">{completedTrades}</span></span>
                    </div>
                  </div>
                )}
                {stratState === 'STOPPED' && stoppedAt && strat.id === activeStratId && (
                  <div className="mt-2 rounded-lg px-3 py-2.5 space-y-1.5 border bg-red-500/[0.06] border-red-500/25">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
                        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
                      </span>
                      <span className="text-xs font-bold text-red-300">● STOPPED</span>
                      <span className="text-[10px] text-gray-500">Last run: {fmtTime(stoppedAt)}</span>
                    </div>
                    {stopError && <p className="text-[11px] text-red-400">Error: {stopError}</p>}
                    {!stopError && <p className="text-[11px] text-gray-500">Stopped by user · {completedTrades} trades · P&L: {todayPnL >= 0 ? '+' : ''}£{Math.abs(todayPnL).toFixed(2)} today</p>}
                  </div>
                )}
                {!strat.lastRunAt && !isRunning && (
                  <div className="mt-2 rounded-lg px-3 py-2 border border-gray-800/60 bg-gray-800/20">
                    <span className="text-[11px] text-gray-600">○ Not started — click Start to begin scanning</span>
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
            subtitle={(() => {
              const botCount   = scanEntries.filter(s => s.status === 'ok' && (s.source === 'yahoo+bot' || s.source === 'bot-server')).length;
              const okCount    = scanEntries.filter(s => s.status === 'ok').length;
              const src = botCount > 0
                ? `Yahoo Finance · ⚡ ${botCount} bot-verified`
                : 'Yahoo Finance';
              return scanEntries.some(s => s.status === 'ok')
                ? `${src} · ${okCount}/${scanEntries.length} markets · last ${fmtTime(scanEntries.find(s=>s.lastScanned)?.lastScanned ?? new Date().toISOString())}`
                : `${src} · ${scanEntries.length} markets ready — click Run to start`;
            })()}
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

                {/* OK but outside liquid hours — show price only */}
                {scan.status === 'ok' && !scan.signal && !scan.scanning && scan.price !== undefined && (
                  <div className="space-y-0.5">
                    <p className="text-sm font-bold text-white tabular-nums">
                      {scan.price > 100
                        ? scan.price.toLocaleString('en-GB', { maximumFractionDigits: 1 })
                        : scan.price.toFixed(4)}
                    </p>
                    {scan.changePercent !== undefined && (
                      <p className={clsx('text-[11px] font-semibold', scan.changePercent >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                        {scan.changePercent >= 0 ? '+' : ''}{scan.changePercent.toFixed(2)}%
                      </p>
                    )}
                    <p className="text-[9px] text-gray-600">Pre-market · no signal</p>
                  </div>
                )}

                {/* OK: price + daily change + bot indicators + source badge */}
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
                    {/* Daily change % — always shown (Yahoo primary) */}
                    {scan.changePercent !== undefined && (
                      <p className={clsx('text-[11px] font-semibold flex items-center gap-0.5',
                        scan.changePercent >= 0 ? 'text-emerald-400' : 'text-red-400'
                      )}>
                        {scan.changePercent >= 0
                          ? <TrendingUp className="h-3 w-3" />
                          : <TrendingDown className="h-3 w-3" />}
                        {scan.changePercent >= 0 ? '+' : ''}{scan.changePercent.toFixed(2)}% daily
                      </p>
                    )}
                    {/* Bot server RSI/MACD — shown when available as secondary check */}
                    {(scan.source === 'yahoo+bot' || scan.source === 'bot-server') && (() => {
                      const rsiInd  = scan.signal.indicators?.find(i => i.label === 'RSI (live)' || i.label === 'RSI');
                      const macdInd = scan.signal.indicators?.find(i => i.label === 'MACD (live)' || i.label === 'MACD');
                      if (!rsiInd && !macdInd) return null;
                      return (
                        <div className="flex gap-2 flex-wrap">
                          {rsiInd && (
                            <span className={clsx('text-[10px] font-mono',
                              rsiInd.status === 'bullish' ? 'text-emerald-400' :
                              rsiInd.status === 'bearish' ? 'text-red-400' : 'text-gray-400'
                            )}>RSI {rsiInd.value}</span>
                          )}
                          {macdInd && (
                            <span className={clsx('text-[10px]',
                              macdInd.status === 'bullish' ? 'text-emerald-400' :
                              macdInd.status === 'bearish' ? 'text-red-400' : 'text-gray-400'
                            )}>{macdInd.value}</span>
                          )}
                        </div>
                      );
                    })()}
                    {/* Source badge */}
                    <span className={clsx(
                      'inline-block text-[9px] px-1.5 py-0.5 rounded border',
                      scan.source === 'yahoo+bot'
                        ? 'bg-purple-500/10 text-purple-400 border-purple-500/20'
                        : scan.source === 'bot-server'
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                        : 'bg-gray-800 text-gray-500 border-gray-700/50'
                    )}>
                      {scan.source === 'yahoo+bot' ? '⚡ Bot verified' : scan.source === 'bot-server' ? '⚡ Live' : 'Yahoo Finance'}
                    </span>
                    {/* Parabolic / overvaluation warning */}
                    {scan.parabolicRisk && (
                      <div className="flex items-start gap-1 mt-1 bg-amber-500/10 border border-amber-500/20 rounded px-1.5 py-1">
                        <AlertCircle className="h-3 w-3 text-amber-400 flex-shrink-0 mt-0.5" />
                        <p className="text-[9px] text-amber-400 leading-tight">{scan.parabolicNote ?? 'Potential reversal — watch for short entry'}</p>
                      </div>
                    )}
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
              ⚠️ Some markets failed to load from Yahoo Finance. Market may be closed or temporarily unavailable. The bot will retry on the next scan.
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
            { id: 'history'  as const, label: 'Trade History',   icon: <Activity className="h-3 w-3" />, count: tradeHistory.length + [...positions.demo, ...positions.live].filter(p => !tradeHistory.some(r => r.dealId === p.dealId)).length },
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
          // Merge live open positions not already recorded in local history
          const trackedIds = new Set(tradeHistory.map(r => r.dealId).filter(Boolean));
          const liveOpenRecords: IGTradeRecord[] = [
            ...positions.demo.map(p => ({ env: 'demo' as const, p })),
            ...positions.live.map(p => ({ env: 'live' as const, p })),
          ]
            .filter(({ p }) => p.dealId && !trackedIds.has(p.dealId))
            .map(({ env, p }) => ({
              id:            `live_${p.dealId}`,
              portfolioName: env === 'live' ? 'Live Account' : 'Demo Account',
              market:        p.instrumentName,
              epic:          p.epic,
              direction:     p.direction as 'BUY' | 'SELL',
              size:          p.size,
              entryLevel:    p.level,
              exitLevel:     null,
              openedAt:      p.createdDate ?? new Date().toISOString(),
              closedAt:      null,
              status:        'OPEN' as const,
              dealReference: '',
              dealId:        p.dealId,
              pnl:           typeof p.upl === 'number' ? p.upl : null,
              closeReason:   null,
              accountType:   env,
            }));

          const allHistory = [...liveOpenRecords, ...tradeHistory].sort(
            (a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime(),
          );

          const closed    = tradeHistory.filter(r => r.status === 'CLOSED');
          const wins      = closed.filter(r => (r.pnl ?? 0) > 0);
          const losses    = closed.filter(r => (r.pnl ?? 0) < 0);
          const totalPnLH = closed.reduce((s, r) => s + (r.pnl ?? 0), 0);
          const winRate   = closed.length > 0 ? Math.round((wins.length / closed.length) * 100) : 0;
          const avgWin    = wins.length   > 0 ? wins.reduce((s, r) => s + (r.pnl ?? 0), 0) / wins.length : 0;
          const avgLoss   = losses.length > 0 ? losses.reduce((s, r) => s + (r.pnl ?? 0), 0) / losses.length : 0;
          const bestPnL   = closed.length > 0 ? Math.max(...closed.map(r => r.pnl ?? 0)) : 0;
          const worstPnL  = closed.length > 0 ? Math.min(...closed.map(r => r.pnl ?? 0)) : 0;
          return (
            <>
              {/* Stats */}
              {allHistory.length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
                  {[
                    { label: 'Total Trades', value: allHistory.length.toString() },
                    { label: 'Win Rate',     value: closed.length > 0 ? `${winRate}%` : '—', color: winRate >= 50 ? 'text-emerald-400' : 'text-red-400' },
                    { label: 'Total P&L',    value: `${totalPnLH >= 0 ? '+' : ''}£${Math.abs(totalPnLH).toFixed(2)}`, color: totalPnLH >= 0 ? 'text-emerald-400' : 'text-red-400' },
                    { label: 'Avg Win',      value: avgWin  > 0 ? `+£${avgWin.toFixed(2)}`  : '—', color: 'text-emerald-400' },
                    { label: 'Avg Loss',     value: avgLoss < 0 ? `-£${Math.abs(avgLoss).toFixed(2)}` : '—', color: 'text-red-400' },
                    { label: 'Best Trade',   value: bestPnL  > 0 ? `+£${bestPnL.toFixed(2)}`  : '—', color: 'text-emerald-400' },
                    { label: 'Worst Trade',  value: worstPnL < 0 ? `-£${Math.abs(worstPnL).toFixed(2)}` : '—', color: 'text-red-400' },
                    { label: 'Open',         value: allHistory.filter(r => r.status === 'OPEN').length.toString() },
                  ].map(s => (
                    <div key={s.label} className="bg-gray-800/40 rounded-lg px-3 py-2">
                      <p className="text-[9px] text-gray-500 uppercase tracking-wider">{s.label}</p>
                      <p className={clsx('text-sm font-bold tabular-nums', s.color ?? 'text-white')}>{s.value}</p>
                    </div>
                  ))}
                </div>
              )}

              {/* Actions row */}
              <div className="flex justify-end gap-3 mb-3">
                <button
                  onClick={() => void hydrateTradeHistory()}
                  className="text-[10px] text-gray-500 hover:text-white transition-colors"
                >
                  Refresh from IG
                </button>
                {tradeHistory.length > 0 && (
                  <button
                    onClick={() => { if (confirm('Clear all trade history?')) { setTradeHistory([]); saveIGTradeHistory([]); } }}
                    className="text-[10px] text-gray-600 hover:text-red-400 transition-colors"
                  >
                    Clear history
                  </button>
                )}
              </div>

              {allHistory.length === 0 ? (
                <p className="text-sm text-gray-500 py-6 text-center">No trades recorded yet — connect to an account to see positions</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-gray-800">
                        {['Opened', 'Account', 'Market', 'Dir', 'Size', 'Entry', 'Exit', 'P&L', 'Status', 'Reason'].map(h => (
                          <th key={h} className="px-2 py-2 text-[9px] text-gray-500 font-medium uppercase tracking-wider whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {allHistory.map(r => (
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
                              r.status === 'OPEN'   ? 'bg-blue-500/20 text-blue-400' :
                              r.status === 'CLOSED' ? 'bg-gray-700 text-gray-300' :
                              'bg-red-500/20 text-red-400'
                            )}>{r.status}</span>
                          </td>
                          <td className="px-2 py-2 text-[10px] text-gray-500">
                            {r.closeReason ? r.closeReason.replace('_', ' ') : '—'}
                          </td>
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

      {/* ── Live Activity Feed ──────────────────────────────────────────── */}
      {runLog.length > 0 && (
        <Card>
          <CardHeader
            title="Live Activity Feed"
            subtitle={`${runLog.length} entries · last 100 visible`}
            icon={<Activity className="h-4 w-4" />}
            action={<button onClick={() => setRunLog([])} className="text-xs text-gray-500 hover:text-white">Clear</button>}
          />
          <div className="space-y-0.5 max-h-72 overflow-y-auto font-mono">
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

      {/* Server-side runner log */}
      {serverLog.length > 0 && (
        <Card>
          <CardHeader
            title="Server Strategy Log"
            subtitle="Oracle VM — runs independently of browser"
            icon={<Activity className="h-4 w-4 text-violet-400" />}
            action={
              serverRunning
                ? <span className="text-[10px] px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-300">LIVE</span>
                : <span className="text-[10px] text-gray-500">stopped</span>
            }
          />
          <div className="space-y-0.5 max-h-48 overflow-y-auto font-mono">
            {serverLog.map(e => (
              <div key={e.id} className="flex gap-2 text-[11px] py-0.5">
                <span className="text-gray-600 flex-shrink-0 tabular-nums">{e.ts}</span>
                <span className={clsx('flex-1 break-all leading-relaxed',
                  e.type === 'error' ? 'text-red-500' :
                  e.type === 'info'  ? 'text-gray-400' : 'text-emerald-400'
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

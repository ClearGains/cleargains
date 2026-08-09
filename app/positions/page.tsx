'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  RefreshCw, X, AlertCircle,
  BarChart3, Clock, Wifi, ExternalLink, Download, Plus,
  ChevronDown, ChevronUp, Bell, Edit2, CheckCircle2, History,
  Layers, Zap, FlaskConical, PlayCircle, ArrowRightLeft, Search,
} from 'lucide-react';
import { clsx } from 'clsx';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useClearGainsStore } from '@/lib/store';
import Link from 'next/link';
import {
  useLoadPortfolio, LoadPortfolioModal,
  PORTFOLIO_SNAPSHOT_KEY, type PortfolioData,
} from '@/components/portfolio/LoadPortfolioModal';

// ── Types ─────────────────────────────────────────────────────────────────────

type AccountKey = 'T212_INVEST' | 'T212_ISA' | 'T212_DEMO' | 'IG_DEMO' | 'IG_LIVE';

interface UnifiedPosition {
  id:           string;
  account:      AccountKey;
  name:         string;
  ticker:       string;
  direction:    'BUY' | 'SELL';
  quantity:     number;
  entryPrice:   number;
  currentPrice: number;
  pnl:          number;
  pnlPct:       number;
  stopLevel?:   number;
  limitLevel?:  number;
  openedAt?:    string;
  currency:     string;
  source:       'cleargains' | 'manual' | 'unknown';
  // IG-specific
  dealId?:      string;
  epic?:        string;
  // T212-specific
  t212Ticker?:  string;
}

interface ClosedPosition {
  id:         string;
  account:    AccountKey;
  name:       string;
  ticker:     string;
  direction:  string;
  size:       number;
  level:      number;
  closedAt:   string;
  currency:   string;
  pnl?:       number;
}

interface Alert {
  id:      string;
  type:    'profit' | 'loss' | 'stale' | 'new' | 'closed';
  message: string;
}

interface ManualPosition {
  account: AccountKey;
  name:    string;
  ticker:  string;
  direction: 'BUY' | 'SELL';
  quantity: number;
  entryPrice: number;
  openedAt: string;
}

const ACCOUNT_LABELS: Record<AccountKey, string> = {
  T212_INVEST: 'T212 Invest',
  T212_ISA:    'T212 ISA',
  T212_DEMO:   'T212 Demo',
  IG_DEMO:     'IG Demo',
  IG_LIVE:     'IG Live',
};

const ACCOUNT_COLORS: Record<AccountKey, string> = {
  T212_INVEST: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  T212_ISA:    'bg-blue-500/20 text-blue-400 border-blue-500/30',
  T212_DEMO:   'bg-purple-500/20 text-purple-400 border-purple-500/30',
  IG_DEMO:     'bg-orange-500/20 text-orange-400 border-orange-500/30',
  IG_LIVE:     'bg-amber-500/20 text-amber-400 border-amber-500/30',
};

function fmt(n: number, decimals = 2) {
  return (n >= 0 ? '+' : '') + n.toFixed(decimals);
}
function fmtP(n: number) {
  return (n >= 0 ? '+£' : '-£') + Math.abs(n).toFixed(2);
}
function fmtPrice(n: number) {
  if (n === 0) return '—';
  return n > 1000
    ? n.toLocaleString('en-GB', { maximumFractionDigits: 1 })
    : n.toFixed(n < 10 ? 4 : 2);
}
function fmtAge(iso?: string) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const EPIC_OPTIONS = [
  // Indices
  { label: 'FTSE 100',      value: 'IX.D.FTSE.DAILY.IP'    },
  { label: 'S&P 500',       value: 'IX.D.SPTRD.DAILY.IP'   },
  { label: 'NASDAQ 100',    value: 'IX.D.NASDAQ.CASH.IP'    },
  { label: 'Wall Street',   value: 'IX.D.DOW.DAILY.IP'      },
  { label: 'Germany 40',    value: 'IX.D.DAX.DAILY.IP'      },
  { label: 'Japan 225',     value: 'IX.D.NIKKEI.DAILY.IP'   },
  { label: 'Australia 200', value: 'IX.D.ASX.DAILY.IP'      },
  // Commodities
  { label: 'Gold',          value: 'CS.D.GOLD.TODAY.IP'     },
  { label: 'Silver',        value: 'CS.D.SILVER.TODAY.IP'   },
  { label: 'Oil (WTI)',     value: 'CS.D.CRUDE.TODAY.IP'    },
  { label: 'Natural Gas',   value: 'CS.D.NATGAS.TODAY.IP'   },
  // Forex
  { label: 'GBP/USD',       value: 'CS.D.GBPUSD.TODAY.IP'  },
  { label: 'EUR/USD',       value: 'CS.D.EURUSD.TODAY.IP'  },
  { label: 'USD/JPY',       value: 'CS.D.USDJPY.TODAY.IP'  },
  { label: 'EUR/GBP',       value: 'CS.D.EURGBP.TODAY.IP'  },
  { label: 'AUD/USD',       value: 'CS.D.AUDUSD.TODAY.IP'  },
  // Crypto
  { label: 'Bitcoin',       value: 'CS.D.BITCOIN.TODAY.IP' },
];

// Key used to track positions opened by ClearGains
const CLEARGAINS_POSITIONS_KEY = 'positions_opened_by_cleargains';

function getClearGainsOpenedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(CLEARGAINS_POSITIONS_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch { return new Set(); }
}

function getSource(pos: UnifiedPosition, cgIds: Set<string>): 'cleargains' | 'manual' | 'unknown' {
  // Check by dealId (IG) or ticker (T212)
  if (pos.dealId && cgIds.has(pos.dealId)) return 'cleargains';
  if (pos.t212Ticker && cgIds.has(pos.t212Ticker)) return 'cleargains';
  return 'unknown';
}

// ── Small components ──────────────────────────────────────────────────────────

function AccountBadge({ account }: { account: AccountKey }) {
  return (
    <span className={clsx('text-[9px] font-bold px-1.5 py-0.5 rounded-full border', ACCOUNT_COLORS[account])}>
      {ACCOUNT_LABELS[account]}
    </span>
  );
}

function SourceTag({ source }: { source: 'cleargains' | 'manual' | 'unknown' }) {
  if (source === 'cleargains') return (
    <span className="text-[8px] px-1 py-0.5 rounded bg-orange-500/15 text-orange-400 font-medium border border-orange-500/20">Bot</span>
  );
  if (source === 'manual') return (
    <span className="text-[8px] px-1 py-0.5 rounded bg-gray-700 text-gray-400 font-medium">Manual</span>
  );
  return (
    <span className="text-[8px] px-1 py-0.5 rounded bg-gray-800 text-gray-600 font-medium">External</span>
  );
}

function TaxTag({ account }: { account: AccountKey }) {
  if (account === 'T212_ISA') return (
    <span className="text-[8px] px-1 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">ISA — Tax Free</span>
  );
  if (account.startsWith('IG_')) return (
    <span className="text-[8px] px-1 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20">Spread Bet — Tax Free</span>
  );
  if (account === 'T212_DEMO') return null;
  return (
    <span className="text-[8px] px-1 py-0.5 rounded bg-yellow-500/10 text-yellow-500/80 border border-yellow-500/20">CGT tracked</span>
  );
}

function SummaryCard({ label, value, sub, highlight }: {
  label: string; value: string; sub?: string; highlight?: 'pos' | 'neg' | 'neutral';
}) {
  return (
    <Card>
      <p className="text-[10px] text-gray-500 uppercase tracking-wider font-medium mb-1">{label}</p>
      <p className={clsx('text-lg font-bold tabular-nums',
        highlight === 'pos' ? 'text-emerald-400' : highlight === 'neg' ? 'text-red-400' : 'text-white'
      )}>{value}</p>
      {sub && <p className="text-[10px] text-gray-600 mt-0.5">{sub}</p>}
    </Card>
  );
}

// ── Position row ──────────────────────────────────────────────────────────────

function PositionRow({ pos, onClose, closing, cgIds }: {
  pos: UnifiedPosition;
  onClose: (p: UnifiedPosition) => void;
  closing: boolean;
  cgIds: Set<string>;
}) {
  const src = getSource(pos, cgIds);
  const isProfit = pos.pnl >= 0;
  const alertLevel = pos.pnlPct <= -2 ? 'danger' : pos.pnlPct >= 3 ? 'profit' : null;
  return (
    <tr className={clsx('border-t border-gray-800 hover:bg-gray-800/30 transition-colors',
      alertLevel === 'danger' ? 'bg-red-500/5' : alertLevel === 'profit' ? 'bg-emerald-500/5' : ''
    )}>
      <td className="px-3 py-2.5">
        <div className="space-y-0.5">
          <AccountBadge account={pos.account} />
          <p className="text-xs font-semibold text-white mt-1">{pos.name}</p>
          <p className="text-[10px] text-gray-500 font-mono">{pos.ticker}</p>
          <div className="flex items-center gap-1 mt-0.5 flex-wrap">
            <SourceTag source={src} />
            <TaxTag account={pos.account} />
          </div>
        </div>
      </td>
      <td className="px-3 py-2.5">
        <span className={clsx('text-[10px] font-bold px-1.5 py-0.5 rounded',
          pos.direction === 'BUY' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
        )}>{pos.direction === 'BUY' ? 'LONG' : 'SHORT'}</span>
      </td>
      <td className="px-3 py-2.5 text-xs text-gray-300 tabular-nums">{pos.quantity.toFixed(4)}</td>
      <td className="px-3 py-2.5 text-xs text-gray-300 tabular-nums">{fmtPrice(pos.entryPrice)}</td>
      <td className="px-3 py-2.5 text-xs text-gray-300 tabular-nums">{fmtPrice(pos.currentPrice)}</td>
      <td className="px-3 py-2.5">
        <div className={clsx('text-xs font-semibold tabular-nums', isProfit ? 'text-emerald-400' : 'text-red-400')}>
          {fmtP(pos.pnl)}
        </div>
        <div className={clsx('text-[10px] tabular-nums', isProfit ? 'text-emerald-500' : 'text-red-500')}>
          {fmt(pos.pnlPct)}%
        </div>
        {alertLevel === 'danger' && <div className="text-[8px] text-red-400 font-medium mt-0.5">⚠ Near SL</div>}
        {alertLevel === 'profit' && <div className="text-[8px] text-emerald-400 font-medium mt-0.5">✓ Take profit?</div>}
      </td>
      <td className="px-3 py-2.5 text-[10px] text-gray-500 tabular-nums">
        {pos.stopLevel ? fmtPrice(pos.stopLevel) : '—'}
      </td>
      <td className="px-3 py-2.5 text-[10px] text-gray-500 tabular-nums">
        {pos.limitLevel ? fmtPrice(pos.limitLevel) : '—'}
      </td>
      <td className="px-3 py-2.5 text-[10px] text-gray-500">{fmtAge(pos.openedAt)}</td>
      <td className="px-3 py-2.5">
        <button
          onClick={() => onClose(pos)}
          disabled={closing}
          className="flex items-center gap-1 text-[10px] text-red-400 hover:text-red-300 border border-red-500/30 hover:border-red-500/60 rounded px-2 py-1 transition-all disabled:opacity-40"
        >
          {closing ? <RefreshCw className="h-2.5 w-2.5 animate-spin" /> : <X className="h-2.5 w-2.5" />}
          Close
        </button>
      </td>
    </tr>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PositionsPage() {
  const {
    t212ApiKey, t212ApiSecret, t212Connected,
    t212IsaApiKey, t212IsaApiSecret, t212IsaConnected,
    t212DemoApiKey, t212DemoApiSecret, t212DemoConnected,
  } = useClearGainsStore();

  const [positions, setPositions]       = useState<UnifiedPosition[]>([]);
  const [closedHistory, setClosedHistory] = useState<ClosedPosition[]>([]);
  const [loading, setLoading]           = useState(true);
  const [errors, setErrors]             = useState<Partial<Record<AccountKey, string>>>({});
  const [alerts, setAlerts]             = useState<Alert[]>([]);
  const [activeTab, setActiveTab]       = useState<AccountKey | 'ALL'>('ALL');
  const [posTab, setPosTab]             = useState<'positions' | 'orders'>('positions');
  const [countdown, setCountdown]       = useState(30);
  const [closingId, setClosingId]       = useState<string | null>(null);
  const [closeError, setCloseError]     = useState<string | null>(null);
  const [closeSuccess, setCloseSuccess] = useState<string | null>(null);
  const [fundsData, setFundsData]       = useState<Partial<Record<string, { available: number; label: string; color: string }>>>({});
  const [showHistory, setShowHistory]   = useState(false);
  const [historyFilter, setHistoryFilter] = useState<AccountKey | 'ALL'>('ALL');
  const [showManualModal, setShowManualModal] = useState(false);
  const [manualForm, setManualForm]     = useState<ManualPosition>({
    account: 'T212_INVEST', name: '', ticker: '', direction: 'BUY',
    quantity: 1, entryPrice: 0, openedAt: new Date().toISOString().slice(0, 16),
  });
  const [manualPositions, setManualPositions] = useState<UnifiedPosition[]>([]);
  const [portfolioData, setPortfolioData] = useState<PortfolioData | null>(null);
  const [cacheWarning, setCacheWarning]   = useState(false);
  const [lastSynced, setLastSynced]       = useState<Date | null>(null);

  // Portfolio modal hook
  const portfolioModal = useLoadPortfolio();

  // Auto-close engine (threshold-based — kept for manual threshold safety net)
  const [autoCloseEnabled, setAutoCloseEnabled] = useState(false);
  const [autoCloseTpPct, setAutoCloseTpPct]     = useState(2.0);
  const [autoCloseSlPct, setAutoCloseSlPct]     = useState(1.0);
  const [autoCloseLog, setAutoCloseLog]         = useState<string[]>([]);
  const [hasIgDemoSession, setHasIgDemoSession] = useState(false);

  // Signal monitor (AI-driven reversal close — Option A)
  const [signalMonitorEnabled, setSignalMonitorEnabled]   = useState(false);
  const [signalMonitorIntervalMin, setSignalMonitorIntervalMin] = useState(5);
  const [signalMonitorLog, setSignalMonitorLog]           = useState<string[]>([]);
  const [signalMonitorChecking, setSignalMonitorChecking] = useState(false);
  // Test trade panel
  const [showTestPanel, setShowTestPanel]       = useState(false);
  const [testEpic, setTestEpic]                 = useState('IX.D.FTSE.DAILY.IP');
  const [testDir, setTestDir]                   = useState<'BUY' | 'SELL'>('BUY');
  const [testSize, setTestSize]                 = useState(1);
  const [testLoading, setTestLoading]           = useState(false);
  const [testResult, setTestResult]             = useState<string | null>(null);
  // Diagnostic
  const [diagLoading, setDiagLoading]           = useState(false);
  const [diagResult, setDiagResult]             = useState<string | null>(null);

  // T212 Position Review — on-demand, longer-horizon keep/swap recommendation.
  // Not real-time monitoring: only runs when the button is clicked.
  type PositionReview = {
    ticker: string; symbol: string; sector: string | null;
    quantity: number; averagePrice: number; currentPrice: number | null;
    unrealizedPnl: number | null;
    trend4w: number | null; trend12w: number | null;
    newsSentiment: number; recentHeadline: string | null;
    verdict: 'KEEP' | 'CONSIDER_SWAPPING';
    reason: string;
    alternative?: { symbol: string; name: string; t212: string; trend12w: number | null };
    accountKey: AccountKey;
    env: string;
  };
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError]     = useState<string | null>(null);
  const [reviews, setReviews]             = useState<PositionReview[]>([]);
  const [swappingTicker, setSwappingTicker] = useState<string | null>(null);

  // Per-epic client-side cooldown: tracks last time each epic was checked (avoids
  // hammering IG price API when multiple positions share the same epic, or when
  // the server cache is cold on a fresh Vercel invocation)
  const epicLastCheckedRef   = useRef<Map<string, number>>(new Map());

  const prevPositionsRef     = useRef<UnifiedPosition[]>([]);
  const refreshRef           = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef         = useRef<ReturnType<typeof setInterval> | null>(null);
  const cgIdsRef             = useRef<Set<string>>(new Set());
  const autoCloseSettingsRef   = useRef({ enabled: false, tpPct: 2.0, slPct: 1.0 });
  const autoClosingRef         = useRef(false);
  const closePositionRef       = useRef<((pos: UnifiedPosition) => Promise<void>) | null>(null);
  const positionsRef           = useRef<UnifiedPosition[]>([]);
  const signalMonitorRunning   = useRef(false);
  const signalMonitorIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const igDemoSessionRef       = useRef<{ cst: string; securityToken: string; apiKey: string } | null>(null);

  // Load manual positions, CG ids, and cached snapshot on mount
  useEffect(() => {
    cgIdsRef.current = getClearGainsOpenedIds();
    try {
      const raw = localStorage.getItem('manual_positions');
      if (raw) setManualPositions(JSON.parse(raw) as UnifiedPosition[]);
    } catch {}
    // Load cached portfolio snapshot
    try {
      const snap = localStorage.getItem(PORTFOLIO_SNAPSHOT_KEY);
      if (snap) {
        const parsed = JSON.parse(snap) as PortfolioData;
        const ageMin = (Date.now() - new Date(parsed.loadedAt).getTime()) / 60_000;
        setPortfolioData(parsed);
        setLastSynced(new Date(parsed.loadedAt));
        if (ageMin > 5) setCacheWarning(true);
      }
    } catch {}
  }, []);

  // Keep autoCloseSettingsRef in sync so the auto-close effect always reads fresh values
  useEffect(() => {
    autoCloseSettingsRef.current = { enabled: autoCloseEnabled, tpPct: autoCloseTpPct, slPct: autoCloseSlPct };
  }, [autoCloseEnabled, autoCloseTpPct, autoCloseSlPct]);

  // On mount: auto-connect IG demo from stored credentials if session is missing/stale
  useEffect(() => {
    void getIGDemoSession();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update portfolioData when modal finishes loading
  useEffect(() => {
    if (portfolioModal.done && portfolioModal.data) {
      setPortfolioData(portfolioModal.data);
      setLastSynced(new Date(portfolioModal.data.loadedAt));
      setCacheWarning(false);
    }
  }, [portfolioModal.done, portfolioModal.data]);

  // ── Detect position changes ───────────────────────────────────────────────
  function detectChanges(prev: UnifiedPosition[], curr: UnifiedPosition[]) {
    const prevIds = new Set(prev.map(p => p.id));
    const currIds = new Set(curr.map(p => p.id));
    const newAlerts: Alert[] = [];

    // New positions appeared
    curr.filter(p => !prevIds.has(p.id)).forEach(p => {
      const src = getSource(p, cgIdsRef.current);
      if (src !== 'cleargains') {
        newAlerts.push({
          id:      `new_${p.id}`,
          type:    'new',
          message: `New position detected on ${ACCOUNT_LABELS[p.account]}: ${p.name} ${p.quantity.toFixed(4)} @ ${fmtPrice(p.entryPrice)}`,
        });
      }
    });

    // Positions disappeared (closed)
    prev.filter(p => !currIds.has(p.id)).forEach(p => {
      newAlerts.push({
        id:      `closed_${p.id}_${Date.now()}`,
        type:    'closed',
        message: `Position closed on ${ACCOUNT_LABELS[p.account]}: ${p.name} — P&L: ${fmtP(p.pnl)}`,
      });
    });

    // Profit/loss alerts on existing positions
    curr.forEach(p => {
      if (p.pnlPct >= 3) {
        newAlerts.push({ id: `profit_${p.id}`, type: 'profit', message: `${p.name} is up ${fmt(p.pnlPct)}% — consider taking profit` });
      } else if (p.pnlPct <= -2) {
        newAlerts.push({ id: `loss_${p.id}`, type: 'loss', message: `${p.name} is down ${fmt(p.pnlPct)}% — approaching stop loss` });
      }
      // Stale: open > 48h, no meaningful movement
      if (p.openedAt) {
        const ageH = (Date.now() - new Date(p.openedAt).getTime()) / 3_600_000;
        if (ageH > 48 && Math.abs(p.pnlPct) < 0.5) {
          newAlerts.push({ id: `stale_${p.id}`, type: 'stale', message: `${p.name} has been open ${Math.floor(ageH)}h with no significant movement` });
        }
      }
    });

    if (newAlerts.length > 0) {
      setAlerts(prev => {
        const existingIds = new Set(prev.map(a => a.id));
        return [...prev, ...newAlerts.filter(a => !existingIds.has(a.id))].slice(0, 20);
      });
    }
  }

  // ── Fetch all positions ────────────────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    setLoading(true);
    const all: UnifiedPosition[] = [];
    const errs: Partial<Record<AccountKey, string>> = {};

    // Refresh IG Demo session upfront — updates igDemoSessionRef which fetchIG reads.
    // Safe to call from this closure: only uses localStorage, fetch, and stable state setters.
    await getIGDemoSession();

    // ── T212 helper ──────────────────────────────────────────────────────────
    async function fetchT212(key: string, secret: string, accountKey: AccountKey, env: string) {
      if (!key) return;
      try {
        const encoded = btoa(key + ':' + secret);
        const r = await fetch(`/api/t212/positions?env=${env}`, {
          headers: { 'x-t212-auth': encoded },
        });
        const raw = await r.json() as unknown;
        const items: Record<string, unknown>[] = Array.isArray(raw)
          ? (raw as Record<string, unknown>[])
          : ((raw as Record<string, unknown[]>).items ?? []) as Record<string, unknown>[];

        items.forEach((p) => {
          const qty    = Number(p.quantity   ?? 0);
          const entry  = Number(p.averagePrice ?? 0);
          const curr   = Number(p.currentPrice ?? 0);
          const pnl    = Number(p.ppl ?? ((curr - entry) * qty));
          const pnlPct = entry > 0 ? ((curr - entry) / entry) * 100 : 0;
          all.push({
            id:           `${accountKey}_${p.ticker}`,
            account:      accountKey,
            name:         String(p.ticker ?? '').replace(/_[A-Z]{2}_[A-Z]{2}$/, ''),
            ticker:       String(p.ticker ?? ''),
            direction:    'BUY',
            quantity:     qty,
            entryPrice:   entry,
            currentPrice: curr,
            pnl:          Math.round(pnl * 100) / 100,
            pnlPct:       Math.round(pnlPct * 100) / 100,
            openedAt:     p.initialFillDate as string | undefined,
            currency:     'GBP',
            source:       'unknown',
            t212Ticker:   String(p.ticker ?? ''),
          });
        });
      } catch (e) {
        errs[accountKey] = e instanceof Error ? e.message : String(e);
      }
    }

    // ── IG helper ─────────────────────────────────────────────────────────────
    async function fetchIG(envKey: 'demo' | 'live', accountKey: AccountKey) {
      try {
        // For demo: use the ref populated by getIGDemoSession() before fetchAll runs
        // For live: read from localStorage directly
        const sess = envKey === 'demo'
          ? igDemoSessionRef.current
          : (() => {
              try {
                const raw = typeof window !== 'undefined' ? localStorage.getItem(`ig_session_${envKey}`) : null;
                if (!raw) return null;
                const p = JSON.parse(raw) as { cst?: string; securityToken?: string; apiKey?: string };
                return p.cst && p.securityToken && p.apiKey ? { cst: p.cst, securityToken: p.securityToken, apiKey: p.apiKey } : null;
              } catch { return null; }
            })();
        if (!sess) {
          if (envKey === 'demo') errs[accountKey] = 'No IG demo session — connect in Settings → Accounts → IG Demo';
          return;
        }

        const r = await fetch('/api/ig/positions', {
          headers: {
            'x-ig-cst':            sess.cst,
            'x-ig-security-token': sess.securityToken,
            'x-ig-api-key':        sess.apiKey,
            'x-ig-env':            envKey,
          },
        });
        const d = await r.json() as { ok: boolean; positions?: Array<{
          dealId: string; direction: string; size: number; level: number;
          upl: number; currency: string; stopLevel?: number; limitLevel?: number;
          createdDate?: string; epic: string; instrumentName: string;
          bid: number; offer: number;
        }>; error?: string; steps?: string[] };

        if (!d.ok) { errs[accountKey] = `${d.error ?? `IG ${envKey} error`} | ${(d.steps ?? []).slice(-3).join(' | ')}`; return; }
        if ((d.positions ?? []).length === 0) {
          errs[accountKey] = `0 positions | ${(d.steps ?? []).slice(-3).join(' | ')}`;
        }

        (d.positions ?? []).forEach(p => {
          const curr = p.direction === 'BUY' ? p.bid : p.offer;
          const pnlPct = p.level > 0 ? (p.upl / (p.level * p.size)) * 100 : 0;
          all.push({
            id:           `${accountKey}_${p.dealId}`,
            account:      accountKey,
            name:         p.instrumentName || p.epic,
            ticker:       p.epic,
            direction:    p.direction as 'BUY' | 'SELL',
            quantity:     p.size,
            entryPrice:   p.level,
            currentPrice: curr,
            pnl:          p.upl,
            pnlPct:       Math.round(pnlPct * 100) / 100,
            stopLevel:    p.stopLevel,
            limitLevel:   p.limitLevel,
            openedAt:     p.createdDate,
            currency:     p.currency || 'GBP',
            source:       'unknown',
            dealId:       p.dealId,
            epic:         p.epic,
          });
        });
      } catch (e) {
        errs[accountKey] = e instanceof Error ? e.message : String(e);
      }
    }

    // Fetch all accounts in parallel
    await Promise.all([
      t212Connected     ? fetchT212(t212ApiKey,    t212ApiSecret,    'T212_INVEST', 'live') : Promise.resolve(),
      t212IsaConnected  ? fetchT212(t212IsaApiKey, t212IsaApiSecret, 'T212_ISA',    'live') : Promise.resolve(),
      t212DemoConnected ? fetchT212(t212DemoApiKey, t212DemoApiSecret, 'T212_DEMO', 'demo') : Promise.resolve(),
      fetchIG('demo', 'IG_DEMO'),
      fetchIG('live', 'IG_LIVE'),
    ]);

    // Apply source tagging
    const cgIds = cgIdsRef.current;
    all.forEach(p => { p.source = getSource(p, cgIds); });

    // Merge manual positions
    const merged = [...all, ...manualPositions];

    // Detect changes vs previous fetch
    detectChanges(prevPositionsRef.current, all);
    prevPositionsRef.current = all;

    setPositions(merged);
    positionsRef.current = merged;
    setErrors(errs);
    setLoading(false);
    setCountdown(30);

    // Re-check IG demo session after every fetch (handles navigation timing)
    try {
      const raw = typeof window !== 'undefined' ? localStorage.getItem('ig_session_demo') : null;
      if (raw) {
        const s = JSON.parse(raw) as { cst?: string; securityToken?: string };
        setHasIgDemoSession(!!(s.cst && s.securityToken));
      }
    } catch {}

    // ── Fetch available funds ────────────────────────────────────────────────
    const funds: Partial<Record<string, { available: number; label: string; color: string }>> = {};

    async function loadT212Cash(key: string, secret: string, env: string, label: string, color: string) {
      if (!key) return;
      try {
        const encoded = btoa(key + ':' + secret);
        const r = await fetch(`/api/t212/cash?env=${env}`, { headers: { 'x-t212-auth': encoded } });
        const d = await r.json() as { ok: boolean; available?: number };
        if (d.ok) funds[label] = { available: d.available ?? 0, label, color };
      } catch {}
    }

    async function loadIGFunds(envKey: 'demo' | 'live', label: string, color: string) {
      try {
        const raw = typeof window !== 'undefined' ? localStorage.getItem(`ig_session_${envKey}`) : null;
        if (!raw) return;
        const sess = JSON.parse(raw) as { cst?: string; securityToken?: string; apiKey?: string };
        if (!sess.cst || !sess.securityToken || !sess.apiKey) return;
        const r = await fetch('/api/ig/account', {
          headers: { 'x-ig-cst': sess.cst, 'x-ig-security-token': sess.securityToken, 'x-ig-api-key': sess.apiKey, 'x-ig-env': envKey },
        });
        const d = await r.json() as { ok: boolean; available?: number };
        if (d.ok) funds[label] = { available: d.available ?? 0, label, color };
      } catch {}
    }

    await Promise.all([
      t212Connected     ? loadT212Cash(t212ApiKey,    t212ApiSecret,    'live', 'T212 Invest', 'text-emerald-400') : Promise.resolve(),
      t212IsaConnected  ? loadT212Cash(t212IsaApiKey, t212IsaApiSecret, 'live', 'T212 ISA',    'text-blue-400')    : Promise.resolve(),
      t212DemoConnected ? loadT212Cash(t212DemoApiKey, t212DemoApiSecret, 'demo', 'T212 Demo', 'text-purple-400') : Promise.resolve(),
      loadIGFunds('demo', 'IG Demo', 'text-orange-400'),
      loadIGFunds('live', 'IG Live', 'text-amber-400'),
    ]);
    setFundsData(funds);

  }, [
    t212ApiKey, t212ApiSecret, t212Connected,
    t212IsaApiKey, t212IsaApiSecret, t212IsaConnected,
    t212DemoApiKey, t212DemoApiSecret, t212DemoConnected,
    manualPositions,
  ]);

  // ── Fetch closed history ──────────────────────────────────────────────────
  const fetchHistory = useCallback(async () => {
    const history: ClosedPosition[] = [];

    // T212 history
    async function fetchT212History(key: string, secret: string, env: string, accountKey: AccountKey) {
      if (!key) return;
      try {
        const encoded = btoa(key + ':' + secret);
        const r = await fetch(`/api/t212/history?env=${env}&limit=50`, { headers: { 'x-t212-auth': encoded } });
        const d = await r.json() as { items?: Array<{ orderId: string; ticker: string; type: string; filledQuantity: number; fillPrice: number; dateCreated: string; dateModified: string }> };
        (d.items ?? []).filter(o => o.type === 'MARKET').slice(0, 50).forEach((o, i) => {
          history.push({
            id:        `${accountKey}_hist_${o.orderId ?? i}`,
            account:   accountKey,
            name:      o.ticker?.replace(/_[A-Z]{2}_[A-Z]{2}$/, '') ?? '',
            ticker:    o.ticker ?? '',
            direction: 'BUY',
            size:      o.filledQuantity ?? 0,
            level:     o.fillPrice ?? 0,
            closedAt:  o.dateModified ?? o.dateCreated ?? '',
            currency:  'GBP',
          });
        });
      } catch {}
    }

    // IG history
    async function fetchIGHistory(envKey: 'demo' | 'live', accountKey: AccountKey) {
      try {
        const raw = typeof window !== 'undefined' ? localStorage.getItem(`ig_session_${envKey}`) : null;
        if (!raw) return;
        const sess = JSON.parse(raw) as { cst?: string; securityToken?: string; apiKey?: string };
        if (!sess.cst || !sess.securityToken || !sess.apiKey) return;
        const r = await fetch('/api/ig/history', {
          headers: {
            'x-ig-cst':            sess.cst,
            'x-ig-security-token': sess.securityToken,
            'x-ig-api-key':        sess.apiKey,
            'x-ig-env':            envKey,
          },
        });
        const d = await r.json() as {
          ok: boolean;
          closed?: { date: string; epic: string; dealId: string; direction: string; size: number; level: number; marketName: string; currency: string }[];
        };
        (d.closed ?? []).slice(0, 50).forEach((c, i) => {
          history.push({
            id:        `${accountKey}_ighist_${c.dealId ?? i}`,
            account:   accountKey,
            name:      c.marketName || c.epic,
            ticker:    c.epic,
            direction: c.direction,
            size:      c.size,
            level:     c.level,
            closedAt:  c.date,
            currency:  c.currency || 'GBP',
          });
        });
      } catch {}
    }

    await Promise.all([
      t212Connected     ? fetchT212History(t212ApiKey,    t212ApiSecret,    'live', 'T212_INVEST') : Promise.resolve(),
      t212IsaConnected  ? fetchT212History(t212IsaApiKey, t212IsaApiSecret, 'live', 'T212_ISA')    : Promise.resolve(),
      t212DemoConnected ? fetchT212History(t212DemoApiKey, t212DemoApiSecret, 'demo', 'T212_DEMO') : Promise.resolve(),
      fetchIGHistory('demo', 'IG_DEMO'),
      fetchIGHistory('live', 'IG_LIVE'),
    ]);

    history.sort((a, b) => new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime());
    setClosedHistory(history.slice(0, 100));
  }, [
    t212ApiKey, t212ApiSecret, t212Connected,
    t212IsaApiKey, t212IsaApiSecret, t212IsaConnected,
    t212DemoApiKey, t212DemoApiSecret, t212DemoConnected,
  ]);


  // ── Auto-refresh every 30s ────────────────────────────────────────────────
  useEffect(() => {
    void fetchAll();
    void fetchHistory();
    refreshRef.current = setInterval(() => { void fetchAll(); }, 30_000);
    countdownRef.current = setInterval(() => { setCountdown(c => c > 0 ? c - 1 : 30); }, 1_000);
    return () => {
      if (refreshRef.current)   clearInterval(refreshRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refetch when fetchAll changes (credentials change)
  useEffect(() => { void fetchAll(); }, [fetchAll]);

  // ── Close position ─────────────────────────────────────────────────────────
  async function closePosition(pos: UnifiedPosition) {
    if (pos.source === 'manual') {
      setManualPositions(prev => {
        const next = prev.filter(p => p.id !== pos.id);
        localStorage.setItem('manual_positions', JSON.stringify(next));
        return next;
      });
      setCloseSuccess(`Removed manual position: ${pos.name}`);
      setTimeout(() => { void fetchAll(); }, 500);
      return;
    }
    setClosingId(pos.id);
    setCloseError(null);
    setCloseSuccess(null);

    try {
      if (pos.account === 'IG_DEMO' || pos.account === 'IG_LIVE') {
        const envKey = pos.account === 'IG_DEMO' ? 'demo' : 'live';
        const sess = pos.account === 'IG_DEMO'
          ? await getIGDemoSession(true)
          : (() => { try { const r = localStorage.getItem('ig_session_live'); return r ? JSON.parse(r) as { cst: string; securityToken: string; apiKey: string } : null; } catch { return null; } })();
        if (!sess) { setCloseError('No IG session — reconnecting, please try again in a moment'); setClosingId(null); void getIGDemoSession(true); return; }
        const r = await fetch('/api/ig/order', {
          method: 'DELETE',
          headers: { 'x-ig-cst': sess.cst, 'x-ig-security-token': sess.securityToken, 'x-ig-api-key': sess.apiKey, 'x-ig-env': envKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ dealId: pos.dealId, direction: pos.direction === 'BUY' ? 'SELL' : 'BUY', size: pos.quantity }),
        });
        const d = await r.json() as { ok: boolean; error?: string; tried?: string[] };
        if (!d.ok) {
          const detail = d.tried?.length ? ` [tried: ${d.tried.join(' | ')}]` : '';
          setCloseError((d.error ?? 'Close failed') + detail);
          setClosingId(null);
          return;
        }
        setCloseSuccess(`Closed ${pos.name}`);
      } else {
        const isDemo = pos.account === 'T212_DEMO';
        const isIsa  = pos.account === 'T212_ISA';
        const key    = isDemo ? t212DemoApiKey : isIsa ? t212IsaApiKey : t212ApiKey;
        const secret = isDemo ? t212DemoApiSecret : isIsa ? t212IsaApiSecret : t212ApiSecret;
        const env    = isDemo ? 'demo' : 'live';
        const r = await fetch('/api/t212/sell', {
          method: 'POST',
          headers: { 'x-t212-auth': btoa(key + ':' + secret), 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticker: pos.t212Ticker, quantity: pos.quantity, env }),
        });
        const d = await r.json() as { ok: boolean; error?: string };
        if (!d.ok) { setCloseError(d.error ?? 'Close failed'); setClosingId(null); return; }
        setCloseSuccess(`Closed ${pos.name}`);
      }
      setTimeout(() => { void fetchAll(); }, 1_500);
      setTimeout(() => setCloseSuccess(null), 4_000);
    } catch (e) {
      setCloseError(e instanceof Error ? e.message : 'Unknown error');
    }
    setClosingId(null);
  }

  // Keep closePositionRef pointing at the latest version so auto-close effect
  // always calls the function that has fresh state in scope
  closePositionRef.current = closePosition;

  // ── Auto-close engine ─────────────────────────────────────────────────────
  // Runs after every positions refresh; closes IG Demo positions that breach
  // the configured profit/loss thresholds using a plain market order (no IG
  // SL/TP orders required).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const { enabled, tpPct, slPct } = autoCloseSettingsRef.current;
    if (!enabled || autoClosingRef.current) return;

    const toClose = positions.filter(
      p => p.account === 'IG_DEMO' && (
        (tpPct > 0 && p.pnlPct >= tpPct) ||
        (slPct > 0 && p.pnlPct <= -slPct)
      ),
    );
    if (toClose.length === 0) return;

    autoClosingRef.current = true;
    const run = async () => {
      for (const pos of toClose) {
        const reason = pos.pnlPct >= tpPct
          ? `+${pos.pnlPct.toFixed(1)}% hit profit target`
          : `${pos.pnlPct.toFixed(1)}% hit loss limit`;
        setAutoCloseLog(prev => [
          `${new Date().toLocaleTimeString('en-GB')}: ${pos.name} — ${reason}`,
          ...prev.slice(0, 19),
        ]);
        await closePositionRef.current?.(pos);
      }
      autoClosingRef.current = false;
    };
    void run();
  }, [positions]);

  // ── T212 Position Review — on-demand keep/swap recommendation ─────────────
  // Not real-time: only runs when the button is clicked. Multi-week trend +
  // 30-day news, not intraday signals — T212 positions are held far longer
  // than the IG bots this app also runs, so the short-term demo-trader scan
  // logic would be the wrong lens here.
  async function runPositionReview() {
    setReviewLoading(true);
    setReviewError(null);
    setReviews([]);
    try {
      const accounts: { key: string; secret: string; accountKey: AccountKey; env: string }[] = [];
      if (t212Connected)    accounts.push({ key: t212ApiKey,    secret: t212ApiSecret,    accountKey: 'T212_INVEST', env: 'live' });
      if (t212IsaConnected) accounts.push({ key: t212IsaApiKey, secret: t212IsaApiSecret, accountKey: 'T212_ISA',    env: 'live' });

      if (accounts.length === 0) {
        setReviewError('No T212 Invest/ISA account connected — connect one in Settings → Accounts.');
        return;
      }

      const all: PositionReview[] = [];
      for (const acc of accounts) {
        const encoded = btoa(acc.key + ':' + acc.secret);
        const res = await fetch('/api/t212/position-review', {
          method: 'POST',
          headers: { 'x-t212-auth': encoded, 'Content-Type': 'application/json' },
          body: JSON.stringify({ env: acc.env }),
        });
        const data = await res.json() as { ok: boolean; error?: string; reviews?: Omit<PositionReview, 'accountKey' | 'env'>[] };
        if (!data.ok) {
          setReviewError(prev => prev ? `${prev} · ${acc.accountKey}: ${data.error}` : `${acc.accountKey}: ${data.error}`);
          continue;
        }
        (data.reviews ?? []).forEach(r => all.push({ ...r, accountKey: acc.accountKey, env: acc.env }));
      }
      setReviews(all);
    } catch (e) {
      setReviewError(e instanceof Error ? e.message : 'Review failed');
    } finally {
      setReviewLoading(false);
    }
  }

  // Manual action, not automatic — closes the flagged position and opens the
  // suggested alternative with the same capital. User must click to confirm.
  async function executeSwap(review: PositionReview) {
    if (!review.alternative || !review.currentPrice) return;
    setSwappingTicker(review.ticker);
    try {
      const key    = review.accountKey === 'T212_ISA' ? t212IsaApiKey    : t212ApiKey;
      const secret = review.accountKey === 'T212_ISA' ? t212IsaApiSecret : t212ApiSecret;
      const encoded = btoa(key + ':' + secret);

      const sellRes = await fetch('/api/t212/sell', {
        method: 'POST',
        headers: { 'x-t212-auth': encoded, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: review.ticker, quantity: review.quantity, env: review.env }),
      });
      const sellData = await sellRes.json() as { ok: boolean; error?: string };
      if (!sellData.ok) throw new Error(sellData.error ?? 'Sell failed');

      // Same capital value into the alternative, at its current price.
      const capitalValue = review.quantity * review.currentPrice;
      const buyRes = await fetch('/api/t212/live-order', {
        method: 'POST',
        headers: { 'x-t212-auth': encoded, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: review.alternative.symbol, quantity: capitalValue, env: review.env }),
      });
      const buyData = await buyRes.json() as { ok: boolean; error?: string };
      if (!buyData.ok) throw new Error(`Sold ${review.symbol} but buying ${review.alternative.symbol} failed: ${buyData.error}`);

      setReviews(prev => prev.filter(r => r.ticker !== review.ticker));
      await fetchAll();
    } catch (e) {
      setReviewError(e instanceof Error ? e.message : 'Swap failed');
    } finally {
      setSwappingTicker(null);
    }
  }

  // ── Signal Monitor — AI-driven reversal close ─────────────────────────────
  async function runSignalMonitor() {
    if (signalMonitorRunning.current) return;
    signalMonitorRunning.current = true;
    setSignalMonitorChecking(true);

    try {
      const sess = await getIGDemoSession();
      if (!sess) {
        setSignalMonitorLog(prev => [`${new Date().toLocaleTimeString('en-GB')}: ✗ No IG demo session — check credentials in Settings`, ...prev.slice(0, 29)]);
        signalMonitorRunning.current = false; setSignalMonitorChecking(false); return;
      }

      const igDemoPositions = positionsRef.current.filter(p => p.account === 'IG_DEMO' && p.epic && p.dealId);

      if (igDemoPositions.length === 0) {
        setSignalMonitorLog(prev => [
          `${new Date().toLocaleTimeString('en-GB')}: No IG Demo positions to monitor`,
          ...prev.slice(0, 29),
        ]);
        signalMonitorRunning.current = false; setSignalMonitorChecking(false); return;
      }

      // Deduplicate by epic: one price fetch per unique epic regardless of how
      // many positions share it. Also enforce a 12-min client-side cooldown per
      // epic so a cold Vercel invocation (empty server cache) doesn't re-hit IG.
      const CLIENT_COOLDOWN_MS = 12 * 60_000;
      const checkedEpics = new Map<string, { signal: string; confidence: number; reasoning: string; engine?: string }>();

      for (const pos of igDemoPositions) {
        if (!pos.epic) continue;
        const ts = epicLastCheckedRef.current.get(pos.epic) ?? 0;
        const sinceLastCheck = Date.now() - ts;

        // Skip this epic entirely if we checked it within the cooldown window
        if (sinceLastCheck < CLIENT_COOLDOWN_MS && checkedEpics.has(pos.epic)) {
          const cached = checkedEpics.get(pos.epic)!;
          const engineTag = cached.engine ? ` [${cached.engine}]` : '';
          setSignalMonitorLog(prev => [
            `${new Date().toLocaleTimeString('en-GB')}: ${pos.name} [${pos.direction}]${engineTag} — ${cached.signal} ${cached.confidence}/10 (client-cache): ${cached.reasoning}`,
            ...prev.slice(0, 29),
          ]);
          continue;
        }

        try {
          const r = await fetch('/api/ig/signal-check', {
            method: 'POST',
            headers: {
              'x-ig-cst':            sess.cst,
              'x-ig-security-token': sess.securityToken,
              'x-ig-api-key':        sess.apiKey,
              'x-ig-env':            'demo',
              'Content-Type':        'application/json',
            },
            body: JSON.stringify({ epic: pos.epic, direction: pos.direction, instrumentName: pos.name }),
          });
          const d = await r.json() as {
            ok: boolean;
            signal?: string; confidence?: number;
            shouldClose?: boolean; reasoning?: string; cached?: boolean;
            engine?: string; error?: string;
          };

          if (!d.ok) {
            setSignalMonitorLog(prev => [`${new Date().toLocaleTimeString('en-GB')}: ✗ ${pos.name} — ${d.error ?? 'check failed'}`, ...prev.slice(0, 29)]);
            continue;
          }

          // Store result for any other positions that share this epic
          epicLastCheckedRef.current.set(pos.epic, Date.now());
          checkedEpics.set(pos.epic, { signal: d.signal ?? 'HOLD', confidence: d.confidence ?? 5, reasoning: d.reasoning ?? '', engine: d.engine });

          const engineTag = d.engine ? ` [${d.engine}]` : '';
          const cachedTag = d.cached ? ' (server-cache)' : '';
          const action    = d.shouldClose ? ' → CLOSING NOW' : '';
          setSignalMonitorLog(prev => [
            `${new Date().toLocaleTimeString('en-GB')}: ${pos.name} [${pos.direction}]${engineTag} — ${d.signal ?? '?'} ${d.confidence ?? '?'}/10${cachedTag}: ${d.reasoning ?? ''}${action}`,
            ...prev.slice(0, 29),
          ]);

          if (d.shouldClose) {
            await closePositionRef.current?.(pos);
          }
        } catch (e) {
          setSignalMonitorLog(prev => [
            `${new Date().toLocaleTimeString('en-GB')}: ✗ ${pos.name} — ${e instanceof Error ? e.message : 'unknown error'}`,
            ...prev.slice(0, 29),
          ]);
        }
      }
    } finally {
      signalMonitorRunning.current = false;
      setSignalMonitorChecking(false);
    }
  }

  // Start/stop signal monitor interval
  useEffect(() => {
    if (signalMonitorIntervalRef.current) {
      clearInterval(signalMonitorIntervalRef.current);
      signalMonitorIntervalRef.current = null;
    }
    if (!signalMonitorEnabled) return;
    void runSignalMonitor();
    signalMonitorIntervalRef.current = setInterval(() => void runSignalMonitor(), signalMonitorIntervalMin * 60_000);
    return () => {
      if (signalMonitorIntervalRef.current) clearInterval(signalMonitorIntervalRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signalMonitorEnabled, signalMonitorIntervalMin]);

  // ── Export CSV ────────────────────────────────────────────────────────────
  function exportCSV() {
    const rows = [
      ['Account', 'Name', 'Ticker', 'Direction', 'Quantity', 'Entry', 'Current', 'P&L', 'P&L %', 'Stop', 'TP', 'Opened', 'Source'],
      ...positions.map(p => [
        ACCOUNT_LABELS[p.account], p.name, p.ticker, p.direction,
        p.quantity.toFixed(4), p.entryPrice.toFixed(2), p.currentPrice.toFixed(2),
        p.pnl.toFixed(2), p.pnlPct.toFixed(2),
        p.stopLevel?.toFixed(2) ?? '',
        p.limitLevel?.toFixed(2) ?? '',
        p.openedAt ? new Date(p.openedAt).toLocaleString('en-GB') : '',
        p.source,
      ]),
    ];
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `positions_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }

  // ── Add manual position ───────────────────────────────────────────────────
  function saveManualPosition() {
    if (!manualForm.name || !manualForm.ticker || manualForm.entryPrice <= 0) return;
    const newPos: UnifiedPosition = {
      id:           `manual_${Date.now()}`,
      account:      manualForm.account,
      name:         manualForm.name,
      ticker:       manualForm.ticker,
      direction:    manualForm.direction,
      quantity:     manualForm.quantity,
      entryPrice:   manualForm.entryPrice,
      currentPrice: manualForm.entryPrice, // no live price for manual
      pnl:          0,
      pnlPct:       0,
      openedAt:     new Date(manualForm.openedAt).toISOString(),
      currency:     'GBP',
      source:       'manual',
    };
    const next = [...manualPositions, newPos];
    setManualPositions(next);
    localStorage.setItem('manual_positions', JSON.stringify(next));
    setShowManualModal(false);
    setManualForm({ account: 'T212_INVEST', name: '', ticker: '', direction: 'BUY', quantity: 1, entryPrice: 0, openedAt: new Date().toISOString().slice(0, 16) });
    void fetchAll();
  }

  // ── IG session helper — auto-connects from stored credentials if needed ────
  // forceRefresh=true bypasses the local cache and forces a fresh login + account switch.
  async function getIGDemoSession(forceRefresh = false): Promise<{ cst: string; securityToken: string; apiKey: string } | null> {
    const SESSION_TTL = 5 * 60 * 60 * 1000;
    const sessKey  = 'ig_session_demo';
    const credKey  = 'ig_demo_credentials';

    // Try cached session first (skip on forceRefresh).
    // Require isSpreadbet: true — sessions that aren't on the Spread Bet account
    // are rejected and fall through to re-auth which switches to Spread Bet.
    if (!forceRefresh) {
      try {
        const raw = localStorage.getItem(sessKey);
        if (raw) {
          const s = JSON.parse(raw) as { cst?: string; securityToken?: string; apiKey?: string; authenticatedAt?: number; isSpreadbet?: boolean };
          if (s.cst && s.securityToken && s.apiKey && s.authenticatedAt && s.isSpreadbet && (Date.now() - s.authenticatedAt) < SESSION_TTL) {
            const result = { cst: s.cst, securityToken: s.securityToken, apiKey: s.apiKey };
            igDemoSessionRef.current = result;
            setHasIgDemoSession(true);
            return result;
          }
        }
      } catch {}
    }

    // No valid cached session (or forceRefresh) — build one from stored credentials
    try {
      const credRaw = localStorage.getItem(credKey);
      if (!credRaw) return null;
      const creds = JSON.parse(credRaw) as { username?: string; password?: string; apiKey?: string; connected?: boolean };
      if (!creds.username || !creds.password || !creds.apiKey) return null;

      const r = await fetch('/api/ig/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: creds.username, password: creds.password, apiKey: creds.apiKey, env: 'demo', forceRefresh }),
      });
      const d = await r.json() as { ok: boolean; cst?: string; securityToken?: string; accountId?: string; isSpreadbet?: boolean; lightstreamerEndpoint?: string | null; error?: string };
      if (!d.ok || !d.cst || !d.securityToken) return null;

      const sess = {
        cst: d.cst, securityToken: d.securityToken, apiKey: creds.apiKey,
        accountId: d.accountId ?? '', isSpreadbet: d.isSpreadbet ?? false,
        lightstreamerEndpoint: d.lightstreamerEndpoint ?? null,
        authenticatedAt: Date.now(),
      };
      localStorage.setItem(sessKey, JSON.stringify(sess));
      igDemoSessionRef.current = { cst: d.cst, securityToken: d.securityToken, apiKey: creds.apiKey };
      setHasIgDemoSession(true);
      return { cst: d.cst, securityToken: d.securityToken, apiKey: creds.apiKey };
    } catch {}
    return null;
  }

  // ── Open test trade on IG Demo Spread Bet ─────────────────────────────────
  async function openTestTrade() {
    setTestLoading(true);
    setTestResult(null);
    try {
      // forceRefresh=true ensures a fresh login + Spread Bet account switch
      const sess = await getIGDemoSession(true);
      if (!sess) { setTestResult('✗ No IG demo credentials found — go to Settings → Accounts → IG Demo and connect first'); setTestLoading(false); return; }
      const expiry = testEpic.startsWith('CS.D.') ? '-' : 'DFB';
      const r = await fetch('/api/ig/order', {
        method: 'POST',
        headers: {
          'x-ig-cst':            sess.cst,
          'x-ig-security-token': sess.securityToken,
          'x-ig-api-key':        sess.apiKey,
          'x-ig-env':            'demo',
          'Content-Type':        'application/json',
        },
        body: JSON.stringify({ epic: testEpic, direction: testDir, size: testSize, expiry }),
      });
      const d = await r.json() as { ok: boolean; dealId?: string; level?: number; dealStatus?: string; error?: string };
      if (!d.ok) {
        setTestResult(`✗ ${d.error ?? 'Open failed'}`);
      } else {
        const epicLabel = EPIC_OPTIONS.find(o => o.value === testEpic)?.label ?? testEpic;
        setTestResult(`✓ ${testDir} ${testSize} ${epicLabel} @ ${d.level ? fmtPrice(d.level) : '?'} (${d.dealStatus ?? 'ACCEPTED'}) — ID: ${d.dealId ?? '?'} — checking positions…`);
        setHasIgDemoSession(true);
        // Immediately check positions with the SAME tokens that placed the order
        // to see if the position is visible right away (same account context)
        await new Promise(res => setTimeout(res, 1_500));
        try {
          const posR = await fetch('/api/ig/positions', {
            headers: { 'x-ig-cst': sess.cst, 'x-ig-security-token': sess.securityToken, 'x-ig-api-key': sess.apiKey, 'x-ig-env': 'demo' },
          });
          const posD = await posR.json() as { ok: boolean; positions?: unknown[]; steps?: string[]; error?: string };
          const lastSteps = (posD.steps ?? []).slice(-3).join(' | ');
          if (posD.ok && (posD.positions?.length ?? 0) > 0) {
            setTestResult(`✓ ${testDir} ${testSize} ${epicLabel} @ ${d.level ? fmtPrice(d.level) : '?'} — ${posD.positions!.length} position(s) visible ✓`);
          } else {
            setTestResult(`✓ opened (${d.dealId ?? '?'}) but positions returned ${posD.positions?.length ?? 0} | ${lastSteps}`);
          }
        } catch { /* keep original success message */ }
        void fetchAll();
      }
    } catch (e) {
      setTestResult(`✗ ${e instanceof Error ? e.message : 'Unknown error'}`);
    }
    setTestLoading(false);
  }

  // ── IG API diagnostic ─────────────────────────────────────────────────────
  async function runDiagnostic() {
    setDiagLoading(true);
    setDiagResult('Running diagnostics…');
    try {
      const sess = await getIGDemoSession();
      if (!sess) { setDiagResult('✗ No IG demo session — connect in Settings → Accounts → IG Demo first'); setDiagLoading(false); return; }
      const r = await fetch('/api/ig/diagnostic', {
        headers: {
          'x-ig-cst':            sess.cst,
          'x-ig-security-token': sess.securityToken,
          'x-ig-api-key':        sess.apiKey,
          'x-ig-env':            'demo',
        },
      });
      const d = await r.json() as {
        ok: boolean; sessionSummary?: string;
        probes?: Array<{ label: string; status: number; ok: boolean; body: string }>;
        error?: string;
      };
      if (!d.ok) { setDiagResult(`✗ ${d.error ?? 'Diagnostic failed'}`); setDiagLoading(false); return; }
      const lines: string[] = [];
      if (d.sessionSummary) lines.push(`Session: ${d.sessionSummary}`);
      (d.probes ?? []).forEach(p => {
        const icon = p.ok ? '✓' : p.status === 404 ? '404' : `✗${p.status}`;
        const preview = p.body.slice(0, 120).replace(/\n/g, ' ');
        lines.push(`${icon} ${p.label}: ${preview}`);
      });
      setDiagResult(lines.join('\n'));
    } catch (e) {
      setDiagResult(`✗ ${e instanceof Error ? e.message : String(e)}`);
    }
    setDiagLoading(false);
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const filtered     = activeTab === 'ALL' ? positions : positions.filter(p => p.account === activeTab);
  const totalPnL     = positions.reduce((s, p) => s + p.pnl, 0);
  const t212PnL      = positions.filter(p => p.account.startsWith('T212')).reduce((s, p) => s + p.pnl, 0);
  const igPnL        = positions.filter(p => p.account.startsWith('IG')).reduce((s, p) => s + p.pnl, 0);
  const best         = positions.length ? positions.reduce((a, b) => a.pnl > b.pnl ? a : b) : null;
  const worst        = positions.length ? positions.reduce((a, b) => a.pnl < b.pnl ? a : b) : null;
  const totalInvested = positions.reduce((s, p) => s + p.entryPrice * p.quantity, 0);
  const totalAvailable = Object.values(fundsData).reduce((s, f) => s + (f?.available ?? 0), 0);

  const tabCounts: Record<AccountKey | 'ALL', number> = {
    ALL:        positions.length,
    T212_INVEST: positions.filter(p => p.account === 'T212_INVEST').length,
    T212_ISA:   positions.filter(p => p.account === 'T212_ISA').length,
    T212_DEMO:  positions.filter(p => p.account === 'T212_DEMO').length,
    IG_DEMO:    positions.filter(p => p.account === 'IG_DEMO').length,
    IG_LIVE:    positions.filter(p => p.account === 'IG_LIVE').length,
  };

  const connectedAccounts: (AccountKey | 'ALL')[] = ['ALL'];
  if (t212Connected)     connectedAccounts.push('T212_INVEST');
  if (t212IsaConnected)  connectedAccounts.push('T212_ISA');
  if (t212DemoConnected) connectedAccounts.push('T212_DEMO');
  connectedAccounts.push('IG_DEMO', 'IG_LIVE');

  const filteredHistory = historyFilter === 'ALL' ? closedHistory : closedHistory.filter(h => h.account === historyFilter);

  return (
    <div className="max-w-6xl mx-auto p-4 space-y-4">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-orange-400" />
            Live Positions
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            All open positions across connected accounts · auto-synced every 30s
            {lastSynced && (
              <span className="ml-2 text-gray-600">· Last synced: {lastSynced.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] text-gray-600 flex items-center gap-1">
            <Clock className="h-3 w-3" /> Refreshing in {countdown}s
          </span>
          <Button size="sm" variant="outline" icon={<BarChart3 className="h-3.5 w-3.5" />} onClick={portfolioModal.openModal} className="border-orange-500/30 text-orange-400 hover:border-orange-500/60">
            Load Portfolio
          </Button>
          <Button size="sm" variant="outline" loading={loading} icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => { void fetchAll(); void fetchHistory(); }}>
            Refresh
          </Button>
          <Button size="sm" variant="outline" icon={<Download className="h-3.5 w-3.5" />} onClick={exportCSV}>
            Export CSV
          </Button>
          <Button size="sm" variant="outline" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setShowManualModal(true)}>
            Add Manual
          </Button>
        </div>
      </div>

      {/* Cache warning */}
      {cacheWarning && (
        <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 text-xs text-amber-400">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
          Showing cached data from {lastSynced ? Math.round((Date.now() - lastSynced.getTime()) / 60_000) : '?'} minutes ago — live data may differ.
          <button onClick={() => portfolioModal.openModal()} className="ml-auto underline hover:no-underline">Reload now</button>
        </div>
      )}

      {/* Toasts */}
      {closeSuccess && (
        <div className="flex items-center gap-2 bg-emerald-500/15 border border-emerald-500/25 rounded-lg px-3 py-2.5 text-xs text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5" /> {closeSuccess}
        </div>
      )}
      {closeError && (
        <div className="flex items-center gap-2 bg-red-500/15 border border-red-500/25 rounded-lg px-3 py-2.5 text-xs text-red-400">
          <AlertCircle className="h-3.5 w-3.5" />{closeError}
        </div>
      )}

      {/* Alerts */}
      {alerts.length > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-3 space-y-1.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-semibold text-amber-400">
              <Bell className="h-3.5 w-3.5" /> Alerts ({alerts.length})
            </div>
            <button onClick={() => setAlerts([])} className="text-[10px] text-gray-500 hover:text-gray-300">Dismiss all</button>
          </div>
          {alerts.slice(0, 5).map(a => (
            <div key={a.id} className="flex items-start gap-2 text-[11px]">
              <span className={clsx('mt-0.5 h-1.5 w-1.5 rounded-full flex-shrink-0',
                a.type === 'profit' ? 'bg-emerald-400' : a.type === 'loss' ? 'bg-red-400' : a.type === 'new' ? 'bg-blue-400' : a.type === 'closed' ? 'bg-gray-400' : 'bg-amber-400'
              )} />
              <span className="text-gray-300">{a.message}</span>
              <button onClick={() => setAlerts(prev => prev.filter(x => x.id !== a.id))} className="ml-auto text-gray-600 hover:text-gray-400 flex-shrink-0">
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          {alerts.length > 5 && <p className="text-[10px] text-gray-500">+{alerts.length - 5} more…</p>}
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-3">
        <SummaryCard
          label="Open Positions"
          value={`${positions.length}`}
          sub={`${connectedAccounts.length - 1} accounts`}
          highlight="neutral"
        />
        <SummaryCard
          label="Total P&L"
          value={`${totalPnL >= 0 ? '+' : ''}£${Math.abs(totalPnL).toFixed(2)}`}
          sub="Unrealised"
          highlight={totalPnL >= 0 ? 'pos' : 'neg'}
        />
        <SummaryCard
          label="T212 P&L"
          value={`${t212PnL >= 0 ? '+' : ''}£${Math.abs(t212PnL).toFixed(2)}`}
          sub={`${positions.filter(p => p.account.startsWith('T212')).length} positions`}
          highlight={t212PnL >= 0 ? 'pos' : 'neg'}
        />
        <SummaryCard
          label="IG P&L"
          value={`${igPnL >= 0 ? '+' : ''}£${Math.abs(igPnL).toFixed(2)}`}
          sub={`${positions.filter(p => p.account.startsWith('IG')).length} positions`}
          highlight={igPnL >= 0 ? 'pos' : 'neg'}
        />
        <SummaryCard
          label="Best Position"
          value={best ? fmtP(best.pnl) : '—'}
          sub={best?.name}
          highlight={best && best.pnl > 0 ? 'pos' : 'neutral'}
        />
        <SummaryCard
          label="Worst Position"
          value={worst ? fmtP(worst.pnl) : '—'}
          sub={worst?.name}
          highlight={worst && worst.pnl < 0 ? 'neg' : 'neutral'}
        />
        <SummaryCard
          label="Available"
          value={`£${totalAvailable.toFixed(0)}`}
          sub="across accounts"
          highlight="neutral"
        />
      </div>

      {/* Available funds strip */}
      {Object.keys(fundsData).length > 0 && (
        <div className="flex items-center gap-3 flex-wrap bg-gray-900/60 border border-gray-800 rounded-lg px-4 py-2.5">
          <span className="text-[10px] text-gray-500 font-medium uppercase tracking-wider">Available Funds</span>
          {Object.values(fundsData).map(f => f && (
            <div key={f.label} className="flex items-center gap-1.5 text-xs">
              <span className="text-gray-500">{f.label}:</span>
              <span className={`font-semibold tabular-nums ${f.color}`}>£{f.available.toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}

      {/* T212 Position Review — on-demand, longer-horizon keep/swap check */}
      {(t212Connected || t212IsaConnected) && (
        <div className="bg-gray-900/70 border border-blue-500/25 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <Search className="h-4 w-4 text-blue-400" />
              <span className="text-sm font-semibold text-white">T212 Position Review</span>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/20 font-bold">ON-DEMAND</span>
            </div>
            <button
              onClick={() => void runPositionReview()}
              disabled={reviewLoading}
              className="flex items-center gap-1.5 text-xs font-medium bg-blue-500/15 text-blue-400 border border-blue-500/30 hover:bg-blue-500/25 rounded px-3 py-1.5 transition-all disabled:opacity-50"
            >
              {reviewLoading ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
              {reviewLoading ? 'Reviewing…' : 'Review Positions'}
            </button>
          </div>
          <p className="text-[10px] text-gray-500">
            Scans your current T212 holdings on click — multi-week/month trend and 30-day news, not intraday
            signals. Defaults to &quot;keep holding&quot;; only suggests a swap when both the trend and the news are
            genuinely negative over a real timeframe. Nothing runs automatically or in the background.
          </p>

          {reviewError && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">{reviewError}</div>
          )}

          {reviews.length > 0 && (
            <div className="space-y-2">
              {reviews.map(r => (
                <div
                  key={`${r.accountKey}_${r.ticker}`}
                  className={clsx(
                    'rounded-lg border p-3 space-y-1.5',
                    r.verdict === 'CONSIDER_SWAPPING' ? 'border-amber-500/30 bg-amber-500/5' : 'border-gray-800 bg-gray-950/40',
                  )}
                >
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-white">{r.symbol}</span>
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 border border-gray-700">{ACCOUNT_LABELS[r.accountKey]}</span>
                      <span className={clsx(
                        'text-[9px] px-1.5 py-0.5 rounded border font-bold',
                        r.verdict === 'CONSIDER_SWAPPING'
                          ? 'bg-amber-500/15 text-amber-400 border-amber-500/30'
                          : 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
                      )}>
                        {r.verdict === 'CONSIDER_SWAPPING' ? 'CONSIDER SWAPPING' : 'KEEP HOLDING'}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-[10px] text-gray-400 tabular-nums">
                      {r.trend12w !== null && <span>12wk: {fmt(r.trend12w)}%</span>}
                      {r.unrealizedPnl !== null && <span className={r.unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>{fmtP(r.unrealizedPnl)}</span>}
                    </div>
                  </div>
                  <p className="text-xs text-gray-400">{r.reason}</p>
                  {r.verdict === 'CONSIDER_SWAPPING' && r.alternative && (
                    <div className="flex items-center justify-between flex-wrap gap-2 pt-1.5 border-t border-gray-800/60 mt-1.5">
                      <span className="text-[10px] text-gray-500">
                        Suggested alternative: <span className="text-white font-medium">{r.alternative.symbol}</span> ({r.alternative.name})
                        {r.alternative.trend12w !== null && <> — 12wk trend {fmt(r.alternative.trend12w)}%</>}
                      </span>
                      <button
                        onClick={() => void executeSwap(r)}
                        disabled={swappingTicker === r.ticker}
                        className="flex items-center gap-1 text-[10px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/30 hover:bg-amber-500/25 rounded px-2 py-1 transition-all disabled:opacity-50"
                      >
                        <ArrowRightLeft className="h-3 w-3" />
                        {swappingTicker === r.ticker ? 'Swapping…' : `Swap for ${r.alternative.symbol}`}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Auto-Close Engine — IG Demo Spread Bet (always visible) */}
      <div className="bg-gray-900/70 border border-orange-500/25 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-orange-400" />
              <span className="text-sm font-semibold text-white">Auto-Close Engine</span>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-400 border border-orange-500/20 font-bold">IG DEMO SPREAD BET</span>
              {autoCloseEnabled && (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 animate-pulse">ACTIVE</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowTestPanel(v => !v)}
                className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-gray-200 border border-gray-700 hover:border-gray-600 rounded px-2 py-1 transition-all"
              >
                <FlaskConical className="h-3 w-3" /> Test Trade
              </button>
              <button
                onClick={() => setAutoCloseEnabled(v => !v)}
                className={clsx(
                  'flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border font-medium transition-all',
                  autoCloseEnabled
                    ? 'bg-orange-500/20 text-orange-400 border-orange-500/40 hover:bg-orange-500/30'
                    : 'bg-gray-800 text-gray-400 border-gray-700 hover:border-gray-600',
                )}
              >
                {autoCloseEnabled ? 'Disable' : 'Enable'}
              </button>
            </div>
          </div>

          <p className="text-[10px] text-gray-500">
            Monitors IG Demo positions every 30s and closes via market order when your thresholds are hit — no SL/TP orders placed on IG.
            {!hasIgDemoSession && (
              <span className="ml-2 text-amber-400 font-medium">⚠ No IG Demo session detected — connect via Auto Trader → IG Strategy Trader first.</span>
            )}
          </p>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">Take Profit at %</label>
              <input
                type="number"
                value={autoCloseTpPct}
                onChange={e => setAutoCloseTpPct(Math.max(0.1, Number(e.target.value)))}
                min={0.1} max={100} step={0.5}
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white focus:border-emerald-500/50 outline-none"
              />
              <p className="text-[9px] text-gray-600 mt-0.5">Close when P&amp;L ≥ +{autoCloseTpPct}%</p>
            </div>
            <div>
              <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">Stop Loss at %</label>
              <input
                type="number"
                value={autoCloseSlPct}
                onChange={e => setAutoCloseSlPct(Math.max(0.1, Number(e.target.value)))}
                min={0.1} max={100} step={0.5}
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white focus:border-red-500/50 outline-none"
              />
              <p className="text-[9px] text-gray-600 mt-0.5">Close when P&amp;L ≤ -{autoCloseSlPct}%</p>
            </div>
          </div>

          {/* Activity log */}
          {autoCloseLog.length > 0 && (
            <div className="bg-gray-950/80 border border-gray-800 rounded-lg p-2 max-h-28 overflow-y-auto">
              <p className="text-[9px] text-gray-600 uppercase tracking-wider mb-1.5 font-medium">Auto-close log</p>
              {autoCloseLog.map((entry, i) => (
                <p key={i} className="text-[10px] text-gray-400 font-mono leading-relaxed">{entry}</p>
              ))}
            </div>
          )}

          {/* Test trade panel */}
          {showTestPanel && (
            <div className="bg-gray-950/80 border border-gray-800 rounded-lg p-3 space-y-2">
              <p className="text-[10px] text-gray-400 font-medium flex items-center gap-1">
                <FlaskConical className="h-3 w-3" /> Open a test position on IG Demo
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <select
                  value={testEpic}
                  onChange={e => setTestEpic(e.target.value)}
                  className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white outline-none"
                >
                  {EPIC_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <select
                  value={testDir}
                  onChange={e => setTestDir(e.target.value as 'BUY' | 'SELL')}
                  className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white outline-none"
                >
                  <option value="BUY">BUY (Long)</option>
                  <option value="SELL">SELL (Short)</option>
                </select>
                <input
                  type="number"
                  value={testSize}
                  onChange={e => setTestSize(Math.max(0.1, Number(e.target.value)))}
                  min={0.1} step={0.1}
                  placeholder="Size"
                  className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white outline-none"
                />
                <button
                  onClick={() => void openTestTrade()}
                  disabled={testLoading}
                  className="flex items-center gap-1.5 text-xs bg-orange-500/20 text-orange-400 border border-orange-500/30 hover:border-orange-500/60 rounded px-3 py-1.5 transition-all disabled:opacity-40"
                >
                  {testLoading ? <RefreshCw className="h-3 w-3 animate-spin" /> : <PlayCircle className="h-3 w-3" />}
                  Open Now
                </button>
              </div>
              {testResult && (
                <p className={clsx('text-[10px] font-mono mt-1', testResult.startsWith('✓') ? 'text-emerald-400' : 'text-red-400')}>
                  {testResult}
                </p>
              )}
              <p className="text-[9px] text-gray-600">
                The position will appear in your IG Demo account and in the table below.
                {signalMonitorEnabled ? ' Signal Monitor is active — it will close when AI detects a reversal.' : ' Enable Signal Monitor below to auto-close on AI signal reversal.'}
              </p>

              {/* API Diagnostic */}
              <div className="border-t border-gray-800/60 pt-2 space-y-1.5">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => void runDiagnostic()}
                    disabled={diagLoading}
                    className="flex items-center gap-1.5 text-[10px] bg-blue-500/10 text-blue-400 border border-blue-500/30 hover:border-blue-500/60 rounded px-2.5 py-1 transition-all disabled:opacity-40"
                  >
                    {diagLoading ? <RefreshCw className="h-2.5 w-2.5 animate-spin" /> : <Zap className="h-2.5 w-2.5" />}
                    Run API Diagnostics
                  </button>
                  <span className="text-[9px] text-gray-600">Tests all IG endpoints + versions</span>
                </div>
                {diagResult && (
                  <pre className="text-[9px] font-mono text-gray-400 bg-gray-900/60 border border-gray-800 rounded p-2 overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto">
                    {diagResult}
                  </pre>
                )}
              </div>
            </div>
          )}

          {/* ── Signal Monitor — AI-driven reversal close ── */}
          <div className="border-t border-gray-800/60 pt-3 space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <Zap className="h-3.5 w-3.5 text-purple-400" />
                <span className="text-xs font-semibold text-white">Signal Monitor</span>
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-400 border border-purple-500/20">REVERSAL CLOSE</span>
                {signalMonitorEnabled && (
                  <span className={clsx(
                    'text-[9px] px-1.5 py-0.5 rounded border',
                    signalMonitorChecking
                      ? 'bg-blue-500/15 text-blue-400 border-blue-500/20 animate-pulse'
                      : 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20 animate-pulse',
                  )}>
                    {signalMonitorChecking ? 'CHECKING…' : 'WATCHING'}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { void runSignalMonitor(); }}
                  disabled={signalMonitorChecking}
                  className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-gray-200 border border-gray-700 hover:border-gray-600 rounded px-2 py-1 transition-all disabled:opacity-40"
                >
                  {signalMonitorChecking ? <RefreshCw className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                  Check Now
                </button>
                <button
                  onClick={() => setSignalMonitorEnabled(v => !v)}
                  className={clsx(
                    'flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border font-medium transition-all',
                    signalMonitorEnabled
                      ? 'bg-purple-500/20 text-purple-400 border-purple-500/40 hover:bg-purple-500/30'
                      : 'bg-gray-800 text-gray-400 border-gray-700 hover:border-gray-600',
                  )}
                >
                  {signalMonitorEnabled ? 'Disable' : 'Enable'}
                </button>
              </div>
            </div>

            <p className="text-[10px] text-gray-500">
              Uses Gemini Flash AI (if configured) or rule-based RSI/MACD/BB analysis. Checks every {signalMonitorIntervalMin} minute{signalMonitorIntervalMin !== 1 ? 's' : ''}.
              Fires a market close when signal reverses with confidence ≥ 7/10 — no price target needed.
            </p>

            <div className="flex items-center gap-3">
              <label className="text-[10px] text-gray-500 uppercase tracking-wider whitespace-nowrap">Check every</label>
              <input
                type="number"
                value={signalMonitorIntervalMin}
                onChange={e => setSignalMonitorIntervalMin(Math.max(1, Math.min(60, Number(e.target.value))))}
                min={1} max={60} step={1}
                className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white outline-none"
              />
              <span className="text-[10px] text-gray-500">minutes</span>
              <span className="text-[9px] text-gray-600 ml-auto">Results cached 10 min server-side</span>
            </div>

            {signalMonitorLog.length > 0 && (
              <div className="bg-gray-950/80 border border-gray-800 rounded-lg p-2 max-h-36 overflow-y-auto">
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-[9px] text-gray-600 uppercase tracking-wider font-medium">Signal monitor log</p>
                  <button onClick={() => setSignalMonitorLog([])} className="text-[9px] text-gray-600 hover:text-gray-400">Clear</button>
                </div>
                {signalMonitorLog.map((entry, i) => (
                  <p key={i} className={clsx(
                    'text-[10px] font-mono leading-relaxed',
                    entry.includes('CLOSING') ? 'text-orange-400' :
                    entry.includes('✗') ? 'text-red-400' :
                    entry.includes('BUY') ? 'text-emerald-400' :
                    entry.includes('SELL') ? 'text-red-400' : 'text-gray-400',
                  )}>{entry}</p>
                ))}
              </div>
            )}
          </div>
        </div>

      {/* Account summary cards — shown when portfolio data is available */}
      {portfolioData && (portfolioData.t212.length > 0 || portfolioData.ig.length > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
          {portfolioData.t212.map(a => (
            <Card key={a.account} className="p-3">
              <div className="flex items-center gap-1.5 mb-2">
                <span className={clsx('text-[9px] font-bold px-1.5 py-0.5 rounded-full border', {
                  'bg-emerald-500/20 text-emerald-400 border-emerald-500/30': a.account === 'T212_INVEST',
                  'bg-blue-500/20 text-blue-400 border-blue-500/30':         a.account === 'T212_ISA',
                  'bg-purple-500/20 text-purple-400 border-purple-500/30':   a.account === 'T212_DEMO',
                })}>{a.label}</span>
                {a.account === 'T212_DEMO' && <span className="text-[8px] text-purple-400 bg-purple-500/10 px-1 rounded">Practice</span>}
                {a.account === 'T212_ISA'  && <span className="text-[8px] text-blue-400 bg-blue-500/10 px-1 rounded">Tax Free</span>}
              </div>
              <div className="space-y-1 text-[11px]">
                <div className="flex justify-between"><span className="text-gray-500">Account value</span><span className="text-white font-semibold">£{a.summary.totalValue.toFixed(2)}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Invested</span><span className="text-gray-300">£{a.cash.invested.toFixed(2)}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Available cash</span><span className="text-gray-300">£{a.cash.available.toFixed(2)}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">P&amp;L</span><span className={a.summary.totalPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}>{a.summary.totalPnL >= 0 ? '+' : ''}£{Math.abs(a.summary.totalPnL).toFixed(2)}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Positions</span><span className="text-gray-300">{a.summary.positionCount}</span></div>
              </div>
            </Card>
          ))}
          {portfolioData.ig.map(a => (
            <Card key={a.account} className="p-3">
              <div className="flex items-center gap-1.5 mb-2">
                <span className={clsx('text-[9px] font-bold px-1.5 py-0.5 rounded-full border', {
                  'bg-orange-500/20 text-orange-400 border-orange-500/30': a.account === 'IG_DEMO',
                  'bg-amber-500/20 text-amber-400 border-amber-500/30':    a.account === 'IG_LIVE',
                })}>{a.label}</span>
                <span className="text-[8px] text-purple-400 bg-purple-500/10 px-1 rounded">Spread Bet</span>
              </div>
              {a.activeAccount ? (
                <div className="space-y-1 text-[11px]">
                  <div className="flex justify-between"><span className="text-gray-500">Equity</span><span className="text-white font-semibold">£{a.activeAccount.balance.toFixed(2)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Available</span><span className="text-gray-300">£{a.activeAccount.available.toFixed(2)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Deposit</span><span className="text-gray-300">£{a.activeAccount.deposit.toFixed(2)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Open P&amp;L</span><span className={a.summary.totalUpl >= 0 ? 'text-emerald-400' : 'text-red-400'}>{a.summary.totalUpl >= 0 ? '+' : ''}£{Math.abs(a.summary.totalUpl).toFixed(2)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Positions</span><span className="text-gray-300">{a.summary.positionCount}</span></div>
                </div>
              ) : (
                <p className="text-[11px] text-gray-500">No session data</p>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Error banners */}
      {Object.entries(errors).map(([acc, err]) => err && (
        <div key={acc} className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-xs text-red-400">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
          <span><strong>{ACCOUNT_LABELS[acc as AccountKey]}:</strong> {err}</span>
        </div>
      ))}

      {/* Tab bar */}
      <div className="flex items-center gap-1 bg-gray-800/50 rounded-lg p-1 flex-wrap">
        {connectedAccounts.map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className={clsx('flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all',
              activeTab === tab ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
            )}>
            {tab === 'ALL' ? 'All' : ACCOUNT_LABELS[tab as AccountKey]}
            {tabCounts[tab] > 0 && (
              <span className={clsx('text-[9px] px-1.5 py-0.5 rounded-full font-bold',
                activeTab === tab ? 'bg-orange-500/30 text-orange-300' : 'bg-gray-700 text-gray-500'
              )}>{tabCounts[tab]}</span>
            )}
          </button>
        ))}
      </div>

      {/* Positions / Orders sub-tab */}
      <div className="flex items-center gap-1 bg-gray-800/40 rounded-lg p-0.5 w-fit">
        {(['positions', 'orders'] as const).map(t => {
          const orderCount = portfolioData
            ? portfolioData.t212.reduce((s, a) => s + (a.orders as unknown[]).length, 0)
              + portfolioData.ig.reduce((s, a) => s + a.workingOrders.length, 0)
            : 0;
          return (
            <button key={t} onClick={() => setPosTab(t)}
              className={clsx('px-3 py-1.5 text-xs font-medium rounded-md transition-all',
                posTab === t ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
              )}>
              {t === 'positions' ? `Open Positions (${filtered.length})` : `Working Orders (${orderCount})`}
            </button>
          );
        })}
      </div>

      {/* Positions table */}
      {posTab === 'positions' && (
        <Card className="overflow-hidden p-0">
          {loading && positions.length === 0 ? (
            <div className="flex items-center justify-center py-12 gap-3 text-gray-500">
              <RefreshCw className="h-5 w-5 animate-spin" />
              <span className="text-sm">Loading positions…</span>
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-12 text-center space-y-3">
              <BarChart3 className="h-8 w-8 text-gray-700 mx-auto" />
              <p className="text-sm text-gray-500">No open positions</p>
              {activeTab === 'ALL' && (
                <p className="text-xs text-gray-600">
                  Connect accounts in{' '}
                  <Link href="/settings/accounts" className="text-orange-400 hover:underline">Settings → Accounts</Link>
                </p>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-gray-800 bg-gray-900/50">
                    {['Account / Market', 'Dir', 'Qty/Size', 'Entry', 'Current', 'P&L', 'SL', 'TP', 'Age', ''].map(h => (
                      <th key={h} className="px-3 py-2 text-[10px] text-gray-500 font-medium uppercase tracking-wider whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(pos => (
                    <PositionRow key={pos.id} pos={pos}
                      onClose={closePosition}
                      closing={closingId === pos.id}
                      cgIds={cgIdsRef.current}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* Working Orders table */}
      {posTab === 'orders' && (
        <Card className="overflow-hidden p-0">
          {!portfolioData || (portfolioData.t212.every(a => (a.orders as unknown[]).length === 0) && portfolioData.ig.every(a => a.workingOrders.length === 0)) ? (
            <div className="py-12 text-center space-y-2">
              <Layers className="h-8 w-8 text-gray-700 mx-auto" />
              <p className="text-sm text-gray-500">No working orders</p>
              <p className="text-xs text-gray-600">Click &quot;Load Portfolio&quot; to fetch working orders from connected accounts</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-gray-800 bg-gray-900/50">
                    {['Account', 'Market', 'Type', 'Dir', 'Size', 'Level', 'Created', 'Good Till'].map(h => (
                      <th key={h} className="px-3 py-2 text-[10px] text-gray-500 font-medium uppercase tracking-wider whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {portfolioData.ig.flatMap(a =>
                    a.workingOrders.map(o => (
                      <tr key={`${a.account}_${o.dealId}`} className="border-t border-gray-800 hover:bg-gray-800/30 text-xs">
                        <td className="px-3 py-2.5"><AccountBadge account={a.account as AccountKey} /></td>
                        <td className="px-3 py-2.5">
                          <p className="font-semibold text-white">{o.instrumentName || o.epic}</p>
                          <p className="text-[10px] text-gray-500 font-mono">{o.epic}</p>
                        </td>
                        <td className="px-3 py-2.5"><span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-300 font-medium">{o.orderType}</span></td>
                        <td className="px-3 py-2.5">
                          <span className={clsx('text-[10px] font-bold px-1.5 py-0.5 rounded',
                            o.direction === 'BUY' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                          )}>{o.direction}</span>
                        </td>
                        <td className="px-3 py-2.5 text-gray-300 tabular-nums">{o.size}</td>
                        <td className="px-3 py-2.5 text-gray-300 tabular-nums">{fmtPrice(o.orderLevel)}</td>
                        <td className="px-3 py-2.5 text-[10px] text-gray-500">
                          {o.createdDate ? new Date(o.createdDate).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '—'}
                        </td>
                        <td className="px-3 py-2.5 text-[10px] text-gray-500">
                          {o.goodTillDate ? new Date(o.goodTillDate).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : 'GTC'}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* Closed Positions / History toggle */}
      <button
        onClick={() => { setShowHistory(v => !v); if (!showHistory) void fetchHistory(); }}
        className="flex items-center gap-2 text-xs text-gray-400 hover:text-gray-200 transition-colors"
      >
        <History className="h-3.5 w-3.5" />
        {showHistory ? 'Hide' : 'Show'} Closed Positions / History
        {showHistory ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>

      {showHistory && (
        <Card className="overflow-hidden p-0">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
            <div className="flex items-center gap-2 text-sm font-semibold text-white">
              <History className="h-4 w-4 text-gray-400" /> Recently Closed ({filteredHistory.length})
            </div>
            {/* Filter tabs */}
            <div className="flex items-center gap-1">
              {(['ALL', 'T212_INVEST', 'T212_ISA', 'T212_DEMO', 'IG_DEMO', 'IG_LIVE'] as (AccountKey | 'ALL')[]).map(tab => (
                <button key={tab} onClick={() => setHistoryFilter(tab)}
                  className={clsx('text-[10px] px-2 py-1 rounded transition-all',
                    historyFilter === tab ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
                  )}>
                  {tab === 'ALL' ? 'All' : ACCOUNT_LABELS[tab as AccountKey]}
                </button>
              ))}
            </div>
          </div>
          {filteredHistory.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-8">No history found</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-gray-800 bg-gray-900/50">
                    {['Account', 'Market', 'Dir', 'Size', 'Level', 'Closed', 'P&L'].map(h => (
                      <th key={h} className="px-3 py-2 text-[10px] text-gray-500 font-medium uppercase tracking-wider whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredHistory.map(h => (
                    <tr key={h.id} className="border-t border-gray-800 hover:bg-gray-800/30 text-xs">
                      <td className="px-3 py-2"><AccountBadge account={h.account} /></td>
                      <td className="px-3 py-2">
                        <p className="font-semibold text-white">{h.name}</p>
                        <p className="text-[10px] text-gray-500 font-mono">{h.ticker}</p>
                      </td>
                      <td className="px-3 py-2">
                        <span className={clsx('text-[10px] font-bold px-1.5 py-0.5 rounded',
                          h.direction === 'BUY' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                        )}>{h.direction}</span>
                      </td>
                      <td className="px-3 py-2 text-gray-300 tabular-nums">{h.size}</td>
                      <td className="px-3 py-2 text-gray-300 tabular-nums">{fmtPrice(h.level)}</td>
                      <td className="px-3 py-2 text-gray-400 text-[10px]">
                        {h.closedAt ? new Date(h.closedAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '—'}
                      </td>
                      <td className="px-3 py-2">
                        {h.pnl != null ? (
                          <span className={clsx('font-semibold tabular-nums', h.pnl >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                            {fmtP(h.pnl)}
                          </span>
                        ) : <span className="text-gray-600">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* Not connected notices */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {!t212Connected && (
          <div className="flex items-center gap-3 bg-gray-900 border border-gray-800 rounded-xl p-4 text-xs text-gray-500">
            <Wifi className="h-4 w-4 text-gray-600 flex-shrink-0" />
            <div>
              <p className="font-semibold text-gray-400">T212 Invest not connected</p>
              <Link href="/settings/accounts" className="text-orange-400 hover:underline flex items-center gap-1 mt-0.5">
                Connect in Settings <ExternalLink className="h-2.5 w-2.5" />
              </Link>
            </div>
          </div>
        )}
        {!t212IsaConnected && (
          <div className="flex items-center gap-3 bg-gray-900 border border-gray-800 rounded-xl p-4 text-xs text-gray-500">
            <Wifi className="h-4 w-4 text-gray-600 flex-shrink-0" />
            <div>
              <p className="font-semibold text-gray-400">T212 ISA not connected</p>
              <Link href="/settings/accounts" className="text-orange-400 hover:underline flex items-center gap-1 mt-0.5">
                Connect in Settings <ExternalLink className="h-2.5 w-2.5" />
              </Link>
            </div>
          </div>
        )}
      </div>

      {/* Load Portfolio Modal — wired to page's portfolioModal hook */}
      <LoadPortfolioModal
        open={portfolioModal.open}
        onClose={portfolioModal.closeModal}
        loading={portfolioModal.loading}
        done={portfolioModal.done}
        accounts={portfolioModal.accounts}
        data={portfolioModal.data}
        totalPositions={portfolioModal.totalPositions}
        connectedCount={portfolioModal.connectedCount}
        onReload={portfolioModal.reload}
      />

      {/* Manual position modal */}
      {showManualModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-sm shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <Edit2 className="h-4 w-4 text-orange-400" /> Add Manual Position
              </h3>
              <button onClick={() => setShowManualModal(false)}><X className="h-4 w-4 text-gray-500 hover:text-white" /></button>
            </div>
            <p className="text-[11px] text-gray-400">Log a position opened outside ClearGains for tracking.</p>
            <div className="space-y-3">
              {/* Account */}
              <div>
                <label className="text-[10px] text-gray-400 mb-1 block">Account</label>
                <select value={manualForm.account} onChange={e => setManualForm(f => ({ ...f, account: e.target.value as AccountKey }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-orange-500">
                  {Object.entries(ACCOUNT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              {/* Name + Ticker */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-gray-400 mb-1 block">Market Name</label>
                  <input value={manualForm.name} onChange={e => setManualForm(f => ({ ...f, name: e.target.value }))} placeholder="Apple Inc."
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-orange-500" />
                </div>
                <div>
                  <label className="text-[10px] text-gray-400 mb-1 block">Ticker / Epic</label>
                  <input value={manualForm.ticker} onChange={e => setManualForm(f => ({ ...f, ticker: e.target.value }))} placeholder="AAPL"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-orange-500" />
                </div>
              </div>
              {/* Direction + Qty */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-gray-400 mb-1 block">Direction</label>
                  <div className="flex gap-1">
                    {(['BUY', 'SELL'] as const).map(d => (
                      <button key={d} onClick={() => setManualForm(f => ({ ...f, direction: d }))}
                        className={clsx('flex-1 py-1.5 rounded text-xs font-bold border transition-all',
                          manualForm.direction === d ? d === 'BUY' ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' : 'bg-red-500/20 text-red-300 border-red-500/40'
                          : 'bg-gray-800 text-gray-500 border-gray-700'
                        )}>{d}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-[10px] text-gray-400 mb-1 block">Quantity</label>
                  <input type="number" min={0} step={0.0001} value={manualForm.quantity} onChange={e => setManualForm(f => ({ ...f, quantity: Number(e.target.value) }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-orange-500" />
                </div>
              </div>
              {/* Entry + Date */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-gray-400 mb-1 block">Entry Price</label>
                  <input type="number" min={0} step={0.01} value={manualForm.entryPrice} onChange={e => setManualForm(f => ({ ...f, entryPrice: Number(e.target.value) }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-orange-500" />
                </div>
                <div>
                  <label className="text-[10px] text-gray-400 mb-1 block">Opened At</label>
                  <input type="datetime-local" value={manualForm.openedAt} onChange={e => setManualForm(f => ({ ...f, openedAt: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-xs text-white focus:outline-none focus:border-orange-500" />
                </div>
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <Button fullWidth variant="outline" onClick={() => setShowManualModal(false)}>Cancel</Button>
              <Button fullWidth onClick={saveManualPosition} disabled={!manualForm.name || !manualForm.ticker || manualForm.entryPrice <= 0}>
                Add Position
              </Button>
            </div>
          </div>
        </div>
      )}

      <p className="text-[10px] text-gray-700 text-center">
        ⚠️ Positions auto-refresh every 30s. Prices are indicative. Always verify in your broker platform before trading. Tax tags are informational only.
      </p>
    </div>
  );
}

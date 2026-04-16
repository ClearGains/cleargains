'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  RefreshCw, X, AlertCircle,
  BarChart3, Clock, Wifi, ExternalLink, Download, Plus,
  ChevronDown, ChevronUp, Bell, Edit2, CheckCircle2, History,
  Layers,
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

  const prevPositionsRef = useRef<UnifiedPosition[]>([]);
  const refreshRef       = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const cgIdsRef         = useRef<Set<string>>(new Set());

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
        const raw = typeof window !== 'undefined' ? localStorage.getItem(`ig_session_${envKey}`) : null;
        if (!raw) return;
        const sess = JSON.parse(raw) as { cst?: string; securityToken?: string; apiKey?: string };
        if (!sess.cst || !sess.securityToken || !sess.apiKey) return;

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
        }>; error?: string };

        if (!d.ok) { errs[accountKey] = d.error ?? `IG ${envKey} error`; return; }

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
    setErrors(errs);
    setLoading(false);
    setCountdown(30);

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
        const raw = localStorage.getItem(`ig_session_${envKey}`);
        if (!raw) { setCloseError('No IG session found'); setClosingId(null); return; }
        const sess = JSON.parse(raw) as { cst: string; securityToken: string; apiKey: string };
        const r = await fetch('/api/ig/order', {
          method: 'DELETE',
          headers: { 'x-ig-cst': sess.cst, 'x-ig-security-token': sess.securityToken, 'x-ig-api-key': sess.apiKey, 'x-ig-env': envKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ dealId: pos.dealId, direction: pos.direction === 'BUY' ? 'SELL' : 'BUY', size: pos.quantity }),
        });
        const d = await r.json() as { ok: boolean; error?: string };
        if (!d.ok) { setCloseError(d.error ?? 'Close failed'); setClosingId(null); return; }
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

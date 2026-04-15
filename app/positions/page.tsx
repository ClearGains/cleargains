'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  RefreshCw, TrendingUp, TrendingDown, X, AlertCircle,
  BarChart3, Clock, Wifi, ExternalLink,
} from 'lucide-react';
import { clsx } from 'clsx';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useClearGainsStore } from '@/lib/store';
import Link from 'next/link';

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
  // IG-specific for close
  dealId?:      string;
  epic?:        string;
  // T212-specific for close
  t212Ticker?:  string;
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
function fmtPrice(n: number) {
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

// ── Account badge ─────────────────────────────────────────────────────────────

function AccountBadge({ account }: { account: AccountKey }) {
  return (
    <span className={clsx('text-[9px] font-bold px-1.5 py-0.5 rounded-full border', ACCOUNT_COLORS[account])}>
      {ACCOUNT_LABELS[account]}
    </span>
  );
}

// ── Summary card ──────────────────────────────────────────────────────────────

function SummaryCard({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: 'pos' | 'neg' | 'neutral' }) {
  return (
    <Card>
      <p className="text-[10px] text-gray-500 uppercase tracking-wider font-medium mb-1">{label}</p>
      <p className={clsx('text-lg font-bold tabular-nums',
        highlight === 'pos' ? 'text-emerald-400' :
        highlight === 'neg' ? 'text-red-400' : 'text-white'
      )}>{value}</p>
      {sub && <p className="text-[10px] text-gray-600 mt-0.5">{sub}</p>}
    </Card>
  );
}

// ── Position row ──────────────────────────────────────────────────────────────

function PositionRow({ pos, onClose, closing }: {
  pos: UnifiedPosition;
  onClose: (p: UnifiedPosition) => void;
  closing: boolean;
}) {
  const isProfit = pos.pnl >= 0;
  return (
    <tr className="border-t border-gray-800 hover:bg-gray-800/30 transition-colors">
      <td className="px-3 py-2.5">
        <div className="space-y-0.5">
          <AccountBadge account={pos.account} />
          <p className="text-xs font-semibold text-white mt-1">{pos.name}</p>
          <p className="text-[10px] text-gray-500 font-mono">{pos.ticker}</p>
        </div>
      </td>
      <td className="px-3 py-2.5">
        <span className={clsx('text-[10px] font-bold px-1.5 py-0.5 rounded',
          pos.direction === 'BUY' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
        )}>{pos.direction === 'BUY' ? 'LONG' : 'SHORT'}</span>
      </td>
      <td className="px-3 py-2.5 text-xs text-gray-300 tabular-nums">{pos.quantity}</td>
      <td className="px-3 py-2.5 text-xs text-gray-300 tabular-nums">{fmtPrice(pos.entryPrice)}</td>
      <td className="px-3 py-2.5 text-xs text-gray-300 tabular-nums">{fmtPrice(pos.currentPrice)}</td>
      <td className="px-3 py-2.5">
        <div className={clsx('text-xs font-semibold tabular-nums', isProfit ? 'text-emerald-400' : 'text-red-400')}>
          {fmt(pos.pnl)} {pos.currency}
        </div>
        <div className={clsx('text-[10px] tabular-nums', isProfit ? 'text-emerald-500' : 'text-red-500')}>
          {fmt(pos.pnlPct)}%
        </div>
      </td>
      <td className="px-3 py-2.5 text-[10px] text-gray-500 tabular-nums">
        <div>{pos.stopLevel ? fmtPrice(pos.stopLevel) : '—'}</div>
        <div className="text-[9px] text-gray-600">SL</div>
      </td>
      <td className="px-3 py-2.5 text-[10px] text-gray-500 tabular-nums">
        <div>{pos.limitLevel ? fmtPrice(pos.limitLevel) : '—'}</div>
        <div className="text-[9px] text-gray-600">TP</div>
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

  const [positions, setPositions]   = useState<UnifiedPosition[]>([]);
  const [loading, setLoading]       = useState(true);
  const [errors, setErrors]         = useState<Partial<Record<AccountKey, string>>>({});
  const [activeTab, setActiveTab]   = useState<AccountKey | 'ALL'>('ALL');
  const [countdown, setCountdown]   = useState(30);
  const [closingId, setClosingId]   = useState<string | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [closeSuccess, setCloseSuccess] = useState<string | null>(null);
  const [fundsData, setFundsData]   = useState<Partial<Record<string, { available: number; label: string; color: string }>>>({});

  const refreshRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Fetch all positions ────────────────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    setLoading(true);
    const all: UnifiedPosition[] = [];
    const errs: Partial<Record<AccountKey, string>> = {};

    // ── T212 helper ──────────────────────────────────────────────────────────
    async function fetchT212(
      key: string, secret: string,
      accountKey: AccountKey, env: string,
    ) {
      if (!key) return;
      try {
        const encoded = btoa(key + ':' + secret);
        const r = await fetch(`/api/t212/positions?env=${env}`, {
          headers: { 'x-t212-auth': encoded },
        });
        const raw = await r.json() as unknown;
        // Response can be a direct array or { items: [...] }
        const items: Record<string, unknown>[] = Array.isArray(raw)
          ? (raw as Record<string, unknown>[])
          : ((raw as Record<string, unknown[]>).items ?? []) as Record<string, unknown>[];

        items.forEach((p) => {
          const qty   = Number(p.quantity   ?? 0);
          const entry = Number(p.averagePrice ?? 0);
          const curr  = Number(p.currentPrice ?? 0);
          const pnl   = Number(p.ppl ?? ((curr - entry) * qty));
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
            t212Ticker:   String(p.ticker ?? ''),
          });
        });
      } catch (e) {
        errs[accountKey] = e instanceof Error ? e.message : String(e);
      }
    }

    // T212 accounts
    if (t212Connected)    await fetchT212(t212ApiKey,    t212ApiSecret,    'T212_INVEST', 'live');
    if (t212IsaConnected) await fetchT212(t212IsaApiKey, t212IsaApiSecret, 'T212_ISA',    'live');
    if (t212DemoConnected) await fetchT212(t212DemoApiKey, t212DemoApiSecret, 'T212_DEMO', 'demo');

    // ── IG helper ─────────────────────────────────────────────────────────────
    async function fetchIG(envKey: 'demo' | 'live', accountKey: AccountKey) {
      try {
        const raw = typeof window !== 'undefined'
          ? localStorage.getItem(`ig_session_${envKey}`)
          : null;
        if (!raw) return;
        const sess = JSON.parse(raw) as { cst?: string; securityToken?: string; apiKey?: string; authenticatedAt?: number };
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
            dealId:       p.dealId,
            epic:         p.epic,
          });
        });
      } catch (e) {
        errs[accountKey] = e instanceof Error ? e.message : String(e);
      }
    }

    await fetchIG('demo', 'IG_DEMO');
    await fetchIG('live', 'IG_LIVE');

    setPositions(all);
    setErrors(errs);
    setLoading(false);
    setCountdown(30);

    // ── Fetch available funds for each connected account ──────────────────────
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
      t212Connected     ? loadT212Cash(t212ApiKey, t212ApiSecret, 'live', 'T212 Invest', 'text-emerald-400') : Promise.resolve(),
      t212IsaConnected  ? loadT212Cash(t212IsaApiKey, t212IsaApiSecret, 'live', 'T212 ISA', 'text-blue-400') : Promise.resolve(),
      t212DemoConnected ? loadT212Cash(t212DemoApiKey, t212DemoApiSecret, 'demo', 'T212 Demo', 'text-purple-400') : Promise.resolve(),
      loadIGFunds('demo', 'IG Demo', 'text-orange-400'),
      loadIGFunds('live', 'IG Live', 'text-amber-400'),
    ]);

    setFundsData(funds);
  }, [
    t212ApiKey, t212ApiSecret, t212Connected,
    t212IsaApiKey, t212IsaApiSecret, t212IsaConnected,
    t212DemoApiKey, t212DemoApiSecret, t212DemoConnected,
  ]);

  // ── Auto-refresh every 30s ─────────────────────────────────────────────────
  useEffect(() => {
    void fetchAll();

    refreshRef.current = setInterval(() => { void fetchAll(); }, 30_000);
    countdownRef.current = setInterval(() => {
      setCountdown(c => c > 0 ? c - 1 : 30);
    }, 1_000);

    return () => {
      if (refreshRef.current)   clearInterval(refreshRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [fetchAll]);

  // ── Close position ─────────────────────────────────────────────────────────
  async function closePosition(pos: UnifiedPosition) {
    setClosingId(pos.id);
    setCloseError(null);
    setCloseSuccess(null);

    try {
      if (pos.account === 'IG_DEMO' || pos.account === 'IG_LIVE') {
        // Close IG position
        const envKey = pos.account === 'IG_DEMO' ? 'demo' : 'live';
        const raw = localStorage.getItem(`ig_session_${envKey}`);
        if (!raw) { setCloseError('No IG session found'); setClosingId(null); return; }
        const sess = JSON.parse(raw) as { cst: string; securityToken: string; apiKey: string };

        const r = await fetch('/api/ig/order', {
          method: 'DELETE',
          headers: {
            'x-ig-cst':            sess.cst,
            'x-ig-security-token': sess.securityToken,
            'x-ig-api-key':        sess.apiKey,
            'x-ig-env':            envKey,
            'Content-Type':        'application/json',
          },
          body: JSON.stringify({
            dealId:    pos.dealId,
            direction: pos.direction === 'BUY' ? 'SELL' : 'BUY',
            size:      pos.quantity,
          }),
        });
        const d = await r.json() as { ok: boolean; error?: string };
        if (!d.ok) { setCloseError(d.error ?? 'Close failed'); setClosingId(null); return; }
        setCloseSuccess(`Closed ${pos.name}`);

      } else {
        // Close T212 position
        const isDemo = pos.account === 'T212_DEMO';
        const isIsa  = pos.account === 'T212_ISA';
        const key    = isDemo ? t212DemoApiKey : isIsa ? t212IsaApiKey : t212ApiKey;
        const secret = isDemo ? t212DemoApiSecret : isIsa ? t212IsaApiSecret : t212ApiSecret;
        const env    = isDemo ? 'demo' : 'live';

        const r = await fetch('/api/t212/sell', {
          method: 'POST',
          headers: {
            'x-t212-auth':  btoa(key + ':' + secret),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ticker: pos.t212Ticker, quantity: pos.quantity, env }),
        });
        const d = await r.json() as { ok: boolean; error?: string };
        if (!d.ok) { setCloseError(d.error ?? 'Close failed'); setClosingId(null); return; }
        setCloseSuccess(`Closed ${pos.name}`);
      }

      // Refresh after close
      setTimeout(() => { void fetchAll(); }, 1_500);
      setTimeout(() => setCloseSuccess(null), 4_000);
    } catch (e) {
      setCloseError(e instanceof Error ? e.message : 'Unknown error');
    }
    setClosingId(null);
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const filtered = activeTab === 'ALL' ? positions : positions.filter(p => p.account === activeTab);
  const totalPnL  = positions.reduce((s, p) => s + p.pnl, 0);
  const t212PnL   = positions.filter(p => p.account.startsWith('T212')).reduce((s, p) => s + p.pnl, 0);
  const igPnL     = positions.filter(p => p.account.startsWith('IG')).reduce((s, p) => s + p.pnl, 0);
  const best  = positions.length ? positions.reduce((a, b) => a.pnl > b.pnl ? a : b) : null;
  const worst = positions.length ? positions.reduce((a, b) => a.pnl < b.pnl ? a : b) : null;

  const tabCounts: Record<AccountKey | 'ALL', number> = {
    ALL:        positions.length,
    T212_INVEST: positions.filter(p => p.account === 'T212_INVEST').length,
    T212_ISA:   positions.filter(p => p.account === 'T212_ISA').length,
    T212_DEMO:  positions.filter(p => p.account === 'T212_DEMO').length,
    IG_DEMO:    positions.filter(p => p.account === 'IG_DEMO').length,
    IG_LIVE:    positions.filter(p => p.account === 'IG_LIVE').length,
  };

  const connectedAccounts: (AccountKey | 'ALL')[] = ['ALL'];
  if (t212Connected)    connectedAccounts.push('T212_INVEST');
  if (t212IsaConnected) connectedAccounts.push('T212_ISA');
  if (t212DemoConnected) connectedAccounts.push('T212_DEMO');
  // IG tabs always shown (session may be in localStorage)
  connectedAccounts.push('IG_DEMO', 'IG_LIVE');

  return (
    <div className="max-w-6xl mx-auto p-4 space-y-4">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-orange-400" />
            Live Positions
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">All open positions across connected accounts</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-gray-600 flex items-center gap-1">
            <Clock className="h-3 w-3" />
            Refreshing in {countdown}s
          </span>
          <Button size="sm" variant="outline" loading={loading}
            icon={<RefreshCw className="h-3.5 w-3.5" />}
            onClick={() => void fetchAll()}>
            Refresh
          </Button>
        </div>
      </div>

      {/* Toasts */}
      {closeSuccess && (
        <div className="flex items-center gap-2 bg-emerald-500/15 border border-emerald-500/25 rounded-lg px-3 py-2.5 text-xs text-emerald-400">
          ✓ {closeSuccess}
        </div>
      )}
      {closeError && (
        <div className="flex items-center gap-2 bg-red-500/15 border border-red-500/25 rounded-lg px-3 py-2.5 text-xs text-red-400">
          <AlertCircle className="h-3.5 w-3.5" />{closeError}
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <SummaryCard
          label="Total P&L"
          value={`${totalPnL >= 0 ? '+' : ''}£${Math.abs(totalPnL).toFixed(2)}`}
          sub={`${positions.length} open positions`}
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
          value={best ? `+£${best.pnl.toFixed(2)}` : '—'}
          sub={best?.name}
          highlight={best && best.pnl > 0 ? 'pos' : 'neutral'}
        />
        <SummaryCard
          label="Worst Position"
          value={worst ? `${worst.pnl >= 0 ? '+' : ''}£${worst.pnl.toFixed(2)}` : '—'}
          sub={worst?.name}
          highlight={worst && worst.pnl < 0 ? 'neg' : 'neutral'}
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
            className={clsx(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all',
              activeTab === tab
                ? 'bg-gray-700 text-white'
                : 'text-gray-500 hover:text-gray-300'
            )}>
            {tab === 'ALL' ? 'All' : ACCOUNT_LABELS[tab as AccountKey]}
            {tabCounts[tab] > 0 && (
              <span className={clsx('text-[9px] px-1.5 py-0.5 rounded-full font-bold',
                activeTab === tab ? 'bg-orange-500/30 text-orange-300' : 'bg-gray-700 text-gray-500'
              )}>
                {tabCounts[tab]}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Positions table */}
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
                <Link href="/settings/accounts" className="text-orange-400 hover:underline">
                  Settings → Accounts
                </Link>
              </p>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-gray-800 bg-gray-900/50">
                  {['Account / Market', 'Dir', 'Qty/Size', 'Entry', 'Current', 'P&L', 'Stop', 'TP', 'Age', ''].map(h => (
                    <th key={h} className="px-3 py-2 text-[10px] text-gray-500 font-medium uppercase tracking-wider whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(pos => (
                  <PositionRow key={pos.id} pos={pos}
                    onClose={closePosition}
                    closing={closingId === pos.id}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

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

      <p className="text-[10px] text-gray-700 text-center">
        ⚠️ Positions auto-refresh every 30s. Prices are indicative. Always verify in your broker platform before trading.
      </p>
    </div>
  );
}

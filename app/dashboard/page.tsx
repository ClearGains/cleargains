'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  TrendingUp,
  TrendingDown,
  RefreshCw,
  Wifi,
  WifiOff,
  ToggleLeft,
  ToggleRight,
  ArrowRight,
  Clock,
  Zap,
  ShieldCheck,
  AlertCircle,
  FlaskConical,
  Key,
  LogOut,
  BarChart3,
  X,
} from 'lucide-react';
import { useClearGainsStore } from '@/lib/store';
import { buildSection104Pools } from '@/lib/cgt';
import { Trade } from '@/lib/types';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConnectModal } from '@/components/t212/ConnectModal';
import { TaxYearTracker } from '@/components/dashboard/TaxYearTracker';
import { CGTMonitorWidget } from '@/components/tax/CGTMonitorWidget';
import { LoadPortfolioButton } from '@/components/portfolio/LoadPortfolioModal';
import { clsx } from 'clsx';
import Link from 'next/link';

function formatGBP(value: number) {
  return value.toLocaleString('en-GB', { style: 'currency', currency: 'GBP' });
}

// ── Unified position type (mirrors positions page) ────────────────────────────
type UPos = {
  id: string; account: string; name: string; ticker: string;
  direction: 'BUY' | 'SELL'; quantity: number; entryPrice: number;
  currentPrice: number; pnl: number; pnlPct: number;
  currency: string; dealId?: string; t212Ticker?: string;
};

const ACCT_LABELS: Record<string, string> = {
  T212_INVEST: 'T212', T212_ISA: 'ISA', T212_DEMO: 'Demo',
  IG_DEMO: 'IG Demo', IG_LIVE: 'IG Live',
};

// ── Live Positions Widget ─────────────────────────────────────────────────────
function LivePositionsWidget() {
  const {
    t212ApiKey, t212ApiSecret, t212Connected,
    t212IsaApiKey, t212IsaApiSecret, t212IsaConnected,
    t212DemoApiKey, t212DemoApiSecret, t212DemoConnected,
  } = useClearGainsStore();

  const [positions, setPositions] = useState<UPos[]>([]);
  const [loading, setLoading]     = useState(false);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchPositions = useCallback(async () => {
    setLoading(true);
    const all: UPos[] = [];

    async function fetchT212(key: string, secret: string, accountKey: string, env: string) {
      if (!key) return;
      try {
        const r = await fetch(`/api/t212/positions?env=${env}`, {
          headers: { 'x-t212-auth': btoa(key + ':' + secret) },
        });
        const raw = await r.json() as unknown;
        const items: Record<string, unknown>[] = Array.isArray(raw)
          ? (raw as Record<string, unknown>[])
          : ((raw as Record<string, unknown[]>).items ?? []) as Record<string, unknown>[];
        items.forEach(p => {
          const qty   = Number(p.quantity ?? 0);
          const entry = Number(p.averagePrice ?? 0);
          const curr  = Number(p.currentPrice ?? 0);
          const pnl   = Number(p.ppl ?? ((curr - entry) * qty));
          all.push({
            id: `${accountKey}_${p.ticker}`, account: accountKey,
            name: String(p.ticker ?? '').replace(/_[A-Z]{2}_[A-Z]{2}$/, ''),
            ticker: String(p.ticker ?? ''), direction: 'BUY',
            quantity: qty, entryPrice: entry, currentPrice: curr,
            pnl: Math.round(pnl * 100) / 100,
            pnlPct: entry > 0 ? Math.round(((curr - entry) / entry) * 10000) / 100 : 0,
            currency: 'GBP', t212Ticker: String(p.ticker ?? ''),
          });
        });
      } catch {}
    }

    async function fetchIG(envKey: 'demo' | 'live', accountKey: string) {
      try {
        const raw = localStorage.getItem(`ig_session_${envKey}`);
        if (!raw) return;
        const sess = JSON.parse(raw) as { cst?: string; securityToken?: string; apiKey?: string };
        if (!sess.cst || !sess.securityToken || !sess.apiKey) return;
        const r = await fetch('/api/ig/positions', {
          headers: { 'x-ig-cst': sess.cst, 'x-ig-security-token': sess.securityToken, 'x-ig-api-key': sess.apiKey, 'x-ig-env': envKey },
        });
        const d = await r.json() as { ok: boolean; positions?: Array<{ dealId: string; direction: string; size: number; level: number; upl: number; currency: string; epic: string; instrumentName: string; bid: number; offer: number }> };
        (d.positions ?? []).forEach(p => {
          const curr = p.direction === 'BUY' ? p.bid : p.offer;
          all.push({
            id: `${accountKey}_${p.dealId}`, account: accountKey,
            name: p.instrumentName || p.epic, ticker: p.epic,
            direction: p.direction as 'BUY' | 'SELL', quantity: p.size,
            entryPrice: p.level, currentPrice: curr, pnl: p.upl,
            pnlPct: p.level > 0 ? Math.round((p.upl / (p.level * p.size)) * 10000) / 100 : 0,
            currency: p.currency || 'GBP', dealId: p.dealId,
          });
        });
      } catch {}
    }

    await Promise.all([
      t212Connected     ? fetchT212(t212ApiKey,    t212ApiSecret,    'T212_INVEST', 'live') : Promise.resolve(),
      t212IsaConnected  ? fetchT212(t212IsaApiKey, t212IsaApiSecret, 'T212_ISA',    'live') : Promise.resolve(),
      t212DemoConnected ? fetchT212(t212DemoApiKey, t212DemoApiSecret, 'T212_DEMO', 'demo') : Promise.resolve(),
      fetchIG('demo', 'IG_DEMO'),
      fetchIG('live', 'IG_LIVE'),
    ]);

    all.sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
    setPositions(all);
    setLastUpdated(new Date());
    setLoading(false);
  }, [t212ApiKey, t212ApiSecret, t212Connected, t212IsaApiKey, t212IsaApiSecret, t212IsaConnected, t212DemoApiKey, t212DemoApiSecret, t212DemoConnected]);

  useEffect(() => {
    void fetchPositions();
    timerRef.current = setInterval(() => { void fetchPositions(); }, 60_000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [fetchPositions]);

  async function closePos(pos: UPos) {
    setClosingId(pos.id);
    try {
      if (pos.account.startsWith('IG_')) {
        const envKey = pos.account === 'IG_DEMO' ? 'demo' : 'live';
        const raw = localStorage.getItem(`ig_session_${envKey}`);
        if (!raw) { setClosingId(null); return; }
        const sess = JSON.parse(raw) as { cst: string; securityToken: string; apiKey: string };
        await fetch('/api/ig/order', {
          method: 'DELETE',
          headers: { 'x-ig-cst': sess.cst, 'x-ig-security-token': sess.securityToken, 'x-ig-api-key': sess.apiKey, 'x-ig-env': envKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ dealId: pos.dealId, direction: pos.direction === 'BUY' ? 'SELL' : 'BUY', size: pos.quantity }),
        });
      } else {
        const isDemo = pos.account === 'T212_DEMO';
        const isIsa  = pos.account === 'T212_ISA';
        const key    = isDemo ? t212DemoApiKey : isIsa ? t212IsaApiKey : t212ApiKey;
        const secret = isDemo ? t212DemoApiSecret : isIsa ? t212IsaApiSecret : t212ApiSecret;
        const env    = isDemo ? 'demo' : 'live';
        await fetch('/api/t212/sell', {
          method: 'POST',
          headers: { 'x-t212-auth': btoa(key + ':' + secret), 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticker: pos.t212Ticker, quantity: pos.quantity, env }),
        });
      }
    } catch {}
    setClosingId(null);
    setTimeout(() => { void fetchPositions(); }, 1_500);
  }

  const totalPnL = positions.reduce((s, p) => s + p.pnl, 0);
  const top5     = positions.slice(0, 5);

  return (
    <Card className="mt-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-orange-400" />
          <div>
            <h3 className="text-sm font-semibold text-gray-200">Live Positions</h3>
            <p className="text-[10px] text-gray-500">
              {positions.length} open · Total P&L:{' '}
              <span className={totalPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                {totalPnL >= 0 ? '+' : ''}£{Math.abs(totalPnL).toFixed(2)}
              </span>
              {lastUpdated && ` · updated ${lastUpdated.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => void fetchPositions()} disabled={loading}
            className="text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-40">
            <RefreshCw className={clsx('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
          <Link href="/positions" className="flex items-center gap-1 text-xs text-orange-400 hover:text-orange-300 transition-colors">
            View all <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </div>

      {loading && positions.length === 0 ? (
        <div className="flex items-center gap-2 py-4 text-xs text-gray-500">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Loading positions…
        </div>
      ) : positions.length === 0 ? (
        <div className="py-4 text-center text-xs text-gray-500">
          No open positions · <Link href="/positions" className="text-orange-400 hover:underline">Connect accounts</Link>
        </div>
      ) : (
        <div className="space-y-0">
          {top5.map(pos => (
            <div key={pos.id} className="flex items-center justify-between py-2 border-b border-gray-800/60 last:border-0">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[9px] px-1.5 py-0.5 rounded-full font-bold bg-gray-800 text-gray-400 flex-shrink-0">
                  {ACCT_LABELS[pos.account] ?? pos.account}
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-white truncate">{pos.name}</p>
                  <div className="flex items-center gap-1">
                    <span className={clsx('text-[8px] font-bold px-1 rounded',
                      pos.direction === 'BUY' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                    )}>{pos.direction}</span>
                    <span className="text-[10px] text-gray-500">{pos.quantity.toFixed(4)}</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <div className="text-right">
                  <p className={clsx('text-xs font-semibold tabular-nums', pos.pnl >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                    {pos.pnl >= 0 ? '+' : ''}£{Math.abs(pos.pnl).toFixed(2)}
                  </p>
                  <p className={clsx('text-[10px] tabular-nums', pos.pnlPct >= 0 ? 'text-emerald-500' : 'text-red-500')}>
                    {pos.pnlPct >= 0 ? '+' : ''}{pos.pnlPct.toFixed(2)}%
                  </p>
                </div>
                <button onClick={() => void closePos(pos)} disabled={closingId === pos.id}
                  className="text-gray-600 hover:text-red-400 transition-colors disabled:opacity-40 p-1"
                  title="Close position">
                  {closingId === pos.id ? <RefreshCw className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                </button>
              </div>
            </div>
          ))}
          {positions.length > 5 && (
            <div className="pt-2 text-center">
              <Link href="/positions" className="text-[10px] text-gray-500 hover:text-orange-400 transition-colors">
                +{positions.length - 5} more positions → View all
              </Link>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function StatCard({
  label,
  value,
  subtext,
  positive,
  simulated = false,
}: {
  label: string;
  value: string;
  subtext?: string;
  positive?: boolean;
  simulated?: boolean;
}) {
  return (
    <Card>
      <div className="flex items-start justify-between mb-1">
        <span className="text-xs text-gray-500 font-medium uppercase tracking-wide">{label}</span>
        {simulated && (
          <span className="text-xs text-yellow-600 bg-yellow-600/10 px-1.5 py-0.5 rounded text-[10px]">
            SIMULATED
          </span>
        )}
      </div>
      <div
        className={clsx(
          'text-2xl font-bold mt-1',
          positive === true ? 'text-emerald-400' : positive === false ? 'text-red-400' : 'text-white'
        )}
      >
        {value}
      </div>
      {subtext && <p className="text-xs text-gray-500 mt-1">{subtext}</p>}
    </Card>
  );
}

export default function DashboardPage() {
  const {
    t212Positions,
    t212Connected,
    t212AccountType,
    t212AccountInfo,
    t212LastSync,
    t212ApiKey,
    t212ApiSecret,
    autoReinvest,
    setAutoReinvest,
    setT212AccountType,
    setT212Connected,
    setT212LastSync,
    setT212Positions,
    clearT212Credentials,
    signals,
    trades,
    selectedCountry,
    setTrades,
    updateSection104Pools,
  } = useClearGainsStore();

  const [showConnectModal, setShowConnectModal] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncDetail, setSyncDetail] = useState<string | null>(null);

  const portfolioValue = t212Positions.reduce(
    (sum, pos) => sum + pos.currentPrice * pos.quantity,
    0
  );
  const totalPnL = t212Positions.reduce((sum, pos) => sum + pos.ppl, 0);
  const unrealisedGain = totalPnL;

  const nonIsaGain = t212Positions
    .filter((p) => !p.isISA && p.ppl > 0)
    .reduce((sum, p) => sum + p.ppl, 0);
  const cgtEstimate = Math.max(0, nonIsaGain - selectedCountry.aea) * (selectedCountry.cgRates.higher / 100);

  const hasCredentials = !!t212ApiKey && !!t212ApiSecret;

  async function handleSync() {
    if (!hasCredentials) {
      setShowConnectModal(true);
      return;
    }
    setSyncing(true);
    setSyncError(null);
    setSyncDetail(null);
    try {
      const encoded = btoa(t212ApiKey + ':' + t212ApiSecret);
      const res = await fetch('/api/t212/sync', {
        method: 'POST',
        headers: { 'x-t212-auth': encoded },
      });
      const data = await res.json();
      if (data.error) {
        setSyncError(data.error);
      } else {
        setT212Positions(data.positions ?? []);
        setT212LastSync(new Date().toISOString());
        setT212Connected(true);
        if (Array.isArray(data.trades) && data.trades.length > 0) {
          const { trades: existing } = useClearGainsStore.getState();
          const existingIds = new Set(existing.map((t: Trade) => t.id));
          const newTrades = (data.trades as Trade[]).filter((t) => !existingIds.has(t.id));
          if (newTrades.length > 0) {
            const merged = [...existing, ...newTrades];
            setTrades(merged);
            updateSection104Pools(buildSection104Pools(merged));
          }
        }
      }
    } catch (err) {
      setSyncError(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSyncing(false);
    }
  }

  function handleDisconnect() {
    clearT212Credentials();
    setSyncError(null);
    setSyncDetail(null);
  }

  const recentSignals = signals.slice(0, 3);
  const topHoldings = [...t212Positions]
    .sort((a, b) => b.currentPrice * b.quantity - a.currentPrice * a.quantity)
    .slice(0, 5);

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      {showConnectModal && (
        <ConnectModal
          onClose={() => setShowConnectModal(false)}
          onConnected={() => {
            setShowConnectModal(false);
            handleSync();
          }}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="text-sm text-gray-500">
            {selectedCountry.flag} {selectedCountry.name} · {selectedCountry.currency}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <LoadPortfolioButton label="Load Portfolio" size="sm" />
          {t212Connected ? (
            <Badge variant={t212AccountType === 'LIVE' ? 'live' : 'demo'}>
              <Wifi className="h-3 w-3 mr-1" />
              {t212AccountType === 'LIVE' ? 'Live Account' : 'Practice Account'}
            </Badge>
          ) : (
            <Badge variant="default">
              <WifiOff className="h-3 w-3 mr-1" /> Not Synced
            </Badge>
          )}
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard
          label="Portfolio Value"
          value={t212Connected ? formatGBP(portfolioValue) : '£0.00'}
          subtext={t212Connected ? `${t212Positions.length} positions` : 'Connect T212 to view'}
          simulated={!t212Connected}
        />
        <StatCard
          label="Total P&L"
          value={t212Connected ? formatGBP(totalPnL) : '—'}
          subtext="Unrealised gain/loss"
          positive={t212Connected ? totalPnL >= 0 : undefined}
          simulated={!t212Connected}
        />
        <StatCard
          label="Unrealised Gain"
          value={t212Connected ? formatGBP(unrealisedGain) : '—'}
          subtext="Open positions"
          positive={t212Connected ? unrealisedGain >= 0 : undefined}
          simulated={!t212Connected}
        />
        <StatCard
          label="CGT Estimate"
          value={t212Connected ? formatGBP(cgtEstimate) : '—'}
          subtext={`After ${selectedCountry.currencySymbol}${selectedCountry.aea.toLocaleString()} AEA`}
          positive={false}
          simulated={!t212Connected}
        />
      </div>

      {/* Live ticker strip */}
      {topHoldings.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl mb-6 overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800">
            <Zap className="h-3.5 w-3.5 text-emerald-400" />
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">Live Positions</span>
          </div>
          <div className="flex gap-6 px-4 py-3 overflow-x-auto">
            {topHoldings.map((pos) => (
              <div key={pos.ticker} className="flex-shrink-0 flex items-center gap-3">
                <div>
                  <div className="text-sm font-bold text-white">{pos.ticker}</div>
                  <div className="text-xs text-gray-500">{pos.quantity.toFixed(4)} shares</div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-mono text-white">
                    {formatGBP(pos.currentPrice)}
                  </div>
                  <div
                    className={clsx(
                      'text-xs font-medium flex items-center gap-0.5',
                      pos.ppl >= 0 ? 'text-emerald-400' : 'text-red-400'
                    )}
                  >
                    {pos.ppl >= 0 ? (
                      <TrendingUp className="h-3 w-3" />
                    ) : (
                      <TrendingDown className="h-3 w-3" />
                    )}
                    {formatGBP(pos.ppl)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* T212 Sync panel */}
        <Card className="lg:col-span-1">
          <CardHeader
            title="Trading 212 Sync"
            subtitle="Connect your T212 account"
            icon={<Wifi className="h-4 w-4" />}
          />

          {/* Not connected state */}
          {!hasCredentials ? (
            <div className="py-4">
              <p className="text-xs text-gray-500 mb-3">
                Enter your T212 API key and secret to sync your portfolio. Your credentials are stored locally and never sent to our servers.
              </p>
              <Button
                onClick={() => setShowConnectModal(true)}
                fullWidth
                icon={<Key className="h-4 w-4" />}
              >
                Connect Trading 212
              </Button>
            </div>
          ) : (
            <>
              {/* Connected account info */}
              <div className="flex items-center justify-between mb-3 px-3 py-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
                <div>
                  <p className="text-xs font-semibold text-emerald-400">
                    {t212AccountType} account connected
                  </p>
                  {t212AccountInfo && (
                    <p className="text-xs text-emerald-400/70 mt-0.5">
                      ID: {t212AccountInfo.id} · {t212AccountInfo.currency}
                    </p>
                  )}
                </div>
                <ShieldCheck className="h-4 w-4 text-emerald-400 flex-shrink-0" />
              </div>

              {/* Account type toggle */}
              <div className="flex bg-gray-800 rounded-lg p-1 mb-3">
                {(['DEMO', 'LIVE'] as const).map((type) => (
                  <button
                    key={type}
                    onClick={() => {
                      setT212AccountType(type);
                      setSyncError(null);
                      setSyncDetail(null);
                    }}
                    className={clsx(
                      'flex-1 py-1.5 rounded-md text-xs font-semibold transition-colors',
                      t212AccountType === type
                        ? type === 'LIVE'
                          ? 'bg-emerald-600 text-white'
                          : 'bg-amber-600 text-white'
                        : 'text-gray-500 hover:text-gray-300'
                    )}
                  >
                    {type === 'LIVE' ? '🟢 LIVE' : '🟡 DEMO'}
                  </button>
                ))}
              </div>

              {/* Mode description */}
              <div className={clsx(
                'flex items-start gap-2 px-3 py-2 rounded-lg text-xs mb-3',
                t212AccountType === 'LIVE'
                  ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
                  : 'bg-amber-500/10 border border-amber-500/20 text-amber-400'
              )}>
                {t212AccountType === 'LIVE'
                  ? <><ShieldCheck className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" /><span>Connected to live account — real Invest &amp; ISA positions</span></>
                  : <><FlaskConical className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" /><span>Practice account — simulated data only</span></>
                }
              </div>

              {/* Sync error */}
              {syncError && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-xs text-red-400 mb-3">
                  <div className="flex items-start gap-1.5">
                    <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                    <span>{syncError}</span>
                  </div>
                  {syncDetail && (
                    <div className="mt-1.5 font-mono text-[10px] text-red-500/80 break-all">
                      T212: {syncDetail}
                    </div>
                  )}
                </div>
              )}

              {/* Last synced */}
              {t212Connected && t212LastSync && (
                <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-3">
                  <Clock className="h-3 w-3" />
                  Last synced: {new Date(t212LastSync).toLocaleString('en-GB')}
                </div>
              )}

              <div className="flex gap-2">
                <Button
                  onClick={handleDisconnect}
                  variant="outline"
                  size="sm"
                  icon={<LogOut className="h-3.5 w-3.5" />}
                >
                  Disconnect
                </Button>
                <Button
                  onClick={handleSync}
                  loading={syncing}
                  variant="secondary"
                  fullWidth
                  icon={<RefreshCw className="h-4 w-4" />}
                >
                  {t212Connected ? 'Re-sync' : 'Sync Account'}
                </Button>
              </div>
            </>
          )}
        </Card>

        {/* Auto-reinvest toggle */}
        <Card className="lg:col-span-1">
          <CardHeader
            title="Auto-Reinvestment Engine"
            subtitle="Simulate dividend reinvestment"
            icon={<RefreshCw className="h-4 w-4" />}
          />
          <div className="flex items-center justify-between py-2">
            <div>
              <p className="text-sm text-gray-300">Auto-Reinvest Dividends</p>
              <p className="text-xs text-gray-600 mt-0.5">
                Automatically reinvest dividends into the same position
              </p>
            </div>
            <button
              onClick={() => setAutoReinvest(!autoReinvest)}
              className={clsx(
                'flex-shrink-0 transition-colors',
                autoReinvest ? 'text-emerald-400' : 'text-gray-600'
              )}
            >
              {autoReinvest ? (
                <ToggleRight className="h-8 w-8" />
              ) : (
                <ToggleLeft className="h-8 w-8" />
              )}
            </button>
          </div>
          <div
            className={clsx(
              'mt-3 px-3 py-2 rounded-lg text-xs',
              autoReinvest
                ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
                : 'bg-gray-800 text-gray-500'
            )}
          >
            {autoReinvest
              ? 'Auto-reinvestment is ACTIVE. Dividends will be added to your positions.'
              : 'Auto-reinvestment is OFF. Dividends will accumulate as cash.'}
          </div>
          <p className="text-xs text-yellow-600/70 mt-2">
            ⚠ Simulation only — not connected to live trading
          </p>
        </Card>

        {/* Recent signals */}
        <Card className="lg:col-span-1">
          <CardHeader
            title="Recent AI Signals"
            subtitle="Latest scanner results"
            icon={<Zap className="h-4 w-4" />}
            action={
              <Link href="/scanner" className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1">
                View all <ArrowRight className="h-3 w-3" />
              </Link>
            }
          />
          {recentSignals.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-sm text-gray-600">No signals yet.</p>
              <Link href="/scanner" className="text-xs text-blue-400 hover:text-blue-300 mt-1 inline-block">
                Run AI Scanner →
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              {recentSignals.map((signal, i) => (
                <div key={i} className="flex items-center justify-between py-2 border-b border-gray-800 last:border-0">
                  <div>
                    <div className="font-semibold text-white text-sm">{signal.ticker}</div>
                    <div className="text-xs text-gray-500">
                      Risk: {signal.riskScore}/100 · {signal.confidence}% confidence
                    </div>
                  </div>
                  <Badge variant={signal.signal.toLowerCase() as 'buy' | 'sell' | 'hold'}>
                    {signal.signal}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Portfolio holdings table */}
      {t212Positions.length > 0 && (
        <Card className="mt-4">
          <CardHeader
            title="Portfolio Holdings"
            subtitle={`${t212Positions.length} positions · ${t212AccountType} account`}
          />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b border-gray-800">
                  <th className="text-left py-2 pr-4">Ticker</th>
                  <th className="text-right py-2 pr-4">Qty</th>
                  <th className="text-right py-2 pr-4">Avg Price</th>
                  <th className="text-right py-2 pr-4">Current</th>
                  <th className="text-right py-2 pr-4">P&L</th>
                  <th className="text-right py-2">ISA</th>
                </tr>
              </thead>
              <tbody>
                {t212Positions.map((pos) => (
                  <tr key={pos.ticker} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                    <td className="py-2 pr-4 font-semibold text-white">{pos.ticker}</td>
                    <td className="py-2 pr-4 text-right text-gray-300 font-mono text-xs">
                      {pos.quantity.toFixed(4)}
                    </td>
                    <td className="py-2 pr-4 text-right text-gray-300 font-mono text-xs">
                      {formatGBP(pos.averagePrice)}
                    </td>
                    <td className="py-2 pr-4 text-right text-gray-300 font-mono text-xs">
                      {formatGBP(pos.currentPrice)}
                    </td>
                    <td className={clsx('py-2 pr-4 text-right font-mono text-xs', pos.ppl >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                      {formatGBP(pos.ppl)}
                    </td>
                    <td className="py-2 text-right">
                      {pos.isISA
                        ? <span className="text-[10px] text-blue-400 font-medium">📈 ISA — Tax Free</span>
                        : <span className="text-[10px] text-emerald-400 font-medium">💰 CGT tracked</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Live Positions widget */}
      <LivePositionsWidget />

      {/* Tax Year Tracker */}
      <div className="mt-4">
        <TaxYearTracker />
      </div>

      {/* CGT Monitor Widget */}
      <div className="mt-4">
        <CGTMonitorWidget />
      </div>

      {/* Quick actions */}
      {!t212Connected && trades.length === 0 && (
        <Card className="mt-4">
          <div className="text-center py-6">
            <TrendingUp className="h-10 w-10 text-emerald-600 mx-auto mb-3" />
            <h3 className="text-lg font-semibold text-white mb-2">Get Started with ClearGains</h3>
            <p className="text-sm text-gray-400 mb-4 max-w-md mx-auto">
              Connect your Trading 212 account or add trades manually to track your portfolio,
              calculate CGT, and get AI-powered signals.
            </p>
            <div className="flex flex-wrap gap-3 justify-center">
              <Button onClick={() => setShowConnectModal(true)} icon={<Key className="h-4 w-4" />}>
                Connect T212
              </Button>
              <Link href="/ledger">
                <Button variant="secondary">Add Manual Trade</Button>
              </Link>
              <Link href="/scanner">
                <Button variant="outline">Run AI Scanner</Button>
              </Link>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

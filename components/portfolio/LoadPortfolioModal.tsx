'use client';

import { useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw, CheckCircle2, X, AlertCircle, WifiOff, BarChart3 } from 'lucide-react';
import { clsx } from 'clsx';
import { Button } from '@/components/ui/Button';
import { useClearGainsStore } from '@/lib/store';

// ── Snapshot key ──────────────────────────────────────────────────────────────
export const PORTFOLIO_SNAPSHOT_KEY = 'portfolio_snapshot';

// ── Types ─────────────────────────────────────────────────────────────────────

export type T212PortfolioResult = {
  account:  string;
  label:    string;
  color:    string;
  positions: {
    ticker: string; name: string; quantity: number; averagePrice: number;
    currentPrice: number; pnl: number; pnlPct: number; value: number; initialFillDate?: string;
  }[];
  orders:   unknown[];
  cash:     { available: number; total: number; invested: number; ppl: number };
  summary:  { totalValue: number; totalPnL: number; positionCount: number };
};

export type IGPortfolioResult = {
  account: string;
  label:   string;
  color:   string;
  positions: {
    dealId: string; direction: string; size: number; level: number;
    currency: string; stopLevel?: number; limitLevel?: number; createdDate?: string;
    epic: string; instrumentName: string; currentPrice: number; upl: number; uplPct: number;
    accountId?: string; accountType?: string; accountName?: string;
  }[];
  workingOrders: {
    dealId: string; direction: string; size: number; orderLevel: number;
    orderType: string; epic: string; instrumentName: string; createdDate?: string;
    goodTillDate?: string | null;
    accountId?: string; accountType?: string;
  }[];
  activeAccount: {
    balance: number; available: number; deposit: number; profitLoss: number;
    currency: string; accountType: string;
  } | null;
  subAccounts?: { accountId: string; accountName: string; accountType: string; positionCount: number }[];
  summary: { positionCount: number; workingOrders: number; totalUpl: number };
};

export type PortfolioData = {
  t212:      T212PortfolioResult[];
  ig:        IGPortfolioResult[];
  loadedAt:  string;
};

type AccountStatus = 'pending' | 'loading' | 'done' | 'error' | 'skipped';

interface AccountState {
  key:     string;
  label:   string;
  status:  AccountStatus;
  count:   number;
  error?:  string;
  debug?:  string;
}

// ── Hook: load portfolio ──────────────────────────────────────────────────────

export function useLoadPortfolio() {
  const {
    t212ApiKey, t212ApiSecret,
    t212IsaApiKey, t212IsaApiSecret,
    t212DemoApiKey, t212DemoApiSecret,
  } = useClearGainsStore();

  const [open, setOpen]         = useState(false);
  const [loading, setLoading]   = useState(false);
  const [done, setDone]         = useState(false);
  const [accounts, setAccounts] = useState<AccountState[]>([]);
  const [data, setData]         = useState<PortfolioData | null>(null);

  function setStatus(key: string, patch: Partial<AccountState>) {
    setAccounts(prev => prev.map(a => a.key === key ? { ...a, ...patch } : a));
  }

  const load = useCallback(async () => {
    setLoading(true);
    setDone(false);
    setData(null);

    // Read T212 credentials from store (persisted) or localStorage fallback
    function getT212Creds(storeKey: string, storeSecret: string, lsKey: string) {
      if (storeKey && storeSecret) return { key: storeKey, secret: storeSecret };
      try {
        const raw = typeof window !== 'undefined' ? localStorage.getItem(lsKey) : null;
        if (!raw) return null;
        const p = JSON.parse(raw) as { apiKey?: string; apiSecret?: string };
        if (p.apiKey && p.apiSecret) return { key: p.apiKey, secret: p.apiSecret };
      } catch {}
      return null;
    }

    const t212InvestCreds = getT212Creds(t212ApiKey,     t212ApiSecret,    't212_invest_credentials');
    const t212IsaCreds    = getT212Creds(t212IsaApiKey,  t212IsaApiSecret, 't212_isa_credentials');
    const t212DemoCreds   = getT212Creds(t212DemoApiKey, t212DemoApiSecret,'t212_demo_credentials');

    // Read IG credentials from localStorage
    function getIGCreds(envKey: 'demo' | 'live') {
      try {
        const raw = typeof window !== 'undefined'
          ? localStorage.getItem(envKey === 'demo' ? 'ig_demo_credentials' : 'ig_live_credentials')
          : null;
        if (!raw) return null;
        const p = JSON.parse(raw) as { username?: string; password?: string; apiKey?: string };
        if (p.username && p.password && p.apiKey) return p as { username: string; password: string; apiKey: string };
      } catch {}
      return null;
    }

    const igDemoCreds = getIGCreds('demo');
    const igLiveCreds = getIGCreds('live');

    const accountDefs: AccountState[] = [
      { key: 'T212_INVEST', label: 'T212 Invest', status: t212InvestCreds ? 'pending' : 'skipped', count: 0 },
      { key: 'T212_ISA',    label: 'T212 ISA',    status: t212IsaCreds    ? 'pending' : 'skipped', count: 0 },
      { key: 'T212_DEMO',   label: 'T212 Demo',   status: t212DemoCreds   ? 'pending' : 'skipped', count: 0 },
      { key: 'IG_DEMO',     label: 'IG Demo',     status: igDemoCreds     ? 'pending' : 'skipped', count: 0 },
      { key: 'IG_LIVE',     label: 'IG Live',     status: igLiveCreds     ? 'pending' : 'skipped', count: 0 },
    ];
    setAccounts(accountDefs);

    const t212Results:  T212PortfolioResult[] = [];
    const igResults:    IGPortfolioResult[]   = [];

    // T212 fetch helper
    async function fetchT212(key: string, secret: string, accountKey: string, label: string, color: string, env: string) {
      setStatus(accountKey, { status: 'loading', debug: `Connecting to ${label}…` });
      try {
        const r = await fetch('/api/portfolio/t212', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ encoded: btoa(key + ':' + secret), env }),
        });
        const d = await r.json() as T212PortfolioResult & { ok: boolean; error?: string };
        if (!d.ok) throw new Error(d.error ?? 'Fetch failed');
        const result: T212PortfolioResult = { account: accountKey, label, color, positions: d.positions, orders: d.orders, cash: d.cash, summary: d.summary };
        t212Results.push(result);
        setStatus(accountKey, { status: 'done', count: d.summary.positionCount, debug: undefined });
      } catch (e) {
        setStatus(accountKey, { status: 'error', error: e instanceof Error ? e.message : String(e), debug: undefined });
      }
    }

    // IG fetch helper — fresh auth every time, fetches all sub-accounts
    async function fetchIG(envKey: 'demo' | 'live', accountKey: string, label: string, color: string, creds: { username: string; password: string; apiKey: string }) {
      try {
        setStatus(accountKey, { status: 'loading', debug: `Authenticating with ${label}…` });
        const sessionRes = await fetch('/api/ig/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: creds.username, password: creds.password, apiKey: creds.apiKey, env: envKey, forceRefresh: true }),
        });
        const sessD = await sessionRes.json() as { ok: boolean; cst?: string; securityToken?: string; error?: string };
        if (!sessD.ok || !sessD.cst) {
          setStatus(accountKey, { status: 'error', error: sessD.error ?? 'Authentication failed', debug: undefined });
          return;
        }

        setStatus(accountKey, { status: 'loading', debug: `Fetching all sub-accounts from ${label}…` });
        const r = await fetch('/api/portfolio/ig', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: creds.apiKey, cst: sessD.cst, securityToken: sessD.securityToken, env: envKey }),
        });
        const d = await r.json() as IGPortfolioResult & {
          ok: boolean; error?: string;
          accounts?: { accountId: string; accountName: string; accountType: string; preferred: boolean; balance: { balance: number; available: number; deposit: number; profitLoss: number }; currency: string }[];
        };
        if (!d.ok) throw new Error(d.error ?? 'Fetch failed');

        // Build per-sub-account position counts
        const subAccountMap = new Map<string, { accountId: string; accountName: string; accountType: string; positionCount: number }>();
        (d.accounts ?? []).forEach(acc => {
          subAccountMap.set(acc.accountId, { accountId: acc.accountId, accountName: acc.accountName, accountType: acc.accountType, positionCount: 0 });
        });
        (d.positions ?? []).forEach(pos => {
          if (pos.accountId) {
            const entry = subAccountMap.get(pos.accountId);
            if (entry) entry.positionCount++;
          }
        });

        const result: IGPortfolioResult = {
          account: accountKey,
          label,
          color,
          positions:     d.positions,
          workingOrders: d.workingOrders,
          activeAccount: d.activeAccount,
          subAccounts:   Array.from(subAccountMap.values()),
          summary:       d.summary,
        };
        igResults.push(result);
        setStatus(accountKey, { status: 'done', count: d.summary.positionCount, debug: undefined });
      } catch (e) {
        setStatus(accountKey, { status: 'error', error: e instanceof Error ? e.message : String(e), debug: undefined });
      }
    }

    await Promise.all([
      t212InvestCreds ? fetchT212(t212InvestCreds.key, t212InvestCreds.secret, 'T212_INVEST', 'T212 Invest', 'text-emerald-400', 'live') : Promise.resolve(),
      t212IsaCreds    ? fetchT212(t212IsaCreds.key,    t212IsaCreds.secret,    'T212_ISA',    'T212 ISA',    'text-blue-400',    'live') : Promise.resolve(),
      t212DemoCreds   ? fetchT212(t212DemoCreds.key,   t212DemoCreds.secret,   'T212_DEMO',   'T212 Demo',   'text-purple-400',  'demo') : Promise.resolve(),
      igDemoCreds     ? fetchIG('demo', 'IG_DEMO', 'IG Demo', 'text-orange-400', igDemoCreds) : Promise.resolve(),
      igLiveCreds     ? fetchIG('live', 'IG_LIVE', 'IG Live', 'text-amber-400',  igLiveCreds) : Promise.resolve(),
    ]);

    const portfolioData: PortfolioData = {
      t212:     t212Results,
      ig:       igResults,
      loadedAt: new Date().toISOString(),
    };
    setData(portfolioData);

    try {
      localStorage.setItem(PORTFOLIO_SNAPSHOT_KEY, JSON.stringify(portfolioData));
    } catch {}

    setLoading(false);
    setDone(true);
  }, [
    t212ApiKey, t212ApiSecret,
    t212IsaApiKey, t212IsaApiSecret,
    t212DemoApiKey, t212DemoApiSecret,
  ]);

  function openModal() { setOpen(true); void load(); }
  function closeModal() { setOpen(false); }

  const totalPositions = accounts.reduce((s, a) => s + a.count, 0);
  const connectedCount = accounts.filter(a => a.status !== 'skipped').length;

  return { open, openModal, closeModal, loading, done, accounts, data, totalPositions, connectedCount, reload: load };
}

// ── Portal wrapper (SSR-safe) ─────────────────────────────────────────────────

function ModalPortal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;
  return createPortal(children, document.body);
}

// ── Modal component ───────────────────────────────────────────────────────────

interface Props {
  open:           boolean;
  onClose:        () => void;
  loading:        boolean;
  done:           boolean;
  accounts:       AccountState[];
  data:           PortfolioData | null;
  totalPositions: number;
  connectedCount: number;
  onReload:       () => void;
}

function StatusIcon({ status }: { status: AccountStatus }) {
  if (status === 'loading') return <RefreshCw className="h-3.5 w-3.5 text-blue-400 animate-spin" />;
  if (status === 'done')    return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
  if (status === 'error')   return <AlertCircle className="h-3.5 w-3.5 text-red-400" />;
  if (status === 'skipped') return <WifiOff className="h-3.5 w-3.5 text-gray-600" />;
  return <span className="h-3.5 w-3.5 rounded-full border border-gray-700 inline-block" />;
}

function AccountTypeBadge({ type }: { type?: string }) {
  if (!type) return null;
  const label = type === 'SPREADBET' ? 'Spread Bet' : type === 'CFD' ? 'CFD' : type === 'SHARES' ? 'Shares' : type;
  const cls   = type === 'SPREADBET'
    ? 'bg-purple-500/15 text-purple-400 border-purple-500/25'
    : type === 'CFD'
    ? 'bg-blue-500/15 text-blue-400 border-blue-500/25'
    : 'bg-gray-700 text-gray-400 border-gray-600';
  return (
    <span className={clsx('text-[8px] px-1.5 py-0.5 rounded border font-medium', cls)}>{label}</span>
  );
}

export function LoadPortfolioModal({ open, onClose, loading, done, accounts, data, totalPositions, connectedCount, onReload }: Props) {
  if (!open) return null;

  const panel = (
    <div
      className="fixed inset-0 z-[9999] flex items-start justify-center bg-black/75 px-4 overflow-y-auto"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-md shadow-2xl mt-[80px] mb-8"
        style={{ maxHeight: 'calc(100vh - 120px)', overflowY: 'auto' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-orange-500/20 flex items-center justify-center flex-shrink-0">
              <BarChart3 className="h-4 w-4 text-orange-400" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">Load Portfolio</h3>
              <p className="text-[10px] text-gray-500">
                {loading ? 'Fetching from connected accounts…' : done ? 'Portfolio loaded' : 'Ready to sync'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="ml-4 flex-shrink-0 text-gray-500 hover:text-white transition-colors p-1 rounded-lg hover:bg-gray-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Account progress list */}
        <div className="space-y-2 mb-4">
          {accounts.map(a => (
            <div key={a.key} className={clsx(
              'flex items-start gap-3 px-3 py-2 rounded-lg border text-xs',
              a.status === 'done'    ? 'bg-emerald-500/5 border-emerald-500/15' :
              a.status === 'loading' ? 'bg-blue-500/5 border-blue-500/20' :
              a.status === 'error'   ? 'bg-red-500/5 border-red-500/15' :
              a.status === 'skipped' ? 'bg-gray-800/30 border-gray-800' :
              'bg-gray-800/20 border-gray-800'
            )}>
              <div className="mt-0.5 flex-shrink-0">
                <StatusIcon status={a.status} />
              </div>
              <div className="flex-1 min-w-0">
                <span className={clsx('font-medium',
                  a.status === 'done'    ? 'text-emerald-400' :
                  a.status === 'loading' ? 'text-blue-400' :
                  a.status === 'error'   ? 'text-red-400' :
                  a.status === 'skipped' ? 'text-gray-600' : 'text-gray-500'
                )}>{a.label}</span>
                {a.status === 'loading' && a.debug && (
                  <p className="text-[10px] text-blue-400/70 truncate mt-0.5">{a.debug}</p>
                )}
                {a.status === 'error' && a.error && (
                  <p className="text-[10px] text-red-400/70 truncate mt-0.5">{a.error}</p>
                )}
                {/* Show IG sub-account breakdown when done */}
                {a.status === 'done' && (a.key === 'IG_DEMO' || a.key === 'IG_LIVE') && data && (() => {
                  const igResult = data.ig.find(r => r.account === a.key);
                  if (!igResult?.subAccounts?.length) return null;
                  const withPositions = igResult.subAccounts.filter(s => s.positionCount > 0);
                  if (!withPositions.length) return null;
                  return (
                    <div className="mt-1 space-y-0.5">
                      {withPositions.map(sub => (
                        <div key={sub.accountId} className="flex items-center gap-1.5 text-[10px] text-gray-400">
                          <AccountTypeBadge type={sub.accountType} />
                          <span className="truncate">{sub.accountName}</span>
                          <span className="text-emerald-400 flex-shrink-0">{sub.positionCount} pos</span>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
              <span className={clsx('text-[10px] flex-shrink-0 mt-0.5',
                a.status === 'done'    ? 'text-emerald-400' :
                a.status === 'skipped' ? 'text-gray-600' : 'text-gray-500'
              )}>
                {a.status === 'done'    ? `${a.count} position${a.count !== 1 ? 's' : ''}` :
                 a.status === 'loading' ? 'loading…' :
                 a.status === 'skipped' ? 'not connected' :
                 a.status === 'error'   ? 'error' : 'waiting'}
              </span>
            </div>
          ))}
        </div>

        {/* Summary */}
        {done && (
          <div className="bg-gray-800/60 border border-gray-700 rounded-lg px-4 py-3 mb-4 text-center">
            <p className="text-sm font-bold text-white">
              {totalPositions > 0
                ? `Portfolio loaded — ${totalPositions} position${totalPositions !== 1 ? 's' : ''} across ${connectedCount} account${connectedCount !== 1 ? 's' : ''}`
                : 'No open positions found across connected accounts'}
            </p>
            {data && (
              <p className="text-[10px] text-gray-500 mt-1">
                Synced at {new Date(data.loadedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </p>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2">
          {done ? (
            <>
              <Button fullWidth variant="outline" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={onReload} loading={loading}>
                Reload
              </Button>
              <Button fullWidth onClick={onClose}>
                View Positions
              </Button>
            </>
          ) : loading ? (
            <Button fullWidth variant="outline" disabled icon={<RefreshCw className="h-3.5 w-3.5 animate-spin" />}>
              Loading…
            </Button>
          ) : (
            <Button fullWidth onClick={onClose} variant="outline">Close</Button>
          )}
        </div>
      </div>
    </div>
  );

  return <ModalPortal>{panel}</ModalPortal>;
}

// ── Trigger button ────────────────────────────────────────────────────────────

interface TriggerProps {
  size?:    'sm' | 'md';
  variant?: 'button' | 'icon';
  label?:   string;
  className?: string;
}

export function LoadPortfolioButton({ size = 'sm', variant = 'button', label = 'Load Portfolio', className }: TriggerProps) {
  const hook = useLoadPortfolio();

  return (
    <>
      {variant === 'icon' ? (
        <button
          onClick={hook.openModal}
          title="Load Portfolio"
          className={clsx('flex items-center justify-center p-1.5 rounded-lg text-gray-400 hover:text-orange-400 hover:bg-orange-500/10 transition-colors', className)}
        >
          <BarChart3 className="h-4 w-4" />
        </button>
      ) : (
        <Button
          size={size}
          variant="outline"
          icon={<BarChart3 className="h-3.5 w-3.5" />}
          onClick={hook.openModal}
          className={clsx('border-orange-500/30 text-orange-400 hover:border-orange-500/60', className)}
        >
          {label}
        </Button>
      )}
      <LoadPortfolioModal
        open={hook.open}
        onClose={hook.closeModal}
        loading={hook.loading}
        done={hook.done}
        accounts={hook.accounts}
        data={hook.data}
        totalPositions={hook.totalPositions}
        connectedCount={hook.connectedCount}
        onReload={hook.reload}
      />
    </>
  );
}

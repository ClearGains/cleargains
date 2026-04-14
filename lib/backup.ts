'use client';

export const BACKUP_VERSION = '1.0';

// Credentials and ephemeral fields to exclude from export
const EXCLUDED_KEYS = new Set([
  't212ApiKey', 't212ApiSecret',
  't212DemoApiKey', 't212DemoApiSecret',
  't212IsaApiKey', 't212IsaApiSecret',
  't212Connected', 't212DemoConnected', 't212IsaConnected',
  'cgtAlerts', 'taxMonitorLastPoll', 'taxMonitorLivePositions',
  'fxRates', 'fxRatesLastFetched',
  'pendingSignalCount', 'signals', 'scanHistory',
]);

// Mirrors constants in demo-trader/page.tsx
const PORTFOLIO_LIST_KEY = 'demo_portfolios';
const ACTIVE_PORTFOLIO_KEY = 'active_portfolio_id';
function portfolioKey(id: string, suffix: string) {
  return `portfolio_${id}_${suffix}`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PortfolioBackup {
  ids: string[];
  activeId: string | null;
  metas: Record<string, unknown>;
  positions: Record<string, unknown[]>;
  trades: Record<string, unknown[]>;
  budgets: Record<string, number>;
}

export interface BackupData {
  store: Record<string, unknown>;
  portfolios: PortfolioBackup;
  manualStocks: unknown[];
  pendingOrders: unknown[];
  customTradeAmount: string | null;
  fx: {
    history: unknown[];
    budget: number | null;
    autoPairs: unknown;
    globalAuto: boolean;
  };
  paperLegacy: {
    positions: unknown[];
    trades: unknown[];
    budget: number | null;
  };
}

export interface BackupFile {
  version: string;
  exportedAt: string;
  device: string;
  data: BackupData;
}

export interface ImportResult {
  portfoliosRestored: number;
  message: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function lsGet<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v != null ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function lsSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

// ── Export ────────────────────────────────────────────────────────────────────

export function exportData(): BackupFile {
  // Main Zustand store — strip sensitive / ephemeral fields
  const rawStore = lsGet<Record<string, unknown>>('cleargains-storage', {});
  const storeState = (rawStore.state ?? {}) as Record<string, unknown>;
  const filteredStore: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(storeState)) {
    if (!EXCLUDED_KEYS.has(k)) filteredStore[k] = v;
  }

  // Portfolio system
  const ids = lsGet<string[]>(PORTFOLIO_LIST_KEY, []);
  const activeId = localStorage.getItem(ACTIVE_PORTFOLIO_KEY);
  const metas: Record<string, unknown> = {};
  const positions: Record<string, unknown[]> = {};
  const trades: Record<string, unknown[]> = {};
  const budgets: Record<string, number> = {};

  for (const id of ids) {
    metas[id] = lsGet<unknown>(portfolioKey(id, 'meta'), null);
    positions[id] = lsGet<unknown[]>(portfolioKey(id, 'positions'), []);
    trades[id] = lsGet<unknown[]>(portfolioKey(id, 'trades'), []);
    const b = lsGet<number | null>(portfolioKey(id, 'budget'), null);
    if (b !== null) budgets[id] = b;
  }

  return {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    device: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    data: {
      store: filteredStore,
      portfolios: { ids, activeId, metas, positions, trades, budgets },
      manualStocks: lsGet<unknown[]>('manual_strategy_stocks', []),
      pendingOrders: lsGet<unknown[]>('pending_orders', []),
      customTradeAmount: localStorage.getItem('custom_trade_amount'),
      fx: {
        history: lsGet<unknown[]>('fx_rate_history', []),
        budget: lsGet<number | null>('fx_budget', null),
        autoPairs: lsGet<unknown>('fx_auto_pairs', {}),
        globalAuto: lsGet<boolean>('fx_global_auto', false),
      },
      paperLegacy: {
        positions: lsGet<unknown[]>('paper_positions', []),
        trades: lsGet<unknown[]>('paper_trades', []),
        budget: lsGet<number | null>('paper_budget', null),
      },
    },
  };
}

// ── Summary ───────────────────────────────────────────────────────────────────

export function getBackupSummary(backup: BackupFile): string {
  const { data } = backup;
  const portfolioCount = data.portfolios.ids.length;
  const paperTradeCount = Object.values(data.portfolios.trades).reduce(
    (s, t) => s + t.length,
    0,
  );
  const watchlistCount =
    (data.store.watchlist as string[] | undefined)?.length ?? 0;
  const cgtCount = (data.store.trades as unknown[] | undefined)?.length ?? 0;
  const fxCount = (data.store.fxTrades as unknown[] | undefined)?.length ?? 0;
  const manualCount = data.manualStocks.length;
  const pendingCount = data.pendingOrders.length;

  const parts: string[] = [];
  if (portfolioCount > 0)
    parts.push(`${portfolioCount} portfolio${portfolioCount !== 1 ? 's' : ''}`);
  if (paperTradeCount > 0)
    parts.push(
      `${paperTradeCount} paper trade${paperTradeCount !== 1 ? 's' : ''}`,
    );
  if (cgtCount > 0)
    parts.push(`${cgtCount} CGT trade${cgtCount !== 1 ? 's' : ''}`);
  if (fxCount > 0)
    parts.push(`${fxCount} FX trade${fxCount !== 1 ? 's' : ''}`);
  if (watchlistCount > 0)
    parts.push(`${watchlistCount} watchlist stock${watchlistCount !== 1 ? 's' : ''}`);
  if (manualCount > 0)
    parts.push(`${manualCount} manual stock${manualCount !== 1 ? 's' : ''}`);
  if (pendingCount > 0)
    parts.push(`${pendingCount} pending order${pendingCount !== 1 ? 's' : ''}`);

  return parts.length > 0
    ? `Found: ${parts.join(', ')}`
    : 'Empty backup (no data found)';
}

// ── Import ────────────────────────────────────────────────────────────────────

export function importData(
  backup: BackupFile,
  mode: 'merge' | 'replace',
): ImportResult {
  const { data } = backup;

  // Helper — preserve current API keys & ephemeral fields when merging store
  const currentRaw = lsGet<Record<string, unknown>>('cleargains-storage', {});
  const currentState = (currentRaw.state ?? {}) as Record<string, unknown>;

  if (mode === 'replace') {
    // Merge imported store state but keep current credentials
    const mergedState: Record<string, unknown> = { ...data.store };
    for (const key of EXCLUDED_KEYS) {
      if (currentState[key] !== undefined) mergedState[key] = currentState[key];
    }
    lsSet('cleargains-storage', { ...currentRaw, state: mergedState });

    // Portfolios
    lsSet(PORTFOLIO_LIST_KEY, data.portfolios.ids);
    if (data.portfolios.activeId) {
      localStorage.setItem(ACTIVE_PORTFOLIO_KEY, data.portfolios.activeId);
    }
    for (const id of data.portfolios.ids) {
      if (data.portfolios.metas[id])
        lsSet(portfolioKey(id, 'meta'), data.portfolios.metas[id]);
      lsSet(portfolioKey(id, 'positions'), data.portfolios.positions[id] ?? []);
      lsSet(portfolioKey(id, 'trades'), data.portfolios.trades[id] ?? []);
      if (data.portfolios.budgets[id] !== undefined)
        lsSet(portfolioKey(id, 'budget'), data.portfolios.budgets[id]);
    }

    // Misc
    lsSet('manual_strategy_stocks', data.manualStocks);
    lsSet('pending_orders', data.pendingOrders);
    if (data.customTradeAmount != null)
      localStorage.setItem('custom_trade_amount', data.customTradeAmount);
    lsSet('fx_rate_history', data.fx.history);
    if (data.fx.budget !== null) lsSet('fx_budget', data.fx.budget);
    lsSet('fx_auto_pairs', data.fx.autoPairs);
    lsSet('fx_global_auto', data.fx.globalAuto);
    lsSet('paper_positions', data.paperLegacy.positions);
    lsSet('paper_trades', data.paperLegacy.trades);
    if (data.paperLegacy.budget !== null)
      lsSet('paper_budget', data.paperLegacy.budget);

    const n = data.portfolios.ids.length;
    return {
      portfoliosRestored: n,
      message: `Import complete — ${n} portfolio${n !== 1 ? 's' : ''} restored`,
    };
  } else {
    // ── Merge mode ────────────────────────────────────────────────────────────

    type WithId = { id: string };
    function mergeById<T extends WithId>(current: T[], incoming: T[]): T[] {
      const existingIds = new Set(current.map((x) => x.id));
      return [...current, ...incoming.filter((x) => !existingIds.has(x.id))];
    }

    const imp = data.store;

    const mergedState: Record<string, unknown> = {
      ...currentState,
      // Merge arrays by ID
      trades: mergeById(
        (currentState.trades as WithId[] | undefined) ?? [],
        (imp.trades as WithId[] | undefined) ?? [],
      ),
      demoPositions: mergeById(
        (currentState.demoPositions as WithId[] | undefined) ?? [],
        (imp.demoPositions as WithId[] | undefined) ?? [],
      ),
      demoTrades: mergeById(
        (currentState.demoTrades as WithId[] | undefined) ?? [],
        (imp.demoTrades as WithId[] | undefined) ?? [],
      ),
      fxPositions: mergeById(
        (currentState.fxPositions as WithId[] | undefined) ?? [],
        (imp.fxPositions as WithId[] | undefined) ?? [],
      ),
      fxTrades: mergeById(
        (currentState.fxTrades as WithId[] | undefined) ?? [],
        (imp.fxTrades as WithId[] | undefined) ?? [],
      ),
      taxTrades: mergeById(
        (currentState.taxTrades as WithId[] | undefined) ?? [],
        (imp.taxTrades as WithId[] | undefined) ?? [],
      ),
      // Union watchlist
      watchlist: [
        ...new Set([
          ...((currentState.watchlist as string[] | undefined) ?? []),
          ...((imp.watchlist as string[] | undefined) ?? []),
        ]),
      ],
      // Merge section104Pools (imported values fill gaps in current)
      section104Pools: {
        ...((imp.section104Pools as object) ?? {}),
        ...((currentState.section104Pools as object) ?? {}),
      },
      // Carry-forward losses: take the higher value
      carriedForwardLosses: Math.max(
        (currentState.carriedForwardLosses as number) ?? 0,
        (imp.carriedForwardLosses as number) ?? 0,
      ),
    };

    lsSet('cleargains-storage', { ...currentRaw, state: mergedState });

    // Merge portfolios — only add IDs not already present
    const currentIds = lsGet<string[]>(PORTFOLIO_LIST_KEY, []);
    const newIds = data.portfolios.ids.filter((id) => !currentIds.includes(id));
    if (newIds.length > 0) {
      lsSet(PORTFOLIO_LIST_KEY, [...currentIds, ...newIds]);
      for (const id of newIds) {
        if (data.portfolios.metas[id])
          lsSet(portfolioKey(id, 'meta'), data.portfolios.metas[id]);
        lsSet(portfolioKey(id, 'positions'), data.portfolios.positions[id] ?? []);
        lsSet(portfolioKey(id, 'trades'), data.portfolios.trades[id] ?? []);
        if (data.portfolios.budgets[id] !== undefined)
          lsSet(portfolioKey(id, 'budget'), data.portfolios.budgets[id]);
      }
    }

    // Merge manual stocks by symbol
    type WithSymbol = { symbol: string };
    const currentManual = lsGet<WithSymbol[]>('manual_strategy_stocks', []);
    const importedManual = (data.manualStocks as WithSymbol[]).filter(
      (s) => !currentManual.some((c) => c.symbol === s.symbol),
    );
    lsSet('manual_strategy_stocks', [...currentManual, ...importedManual]);

    // Merge pending orders by ID
    const currentPending = lsGet<WithId[]>('pending_orders', []);
    const importedPending = (data.pendingOrders as WithId[]).filter(
      (o) => !currentPending.some((c) => c.id === o.id),
    );
    lsSet('pending_orders', [...currentPending, ...importedPending]);

    const n = newIds.length;
    return {
      portfoliosRestored: n,
      message: `Import complete — ${n} new portfolio${n !== 1 ? 's' : ''} added`,
    };
  }
}

// ── Backup date helpers ───────────────────────────────────────────────────────

const LS_LAST_BACKUP = 'last_backup_date';
const LS_LAST_IMPORT = 'last_import_date';
const LS_BANNER_DISMISSED = 'backup_banner_dismissed_until';

export function getLastBackupDate(): string | null {
  return localStorage.getItem(LS_LAST_BACKUP);
}

export function getLastImportDate(): string | null {
  return localStorage.getItem(LS_LAST_IMPORT);
}

export function recordBackup(): void {
  localStorage.setItem(LS_LAST_BACKUP, new Date().toISOString());
}

export function recordImport(): void {
  localStorage.setItem(LS_LAST_IMPORT, new Date().toISOString());
}

/** Returns true if the reminder banner should be shown. */
export function shouldShowBackupReminder(): boolean {
  const dismissedUntil = localStorage.getItem(LS_BANNER_DISMISSED);
  if (dismissedUntil && new Date(dismissedUntil) > new Date()) return false;

  const lastBackup = localStorage.getItem(LS_LAST_BACKUP);
  if (!lastBackup) return true; // never backed up

  const daysSince =
    (Date.now() - new Date(lastBackup).getTime()) / (1000 * 60 * 60 * 24);
  return daysSince > 7;
}

export function dismissBackupReminder(): void {
  const until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  localStorage.setItem(LS_BANNER_DISMISSED, until);
}

export function daysSinceBackup(): number | null {
  const last = localStorage.getItem(LS_LAST_BACKUP);
  if (!last) return null;
  return Math.floor((Date.now() - new Date(last).getTime()) / (1000 * 60 * 60 * 24));
}

export function formatBackupDate(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

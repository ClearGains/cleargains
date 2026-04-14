'use client';

/**
 * SyncService — headless background component that keeps Redis in sync with
 * localStorage / Zustand state.
 *
 * Responsibilities:
 *  1. Migration: on first load, upload existing localStorage data to Redis.
 *  2. Cross-device load: if localStorage is empty, pull data from Redis.
 *  3. Ongoing sync: debounced subscriptions to Zustand store changes
 *     (watchlist, CGT history, FX positions/trades) → POST to API routes.
 */

import { useEffect, useRef } from 'react';
import { useClearGainsStore } from '@/lib/store';
import { useSyncContext } from '@/lib/syncContext';

// ── Helpers ────────────────────────────────────────────────────────────────────
const JSON_HEADERS = { 'Content-Type': 'application/json' };

function dbPost(path: string, body: unknown): Promise<void> {
  return fetch(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) })
    .then(() => {})
    .catch(err => console.warn('[SyncService]', path, err));
}

function makeDebounced<T>(fn: (val: T) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout>;
  return (val: T) => { clearTimeout(timer); timer = setTimeout(() => fn(val), ms); };
}

// ── Portfolio localStorage helpers (mirrors demo-trader/page.tsx) ─────────────
const PORTFOLIO_LIST_KEY   = 'demo_portfolios';
const ACTIVE_PORTFOLIO_KEY = 'active_portfolio_id';

function lsGet<T>(key: string): T | null {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) as T : null; } catch { return null; }
}

function portfolioKey(id: string, suffix: string) { return `portfolio_${id}_${suffix}`; }

// ── Main service ───────────────────────────────────────────────────────────────
export function SyncService() {
  const { setSyncing, setSynced, setError, setMigrationMessage, setReconnectNotice } = useSyncContext();
  const migratedRef = useRef(false);

  // ── 1. Migration & cross-device load on mount ──────────────────────────────
  useEffect(() => {
    if (migratedRef.current) return;
    migratedRef.current = true;

    (async () => {
      try {
        // Check if migration already done in Redis
        const mRes  = await fetch('/api/db/migrate');
        const mData = await mRes.json() as { done: boolean };

        if (!mData.done) {
          // Migration needed — collect all localStorage data and upload to Redis
          const portfolioIds: string[] = lsGet<string[]>(PORTFOLIO_LIST_KEY) ?? [];
          const activeId: string | null = localStorage.getItem(ACTIVE_PORTFOLIO_KEY);
          const zustandRaw = lsGet<Record<string, unknown>>('cleargains-storage');
          const zustandState = (zustandRaw?.state ?? {}) as Record<string, unknown>;

          const hasData =
            portfolioIds.length > 0 ||
            (zustandState.watchlist as unknown[])?.length > 0 ||
            (zustandState.trades   as unknown[])?.length > 0;

          if (hasData) {
            setSyncing();

            const portfolioData: Record<string, { positions?: unknown[]; trades?: unknown[]; budget?: number | null; settings?: unknown }> = {};
            const portfolioMetas: unknown[] = [];

            for (const id of portfolioIds) {
              const meta      = lsGet<unknown>(portfolioKey(id, 'meta'));
              const positions = lsGet<unknown[]>(portfolioKey(id, 'positions')) ?? [];
              const trades    = lsGet<unknown[]>(portfolioKey(id, 'trades')) ?? [];
              const budget    = lsGet<number>(portfolioKey(id, 'budget'));
              if (meta) portfolioMetas.push(meta);
              portfolioData[id] = { positions, trades, budget, settings: meta };
            }

            await fetch('/api/db/migrate', {
              method: 'POST',
              headers: JSON_HEADERS,
              body: JSON.stringify({
                portfolios:       portfolioMetas,
                activePortfolioId: activeId,
                portfolioData,
                watchlist:  (zustandState.watchlist  as string[])  ?? [],
                cgtHistory: (zustandState.taxTrades  as unknown[]) ?? [],
                fxPositions:(zustandState.fxPositions as unknown[]) ?? [],
                fxTrades:   (zustandState.fxTrades    as unknown[]) ?? [],
                manualStocks: lsGet<unknown[]>('manual_strategy_stocks') ?? [],
                pendingOrders: lsGet<unknown[]>('pending_orders') ?? [],
              }),
            });

            setSynced();
            setMigrationMessage('Your data has been migrated to cloud storage — now syncs across all devices');
            setTimeout(() => setMigrationMessage(null), 8_000);
          } else {
            // No local data — try loading from Redis (new device / cleared browser)
            await loadFromRedis();
          }
        } else {
          // Migration done — check if localStorage needs populating (new device)
          const portfolioIds = lsGet<string[]>(PORTFOLIO_LIST_KEY) ?? [];
          if (portfolioIds.length === 0) {
            await loadFromRedis();
          }
        }
      } catch (err) {
        console.error('[SyncService] mount sync failed', err);
        setError();
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 2. Cross-device load ────────────────────────────────────────────────────
  async function loadFromRedis() {
    setSyncing();
    try {
      const [portfoliosRes, activeRes, watchlistRes, cgtRes, manualRes, pendingRes] = await Promise.all([
        fetch('/api/db/portfolios').then(r => r.json()),
        fetch('/api/db/active-portfolio').then(r => r.json()),
        fetch('/api/db/watchlist').then(r => r.json()),
        fetch('/api/db/cgt').then(r => r.json()),
        fetch('/api/db/manual-stocks').then(r => r.json()),
        fetch('/api/db/pending-orders').then(r => r.json()),
      ]) as [unknown[], { id: string | null }, string[], unknown[], unknown[], unknown[]];

      // Restore portfolios to localStorage
      if (Array.isArray(portfoliosRes) && portfoliosRes.length > 0) {
        const ids = (portfoliosRes as Array<{ id: string }>).map(p => p.id);
        localStorage.setItem(PORTFOLIO_LIST_KEY, JSON.stringify(ids));
        if (activeRes.id) localStorage.setItem(ACTIVE_PORTFOLIO_KEY, activeRes.id);

        // For each portfolio, fetch and restore positions/trades/budget
        for (const meta of portfoliosRes as Array<{ id: string }>) {
          localStorage.setItem(portfolioKey(meta.id, 'meta'), JSON.stringify(meta));
          const [pos, trades, budget] = await Promise.all([
            fetch(`/api/db/positions/${meta.id}`).then(r => r.json()),
            fetch(`/api/db/trades/${meta.id}`).then(r => r.json()),
            fetch(`/api/db/budget/${meta.id}`).then(r => r.json()),
          ]);
          localStorage.setItem(portfolioKey(meta.id, 'positions'), JSON.stringify(pos));
          localStorage.setItem(portfolioKey(meta.id, 'trades'),    JSON.stringify(trades));
          if ((budget as { amount: number }).amount) {
            localStorage.setItem(portfolioKey(meta.id, 'budget'), JSON.stringify((budget as { amount: number }).amount));
          }
        }

        // Restore Zustand-managed state
        const store = useClearGainsStore.getState();
        if (Array.isArray(watchlistRes) && watchlistRes.length > 0) {
          store.setTrades([]); // will be repopulated by cgt
          watchlistRes.forEach(t => store.addToWatchlist(t as string));
        }
        if (Array.isArray(cgtRes) && cgtRes.length > 0) {
          // Restore taxTrades — use setTrades-like approach
          store.clearTaxTrades();
          (cgtRes as Array<Parameters<typeof store.addTaxTrade>[0]>).forEach(t => store.addTaxTrade(t));
        }

        // Restore manual stocks and pending orders to localStorage
        if (Array.isArray(manualRes) && manualRes.length > 0) {
          localStorage.setItem('manual_strategy_stocks', JSON.stringify(manualRes));
        }
        if (Array.isArray(pendingRes) && pendingRes.length > 0) {
          localStorage.setItem('pending_orders', JSON.stringify(pendingRes));
        }

        setMigrationMessage('Data loaded from cloud — synced across devices');
        setTimeout(() => setMigrationMessage(null), 5_000);

        // ── Welcome back: portfolios loaded but T212 keys not present ───────────
        const hasT212 = store.t212Connected || store.t212DemoConnected || store.t212IsaConnected;
        if (!hasT212) {
          // Check if encrypted keys are stored — if so, offer to decrypt
          const encRes = await fetch('/api/db/encrypted-keys').catch(() => null);
          const encData = encRes ? await encRes.json().catch(() => null) : null;
          if (encData && (encData.live || encData.isa || encData.demo)) {
            setReconnectNotice('encrypted');
          } else {
            setReconnectNotice('manual');
          }
        }
      }
      setSynced();
    } catch (err) {
      console.error('[SyncService] loadFromRedis failed', err);
      setError();
    }
  }

  // ── 3. Ongoing Zustand → Redis sync (watchlist, CGT, FX) ───────────────────
  useEffect(() => {
    const debouncedWatchlist = makeDebounced((wl: string[]) => {
      setSyncing();
      dbPost('/api/db/watchlist', wl).then(setSynced).catch(() => setError());
    }, 1500);

    const debouncedCGT = makeDebounced((trades: unknown[]) => {
      setSyncing();
      dbPost('/api/db/cgt', trades).then(setSynced).catch(() => setError());
    }, 2000);

    const debouncedFX = makeDebounced(({ positions, trades }: { positions: unknown[]; trades: unknown[] }) => {
      setSyncing();
      dbPost('/api/db/fx/global', { positions, trades }).then(setSynced).catch(() => setError());
    }, 2000);

    // Zustand v5 subscribe only accepts a single full-state listener
    // Track previous slices manually to avoid redundant writes
    let prevWatchlist = useClearGainsStore.getState().watchlist;
    let prevTaxTrades = useClearGainsStore.getState().taxTrades;
    let prevFxPositions = useClearGainsStore.getState().fxPositions;
    let prevFxTrades = useClearGainsStore.getState().fxTrades;

    const unsubWatchlist = useClearGainsStore.subscribe(state => {
      if (state.watchlist !== prevWatchlist) {
        prevWatchlist = state.watchlist;
        debouncedWatchlist(state.watchlist);
      }
    });

    const unsubCGT = useClearGainsStore.subscribe(state => {
      if (state.taxTrades !== prevTaxTrades) {
        prevTaxTrades = state.taxTrades;
        debouncedCGT(state.taxTrades);
      }
    });

    const unsubFX = useClearGainsStore.subscribe(state => {
      if (state.fxPositions !== prevFxPositions || state.fxTrades !== prevFxTrades) {
        prevFxPositions = state.fxPositions;
        prevFxTrades = state.fxTrades;
        debouncedFX({ positions: state.fxPositions, trades: state.fxTrades });
      }
    });

    return () => { unsubWatchlist(); unsubCGT(); unsubFX(); };
  }, [setSyncing, setSynced, setError]); // eslint-disable-line react-hooks/exhaustive-deps

  return null; // headless component
}

import { Redis } from '@upstash/redis';
import type { DemoPosition, DemoTrade, FxPosition, FxTrade, TaxTrade } from './types';

// Strip ALL surrounding quotes and whitespace variants (single, double, backtick, spaces)
const redisUrl   = (process.env.UPSTASH_REDIS_REST_URL   ?? '').replace(/^["'\s`]+|["'\s`]+$/g, '');
const redisToken = (process.env.UPSTASH_REDIS_REST_TOKEN ?? '').replace(/^["'\s`]+|["'\s`]+$/g, '');

export const isRedisConfigured = redisUrl.startsWith('https://');

// ── Lazy Redis client — instantiated only on first use, never at module load ───
// This prevents crashes during build/SSR when env vars are absent or malformed.
let _redis: Redis | null = null;

export function getRedis(): Redis | null {
  if (!isRedisConfigured) return null;
  if (!_redis) {
    try {
      _redis = new Redis({ url: redisUrl, token: redisToken });
    } catch (e) {
      console.error('[DB] Failed to create Redis client:', e);
      return null;
    }
  }
  return _redis;
}

// ── Key helpers ────────────────────────────────────────────────────────────────
const K = {
  portfolios:      'portfolios',
  activePortfolio: 'active_portfolio',
  positions:       (id: string) => `positions:${id}`,
  trades:          (id: string) => `trades:${id}`,
  fx:              (id: string) => `fx:${id}`,
  watchlist:       'watchlist',
  manualStocks:    'manual_stocks',
  cgtHistory:      'cgt_history',
  settings:        (id: string) => `settings:${id}`,
  budget:          (id: string) => `budget:${id}`,
  pendingOrders:   'pending_orders',
  migrationDone:   'migration_done',
  encryptedKeys:   'encrypted_t212_keys',
};

// ── DB helpers (server-side only) ─────────────────────────────────────────────
export const DB = {
  async getPortfolios(): Promise<unknown[]> {
    const r = getRedis(); if (!r) return [];
    try { return (await r.get<unknown[]>(K.portfolios)) ?? []; } catch { return []; }
  },
  async savePortfolios(data: unknown[]): Promise<void> {
    const r = getRedis(); if (!r) return;
    try { await r.set(K.portfolios, data); } catch (e) { console.error('[DB] savePortfolios', e); }
  },

  async getActivePortfolio(): Promise<string | null> {
    const r = getRedis(); if (!r) return null;
    try { return await r.get<string>(K.activePortfolio); } catch { return null; }
  },
  async setActivePortfolio(id: string): Promise<void> {
    const r = getRedis(); if (!r) return;
    try { await r.set(K.activePortfolio, id); } catch (e) { console.error('[DB] setActivePortfolio', e); }
  },

  async getPositions(id: string): Promise<DemoPosition[]> {
    const r = getRedis(); if (!r) return [];
    try { return (await r.get<DemoPosition[]>(K.positions(id))) ?? []; } catch { return []; }
  },
  async savePositions(id: string, d: DemoPosition[]): Promise<void> {
    const r = getRedis(); if (!r) return;
    try { await r.set(K.positions(id), d); } catch (e) { console.error('[DB] savePositions', e); }
  },

  async getTrades(id: string): Promise<DemoTrade[]> {
    const r = getRedis(); if (!r) return [];
    try { return (await r.get<DemoTrade[]>(K.trades(id))) ?? []; } catch { return []; }
  },
  async saveTrades(id: string, d: DemoTrade[]): Promise<void> {
    const r = getRedis(); if (!r) return;
    try { await r.set(K.trades(id), d); } catch (e) { console.error('[DB] saveTrades', e); }
  },

  async getFXPositions(id: string): Promise<FxPosition[]> {
    const r = getRedis(); if (!r) return [];
    try { return (await r.get<FxPosition[]>(K.fx(id))) ?? []; } catch { return []; }
  },
  async saveFXPositions(id: string, d: FxPosition[]): Promise<void> {
    const r = getRedis(); if (!r) return;
    try { await r.set(K.fx(id), d); } catch (e) { console.error('[DB] saveFXPositions', e); }
  },

  async getFXTrades(id: string): Promise<FxTrade[]> {
    const r = getRedis(); if (!r) return [];
    try { return (await r.get<FxTrade[]>(`${K.fx(id)}:trades`)) ?? []; } catch { return []; }
  },
  async saveFXTrades(id: string, d: FxTrade[]): Promise<void> {
    const r = getRedis(); if (!r) return;
    try { await r.set(`${K.fx(id)}:trades`, d); } catch (e) { console.error('[DB] saveFXTrades', e); }
  },

  async getWatchlist(): Promise<string[]> {
    const r = getRedis(); if (!r) return [];
    try { return (await r.get<string[]>(K.watchlist)) ?? []; } catch { return []; }
  },
  async saveWatchlist(tickers: string[]): Promise<void> {
    const r = getRedis(); if (!r) return;
    try { await r.set(K.watchlist, tickers); } catch (e) { console.error('[DB] saveWatchlist', e); }
  },

  async getManualStocks(): Promise<unknown[]> {
    const r = getRedis(); if (!r) return [];
    try { return (await r.get<unknown[]>(K.manualStocks)) ?? []; } catch { return []; }
  },
  async saveManualStocks(data: unknown[]): Promise<void> {
    const r = getRedis(); if (!r) return;
    try { await r.set(K.manualStocks, data); } catch (e) { console.error('[DB] saveManualStocks', e); }
  },

  async getCGTHistory(): Promise<TaxTrade[]> {
    const r = getRedis(); if (!r) return [];
    try { return (await r.get<TaxTrade[]>(K.cgtHistory)) ?? []; } catch { return []; }
  },
  async saveCGTHistory(data: TaxTrade[]): Promise<void> {
    const r = getRedis(); if (!r) return;
    try { await r.set(K.cgtHistory, data); } catch (e) { console.error('[DB] saveCGTHistory', e); }
  },

  async getStrategySettings(id: string): Promise<unknown | null> {
    const r = getRedis(); if (!r) return null;
    try { return await r.get<unknown>(K.settings(id)); } catch { return null; }
  },
  async saveStrategySettings(id: string, d: unknown): Promise<void> {
    const r = getRedis(); if (!r) return;
    try { await r.set(K.settings(id), d); } catch (e) { console.error('[DB] saveStrategySettings', e); }
  },

  async getBudget(id: string): Promise<number> {
    const r = getRedis(); if (!r) return 1000;
    try { return (await r.get<number>(K.budget(id))) ?? 1000; } catch { return 1000; }
  },
  async saveBudget(id: string, amount: number): Promise<void> {
    const r = getRedis(); if (!r) return;
    try { await r.set(K.budget(id), amount); } catch (e) { console.error('[DB] saveBudget', e); }
  },

  async getPendingOrders(): Promise<unknown[]> {
    const r = getRedis(); if (!r) return [];
    try { return (await r.get<unknown[]>(K.pendingOrders)) ?? []; } catch { return []; }
  },
  async savePendingOrders(data: unknown[]): Promise<void> {
    const r = getRedis(); if (!r) return;
    try { await r.set(K.pendingOrders, data); } catch (e) { console.error('[DB] savePendingOrders', e); }
  },

  async isMigrationDone(): Promise<boolean> {
    const r = getRedis(); if (!r) return false;
    try { return (await r.get<boolean>(K.migrationDone)) ?? false; } catch { return false; }
  },
  async setMigrationDone(): Promise<void> {
    const r = getRedis(); if (!r) return;
    try { await r.set(K.migrationDone, true); } catch (e) { console.error('[DB] setMigrationDone', e); }
  },

  async getEncryptedKeys(): Promise<{
    live?: { key: string; secret: string };
    isa?:  { key: string; secret: string };
    demo?: { key: string; secret: string };
  } | null> {
    const r = getRedis(); if (!r) return null;
    try {
      return await r.get<{
        live?: { key: string; secret: string };
        isa?:  { key: string; secret: string };
        demo?: { key: string; secret: string };
      }>(K.encryptedKeys);
    } catch { return null; }
  },
  async saveEncryptedKeys(data: {
    live?: { key: string; secret: string };
    isa?:  { key: string; secret: string };
    demo?: { key: string; secret: string };
  }): Promise<void> {
    const r = getRedis(); if (!r) return;
    try { await r.set(K.encryptedKeys, data); } catch (e) { console.error('[DB] saveEncryptedKeys', e); }
  },
  async deleteEncryptedKeys(): Promise<void> {
    const r = getRedis(); if (!r) return;
    try { await r.del(K.encryptedKeys); } catch (e) { console.error('[DB] deleteEncryptedKeys', e); }
  },
};

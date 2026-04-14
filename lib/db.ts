import { Redis } from '@upstash/redis';
import type { DemoPosition, DemoTrade, FxPosition, FxTrade, TaxTrade } from './types';

// Strip any surrounding quotes that can appear when copy-pasting env vars
const redisUrl   = (process.env.UPSTASH_REDIS_REST_URL   ?? '').replace(/^["']|["']$/g, '').trim();
const redisToken = (process.env.UPSTASH_REDIS_REST_TOKEN ?? '').replace(/^["']|["']$/g, '').trim();

export const isRedisConfigured = redisUrl.startsWith('https://');

export const redis: Redis | null = isRedisConfigured
  ? new Redis({ url: redisUrl, token: redisToken })
  : null;

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
    if (!redis) return [];
    try { return (await redis.get<unknown[]>(K.portfolios)) ?? []; } catch { return []; }
  },
  async savePortfolios(data: unknown[]): Promise<void> {
    if (!redis) return;
    try { await redis.set(K.portfolios, data); } catch (e) { console.error('[DB] savePortfolios', e); }
  },

  async getActivePortfolio(): Promise<string | null> {
    if (!redis) return null;
    try { return await redis.get<string>(K.activePortfolio); } catch { return null; }
  },
  async setActivePortfolio(id: string): Promise<void> {
    if (!redis) return;
    try { await redis.set(K.activePortfolio, id); } catch (e) { console.error('[DB] setActivePortfolio', e); }
  },

  async getPositions(id: string): Promise<DemoPosition[]> {
    if (!redis) return [];
    try { return (await redis.get<DemoPosition[]>(K.positions(id))) ?? []; } catch { return []; }
  },
  async savePositions(id: string, d: DemoPosition[]): Promise<void> {
    if (!redis) return;
    try { await redis.set(K.positions(id), d); } catch (e) { console.error('[DB] savePositions', e); }
  },

  async getTrades(id: string): Promise<DemoTrade[]> {
    if (!redis) return [];
    try { return (await redis.get<DemoTrade[]>(K.trades(id))) ?? []; } catch { return []; }
  },
  async saveTrades(id: string, d: DemoTrade[]): Promise<void> {
    if (!redis) return;
    try { await redis.set(K.trades(id), d); } catch (e) { console.error('[DB] saveTrades', e); }
  },

  async getFXPositions(id: string): Promise<FxPosition[]> {
    if (!redis) return [];
    try { return (await redis.get<FxPosition[]>(K.fx(id))) ?? []; } catch { return []; }
  },
  async saveFXPositions(id: string, d: FxPosition[]): Promise<void> {
    if (!redis) return;
    try { await redis.set(K.fx(id), d); } catch (e) { console.error('[DB] saveFXPositions', e); }
  },

  async getFXTrades(id: string): Promise<FxTrade[]> {
    if (!redis) return [];
    try { return (await redis.get<FxTrade[]>(`${K.fx(id)}:trades`)) ?? []; } catch { return []; }
  },
  async saveFXTrades(id: string, d: FxTrade[]): Promise<void> {
    if (!redis) return;
    try { await redis.set(`${K.fx(id)}:trades`, d); } catch (e) { console.error('[DB] saveFXTrades', e); }
  },

  async getWatchlist(): Promise<string[]> {
    if (!redis) return [];
    try { return (await redis.get<string[]>(K.watchlist)) ?? []; } catch { return []; }
  },
  async saveWatchlist(tickers: string[]): Promise<void> {
    if (!redis) return;
    try { await redis.set(K.watchlist, tickers); } catch (e) { console.error('[DB] saveWatchlist', e); }
  },

  async getManualStocks(): Promise<unknown[]> {
    if (!redis) return [];
    try { return (await redis.get<unknown[]>(K.manualStocks)) ?? []; } catch { return []; }
  },
  async saveManualStocks(data: unknown[]): Promise<void> {
    if (!redis) return;
    try { await redis.set(K.manualStocks, data); } catch (e) { console.error('[DB] saveManualStocks', e); }
  },

  async getCGTHistory(): Promise<TaxTrade[]> {
    if (!redis) return [];
    try { return (await redis.get<TaxTrade[]>(K.cgtHistory)) ?? []; } catch { return []; }
  },
  async saveCGTHistory(data: TaxTrade[]): Promise<void> {
    if (!redis) return;
    try { await redis.set(K.cgtHistory, data); } catch (e) { console.error('[DB] saveCGTHistory', e); }
  },

  async getStrategySettings(id: string): Promise<unknown | null> {
    if (!redis) return null;
    try { return await redis.get<unknown>(K.settings(id)); } catch { return null; }
  },
  async saveStrategySettings(id: string, d: unknown): Promise<void> {
    if (!redis) return;
    try { await redis.set(K.settings(id), d); } catch (e) { console.error('[DB] saveStrategySettings', e); }
  },

  async getBudget(id: string): Promise<number> {
    if (!redis) return 1000;
    try { return (await redis.get<number>(K.budget(id))) ?? 1000; } catch { return 1000; }
  },
  async saveBudget(id: string, amount: number): Promise<void> {
    if (!redis) return;
    try { await redis.set(K.budget(id), amount); } catch (e) { console.error('[DB] saveBudget', e); }
  },

  async getPendingOrders(): Promise<unknown[]> {
    if (!redis) return [];
    try { return (await redis.get<unknown[]>(K.pendingOrders)) ?? []; } catch { return []; }
  },
  async savePendingOrders(data: unknown[]): Promise<void> {
    if (!redis) return;
    try { await redis.set(K.pendingOrders, data); } catch (e) { console.error('[DB] savePendingOrders', e); }
  },

  async isMigrationDone(): Promise<boolean> {
    if (!redis) return false;
    try { return (await redis.get<boolean>(K.migrationDone)) ?? false; } catch { return false; }
  },
  async setMigrationDone(): Promise<void> {
    if (!redis) return;
    try { await redis.set(K.migrationDone, true); } catch (e) { console.error('[DB] setMigrationDone', e); }
  },

  async getEncryptedKeys(): Promise<{
    live?: { key: string; secret: string };
    isa?:  { key: string; secret: string };
    demo?: { key: string; secret: string };
  } | null> {
    if (!redis) return null;
    try {
      return await redis.get<{
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
    if (!redis) return;
    try { await redis.set(K.encryptedKeys, data); } catch (e) { console.error('[DB] saveEncryptedKeys', e); }
  },
  async deleteEncryptedKeys(): Promise<void> {
    if (!redis) return;
    try { await redis.del(K.encryptedKeys); } catch (e) { console.error('[DB] deleteEncryptedKeys', e); }
  },
};

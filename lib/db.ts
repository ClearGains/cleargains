import { Redis } from '@upstash/redis';
import type { DemoPosition, DemoTrade, FxPosition, FxTrade, TaxTrade } from './types';

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

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
  // Encrypted T212 credentials — only encrypted blobs stored; raw keys never touch server
  encryptedKeys:   'encrypted_t212_keys',
};

// ── DB helpers (server-side only) ─────────────────────────────────────────────
export const DB = {
  // Portfolios (PortfolioMeta[])
  async getPortfolios():                             Promise<unknown[]> { return (await redis.get<unknown[]>(K.portfolios)) ?? []; },
  async savePortfolios(data: unknown[]):             Promise<void> { await redis.set(K.portfolios, data); },

  // Active portfolio ID
  async getActivePortfolio():                        Promise<string | null> { return redis.get<string>(K.activePortfolio); },
  async setActivePortfolio(id: string):              Promise<void> { await redis.set(K.activePortfolio, id); },

  // Per-portfolio positions
  async getPositions(id: string):                    Promise<DemoPosition[]> { return (await redis.get<DemoPosition[]>(K.positions(id))) ?? []; },
  async savePositions(id: string, d: DemoPosition[]): Promise<void> { await redis.set(K.positions(id), d); },

  // Per-portfolio trades
  async getTrades(id: string):                       Promise<DemoTrade[]> { return (await redis.get<DemoTrade[]>(K.trades(id))) ?? []; },
  async saveTrades(id: string, d: DemoTrade[]):      Promise<void> { await redis.set(K.trades(id), d); },

  // Per-portfolio FX positions
  async getFXPositions(id: string):                  Promise<FxPosition[]> { return (await redis.get<FxPosition[]>(K.fx(id))) ?? []; },
  async saveFXPositions(id: string, d: FxPosition[]): Promise<void> { await redis.set(K.fx(id), d); },

  // Per-portfolio FX trades (stored as fx:${id}:trades)
  async getFXTrades(id: string):                     Promise<FxTrade[]> { return (await redis.get<FxTrade[]>(`${K.fx(id)}:trades`)) ?? []; },
  async saveFXTrades(id: string, d: FxTrade[]):      Promise<void> { await redis.set(`${K.fx(id)}:trades`, d); },

  // Watchlist
  async getWatchlist():                              Promise<string[]> { return (await redis.get<string[]>(K.watchlist)) ?? []; },
  async saveWatchlist(tickers: string[]):            Promise<void> { await redis.set(K.watchlist, tickers); },

  // Manual strategy stocks
  async getManualStocks():                           Promise<unknown[]> { return (await redis.get<unknown[]>(K.manualStocks)) ?? []; },
  async saveManualStocks(data: unknown[]):           Promise<void> { await redis.set(K.manualStocks, data); },

  // CGT trade history
  async getCGTHistory():                             Promise<TaxTrade[]> { return (await redis.get<TaxTrade[]>(K.cgtHistory)) ?? []; },
  async saveCGTHistory(data: TaxTrade[]):            Promise<void> { await redis.set(K.cgtHistory, data); },

  // Strategy settings per portfolio (stores PortfolioMeta)
  async getStrategySettings(id: string):             Promise<unknown | null> { return redis.get<unknown>(K.settings(id)); },
  async saveStrategySettings(id: string, d: unknown): Promise<void> { await redis.set(K.settings(id), d); },

  // Paper budget per portfolio
  async getBudget(id: string):                       Promise<number> { return (await redis.get<number>(K.budget(id))) ?? 1000; },
  async saveBudget(id: string, amount: number):      Promise<void> { await redis.set(K.budget(id), amount); },

  // Pending orders queue
  async getPendingOrders():                          Promise<unknown[]> { return (await redis.get<unknown[]>(K.pendingOrders)) ?? []; },
  async savePendingOrders(data: unknown[]):          Promise<void> { await redis.set(K.pendingOrders, data); },

  // Migration flag
  async isMigrationDone():                           Promise<boolean> { return (await redis.get<boolean>(K.migrationDone)) ?? false; },
  async setMigrationDone():                          Promise<void> { await redis.set(K.migrationDone, true); },

  // Encrypted T212 credentials (AES-256-GCM blobs — safe to store, useless without password)
  async getEncryptedKeys(): Promise<{
    live?: { key: string; secret: string };
    isa?:  { key: string; secret: string };
    demo?: { key: string; secret: string };
  } | null> {
    return redis.get<{
      live?: { key: string; secret: string };
      isa?:  { key: string; secret: string };
      demo?: { key: string; secret: string };
    }>(K.encryptedKeys);
  },
  async saveEncryptedKeys(data: {
    live?: { key: string; secret: string };
    isa?:  { key: string; secret: string };
    demo?: { key: string; secret: string };
  }): Promise<void> {
    await redis.set(K.encryptedKeys, data);
  },
  async deleteEncryptedKeys(): Promise<void> {
    await redis.del(K.encryptedKeys);
  },
};

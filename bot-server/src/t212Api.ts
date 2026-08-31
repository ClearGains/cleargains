// ── Trading 212 API — server-side, for the autonomous ISA bot ─────────────────
// Mirrors alpacaApi.ts's shape (getKeys/base/fetch wrapper pattern). Unlike
// every other broker in this codebase, T212 credentials previously only ever
// lived in the browser (base64'd client-side, sent per-request, never stored
// server-side) — that's what kept T212 manual-only. Real full-time automation
// needs the key sitting here instead, same as IG_LIVE_API_KEY/ALPACA_LIVE_KEY
// already do. See DEPLOY.md-equivalent instructions given to the user for
// exactly which env vars to add.

export type T212Mode = 'live' | 'demo';

function getKeys(mode: T212Mode): { key: string; secret: string } {
  if (mode === 'live') {
    return { key: process.env.T212_LIVE_KEY ?? '', secret: process.env.T212_LIVE_SECRET ?? '' };
  }
  return { key: process.env.T212_DEMO_KEY ?? '', secret: process.env.T212_DEMO_SECRET ?? '' };
}

export function hasT212Creds(mode: T212Mode): boolean {
  const { key, secret } = getKeys(mode);
  return !!key && !!secret;
}

function tradeBase(mode: T212Mode): string {
  return mode === 'live' ? 'https://live.trading212.com/api/v0' : 'https://demo.trading212.com/api/v0';
}

const RETRYABLE_ATTEMPTS = 2;

async function t212Fetch<T>(mode: T212Mode, path: string, options: RequestInit = {}): Promise<T> {
  const { key, secret } = getKeys(mode);
  if (!key || !secret) throw new Error(`T212 ${mode} credentials not configured`);
  const encoded = Buffer.from(`${key}:${secret}`).toString('base64');
  const url = `${tradeBase(mode)}${path}`;

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic ' + encoded,
          ...(options.headers ?? {}),
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      if (attempt < RETRYABLE_ATTEMPTS) { await new Promise(r => setTimeout(r, 1_000 * (attempt + 1))); continue; }
      throw e;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if ((res.status === 429 || res.status >= 500) && attempt < RETRYABLE_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 1_500 * (attempt + 1)));
        continue;
      }
      throw new Error(`T212 ${res.status}: ${text.slice(0, 300) || res.statusText}`);
    }
    const text = await res.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }
}

export type T212Position = {
  ticker:         string;
  quantity:       number;
  averagePrice:   number;
  currentPrice?:  number;
  ppl?:           number;   // unrealized P/L, account currency
  fxPpl?:         number;
  initialFillDate?: string;
};

export function getPortfolio(mode: T212Mode): Promise<T212Position[]> {
  return t212Fetch<T212Position[]>(mode, '/equity/portfolio');
}

export type T212Cash = { free: number; total: number; currencyCode?: string };

export function getCash(mode: T212Mode): Promise<T212Cash> {
  return t212Fetch<T212Cash>(mode, '/equity/account/cash');
}

export type T212Instrument = { ticker: string; shortName: string; type: string; currencyCode: string };

let instrumentCache: { at: number; mode: T212Mode; data: T212Instrument[] } | null = null;
const INSTRUMENT_CACHE_MS = 60 * 60_000; // instrument list barely changes — cache an hour

export async function getInstruments(mode: T212Mode): Promise<T212Instrument[]> {
  if (instrumentCache && instrumentCache.mode === mode && Date.now() - instrumentCache.at < INSTRUMENT_CACHE_MS) {
    return instrumentCache.data;
  }
  const data = await t212Fetch<T212Instrument[]>(mode, '/equity/metadata/instruments');
  instrumentCache = { at: Date.now(), mode, data };
  return data;
}

// Resolves a plain ticker ("AAPL") to T212's own instrument code
// ("AAPL_US_EQ") via the live instrument list — dynamic, not a hardcoded
// table, so it doesn't silently go stale the way a fixed map would.
export async function resolveT212Ticker(mode: T212Mode, symbol: string): Promise<string | null> {
  const upper = symbol.toUpperCase().replace(/\.L$/, '');
  if (upper.includes('_')) return upper; // already a T212 ticker
  const instruments = await getInstruments(mode);
  const match = instruments.find(i => i.ticker.startsWith(upper + '_') || i.shortName?.toUpperCase() === upper);
  return match?.ticker ?? null;
}

export type T212PendingOrder = { id: number; ticker: string; quantity: number; filledQuantity: number; status: string };

// Pending/working orders — needed because a just-placed market order does
// NOT show up in getPortfolio() until it actually fills, which (e.g. right
// at/after market close) can take hours. Code that decides "is this ticker
// still ours" must check this too, not just the portfolio snapshot, or it
// will wrongly conclude a recently-opened, still-unfilled position was
// "closed elsewhere" and re-enter it.
export function getOrders(mode: T212Mode): Promise<T212PendingOrder[]> {
  return t212Fetch<T212PendingOrder[]>(mode, '/equity/orders');
}

export type T212OrderResult = { id?: number | string; fillPrice?: number };

// Positive quantity = buy, negative = sell. Fractional (4dp) — T212 supports
// fractional shares, no per-share minimum, which is what makes a bounded £
// budget per position workable regardless of the stock's own share price.
// extendedHours defaults true — this is used almost exclusively by the ISA
// bot, which is long-horizon buy-and-hold with no need for regular-hours
// fill precision, and letting orders execute outside the NYSE window avoids
// them sitting as unfilled "NEW" for hours if placed near/after close (the
// exact situation that exposed the pending-order tracking bug on 2026-08-24
// — see t212Bot.ts). Untested how T212 actually fills/spreads outside
// regular hours; worth revisiting if fills look bad.
export function placeMarketOrder(mode: T212Mode, ticker: string, quantity: number, extendedHours = true): Promise<T212OrderResult> {
  const rounded = quantity < 0
    ? -(Math.round(Math.abs(quantity) * 10000) / 10000)
    : Math.round(quantity * 10000) / 10000;
  return t212Fetch<T212OrderResult>(mode, '/equity/orders/market', {
    method: 'POST',
    body: JSON.stringify({ ticker, quantity: rounded, extendedHours }),
  });
}

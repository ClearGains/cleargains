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

// Short in-flight+result cache — added 2026-09-04 after "Poll failed: T212
// 429" kept recurring. Root cause: every T212-status page (t212-trader,
// dashboard, positions, world-affairs) polls the bot-server's /t212/:mode/status
// every 10s, which calls getCash+getPortfolio fresh on every single request —
// with any of those pages open (multiple tabs compound it further) that's a
// steady stream of live T212 API calls on top of poll()'s own 3h cycle and
// pollMomentum's 15min one, and T212's real rate limit is tight enough that
// this alone was enough to trip it. Caches the in-flight PROMISE, not just
// the resolved value, so concurrent callers within the same window (the
// status endpoint's own Promise.all([getCash, getPortfolio]) landing at the
// same moment as another tab's poll, or a bot cycle) share one real network
// call instead of each firing their own. TTL (15s) is chosen to just exceed
// the UI's own 10s poll interval — this coalesces that specific hot path
// without making the data meaningfully stale for anything that reads it: no
// caller here acts faster than 15min (pollMomentum), let alone 10s. A failed
// fetch is evicted immediately rather than cached for the full TTL, so a
// transient error doesn't keep everyone stuck on it.
const T212_CACHE_TTL_MS = 15_000;
type T212Cached<T> = { at: number; promise: Promise<T> };
const portfolioCache = new Map<T212Mode, T212Cached<T212Position[]>>();
const cashCache      = new Map<T212Mode, T212Cached<T212Cash>>();

function cached<T>(map: Map<T212Mode, T212Cached<T>>, mode: T212Mode, fresh: boolean, fetcher: () => Promise<T>): Promise<T> {
  const existing = map.get(mode);
  if (!fresh && existing && Date.now() - existing.at < T212_CACHE_TTL_MS) return existing.promise;
  const promise = fetcher();
  map.set(mode, { at: Date.now(), promise });
  promise.catch(() => { if (map.get(mode)?.promise === promise) map.delete(mode); });
  return promise;
}

// `fresh: true` bypasses the cache — used by the budget-check setters below,
// which need a genuinely live balance at the moment of the request, not a
// value that could be up to 15s old.
export function getPortfolio(mode: T212Mode, opts?: { fresh?: boolean }): Promise<T212Position[]> {
  return cached(portfolioCache, mode, !!opts?.fresh, () => t212Fetch<T212Position[]>(mode, '/equity/portfolio'));
}

export type T212Cash = { free: number; total: number; currencyCode?: string };

export function getCash(mode: T212Mode, opts?: { fresh?: boolean }): Promise<T212Cash> {
  return cached(cashCache, mode, !!opts?.fresh, () => t212Fetch<T212Cash>(mode, '/equity/account/cash'));
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

// Real broker-side stop-loss/gain-floor protection for the ISA bot — added
// 2026-09-06 per explicit request. T212 has no bracket/attached-stop order
// (confirmed by the user directly — a protective order can only be placed
// AFTER a position already exists, unlike IG's stopDistance/limitDistance
// on the entry order itself), so this is always a SEPARATE follow-up call
// once the market buy has gone through. Stop-LIMIT specifically (not a
// plain Stop, which becomes a market order and can slip badly on a gap) —
// once `stopPrice` is hit, T212 places a limit order at `limitPrice`, not
// a market one. `quantity` negative = sell, matching placeMarketOrder's own
// sign convention. Confirmed live against T212's public OpenAPI spec
// (docs.trading212.com) — this endpoint is explicitly NOT idempotent
// (T212's own words: sending the same request twice can create duplicate
// orders), so callers must never retry this blindly and must track the
// returned order id themselves to cancel/replace it later.
export function placeStopLimitOrder(
  mode: T212Mode, ticker: string, quantity: number, stopPrice: number, limitPrice: number,
  timeValidity: 'DAY' | 'GOOD_TILL_CANCEL' = 'GOOD_TILL_CANCEL',
): Promise<T212OrderResult> {
  const rounded = quantity < 0
    ? -(Math.round(Math.abs(quantity) * 10000) / 10000)
    : Math.round(quantity * 10000) / 10000;
  return t212Fetch<T212OrderResult>(mode, '/equity/orders/stop_limit', {
    method: 'POST',
    body: JSON.stringify({ ticker, quantity: rounded, stopPrice, limitPrice, timeValidity }),
  });
}

// Best-effort — callers should swallow a 404 (order already filled/gone,
// nothing to cancel) rather than treat it as a real failure.
export function cancelOrder(mode: T212Mode, orderId: number | string): Promise<void> {
  return t212Fetch<void>(mode, `/equity/orders/${orderId}`, { method: 'DELETE' });
}

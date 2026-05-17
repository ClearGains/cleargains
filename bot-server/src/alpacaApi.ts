export type AccountMode = 'paper' | 'live';

export type AlpacaBar = {
  t:   string;  // ISO timestamp
  o:   number;
  h:   number;
  l:   number;
  c:   number;
  v:   number;
  vw?: number;  // vwap if available
};

export type AlpacaPosition = {
  asset_id:         string;
  symbol:           string;
  qty:              string;
  side:             'long' | 'short';
  market_value:     string;
  cost_basis:       string;
  unrealized_pl:    string;
  unrealized_plpc:  string;
  current_price:    string;
  avg_entry_price:  string;
};

export type AlpacaOrder = {
  id:                string;
  client_order_id:   string;
  symbol:            string;
  qty:               string | null;
  notional:          string | null;
  filled_qty:        string;
  side:              'buy' | 'sell';
  type:              string;
  status:            string;
  created_at:        string;
  filled_at:         string | null;
  filled_avg_price:  string | null;
  trail_percent:     string | null;
  stop_price:        string | null;
  limit_price:       string | null;
};

export type AlpacaAccount = {
  id:                  string;
  cash:                string;
  portfolio_value:     string;
  buying_power:        string;
  equity:              string;
  pattern_day_trader:  boolean;
  trading_blocked:     boolean;
  status:              string;
};

export type OrderParams = {
  symbol:           string;
  qty?:             number;
  notional?:        number;   // dollar amount (fractional share support)
  side:             'buy' | 'sell';
  type:             'market' | 'limit' | 'stop' | 'stop_limit' | 'trailing_stop';
  time_in_force:    'day' | 'gtc' | 'ioc' | 'fok';
  limit_price?:     number;
  stop_price?:      number;
  trail_percent?:   number;
  extended_hours?:  boolean;
};

// ── Credentials ───────────────────────────────────────────────────────────────

function getKeys(mode: AccountMode): { key: string; secret: string } {
  if (mode === 'live') {
    return {
      key:    process.env.ALPACA_LIVE_KEY    ?? process.env.ALPACA_API_KEY    ?? '',
      secret: process.env.ALPACA_LIVE_SECRET ?? process.env.ALPACA_SECRET_KEY ?? '',
    };
  }
  return {
    key:    process.env.ALPACA_PAPER_KEY    ?? process.env.ALPACA_API_KEY    ?? '',
    secret: process.env.ALPACA_PAPER_SECRET ?? process.env.ALPACA_SECRET_KEY ?? '',
  };
}

function tradeBase(mode: AccountMode): string {
  return mode === 'live'
    ? 'https://api.alpaca.markets/v2'
    : 'https://paper-api.alpaca.markets/v2';
}

// ── Core fetch ────────────────────────────────────────────────────────────────

async function alpacaFetch<T>(
  mode: AccountMode,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const { key, secret } = getKeys(mode);
  if (!key || !secret) throw new Error(`Alpaca ${mode} credentials not configured`);

  const url = path.startsWith('https://') ? path : `${tradeBase(mode)}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type':        'application/json',
      'APCA-API-KEY-ID':     key,
      'APCA-API-SECRET-KEY': secret,
      ...((options.headers ?? {}) as Record<string, string>),
    },
  });

  if (res.status === 204) return {} as T;

  const text = await res.text();
  if (!res.ok) throw new Error(`Alpaca ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

// ── Account / positions / orders ──────────────────────────────────────────────

export function getAccount(mode: AccountMode): Promise<AlpacaAccount> {
  return alpacaFetch<AlpacaAccount>(mode, '/account');
}

export function getPositions(mode: AccountMode): Promise<AlpacaPosition[]> {
  return alpacaFetch<AlpacaPosition[]>(mode, '/positions');
}

export function getOrders(mode: AccountMode, status: 'open' | 'closed' | 'all' = 'open'): Promise<AlpacaOrder[]> {
  return alpacaFetch<AlpacaOrder[]>(mode, `/orders?status=${status}&limit=100`);
}

export function placeOrder(mode: AccountMode, params: OrderParams): Promise<AlpacaOrder> {
  return alpacaFetch<AlpacaOrder>(mode, '/orders', {
    method: 'POST',
    body:   JSON.stringify(params),
  });
}

export async function cancelOrder(mode: AccountMode, orderId: string): Promise<void> {
  await alpacaFetch<unknown>(mode, `/orders/${orderId}`, { method: 'DELETE' });
}

export async function cancelAllOrders(mode: AccountMode): Promise<void> {
  await alpacaFetch<unknown>(mode, '/orders', { method: 'DELETE' });
}

export function closePosition(mode: AccountMode, symbol: string): Promise<AlpacaOrder> {
  return alpacaFetch<AlpacaOrder>(mode, `/positions/${symbol}`, { method: 'DELETE' });
}

export async function closeAllPositions(mode: AccountMode): Promise<void> {
  await alpacaFetch<unknown>(mode, '/positions?cancel_orders=true', { method: 'DELETE' });
}

// ── Market data ───────────────────────────────────────────────────────────────

export type Timeframe = '1Min' | '5Min' | '15Min' | '1Hour' | '1Day' | '1Week';

export async function getBars(
  symbols:   string[],
  timeframe: Timeframe,
  limit:     number,
  mode:      AccountMode,
): Promise<Record<string, AlpacaBar[]>> {
  const { key, secret } = getKeys(mode);
  if (!key || !secret) throw new Error('Alpaca credentials not configured');

  const params = new URLSearchParams({
    symbols:   symbols.join(','),
    timeframe,
    limit:     String(limit),
    feed:      'iex',     // IEX is free; switch to 'sip' with paid data plan
    sort:      'asc',
  });

  const url = `https://data.alpaca.markets/v2/stocks/bars?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      'APCA-API-KEY-ID':     key,
      'APCA-API-SECRET-KEY': secret,
    },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => res.statusText);
    throw new Error(`Alpaca data ${res.status}: ${txt.slice(0, 200)}`);
  }

  const data = await res.json() as { bars?: Record<string, AlpacaBar[]> };
  return data.bars ?? {};
}

export async function getLatestBars(
  symbols: string[],
  mode:    AccountMode,
): Promise<Record<string, AlpacaBar>> {
  const { key, secret } = getKeys(mode);
  if (!key || !secret) throw new Error('Alpaca credentials not configured');

  const params = new URLSearchParams({ symbols: symbols.join(','), feed: 'iex' });
  const url = `https://data.alpaca.markets/v2/stocks/bars/latest?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      'APCA-API-KEY-ID':     key,
      'APCA-API-SECRET-KEY': secret,
    },
  });

  if (!res.ok) throw new Error(`Alpaca latest bars ${res.status}`);
  const data = await res.json() as { bars?: Record<string, AlpacaBar> };
  return data.bars ?? {};
}

// ── Market hours ──────────────────────────────────────────────────────────────

export function isNYSEOpen(): boolean {
  const now = new Date();
  if (now.getUTCDay() === 0 || now.getUTCDay() === 6) return false;
  // NYSE 9:30–16:00 ET. EDT = UTC-4, so 13:30–20:00 UTC. EST = UTC-5, so 14:30–21:00 UTC.
  // Use 13:30–21:00 to cover both seasons conservatively.
  const utcMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return utcMins >= 13 * 60 + 30 && utcMins < 21 * 60;
}

export function isInOpeningRange(): boolean {
  // First 30 minutes of NYSE: 9:30–10:00 ET = 13:30–14:00 UTC (EDT)
  const now = new Date();
  if (now.getUTCDay() === 0 || now.getUTCDay() === 6) return false;
  const utcMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return utcMins >= 13 * 60 + 30 && utcMins < 14 * 60;
}

export function isNearClose(bufferMins = 15): boolean {
  const now = new Date();
  const utcMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return utcMins >= 21 * 60 - bufferMins && utcMins < 21 * 60;
}

export function isMarketJustOpened(): boolean {
  // Between 9:30–9:35 ET — good time to read opening range
  const now = new Date();
  if (now.getUTCDay() === 0 || now.getUTCDay() === 6) return false;
  const utcMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return utcMins >= 13 * 60 + 30 && utcMins < 13 * 60 + 35;
}

export function isDailyCheckTime(): boolean {
  // Run daily strategy checks at 21:05 UTC (5 min after close) — uses EOD bars
  const now = new Date();
  if (now.getUTCDay() === 0 || now.getUTCDay() === 6) return false;
  const utcMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return utcMins >= 21 * 60 + 5 && utcMins < 21 * 60 + 10;
}

export function isWeeklyCheckTime(): boolean {
  // Run weekly strategy check on Monday 14:00 UTC (after open)
  const now = new Date();
  if (now.getUTCDay() !== 1) return false;
  const utcMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return utcMins >= 14 * 60 && utcMins < 14 * 60 + 5;
}

export function isWeekend(): boolean {
  const day = new Date().getUTCDay();
  return day === 0 || day === 6;
}

// Returns ms until Monday 13:00 UTC (30 min before NYSE open)
export function msUntilMondayOpen(): number {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon … 6=Sat
  const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7; // always next Monday
  const monday = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMonday,
    13, 0, 0, 0,
  ));
  return Math.max(monday.getTime() - now.getTime(), 60_000);
}

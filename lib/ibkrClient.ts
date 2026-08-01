// Direct browser-to-Gateway client for IBKR's Client Portal Web API.
// No backend relay: IB Gateway runs on the same machine as the browser (the
// whole point of this bot being device-resident, not server-resident), so
// every call here goes straight to https://localhost:5000/v1/api. The
// Gateway itself authenticates via its own browser-based login page
// (https://localhost:5000) — nothing here submits credentials; this module
// only talks to the already-authenticated session, via the session cookie
// the browser already holds for that host (credentials: 'include').
//
// Endpoint shapes below were confirmed against IBKR's own Web API docs and
// the community ibind client's source (both cross-referenced, not guessed),
// but NOT yet exercised against a real response — verify each against the
// paper account once Gateway login works, same discipline used for every
// IG epic this session. Expect some field names to need correcting.

const BASE = 'https://localhost:5000/v1/api';

async function ibkrFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ibkr ${init?.method ?? 'GET'} ${path} ${res.status}: ${text.slice(0, 300)}`);
  }
  // Some IBKR endpoints (e.g. tickle with no session) return empty bodies.
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

// ── Session ───────────────────────────────────────────────────────────────────

export type AuthStatus = {
  authenticated: boolean;
  competing?:    boolean;
  connected?:    boolean;
  message?:      string;
};

export async function checkAuthStatus(): Promise<AuthStatus> {
  return ibkrFetch<AuthStatus>('/iserver/auth/status', { method: 'POST' });
}

// Call every ~60s while the bot is running, per IBKR's own guidance — lets
// the Gateway know a client is still active, keeping the session alive.
export async function tickle(): Promise<void> {
  await ibkrFetch('/tickle', { method: 'POST' });
}

// Refreshes the *brokerage* session (valid ~24h) without a full relogin —
// does NOT help once the underlying credentials expire (~weekly), that
// still needs the browser login flow at https://localhost:5000 again.
export async function reauthenticate(): Promise<void> {
  await ibkrFetch('/iserver/reauthenticate', { method: 'POST' });
}

// Required once per session before market-data snapshot calls will work —
// a real IBKR quirk, not optional bookkeeping (confirmed in their own docs:
// "/iserver/accounts must be called prior to /iserver/marketdata/snapshot").
export async function primeSession(): Promise<{ accounts: string[]; selectedAccount?: string }> {
  return ibkrFetch('/iserver/accounts');
}

// ── Accounts ──────────────────────────────────────────────────────────────────

export type IbkrAccount = { accountId: string; accountVan?: string; accountTitle?: string; currency?: string };

export async function getAccounts(): Promise<IbkrAccount[]> {
  return ibkrFetch<IbkrAccount[]>('/portfolio/accounts');
}

// ── Contract search ───────────────────────────────────────────────────────────

export type ContractSection = { secType: string; conid?: string; exchange?: string };
export type ContractSearchResult = {
  conid:        string;
  companyName?: string;
  symbol?:      string;
  sections?:    ContractSection[];
};

// CFDs aren't found by passing secType=CFD directly to the search itself —
// IBKR's search returns the underlying plus a `sections` array listing which
// product types (STK, CFD, WAR, ...) are actually available for it. Callers
// should search by the underlying symbol, then pick out the CFD conid from
// the matched result's sections. Needs empirical confirmation once we have
// a live session — this is the one endpoint shape most likely to need
// adjusting once we can actually see a real response.
export async function searchContract(symbol: string): Promise<ContractSearchResult[]> {
  const params = new URLSearchParams({ symbol });
  return ibkrFetch<ContractSearchResult[]>(`/iserver/secdef/search?${params}`);
}

// ── Market data ───────────────────────────────────────────────────────────────

export type Snapshot = Record<string, string | number> & { conid?: number };

// fields: tick-type codes, e.g. '31' (last price), '84' (bid), '86' (ask).
// First call after primeSession() often returns partial/empty data — IBKR's
// snapshot endpoint "warms up" a subscription; a second call shortly after
// usually returns the real values. Caller should account for this, not
// assume the first response is authoritative.
export async function getSnapshot(conids: string[], fields: string[]): Promise<Snapshot[]> {
  const params = new URLSearchParams({ conids: conids.join(','), fields: fields.join(',') });
  return ibkrFetch<Snapshot[]>(`/iserver/marketdata/snapshot?${params}`);
}

export type IbkrBar = { t: number; o: number; h: number; l: number; c: number; v: number };
export type HistoryResponse = { data: IbkrBar[]; points?: number };

// bar: '1min' | '5min' | '1h' | '1d' | '1w' etc. (see lib/ibkrStrategies.ts's
// STRATEGY_META barPeriod values — same vocabulary).
export async function getHistory(conid: string, bar: string, period: string): Promise<HistoryResponse> {
  const params = new URLSearchParams({ conid, bar, period });
  return ibkrFetch<HistoryResponse>(`/iserver/marketdata/history?${params}`);
}

// ── Positions ─────────────────────────────────────────────────────────────────

export type IbkrPosition = {
  conid:          number;
  position:       number;   // signed: positive = long, negative = short
  avgCost?:       number;
  avgPrice?:      number;
  mktPrice?:      number;
  mktValue?:      number;
  unrealizedPnl?: number;
  contractDesc?:  string;
  currency?:      string;
};

export async function getPositions(accountId: string, page = 0): Promise<IbkrPosition[]> {
  return ibkrFetch<IbkrPosition[]>(`/portfolio/${accountId}/positions/${page}`);
}

// ── Orders ────────────────────────────────────────────────────────────────────

export type OrderRequest = {
  conid:      number;
  orderType:  'MKT' | 'LMT' | 'STP';
  side:       'BUY' | 'SELL';
  quantity:   number;
  tif:        'DAY' | 'GTC';
  price?:     number;    // required for LMT/STP
  cOID?:      string;    // idempotency key — set one per attempt
};

export type OrderReply = { id: string; message: string[] };
export type OrderResult = { order_id?: string; order_status?: string } & Partial<OrderReply>;

function isReply(r: OrderResult): r is OrderResult & OrderReply {
  return typeof r.id === 'string' && Array.isArray(r.message);
}

// Places one or more orders, then walks any "confirmation required" replies
// automatically (IBKR returns these instead of a fill when an order trips a
// risk/precaution warning — e.g. size or price sanity checks). Auto-confirms
// every reply for now since this only runs against paper trading; revisit
// before ever pointing this at a live account — some warnings (e.g. "this
// order may execute immediately against the market") are worth actually
// surfacing to a human rather than blindly confirming.
export async function placeOrders(accountId: string, orders: OrderRequest[]): Promise<OrderResult[]> {
  let results = await ibkrFetch<OrderResult[]>(`/iserver/account/${accountId}/orders`, {
    method: 'POST',
    body: JSON.stringify({ orders }),
  });

  for (let guard = 0; guard < 5; guard++) {
    const pending = results.filter(isReply);
    if (!pending.length) break;
    const confirmed: OrderResult[] = [];
    for (const reply of pending) {
      const next = await ibkrFetch<OrderResult[]>(`/iserver/reply/${reply.id}`, {
        method: 'POST',
        body: JSON.stringify({ confirmed: true }),
      });
      confirmed.push(...next);
    }
    results = [...results.filter(r => !isReply(r)), ...confirmed];
  }

  return results;
}

export async function getLiveOrders(): Promise<OrderResult[]> {
  const r = await ibkrFetch<{ orders?: OrderResult[] }>('/iserver/account/orders');
  return r.orders ?? [];
}

export async function cancelOrder(accountId: string, orderId: string): Promise<void> {
  await ibkrFetch(`/iserver/account/${accountId}/order/${orderId}`, { method: 'DELETE' });
}

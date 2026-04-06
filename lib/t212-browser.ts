'use client';

// Browser-side Trading 212 client — calls T212 directly via CORS proxy.
// Credentials never leave the browser except to go to Trading 212.

const PROXY = 'https://corsproxy.io/?';

function proxyUrl(t212Url: string): string {
  return PROXY + encodeURIComponent(t212Url);
}

function buildAuthHeader(apiKey: string, apiSecret: string): string {
  return 'Basic ' + btoa(apiKey.trim() + ':' + apiSecret.trim());
}

async function t212Fetch(
  path: string,
  apiKey: string,
  apiSecret: string
): Promise<{ status: number; rawBody: string; ok: boolean }> {
  const url = `https://live.trading212.com/api/v0${path}`;
  const res = await fetch(proxyUrl(url), {
    method: 'GET',
    headers: {
      Authorization: buildAuthHeader(apiKey, apiSecret),
      Accept: 'application/json',
    },
  });
  const rawBody = await res.text();
  return { status: res.status, rawBody, ok: res.ok };
}

export async function t212TestConnection(
  apiKey: string,
  apiSecret: string
): Promise<{ ok: boolean; accountId?: string; currency?: string; error?: string }> {
  const result = await t212Fetch('/equity/account/cash', apiKey, apiSecret);

  if (result.ok) {
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(result.rawBody); } catch { /* leave empty */ }
    return {
      ok: true,
      accountId: String(data.id ?? 'unknown'),
      currency: String(data.currencyCode ?? data.currency ?? 'GBP'),
    };
  }

  if (result.status === 401) {
    const body = result.rawBody.trim();
    return {
      ok: false,
      error: body
        ? `Trading 212 returned 401: ${body}`
        : 'Trading 212 returned 401 with empty response — API key format may be incorrect or key was generated on the wrong account type',
    };
  }

  if (result.status === 403) {
    return {
      ok: false,
      error: `Trading 212 returned 403 Forbidden — key may lack required permissions${result.rawBody ? `: ${result.rawBody}` : ''}`,
    };
  }

  return {
    ok: false,
    error: `Trading 212 returned HTTP ${result.status}: ${result.rawBody || '(empty body)'}`,
  };
}

export type T212SyncResult = {
  ok: boolean;
  error?: string;
  accountId?: string;
  currency?: string;
  cash?: number;
  positions?: T212PositionData[];
  trades?: T212TradeData[];
};

export type T212PositionData = {
  ticker: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  ppl: number;
  fxPpl: number;
  initialFillDate: string;
  isISA: boolean;
};

export type T212TradeData = {
  id: string;
  ticker: string;
  type: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  currency: string;
  gbpValue: number;
  date: string;
  fees: number;
  isISA: boolean;
  source: 't212';
};

export async function t212Sync(
  apiKey: string,
  apiSecret: string
): Promise<T212SyncResult> {
  const [cashResult, positionsResult] = await Promise.all([
    t212Fetch('/equity/account/cash', apiKey, apiSecret),
    t212Fetch('/equity/positions', apiKey, apiSecret),
  ]);

  if (!cashResult.ok) {
    return {
      ok: false,
      error: `equity/account/cash — HTTP ${cashResult.status}: ${cashResult.rawBody || '(empty body)'}`,
    };
  }
  if (!positionsResult.ok) {
    return {
      ok: false,
      error: `equity/positions — HTTP ${positionsResult.status}: ${positionsResult.rawBody || '(empty body)'}`,
    };
  }

  let cashData: Record<string, unknown> = {};
  let rawPositions: Record<string, unknown>[] = [];
  try { cashData = JSON.parse(cashResult.rawBody); } catch { /* leave empty */ }
  try {
    const parsed = JSON.parse(positionsResult.rawBody);
    rawPositions = Array.isArray(parsed) ? parsed : [];
  } catch { /* leave empty */ }

  const positions: T212PositionData[] = rawPositions.map((pos) => ({
    ticker: String(pos.ticker ?? ''),
    quantity: Number(pos.quantity ?? 0),
    averagePrice: Number(pos.averagePrice ?? 0),
    currentPrice: Number(pos.currentPrice ?? 0),
    ppl: Number(pos.ppl ?? 0),
    fxPpl: Number(pos.fxPpl ?? 0),
    initialFillDate: String(pos.initialFillDate ?? ''),
    isISA: Boolean(pos.isISA ?? false),
  }));

  const ordersResult = await t212Fetch('/equity/history/orders?limit=200', apiKey, apiSecret);
  const trades: T212TradeData[] = [];
  if (ordersResult.ok) {
    try {
      const ordersData = JSON.parse(ordersResult.rawBody);
      const rawOrders: Record<string, unknown>[] = Array.isArray(ordersData)
        ? ordersData
        : (ordersData?.items ?? []);

      for (const o of rawOrders) {
        if (!o.fillPrice || Number(o.filledQuantity ?? 0) <= 0) continue;
        trades.push({
          id: String(o.id ?? Math.random()),
          ticker: String(o.ticker ?? ''),
          type: 'BUY',
          quantity: Number(o.filledQuantity ?? 0),
          price: Number(o.fillPrice ?? 0),
          currency: 'GBP',
          gbpValue: Number(o.filledQuantity ?? 0) * Number(o.fillPrice ?? 0),
          date: String(o.dateModified ?? o.dateCreated ?? ''),
          fees: Number(
            Array.isArray(o.taxes)
              ? (o.taxes as Record<string, unknown>[]).reduce(
                  (s, t) => s + Number(t.quantity ?? 0),
                  0
                )
              : 0
          ),
          isISA: false,
          source: 't212',
        });
      }
    } catch { /* orders parse failed — skip */ }
  }

  return {
    ok: true,
    accountId: String(cashData.id ?? 'unknown'),
    currency: String(cashData.currencyCode ?? cashData.currency ?? 'GBP'),
    cash: Number(cashData.free ?? cashData.cash ?? 0),
    positions,
    trades,
  };
}

export async function t212FetchOrders(
  apiKey: string,
  apiSecret: string,
  limit = 200
): Promise<T212TradeData[]> {
  const result = await t212Fetch(`/equity/history/orders?limit=${limit}`, apiKey, apiSecret);
  if (!result.ok) throw new Error(`HTTP ${result.status}: ${result.rawBody || '(empty body)'}`);

  const ordersData = JSON.parse(result.rawBody);
  const rawOrders: Record<string, unknown>[] = Array.isArray(ordersData)
    ? ordersData
    : (ordersData?.items ?? []);

  return rawOrders
    .filter((o) => o.fillPrice && Number(o.filledQuantity ?? 0) > 0)
    .map((o) => ({
      id: String(o.id ?? Math.random()),
      ticker: String(o.ticker ?? ''),
      type: 'BUY' as const,
      quantity: Number(o.filledQuantity ?? 0),
      price: Number(o.fillPrice ?? 0),
      currency: 'GBP',
      gbpValue: Number(o.filledQuantity ?? 0) * Number(o.fillPrice ?? 0),
      date: String(o.dateModified ?? o.dateCreated ?? ''),
      fees: Number(
        Array.isArray(o.taxes)
          ? (o.taxes as Record<string, unknown>[]).reduce(
              (s, t) => s + Number(t.quantity ?? 0),
              0
            )
          : 0
      ),
      isISA: false,
      source: 't212' as const,
    }));
}

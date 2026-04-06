// T212 API helpers — server-side only. Never import in client components.

import { T212Position, T212Order } from './types';

function getBase(accountType: 'LIVE' | 'DEMO'): string {
  if (accountType === 'LIVE') {
    return process.env.T212_BASE_URL ?? 'https://live.trading212.com/api/v0';
  }
  return process.env.T212_DEMO_URL ?? 'https://demo.trading212.com/api/v0';
}

function getHeaders(): HeadersInit {
  const apiKey = process.env.T212_API_KEY;
  const apiSecret = process.env.T212_API_SECRET;

  console.log('[T212] T212_API_KEY present:', !!apiKey);
  console.log('[T212] T212_API_SECRET present:', !!apiSecret);

  if (!apiKey) throw new Error('T212_API_KEY not configured');
  if (!apiSecret) throw new Error('T212_API_SECRET not configured');

  const credentials = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');

  return {
    Authorization: `Basic ${credentials}`,
    'Content-Type': 'application/json',
  };
}

export async function fetchT212AccountInfo(accountType: 'LIVE' | 'DEMO') {
  const base = getBase(accountType);
  const res = await fetch(`${base}/equity/account/summary`, {
    headers: getHeaders(),
    next: { revalidate: 0 },
  });
  if (!res.ok) throw new Error(`T212 account info failed: ${res.status}`);
  return res.json();
}

export async function fetchT212Cash(accountType: 'LIVE' | 'DEMO') {
  const base = getBase(accountType);
  const res = await fetch(`${base}/equity/account/cash`, {
    headers: getHeaders(),
    next: { revalidate: 0 },
  });
  if (!res.ok) throw new Error(`T212 cash failed: ${res.status}`);
  return res.json();
}

export async function fetchT212Portfolio(
  accountType: 'LIVE' | 'DEMO'
): Promise<T212Position[]> {
  const base = getBase(accountType);
  const res = await fetch(`${base}/equity/positions`, {
    headers: getHeaders(),
    next: { revalidate: 0 },
  });
  if (!res.ok) throw new Error(`T212 portfolio failed: ${res.status}`);
  const data = await res.json();

  // Map T212 response to our T212Position type
  const positions: T212Position[] = (data ?? []).map((pos: Record<string, unknown>) => ({
    ticker: pos.ticker as string,
    quantity: Number(pos.quantity ?? 0),
    averagePrice: Number(pos.averagePrice ?? 0),
    currentPrice: Number(pos.currentPrice ?? 0),
    ppl: Number(pos.ppl ?? 0),
    fxPpl: Number(pos.fxPpl ?? 0),
    initialFillDate: (pos.initialFillDate as string) ?? '',
    isISA: Boolean(pos.isISA ?? false),
  }));

  return positions;
}

export async function fetchT212Orders(
  accountType: 'LIVE' | 'DEMO',
  limit = 50
): Promise<T212Order[]> {
  const base = getBase(accountType);
  const res = await fetch(
    `${base}/equity/history/orders?limit=${limit}`,
    {
      headers: getHeaders(),
      next: { revalidate: 0 },
    }
  );
  if (!res.ok) throw new Error(`T212 orders failed: ${res.status}`);
  const data = await res.json();

  const orders: T212Order[] = ((data?.items ?? data) as Record<string, unknown>[]).map(
    (order) => ({
      id: (order.id as string) ?? String(Math.random()),
      ticker: (order.ticker as string) ?? '',
      type: ((order.type as string) ?? 'MARKET') as T212Order['type'],
      side: ((order.filledQuantity as number) > 0
        ? order.orderedQuantity
        : 'BUY') as T212Order['side'],
      quantity: Number(order.filledQuantity ?? order.orderedQuantity ?? 0),
      price: Number(order.fillPrice ?? order.limitPrice ?? 0),
      status: (order.status as string) ?? '',
      fillDate: (order.dateModified as string) ?? (order.dateCreated as string) ?? '',
      taxes: Number(order.taxes ?? 0),
      currency: (order.filledValue !== undefined ? 'GBP' : 'USD') as string,
    })
  );

  return orders;
}

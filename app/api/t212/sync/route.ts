import { NextRequest, NextResponse } from 'next/server';

function getBaseUrl(accountType: 'LIVE' | 'DEMO'): string {
  return accountType === 'LIVE'
    ? 'https://live.trading212.com/api/v0'
    : 'https://demo.trading212.com/api/v0';
}

function buildAuthHeader(key: string, secret: string): string {
  return 'Basic ' + Buffer.from(key + ':' + secret).toString('base64');
}

function describeT212Error(endpoint: string, status: number, rawBody: string): string {
  const prefix = `Trading 212 returned HTTP ${status} on ${endpoint}`;
  if (status === 401) {
    if (!rawBody || rawBody.trim() === '') {
      return `${prefix} with empty response - this usually means the API key format is incorrect or the key was generated on the wrong account type`;
    }
    return `${prefix} — ${rawBody}`;
  }
  if (status === 403) {
    return `${prefix} Forbidden - your key may not have the required permissions${rawBody ? ` — ${rawBody}` : ''}`;
  }
  return `${prefix} — ${rawBody || '(empty body)'}`;
}

async function t212Get(url: string, authHeader: string): Promise<{ status: number; rawBody: string }> {
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: authHeader },
    cache: 'no-store',
  });
  const rawBody = await res.text();
  return { status: res.status, rawBody };
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { apiKey, apiSecret, accountType = 'DEMO' } = body as {
    apiKey: string;
    apiSecret: string;
    accountType: 'LIVE' | 'DEMO';
  };

  const key = (apiKey ?? '').trim();
  const secret = (apiSecret ?? '').trim();

  console.log('[T212 sync] accountType:', accountType);
  console.log('[T212 sync] apiKey present:', !!key, '| first 4 chars:', key ? key.slice(0, 4) : 'none');
  console.log('[T212 sync] apiSecret present:', !!secret);

  if (!key || !secret) {
    return NextResponse.json({ error: 'API key and secret must not be empty.' }, { status: 400 });
  }

  const authHeader = buildAuthHeader(key, secret);
  const base = getBaseUrl(accountType);

  try {
    const endpoints = {
      info: `${base}/equity/account/summary`,
      cash: `${base}/equity/account/cash`,
      portfolio: `${base}/equity/positions`,
    };

    console.log('[T212 sync] fetching info, cash, portfolio in parallel');

    const [infoResult, cashResult, portfolioResult] = await Promise.all([
      t212Get(endpoints.info, authHeader),
      t212Get(endpoints.cash, authHeader),
      t212Get(endpoints.portfolio, authHeader),
    ]);

    console.log('[T212 sync] info:', infoResult.status, infoResult.rawBody);
    console.log('[T212 sync] cash:', cashResult.status, cashResult.rawBody);
    console.log('[T212 sync] portfolio:', portfolioResult.status, portfolioResult.rawBody);

    for (const [label, result] of [
      ['equity/account/summary', infoResult],
      ['equity/account/cash', cashResult],
      ['equity/positions', portfolioResult],
    ] as [string, { status: number; rawBody: string }][]) {
      if (result.status < 200 || result.status >= 300) {
        const error = describeT212Error(label, result.status, result.rawBody);
        return NextResponse.json({ error, endpoint: label, status: result.status, rawBody: result.rawBody });
      }
    }

    let accountInfo: Record<string, unknown> = {};
    let cashData: Record<string, unknown> = {};
    let rawPositions: unknown[] = [];

    try { accountInfo = JSON.parse(infoResult.rawBody); } catch { /* leave empty */ }
    try { cashData = JSON.parse(cashResult.rawBody); } catch { /* leave empty */ }
    try {
      const parsed = JSON.parse(portfolioResult.rawBody);
      rawPositions = Array.isArray(parsed) ? parsed : [];
    } catch { /* leave empty */ }

    const positions = (rawPositions as Record<string, unknown>[]).map((pos) => ({
      ticker: String(pos.ticker ?? ''),
      quantity: Number(pos.quantity ?? 0),
      averagePrice: Number(pos.averagePrice ?? 0),
      currentPrice: Number(pos.currentPrice ?? 0),
      ppl: Number(pos.ppl ?? 0),
      fxPpl: Number(pos.fxPpl ?? 0),
      initialFillDate: String(pos.initialFillDate ?? ''),
      isISA: Boolean(pos.isISA ?? false),
    }));

    console.log('[T212 sync] fetching orders');
    const ordersResult = await t212Get(`${base}/equity/history/orders?limit=200`, authHeader);
    console.log('[T212 sync] orders:', ordersResult.status, ordersResult.rawBody.slice(0, 200));

    let trades: unknown[] = [];
    if (ordersResult.status >= 200 && ordersResult.status < 300) {
      try {
        const ordersData = JSON.parse(ordersResult.rawBody);
        const rawOrders: Record<string, unknown>[] = Array.isArray(ordersData)
          ? ordersData
          : (ordersData?.items ?? []);

        trades = rawOrders
          .filter((o) => o.fillPrice && Number(o.filledQuantity ?? 0) > 0)
          .map((o) => ({
            id: String(o.id ?? Math.random()),
            ticker: String(o.ticker ?? ''),
            type: Number(o.filledQuantity ?? 0) > 0 ? 'BUY' : 'SELL',
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
      } catch { /* orders parse failed — skip */ }
    }

    const portfolioValue = positions.reduce(
      (sum, pos) => sum + pos.currentPrice * pos.quantity,
      0
    );

    return NextResponse.json({
      accountType,
      id: accountInfo.id ?? 'unknown',
      currency: accountInfo.currencyCode ?? 'GBP',
      cash: cashData.free ?? cashData.cash ?? 0,
      portfolioValue,
      positions,
      trades,
      syncedAt: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log('[T212 sync] unexpected error:', msg);
    return NextResponse.json(
      { error: `Request to Trading 212 failed: ${msg}` },
      { status: 500 }
    );
  }
}

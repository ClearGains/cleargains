import { NextRequest, NextResponse } from 'next/server';

function getBaseUrl(accountType: 'LIVE' | 'DEMO'): string {
  return accountType === 'LIVE'
    ? 'https://live.trading212.com/api/v0'
    : 'https://demo.trading212.com/api/v0';
}

function buildAuthHeader(key: string, secret: string): string {
  const credentials = Buffer.from(key + ':' + secret).toString('base64');
  return 'Basic ' + credentials;
}

async function t212Fetch(url: string, authHeader: string): Promise<Response> {
  return fetch(url, {
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { apiKey, apiSecret, accountType = 'DEMO' } = body as {
    apiKey: string;
    apiSecret: string;
    accountType: 'LIVE' | 'DEMO';
  };

  if (!apiKey || !apiSecret) {
    return NextResponse.json(
      { error: 'API key and secret are required.' },
      { status: 400 }
    );
  }

  const authHeader = buildAuthHeader(apiKey, apiSecret);
  const base = getBaseUrl(accountType);

  try {
    const [infoRes, cashRes, portfolioRes] = await Promise.all([
      t212Fetch(`${base}/equity/account/info`, authHeader),
      t212Fetch(`${base}/equity/account/cash`, authHeader),
      t212Fetch(`${base}/equity/portfolio`, authHeader),
    ]);

    for (const [label, res] of [
      ['account/info', infoRes],
      ['account/cash', cashRes],
      ['equity/portfolio', portfolioRes],
    ] as [string, Response][]) {
      if (!res.ok) {
        const errorBody = await res.text();
        return NextResponse.json(
          {
            error: `Trading 212 returned ${res.status} for ${label}`,
            t212Message: errorBody,
            accountType,
          },
          { status: res.status === 401 ? 401 : 502 }
        );
      }
    }

    const [accountInfo, cashData, rawPositions] = await Promise.all([
      infoRes.json(),
      cashRes.json(),
      portfolioRes.json(),
    ]);

    const positions = (Array.isArray(rawPositions) ? rawPositions : []).map(
      (pos: Record<string, unknown>) => ({
        ticker: String(pos.ticker ?? ''),
        quantity: Number(pos.quantity ?? 0),
        averagePrice: Number(pos.averagePrice ?? 0),
        currentPrice: Number(pos.currentPrice ?? 0),
        ppl: Number(pos.ppl ?? 0),
        fxPpl: Number(pos.fxPpl ?? 0),
        initialFillDate: String(pos.initialFillDate ?? ''),
        isISA: Boolean(pos.isISA ?? false),
      })
    );

    const ordersRes = await t212Fetch(`${base}/equity/history/orders?limit=200`, authHeader);
    let trades: unknown[] = [];
    if (ordersRes.ok) {
      const ordersData = await ordersRes.json();
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
    return NextResponse.json(
      {
        error: `Sync failed: ${err instanceof Error ? err.message : String(err)}`,
        accountType,
      },
      { status: 500 }
    );
  }
}

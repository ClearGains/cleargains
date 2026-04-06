import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { apiKey, apiSecret, limit = 200 } = body as {
    apiKey: string;
    apiSecret: string;
    limit?: number;
  };

  if (!apiKey || !apiSecret) {
    return NextResponse.json({ error: 'API key and secret are required.' }, { status: 400 });
  }

  const credentials = Buffer.from(apiKey + ':' + apiSecret).toString('base64');

  let status: number;
  let rawBody: string;

  try {
    const res = await fetch(
      `https://live.trading212.com/api/v0/equity/history/orders?limit=${limit}`,
      {
        method: 'GET',
        headers: {
          Authorization: 'Basic ' + credentials,
          'Content-Type': 'application/json',
        },
      }
    );
    status = res.status;
    rawBody = await res.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Request to Trading 212 failed: ${msg}` }, { status: 500 });
  }

  if (status < 200 || status >= 300) {
    return NextResponse.json({
      error: `Trading 212 returned HTTP ${status}: ${rawBody || '(empty body)'}`,
    });
  }

  let ordersData: unknown;
  try { ordersData = JSON.parse(rawBody); } catch {
    return NextResponse.json({ error: `Failed to parse Trading 212 response: ${rawBody}` });
  }

  const rawOrders: Record<string, unknown>[] = Array.isArray(ordersData)
    ? ordersData
    : ((ordersData as Record<string, unknown>)?.items as Record<string, unknown>[]) ?? [];

  const trades = rawOrders
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

  return NextResponse.json({ trades, total: trades.length });
}

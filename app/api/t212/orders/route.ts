import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  // Credentials are base64-encoded by the browser (btoa) and sent as a header.
  const encoded = request.headers.get('x-t212-auth');
  const body = await request.json().catch(() => ({}));
  const limit = Number((body as Record<string, unknown>).limit ?? 200);

  if (!encoded) {
    return NextResponse.json({ error: 'Missing x-t212-auth header.' }, { status: 400 });
  }

  let status: number;
  let rawBody: string;

  try {
    const res = await fetch(
      `https://live.trading212.com/api/v0/equity/history/orders?limit=${limit}`,
      {
        method: 'GET',
        headers: {
          Authorization: 'Basic ' + encoded,
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

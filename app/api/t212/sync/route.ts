import { NextRequest, NextResponse } from 'next/server';

async function t212Get(url: string, encoded: string): Promise<{ status: number; rawBody: string }> {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: 'Basic ' + encoded,
      'Content-Type': 'application/json',
    },
  });
  const rawBody = await res.text();
  return { status: res.status, rawBody };
}

export async function POST(request: NextRequest) {
  // Credentials are base64-encoded by the browser (btoa) and sent as a header.
  const encoded = request.headers.get('x-t212-auth');

  if (!encoded) {
    return NextResponse.json({ error: 'Missing x-t212-auth header.' }, { status: 400 });
  }

  const base = 'https://live.trading212.com/api/v0';

  try {
    const [cashResult, positionsResult] = await Promise.all([
      t212Get(`${base}/equity/account/cash`, encoded),
      t212Get(`${base}/equity/positions`, encoded),
    ]);

    if (cashResult.status < 200 || cashResult.status >= 300) {
      return NextResponse.json({
        error: `equity/account/cash — HTTP ${cashResult.status}: ${cashResult.rawBody || '(empty body)'}`,
      });
    }
    if (positionsResult.status < 200 || positionsResult.status >= 300) {
      return NextResponse.json({
        error: `equity/positions — HTTP ${positionsResult.status}: ${positionsResult.rawBody || '(empty body)'}`,
      });
    }

    let cashData: Record<string, unknown> = {};
    let rawPositions: Record<string, unknown>[] = [];
    try { cashData = JSON.parse(cashResult.rawBody); } catch { /* leave empty */ }
    try {
      const parsed = JSON.parse(positionsResult.rawBody);
      rawPositions = Array.isArray(parsed) ? parsed : [];
    } catch { /* leave empty */ }

    const positions = rawPositions.map((pos) => ({
      ticker: String(pos.ticker ?? ''),
      quantity: Number(pos.quantity ?? 0),
      averagePrice: Number(pos.averagePrice ?? 0),
      currentPrice: Number(pos.currentPrice ?? 0),
      ppl: Number(pos.ppl ?? 0),
      fxPpl: Number(pos.fxPpl ?? 0),
      initialFillDate: String(pos.initialFillDate ?? ''),
      isISA: Boolean(pos.isISA ?? false),
    }));

    const ordersResult = await t212Get(`${base}/equity/history/orders?limit=200`, encoded);
    const trades: unknown[] = [];
    if (ordersResult.status >= 200 && ordersResult.status < 300) {
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

    return NextResponse.json({
      ok: true,
      accountId: String(cashData.id ?? 'unknown'),
      currency: String(cashData.currencyCode ?? cashData.currency ?? 'GBP'),
      cash: Number(cashData.free ?? cashData.cash ?? 0),
      positions,
      trades,
      syncedAt: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Request to Trading 212 failed: ${msg}` }, { status: 500 });
  }
}

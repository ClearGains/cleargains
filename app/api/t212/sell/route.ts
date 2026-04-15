import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/t212/sell
 * Body: { ticker: string; quantity: number; env?: 'live' | 'isa' | 'demo' }
 * Header: x-t212-auth  (btoa(apiKey + ':' + apiSecret))
 *
 * Closes a T212 position by placing a market sell order with negative quantity.
 */
export async function POST(request: NextRequest) {
  const encoded = request.headers.get('x-t212-auth');
  if (!encoded) {
    return NextResponse.json({ ok: false, error: 'Missing x-t212-auth header' }, { status: 400 });
  }

  const body = await request.json() as { ticker?: string; quantity?: number; env?: string };
  if (!body.ticker || !body.quantity) {
    return NextResponse.json({ ok: false, error: 'ticker and quantity are required' }, { status: 400 });
  }

  const env = body.env ?? 'live';
  const base = env === 'demo'
    ? 'https://demo.trading212.com/api/v0'
    : 'https://live.trading212.com/api/v0';

  // Negative quantity = sell/close
  const sellQuantity = -Math.abs(body.quantity);

  try {
    const res = await fetch(`${base}/equity/orders/market`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + encoded,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ticker: body.ticker, quantity: sellQuantity }),
      signal: AbortSignal.timeout(10_000),
    });

    const text = await res.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = text; }

    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: `T212 error ${res.status}: ${text.slice(0, 300)}` },
        { status: res.status },
      );
    }

    return NextResponse.json({ ok: true, data });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

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

  // T212 won't let a position close normally while it has an active
  // protective order (stop/stop-limit) sitting against it — confirmed
  // directly by the user. This route has no idea whether the bot-server (or
  // the user themselves, from the T212 app) ever placed one, so rather than
  // relying on that, it just asks T212 directly: cancel anything pending
  // for this exact ticker before selling. Best-effort — a cancel failing
  // here shouldn't block the sell attempt itself; if a real stop is still
  // in the way, the sell call below will surface that error clearly instead
  // of silently doing nothing.
  try {
    const ordersRes = await fetch(`${base}/equity/orders`, {
      headers: { Authorization: 'Basic ' + encoded },
      signal: AbortSignal.timeout(10_000),
    });
    if (ordersRes.ok) {
      const orders = await ordersRes.json() as Array<{ id?: number | string; ticker?: string }>;
      const pending = Array.isArray(orders) ? orders.filter(o => o.ticker === body.ticker) : [];
      for (const o of pending) {
        if (o.id === undefined) continue;
        try {
          await fetch(`${base}/equity/orders/${o.id}`, {
            method: 'DELETE',
            headers: { Authorization: 'Basic ' + encoded },
            signal: AbortSignal.timeout(10_000),
          });
        } catch { /* best-effort — proceed to the sell attempt regardless */ }
      }
    }
  } catch { /* best-effort — proceed to the sell attempt regardless */ }

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

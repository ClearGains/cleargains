import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const encoded = request.headers.get('x-t212-auth');
  if (!encoded) {
    return NextResponse.json({ ok: false, error: 'Missing x-t212-auth header.' }, { status: 400 });
  }

  const body = await request.json() as { ticker: string; quantity: number };
  if (!body.ticker || !body.quantity || body.quantity < 1) {
    return NextResponse.json({ ok: false, error: 'ticker and quantity are required.' }, { status: 400 });
  }

  try {
    const res = await fetch('https://demo.trading212.com/api/v0/equity/orders/market', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + encoded,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ticker: body.ticker, quantity: body.quantity }),
    });

    const rawBody = await res.text();

    if (res.ok) {
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(rawBody); } catch { /* empty */ }
      return NextResponse.json({ ok: true, orderId: data.id, status: data.status });
    }

    return NextResponse.json({
      ok: false,
      httpStatus: res.status,
      error: rawBody || `HTTP ${res.status}`,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

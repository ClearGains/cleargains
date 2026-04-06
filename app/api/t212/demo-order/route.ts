import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const encoded = request.headers.get('x-t212-auth');
  if (!encoded) return NextResponse.json({ error: 'Missing x-t212-auth header.' }, { status: 400 });

  const body = await request.json() as { ticker: string; quantity: number };
  const { ticker, quantity } = body;

  if (!ticker || !quantity || quantity <= 0) {
    return NextResponse.json({ error: 'ticker and positive quantity are required.' }, { status: 400 });
  }

  const base = 'https://demo.trading212.com/api/v0';

  try {
    const res = await fetch(`${base}/equity/orders/market`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + encoded,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ quantity, ticker }),
      signal: AbortSignal.timeout(10_000),
    });

    const text = await res.text();
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(text); } catch { /* non-JSON body */ }

    if (!res.ok) {
      return NextResponse.json({ error: `T212 DEMO returned ${res.status}: ${text || '(empty)'}` }, { status: res.status });
    }

    return NextResponse.json({ ok: true, orderId: data.id, fillPrice: data.fillPrice, data });
  } catch (err) {
    return NextResponse.json({ error: `Request failed: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
  }
}

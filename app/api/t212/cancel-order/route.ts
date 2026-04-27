import { NextRequest, NextResponse } from 'next/server';

export async function DELETE(request: NextRequest) {
  const encoded = request.headers.get('x-t212-auth');
  if (!encoded) {
    return NextResponse.json({ ok: false, error: 'Missing x-t212-auth header.' }, { status: 400 });
  }

  const orderId = request.nextUrl.searchParams.get('orderId');
  const env     = request.nextUrl.searchParams.get('env') ?? 'demo';

  if (!orderId) {
    return NextResponse.json({ ok: false, error: 'orderId query param required.' }, { status: 400 });
  }

  const base = env === 'live'
    ? 'https://live.trading212.com/api/v0'
    : 'https://demo.trading212.com/api/v0';

  try {
    const r = await fetch(`${base}/equity/orders/${orderId}`, {
      method: 'DELETE',
      headers: { Authorization: 'Basic ' + encoded },
      signal: AbortSignal.timeout(8_000),
    });

    // 404 = already filled/cancelled — treat as success
    if (r.ok || r.status === 404) {
      return NextResponse.json({ ok: true });
    }

    const text = await r.text();
    let msg = text.trim();
    try {
      const d = JSON.parse(text) as { message?: string; code?: string };
      msg = d.message ?? d.code ?? msg;
    } catch { /* ok */ }

    return NextResponse.json({ ok: false, error: msg }, { status: r.status });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

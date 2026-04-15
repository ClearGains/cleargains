import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/t212/cash
 * Header: x-t212-auth  (btoa(apiKey + ':' + apiSecret))
 * Query:  ?env=live|isa|demo
 *
 * Returns available cash for a T212 account.
 */
export async function GET(request: NextRequest) {
  const encoded = request.headers.get('x-t212-auth');
  if (!encoded) {
    return NextResponse.json({ ok: false, error: 'Missing x-t212-auth header' }, { status: 400 });
  }

  const env = request.nextUrl.searchParams.get('env') ?? 'live';
  const base = env === 'demo'
    ? 'https://demo.trading212.com/api/v0'
    : 'https://live.trading212.com/api/v0';

  try {
    const res = await fetch(`${base}/equity/account/cash`, {
      headers: {
        Authorization: 'Basic ' + encoded,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { ok: false, error: `T212 error ${res.status}: ${text.slice(0, 200)}` },
        { status: res.status },
      );
    }

    const data = await res.json() as {
      free?: number;
      total?: number;
      ppl?: number;
      result?: number;
      invested?: number;
      pieCash?: number;
      blocked?: number;
    };

    return NextResponse.json({
      ok:        true,
      available: data.free    ?? 0,
      total:     data.total   ?? 0,
      ppl:       data.ppl     ?? 0,
      invested:  data.invested ?? 0,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

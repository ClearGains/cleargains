import { NextRequest, NextResponse } from 'next/server';

/**
 * PUT /api/ig/positions/update
 * Updates stop/limit levels on an open IG OTC position.
 * Body: { dealId, stopLevel?, limitLevel? }
 */
export async function PUT(request: NextRequest) {
  const cst   = request.headers.get('x-ig-cst') ?? '';
  const token = request.headers.get('x-ig-security-token') ?? '';
  const key   = request.headers.get('x-ig-api-key') ?? '';
  const env   = (request.headers.get('x-ig-env') ?? 'demo') as 'demo' | 'live';

  if (!cst || !token || !key) {
    return NextResponse.json({ ok: false, error: 'Missing IG auth headers' }, { status: 401 });
  }

  const body = await request.json() as { dealId: string; stopLevel?: number; limitLevel?: number };
  if (!body.dealId) {
    return NextResponse.json({ ok: false, error: 'dealId required' }, { status: 400 });
  }

  const base = env === 'demo'
    ? 'https://demo-api.ig.com/gateway/deal'
    : 'https://api.ig.com/gateway/deal';

  try {
    const res = await fetch(`${base}/positions/otc/${encodeURIComponent(body.dealId)}`, {
      method: 'PUT',
      headers: {
        'X-IG-API-KEY':    key,
        'CST':             cst,
        'X-SECURITY-TOKEN': token,
        'Content-Type':    'application/json; charset=UTF-8',
        'Accept':          'application/json; charset=UTF-8',
        'Version':         '2',
      },
      body: JSON.stringify({
        stopLevel:             body.stopLevel   ?? null,
        limitLevel:            body.limitLevel  ?? null,
        trailingStop:          false,
        trailingStopDistance:  null,
        trailingStopIncrement: null,
      }),
    });

    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `IG ${res.status}: ${text.slice(0, 200)}` }, { status: res.status });
    }

    const data = JSON.parse(text) as { dealReference?: string; status?: string };
    return NextResponse.json({ ok: true, dealReference: data.dealReference, status: data.status });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

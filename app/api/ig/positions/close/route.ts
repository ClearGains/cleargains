import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/ig/positions/close
 * Closes an open IG OTC position via DELETE /positions/otc.
 * Body: { dealId, direction ('BUY'|'SELL' — opposite of the open direction), size }
 */
export async function POST(request: NextRequest) {
  const cst   = request.headers.get('x-ig-cst') ?? '';
  const token = request.headers.get('x-ig-security-token') ?? '';
  const key   = request.headers.get('x-ig-api-key') ?? '';
  const env   = (request.headers.get('x-ig-env') ?? 'demo') as 'demo' | 'live';

  if (!cst || !token || !key) {
    return NextResponse.json({ ok: false, error: 'Missing IG auth headers' }, { status: 401 });
  }

  const body = await request.json() as { dealId: string; direction: 'BUY' | 'SELL'; size: number };
  if (!body.dealId || !body.direction || !body.size) {
    return NextResponse.json({ ok: false, error: 'dealId, direction and size are required' }, { status: 400 });
  }

  const base = env === 'demo'
    ? 'https://demo-api.ig.com/gateway/deal'
    : 'https://api.ig.com/gateway/deal';

  try {
    const res = await fetch(`${base}/positions/otc`, {
      method: 'DELETE',
      headers: {
        'X-IG-API-KEY': key,
        'CST': cst,
        'X-SECURITY-TOKEN': token,
        'Content-Type': 'application/json; charset=UTF-8',
        'Accept': 'application/json; charset=UTF-8',
        'Version': '1',
        '_method': 'DELETE',
      },
      body: JSON.stringify({
        dealId:    body.dealId,
        direction: body.direction,
        size:      body.size,
        orderType: 'MARKET',
        expiry:    'DFB',
      }),
    });

    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `IG ${res.status}: ${text.slice(0, 200)}` }, { status: res.status });
    }

    const data = await JSON.parse(text) as { dealReference?: string; status?: string };
    return NextResponse.json({ ok: true, dealReference: data.dealReference, status: data.status });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

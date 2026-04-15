import { NextRequest, NextResponse } from 'next/server';

function igHeaders(apiKey: string, cst: string, securityToken: string, version = '2'): Record<string, string> {
  return {
    'X-IG-API-KEY': apiKey,
    'CST': cst,
    'X-SECURITY-TOKEN': securityToken,
    'Content-Type': 'application/json',
    'Accept': 'application/json; charset=UTF-8',
    'Version': version,
  };
}

/** POST — open a new position */
export async function POST(request: NextRequest) {
  try {
    const cst = request.headers.get('x-ig-cst') ?? '';
    const securityToken = request.headers.get('x-ig-security-token') ?? '';
    const apiKey = request.headers.get('x-ig-api-key') ?? '';
    const env = (request.headers.get('x-ig-env') ?? 'demo') as 'demo' | 'live';

    if (!cst || !securityToken || !apiKey) {
      return NextResponse.json({ ok: false, error: 'Missing IG auth headers' }, { status: 401 });
    }

    const body = await request.json() as {
      epic: string;
      expiry?: string;
      direction: 'BUY' | 'SELL';
      size: number;
      orderType?: string;
      guaranteedStop?: boolean;
      stopDistance?: number;
      profitDistance?: number;
      currencyCode?: string;
      forceOpen?: boolean;
    };

    const baseUrl = env === 'demo'
      ? 'https://demo-api.ig.com/gateway/deal'
      : 'https://api.ig.com/gateway/deal';

    const payload = {
      epic: body.epic,
      expiry: body.expiry ?? 'DFB',
      direction: body.direction,
      size: body.size,
      orderType: body.orderType ?? 'MARKET',
      level: null,
      limitLevel: null,
      stopLevel: null,
      guaranteedStop: body.guaranteedStop ?? false,
      trailingStop: false,
      stopDistance: body.stopDistance ?? null,
      limitDistance: body.profitDistance ?? null,
      currencyCode: body.currencyCode ?? 'GBP',
      forceOpen: body.forceOpen ?? true,
    };

    const res = await fetch(`${baseUrl}/positions/otc`, {
      method: 'POST',
      headers: igHeaders(apiKey, cst, securityToken, '2'),
      body: JSON.stringify(payload),
    });

    let data: { dealReference?: string; errorCode?: string } = {};
    try { data = await res.json() as typeof data; } catch {}

    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: data.errorCode ?? `IG API error ${res.status}` },
        { status: res.status }
      );
    }

    return NextResponse.json({ ok: true, dealReference: data.dealReference });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

/** DELETE — close an existing position (IG requires POST with _method override header) */
export async function DELETE(request: NextRequest) {
  try {
    const cst = request.headers.get('x-ig-cst') ?? '';
    const securityToken = request.headers.get('x-ig-security-token') ?? '';
    const apiKey = request.headers.get('x-ig-api-key') ?? '';
    const env = (request.headers.get('x-ig-env') ?? 'demo') as 'demo' | 'live';

    if (!cst || !securityToken || !apiKey) {
      return NextResponse.json({ ok: false, error: 'Missing IG auth headers' }, { status: 401 });
    }

    const body = await request.json() as {
      dealId: string;
      direction: 'BUY' | 'SELL';
      size: number;
    };

    const baseUrl = env === 'demo'
      ? 'https://demo-api.ig.com/gateway/deal'
      : 'https://api.ig.com/gateway/deal';

    // IG API: close uses POST with _method=DELETE override header (Version 1)
    const closePayload = {
      dealId: body.dealId,
      epic: null,
      expiry: null,
      direction: body.direction,
      size: body.size,
      level: null,
      orderType: 'MARKET',
      timeInForce: null,
      quoteId: null,
    };

    const headers = igHeaders(apiKey, cst, securityToken, '1');

    const res = await fetch(`${baseUrl}/positions/otc`, {
      method: 'POST',
      headers: { ...headers, '_method': 'DELETE' },
      body: JSON.stringify(closePayload),
    });

    let data: { dealReference?: string; errorCode?: string } = {};
    try { data = await res.json() as typeof data; } catch {}

    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: data.errorCode ?? `IG API error ${res.status}` },
        { status: res.status }
      );
    }

    return NextResponse.json({ ok: true, dealReference: data.dealReference });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

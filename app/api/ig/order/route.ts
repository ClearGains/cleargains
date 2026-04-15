import { NextRequest, NextResponse } from 'next/server';

function getIGHeaders(apiKey: string, cst: string, securityToken: string, version = '2'): Record<string, string> {
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
      guaranteedStop: body.guaranteedStop ?? false,
      stopDistance: body.stopDistance ?? 20,
      limitDistance: body.profitDistance ?? 40,
      currencyCode: body.currencyCode ?? 'GBP',
      forceOpen: body.forceOpen ?? true,
    };

    const res = await fetch(`${baseUrl}/positions/otc`, {
      method: 'POST',
      headers: getIGHeaders(apiKey, cst, securityToken),
      body: JSON.stringify(payload),
    });

    const data = await res.json() as { dealReference?: string; errorCode?: string };

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

/** DELETE — close an existing position */
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

    const closePayload = {
      dealId: body.dealId,
      direction: body.direction,
      size: body.size,
      orderType: 'MARKET',
    };

    // IG uses a DELETE with _method override for close
    const res = await fetch(`${baseUrl}/positions/otc`, {
      method: 'POST',
      headers: { ...getIGHeaders(apiKey, cst, securityToken), '_method': 'DELETE' },
      body: JSON.stringify(closePayload),
    });

    const data = await res.json() as { dealReference?: string; errorCode?: string };

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

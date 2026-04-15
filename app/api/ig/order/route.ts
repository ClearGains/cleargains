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

function getAuth(request: NextRequest) {
  return {
    cst:           request.headers.get('x-ig-cst') ?? '',
    securityToken: request.headers.get('x-ig-security-token') ?? '',
    apiKey:        request.headers.get('x-ig-api-key') ?? '',
    env:          (request.headers.get('x-ig-env') ?? 'demo') as 'demo' | 'live',
  };
}

function baseUrl(env: 'demo' | 'live') {
  return env === 'demo'
    ? 'https://demo-api.ig.com/gateway/deal'
    : 'https://api.ig.com/gateway/deal';
}

// ── POST — open market position OR create working order ───────────────────────
export async function POST(request: NextRequest) {
  try {
    const { cst, securityToken, apiKey, env } = getAuth(request);
    if (!cst || !securityToken || !apiKey) {
      return NextResponse.json({ ok: false, error: 'Missing IG auth headers' }, { status: 401 });
    }

    const body = await request.json() as {
      epic: string;
      expiry?: string;
      direction: 'BUY' | 'SELL';
      size: number;
      // MARKET (default) → positions/otc
      // LIMIT / STOP     → workingorders/otc
      orderType?: 'MARKET' | 'LIMIT' | 'STOP';
      level?: number;          // required for LIMIT/STOP working orders
      guaranteedStop?: boolean;
      stopDistance?: number;   // points below/above entry for auto stop-loss
      profitDistance?: number; // points above/below entry for auto take-profit
      stopLevel?: number;      // absolute stop level (alternative to stopDistance)
      limitLevel?: number;     // absolute limit level (alternative to profitDistance)
      currencyCode?: string;
      forceOpen?: boolean;
      timeInForce?: 'GOOD_TILL_CANCELLED' | 'GOOD_TILL_DATE';
    };

    const base = baseUrl(env);
    const orderType = body.orderType ?? 'MARKET';

    // ── Working order (LIMIT or STOP) ─────────────────────────────────────────
    if (orderType === 'LIMIT' || orderType === 'STOP') {
      if (!body.level) {
        return NextResponse.json({ ok: false, error: 'level is required for LIMIT/STOP working orders' }, { status: 400 });
      }
      const woPayload = {
        epic:          body.epic,
        expiry:        body.expiry ?? 'DFB',
        direction:     body.direction,
        size:          body.size,
        level:         body.level,
        type:          orderType,
        guaranteedStop: body.guaranteedStop ?? false,
        stopDistance:  body.stopDistance ?? null,
        limitDistance: body.profitDistance ?? null,
        stopLevel:     body.stopLevel ?? null,
        limitLevel:    body.limitLevel ?? null,
        currencyCode:  body.currencyCode ?? 'GBP',
        timeInForce:   body.timeInForce ?? 'GOOD_TILL_CANCELLED',
        forceOpen:     body.forceOpen ?? true,
      };
      const res = await fetch(`${base}/workingorders/otc`, {
        method: 'POST',
        headers: igHeaders(apiKey, cst, securityToken, '2'),
        body: JSON.stringify(woPayload),
      });
      let data: { dealReference?: string; errorCode?: string } = {};
      try { data = await res.json() as typeof data; } catch {}
      if (!res.ok) {
        return NextResponse.json({ ok: false, error: data.errorCode ?? `IG API error ${res.status}` }, { status: res.status });
      }
      return NextResponse.json({ ok: true, dealReference: data.dealReference, orderType });
    }

    // ── Market position ───────────────────────────────────────────────────────
    const payload = {
      epic:          body.epic,
      expiry:        body.expiry ?? 'DFB',
      direction:     body.direction,
      size:          body.size,
      orderType:     'MARKET',
      level:         null,
      limitLevel:    body.limitLevel ?? null,
      stopLevel:     body.stopLevel ?? null,
      guaranteedStop: body.guaranteedStop ?? false,
      trailingStop:  false,
      stopDistance:  body.stopDistance ?? null,
      limitDistance: body.profitDistance ?? null,
      currencyCode:  body.currencyCode ?? 'GBP',
      forceOpen:     body.forceOpen ?? true,
    };

    const res = await fetch(`${base}/positions/otc`, {
      method: 'POST',
      headers: igHeaders(apiKey, cst, securityToken, '2'),
      body: JSON.stringify(payload),
    });

    let data: { dealReference?: string; errorCode?: string } = {};
    try { data = await res.json() as typeof data; } catch {}

    if (!res.ok) {
      return NextResponse.json({ ok: false, error: data.errorCode ?? `IG API error ${res.status}` }, { status: res.status });
    }
    return NextResponse.json({ ok: true, dealReference: data.dealReference, orderType: 'MARKET' });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
}

// ── DELETE — close an existing position ──────────────────────────────────────
export async function DELETE(request: NextRequest) {
  try {
    const { cst, securityToken, apiKey, env } = getAuth(request);
    if (!cst || !securityToken || !apiKey) {
      return NextResponse.json({ ok: false, error: 'Missing IG auth headers' }, { status: 401 });
    }

    const body = await request.json() as { dealId: string; direction: 'BUY' | 'SELL'; size: number };
    const base = baseUrl(env);

    const closePayload = {
      dealId:      body.dealId,
      epic:        null,
      expiry:      null,
      direction:   body.direction,
      size:        body.size,
      level:       null,
      orderType:   'MARKET',
      timeInForce: null,
      quoteId:     null,
    };

    const res = await fetch(`${base}/positions/otc`, {
      method: 'POST',
      headers: { ...igHeaders(apiKey, cst, securityToken, '1'), '_method': 'DELETE' },
      body: JSON.stringify(closePayload),
    });

    let data: { dealReference?: string; errorCode?: string } = {};
    try { data = await res.json() as typeof data; } catch {}

    if (!res.ok) {
      return NextResponse.json({ ok: false, error: data.errorCode ?? `IG API error ${res.status}` }, { status: res.status });
    }
    return NextResponse.json({ ok: true, dealReference: data.dealReference });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
}

// ── PATCH — update stop/limit levels on an existing open position ─────────────
export async function PATCH(request: NextRequest) {
  try {
    const { cst, securityToken, apiKey, env } = getAuth(request);
    if (!cst || !securityToken || !apiKey) {
      return NextResponse.json({ ok: false, error: 'Missing IG auth headers' }, { status: 401 });
    }

    const body = await request.json() as {
      dealId: string;
      stopLevel?: number | null;
      limitLevel?: number | null;
    };

    if (!body.dealId) {
      return NextResponse.json({ ok: false, error: 'dealId is required' }, { status: 400 });
    }

    const base = baseUrl(env);
    const updatePayload = {
      stopLevel:   body.stopLevel ?? null,
      limitLevel:  body.limitLevel ?? null,
      trailingStop: false,
    };

    const res = await fetch(`${base}/positions/otc/${encodeURIComponent(body.dealId)}`, {
      method: 'PUT',
      headers: igHeaders(apiKey, cst, securityToken, '2'),
      body: JSON.stringify(updatePayload),
    });

    let data: { dealReference?: string; errorCode?: string } = {};
    try { data = await res.json() as typeof data; } catch {}

    if (!res.ok) {
      return NextResponse.json({ ok: false, error: data.errorCode ?? `IG API error ${res.status}` }, { status: res.status });
    }
    return NextResponse.json({ ok: true, dealReference: data.dealReference });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
}

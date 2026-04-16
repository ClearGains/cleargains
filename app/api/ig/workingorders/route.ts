/**
 * /api/ig/workingorders
 *
 * GET    — list all pending working orders (LIMIT / STOP)
 * DELETE — cancel a specific working order by dealId
 */

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

export interface IGWorkingOrder {
  dealId:        string;
  epic:          string;
  instrumentName:string;
  direction:     string;
  size:          number;
  orderType:     string;   // 'LIMIT' | 'STOP'
  level:         number;   // trigger level
  stopDistance?: number;
  limitDistance?:number;
  stopLevel?:    number;
  limitLevel?:   number;
  currency:      string;
  createdAt?:    string;
  timeInForce?:  string;
  goodTillDate?: string;
}

export async function GET(request: NextRequest) {
  try {
    const cst           = request.headers.get('x-ig-cst') ?? '';
    const securityToken = request.headers.get('x-ig-security-token') ?? '';
    const apiKey        = request.headers.get('x-ig-api-key') || (process.env.IG_API_KEY ?? '');
    const env           = (request.headers.get('x-ig-env') ?? 'demo') as 'demo' | 'live';

    if (!cst || !securityToken || !apiKey) {
      return NextResponse.json({ ok: false, error: 'Missing IG auth headers' }, { status: 401 });
    }

    const base = env === 'demo'
      ? 'https://demo-api.ig.com/gateway/deal'
      : 'https://api.ig.com/gateway/deal';

    const res = await fetch(`${base}/workingorders/otc`, {
      headers: igHeaders(apiKey, cst, securityToken, '2'),
    });

    if (!res.ok) {
      const text = await res.text();
      let err = `IG API error ${res.status}`;
      try { const j = JSON.parse(text) as { errorCode?: string }; if (j.errorCode) err = j.errorCode; } catch {}
      return NextResponse.json({ ok: false, error: err }, { status: res.status });
    }

    const raw = await res.json() as {
      workingOrders?: Array<{
        workingOrderData?: {
          dealId?: string;
          direction?: string;
          size?: number;
          orderType?: string;
          level?: number;
          stopDistance?: number;
          limitDistance?: number;
          stopLevel?: number;
          limitLevel?: number;
          currencyCode?: string;
          createdDate?: string;
          timeInForce?: string;
          goodTillDate?: string;
          guaranteedStop?: boolean;
        };
        marketData?: {
          epic?: string;
          instrumentName?: string;
        };
      }>;
    };

    const workingOrders: IGWorkingOrder[] = (raw.workingOrders ?? []).map(wo => ({
      dealId:         wo.workingOrderData?.dealId        ?? '',
      epic:           wo.marketData?.epic                ?? '',
      instrumentName: wo.marketData?.instrumentName      ?? '',
      direction:      wo.workingOrderData?.direction     ?? '',
      size:           wo.workingOrderData?.size          ?? 0,
      orderType:      wo.workingOrderData?.orderType     ?? '',
      level:          wo.workingOrderData?.level         ?? 0,
      stopDistance:   wo.workingOrderData?.stopDistance,
      limitDistance:  wo.workingOrderData?.limitDistance,
      stopLevel:      wo.workingOrderData?.stopLevel,
      limitLevel:     wo.workingOrderData?.limitLevel,
      currency:       wo.workingOrderData?.currencyCode  ?? 'GBP',
      createdAt:      wo.workingOrderData?.createdDate,
      timeInForce:    wo.workingOrderData?.timeInForce,
      goodTillDate:   wo.workingOrderData?.goodTillDate,
    }));

    return NextResponse.json({ ok: true, workingOrders });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const cst           = request.headers.get('x-ig-cst') ?? '';
    const securityToken = request.headers.get('x-ig-security-token') ?? '';
    const apiKey        = request.headers.get('x-ig-api-key') || (process.env.IG_API_KEY ?? '');
    const env           = (request.headers.get('x-ig-env') ?? 'demo') as 'demo' | 'live';

    if (!cst || !securityToken || !apiKey) {
      return NextResponse.json({ ok: false, error: 'Missing IG auth headers' }, { status: 401 });
    }

    const { dealId } = await request.json() as { dealId: string };
    if (!dealId) {
      return NextResponse.json({ ok: false, error: 'dealId is required' }, { status: 400 });
    }

    const base = env === 'demo'
      ? 'https://demo-api.ig.com/gateway/deal'
      : 'https://api.ig.com/gateway/deal';

    // IG cancel working order: POST with _method=DELETE header (Version 2)
    const res = await fetch(`${base}/workingorders/otc/${encodeURIComponent(dealId)}`, {
      method: 'POST',
      headers: { ...igHeaders(apiKey, cst, securityToken, '2'), '_method': 'DELETE' },
      body: JSON.stringify({}),
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

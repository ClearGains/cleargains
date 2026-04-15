import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const epic = searchParams.get('epic') ?? '';
    const cst = request.headers.get('x-ig-cst') ?? '';
    const securityToken = request.headers.get('x-ig-security-token') ?? '';
    const apiKey = request.headers.get('x-ig-api-key') ?? '';
    const env = (request.headers.get('x-ig-env') ?? 'demo') as 'demo' | 'live';

    if (!epic) {
      return NextResponse.json({ ok: false, error: 'epic parameter is required' }, { status: 400 });
    }
    if (!cst || !securityToken || !apiKey) {
      return NextResponse.json({ ok: false, error: 'Missing IG auth headers' }, { status: 401 });
    }

    const baseUrl = env === 'demo'
      ? 'https://demo-api.ig.com/gateway/deal'
      : 'https://api.ig.com/gateway/deal';

    const res = await fetch(`${baseUrl}/markets/${encodeURIComponent(epic)}`, {
      headers: {
        'X-IG-API-KEY': apiKey,
        'CST': cst,
        'X-SECURITY-TOKEN': securityToken,
        'Accept': 'application/json; charset=UTF-8',
        'Version': '3',
      },
    });

    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `IG API error ${res.status}` }, { status: res.status });
    }

    const data = await res.json() as {
      snapshot?: {
        bid?: number;
        offer?: number;
        high?: number;
        low?: number;
        percentageChange?: number;
        netChange?: number;
      };
      instrumentName?: string;
    };

    const snap = data.snapshot ?? {};
    return NextResponse.json({
      ok: true,
      epic,
      instrumentName: data.instrumentName,
      bid: snap.bid,
      offer: snap.offer,
      high: snap.high,
      low: snap.low,
      percentageChange: snap.percentageChange,
      netChange: snap.netChange,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

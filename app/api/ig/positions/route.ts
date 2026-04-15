import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const cst = request.headers.get('x-ig-cst') ?? '';
    const securityToken = request.headers.get('x-ig-security-token') ?? '';
    const apiKey = request.headers.get('x-ig-api-key') ?? '';
    const env = (request.headers.get('x-ig-env') ?? 'demo') as 'demo' | 'live';

    if (!cst || !securityToken || !apiKey) {
      return NextResponse.json({ ok: false, error: 'Missing IG auth headers' }, { status: 401 });
    }

    const baseUrl = env === 'demo'
      ? 'https://demo-api.ig.com/gateway/deal'
      : 'https://api.ig.com/gateway/deal';

    const res = await fetch(`${baseUrl}/positions/otc`, {
      headers: {
        'X-IG-API-KEY': apiKey,
        'CST': cst,
        'X-SECURITY-TOKEN': securityToken,
        'Accept': 'application/json; charset=UTF-8',
        'Version': '2',
      },
    });

    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `IG API error ${res.status}` }, { status: res.status });
    }

    const data = await res.json() as {
      positions?: Array<{
        position?: {
          dealId?: string;
          size?: number;
          direction?: string;
          level?: number;
          currency?: string;
          upl?: number;
          stopLevel?: number;
          limitLevel?: number;
          contractSize?: number;
          createdDate?: string;
        };
        market?: {
          epic?: string;
          instrumentName?: string;
          bid?: number;
          offer?: number;
          instrumentType?: string;
        };
      }>;
    };

    const positions = (data.positions ?? []).map(p => ({
      dealId:         p.position?.dealId,
      direction:      p.position?.direction,
      size:           p.position?.size,
      level:          p.position?.level,
      upl:            p.position?.upl,
      currency:       p.position?.currency,
      stopLevel:      p.position?.stopLevel,
      limitLevel:     p.position?.limitLevel,
      contractSize:   p.position?.contractSize,
      createdDate:    p.position?.createdDate,
      epic:           p.market?.epic,
      instrumentName: p.market?.instrumentName,
      bid:            p.market?.bid,
      offer:          p.market?.offer,
      instrumentType: p.market?.instrumentType,
    }));

    return NextResponse.json({ ok: true, positions });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

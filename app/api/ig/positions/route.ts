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

    // 404 = no positions on account (not a real error)
    if (res.status === 404) {
      return NextResponse.json({ ok: true, positions: [] });
    }

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[ig/positions] IG ${res.status}:`, errText.slice(0, 300));
      return NextResponse.json(
        { ok: false, error: `IG positions error ${res.status}`, detail: errText.slice(0, 200) },
        { status: res.status },
      );
    }

    const data = await res.json() as {
      positions?: Array<{
        position?: {
          dealId?: string;
          size?: number;
          direction?: string;
          level?: number;
          currency?: string;
          stopLevel?: number;
          limitLevel?: number;
          contractSize?: number;
          createdDate?: string;
          createdDateUTC?: string;
        };
        market?: {
          epic?: string;
          instrumentName?: string;
          bid?: number;
          offer?: number;
          instrumentType?: string;
          netChange?: number;
          percentageChange?: number;
        };
      }>;
    };

    const positions = (data.positions ?? []).map(p => {
      const direction = p.position?.direction ?? '';
      const level     = p.position?.level ?? 0;
      const size      = p.position?.size ?? 0;
      const bid       = p.market?.bid ?? 0;
      const offer     = p.market?.offer ?? 0;
      // IG doesn't return UPL directly — calculate it
      const upl = direction === 'BUY'
        ? (bid   - level) * size
        : (level - offer) * size;
      return {
        dealId:         p.position?.dealId         ?? '',
        direction,
        size,
        level,
        upl:            Math.round(upl * 100) / 100,
        currency:       p.position?.currency        ?? 'GBP',
        stopLevel:      p.position?.stopLevel,
        limitLevel:     p.position?.limitLevel,
        contractSize:   p.position?.contractSize,
        createdDate:    p.position?.createdDateUTC ?? p.position?.createdDate,
        epic:           p.market?.epic              ?? '',
        instrumentName: p.market?.instrumentName    ?? '',
        bid,
        offer,
        instrumentType: p.market?.instrumentType,
      };
    });

    console.log(`[ig/positions] ${env} → ${positions.length} position(s)`);
    return NextResponse.json({ ok: true, positions });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

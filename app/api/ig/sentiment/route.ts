import { NextRequest, NextResponse } from 'next/server';

type RawSentiment = {
  marketId:                string;
  longPositionPercentage:  number;
  shortPositionPercentage: number;
};

type SentimentResponse = {
  clientSentiments?: RawSentiment[];
};

export async function GET(request: NextRequest) {
  try {
    const cst           = request.headers.get('x-ig-cst') ?? '';
    const securityToken = request.headers.get('x-ig-security-token') ?? '';
    const apiKey        = request.headers.get('x-ig-api-key') ?? '';
    const env           = (request.headers.get('x-ig-env') ?? 'demo') as 'demo' | 'live';
    const marketIds     = request.nextUrl.searchParams.get('marketIds') ?? '';

    if (!cst || !securityToken || !apiKey) {
      return NextResponse.json({ ok: false, error: 'Missing IG auth headers' }, { status: 401 });
    }
    if (!marketIds) {
      return NextResponse.json({ ok: false, error: 'marketIds query param required' }, { status: 400 });
    }

    const baseUrl = env === 'demo'
      ? 'https://demo-api.ig.com/gateway/deal'
      : 'https://api.ig.com/gateway/deal';

    const url = `${baseUrl}/clientsentiment?marketIds=${encodeURIComponent(marketIds)}`;

    const r = await fetch(url, {
      headers: {
        'X-IG-API-KEY':      apiKey,
        'CST':               cst,
        'X-SECURITY-TOKEN':  securityToken,
        'Accept':            'application/json; charset=UTF-8',
        'Version':           '1',
      },
    });

    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return NextResponse.json({ ok: false, error: `IG sentiment ${r.status}: ${body.slice(0, 200)}` }, { status: 502 });
    }

    const raw = await r.json() as SentimentResponse;
    const sentiments = (raw.clientSentiments ?? []).map(s => ({
      marketId:   s.marketId,
      longPct:    s.longPositionPercentage,
      shortPct:   s.shortPositionPercentage,
    }));

    return NextResponse.json({ ok: true, sentiments });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

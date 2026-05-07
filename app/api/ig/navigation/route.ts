import { NextRequest, NextResponse } from 'next/server';

type NavData = { nodes: Array<{ id: string; name: string }>; markets: Array<{ epic: string; instrumentName: string; expiry?: string; dealingEnabled?: boolean }> };
const cache = new Map<string, { data: NavData; ts: number }>();
const TTL = 10 * 60 * 1000; // 10 min

export async function GET(req: NextRequest) {
  const nodeId = req.nextUrl.searchParams.get('nodeId') ?? '';
  const cst           = req.headers.get('x-ig-cst') ?? '';
  const securityToken = req.headers.get('x-ig-security-token') ?? '';
  const apiKey        = req.headers.get('x-ig-api-key') ?? '';
  const env           = (req.headers.get('x-ig-env') ?? 'demo') as 'demo' | 'live';

  if (!cst || !securityToken || !apiKey) {
    return NextResponse.json({ ok: false, error: 'Missing IG auth headers' }, { status: 401 });
  }

  const cacheKey = `${env}:${nodeId}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TTL) {
    return NextResponse.json({ ok: true, ...cached.data });
  }

  const base = env === 'demo' ? 'https://demo-api.ig.com/gateway/deal' : 'https://api.ig.com/gateway/deal';
  const url  = nodeId ? `${base}/marketnavigation/${nodeId}` : `${base}/marketnavigation`;

  try {
    const res = await fetch(url, {
      headers: {
        'X-IG-API-KEY': apiKey, 'CST': cst, 'X-SECURITY-TOKEN': securityToken,
        'Accept': 'application/json; charset=UTF-8', 'Version': '1',
      },
    });
    if (!res.ok) return NextResponse.json({ ok: false, error: `IG ${res.status}` }, { status: res.status });

    const raw = await res.json() as {
      nodes?: Array<{ id: string; name: string }>;
      markets?: Array<{ epic: string; instrumentName: string; expiry?: string; dealingEnabled?: boolean }>;
    };

    const data = { nodes: raw.nodes ?? [], markets: raw.markets ?? [] };
    cache.set(cacheKey, { data, ts: Date.now() });
    return NextResponse.json({ ok: true, ...data });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

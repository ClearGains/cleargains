import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/ig/marketnavigation
 * GET /api/ig/marketnavigation?nodeId={id}
 *
 * Proxies IG's GET /marketnavigation (top-level) and GET /marketnavigation/{nodeId}.
 * Returns:
 *   { ok: true, nodes: [{id, name}], markets: [{epic, instrumentName, instrumentType, bid, offer, expiry}] }
 */

type IGNode    = { id: string; name: string };
type IGMarket  = { epic: string; instrumentName: string; instrumentType: string; bid: number; offer: number; expiry: string; lotSize?: number };
type IGNavResp = { nodes?: IGNode[]; markets?: IGMarket[] };

/** 5-minute cache to avoid hammering IG while the user browses categories */
const navCache = new Map<string, { data: IGNavResp; expiresAt: number }>();
const CACHE_TTL = 5 * 60_000;

function igHeaders(apiKey: string, cst: string, secToken: string): Record<string, string> {
  return {
    'X-IG-API-KEY':      apiKey,
    'CST':               cst,
    'X-SECURITY-TOKEN':  secToken,
    'Accept':            'application/json; charset=UTF-8',
    'Version':           '1',
  };
}

export async function GET(request: NextRequest) {
  const cst      = request.headers.get('x-ig-cst') ?? '';
  const secToken = request.headers.get('x-ig-security-token') ?? '';
  const apiKey   = request.headers.get('x-ig-api-key') ?? '';
  const env      = (request.headers.get('x-ig-env') ?? 'demo') as 'demo' | 'live';
  const nodeId   = request.nextUrl.searchParams.get('nodeId') ?? '';

  if (!cst || !secToken || !apiKey) {
    return NextResponse.json({ ok: false, error: 'Missing IG auth headers' }, { status: 401 });
  }

  const cacheKey = `${env}:${nodeId || 'root'}`;
  const hit = navCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    return NextResponse.json({ ok: true, ...hit.data, cached: true });
  }

  const baseUrl = env === 'demo'
    ? 'https://demo-api.ig.com/gateway/deal'
    : 'https://api.ig.com/gateway/deal';

  const path = nodeId ? `/marketnavigation/${encodeURIComponent(nodeId)}` : '/marketnavigation';

  try {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: igHeaders(apiKey, cst, secToken),
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return NextResponse.json({ ok: false, error: `IG API ${res.status}: ${text.slice(0, 200)}` }, { status: res.status });
    }

    const data = await res.json() as IGNavResp;
    const result: IGNavResp = {
      nodes:   data.nodes   ?? [],
      markets: data.markets ?? [],
    };

    navCache.set(cacheKey, { data: result, expiresAt: Date.now() + CACHE_TTL });
    return NextResponse.json({ ok: true, ...result, cached: false });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

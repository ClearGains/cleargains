import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/ig/snapshot?epics=EPIC1,EPIC2,...
 *
 * Bulk real-time market snapshot for multiple IG epics in one call.
 * Uses IG's /v1/markets?epics=... endpoint (up to 50 epics).
 * Cached 60s — fresh enough for signal generation, won't hammer IG.
 *
 * Returns a map: { [epic]: { bid, offer, mid, percentageChange, spread, high, low } }
 */

export type IGSnapshotEntry = {
  bid:              number;
  offer:            number;
  mid:              number;
  percentageChange: number;
  spread:           number;
  high:             number;
  low:              number;
};

const cache = new Map<string, { data: Record<string, IGSnapshotEntry>; expiresAt: number }>();
const CACHE_TTL = 60_000; // 60 seconds

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const epicsParam = searchParams.get('epics') ?? '';
  const cst           = request.headers.get('x-ig-cst') ?? '';
  const securityToken = request.headers.get('x-ig-security-token') ?? '';
  const apiKey        = request.headers.get('x-ig-api-key') ?? '';
  const env           = (request.headers.get('x-ig-env') ?? 'demo') as 'demo' | 'live';

  if (!epicsParam) return NextResponse.json({ ok: false, error: 'epics parameter required' }, { status: 400 });
  if (!cst || !securityToken || !apiKey) return NextResponse.json({ ok: false, error: 'Missing IG auth headers' }, { status: 401 });

  // Deduplicate and cap at 50 (IG limit)
  const epics = [...new Set(epicsParam.split(',').map(e => e.trim()).filter(Boolean))].slice(0, 50);
  const cacheKey = `${env}:${epics.sort().join(',')}`;

  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    return NextResponse.json({ ok: true, snapshot: hit.data, cached: true });
  }

  const baseUrl = env === 'demo'
    ? 'https://demo-api.ig.com/gateway/deal'
    : 'https://api.ig.com/gateway/deal';

  try {
    const res = await fetch(
      `${baseUrl}/markets?epics=${encodeURIComponent(epics.join(','))}`,
      {
        headers: {
          'X-IG-API-KEY':      apiKey,
          'CST':               cst,
          'X-SECURITY-TOKEN':  securityToken,
          'Accept':            'application/json; charset=UTF-8',
          'Version':           '1',
        },
        signal: AbortSignal.timeout(8_000),
      },
    );

    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `IG API ${res.status}` }, { status: res.status });
    }

    const raw = await res.json() as {
      marketDetails?: Array<{
        instrument?: { epic?: string };
        snapshot?: {
          bid?: number;
          offer?: number;
          percentageChange?: number;
          high?: number;
          low?: number;
        };
      }>;
    };

    const snapshot: Record<string, IGSnapshotEntry> = {};
    for (const detail of raw.marketDetails ?? []) {
      const epic = detail.instrument?.epic;
      const s    = detail.snapshot;
      if (!epic || !s || !s.bid || !s.offer) continue;
      const bid    = s.bid;
      const offer  = s.offer;
      snapshot[epic] = {
        bid,
        offer,
        mid:              (bid + offer) / 2,
        percentageChange: s.percentageChange ?? 0,
        spread:           offer - bid,
        high:             s.high ?? offer,
        low:              s.low  ?? bid,
      };
    }

    cache.set(cacheKey, { data: snapshot, expiresAt: Date.now() + CACHE_TTL });
    return NextResponse.json({ ok: true, snapshot, cached: false });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
}

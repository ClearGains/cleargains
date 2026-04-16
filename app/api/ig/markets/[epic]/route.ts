import { NextRequest, NextResponse } from 'next/server';

/** Fetch a single market by epic — used to validate an epic is tradeable on the current account */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ epic: string }> },
) {
  const { epic } = await params;
  const cst           = request.headers.get('x-ig-cst') ?? '';
  const securityToken = request.headers.get('x-ig-security-token') ?? '';
  const apiKey        = request.headers.get('x-ig-api-key') ?? '';
  const env           = (request.headers.get('x-ig-env') ?? 'demo') as 'demo' | 'live';

  if (!cst || !securityToken || !apiKey) {
    return NextResponse.json({ ok: false, error: 'Missing IG auth headers' }, { status: 401 });
  }

  const baseUrl = env === 'demo'
    ? 'https://demo-api.ig.com/gateway/deal'
    : 'https://api.ig.com/gateway/deal';

  try {
    const res = await fetch(`${baseUrl}/markets/${encodeURIComponent(epic)}`, {
      headers: {
        'X-IG-API-KEY': apiKey,
        'CST': cst,
        'X-SECURITY-TOKEN': securityToken,
        'Accept': 'application/json; charset=UTF-8',
        'Version': '3',
      },
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `IG API ${res.status}` }, { status: res.status });
    }

    const data = await res.json() as {
      instrument?: { epic?: string; name?: string };
      dealingRules?: unknown;
      snapshot?: { bid?: number; offer?: number };
    };

    return NextResponse.json({ ok: true, epic, instrument: data.instrument, snapshot: data.snapshot });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

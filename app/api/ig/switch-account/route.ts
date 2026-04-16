import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/ig/switch-account
 * Body: { cst, securityToken, apiKey, env, accountId }
 *
 * Switches the active IG sub-account (PUT /session) using existing session
 * tokens and returns refreshed CST + X-SECURITY-TOKEN for the new account.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      cst?: string;
      securityToken?: string;
      apiKey?: string;
      env?: 'demo' | 'live';
      accountId?: string;
    };
    const { cst, securityToken, apiKey, env = 'demo', accountId } = body;

    if (!cst || !securityToken || !apiKey || !accountId) {
      return NextResponse.json({ ok: false, error: 'cst, securityToken, apiKey and accountId are required' }, { status: 400 });
    }

    const baseUrl = env === 'demo'
      ? 'https://demo-api.ig.com/gateway/deal'
      : 'https://api.ig.com/gateway/deal';

    const res = await fetch(`${baseUrl}/session`, {
      method: 'PUT',
      headers: {
        'X-IG-API-KEY':     apiKey,
        'CST':              cst,
        'X-SECURITY-TOKEN': securityToken,
        'Content-Type':     'application/json',
        'Accept':           'application/json; charset=UTF-8',
        'Version':          '1',
      },
      body: JSON.stringify({ accountId, dealingEnabled: true }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return NextResponse.json(
        { ok: false, error: `IG account switch failed (${res.status}): ${text.slice(0, 200)}` },
        { status: res.status },
      );
    }

    // IG issues fresh tokens after a successful PUT /session
    const newCst      = res.headers.get('CST') ?? cst;
    const newSecToken = res.headers.get('X-SECURITY-TOKEN') ?? securityToken;

    return NextResponse.json({
      ok: true,
      cst:           newCst,
      securityToken: newSecToken,
      accountId,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

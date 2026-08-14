import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/ig/refresh-token
 * Body: { refreshToken, apiKey, env }
 *
 * Extends an OAuth (Version 3) session without a fresh login — confirmed
 * live an OAuth access token lasts only 30min, far shorter than the legacy
 * CST/token session's ~6h, so a caller using OAuth (IGCfdAutoTrader.tsx)
 * needs to call this well before that expiry rather than re-authenticating
 * from scratch each time. Re-authenticating with username/password would
 * work too, but this is IG's own intended mechanism for it and doesn't
 * require holding the password in memory for the refresh cycle.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { refreshToken: string; apiKey: string; env: 'demo' | 'live' };
    const { refreshToken, apiKey, env } = body;

    if (!refreshToken || !apiKey) {
      return NextResponse.json({ ok: false, error: 'refreshToken and apiKey are required' }, { status: 400 });
    }

    const baseUrl = env === 'demo'
      ? 'https://demo-api.ig.com/gateway/deal'
      : 'https://api.ig.com/gateway/deal';

    const res = await fetch(`${baseUrl}/session/refresh-token`, {
      method: 'POST',
      headers: {
        'X-IG-API-KEY': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json; charset=UTF-8',
        'Version': '1',
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const text = await res.text();
      let errorCode = '';
      try { errorCode = (JSON.parse(text) as { errorCode?: string }).errorCode ?? ''; } catch {}
      return NextResponse.json({ ok: false, error: errorCode || `IG API error ${res.status}` }, { status: res.status });
    }

    const data = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: string };
    if (!data.access_token || !data.refresh_token) {
      return NextResponse.json({ ok: false, error: 'IG refresh succeeded but response was missing tokens' }, { status: 502 });
    }

    return NextResponse.json({
      ok: true,
      accessToken:  data.access_token,
      refreshToken: data.refresh_token,
      expiresIn:    Number(data.expires_in ?? '1800'),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/ig/logout
 * Headers: x-ig-cst, x-ig-security-token, x-ig-api-key, x-ig-env
 *
 * IG only tolerates one active session per login. Leaving a session open
 * when a bot/tab stops (rather than explicitly logging out) keeps it
 * occupying that one-session slot until its own multi-hour token expiry,
 * which can block every other consumer of the same login in the meantime.
 * This actually tells IG the session is done.
 */
export async function POST(request: NextRequest) {
  const cst   = request.headers.get('x-ig-cst');
  const token = request.headers.get('x-ig-security-token');
  const key   = request.headers.get('x-ig-api-key');
  const env   = request.headers.get('x-ig-env') ?? 'demo';

  if (!cst || !token || !key) {
    return NextResponse.json({ ok: false, error: 'Missing IG auth headers' }, { status: 400 });
  }

  const base = env === 'demo'
    ? 'https://demo-api.ig.com/gateway/deal'
    : 'https://api.ig.com/gateway/deal';

  try {
    await fetch(`${base}/session`, {
      method: 'DELETE',
      headers: {
        'X-IG-API-KEY': key,
        'CST': cst,
        'X-SECURITY-TOKEN': token,
        'Version': '1',
        'Accept': 'application/json; charset=UTF-8',
      },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    // Best-effort — the caller is stopping regardless, and a failed logout
    // just means the session dies on its own natural expiry instead.
  }

  return NextResponse.json({ ok: true });
}

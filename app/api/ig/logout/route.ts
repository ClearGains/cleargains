import { NextRequest, NextResponse } from 'next/server';
import { resolveIgAuth, igRequestHeaders } from '@/lib/igAuthHeaders';

/**
 * POST /api/ig/logout
 * Headers: x-ig-api-key, x-ig-env, plus either (x-ig-cst + x-ig-security-token)
 * or (x-ig-access-token + x-ig-account-id) — see lib/igAuthHeaders.ts.
 *
 * A legacy session only tolerates one other concurrent legacy session per
 * login. Leaving one open when a bot/tab stops (rather than explicitly
 * logging out) keeps it occupying that slot until its own multi-hour token
 * expiry, which can block every other consumer of the same login in the
 * meantime. This actually tells IG the session is done. An OAuth session
 * doesn't carry that same collision risk (confirmed live — see
 * igAuthHeaders.ts) and expires in 30min on its own regardless, so this
 * stays best-effort for both styles rather than something callers need to
 * depend on succeeding.
 */
export async function POST(request: NextRequest) {
  const env  = request.headers.get('x-ig-env') ?? 'demo';
  const auth = resolveIgAuth(request);

  if (!auth) {
    return NextResponse.json({ ok: false, error: 'Missing IG auth headers' }, { status: 400 });
  }

  const base = env === 'demo'
    ? 'https://demo-api.ig.com/gateway/deal'
    : 'https://api.ig.com/gateway/deal';

  try {
    await fetch(`${base}/session`, {
      method: 'DELETE',
      headers: igRequestHeaders(auth, '1'),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    // Best-effort — the caller is stopping regardless, and a failed logout
    // just means the session dies on its own natural expiry instead.
  }

  return NextResponse.json({ ok: true });
}

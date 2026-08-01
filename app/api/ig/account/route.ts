import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/ig/account
 * Headers: x-ig-cst, x-ig-security-token, x-ig-api-key, x-ig-env
 *
 * Returns available funds and balance for the connected IG account.
 */
export async function GET(request: NextRequest) {
  const cst   = request.headers.get('x-ig-cst');
  const token = request.headers.get('x-ig-security-token');
  const key   = request.headers.get('x-ig-api-key');
  const env   = request.headers.get('x-ig-env') ?? 'demo';
  // IG's own "preferred" flag on each account is a sticky per-account
  // setting, NOT "which account this session is currently switched to" —
  // confirmed live it stays pointed at the spread-bet account even after a
  // successful switch to CFD. Callers that know which account they actually
  // switched to (e.g. from /api/ig/session's own returned accountId) should
  // pass it here so this returns the right one instead of silently falling
  // back to whichever account IG considers "preferred".
  const wantedAccountId = request.nextUrl.searchParams.get('accountId');

  if (!cst || !token || !key) {
    return NextResponse.json({ ok: false, error: 'Missing IG auth headers' }, { status: 400 });
  }

  const base = env === 'demo'
    ? 'https://demo-api.ig.com/gateway/deal'
    : 'https://api.ig.com/gateway/deal';

  try {
    const res = await fetch(`${base}/accounts`, {
      headers: {
        'X-IG-API-KEY': key,
        'CST': cst,
        'X-SECURITY-TOKEN': token,
        'Version': '1',
        'Accept': 'application/json; charset=UTF-8',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { ok: false, error: `IG error ${res.status}: ${text.slice(0, 200)}` },
        { status: res.status },
      );
    }

    const data = await res.json() as {
      accounts?: {
        accountId: string;
        accountName: string;
        accountType: string;
        preferred: boolean;
        balance: {
          balance: number;
          deposit: number;
          profitLoss: number;
          available: number;
        };
        currency: string;
        status: string;
      }[];
    };

    // Match by the specific account ID when given (see comment above on why
    // "preferred" can't be trusted for this); otherwise preserve the
    // original fallback behaviour for existing callers.
    const accounts = data.accounts ?? [];
    const selected = (wantedAccountId && accounts.find(a => a.accountId === wantedAccountId))
      ?? accounts.find(a => a.preferred)
      ?? accounts[0];

    if (!selected) {
      return NextResponse.json({ ok: false, error: 'No accounts returned' }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      available:   selected.balance?.available   ?? 0,
      balance:     selected.balance?.balance      ?? 0,
      deposit:     selected.balance?.deposit      ?? 0,
      profitLoss:  selected.balance?.profitLoss   ?? 0,
      accountType: selected.accountType,
      currency:    selected.currency,
      accountId:   selected.accountId,
      accountName: selected.accountName,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/ig/account
 * Headers: x-ig-cst, x-ig-security-token, x-ig-api-key, x-ig-env
 *
 * Returns available funds and balance for the connected IG account.
 */
export async function GET(request: NextRequest) {
  const cst       = request.headers.get('x-ig-cst');
  const token     = request.headers.get('x-ig-security-token');
  const key       = request.headers.get('x-ig-api-key');
  const env       = request.headers.get('x-ig-env') ?? 'demo';
  const targetId  = request.headers.get('x-ig-account-id') ?? '';

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

    const accounts = data.accounts ?? [];
    // Always look up the specific account ID passed by the caller.
    // Fallback to preferred only when no targetId is supplied.
    const preferred = (targetId ? accounts.find(a => a.accountId === targetId) : null)
      ?? accounts.find(a => a.preferred)
      ?? accounts[0];

    if (!preferred) {
      return NextResponse.json({ ok: false, error: 'No accounts returned' }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      available:   preferred.balance?.available   ?? 0,
      balance:     preferred.balance?.balance      ?? 0,
      deposit:     preferred.balance?.deposit      ?? 0,
      profitLoss:  preferred.balance?.profitLoss   ?? 0,
      accountType: preferred.accountType,
      currency:    preferred.currency,
      accountId:   preferred.accountId,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

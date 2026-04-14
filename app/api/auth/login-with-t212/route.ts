import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/proxy';
import {
  hashKeyPair, signLinks, verifyLinks,
  ACCOUNT_COOKIE, COOKIE_MAX_AGE,
  AccountType, AccountClaim,
} from '@/lib/accountAuth';

const T212_BASE: Record<AccountType, string> = {
  demo: 'https://demo.trading212.com/api/v0',
  live: 'https://live.trading212.com/api/v0',
  isa:  'https://live.trading212.com/api/v0',
};

/**
 * POST /api/auth/login-with-t212
 *
 * Validates T212 credentials, then in a single response:
 *   1. Sets the cg-session cookie (grants site access)
 *   2. Sets the cg-account-links cookie (grants trading permission)
 *
 * Body: { apiKey: string; apiSecret: string; accountType: 'demo' | 'live' | 'isa' }
 * Returns: { ok, accountId, currency, cash, keyHashPrefix, accountType }
 */
export async function POST(request: NextRequest) {
  let body: { apiKey: string; apiSecret: string; accountType: AccountType };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request body.' }, { status: 400 });
  }

  const { apiKey, apiSecret, accountType } = body;

  if (!apiKey?.trim() || !apiSecret?.trim()) {
    return NextResponse.json({ ok: false, error: 'API key and secret are required.' }, { status: 400 });
  }
  if (!['demo', 'live', 'isa'].includes(accountType)) {
    return NextResponse.json({ ok: false, error: 'accountType must be demo, live, or isa.' }, { status: 400 });
  }

  const cleanKey    = apiKey.trim();
  const cleanSecret = apiSecret.trim();
  const encoded     = Buffer.from(`${cleanKey}:${cleanSecret}`).toString('base64');
  const base        = T212_BASE[accountType];

  // Validate with T212
  let accountId = 'unknown';
  let currency  = 'GBP';
  let cash      = 0;

  try {
    const t212Res = await fetch(`${base}/equity/account/cash`, {
      headers: { Authorization: 'Basic ' + encoded },
      signal: AbortSignal.timeout(8_000),
    });

    if (!t212Res.ok) {
      const msg = await t212Res.text();
      return NextResponse.json(
        { ok: false, error: `T212 rejected these credentials (${t212Res.status})${msg ? ': ' + msg : ''}` },
        { status: 401 }
      );
    }

    const data = await t212Res.json() as Record<string, unknown>;
    accountId = String(data.id ?? 'unknown');
    currency  = String(data.currencyCode ?? data.currency ?? 'GBP');
    cash      = Number(data.free ?? data.cash ?? 0);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `Could not reach Trading 212: ${err instanceof Error ? err.message : String(err)}` },
      { status: 503 }
    );
  }

  // Build/merge the account-links cookie
  const keyHash = hashKeyPair(cleanKey, cleanSecret);
  const existingRaw = request.cookies.get(ACCOUNT_COOKIE)?.value;
  const existing = existingRaw ? verifyLinks(existingRaw) : null;
  const claims: AccountClaim[] = (existing?.claims ?? []).filter(c => c.accountType !== accountType);
  claims.push({ keyHash, accountId, accountType, linkedAt: Date.now() });
  const accountToken = signLinks({ claims, exp: Date.now() + COOKIE_MAX_AGE * 1000 });

  const cookieOpts = {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: COOKIE_MAX_AGE,
    secure: process.env.NODE_ENV === 'production',
  };

  const res = NextResponse.json({
    ok: true,
    accountType,
    accountId,
    currency,
    cash,
    keyHashPrefix: keyHash.slice(0, 8),
  });

  // Session cookie — grants site-level access (mirrors the site-password flow)
  res.cookies.set(SESSION_COOKIE, 'open', cookieOpts);

  // Account-links cookie — grants trading permission for this account
  res.cookies.set(ACCOUNT_COOKIE, accountToken, cookieOpts);

  return res;
}

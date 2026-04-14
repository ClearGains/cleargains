import { NextRequest, NextResponse } from 'next/server';
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

// ── POST — validate credentials with T212 then record a signed account claim ──
export async function POST(request: NextRequest) {
  let body: { apiKey: string; apiSecret: string; accountType: AccountType };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { apiKey, apiSecret, accountType } = body;
  if (!apiKey || !apiSecret || !accountType) {
    return NextResponse.json({ ok: false, error: 'apiKey, apiSecret and accountType are required.' }, { status: 400 });
  }
  if (!['demo', 'live', 'isa'].includes(accountType)) {
    return NextResponse.json({ ok: false, error: 'accountType must be demo, live or isa.' }, { status: 400 });
  }

  // Validate credentials against T212
  const encoded = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  const base = T212_BASE[accountType];
  let accountId = 'unknown';
  try {
    const t212Res = await fetch(`${base}/equity/account/cash`, {
      headers: { Authorization: 'Basic ' + encoded },
      signal: AbortSignal.timeout(8_000),
    });
    if (!t212Res.ok) {
      const body = await t212Res.text();
      return NextResponse.json(
        { ok: false, error: `T212 rejected credentials (${t212Res.status}): ${body}` },
        { status: 401 }
      );
    }
    const data = await t212Res.json() as Record<string, unknown>;
    accountId = String(data.id ?? data.accountId ?? 'unknown');
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `T212 unreachable: ${err instanceof Error ? err.message : String(err)}` },
      { status: 503 }
    );
  }

  const keyHash = hashKeyPair(apiKey, apiSecret);

  // Merge with any existing claims from the cookie
  const existingRaw = request.cookies.get(ACCOUNT_COOKIE)?.value;
  const existing = existingRaw ? verifyLinks(existingRaw) : null;
  const claims: AccountClaim[] = (existing?.claims ?? []).filter(c => c.accountType !== accountType);
  claims.push({ keyHash, accountId, accountType, linkedAt: Date.now() });

  const token = signLinks({ claims, exp: Date.now() + COOKIE_MAX_AGE * 1000 });

  const res = NextResponse.json({
    ok: true,
    accountType,
    accountId,
    keyHashPrefix: keyHash.slice(0, 8), // safe to expose — 8 chars of hex is not reversible
  });
  res.cookies.set(ACCOUNT_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE,
    secure: process.env.NODE_ENV === 'production',
  });
  return res;
}

// ── GET — list currently linked accounts (no secrets, just metadata) ──────────
export async function GET(request: NextRequest) {
  const raw = request.cookies.get(ACCOUNT_COOKIE)?.value;
  if (!raw) return NextResponse.json({ accounts: [] });
  const links = verifyLinks(raw);
  if (!links) return NextResponse.json({ accounts: [], expired: true });

  return NextResponse.json({
    accounts: links.claims.map(c => ({
      accountType: c.accountType,
      accountId: c.accountId,
      keyHashPrefix: c.keyHash.slice(0, 8),
      linkedAt: c.linkedAt,
    })),
  });
}

// ── DELETE — unlink a specific account type ───────────────────────────────────
export async function DELETE(request: NextRequest) {
  let body: { accountType: AccountType };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { accountType } = body;
  const raw = request.cookies.get(ACCOUNT_COOKIE)?.value;
  const existing = raw ? verifyLinks(raw) : null;
  const claims: AccountClaim[] = (existing?.claims ?? []).filter(c => c.accountType !== accountType);

  const res = NextResponse.json({ ok: true });
  if (claims.length === 0) {
    res.cookies.delete(ACCOUNT_COOKIE);
  } else {
    const token = signLinks({ claims, exp: Date.now() + COOKIE_MAX_AGE * 1000 });
    res.cookies.set(ACCOUNT_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: COOKIE_MAX_AGE,
      secure: process.env.NODE_ENV === 'production',
    });
  }
  return res;
}

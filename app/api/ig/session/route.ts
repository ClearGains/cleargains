import { NextRequest, NextResponse } from 'next/server';

/** In-memory token cache: { cacheKey → { cst, securityToken, accountId, accounts, expiresAt } } */
const tokenCache = new Map<string, {
  cst: string;
  securityToken: string;
  accountId: string;
  accounts: unknown[];
  expiresAt: number;
}>();

const TOKEN_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      username: string;
      password: string;
      apiKey: string;
      env: 'demo' | 'live';
    };
    const { password, apiKey, env } = body;
    // Sanitise — IG rejects identifiers that contain spaces or @ symbols
    const username = (body.username ?? '').trim().replace(/\s+/g, '');

    if (!username || !password || !apiKey) {
      return NextResponse.json({ ok: false, error: 'username, password, and apiKey are required' }, { status: 400 });
    }

    const baseUrl = env === 'demo'
      ? 'https://demo-api.ig.com/gateway/deal'
      : 'https://api.ig.com/gateway/deal';

    const cacheKey = `${env}:${username}:${apiKey}`;
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return NextResponse.json({
        ok: true,
        cst: cached.cst,
        securityToken: cached.securityToken,
        accountId: cached.accountId,
        accounts: cached.accounts,
      });
    }

    const res = await fetch(`${baseUrl}/session`, {
      method: 'POST',
      headers: {
        'X-IG-API-KEY': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json; charset=UTF-8',
        'Version': '2',
      },
      body: JSON.stringify({ identifier: username, password }),
    });

    if (!res.ok) {
      const text = await res.text();
      let errMsg = `IG API error ${res.status}`;
      try {
        const j = JSON.parse(text) as { errorCode?: string };
        if (j.errorCode) {
          if (j.errorCode.includes('authenticationRequest.identifier') || j.errorCode.includes('invalid.identifier')) {
            errMsg = 'IG rejected the username. Please use your IG username/account number — NOT your email address. Find it in the IG app → My Account → Account details.';
          } else if (j.errorCode.includes('invalid.password') || j.errorCode.includes('authentication')) {
            errMsg = 'IG authentication failed. Check your username and password are correct.';
          } else {
            errMsg = `IG: ${j.errorCode}`;
          }
        }
      } catch {}
      return NextResponse.json({ ok: false, error: errMsg }, { status: res.status });
    }

    const cst = res.headers.get('CST') ?? '';
    const securityToken = res.headers.get('X-SECURITY-TOKEN') ?? '';
    const data = await res.json() as {
      accountType?: string;
      accountId?: string;
      accounts?: unknown[];
      clientId?: string;
    };

    const entry = {
      cst,
      securityToken,
      accountId: data.accountId ?? '',
      accounts: data.accounts ?? [],
      expiresAt: Date.now() + TOKEN_TTL_MS,
    };
    tokenCache.set(cacheKey, entry);

    return NextResponse.json({
      ok: true,
      cst,
      securityToken,
      accountId: data.accountId,
      accounts: data.accounts,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

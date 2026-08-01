import { NextRequest, NextResponse } from 'next/server';

/** In-memory token cache: { cacheKey → { cst, securityToken, accountId, accounts, expiresAt } } */
const tokenCache = new Map<string, {
  cst: string;
  securityToken: string;
  accountId: string;
  accounts: unknown[];
  expiresAt: number;
}>();

const TOKEN_TTL_MS = 5 * 60 * 60 * 1000; // 5 hours (IG tokens last 6h; refresh before expiry)

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      username: string;
      password: string;
      apiKey: string;
      env: 'demo' | 'live';
      accountType?: 'SPREADBET' | 'CFD';
    };
    const { password, apiKey, env } = body;
    const wantedAccountType = body.accountType ?? 'SPREADBET';
    const forceRefresh = (body as { forceRefresh?: boolean }).forceRefresh === true;
    // Sanitise — IG rejects identifiers that contain spaces or @ symbols
    const username = (body.username ?? '').trim().replace(/\s+/g, '');

    if (!username || !password || !apiKey) {
      return NextResponse.json({ ok: false, error: 'username, password, and apiKey are required' }, { status: 400 });
    }

    const baseUrl = env === 'demo'
      ? 'https://demo-api.ig.com/gateway/deal'
      : 'https://api.ig.com/gateway/deal';

    const cacheKey = `${env}:${username}:${apiKey}:${wantedAccountType}`;
    const cached = tokenCache.get(cacheKey);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
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
      let errorCode = '';
      try {
        const j = JSON.parse(text) as { errorCode?: string };
        errorCode = j.errorCode ?? '';
      } catch { /* plain-text or HTML response */ }

      if (errorCode.includes('authenticationRequest.identifier') || errorCode.includes('invalid.identifier')) {
        errMsg = 'IG rejected the username. Use your IG account number (e.g. Z12345), not your email. Find it in the IG app → My Account → Account details.';
      } else if (errorCode.includes('invalid.password') || errorCode.includes('authentication')) {
        errMsg = 'IG authentication failed — check your username and password are correct.';
      } else if (errorCode.includes('exceed-login-session-limit') || errorCode.includes('session-limit')) {
        errMsg = 'IG session limit reached. Log out of the IG web platform or other devices, wait a minute, then try again.';
      } else if (res.status === 500) {
        errMsg = errorCode
          ? `IG server error: ${errorCode}`
          : 'IG demo server returned 500. This is usually temporary — the demo environment is less stable than live. Wait 1–2 minutes and try again, or check status.ig.com.';
      } else if (errorCode) {
        errMsg = `IG: ${errorCode}`;
      }

      // Clear any cached token so the next attempt hits IG fresh
      tokenCache.delete(cacheKey);

      return NextResponse.json({ ok: false, error: errMsg }, { status: res.status });
    }

    // IG returns session tokens in RESPONSE HEADERS (not body)
    let cst           = res.headers.get('CST') ?? '';
    let securityToken = res.headers.get('X-SECURITY-TOKEN') ?? '';

    type AccountEntry = { accountId: string; accountName: string; accountType: string; preferred: boolean; status: string };
    const data = await res.json() as {
      accountType?: string;
      accountId?: string;
      accounts?: AccountEntry[];
      clientId?: string;
    };

    // ── Auto-switch to the requested account type ─────────────────────────────
    // If the user has both a CFD and a Spread Bet account, IG may default to
    // either one on login. Orders placed on the wrong account type are
    // rejected with REJECT_CFD_ORDER_ON_SPREADBET_ACCOUNT (or vice-versa).
    // Explicitly switching to whichever type the caller asked for (default
    // SPREADBET, preserving every existing caller's behaviour) prevents this.
    let activeAccountId = data.accountId ?? '';
    const accounts = data.accounts ?? [];
    const targetAccount = accounts.find((a: AccountEntry) => a.accountType === wantedAccountType);

    if (targetAccount && targetAccount.accountId !== activeAccountId) {
      try {
        const switchRes = await fetch(`${baseUrl}/session`, {
          method: 'PUT',
          headers: {
            'X-IG-API-KEY': apiKey,
            'CST': cst,
            'X-SECURITY-TOKEN': securityToken,
            'Content-Type': 'application/json',
            'Accept': 'application/json; charset=UTF-8',
            'Version': '1',
          },
          body: JSON.stringify({ accountId: targetAccount.accountId, dealingEnabled: true }),
        });
        if (switchRes.ok) {
          // IG issues fresh tokens after account switch
          const newCst      = switchRes.headers.get('CST');
          const newSecToken = switchRes.headers.get('X-SECURITY-TOKEN');
          if (newCst)      cst           = newCst;
          if (newSecToken) securityToken = newSecToken;
          activeAccountId = targetAccount.accountId;
          console.log(`[ig/session] Switched to ${wantedAccountType} account ${activeAccountId}`);
        } else {
          const errText = await switchRes.text().catch(() => '');
          console.warn(`[ig/session] Account switch failed (${switchRes.status}):`, errText.slice(0, 200));
        }
      } catch (e) {
        console.warn('[ig/session] Account switch error:', e instanceof Error ? e.message : String(e));
      }
    } else if (targetAccount) {
      console.log(`[ig/session] Already on ${wantedAccountType} account ${activeAccountId}`);
    } else {
      console.log(`[ig/session] No ${wantedAccountType} account found — using default account ${activeAccountId}`);
    }

    const entry = {
      cst,
      securityToken,
      accountId: activeAccountId,
      accounts,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    };
    tokenCache.set(cacheKey, entry);

    return NextResponse.json({
      ok: true,
      cst,
      securityToken,
      accountId: activeAccountId,
      accounts,
      // Kept for existing callers that read this specifically.
      spreadbetAccountId: accounts.find((a: AccountEntry) => a.accountType === 'SPREADBET')?.accountId ?? null,
      accountType: wantedAccountType,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

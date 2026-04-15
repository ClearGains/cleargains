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
    };
    const { password, apiKey, env } = body;
    const forceRefresh = (body as { forceRefresh?: boolean }).forceRefresh === true;
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

    // ── Auto-switch to the SPREADBET account ─────────────────────────────────
    // If the user has both a CFD and a Spread Bet account, IG may default to
    // CFD on login.  Orders placed on the wrong account type are rejected with
    // REJECT_CFD_ORDER_ON_SPREADBET_ACCOUNT (or vice-versa).  Explicitly
    // switching before trading prevents this.
    let activeAccountId = data.accountId ?? '';
    const accounts = data.accounts ?? [];
    const spreadbetAccount = accounts.find((a: AccountEntry) => a.accountType === 'SPREADBET');

    if (spreadbetAccount && spreadbetAccount.accountId !== activeAccountId) {
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
          body: JSON.stringify({ accountId: spreadbetAccount.accountId, dealingEnabled: true }),
        });
        if (switchRes.ok) {
          // IG issues fresh tokens after account switch
          const newCst      = switchRes.headers.get('CST');
          const newSecToken = switchRes.headers.get('X-SECURITY-TOKEN');
          if (newCst)      cst           = newCst;
          if (newSecToken) securityToken = newSecToken;
          activeAccountId = spreadbetAccount.accountId;
          console.log(`[ig/session] Switched to SPREADBET account ${activeAccountId}`);
        } else {
          const errText = await switchRes.text().catch(() => '');
          console.warn(`[ig/session] Account switch failed (${switchRes.status}):`, errText.slice(0, 200));
        }
      } catch (e) {
        console.warn('[ig/session] Account switch error:', e instanceof Error ? e.message : String(e));
      }
    } else if (spreadbetAccount) {
      console.log(`[ig/session] Already on SPREADBET account ${activeAccountId}`);
    } else {
      console.log(`[ig/session] No SPREADBET account found — using default account ${activeAccountId}`);
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
      spreadbetAccountId: spreadbetAccount?.accountId ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

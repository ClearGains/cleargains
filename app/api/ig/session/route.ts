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
      username?: string;
      password?: string;
      apiKey?: string;
      env?: 'demo' | 'live';
      targetAccountId?: string;   // switch to this sub-account after login
      useEnvCredentials?: boolean; // use IG_* env vars instead of body credentials
    };
    const forceRefresh = (body as { forceRefresh?: boolean }).forceRefresh === true;
    const targetAccountId = body.targetAccountId ?? null;

    // Resolve credentials: body fields take priority; fall back to server env vars.
    // This lets the client auto-connect without storing credentials in localStorage.
    const username = ((body.username ?? '').trim().replace(/\s+/g, ''))
      || (process.env.IG_USERNAME ?? '');
    const password = body.password || (process.env.IG_PASSWORD ?? '');
    const apiKey   = body.apiKey   || (process.env.IG_API_KEY  ?? '');
    const env: 'demo' | 'live' = body.env
      ?? (process.env.IG_DEMO === 'true' ? 'demo' : 'live');

    if (!username || !password || !apiKey) {
      return NextResponse.json({ ok: false, error: 'username, password, and apiKey are required (provide in body or set IG_USERNAME / IG_PASSWORD / IG_API_KEY env vars)' }, { status: 400 });
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

    type AccountEntry = { accountId: string; accountName: string; accountType: string; preferred: boolean; status: string; balance?: { balance: number; available: number } };
    const data = await res.json() as {
      accountType?: string;
      accountId?: string;
      accounts?: AccountEntry[];
      clientId?: string;
    };

    // ── Optionally switch to a specific sub-account ──────────────────────────
    // If targetAccountId is given: switch to that account.
    // Otherwise: switch to the SPREADBET account if one exists (backward compat).
    let activeAccountId = data.accountId ?? '';
    const accounts = data.accounts ?? [];
    const spreadbetAccount = accounts.find((a: AccountEntry) => a.accountType === 'SPREADBET');
    const switchTarget = targetAccountId
      ? accounts.find((a: AccountEntry) => a.accountId === targetAccountId)
      : spreadbetAccount;

    if (switchTarget && switchTarget.accountId !== activeAccountId) {
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
          body: JSON.stringify({ accountId: switchTarget.accountId, dealingEnabled: true }),
        });
        if (switchRes.ok) {
          const newCst      = switchRes.headers.get('CST');
          const newSecToken = switchRes.headers.get('X-SECURITY-TOKEN');
          if (newCst)      cst           = newCst;
          if (newSecToken) securityToken = newSecToken;
          activeAccountId = switchTarget.accountId;
          console.log(`[ig/session] Switched to ${switchTarget.accountType} account ${activeAccountId}`);
        } else {
          const errText = await switchRes.text().catch(() => '');
          console.warn(`[ig/session] Account switch failed (${switchRes.status}):`, errText.slice(0, 200));
        }
      } catch (e) {
        console.warn('[ig/session] Account switch error:', e instanceof Error ? e.message : String(e));
      }
    } else if (switchTarget) {
      console.log(`[ig/session] Already on ${switchTarget.accountType} account ${activeAccountId}`);
    } else {
      console.log(`[ig/session] Using default account ${activeAccountId}`);
    }

    // ── Fetch per-account balances from GET /accounts ───────────────────────
    // POST /session does NOT include balance in the accounts array.
    // GET /accounts returns { accounts: [{ accountId, preferred, balance: { balance, available } }] }
    let accountsWithBalance: AccountEntry[] = accounts;
    try {
      const accsRes = await fetch(`${baseUrl}/accounts`, {
        headers: {
          'X-IG-API-KEY': apiKey,
          'CST': cst,
          'X-SECURITY-TOKEN': securityToken,
          'Accept': 'application/json; charset=UTF-8',
          'Version': '1',
        },
        signal: AbortSignal.timeout(5_000),
      });
      if (accsRes.ok) {
        const accsData = await accsRes.json() as {
          accounts?: Array<{ accountId: string; balance?: { balance: number; available: number }; preferred?: boolean }>;
        };
        if (accsData.accounts?.length) {
          const balanceMap = new Map(accsData.accounts.map(a => [a.accountId, a.balance]));
          accountsWithBalance = accounts.map(a => ({
            ...a,
            balance: balanceMap.get(a.accountId) ?? undefined,
          }));
        }
      }
    } catch {
      // Non-fatal — proceed without balance data
    }

    const entry = {
      cst,
      securityToken,
      accountId: activeAccountId,
      accounts: accountsWithBalance,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    };
    tokenCache.set(cacheKey, entry);

    const activeAccount = accountsWithBalance.find((a: AccountEntry) => a.accountId === activeAccountId) ?? null;
    return NextResponse.json({
      ok: true,
      cst,
      securityToken,
      accountId: activeAccountId,
      accountType: activeAccount?.accountType ?? null,
      accounts: accountsWithBalance,
      spreadbetAccountId: spreadbetAccount?.accountId ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

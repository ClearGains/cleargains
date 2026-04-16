import { NextRequest, NextResponse } from 'next/server';

/**
 * IG session — simple login, no account switching.
 *
 * Flow:
 *  1. POST /session with API key + credentials
 *  2. Read CST and X-SECURITY-TOKEN from RESPONSE HEADERS (not body)
 *  3. Cache for 5 hours so repeated calls don't re-login
 *  4. Return tokens — the order route uses them directly
 *
 * No PUT /session, no sub-account switching.  IG lands the session on
 * whichever account is the preferred/default for the credentials supplied.
 */

// ── In-memory session cache ────────────────────────────────────────────────────
// Key = `${env}:${username}:${apiKey}`
const tokenCache = new Map<string, {
  cst:           string;
  securityToken: string;
  accountId:     string;
  accountType:   string | null;
  accounts:      unknown[];
  expiresAt:     number;
}>();

const TOKEN_TTL_MS = 5 * 60 * 60 * 1000; // 5 hours

type AccountEntry = {
  accountId:   string;
  accountName: string;
  accountType: string;
  preferred:   boolean;
  status:      string;
  balance?:    { balance: number; available: number };
};

function igHeaders(apiKey: string, cst: string, secToken: string, version = '1'): Record<string, string> {
  return {
    'X-IG-API-KEY':     apiKey,
    'CST':              cst,
    'X-SECURITY-TOKEN': secToken,
    'Content-Type':     'application/json',
    'Accept':           'application/json; charset=UTF-8',
    'Version':          version,
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      username?:          string;
      password?:          string;
      apiKey?:            string;
      env?:               'demo' | 'live';
      targetAccountId?:   string;   // accepted but ignored — no switching
      useEnvCredentials?: boolean;
      forceRefresh?:      boolean;
    };

    const forceRefresh = body.forceRefresh === true;

    const username = ((body.username ?? '').trim().replace(/\s+/g, ''))
      || (process.env.IG_USERNAME ?? '');
    const password = body.password || (process.env.IG_PASSWORD ?? '');
    const apiKey   = body.apiKey   || (process.env.IG_API_KEY  ?? '');
    const env: 'demo' | 'live' = body.env
      ?? (process.env.IG_DEMO === 'true' ? 'demo' : 'live');

    if (!username || !password || !apiKey) {
      return NextResponse.json(
        { ok: false, error: 'username, password and apiKey are required (or set IG_USERNAME / IG_PASSWORD / IG_API_KEY env vars)' },
        { status: 400 },
      );
    }

    const baseUrl = env === 'demo'
      ? 'https://demo-api.ig.com/gateway/deal'
      : 'https://api.ig.com/gateway/deal';

    // ── Cache lookup ───────────────────────────────────────────────────────────
    const cacheKey = `${env}:${username}:${apiKey}`;
    const cached = tokenCache.get(cacheKey);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      console.log(`[ig/session] Cache hit — accountId=${cached.accountId}`);
      return NextResponse.json({
        ok:            true,
        cst:           cached.cst,
        securityToken: cached.securityToken,
        accountId:     cached.accountId,
        accountType:   cached.accountType,
        accounts:      cached.accounts,
        apiKey,
        spreadbetAccountId: (cached.accounts as AccountEntry[]).find(a => a.accountType === 'SPREADBET')?.accountId ?? null,
      });
    }

    // ── POST /session — login ──────────────────────────────────────────────────
    // CST and X-SECURITY-TOKEN come from RESPONSE HEADERS, not the body.
    console.log(`[ig/session] Logging in as ${username} (env=${env})`);
    const loginRes = await fetch(`${baseUrl}/session`, {
      method:  'POST',
      headers: {
        'X-IG-API-KEY': apiKey,
        'Content-Type': 'application/json',
        'Accept':       'application/json; charset=UTF-8',
        'Version':      '2',
      },
      body: JSON.stringify({ identifier: username, password }),
    });

    if (!loginRes.ok) {
      const text = await loginRes.text().catch(() => '');
      let errMsg = `IG login error ${loginRes.status}`;
      try {
        const j = JSON.parse(text) as { errorCode?: string };
        if (j.errorCode?.includes('identifier') || j.errorCode?.includes('invalid.identifier')) {
          errMsg = 'IG rejected the username — use your IG account number, not your email.';
        } else if (j.errorCode?.includes('password') || j.errorCode?.includes('authentication')) {
          errMsg = 'IG authentication failed — check username and password.';
        } else if (j.errorCode) {
          errMsg = `IG: ${j.errorCode}`;
        }
      } catch {}
      return NextResponse.json({ ok: false, error: errMsg }, { status: loginRes.status });
    }

    // Tokens are in RESPONSE HEADERS for POST /session
    const cst           = loginRes.headers.get('CST') ?? '';
    const securityToken = loginRes.headers.get('X-SECURITY-TOKEN') ?? '';

    if (!cst || !securityToken) {
      return NextResponse.json(
        { ok: false, error: 'IG login succeeded but CST/X-SECURITY-TOKEN missing from response headers' },
        { status: 502 },
      );
    }

    const loginData = await loginRes.json() as {
      currentAccountId?: string;
      accountId?:        string;
      accountType?:      string;
      accounts?:         AccountEntry[];
    };

    const activeAccountId = (loginData.currentAccountId ?? loginData.accountId ?? '').trim();
    let accounts: AccountEntry[] = loginData.accounts ?? [];

    console.log(`[ig/session] Login OK — accountId=${activeAccountId || '(empty)'}, accounts=${accounts.length}`);

    // ── Fetch accounts list if not in login response ───────────────────────────
    if (accounts.length === 0) {
      try {
        const accsRes = await fetch(`${baseUrl}/accounts`, {
          headers: igHeaders(apiKey, cst, securityToken),
          signal:  AbortSignal.timeout(5_000),
        });
        if (accsRes.ok) {
          const d = await accsRes.json() as { accounts?: AccountEntry[] };
          accounts = d.accounts ?? [];
          console.log(`[ig/session] Fetched ${accounts.length} accounts from GET /accounts`);
        }
      } catch (e) {
        console.warn('[ig/session] GET /accounts failed:', e instanceof Error ? e.message : e);
      }
    }

    // ── Fetch account balances ─────────────────────────────────────────────────
    let accountsWithBalance: AccountEntry[] = accounts;
    try {
      const accsRes = await fetch(`${baseUrl}/accounts`, {
        headers: igHeaders(apiKey, cst, securityToken),
        signal:  AbortSignal.timeout(5_000),
      });
      if (accsRes.ok) {
        const d = await accsRes.json() as {
          accounts?: Array<{ accountId: string; balance?: { balance: number; available: number } }>;
        };
        if (d.accounts?.length) {
          const balMap = new Map(d.accounts.map(a => [a.accountId, a.balance]));
          accountsWithBalance = accounts.map(a => ({ ...a, balance: balMap.get(a.accountId) ?? undefined }));
        }
      }
    } catch { /* non-fatal */ }

    const activeAccount = accountsWithBalance.find(a => a.accountId === activeAccountId) ?? null;
    console.log(`[ig/session] Session ready — accountId=${activeAccountId} accountType=${activeAccount?.accountType ?? 'unknown'}`);

    // ── Cache and return ───────────────────────────────────────────────────────
    tokenCache.set(cacheKey, {
      cst,
      securityToken,
      accountId:   activeAccountId,
      accountType: activeAccount?.accountType ?? null,
      accounts:    accountsWithBalance,
      expiresAt:   Date.now() + TOKEN_TTL_MS,
    });

    return NextResponse.json({
      ok:            true,
      cst,
      securityToken,
      accountId:     activeAccountId,
      accountType:   activeAccount?.accountType ?? null,
      accounts:      accountsWithBalance,
      apiKey,
      spreadbetAccountId: accountsWithBalance.find(a => a.accountType === 'SPREADBET')?.accountId ?? null,
    });

  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

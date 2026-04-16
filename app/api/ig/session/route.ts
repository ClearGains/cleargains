import { NextRequest, NextResponse } from 'next/server';

/**
 * In-memory session cache.
 * Key = `${env}:${username}:${apiKey}:${targetAccountId}`
 * Each account gets its own entry — CFD and SB never share.
 */
const tokenCache = new Map<string, {
  cst: string;
  securityToken: string;
  accountId: string;
  accountType: string | null;
  accounts: unknown[];
  expiresAt: number;
}>();

const TOKEN_TTL_MS = 5 * 60 * 60 * 1000; // 5 hours

type AccountEntry = {
  accountId: string;
  accountName: string;
  accountType: string;
  preferred: boolean;
  status: string;
  balance?: { balance: number; available: number };
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
      username?: string;
      password?: string;
      apiKey?: string;
      env?: 'demo' | 'live';
      targetAccountId?: string;
      useEnvCredentials?: boolean;
      forceRefresh?: boolean;
    };

    const forceRefresh    = body.forceRefresh === true;
    const targetAccountId = (body.targetAccountId ?? '').trim();

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

    // ── Per-account cache — never share between CFD and SB ─────────────────
    const cacheKey = `${env}:${username}:${apiKey}:${targetAccountId || 'default'}`;
    const cached = tokenCache.get(cacheKey);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      return NextResponse.json({
        ok: true,
        cst:           cached.cst,
        securityToken: cached.securityToken,
        accountId:     cached.accountId,
        accountType:   cached.accountType,
        accounts:      cached.accounts,
      });
    }

    // ── STEP 1: POST /session — login ───────────────────────────────────────
    const loginRes = await fetch(`${baseUrl}/session`, {
      method: 'POST',
      headers: {
        'X-IG-API-KEY':  apiKey,
        'Content-Type':  'application/json',
        'Accept':        'application/json; charset=UTF-8',
        'Version':       '2',
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

    // Tokens are in RESPONSE HEADERS (not body) for POST /session
    let cst           = loginRes.headers.get('CST') ?? '';
    let securityToken = loginRes.headers.get('X-SECURITY-TOKEN') ?? '';

    const loginData = await loginRes.json() as {
      currentAccountId?: string;
      accountId?:        string;
      accountType?:      string;
      accounts?:         AccountEntry[];
      clientId?:         string;
    };

    // IG Version 2 uses "currentAccountId"; older versions use "accountId"
    let activeAccountId = (loginData.currentAccountId ?? loginData.accountId ?? '').trim();
    let accounts: AccountEntry[] = loginData.accounts ?? [];

    console.log(`[ig/session] POST login OK — defaultAccount=${activeAccountId || '(empty)'}, accounts=${accounts.length}`);

    // ── STEP 2: If accounts list is empty, fetch it separately ─────────────
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

    // ── STEP 3: Switch account if needed ────────────────────────────────────
    if (targetAccountId && activeAccountId !== targetAccountId) {
      console.log(`[ig/session] Need to switch from ${activeAccountId || '(unknown)'} → ${targetAccountId}`);

      // Helper: PUT /session to switch to an account, update cst/securityToken from headers
      const doPutSwitch = async (toAccountId: string): Promise<{ ok: boolean; status: number; body: string }> => {
        const body = JSON.stringify({ accountId: toAccountId });
        console.log(`[ig/session] PUT /session { accountId: ${toAccountId} }`);
        const res = await fetch(`${baseUrl}/session`, {
          method: 'PUT',
          headers: {
            'X-IG-API-KEY':     apiKey,
            'CST':              cst,
            'X-SECURITY-TOKEN': securityToken,
            'Content-Type':     'application/json',
            'Accept':           'application/json; charset=UTF-8',
            'Version':          '1',
          },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        const text = await res.text().catch(() => '');
        console.log(`[ig/session] PUT → ${res.status} | body=${text.slice(0, 200)}`);
        if (res.ok) {
          const nc = res.headers.get('CST');
          const ns = res.headers.get('X-SECURITY-TOKEN');
          if (nc) cst = nc;
          if (ns) securityToken = ns;
          console.log(`[ig/session] Tokens after switch to ${toAccountId}: cst=${nc ? 'new' : 'unchanged'} sec=${ns ? 'new' : 'unchanged'}`);
        }
        return { ok: res.ok, status: res.status, body: text };
      };

      // Find the target account type
      const targetEntry = accounts.find(a => a.accountId === targetAccountId);
      const targetType  = targetEntry?.accountType ?? 'UNKNOWN';
      const sbAccount   = accounts.find(a => a.accountType === 'SPREADBET');
      console.log(`[ig/session] Target type=${targetType}; spreadbetAccount=${sbAccount?.accountId ?? 'none'}`);

      // Two-step switch: if switching to a non-SPREADBET account, land on SPREADBET first.
      // IG sessions always default to the SPREADBET account — switching directly to CFD
      // fails with 401/502.  Landing on SPREADBET first establishes a clean token state.
      if (targetType !== 'SPREADBET' && sbAccount && activeAccountId !== sbAccount.accountId) {
        console.log(`[ig/session] Step A: landing on SPREADBET ${sbAccount.accountId} first…`);
        const stepA = await doPutSwitch(sbAccount.accountId);
        if (stepA.ok) {
          console.log(`[ig/session] Step A OK — now on ${sbAccount.accountId}`);
          await new Promise(r => setTimeout(r, 400)); // brief pause before step B
        } else {
          console.warn(`[ig/session] Step A failed (${stepA.status}) — attempting direct switch anyway`);
        }
      }

      // Step B (or only step): switch to the actual target
      console.log(`[ig/session] Step B: switching to ${targetAccountId} (${targetType})`);
      let putRes = await doPutSwitch(targetAccountId);

      // Retry once on transient 5xx
      if (putRes.status >= 500) {
        await new Promise(r => setTimeout(r, 800));
        console.log(`[ig/session] Step B retry…`);
        putRes = await doPutSwitch(targetAccountId);
      }

      if (!putRes.ok) {
        return NextResponse.json({
          ok:    false,
          error: `Account switch to ${targetAccountId} failed — IG returned ${putRes.status}: ${putRes.body.slice(0, 200)}`,
        }, { status: 502 });
      }

      // ── STEP 4: GET /session to confirm the active account ────────────────
      let confirmedId = '';
      try {
        const getRes = await fetch(`${baseUrl}/session`, {
          headers: igHeaders(apiKey, cst, securityToken),
          signal:  AbortSignal.timeout(5_000),
        });
        const getBody = getRes.ok ? await getRes.json() as Record<string, unknown> : {};
        confirmedId = ((getBody.currentAccountId ?? getBody.accountId ?? '') as string).trim();
        console.log(`[ig/session] GET /session after switch → status=${getRes.status} currentAccountId=${confirmedId || '(empty)'}`);
      } catch (e) {
        console.warn('[ig/session] GET /session confirmation failed:', e instanceof Error ? e.message : e);
      }

      if (confirmedId && confirmedId !== targetAccountId) {
        // Switch did not take effect — return explicit failure
        return NextResponse.json({
          ok:    false,
          error: `Account switch to ${targetAccountId} failed — IG confirms active account is ${confirmedId}. ` +
                 `This usually means the account is unavailable or trading is disabled on it.`,
          confirmedAccountId: confirmedId,
        }, { status: 409 });
      }

      // Success — use confirmed ID if we got one, otherwise trust PUT 200
      activeAccountId = confirmedId || targetAccountId;
      console.log(`[ig/session] Switch confirmed: activeAccountId=${activeAccountId}`);

    } else if (targetAccountId && activeAccountId === targetAccountId) {
      console.log(`[ig/session] Already on target account ${targetAccountId} — no switch needed`);
    } else {
      console.log(`[ig/session] No targetAccountId — using default ${activeAccountId}`);
    }

    // ── STEP 5: Fetch account balances ──────────────────────────────────────
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
    console.log(`[ig/session] Final: accountId=${activeAccountId} accountType=${activeAccount?.accountType ?? 'unknown'}`);

    const entry = {
      cst,
      securityToken,
      accountId:   activeAccountId,
      accountType: activeAccount?.accountType ?? null,
      accounts:    accountsWithBalance,
      expiresAt:   Date.now() + TOKEN_TTL_MS,
    };
    tokenCache.set(cacheKey, entry);

    return NextResponse.json({
      ok:            true,
      cst,
      securityToken,
      accountId:     activeAccountId,
      accountType:   activeAccount?.accountType ?? null,
      accounts:      accountsWithBalance,
      apiKey,
      spreadbetAccountId: accounts.find(a => a.accountType === 'SPREADBET')?.accountId ?? null,
    });

  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

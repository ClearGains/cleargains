import { NextRequest, NextResponse } from 'next/server';

/**
 * IG session management — single shared session per credentials.
 *
 * Architecture:
 *  - ONE cache entry per {env, username, apiKey} — both CFD and spread-bet
 *    accounts share the same CST / X-SECURITY-TOKEN pair.
 *  - Cache records which account is currently active.
 *  - If the requested targetAccountId already matches the cached account → fast
 *    return (no IG call needed).
 *  - If targetAccountId differs → PUT /session to switch (no full re-login),
 *    update cache, return fresh tokens.
 *  - Full login only on cache miss / expiry.
 *  - Server-side mutex per credential set prevents concurrent switch races.
 */

// ── In-memory session cache ────────────────────────────────────────────────────
// Key = `${env}:${username}:${apiKey}` — shared across both account types.
const tokenCache = new Map<string, {
  cst:           string;
  securityToken: string;
  accountId:     string;   // currently active account on this IG session
  accountType:   string | null;
  accounts:      unknown[];
  expiresAt:     number;
}>();

const TOKEN_TTL_MS = 5 * 60 * 60 * 1000; // 5 hours

// ── Per-credentials switch lock ────────────────────────────────────────────────
// Prevents two simultaneous requests racing through account-switch logic.
const switchLocks = new Map<string, Promise<unknown>>();

function withSwitchLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev   = switchLocks.get(key) ?? Promise.resolve();
  const result = prev.then(() => fn());
  // Extend the chain so the next caller waits for this one
  switchLocks.set(key, result.then(() => {}, () => {}));
  return result;
}

// ── Types ──────────────────────────────────────────────────────────────────────
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

// ── Account switch helper ──────────────────────────────────────────────────────
// Performs the minimal PUT /session sequence needed to reach targetAccountId.
// Returns updated { cst, securityToken } or null on failure.
async function doAccountSwitch(
  baseUrl:       string,
  apiKey:        string,
  cst:           string,
  secToken:      string,
  fromAccountId: string,
  targetId:      string,
  accounts:      AccountEntry[],
): Promise<{ cst: string; securityToken: string } | null> {

  let curCst = cst, curSec = secToken;

  const doPut = async (toId: string): Promise<boolean> => {
    console.log(`[ig/session] PUT /session { accountId: ${toId} }`);
    const res = await fetch(`${baseUrl}/session`, {
      method:  'PUT',
      headers: {
        'X-IG-API-KEY':     apiKey,
        'CST':              curCst,
        'X-SECURITY-TOKEN': curSec,
        'Content-Type':     'application/json',
        'Accept':           'application/json; charset=UTF-8',
        'Version':          '1',
      },
      body:   JSON.stringify({ accountId: toId }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text().catch(() => '');
    console.log(`[ig/session] PUT → ${res.status}${text ? ' | ' + text.slice(0, 120) : ''}`);
    if (res.ok) {
      const nc = res.headers.get('CST');
      const ns = res.headers.get('X-SECURITY-TOKEN');
      if (nc) curCst = nc;
      if (ns) curSec = ns;
      console.log(`[ig/session] Tokens after switch to ${toId}: cst=${nc ? 'new' : 'unchanged'} sec=${ns ? 'new' : 'unchanged'}`);
    }
    return res.ok;
  };

  // Two-step switch: if targeting a non-SPREADBET account, land on SPREADBET first.
  // IG sessions default to the SPREADBET account; switching directly to CFD can
  // fail with 401/502.  A brief stop on SPREADBET stabilises the token state.
  const targetType = accounts.find(a => a.accountId === targetId)?.accountType ?? '';
  const sbAccount  = accounts.find(a => a.accountType === 'SPREADBET');

  if (targetType !== 'SPREADBET' && sbAccount && fromAccountId !== sbAccount.accountId) {
    console.log(`[ig/session] Step A: landing on SPREADBET ${sbAccount.accountId} first…`);
    const ok = await doPut(sbAccount.accountId);
    if (ok) {
      console.log(`[ig/session] Step A OK`);
      await new Promise(r => setTimeout(r, 400));
    } else {
      console.warn(`[ig/session] Step A failed — attempting direct switch anyway`);
    }
  }

  console.log(`[ig/session] Step B: switching to ${targetId} (${targetType || 'unknown'})`);
  let ok = await doPut(targetId);

  // Retry once on transient 5xx
  if (!ok) {
    await new Promise(r => setTimeout(r, 800));
    console.log(`[ig/session] Step B retry…`);
    ok = await doPut(targetId);
  }

  return ok ? { cst: curCst, securityToken: curSec } : null;
}

// ── Route handler ─────────────────────────────────────────────────────────────
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      username?:          string;
      password?:          string;
      apiKey?:            string;
      env?:               'demo' | 'live';
      targetAccountId?:   string;
      useEnvCredentials?: boolean;
      forceRefresh?:      boolean;
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

    // ── Shared cache key (no accountId — both tabs share one IG session) ────
    const cacheKey = `${env}:${username}:${apiKey}`;

    return withSwitchLock(cacheKey, async () => {

      // ── Fast path: already on the right account ────────────────────────────
      const cached = tokenCache.get(cacheKey);
      if (!forceRefresh && cached && cached.expiresAt > Date.now()) {

        if (!targetAccountId || cached.accountId === targetAccountId) {
          console.log(`[ig/session] Cache hit — already on ${cached.accountId}`);
          return NextResponse.json({
            ok: true,
            cst:           cached.cst,
            securityToken: cached.securityToken,
            accountId:     cached.accountId,
            accountType:   cached.accountType,
            accounts:      cached.accounts,
            apiKey,
            spreadbetAccountId: (cached.accounts as AccountEntry[]).find(a => a.accountType === 'SPREADBET')?.accountId ?? null,
          });
        }

        // ── Quick-switch path: valid session, just wrong account ─────────────
        console.log(`[ig/session] Quick switch ${cached.accountId} → ${targetAccountId}`);
        const switched = await doAccountSwitch(
          baseUrl, apiKey,
          cached.cst, cached.securityToken,
          cached.accountId, targetAccountId,
          cached.accounts as AccountEntry[],
        );

        if (switched) {
          // Confirm via GET /session
          let confirmedId = targetAccountId;
          try {
            const getRes = await fetch(`${baseUrl}/session`, {
              headers: igHeaders(apiKey, switched.cst, switched.securityToken),
              signal:  AbortSignal.timeout(5_000),
            });
            const getBody = getRes.ok ? await getRes.json() as Record<string, unknown> : {};
            const confirmed = ((getBody.currentAccountId ?? getBody.accountId ?? '') as string).trim();
            if (confirmed) confirmedId = confirmed;
          } catch {}

          if (confirmedId !== targetAccountId) {
            return NextResponse.json({
              ok: false,
              error: `Account switch to ${targetAccountId} failed — IG confirms active account is ${confirmedId}.`,
              confirmedAccountId: confirmedId,
            }, { status: 409 });
          }

          const activeEntry = (cached.accounts as AccountEntry[]).find(a => a.accountId === confirmedId);
          const updated = {
            ...cached,
            cst:           switched.cst,
            securityToken: switched.securityToken,
            accountId:     confirmedId,
            accountType:   activeEntry?.accountType ?? cached.accountType,
            expiresAt:     Date.now() + TOKEN_TTL_MS,
          };
          tokenCache.set(cacheKey, updated);

          console.log(`[ig/session] Quick switch confirmed → ${confirmedId}`);
          return NextResponse.json({
            ok: true,
            cst:           updated.cst,
            securityToken: updated.securityToken,
            accountId:     updated.accountId,
            accountType:   updated.accountType,
            accounts:      updated.accounts,
            apiKey,
            spreadbetAccountId: (updated.accounts as AccountEntry[]).find(a => a.accountType === 'SPREADBET')?.accountId ?? null,
          });
        }

        // Quick-switch failed — fall through to full login below
        console.warn(`[ig/session] Quick switch failed — falling back to full login`);
      }

      // ── Full login ─────────────────────────────────────────────────────────
      console.log(`[ig/session] Full login for ${username} (env=${env})`);
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

      let cst           = loginRes.headers.get('CST') ?? '';
      let securityToken = loginRes.headers.get('X-SECURITY-TOKEN') ?? '';

      const loginData = await loginRes.json() as {
        currentAccountId?: string;
        accountId?:        string;
        accountType?:      string;
        accounts?:         AccountEntry[];
        clientId?:         string;
      };

      let activeAccountId = (loginData.currentAccountId ?? loginData.accountId ?? '').trim();
      let accounts: AccountEntry[] = loginData.accounts ?? [];

      console.log(`[ig/session] Login OK — defaultAccount=${activeAccountId || '(empty)'}, accounts=${accounts.length}`);

      // Fetch accounts list if not included in login response
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

      // Switch to targetAccountId if needed
      if (targetAccountId && activeAccountId !== targetAccountId) {
        const switched = await doAccountSwitch(
          baseUrl, apiKey, cst, securityToken,
          activeAccountId, targetAccountId, accounts,
        );

        if (!switched) {
          return NextResponse.json({
            ok:    false,
            error: `Account switch to ${targetAccountId} failed after login`,
          }, { status: 502 });
        }

        cst           = switched.cst;
        securityToken = switched.securityToken;

        // Confirm
        let confirmedId = '';
        try {
          const getRes = await fetch(`${baseUrl}/session`, {
            headers: igHeaders(apiKey, cst, securityToken),
            signal:  AbortSignal.timeout(5_000),
          });
          const getBody = getRes.ok ? await getRes.json() as Record<string, unknown> : {};
          confirmedId = ((getBody.currentAccountId ?? getBody.accountId ?? '') as string).trim();
          console.log(`[ig/session] GET /session after switch → ${confirmedId || '(empty)'}`);
        } catch (e) {
          console.warn('[ig/session] GET /session confirmation failed:', e instanceof Error ? e.message : e);
        }

        if (confirmedId && confirmedId !== targetAccountId) {
          return NextResponse.json({
            ok:    false,
            error: `Account switch to ${targetAccountId} failed — IG confirms active account is ${confirmedId}.`,
            confirmedAccountId: confirmedId,
          }, { status: 409 });
        }

        activeAccountId = confirmedId || targetAccountId;
        console.log(`[ig/session] Switch confirmed: ${activeAccountId}`);

      } else if (targetAccountId && activeAccountId === targetAccountId) {
        console.log(`[ig/session] Already on target account ${targetAccountId}`);
      }

      // Fetch balances
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

      // Store in shared cache
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

    }); // end withSwitchLock

  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

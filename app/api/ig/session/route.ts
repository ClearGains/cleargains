import { NextRequest, NextResponse } from 'next/server';
import { publicEncrypt, constants, createPublicKey } from 'crypto';

/** In-memory token cache: { cacheKey → { cst, securityToken, accountId, accounts, expiresAt } } */
const tokenCache = new Map<string, {
  cst: string;
  securityToken: string;
  accountId: string;
  accounts: unknown[];
  expiresAt: number;
}>();

const TOKEN_TTL_MS = 5 * 60 * 60 * 1000; // 5 hours (IG tokens last 6h; refresh before expiry)

// IG migrated-account auth: fetch RSA key then encrypt password|timestamp
// Key comes back as raw base64-encoded DER (SPKI format) — load it directly
// rather than wrapping in PEM, which requires 64-char line breaks to parse.
async function getEncryptedPassword(baseUrl: string, apiKey: string, password: string): Promise<string> {
  const keyRes = await fetch(`${baseUrl}/session/encryptionKey`, {
    headers: { 'X-IG-API-KEY': apiKey, 'Version': '1', 'Accept': 'application/json; charset=UTF-8' },
  });
  if (!keyRes.ok) throw new Error(`IG encryption key fetch failed (${keyRes.status})`);
  const { encryptionKey, timeStamp } = await keyRes.json() as { encryptionKey: string; timeStamp: string | number };
  const publicKey = createPublicKey({ key: Buffer.from(encryptionKey, 'base64'), format: 'der', type: 'spki' });
  const encrypted = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(`${password}|${timeStamp}`));
  return encrypted.toString('base64');
}

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

    console.log(`[ig/session] ${env} login attempt for identifier="${username}" baseUrl=${baseUrl}`);

    let res = await fetch(`${baseUrl}/session`, {
      method: 'POST',
      headers: {
        'X-IG-API-KEY': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json; charset=UTF-8',
        'Version': '2',
      },
      body: JSON.stringify({ identifier: username, password }),
    });

    // Migrated accounts require RSA-encrypted password — retry automatically
    if (!res.ok) {
      const text = await res.text();
      let errorCode = '';
      try { errorCode = (JSON.parse(text) as { errorCode?: string }).errorCode ?? ''; } catch { /* noop */ }
      console.log(`[ig/session] plain-password attempt failed: status=${res.status} errorCode="${errorCode}" body=${text.slice(0, 300)}`);

      if (errorCode.includes('account-migrated')) {
        console.log(`[ig/session] account-migrated detected — attempting encrypted-password retry`);
        try {
          const encPwd = await getEncryptedPassword(baseUrl, apiKey, password);
          console.log(`[ig/session] encrypted password obtained (length=${encPwd.length}), retrying session`);
          const encRes = await fetch(`${baseUrl}/session`, {
            method: 'POST',
            headers: {
              'X-IG-API-KEY': apiKey,
              'Content-Type': 'application/json',
              'Accept': 'application/json; charset=UTF-8',
              'Version': '2',
            },
            body: JSON.stringify({ identifier: username, password: encPwd, encryptedPassword: true }),
          });
          const encText = await encRes.text();
          console.log(`[ig/session] encrypted-password retry: status=${encRes.status} body=${encText.slice(0, 300)}`);
          if (!encRes.ok) {
            let encCode = '';
            try { encCode = (JSON.parse(encText) as { errorCode?: string }).errorCode ?? ''; } catch { /* noop */ }
            tokenCache.delete(`${env}:${username}:${apiKey}`);
            return NextResponse.json({
              ok: false,
              error: `IG encrypted auth failed (${encRes.status}): ${encCode || encText.slice(0, 120)}`,
            }, { status: encRes.status });
          }
          // Reconstruct a Response object from the already-read body so the rest of the handler can parse it
          res = new Response(encText, { status: encRes.status, headers: encRes.headers });
        } catch (encErr) {
          console.error(`[ig/session] encrypted auth exception:`, encErr);
          tokenCache.delete(`${env}:${username}:${apiKey}`);
          return NextResponse.json({ ok: false, error: `IG account migrated — encrypted auth exception: ${encErr instanceof Error ? encErr.message : String(encErr)}` }, { status: 401 });
        }
      }
    }

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
      tokenCache.delete(`${env}:${username}:${apiKey}`);

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

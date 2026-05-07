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

    function parseCode(text: string) {
      try { return (JSON.parse(text) as { errorCode?: string }).errorCode ?? ''; } catch { return ''; }
    }
    function igErrMsg(code: string, status: number, context?: 'encrypted') {
      if (code.includes('authenticationRequest.identifier') || code.includes('invalid.identifier'))
        return 'IG rejected the username. Use your IG account number (e.g. Z12345), not your email. Find it in the IG app → My Account → Account details.';
      if (code.includes('invalid.password') || code.includes('authentication'))
        return 'IG authentication failed — check your username and password are correct.';
      if (code.includes('exceed-login-session-limit') || code.includes('session-limit'))
        return 'IG session limit reached. Log out of the IG web platform or other devices, wait a minute, then try again.';
      if (code.includes('account-migrated'))
        return context === 'encrypted'
          ? `IG still rejecting after encrypted-password retry. Most likely cause: you are entering ${env.toUpperCase()} credentials in the wrong tab — IG Demo and Live are completely separate accounts with different account numbers and passwords. If your credentials are correct for this environment, your account may require IG support to re-enable API access.`
          : `IG account migrated — attempting encrypted password retry…`;
      if (status === 500)
        return code ? `IG server error: ${code}` : 'IG server returned 500 — usually temporary. Try again in 1–2 minutes.';
      return code ? `IG: ${code}` : `IG API error ${status}`;
    }

    console.log(`[ig/session] ${env} login attempt identifier="${username}"`);

    // Step 1: plain-password attempt — read body exactly once
    const plainRes  = await fetch(`${baseUrl}/session`, {
      method: 'POST',
      headers: { 'X-IG-API-KEY': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json; charset=UTF-8', 'Version': '2' },
      body: JSON.stringify({ identifier: username, password }),
    });
    const plainText = await plainRes.text();
    const plainCode = parseCode(plainText);
    console.log(`[ig/session] plain: status=${plainRes.status} code="${plainCode}"`);

    // sessionText / sessionHeaders point to whichever attempt succeeded
    let sessionText: string;
    let sessionHeaders: Headers;

    if (!plainRes.ok) {
      if (plainCode.includes('account-migrated')) {
        // Step 2: encrypted-password retry — body read exactly once
        let encPwd: string;
        try {
          encPwd = await getEncryptedPassword(baseUrl, apiKey, password);
          console.log(`[ig/session] encrypted pwd obtained length=${encPwd.length}`);
        } catch (e) {
          tokenCache.delete(cacheKey);
          return NextResponse.json({ ok: false, error: `IG encrypted auth exception: ${e instanceof Error ? e.message : String(e)}` }, { status: 401 });
        }
        const encRes  = await fetch(`${baseUrl}/session`, {
          method: 'POST',
          headers: { 'X-IG-API-KEY': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json; charset=UTF-8', 'Version': '2' },
          body: JSON.stringify({ identifier: username, password: encPwd, encryptedPassword: true }),
        });
        const encText = await encRes.text();
        const encCode = parseCode(encText);
        console.log(`[ig/session] encrypted: status=${encRes.status} code="${encCode}"`);
        if (!encRes.ok) {
          tokenCache.delete(cacheKey);
          return NextResponse.json({ ok: false, error: igErrMsg(encCode, encRes.status, 'encrypted') }, { status: encRes.status });
        }
        sessionText    = encText;
        sessionHeaders = encRes.headers;
      } else {
        tokenCache.delete(cacheKey);
        return NextResponse.json({ ok: false, error: igErrMsg(plainCode, plainRes.status) }, { status: plainRes.status });
      }
    } else {
      sessionText    = plainText;
      sessionHeaders = plainRes.headers;
    }

    // IG returns session tokens in RESPONSE HEADERS (not body)
    let cst           = sessionHeaders.get('CST') ?? '';
    let securityToken = sessionHeaders.get('X-SECURITY-TOKEN') ?? '';

    type AccountEntry = { accountId: string; accountName: string; accountType: string; preferred: boolean; status: string };
    const data = JSON.parse(sessionText) as {
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

import { NextRequest, NextResponse } from 'next/server';
import { resolveIgAuth, igRequestHeaders } from '@/lib/igAuthHeaders';

type RawPositionEntry = {
  position?: {
    dealId?: string; size?: number; direction?: string; level?: number;
    currency?: string; stopLevel?: number; limitLevel?: number;
    contractSize?: number; createdDate?: string; createdDateUTC?: string;
  };
  market?: {
    epic?: string; instrumentName?: string; bid?: number; offer?: number;
    instrumentType?: string; netChange?: number; percentageChange?: number;
  };
};

type RawPositionsData = { positions?: RawPositionEntry[] };

// The legacy session used everywhere else on this page is pinned to
// whichever account it authenticated onto — for every account seen so far
// that's the SPREADBET one (e.g. live: PTG8S), never the separate CFD
// sub-account IG also creates under the same login (e.g. live: PTG8T,
// confirmed live via a one-off OAuth-login check). Querying /positions/otc
// with a session pinned to the wrong account type is what IG reports back
// as error.security.api-key-disabled — a misleading label for "wrong
// account for this endpoint", not an actual disabled key. OAuth sessions
// aren't pinned to one account (every request carries its own
// IG-ACCOUNT-ID), so this does a short-lived, standalone OAuth login
// scoped to the CFD account specifically, purely to read its positions —
// deliberately not touching or reusing the shared legacy session that the
// persistent live/demo trading bots depend on.
async function fetchOAuthCfdPositions(baseUrl: string, env: 'demo' | 'live'): Promise<{ positions: RawPositionEntry[]; step: string }> {
  const prefix   = env === 'demo' ? 'IG_DEMO_' : 'IG_LIVE_';
  const apiKey   = process.env[`${prefix}API_KEY`];
  const username = process.env[`${prefix}USERNAME`];
  const password = process.env[`${prefix}PASSWORD`];
  if (!apiKey || !username || !password) {
    return { positions: [], step: `[CFD-OAuth] ${prefix}API_KEY/USERNAME/PASSWORD not configured — skipping CFD account` };
  }

  let accessToken = '';
  let cfdAccountId = '';
  try {
    const loginRes = await fetch(`${baseUrl}/session`, {
      method: 'POST',
      headers: { 'X-IG-API-KEY': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json; charset=UTF-8', 'Version': '3' },
      body: JSON.stringify({ identifier: username, password, encryptedPassword: false }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!loginRes.ok) return { positions: [], step: `[CFD-OAuth] login failed ${loginRes.status}` };
    const loginData = await loginRes.json() as { accountId?: string; oauthToken?: { access_token?: string } };
    accessToken = loginData.oauthToken?.access_token ?? '';
    if (!accessToken) return { positions: [], step: '[CFD-OAuth] login succeeded but no access token returned' };

    const acctRes = await fetch(`${baseUrl}/accounts`, {
      headers: { 'X-IG-API-KEY': apiKey, 'Authorization': `Bearer ${accessToken}`, 'IG-ACCOUNT-ID': loginData.accountId ?? '', 'Accept': 'application/json; charset=UTF-8', 'Version': '1' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!acctRes.ok) return { positions: [], step: `[CFD-OAuth] account lookup failed ${acctRes.status}` };
    const acctData = await acctRes.json() as { accounts?: Array<{ accountId: string; accountType: string }> };
    cfdAccountId = acctData.accounts?.find(a => a.accountType === 'CFD')?.accountId ?? '';
    if (!cfdAccountId) return { positions: [], step: '[CFD-OAuth] no CFD account found on this login' };

    const posRes = await fetch(`${baseUrl}/positions`, {
      headers: { 'X-IG-API-KEY': apiKey, 'Authorization': `Bearer ${accessToken}`, 'IG-ACCOUNT-ID': cfdAccountId, 'Accept': 'application/json; charset=UTF-8', 'Version': '2' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!posRes.ok) return { positions: [], step: `[CFD-OAuth] positions fetch failed ${posRes.status}` };
    const posData = await posRes.json() as RawPositionsData;
    return { positions: posData.positions ?? [], step: `[CFD-OAuth] account=${cfdAccountId} — ${posData.positions?.length ?? 0} position(s)` };
  } catch (e) {
    return { positions: [], step: `[CFD-OAuth] exception: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    if (accessToken) {
      try { await fetch(`${baseUrl}/session`, { method: 'DELETE', headers: { 'X-IG-API-KEY': apiKey, 'Authorization': `Bearer ${accessToken}`, 'IG-ACCOUNT-ID': cfdAccountId, 'Accept': 'application/json; charset=UTF-8', 'Version': '1' } }); } catch { /* best-effort */ }
    }
  }
}

function normalisePositions(data: RawPositionsData) {
  return (data.positions ?? []).map(p => {
    const direction = p.position?.direction ?? '';
    const level     = p.position?.level ?? 0;
    const size      = p.position?.size ?? 0;
    const bid       = p.market?.bid ?? 0;
    const offer     = p.market?.offer ?? 0;
    const upl = direction === 'BUY'
      ? (bid   - level) * size
      : (level - offer) * size;
    return {
      dealId:         p.position?.dealId         ?? '',
      direction,
      size,
      level,
      upl:            Math.round(upl * 100) / 100,
      currency:       p.position?.currency        ?? 'GBP',
      stopLevel:      p.position?.stopLevel,
      limitLevel:     p.position?.limitLevel,
      contractSize:   p.position?.contractSize,
      createdDate:    p.position?.createdDateUTC ?? p.position?.createdDate,
      epic:           p.market?.epic              ?? '',
      instrumentName: p.market?.instrumentName    ?? '',
      bid,
      offer,
      instrumentType: p.market?.instrumentType,
    };
  });
}

export async function GET(request: NextRequest) {
  const steps: string[] = [];
  try {
    const env = (request.headers.get('x-ig-env') ?? 'demo') as 'demo' | 'live';
    const auth = resolveIgAuth(request);

    steps.push(`[1] env=${env}, auth=${auth?.style ?? 'MISSING'}`);

    if (!auth) {
      steps.push('[1] ✗ Missing auth headers — aborting');
      return NextResponse.json({ ok: false, error: 'Missing IG auth headers', steps }, { status: 401 });
    }

    const baseUrl = env === 'demo'
      ? 'https://demo-api.ig.com/gateway/deal'
      : 'https://api.ig.com/gateway/deal';

    // IG Spread Bet accounts use /positions (not /positions/otc).
    // Try /positions first; if that 404s, fall back to /positions/otc (CFD).
    const endpoints = [
      { path: `${baseUrl}/positions`,     version: '2', label: '/positions V2 (spreadbet)'  },
      { path: `${baseUrl}/positions/otc`, version: '2', label: '/positions/otc V2 (CFD)'    },
    ];

    let rawText = '';
    let usedLabel = '';
    for (const ep of endpoints) {
      steps.push(`[2] Trying ${ep.label}`);
      const r = await fetch(ep.path, { headers: igRequestHeaders(auth, ep.version) });
      steps.push(`[2] HTTP ${r.status}`);
      if (r.ok) {
        rawText   = await r.text();
        usedLabel = ep.label;
        break;
      }
      const errBody = await r.text().catch(() => '');
      steps.push(`[2] ${ep.label} error: ${errBody.slice(0, 150)}`);
    }

    let data: RawPositionsData = {};
    if (!rawText) {
      steps.push('[2] ✗ All legacy-session endpoints returned errors');
    } else {
      steps.push(`[3] Got response via ${usedLabel} — length ${rawText.length}`);
      try {
        data = JSON.parse(rawText) as RawPositionsData;
      } catch (parseErr) {
        steps.push(`[3] ✗ JSON parse error: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
        return NextResponse.json({ ok: false, error: 'JSON parse error', steps, rawResponse: rawText.slice(0, 500) }, { status: 500 });
      }
    }

    // The legacy session above is pinned to whichever account it logged
    // into (always SPREADBET so far) and can't see a separate CFD
    // sub-account's positions no matter which endpoint is tried — see
    // fetchOAuthCfdPositions's own comment. Only attempted when this auth
    // style is legacy; an OAuth-style caller already addresses whichever
    // single account it wants directly, so there's no separate CFD account
    // to go find here.
    if (auth.style === 'legacy') {
      const cfd = await fetchOAuthCfdPositions(baseUrl, env);
      steps.push(cfd.step);
      if (cfd.positions.length > 0) {
        const existingIds = new Set((data.positions ?? []).map(p => p.position?.dealId));
        data.positions = [...(data.positions ?? []), ...cfd.positions.filter(p => !existingIds.has(p.position?.dealId))];
      }
    }

    const rawCount = data.positions?.length ?? 0;
    steps.push(`[4] Parsed OK — positions array length: ${rawCount}`);
    if (rawCount > 0) {
      data.positions!.slice(0, 3).forEach((p, i) => {
        steps.push(`[4] position[${i}]: dealId=${p.position?.dealId ?? '?'} dir=${p.position?.direction ?? '?'} size=${p.position?.size ?? '?'} epic=${p.market?.epic ?? '?'}`);
      });
    } else {
      steps.push('[4] ⚠ No positions in response. Possible causes: wrong account selected, tokens for a different sub-account, or account is genuinely empty.');
    }

    const positions = normalisePositions(data);

    steps.push(`[5] Normalised ${positions.length} position(s) — returning`);
    console.log(`[ig/positions] ${env} → ${positions.length} position(s)`);
    return NextResponse.json({ ok: true, positions, steps, rawResponse: rawText.slice(0, 2000) });
  } catch (err) {
    steps.push(`[ERR] Exception: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error', steps },
      { status: 500 }
    );
  }
}

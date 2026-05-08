import { NextRequest, NextResponse } from 'next/server';

function hdr(apiKey: string, cst: string, token: string, version: string): Record<string, string> {
  return {
    'X-IG-API-KEY':    apiKey,
    'CST':             cst,
    'X-SECURITY-TOKEN': token,
    'Accept':          'application/json; charset=UTF-8',
    'Version':         version,
  };
}

async function probe(label: string, url: string, headers: Record<string, string>): Promise<{
  label: string; url: string; status: number; ok: boolean; body: string;
}> {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) });
    const body = await r.text().catch(() => '');
    return { label, url, status: r.status, ok: r.ok, body: body.slice(0, 600) };
  } catch (e) {
    return { label, url, status: 0, ok: false, body: e instanceof Error ? e.message : String(e) };
  }
}

export async function GET(request: NextRequest) {
  const cst   = request.headers.get('x-ig-cst') ?? '';
  const token = request.headers.get('x-ig-security-token') ?? '';
  const key   = request.headers.get('x-ig-api-key') ?? '';
  const env   = (request.headers.get('x-ig-env') ?? 'demo') as 'demo' | 'live';

  if (!cst || !token || !key) {
    return NextResponse.json({ ok: false, error: 'Missing x-ig-cst / x-ig-security-token / x-ig-api-key headers' }, { status: 400 });
  }

  const base = env === 'demo'
    ? 'https://demo-api.ig.com/gateway/deal'
    : 'https://api.ig.com/gateway/deal';

  const results = await Promise.all([
    // ── Session / identity ──────────────────────────────────────────────────
    probe('GET /session (V1)',          `${base}/session`,          hdr(key, cst, token, '1')),
    probe('GET /session (V2)',          `${base}/session`,          hdr(key, cst, token, '2')),

    // ── Positions (primary path, V1 and V2) ────────────────────────────────
    probe('GET /positions/otc (V1)',    `${base}/positions/otc`,    hdr(key, cst, token, '1')),
    probe('GET /positions/otc (V2)',    `${base}/positions/otc`,    hdr(key, cst, token, '2')),

    // ── Positions without /otc ──────────────────────────────────────────────
    probe('GET /positions (V1)',        `${base}/positions`,        hdr(key, cst, token, '1')),
    probe('GET /positions (V2)',        `${base}/positions`,        hdr(key, cst, token, '2')),

    // ── Accounts (to confirm which accounts these tokens can see) ───────────
    probe('GET /accounts (V1)',         `${base}/accounts`,         hdr(key, cst, token, '1')),

    // ── Working orders ──────────────────────────────────────────────────────
    probe('GET /workingorders/otc (V2)',`${base}/workingorders/otc`,hdr(key, cst, token, '2')),
  ]);

  // Parse session info for a human-readable summary
  let sessionSummary = '';
  const sessResult = results.find(r => r.label === 'GET /session (V1)' && r.ok);
  if (sessResult) {
    try {
      const s = JSON.parse(sessResult.body) as {
        currentAccountId?: string;
        clientId?: string;
        dealingEnabled?: boolean;
        accounts?: Array<{ accountId: string; accountName: string; accountType: string; preferred: boolean }>;
      };
      sessionSummary = [
        `currentAccountId: ${s.currentAccountId ?? '?'}`,
        `clientId: ${s.clientId ?? '?'}`,
        `dealingEnabled: ${s.dealingEnabled ?? '?'}`,
        `accounts: ${(s.accounts ?? []).map(a => `${a.accountId}(${a.accountType}${a.preferred ? ',preferred' : ''})`).join(', ')}`,
      ].join(' | ');
    } catch {
      sessionSummary = 'Could not parse session JSON';
    }
  }

  return NextResponse.json({
    ok: true,
    env,
    base,
    sessionSummary,
    probes: results.map(r => ({
      label:  r.label,
      url:    r.url,
      status: r.status,
      ok:     r.ok,
      body:   r.body,
    })),
  });
}

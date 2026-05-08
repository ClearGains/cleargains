const BASE: Record<string, string> = {
  demo: 'https://demo-api.ig.com/gateway/deal',
  live: 'https://api.ig.com/gateway/deal',
};

export type IGSession = {
  cst:                  string;
  securityToken:        string;
  accountId:            string;
  apiKey:               string;
  env:                  'demo' | 'live';
  lightstreamerEndpoint: string;
  expiresAt:            number;  // epoch ms
};

export type IGPosition = {
  dealId:    string;
  epic:      string;
  direction: 'BUY' | 'SELL';
  size:      number;
  level:     number;
};

let activeSession: IGSession | null = null;

function headers(session: IGSession, version = '1'): Record<string, string> {
  return {
    'X-IG-API-KEY':     session.apiKey,
    'CST':              session.cst,
    'X-SECURITY-TOKEN': session.securityToken,
    'Content-Type':     'application/json',
    'Accept':           'application/json; charset=UTF-8',
    'Version':          version,
  };
}

export async function authenticate(
  apiKey:   string,
  username: string,
  password: string,
  env:      'demo' | 'live',
): Promise<IGSession> {
  const base = BASE[env];
  const res = await fetch(`${base}/session`, {
    method:  'POST',
    headers: { 'X-IG-API-KEY': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json; charset=UTF-8', 'Version': '2' },
    body:    JSON.stringify({ identifier: username, password, encryptedPassword: false }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`IG auth failed ${res.status}: ${txt}`);
  }
  // Node.js fetch normalises header names to lowercase
  const cst           = res.headers.get('cst') ?? res.headers.get('CST') ?? '';
  const securityToken = res.headers.get('x-security-token') ?? res.headers.get('X-SECURITY-TOKEN') ?? '';
  const data          = await res.json() as {
    accountId?: string;
    currentAccountId?: string;
    lightstreamerEndpoint?: string;
    accounts?: Array<{ accountId: string; preferred: boolean }>;
  };

  const accountId = data.currentAccountId ?? data.accountId ?? (data.accounts?.find(a => a.preferred)?.accountId ?? '');
  const lsEndpoint = data.lightstreamerEndpoint ?? '';

  if (!cst || !securityToken || !accountId) {
    throw new Error(`IG auth succeeded but missing tokens. cst=${!!cst} token=${!!securityToken} account=${accountId}`);
  }

  const session: IGSession = {
    cst,
    securityToken,
    accountId,
    apiKey,
    env,
    lightstreamerEndpoint: lsEndpoint,
    expiresAt: Date.now() + 5.5 * 60 * 60 * 1000,  // 5.5 hours (IG tokens last 6h)
  };
  activeSession = session;
  console.log(`[igApi] Authenticated — account=${accountId} env=${env} ls=${lsEndpoint}`);
  return session;
}

export function getSession(): IGSession | null { return activeSession; }

export function clearSession() { activeSession = null; }

export async function openPosition(
  session:  IGSession,
  epic:     string,
  size:     number,
): Promise<{ dealId: string; level: number }> {
  const base    = BASE[session.env];
  const expiry  = epic.startsWith('CS.D.') ? '-' : 'DFB';
  const payload = {
    epic,
    expiry,
    direction:     'BUY',
    size,
    orderType:     'MARKET',
    guaranteedStop: false,
    forceOpen:      true,
    currencyCode:   'GBP',
  };

  const r = await fetch(`${base}/positions/otc`, {
    method:  'POST',
    headers: headers(session, '2'),
    body:    JSON.stringify(payload),
    signal:  AbortSignal.timeout(10_000),
  });
  const d = await r.json() as { dealReference?: string; errorCode?: string };
  if (!r.ok) throw new Error(`openPosition failed ${r.status}: ${d.errorCode ?? JSON.stringify(d)}`);

  const dealRef = d.dealReference ?? '';
  // Confirm deal
  const cr = await fetch(`${base}/confirms/${dealRef}`, { headers: headers(session, '1'), signal: AbortSignal.timeout(8_000) });
  const confirm = await cr.json() as { dealId?: string; level?: number; dealStatus?: string; errorCode?: string };
  if (!cr.ok || confirm.dealStatus === 'REJECTED') {
    throw new Error(`openPosition confirm failed: ${confirm.errorCode ?? confirm.dealStatus}`);
  }
  return { dealId: confirm.dealId ?? '', level: confirm.level ?? 0 };
}

export async function closePosition(
  session:   IGSession,
  dealId:    string,
  direction: 'BUY' | 'SELL',
  size:      number,
): Promise<void> {
  const base = BASE[session.env];
  const closeDirection: 'BUY' | 'SELL' = direction === 'BUY' ? 'SELL' : 'BUY';

  const overridePayload = { dealId, epic: null, expiry: null, direction: closeDirection, size, level: null, orderType: 'MARKET', timeInForce: null, quoteId: null };
  const directPayload   = { direction: closeDirection, size, orderType: 'MARKET', timeInForce: null, quoteId: null, level: null };

  const attempts = [
    { url: `${base}/positions/${encodeURIComponent(dealId)}`, method: 'DELETE', payload: directPayload,   version: '1' },
    { url: `${base}/positions`,     method: 'POST', payload: overridePayload, version: '1', override: true },
    { url: `${base}/positions/otc`, method: 'POST', payload: overridePayload, version: '1', override: true },
  ] as const;

  for (const attempt of attempts) {
    const hdrs: Record<string, string> = headers(session, attempt.version);
    if ('override' in attempt && attempt.override) hdrs['_method'] = 'DELETE';

    const r = await fetch(attempt.url, {
      method:  attempt.method,
      headers: hdrs,
      body:    JSON.stringify(attempt.payload),
      signal:  AbortSignal.timeout(10_000),
    });
    const d = await r.json().catch(() => ({} as { errorCode?: string })) as { errorCode?: string };
    if (r.ok) return;
    if (r.status !== 404) throw new Error(`closePosition failed ${r.status}: ${d.errorCode ?? attempt.url}`);
    // 404 → try next endpoint
  }
  throw new Error(`closePosition: all endpoints returned 404 for dealId=${dealId}`);
}

export async function fetchPositions(session: IGSession): Promise<IGPosition[]> {
  const base = BASE[session.env];
  const endpoints = [
    { url: `${base}/positions`,     version: '2' },
    { url: `${base}/positions/otc`, version: '2' },
  ];

  for (const ep of endpoints) {
    const r = await fetch(ep.url, { headers: headers(session, ep.version), signal: AbortSignal.timeout(8_000) });
    if (!r.ok) continue;
    const d = await r.json() as { positions?: Array<{ position: { dealId: string; size: number; direction: string; level: number }; market: { epic: string } }> };
    if (!d.positions) continue;
    return d.positions.map(p => ({
      dealId:    p.position.dealId,
      epic:      p.market.epic,
      direction: p.position.direction as 'BUY' | 'SELL',
      size:      p.position.size,
      level:     p.position.level,
    }));
  }
  return [];
}

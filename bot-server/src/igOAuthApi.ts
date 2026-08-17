// ── OAuth (Version 3) IG REST client — isolated from igApi.ts on purpose ──
// igApi.ts's IGSession/authenticate() use the legacy CST/X-SECURITY-TOKEN
// mechanism (Version 2), which every persistent live bot (igStrategyBot.ts,
// fxScalperBot.ts) and Lightstreamer (igStream.ts — it specifically
// requires CST/token, OAuth doesn't provide them) already depend on. A
// second concurrent LEGACY session on the same account login gets rejected
// by IG (confirmed live: error.security.api-key-disabled), so this CFD bot
// — which needs to run at the same time as those — cannot share or
// duplicate that mechanism.
//
// Verified directly against IG's API before building this (same diagnostic
// discipline as every other epic/endpoint this session): a legacy session
// and an OAuth session on the same account coexist without colliding. So
// this file is a deliberately separate, self-contained OAuth client rather
// than a generalisation of igApi.ts — duplicates a handful of REST call
// shapes, but touches zero code any currently-live bot depends on.

const BASE: Record<string, string> = {
  demo: 'https://demo-api.ig.com/gateway/deal',
  live: 'https://api.ig.com/gateway/deal',
};

export type IGOAuthSession = {
  accessToken:  string;
  refreshToken: string;
  accountId:    string;
  apiKey:       string;
  env:          'demo' | 'live';
  expiresAt:    number;  // epoch ms
};

function headers(session: IGOAuthSession, version = '1'): Record<string, string> {
  return {
    'X-IG-API-KEY':  session.apiKey,
    'Authorization': `Bearer ${session.accessToken}`,
    'IG-ACCOUNT-ID': session.accountId,
    'Content-Type':  'application/json',
    'Accept':        'application/json; charset=UTF-8',
    'Version':       version,
  };
}

export async function authenticateOAuth(
  apiKey:      string,
  username:    string,
  password:    string,
  env:         'demo' | 'live',
  accountType: 'CFD' | 'SPREADBET' = 'CFD',
): Promise<IGOAuthSession> {
  const base = BASE[env];
  const res = await fetch(`${base}/session`, {
    method:  'POST',
    headers: { 'X-IG-API-KEY': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json; charset=UTF-8', 'Version': '3' },
    body:    JSON.stringify({ identifier: username, password, encryptedPassword: false }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`IG OAuth auth failed ${res.status}: ${txt}`);
  }
  const data = await res.json() as {
    accountId?: string;
    oauthToken?: { access_token?: string; refresh_token?: string; expires_in?: string };
  };
  const accessToken  = data.oauthToken?.access_token  ?? '';
  const refreshToken = data.oauthToken?.refresh_token ?? '';
  const expiresIn    = Number(data.oauthToken?.expires_in ?? '1800');
  const defaultAccountId = data.accountId ?? '';
  if (!accessToken || !refreshToken || !defaultAccountId) {
    throw new Error('IG OAuth auth succeeded but response was missing expected fields');
  }

  // Find the specific account matching accountType — V3's login response
  // doesn't include the accounts list (unlike V2), so a follow-up call is
  // needed. Falls back to whatever account the login itself defaulted to
  // if the wanted type isn't found (better than throwing — the caller can
  // still see accountId doesn't match what it expected and decide what to do).
  let accountId = defaultAccountId;
  try {
    const acctRes = await fetch(`${base}/accounts`, {
      headers: { 'X-IG-API-KEY': apiKey, 'Authorization': `Bearer ${accessToken}`, 'IG-ACCOUNT-ID': defaultAccountId, 'Accept': 'application/json; charset=UTF-8', 'Version': '1' },
    });
    if (acctRes.ok) {
      const acctData = await acctRes.json() as { accounts?: Array<{ accountId: string; accountType: string }> };
      const target = acctData.accounts?.find(a => a.accountType === accountType);
      if (target) accountId = target.accountId;
    }
  } catch { /* fall through with defaultAccountId */ }

  const session: IGOAuthSession = { accessToken, refreshToken, accountId, apiKey, env, expiresAt: Date.now() + expiresIn * 1000 };
  console.log(`[igOAuthApi] Authenticated — account=${accountId} env=${env} type=${accountType}`);
  return session;
}

// Access tokens last only 30min (confirmed live) — callers should refresh
// well before expiresAt, not wait for a 401.
export async function refreshOAuthSession(session: IGOAuthSession): Promise<IGOAuthSession> {
  const base = BASE[session.env];
  const res = await fetch(`${base}/session/refresh-token`, {
    method:  'POST',
    headers: { 'X-IG-API-KEY': session.apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json; charset=UTF-8', 'Version': '1' },
    body:    JSON.stringify({ refresh_token: session.refreshToken }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`IG OAuth refresh failed ${res.status}: ${txt}`);
  }
  const data = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: string };
  if (!data.access_token || !data.refresh_token) throw new Error('IG OAuth refresh succeeded but response was missing tokens');
  return {
    ...session,
    accessToken:  data.access_token,
    refreshToken: data.refresh_token,
    expiresAt:    Date.now() + Number(data.expires_in ?? '1800') * 1000,
  };
}

export async function logoutOAuth(session: IGOAuthSession): Promise<void> {
  const base = BASE[session.env];
  try {
    await fetch(`${base}/session`, { method: 'DELETE', headers: headers(session) });
  } catch { /* best-effort */ }
}

export type FullPosition = {
  dealId:         string;
  epic:           string;
  direction:      'BUY' | 'SELL';
  size:           number;
  level:          number;
  instrumentName: string;
  upl:            number;
  currency:       string;   // deal currency (e.g. USD for US-share CFDs) — upl above is in THIS currency, not necessarily account currency
  hasLiveQuote:   boolean;  // false when IG's own bid/offer are null (market closed) — upl is 0/unset, not a real number. Caller can fall back to another price source rather than just show 0.
  bid:            number;
  offer:          number;
  stopLevel?:     number;
  limitLevel?:    number;
  openedAt?:      string;
};

export async function fetchFullPositions(session: IGOAuthSession): Promise<FullPosition[]> {
  const base = BASE[session.env];
  const r = await fetch(`${base}/positions`, { headers: headers(session, '2'), signal: AbortSignal.timeout(8_000) });
  if (!r.ok) return [];
  const d = await r.json() as {
    positions?: Array<{
      position: {
        dealId: string; size: number; direction: string; level: number;
        upl?: number; limitLevel: number | null; stopLevel: number | null;
        createdDateUTC?: string; currency?: string;
      };
      market: { epic: string; instrumentName: string; bid: number; offer: number };
    }>;
  };
  // Same "IG's own /positions response doesn't actually include `upl`"
  // gap confirmed live for the legacy session earlier this session —
  // compute from level vs bid/offer rather than trust an absent field.
  // IG returns bid/offer as null when the market is currently closed
  // (confirmed live: every "24 Hours" CFD stock outside its real exchange
  // hours) — a plain `null - level` silently coerces to `0 - level` in JS,
  // which looked exactly like a real (and wrong) P&L equal to ±the entry
  // price. Guard explicitly: no live quote means no P&L to report, not 0
  // minus the entry price.
  return (d.positions ?? []).map(p => {
    const direction = p.position.direction as 'BUY' | 'SELL';
    const hasLiveQuote = typeof p.market.bid === 'number' && typeof p.market.offer === 'number';
    const computedUpl = hasLiveQuote
      ? (direction === 'BUY' ? p.market.bid - p.position.level : p.position.level - p.market.offer) * p.position.size
      : 0;
    return {
      dealId: p.position.dealId, epic: p.market.epic, direction, size: p.position.size, level: p.position.level,
      instrumentName: p.market.instrumentName,
      upl: typeof p.position.upl === 'number' ? p.position.upl : computedUpl,
      currency: p.position.currency ?? 'GBP',
      hasLiveQuote,
      bid: p.market.bid ?? p.position.level, offer: p.market.offer ?? p.position.level,
      stopLevel: p.position.stopLevel ?? undefined, limitLevel: p.position.limitLevel ?? undefined,
      openedAt: p.position.createdDateUTC ? `${p.position.createdDateUTC}Z` : undefined,
    };
  });
}

export async function fetchAccountFunds(session: IGOAuthSession): Promise<{ available: number; balance: number }> {
  const base = BASE[session.env];
  const r = await fetch(`${base}/accounts`, { headers: headers(session, '1'), signal: AbortSignal.timeout(8_000) });
  if (!r.ok) throw new Error(`fetchAccountFunds ${r.status}`);
  const d = await r.json() as { accounts?: Array<{ accountId: string; balance: { available: number; balance: number } }> };
  const acct = d.accounts?.find(a => a.accountId === session.accountId) ?? d.accounts?.[0];
  return { available: acct?.balance.available ?? 0, balance: acct?.balance.balance ?? 0 };
}

export type MarketDetail = {
  epic: string;
  minDealSize: number;
  minStopDist: number;
  // `| null`, not just optional — IG returns bid/offer as JSON null (not a
  // missing field) whenever there's no live quote, and null !== undefined
  // in JS. A `typeof x === 'number'` check catches both; a `!== undefined`
  // check silently passes null through and let `(null + null) / 2`
  // evaluate to 0 — confirmed live, blew a CFD stop distance out to
  // roughly the full price level for a real GSK entry.
  bid?: number | null;
  offer?: number | null;
  marketStatus?: string;
  marginFactorPct?: number;
  currencyCode?: string;
};

export async function fetchMarketDetails(session: IGOAuthSession, epics: string[]): Promise<Map<string, MarketDetail>> {
  const result = new Map<string, MarketDetail>();
  if (!epics.length) return result;
  const base = BASE[session.env];
  try {
    const url = `${base}/markets?epics=${epics.map(encodeURIComponent).join(',')}`;
    const r = await fetch(url, { headers: headers(session, '2'), signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return result;
    const d = await r.json() as {
      marketDetails?: Array<{
        instrument?: { epic?: string; marginFactor?: number; currencies?: Array<{ code?: string; isDefault?: boolean }> };
        dealingRules?: { minDealSize?: { value?: number }; minControlledRiskStopDistance?: { value?: number }; minNormalStopOrLimitDistance?: { value?: number } };
        snapshot?: { bid?: number | null; offer?: number | null; marketStatus?: string };
      }>;
    };
    for (const m of d.marketDetails ?? []) {
      const epic = m.instrument?.epic;
      if (!epic) continue;
      // `||` not `??` — same reasoning as igApi.ts's own fix: a genuine 0
      // isn't realistic here, so treat it as missing rather than let a
      // stray 0 silently disable the stake/stop clamp that trusts this.
      const minDeal = m.dealingRules?.minDealSize?.value || 1;
      const minStop = m.dealingRules?.minNormalStopOrLimitDistance?.value || m.dealingRules?.minControlledRiskStopDistance?.value || 1;
      // CFDs settle in the instrument's own currency (e.g. USD for US
      // shares), unlike spread bets which are always £/point regardless
      // of instrument — sending an unsupported currencyCode gets a
      // generic REJECTED/UNKNOWN from IG with no useful detail. Prefer
      // the currency IG flags isDefault, else just take the first (only)
      // one listed — verified live that e.g. TSLA/AMD/AVGO only support
      // USD on the CFD account, not GBP.
      const currencies = m.instrument?.currencies ?? [];
      const currencyCode = currencies.find(c => c.isDefault)?.code ?? currencies[0]?.code;
      result.set(epic, {
        epic, minDealSize: minDeal, minStopDist: minStop,
        bid: m.snapshot?.bid, offer: m.snapshot?.offer, marketStatus: m.snapshot?.marketStatus,
        marginFactorPct: m.instrument?.marginFactor,
        currencyCode,
      });
    }
  } catch (e) {
    console.warn(`[igOAuthApi] fetchMarketDetails failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return result;
}

// CFD orders use expiry: '-' (not spread-bet's 'DFB') — confirmed live
// against a real CFD account before this file was written.
export async function placeMarketOrder(
  session:     IGOAuthSession,
  epic:        string,
  direction:   'BUY' | 'SELL',
  size:        number,
  stopDist?:   number,
  profitDist?: number,
  currencyCode = 'GBP',
): Promise<{ dealId: string; level: number; protectionOk: boolean; protectionError?: string }> {
  const base = BASE[session.env];
  const payload: Record<string, unknown> = {
    epic, expiry: '-', direction, size,
    orderType: 'MARKET', guaranteedStop: false, trailingStop: false,
    forceOpen: true, currencyCode,
  };
  const r = await fetch(`${base}/positions/otc`, {
    method: 'POST', headers: headers(session, '2'), body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000),
  });
  const d = await r.json() as { dealReference?: string; errorCode?: string };
  if (!r.ok) throw new Error(`placeMarketOrder failed ${r.status}: ${d.errorCode ?? JSON.stringify(d)}`);

  const dealRef = d.dealReference ?? '';
  let confirm: { dealId?: string; level?: number; dealStatus?: string; reason?: string } = {};
  for (let i = 0; i < 4; i++) {
    await new Promise(res => setTimeout(res, 1_500));
    try {
      const cr = await fetch(`${base}/confirms/${encodeURIComponent(dealRef)}`, { headers: headers(session, '1'), signal: AbortSignal.timeout(8_000) });
      if (cr.ok) {
        confirm = await cr.json() as typeof confirm;
        if (confirm.dealStatus === 'ACCEPTED' || confirm.dealStatus === 'REJECTED') break;
      }
    } catch { /* retry */ }
  }
  if (confirm.dealStatus !== 'ACCEPTED' || !confirm.dealId) {
    console.error(`[igOAuthApi] placeMarketOrder REJECTED — epic=${epic} direction=${direction} size=${size} confirm: ${JSON.stringify(confirm)}`);
    throw new Error(`Deal REJECTED: ${confirm.reason ?? confirm.dealStatus ?? 'unknown'}`);
  }

  const dealId = confirm.dealId;
  const level  = confirm.level ?? 0;

  let protectionOk = true;
  let protectionError: string | undefined;
  if ((stopDist || profitDist) && level) {
    const slTp: Record<string, unknown> = { trailingStop: false };
    if (stopDist)   slTp.stopLevel  = Math.round((direction === 'BUY' ? level - stopDist   : level + stopDist)   * 100) / 100;
    if (profitDist) slTp.limitLevel = Math.round((direction === 'BUY' ? level + profitDist : level - profitDist) * 100) / 100;

    const attempt = async (): Promise<{ ok: boolean; error?: string }> => {
      try {
        const upd = await fetch(`${base}/positions/otc/${encodeURIComponent(dealId)}`, {
          method: 'PUT', headers: headers(session, '2'), body: JSON.stringify(slTp), signal: AbortSignal.timeout(8_000),
        });
        if (upd.ok) return { ok: true };
        return { ok: false, error: `${upd.status} ${(await upd.text()).slice(0, 200)}` };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    };
    let result = await attempt();
    if (!result.ok) { await new Promise(r => setTimeout(r, 1_500)); result = await attempt(); }
    protectionOk = result.ok;
    protectionError = result.error;
  }

  return { dealId, level, protectionOk, protectionError };
}

export async function closePosition(session: IGOAuthSession, dealId: string, direction: 'BUY' | 'SELL', size: number): Promise<void> {
  const base = BASE[session.env];
  const closeDirection: 'BUY' | 'SELL' = direction === 'BUY' ? 'SELL' : 'BUY';
  const payload = { dealId, epic: null, expiry: null, direction: closeDirection, size, level: null, orderType: 'MARKET', timeInForce: null, quoteId: null };
  const r = await fetch(`${base}/positions/otc`, {
    method: 'POST', headers: { ...headers(session, '1'), '_method': 'DELETE' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000),
  });
  const d = await r.json().catch(() => ({} as { dealReference?: string; errorCode?: string })) as { dealReference?: string; errorCode?: string };
  if (!r.ok) {
    const code = d.errorCode ?? '';
    if (code.includes('notional.details.null') || code.includes('position.notfound') || code.includes('POSITION_NOT_FOUND')) return; // already closed — no-op
    throw new Error(`closePosition failed ${r.status}: ${code}`);
  }
  // r.ok only means IG accepted the close *request* — same gap
  // placeMarketOrder above already guards against for opens (see its own
  // comment), just never applied to closes. Confirmed live this actually
  // matters: the live spread-bet bot's equivalent close path (igApi.ts)
  // logged a close attempt against a real open position with no exception
  // raised, yet the position was still open hours later. Poll the same way
  // placeMarketOrder does before trusting a close actually happened.
  if (!d.dealReference) return; // nothing to confirm against — treat as closed
  let confirm: { dealStatus?: string; reason?: string; errorCode?: string } = {};
  for (let i = 0; i < 4; i++) {
    await new Promise(res => setTimeout(res, 1_500));
    try {
      const cr = await fetch(`${base}/confirms/${encodeURIComponent(d.dealReference)}`, { headers: headers(session, '1'), signal: AbortSignal.timeout(8_000) });
      if (cr.ok) {
        confirm = await cr.json() as typeof confirm;
        if (confirm.dealStatus === 'ACCEPTED' || confirm.dealStatus === 'REJECTED') break;
      }
    } catch { /* retry */ }
  }
  if (confirm.dealStatus === 'ACCEPTED') return;
  if (confirm.dealStatus === 'REJECTED') throw new Error(`closePosition confirm REJECTED: ${confirm.reason ?? confirm.errorCode ?? 'unknown'}`);
  // Confirm never resolved either way — don't silently assume success;
  // check IG's own position list before deciding, same idempotency
  // fallback igApi.ts's closePosition uses.
  const stillOpen = await fetchFullPositions(session).then(ps => ps.some(p => p.dealId === dealId)).catch(() => true);
  if (!stillOpen) return;
  throw new Error(`closePosition: could not confirm close for dealId=${dealId}`);
}

export async function updatePositionLevels(session: IGOAuthSession, dealId: string, stopLevel: number | null, limitLevel: number | null): Promise<void> {
  const base = BASE[session.env];
  const r = await fetch(`${base}/positions/otc/${encodeURIComponent(dealId)}`, {
    method: 'PUT', headers: headers(session, '2'), body: JSON.stringify({ stopLevel, limitLevel, trailingStop: false }), signal: AbortSignal.timeout(8_000),
  });
  if (!r.ok) throw new Error(`updatePositionLevels ${r.status}: ${(await r.text()).slice(0, 100)}`);
}

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

const sessions = new Map<string, IGSession>();

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
  apiKey:      string,
  username:    string,
  password:    string,
  env:         'demo' | 'live',
  accountKey?: string,
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
  let cst           = res.headers.get('cst') ?? res.headers.get('CST') ?? '';
  let securityToken = res.headers.get('x-security-token') ?? res.headers.get('X-SECURITY-TOKEN') ?? '';
  const data          = await res.json() as {
    accountId?: string;
    currentAccountId?: string;
    lightstreamerEndpoint?: string;
    accounts?: Array<{ accountId: string; accountType?: string; preferred: boolean }>;
  };

  let accountId = data.currentAccountId ?? data.accountId ?? (data.accounts?.find(a => a.preferred)?.accountId ?? '');
  const lsEndpoint = data.lightstreamerEndpoint ?? '';

  if (!cst || !securityToken || !accountId) {
    throw new Error(`IG auth succeeded but missing tokens. cst=${!!cst} token=${!!securityToken} account=${accountId}`);
  }

  // Switch to SPREADBET account if not already on it — same logic as website session route
  const spreadbetAccount = data.accounts?.find(a => a.accountType === 'SPREADBET');
  if (spreadbetAccount && spreadbetAccount.accountId !== accountId) {
    const switchRes = await fetch(`${base}/session`, {
      method:  'PUT',
      headers: { 'X-IG-API-KEY': apiKey, 'CST': cst, 'X-SECURITY-TOKEN': securityToken, 'Content-Type': 'application/json', 'Accept': 'application/json; charset=UTF-8', 'Version': '1' },
      body:    JSON.stringify({ accountId: spreadbetAccount.accountId, dealingEnabled: true }),
    });
    if (switchRes.ok) {
      const newCst   = switchRes.headers.get('cst') ?? switchRes.headers.get('CST');
      const newToken = switchRes.headers.get('x-security-token') ?? switchRes.headers.get('X-SECURITY-TOKEN');
      if (newCst)   cst           = newCst;
      if (newToken) securityToken = newToken;
      accountId = spreadbetAccount.accountId;
      console.log(`[igApi] Switched to SPREADBET account ${accountId}`);
    } else {
      console.warn(`[igApi] SPREADBET switch failed (${switchRes.status}) — continuing with default account`);
    }
  } else if (spreadbetAccount) {
    console.log(`[igApi] Already on SPREADBET account ${accountId}`);
  }

  const session: IGSession = {
    cst,
    securityToken,
    accountId,
    apiKey,
    env,
    lightstreamerEndpoint: lsEndpoint,
    expiresAt: Date.now() + 5.5 * 60 * 60 * 1000,
  };
  const key = accountKey ?? env;
  sessions.set(key, session);
  console.log(`[igApi] Authenticated — account=${accountId} env=${env} key=${key} ls=${lsEndpoint}`);
  return session;
}

export function getSession(accountKey?: string): IGSession | null {
  if (accountKey) return sessions.get(accountKey) ?? null;
  // backward compat: return the first available session
  return sessions.values().next().value ?? null;
}

export function setSession(session: IGSession, accountKey?: string): void {
  sessions.set(accountKey ?? session.env, session);
}

export function clearSession(accountKey?: string): void {
  if (accountKey) sessions.delete(accountKey);
  else sessions.clear();
}

// IG only tolerates one active session per login. Every place that stops
// using a session used to just discard it locally, leaving it open on IG's
// side until its own multi-hour token expiry — a pile of these from a busy
// testing session can eat the account's one-session allowance for hours
// after the fact. This actually tells IG the session is done.
export async function logout(session: IGSession, accountKey?: string): Promise<void> {
  const base = BASE[session.env];
  try {
    await fetch(`${base}/session`, { method: 'DELETE', headers: headers(session) });
  } catch { /* best-effort — local cache is cleared regardless */ }
  if (accountKey) sessions.delete(accountKey);
}

export async function openPosition(
  session:    IGSession,
  epic:       string,
  size:       number,
  direction:  'BUY' | 'SELL' = 'BUY',
  stopLevel?: number,
  limitLevel?: number,
): Promise<{ dealId: string; level: number }> {
  const base   = BASE[session.env];
  const expiry = epic.startsWith('CS.D.') ? '-' : 'DFB';
  const payload: Record<string, unknown> = {
    epic,
    expiry,
    direction,
    size,
    orderType:      'MARKET',
    guaranteedStop: false,
    trailingStop:   false,
    forceOpen:      true,
    currencyCode:   'GBP',
  };
  if (stopLevel  !== undefined) payload.stopLevel  = stopLevel;
  if (limitLevel !== undefined) payload.limitLevel = limitLevel;

  console.log(`[igApi] openPosition ${epic} ${direction} size=${size} stop=${stopLevel?.toFixed(5) ?? 'none'} limit=${limitLevel?.toFixed(5) ?? 'none'}`);

  const r = await fetch(`${base}/positions/otc`, {
    method:  'POST',
    headers: headers(session, '2'),
    body:    JSON.stringify(payload),
    signal:  AbortSignal.timeout(20_000),
  });
  const d = await r.json() as { dealReference?: string; errorCode?: string };
  if (!r.ok) throw new Error(`openPosition failed ${r.status}: ${d.errorCode ?? JSON.stringify(d)}`);

  const dealRef = d.dealReference ?? '';

  // Poll confirms with retries — IG can take 1-3s to process
  let confirm: { dealId?: string; level?: number; dealStatus?: string; errorCode?: string } = {};
  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise(res => setTimeout(res, 1500));
    const cr = await fetch(`${base}/confirms/${dealRef}`, { headers: headers(session, '1'), signal: AbortSignal.timeout(8_000) });
    confirm = await cr.json() as typeof confirm;
    if (cr.ok && confirm.dealStatus && confirm.dealStatus !== 'REJECTED') break;
    if (confirm.dealStatus === 'REJECTED') break;  // definitive — no point retrying
  }

  if (confirm.dealStatus === 'REJECTED' || !confirm.dealId) {
    console.error(`[igApi] REJECTED confirm: ${JSON.stringify(confirm)}`);
    throw new Error(`openPosition confirm failed: ${confirm.errorCode ?? confirm.dealStatus ?? 'deal-not-found'}`);
  }
  return { dealId: confirm.dealId, level: confirm.level ?? 0 };
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

  // A 200 here only means IG accepted the close *request* for processing —
  // same gap as placeMarketOrder's own submit step, which is why that
  // function always polls /confirms afterwards and this one didn't.
  // Confirmed live tonight this actually matters: the severe-loss guard
  // logged "closing immediately" against a real open position, got no
  // exception back, and moved on — but the position was still open 6+
  // hours later. r.ok alone can't tell a genuinely-closed position apart
  // from one IG silently rejected on confirmation (e.g. market closed),
  // so poll the same way every other order-placement path in this
  // codebase already does before trusting a close actually happened.
  type Confirm = { dealId?: string; dealStatus?: string; reason?: string; errorCode?: string };
  const confirmClose = async (dealRef: string): Promise<Confirm> => {
    let confirm: Confirm = {};
    for (let i = 0; i < 4; i++) {
      await new Promise(res => setTimeout(res, 1_500));
      try {
        const cr = await fetch(`${base}/confirms/${encodeURIComponent(dealRef)}`,
          { headers: headers(session, '1'), signal: AbortSignal.timeout(8_000) });
        if (cr.ok) {
          confirm = await cr.json() as Confirm;
          if (confirm.dealStatus === 'ACCEPTED' || confirm.dealStatus === 'REJECTED') break;
        }
      } catch { /* retry */ }
    }
    return confirm;
  };

  for (const attempt of attempts) {
    const hdrs: Record<string, string> = headers(session, attempt.version);
    if ('override' in attempt && attempt.override) hdrs['_method'] = 'DELETE';

    const r = await fetch(attempt.url, {
      method:  attempt.method,
      headers: hdrs,
      body:    JSON.stringify(attempt.payload),
      signal:  AbortSignal.timeout(10_000),
    });
    const d = await r.json().catch(() => ({} as { dealReference?: string; errorCode?: string })) as { dealReference?: string; errorCode?: string };
    if (r.ok) {
      if (!d.dealReference) return; // some IG endpoint variants close synchronously with no dealReference to confirm — nothing further to check
      const confirm = await confirmClose(d.dealReference);
      if (confirm.dealStatus === 'ACCEPTED') return;
      if (confirm.dealStatus === 'REJECTED') {
        throw new Error(`closePosition confirm REJECTED: ${confirm.reason ?? confirm.errorCode ?? 'unknown'}`);
      }
      // Confirm never resolved either way (timed out) — don't silently
      // treat this as success; fall through and let the idempotency check
      // below settle it.
      break;
    }
    // 404 = endpoint doesn't exist, 405 = method not allowed — try next
    if (r.status !== 404 && r.status !== 405) throw new Error(`closePosition failed ${r.status}: ${d.errorCode ?? attempt.url}`);
    // otherwise fall through to next attempt
  }
  // Either every endpoint variant 404'd, or a close request was accepted
  // but its confirm never came back definitive — this is the same code
  // that closes positions successfully constantly elsewhere, so a
  // genuinely broken endpoint is unlikely. Far more likely: the position
  // is already gone (IG's own broker-side stop/limit closed it before this
  // software-side attempt reached IG), or really did just get closed by
  // this attempt and the confirm poll missed it. Confirming that here
  // makes close idempotent — "close an already-closed position" succeeds
  // as a no-op instead of throwing a misleading error for something that
  // isn't actually broken.
  try {
    const stillOpen = (await fetchFullPositions(session)).some(p => p.dealId === dealId);
    if (!stillOpen) return;
  } catch { /* fall through to the throw below if we can't even check */ }
  throw new Error(`closePosition: could not confirm close for dealId=${dealId}`);
}

export type CandleBar = {
  snapshotTime: string;
  openPrice:    { bid: number; ask: number; mid: number | null };
  highPrice:    { bid: number; ask: number; mid: number | null };
  lowPrice:     { bid: number; ask: number; mid: number | null };
  closePrice:   { bid: number; ask: number; mid: number | null };
};

export async function fetchCandleHistory(
  session:    IGSession,
  epic:       string,
  resolution  = 'MINUTE_5',
  count       = 35,
): Promise<CandleBar[]> {
  const base = BASE[session.env];
  const url  = `${base}/prices/${encodeURIComponent(epic)}?resolution=${resolution}&max=${count}&pageSize=${count}&pageNumber=1`;
  const r    = await fetch(url, { headers: headers(session, '3'), signal: AbortSignal.timeout(12_000) });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`fetchCandleHistory ${r.status}: ${txt.slice(0, 200)}`);
  }
  const d = await r.json() as { prices?: CandleBar[] };
  return d.prices ?? [];
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

export type FullPosition = IGPosition & {
  instrumentName: string;
  upl:        number;
  bid:        number;
  offer:      number;
  stopLevel?:  number;
  limitLevel?: number;
  openedAt?:   string;  // IG's createdDateUTC, e.g. "2026-07-29T13:58:03" — no trailing Z, but is UTC
};

export async function fetchFullPositions(session: IGSession): Promise<FullPosition[]> {
  const base = BASE[session.env];
  const r = await fetch(`${base}/positions`, { headers: headers(session, '2'), signal: AbortSignal.timeout(8_000) });
  if (!r.ok) return [];
  const d = await r.json() as {
    positions?: Array<{
      position: {
        dealId: string; size: number; direction: string; level: number;
        upl?: number; limitLevel: number | null; stopLevel: number | null;
        currency: string; createdDateUTC?: string;
      };
      market: { epic: string; instrumentName: string; bid: number; offer: number };
    }>;
  };
  // IG's own /positions response doesn't actually include `upl` (confirmed
  // against the live account — every position comes back with it absent),
  // despite it being a documented field on some API versions. Compute it
  // from level vs bid/offer rather than trust a field that isn't there —
  // an undefined upl reaching the UI crashes any .toFixed() render of it.
  return (d.positions ?? []).map(p => {
    const direction = p.position.direction as 'BUY' | 'SELL';
    const computedUpl = direction === 'BUY'
      ? (p.market.bid   - p.position.level) * p.position.size
      : (p.position.level - p.market.offer) * p.position.size;
    return {
      dealId:         p.position.dealId,
      epic:           p.market.epic,
      direction,
      size:           p.position.size,
      level:          p.position.level,
      instrumentName: p.market.instrumentName,
      upl:            typeof p.position.upl === 'number' ? p.position.upl : computedUpl,
      bid:            p.market.bid,
      offer:          p.market.offer,
      stopLevel:      p.position.stopLevel ?? undefined,
      limitLevel:     p.position.limitLevel ?? undefined,
      openedAt:       p.position.createdDateUTC ? `${p.position.createdDateUTC}Z` : undefined,
    };
  });
}

export type IgClosedTransaction = {
  instrumentName: string;
  openDateUtc?:   string;
  closeDateUtc:   string;
  openLevel?:     number;
  closeLevel?:    number;
  profitAndLoss:  number;  // parsed from IG's "£-3.15"-style string, sign preserved
};

// Recovers what actually happened to a position that vanished from
// /positions without going through any of this codebase's own close paths —
// confirmed live 2026-08-25: a broker-side stop-loss execution (IG closing
// the position server-side once price touches the stop) never runs any of
// our own igClosePos/journalExit code at all, so a position closed this way
// previously just silently disappeared with zero record of what it closed
// at or for how much. IG's own transaction history is the only source of
// truth for that — this is a real network call (not cached), so callers
// should use it sparingly (only for dealIds actually confirmed missing),
// not on every poll.
export async function fetchClosedTransactions(session: IGSession, sinceIso: string): Promise<IgClosedTransaction[]> {
  const base = BASE[session.env];
  const from = sinceIso.slice(0, 19);
  const r = await fetch(`${base}/history/transactions?type=ALL_DEAL&from=${from}`, {
    headers: headers(session, '2'), signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) return [];
  const d = await r.json() as {
    transactions?: Array<{
      instrumentName?: string; openDateUtc?: string; dateUtc?: string;
      openLevel?: string; closeLevel?: string; profitAndLoss?: string;
    }>;
  };
  return (d.transactions ?? [])
    .filter(t => t.instrumentName && t.dateUtc && t.profitAndLoss)
    .map(t => ({
      instrumentName: t.instrumentName!,
      openDateUtc:    t.openDateUtc,
      closeDateUtc:   t.dateUtc!,
      openLevel:      t.openLevel  !== undefined ? Number(t.openLevel)  : undefined,
      closeLevel:     t.closeLevel !== undefined ? Number(t.closeLevel) : undefined,
      // IG returns this as a currency-prefixed string, e.g. "£-3.15" or "£12.40"
      profitAndLoss:  Number((t.profitAndLoss ?? '0').replace(/[^0-9.-]/g, '')) || 0,
    }));
}

export async function placeMarketOrder(
  session:      IGSession,
  epic:         string,
  direction:    'BUY' | 'SELL',
  size:         number,
  stopDist?:    number,
  profitDist?:  number,
  currencyCode = 'GBP',
  wantGuaranteedStop = false,
  // 'DFB' (daily funded bet, rolls forever) is right for every cash
  // CFD/spread-bet epic this codebase trades — but an options epic has a
  // real expiry ("SEP-26", "30-SEP-26") that MUST be sent as-is or IG
  // rejects the order as referencing a nonexistent market. Only
  // igOptionsBot.ts passes this; everything else keeps the default.
  expiry = 'DFB',
  // Confirmed live 2026-08-31 (igOptionsBot.ts): a real subset of IG's own
  // option epics reject MARKET orders outright with
  // error.trading.otc.market-orders.not-supported-for-epic — not a
  // liquidity/spread problem, an order-TYPE restriction some option
  // contracts carry. When a caller knows it's dealing with an option and
  // supplies the current offer, that specific rejection (only that one)
  // retries once as a LIMIT order priced a small buffer past the offer —
  // marketable in practice, but sent as the order type IG will actually
  // accept for these epics.
  optionFallbackOffer?: number,
): Promise<{ dealId: string; level: number; protectionOk: boolean; protectionError?: string; guaranteedStop: boolean }> {
  const base = BASE[session.env];
  // Guaranteed stops can only be requested at open time, as a *distance*
  // (IG computes the level itself once it knows the actual fill price) —
  // unlike a normal stop, which we attach afterwards via PUT once we know
  // that fill level. A guaranteed stop can't slip past its level even if
  // price gaps straight through it, unlike the normal stop this bot used
  // before — confirmed live cost of that gap: a Seagate position stopped
  // at 4000pts (~£40 intended) actually lost £854.53 in a single thin-
  // liquidity window before the severe-loss guard caught it.
  const useGuaranteed = wantGuaranteedStop && !!stopDist;

  // IG validates a guaranteed stop's distance/eligibility asynchronously —
  // the initial POST just accepts the request and returns a dealReference;
  // the actual accept/reject (e.g. ATTACHED_ORDER_LEVEL_ERROR when the
  // instrument needs a wider guaranteed-stop distance than requested) only
  // shows up on the /confirms poll. So the guaranteed/normal choice has to
  // be tried as a full submit-and-confirm cycle, not just checked against
  // the POST's own response.
  type Confirm = { dealId?: string; level?: number; dealStatus?: string; reason?: string } & Record<string, unknown>;
  const submitAndConfirm = async (asGuaranteed: boolean, asLimitLevel?: number): Promise<{ ok: boolean; confirm: Confirm }> => {
    const payload: Record<string, unknown> = {
      epic, expiry, direction, size,
      trailingStop: false,
      forceOpen: true, currencyCode,
    };
    if (asLimitLevel !== undefined) {
      payload.orderType = 'LIMIT';
      payload.level     = Math.round(asLimitLevel * 100) / 100;
    } else {
      payload.orderType = 'MARKET';
    }
    if (asGuaranteed) {
      payload.guaranteedStop = true;
      payload.stopDistance   = Math.round(stopDist! * 100) / 100;
    } else {
      payload.guaranteedStop = false;
    }

    const r = await fetch(`${base}/positions/otc`, {
      method: 'POST', headers: headers(session, '2'),
      body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000),
    });
    const d = await r.json() as { dealReference?: string; errorCode?: string };
    if (!r.ok) return { ok: false, confirm: { reason: d.errorCode } };

    const dealRef = d.dealReference ?? '';
    let confirm: Confirm = {};
    for (let i = 0; i < 4; i++) {
      await new Promise(res => setTimeout(res, 1_500));
      try {
        const cr = await fetch(`${base}/confirms/${encodeURIComponent(dealRef)}`,
          { headers: headers(session, '1'), signal: AbortSignal.timeout(8_000) });
        if (cr.ok) {
          confirm = await cr.json() as Confirm;
          if (confirm.dealStatus === 'ACCEPTED' || confirm.dealStatus === 'REJECTED') break;
        }
      } catch { /* retry */ }
    }
    return { ok: confirm.dealStatus === 'ACCEPTED' && !!confirm.dealId, confirm };
  };

  let guaranteedApplied = useGuaranteed;
  let { ok, confirm } = await submitAndConfirm(useGuaranteed);
  // Not every instrument supports guaranteed stops (and some reject the
  // requested distance as too tight) — fall back to a normal stop rather
  // than failing the entry outright.
  if (!ok && useGuaranteed) {
    console.warn(`[igApi] Guaranteed stop rejected for ${epic} (${confirm.reason ?? 'unknown'}) — retrying with a normal stop`);
    guaranteedApplied = false;
    ({ ok, confirm } = await submitAndConfirm(false));
  }

  // See optionFallbackOffer's own comment — this specific rejection means
  // the epic simply doesn't accept MARKET orders, not that anything about
  // the order itself was wrong. Retry as a marketable LIMIT: 2% past the
  // live offer for a BUY (5% for a SELL, since IG spread-bet option premiums
  // can move fast intraday) — comfortably inside typical bid/offer spreads
  // on the illiquid strikes this actually fires for, so it fills like a
  // market order in practice while satisfying IG's order-type requirement.
  if (!ok && confirm.reason === 'error.trading.otc.market-orders.not-supported-for-epic' && optionFallbackOffer) {
    const buffered = direction === 'BUY' ? optionFallbackOffer * 1.02 : optionFallbackOffer * 0.95;
    console.warn(`[igApi] MARKET order not supported for ${epic} — retrying as LIMIT @ ${buffered.toFixed(2)}`);
    ({ ok, confirm } = await submitAndConfirm(guaranteedApplied, buffered));
  }

  // Widened to capture whatever else IG's confirm response includes (IG's
  // own "reason" field is frequently just the opaque literal string
  // "UNKNOWN" with no further detail — confirmed a known, widely-reported
  // gap in IG's own API, not something client-side to fix). Logging the
  // full raw response on rejection at least preserves every field IG did
  // send (affectedDeals, profit, timestamps, etc.) in case a pattern shows
  // up across repeat occurrences, instead of discarding everything but the
  // one unhelpful reason string.
  if (!ok) {
    console.error(`[igApi] placeMarketOrder REJECTED — epic=${epic} direction=${direction} size=${size} stopDist=${stopDist} profitDist=${profitDist} full confirm: ${JSON.stringify(confirm)}`);
    throw new Error(`Deal REJECTED: ${confirm.reason ?? confirm.dealStatus ?? 'unknown'}`);
  }

  const dealId = confirm.dealId!;
  const level  = confirm.level ?? 0;

  // Apply SL/TP via PUT after deal accepted. One retry before giving up — a
  // naked position (no broker-side stop or take-profit) only exits on the
  // strategy's own thesis-reversal check, which is often lagging/one-sided,
  // so a silently-failed attach here is the main way trades ride losses
  // instead of taking profit.
  let protectionOk = true;
  let protectionError: string | undefined;
  // A guaranteed stop is already attached from the initial order — only
  // the take-profit (if any) still needs the follow-up PUT.
  const stopStillNeeded = stopDist && !guaranteedApplied;
  if ((stopStillNeeded || profitDist) && level) {
    const slTp: Record<string, unknown> = { trailingStop: false };
    if (stopStillNeeded) slTp.stopLevel  = Math.round((direction === 'BUY' ? level - stopDist!  : level + stopDist!)  * 100) / 100;
    if (profitDist)      slTp.limitLevel = Math.round((direction === 'BUY' ? level + profitDist : level - profitDist) * 100) / 100;

    const attemptSlTpPut = async (): Promise<{ ok: boolean; error?: string }> => {
      try {
        const r = await fetch(`${base}/positions/otc/${encodeURIComponent(dealId)}`, {
          method: 'PUT', headers: headers(session, '2'),
          body: JSON.stringify(slTp), signal: AbortSignal.timeout(8_000),
        });
        if (r.ok) return { ok: true };
        const txt = await r.text();
        return { ok: false, error: `${r.status} ${txt.slice(0, 200)}` };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    };

    let result = await attemptSlTpPut();
    if (!result.ok) {
      await new Promise(res => setTimeout(res, 1_500));
      result = await attemptSlTpPut();
    }
    protectionOk = result.ok;
    protectionError = result.error;
  }

  // The initial submitAndConfirm's ACCEPTED status only means IG accepted
  // the open request — not proof the guaranteed-stop leg specifically
  // survived. protectionOk above never actually re-checks that: when
  // guaranteedApplied is true, stopStillNeeded is false, so the PUT block
  // only ever validates the take-profit leg (if any) and protectionOk
  // stays at its default `true` regardless of whether the stop is real.
  // Confirmed live this gap is real, not theoretical: an AUD/USD entry
  // logged "(guaranteed)" from an ACCEPTED confirm, protectionOk true, yet
  // a live position fetch 7 minutes later found it naked with no stopLevel
  // at all — only caught because a different bot's unrelated self-heal
  // sweep happened to check it, not this function's own claim. Re-verify
  // against the live position instead of trusting the open confirm alone.
  if (guaranteedApplied) {
    try {
      const live = await fetchFullPositions(session);
      const pos  = live.find(p => p.dealId === dealId);
      if (!pos || pos.stopLevel === undefined) {
        protectionOk = false;
        protectionError = protectionError
          ? `${protectionError}; guaranteed stop not present on live position`
          : 'guaranteed stop not present on live position';
      }
    } catch {
      // Fetch failed — can't confirm either way; leave protectionOk as-is
      // rather than falsely flag a real success as unprotected.
    }
  }

  return { dealId, level, protectionOk, protectionError, guaranteedStop: guaranteedApplied };
}

export async function updatePositionLevels(
  session:    IGSession,
  dealId:     string,
  stopLevel:  number | null,
  limitLevel: number | null,
): Promise<void> {
  const base = BASE[session.env];
  const r = await fetch(`${base}/positions/otc/${encodeURIComponent(dealId)}`, {
    method: 'PUT', headers: headers(session, '2'),
    body: JSON.stringify({ stopLevel, limitLevel, trailingStop: false }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`updatePositionLevels ${r.status}: ${t.slice(0, 100)}`);
  }
}

export type MarketDetail = {
  epic:            string;
  minDealSize:     number;   // minimum £/point bet size
  minStopDist:     number;   // minimum stop distance in points
  // `| null`, not just optional — IG returns bid/offer as JSON null (not a
  // missing field) whenever there's no live quote, and null !== undefined
  // in JS. Every caller must check `typeof x === 'number'`, not
  // `!== undefined` — the latter silently passes null through and let
  // several real safety checks (spread-width, margin-sufficiency, a
  // Yahoo-rescale reference level) no-op across this session's live bots.
  bid?:            number | null;   // live snapshot — this endpoint isn't subject to the
  offer?:          number | null;   // historical-data allowance, unlike fetchCandleHistory
  marketStatus?:   string;   // 'TRADEABLE' | 'CLOSED' | 'EDITS_ONLY' | 'OFFLINE' | ...
                              // — IG's own real-time truth on whether this specific
                              // epic can actually be dealt right now, used instead of
                              // a fixed-hours guess for strategies that trade outside
                              // the primary exchange's cash session.
  marginFactorPct?: number;  // e.g. 20 = 20% of notional exposure required as margin —
                              // confirmed live this varies a lot by instrument (higher-
                              // priced-per-point shares need far more margin at even the
                              // IG minimum stake than a small account can supply).
};

export async function fetchMarketDetails(
  session: IGSession,
  epics:   string[],
): Promise<Map<string, MarketDetail>> {
  const result = new Map<string, MarketDetail>();
  if (!epics.length) return result;

  const base   = BASE[session.env];
  const BATCH  = 50;  // IG cap per request

  for (let i = 0; i < epics.length; i += BATCH) {
    const batch = epics.slice(i, i + BATCH);
    try {
      const url = `${base}/markets?epics=${batch.map(encodeURIComponent).join(',')}`;
      const r   = await fetch(url, { headers: headers(session, '2'), signal: AbortSignal.timeout(10_000) });
      if (!r.ok) {
        console.warn(`[igApi] fetchMarketDetails ${r.status} for batch ${i}`);
        continue;
      }
      const d = await r.json() as {
        marketDetails?: Array<{
          instrument?: { epic?: string; marginFactor?: number };
          dealingRules?: {
            minDealSize?: { value?: number };
            minControlledRiskStopDistance?: { value?: number };
            minNormalStopOrLimitDistance?:  { value?: number };
          };
          snapshot?: { bid?: number | null; offer?: number | null; marketStatus?: string };
        }>;
      };
      for (const m of d.marketDetails ?? []) {
        const epic       = m.instrument?.epic;
        if (!epic) continue;
        // `||` not `??` — a genuine 0 here isn't realistic (IG always has
        // some positive minimum), so treat it the same as missing rather
        // than let a stray 0 silently disable every downstream stake/stop
        // clamp that trusts this value.
        const minDeal    = m.dealingRules?.minDealSize?.value || 1;
        const minStop    = m.dealingRules?.minNormalStopOrLimitDistance?.value
                        || m.dealingRules?.minControlledRiskStopDistance?.value
                        || 1;
        result.set(epic, {
          epic, minDealSize: minDeal, minStopDist: minStop,
          bid: m.snapshot?.bid, offer: m.snapshot?.offer, marketStatus: m.snapshot?.marketStatus,
          marginFactorPct: m.instrument?.marginFactor,
        });
      }
    } catch (e) {
      console.warn(`[igApi] fetchMarketDetails batch failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}

// Market search — IG's only chain-discovery mechanism on this API (there's
// no options-chain endpoint; /marketnavigation 404s on demo, confirmed by
// direct probe 2026-08-31). Search matches instrument names token-wise, so
// an exact option name ("FTSE 10300 Call") reliably finds that strike's
// markets across expiries. Not allowance-gated (same class as the snapshot
// endpoint above, not fetchCandleHistory).
export type MarketSearchResult = { epic: string; name: string; instrumentType: string; expiry: string };

export async function searchMarkets(session: IGSession, term: string): Promise<MarketSearchResult[]> {
  const base = BASE[session.env];
  const r = await fetch(`${base}/markets?searchTerm=${encodeURIComponent(term)}`, {
    headers: headers(session, '1'), signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`searchMarkets ${r.status}`);
  const d = await r.json() as { markets?: Array<{ epic?: string; instrumentName?: string; instrumentType?: string; expiry?: string }> };
  return (d.markets ?? [])
    .filter(m => !!m.epic)
    .map(m => ({ epic: m.epic!, name: m.instrumentName ?? '', instrumentType: m.instrumentType ?? '', expiry: m.expiry ?? '' }));
}

export async function fetchAccountFunds(session: IGSession): Promise<{ available: number; balance: number }> {
  const base = BASE[session.env];
  const r = await fetch(`${base}/accounts`, { headers: headers(session, '1'), signal: AbortSignal.timeout(8_000) });
  if (!r.ok) throw new Error(`fetchAccountFunds ${r.status}`);
  const d = await r.json() as {
    accounts?: Array<{ accountId: string; preferred: boolean; balance: { available: number; balance: number } }>;
  };
  const acct = d.accounts?.find(a => a.accountId === session.accountId) ?? d.accounts?.[0];
  return { available: acct?.balance.available ?? 0, balance: acct?.balance.balance ?? 0 };
}

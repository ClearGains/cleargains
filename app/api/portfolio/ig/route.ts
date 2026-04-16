import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/portfolio/ig
 * Body: { apiKey, cst, securityToken, env }
 *
 * Uses the tokens exactly as received (already pointing at the correct
 * account after /api/ig/session handled the SPREADBET switch).
 * Also fetches the accounts list so the caller knows all sub-accounts.
 * Returns a `steps` array for diagnostics.
 */
export async function POST(request: NextRequest) {
  const steps: string[] = [];

  const body = await request.json() as {
    apiKey?: string; cst?: string; securityToken?: string; env?: string;
  };
  const { apiKey, cst, securityToken, env = 'demo' } = body;

  steps.push(`[1] env=${env}, apiKey=${apiKey?.slice(0, 8) ?? 'MISSING'}…, CST=${cst ? cst.slice(0, 10) + '…' : 'MISSING'}`);

  if (!apiKey || !cst || !securityToken) {
    steps.push('[1] ✗ Missing credentials');
    return NextResponse.json({ ok: false, error: 'Missing IG credentials', steps }, { status: 400 });
  }

  const base = env === 'demo'
    ? 'https://demo-api.ig.com/gateway/deal'
    : 'https://api.ig.com/gateway/deal';

  const commonHeaders = {
    'X-IG-API-KEY':     apiKey,
    'CST':              cst,
    'X-SECURITY-TOKEN': securityToken,
    'Accept':           'application/json; charset=UTF-8',
  };

  // ── Step 2: Fetch accounts list ─────────────────────────────────────────
  type IGAccount = {
    accountId: string; accountName: string; accountType: string; preferred: boolean;
    balance: { balance: number; deposit: number; profitLoss: number; available: number };
    currency: string; status: string;
  };

  let allAccounts: IGAccount[] = [];
  steps.push(`[2] GET ${base}/accounts`);
  try {
    const accountsRes = await fetch(`${base}/accounts`, {
      headers: { ...commonHeaders, 'Version': '1' },
      signal: AbortSignal.timeout(10_000),
    });
    steps.push(`[2] HTTP ${accountsRes.status}`);
    if (accountsRes.ok) {
      const d = await accountsRes.json() as { accounts?: IGAccount[] };
      allAccounts = d.accounts ?? [];
      steps.push(`[2] Found ${allAccounts.length} account(s): ${allAccounts.map(a => `${a.accountId}(${a.accountType})`).join(', ')}`);
    } else {
      const t = await accountsRes.text().catch(() => '');
      steps.push(`[2] ✗ Accounts fetch failed: ${t.slice(0, 150)}`);
    }
  } catch (e) {
    steps.push(`[2] ✗ Exception: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── Step 3: Fetch positions using the tokens we received ────────────────
  // Do NOT switch accounts — the tokens from /api/ig/session are already
  // pointing at the correct (SPREADBET) account after the login+switch.

  type IGRawPos = {
    position?: {
      dealId?: string; size?: number; direction?: string; level?: number;
      currency?: string; stopLevel?: number; limitLevel?: number;
      createdDate?: string; createdDateUTC?: string;
    };
    market?: {
      epic?: string; instrumentName?: string; bid?: number; offer?: number;
      percentageChange?: number; instrumentType?: string;
    };
  };

  type IGWorkingOrder = {
    workingOrderData?: {
      dealId?: string; direction?: string; size?: number; orderLevel?: number;
      orderType?: string; currencyCode?: string; goodTillDate?: string | null; createdDate?: string;
    };
    marketData?: { epic?: string; instrumentName?: string };
  };

  steps.push(`[3] GET ${base}/positions/otc (Version: 2, using initial tokens — no account switch)`);
  let rawPositions: IGRawPos[] = [];
  let rawPosText = '';
  try {
    const posRes = await fetch(`${base}/positions/otc`, {
      headers: { ...commonHeaders, 'Version': '2' },
      signal: AbortSignal.timeout(10_000),
    });
    steps.push(`[3] HTTP ${posRes.status}`);
    rawPosText = await posRes.text().catch(() => '');
    if (posRes.ok || posRes.status === 200) {
      const d = JSON.parse(rawPosText) as { positions?: IGRawPos[] };
      rawPositions = d.positions ?? [];
      steps.push(`[3] Positions found: ${rawPositions.length}`);
      rawPositions.slice(0, 3).forEach((p, i) => {
        steps.push(`[3] pos[${i}]: dealId=${p.position?.dealId ?? '?'} dir=${p.position?.direction ?? '?'} epic=${p.market?.epic ?? '?'}`);
      });
      if (rawPositions.length === 0) {
        steps.push('[3] ⚠ 0 positions. Raw: ' + rawPosText.slice(0, 200));
      }
    } else if (posRes.status === 404) {
      steps.push('[3] 404 — account has no open positions');
    } else {
      steps.push(`[3] ✗ Error: ${rawPosText.slice(0, 200)}`);
    }
  } catch (e) {
    steps.push(`[3] ✗ Exception: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── Step 4: Fetch working orders ────────────────────────────────────────
  steps.push(`[4] GET ${base}/workingorders/otc`);
  let rawOrders: IGWorkingOrder[] = [];
  try {
    const ordRes = await fetch(`${base}/workingorders/otc`, {
      headers: { ...commonHeaders, 'Version': '2' },
      signal: AbortSignal.timeout(10_000),
    });
    steps.push(`[4] HTTP ${ordRes.status}`);
    if (ordRes.ok) {
      const d = await ordRes.json() as { workingOrders?: IGWorkingOrder[] };
      rawOrders = d.workingOrders ?? [];
      steps.push(`[4] Working orders: ${rawOrders.length}`);
    }
  } catch (e) {
    steps.push(`[4] ✗ Exception: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── Normalise ────────────────────────────────────────────────────────────
  const positions = rawPositions.map((p) => {
    const direction = p.position?.direction ?? '';
    const level     = p.position?.level ?? 0;
    const size      = p.position?.size ?? 0;
    const bid       = p.market?.bid ?? 0;
    const offer     = p.market?.offer ?? 0;
    const curr      = direction === 'BUY' ? bid : offer;
    const upl       = direction === 'BUY' ? (bid - level) * size : (level - offer) * size;
    return {
      dealId:         p.position?.dealId ?? '',
      direction,
      size,
      level,
      currency:       p.position?.currency ?? 'GBP',
      stopLevel:      p.position?.stopLevel,
      limitLevel:     p.position?.limitLevel,
      createdDate:    p.position?.createdDateUTC ?? p.position?.createdDate,
      epic:           p.market?.epic ?? '',
      instrumentName: p.market?.instrumentName ?? '',
      bid, offer,
      currentPrice:   curr,
      upl:            Math.round(upl * 100) / 100,
      uplPct:         level > 0 ? Math.round((upl / (level * size)) * 10000) / 100 : 0,
      instrumentType: p.market?.instrumentType,
      // Tag with the preferred/active account info
      accountId:   allAccounts.find(a => a.preferred)?.accountId ?? allAccounts[0]?.accountId ?? '',
      accountType: allAccounts.find(a => a.preferred)?.accountType ?? allAccounts[0]?.accountType ?? '',
      accountName: allAccounts.find(a => a.preferred)?.accountName ?? allAccounts[0]?.accountName ?? '',
    };
  });

  const workingOrders = rawOrders.map((o) => ({
    dealId:         o.workingOrderData?.dealId ?? '',
    direction:      o.workingOrderData?.direction ?? '',
    size:           o.workingOrderData?.size ?? 0,
    orderLevel:     o.workingOrderData?.orderLevel ?? 0,
    orderType:      o.workingOrderData?.orderType ?? '',
    currency:       o.workingOrderData?.currencyCode ?? 'GBP',
    createdDate:    o.workingOrderData?.createdDate,
    goodTillDate:   o.workingOrderData?.goodTillDate ?? null,
    epic:           o.marketData?.epic ?? '',
    instrumentName: o.marketData?.instrumentName ?? '',
  }));

  const preferred  = allAccounts.find(a => a.preferred) ?? allAccounts[0] ?? null;
  const totalUpl   = positions.reduce((s, p) => s + p.upl, 0);

  steps.push(`[5] Done — returning ${positions.length} positions, ${workingOrders.length} orders`);

  return NextResponse.json({
    ok: true,
    positions,
    workingOrders,
    accounts:  allAccounts,
    activeAccount: preferred ? {
      balance:     preferred.balance?.balance    ?? 0,
      available:   preferred.balance?.available  ?? 0,
      deposit:     preferred.balance?.deposit    ?? 0,
      profitLoss:  preferred.balance?.profitLoss ?? totalUpl,
      currency:    preferred.currency,
      accountType: preferred.accountType,
    } : null,
    summary: {
      positionCount:  positions.length,
      workingOrders:  workingOrders.length,
      totalUpl,
    },
    steps,
    rawPositionsResponse: rawPosText.slice(0, 1000),
  });
}

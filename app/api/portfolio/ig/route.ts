import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/portfolio/ig
 * Body: { apiKey, cst, securityToken, env }
 *
 * Iterates every IG sub-account (SPREADBET, CFD, SHARES…),
 * switches to each one, fetches its positions + working orders,
 * then returns all positions tagged with accountId / accountType.
 */
export async function POST(request: NextRequest) {
  const body = await request.json() as {
    apiKey?: string; cst?: string; securityToken?: string; env?: string;
  };
  const { apiKey, cst: initCst, securityToken: initSecToken, env = 'demo' } = body;

  if (!apiKey || !initCst || !initSecToken) {
    return NextResponse.json({ ok: false, error: 'Missing IG credentials' }, { status: 400 });
  }

  const base = env === 'demo'
    ? 'https://demo-api.ig.com/gateway/deal'
    : 'https://api.ig.com/gateway/deal';

  // ── Step 1: Fetch all accounts ────────────────────────────────────────────
  type IGAccount = {
    accountId: string; accountName: string; accountType: string; preferred: boolean;
    balance: { balance: number; deposit: number; profitLoss: number; available: number };
    currency: string; status: string;
  };

  let allAccounts: IGAccount[] = [];
  try {
    const accountsRes = await fetch(`${base}/accounts`, {
      headers: {
        'X-IG-API-KEY':     apiKey,
        'CST':              initCst,
        'X-SECURITY-TOKEN': initSecToken,
        'Accept':           'application/json; charset=UTF-8',
        'Version':          '1',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (accountsRes.ok) {
      const d = await accountsRes.json() as { accounts?: IGAccount[] };
      allAccounts = d.accounts ?? [];
    }
  } catch { /* fall through — will try with initCst tokens directly */ }

  // ── Step 2: For each account, switch + fetch positions ───────────────────
  type IGRawPos = {
    position?: {
      dealId?: string; dealReference?: string; size?: number; direction?: string;
      level?: number; currency?: string; stopLevel?: number; limitLevel?: number;
      createdDate?: string; createdDateUTC?: string;
    };
    market?: {
      epic?: string; instrumentName?: string; bid?: number; offer?: number;
      percentageChange?: number; netChange?: number; instrumentType?: string;
    };
  };

  type IGWorkingOrder = {
    workingOrderData?: {
      dealId?: string; direction?: string; size?: number; orderLevel?: number;
      orderType?: string; currencyCode?: string; goodTillDate?: string | null;
      createdDate?: string;
    };
    marketData?: { epic?: string; instrumentName?: string; bid?: number; offer?: number };
  };

  interface NormalisedPosition {
    dealId: string; direction: string; size: number; level: number;
    currency: string; stopLevel?: number; limitLevel?: number; createdDate?: string;
    epic: string; instrumentName: string; bid: number; offer: number;
    currentPrice: number; upl: number; uplPct: number; instrumentType?: string;
    accountId: string; accountType: string; accountName: string;
  }

  interface NormalisedOrder {
    dealId: string; direction: string; size: number; orderLevel: number;
    orderType: string; currency: string; createdDate?: string;
    goodTillDate?: string | null; epic: string; instrumentName: string;
    accountId: string; accountType: string;
  }

  const allPositions:    NormalisedPosition[] = [];
  const allWorkingOrders: NormalisedOrder[]   = [];

  function normalisePositions(raw: IGRawPos[], accountId: string, accountType: string, accountName: string): NormalisedPosition[] {
    return raw.map((p) => {
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
        accountId,
        accountType,
        accountName,
      };
    });
  }

  function normaliseOrders(raw: IGWorkingOrder[], accountId: string, accountType: string): NormalisedOrder[] {
    return raw.map((o) => ({
      dealId:       o.workingOrderData?.dealId ?? '',
      direction:    o.workingOrderData?.direction ?? '',
      size:         o.workingOrderData?.size ?? 0,
      orderLevel:   o.workingOrderData?.orderLevel ?? 0,
      orderType:    o.workingOrderData?.orderType ?? '',
      currency:     o.workingOrderData?.currencyCode ?? 'GBP',
      createdDate:  o.workingOrderData?.createdDate,
      goodTillDate: o.workingOrderData?.goodTillDate ?? null,
      epic:         o.marketData?.epic ?? '',
      instrumentName: o.marketData?.instrumentName ?? '',
      accountId,
      accountType,
    }));
  }

  // If we have multiple accounts, iterate each; otherwise just fetch with initial tokens
  if (allAccounts.length > 0) {
    let cst           = initCst;
    let securityToken = initSecToken;

    for (const account of allAccounts) {
      // Switch to this account
      try {
        const switchRes = await fetch(`${base}/session`, {
          method: 'PUT',
          headers: {
            'X-IG-API-KEY':     apiKey,
            'CST':              cst,
            'X-SECURITY-TOKEN': securityToken,
            'Content-Type':     'application/json',
            'Accept':           'application/json; charset=UTF-8',
            'Version':          '1',
          },
          body: JSON.stringify({ accountId: account.accountId, dealingEnabled: true }),
          signal: AbortSignal.timeout(8_000),
        });
        if (switchRes.ok) {
          const newCst      = switchRes.headers.get('CST');
          const newSecToken = switchRes.headers.get('X-SECURITY-TOKEN');
          if (newCst)      cst           = newCst;
          if (newSecToken) securityToken = newSecToken;
        }
      } catch { /* continue with current tokens */ }

      const switchedHeaders = {
        'X-IG-API-KEY':     apiKey,
        'CST':              cst,
        'X-SECURITY-TOKEN': securityToken,
        'Accept':           'application/json; charset=UTF-8',
      };

      // Fetch positions + working orders in parallel for this account
      const [posRes, ordersRes] = await Promise.all([
        fetch(`${base}/positions/otc`, {
          headers: { ...switchedHeaders, 'Version': '2' },
          signal: AbortSignal.timeout(10_000),
        }).catch(() => null),
        fetch(`${base}/workingorders/otc`, {
          headers: { ...switchedHeaders, 'Version': '2' },
          signal: AbortSignal.timeout(10_000),
        }).catch(() => null),
      ]);

      if (posRes && posRes.ok) {
        const d = await posRes.json().catch(() => null) as { positions?: IGRawPos[] } | null;
        if (d?.positions) {
          allPositions.push(...normalisePositions(d.positions, account.accountId, account.accountType, account.accountName));
        }
      }
      if (ordersRes && ordersRes.ok) {
        const d = await ordersRes.json().catch(() => null) as { workingOrders?: IGWorkingOrder[] } | null;
        if (d?.workingOrders) {
          allWorkingOrders.push(...normaliseOrders(d.workingOrders, account.accountId, account.accountType));
        }
      }
    }
  } else {
    // No accounts list — fetch with initial tokens directly
    const commonHeaders = {
      'X-IG-API-KEY':     apiKey,
      'CST':              initCst,
      'X-SECURITY-TOKEN': initSecToken,
      'Accept':           'application/json; charset=UTF-8',
    };
    const [posRes, ordersRes] = await Promise.all([
      fetch(`${base}/positions/otc`, { headers: { ...commonHeaders, 'Version': '2' }, signal: AbortSignal.timeout(10_000) }).catch(() => null),
      fetch(`${base}/workingorders/otc`, { headers: { ...commonHeaders, 'Version': '2' }, signal: AbortSignal.timeout(10_000) }).catch(() => null),
    ]);
    if (posRes && posRes.ok) {
      const d = await posRes.json().catch(() => null) as { positions?: IGRawPos[] } | null;
      if (d?.positions) allPositions.push(...normalisePositions(d.positions, 'default', 'UNKNOWN', 'IG Account'));
    }
    if (ordersRes && ordersRes.ok) {
      const d = await ordersRes.json().catch(() => null) as { workingOrders?: IGWorkingOrder[] } | null;
      if (d?.workingOrders) allWorkingOrders.push(...normaliseOrders(d.workingOrders, 'default', 'UNKNOWN'));
    }
  }

  // ── Step 3: Preferred account summary ────────────────────────────────────
  const preferred = allAccounts.find(a => a.preferred) ?? allAccounts[0] ?? null;
  const totalUpl   = allPositions.reduce((s, p) => s + p.upl, 0);

  return NextResponse.json({
    ok: true,
    positions:     allPositions,
    workingOrders: allWorkingOrders,
    accounts:      allAccounts,
    activeAccount: preferred ? {
      balance:     preferred.balance?.balance    ?? 0,
      available:   preferred.balance?.available  ?? 0,
      deposit:     preferred.balance?.deposit    ?? 0,
      profitLoss:  preferred.balance?.profitLoss ?? totalUpl,
      currency:    preferred.currency,
      accountType: preferred.accountType,
    } : null,
    summary: {
      positionCount:  allPositions.length,
      workingOrders:  allWorkingOrders.length,
      totalUpl,
    },
  });
}

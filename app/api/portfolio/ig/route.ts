import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/portfolio/ig
 * Body: { apiKey, cst, securityToken, env }
 *
 * Fetches IG positions + accounts + working orders in one shot.
 */
export async function POST(request: NextRequest) {
  const body = await request.json() as {
    apiKey?: string; cst?: string; securityToken?: string; env?: string;
  };
  const { apiKey, cst, securityToken, env = 'demo' } = body;

  if (!apiKey || !cst || !securityToken) {
    return NextResponse.json({ ok: false, error: 'Missing IG credentials' }, { status: 400 });
  }

  const base = env === 'demo'
    ? 'https://demo-api.ig.com/gateway/deal'
    : 'https://api.ig.com/gateway/deal';

  const commonHeaders = {
    'X-IG-API-KEY':     apiKey,
    'CST':              cst,
    'X-SECURITY-TOKEN': securityToken,
    'Content-Type':     'application/json',
    'Accept':           'application/json; charset=UTF-8',
  };

  async function safeFetch(url: string, version = '1') {
    try {
      const r = await fetch(url, {
        headers: { ...commonHeaders, 'Version': version },
        signal: AbortSignal.timeout(10_000),
      });
      // 404 = no positions (not an error)
      if (r.status === 404) return null;
      if (!r.ok) return null;
      return r.json() as Promise<unknown>;
    } catch { return null; }
  }

  const [positionsRaw, accountsRaw, workingOrdersRaw] = await Promise.all([
    safeFetch(`${base}/positions/otc`, '2'),
    safeFetch(`${base}/accounts`, '1'),
    safeFetch(`${base}/workingorders/otc`, '2'),
  ]);

  // Normalise positions
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

  const rawPositions = ((positionsRaw as { positions?: IGRawPos[] } | null)?.positions ?? []);
  const positions = rawPositions.map((p: IGRawPos) => {
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
    };
  });

  // Accounts
  type IGAccount = {
    accountId: string; accountName: string; accountType: string; preferred: boolean;
    balance: { balance: number; deposit: number; profitLoss: number; available: number };
    currency: string; status: string;
  };
  const accounts = ((accountsRaw as { accounts?: IGAccount[] } | null)?.accounts ?? []) as IGAccount[];
  const preferred = accounts.find(a => a.preferred) ?? accounts[0] ?? null;

  // Working orders
  type IGWorkingOrder = {
    workingOrderData?: {
      dealId?: string; direction?: string; size?: number; orderLevel?: number;
      orderType?: string; currencyCode?: string; goodTillDate?: string | null;
      createdDate?: string; dealReference?: string;
    };
    marketData?: { epic?: string; instrumentName?: string; bid?: number; offer?: number };
  };
  const rawOrders = ((workingOrdersRaw as { workingOrders?: IGWorkingOrder[] } | null)?.workingOrders ?? []);
  const workingOrders = rawOrders.map((o: IGWorkingOrder) => ({
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

  const totalUpl = positions.reduce((s, p) => s + p.upl, 0);

  return NextResponse.json({
    ok: true,
    positions,
    workingOrders,
    accounts,
    activeAccount: preferred ? {
      balance:    preferred.balance?.balance    ?? 0,
      available:  preferred.balance?.available  ?? 0,
      deposit:    preferred.balance?.deposit    ?? 0,
      profitLoss: preferred.balance?.profitLoss ?? totalUpl,
      currency:   preferred.currency,
      accountType: preferred.accountType,
    } : null,
    summary: {
      positionCount:  positions.length,
      workingOrders:  workingOrders.length,
      totalUpl,
    },
  });
}

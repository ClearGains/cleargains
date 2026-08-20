import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/portfolio/t212
 * Body: { encoded: string (btoa(key+':'+secret)), env: 'live'|'demo' }
 *
 * Fetches T212 positions + cash + account summary in one shot.
 */
export async function POST(request: NextRequest) {
  const body = await request.json() as { encoded?: string; env?: string };
  const { encoded, env = 'live' } = body;

  if (!encoded) {
    return NextResponse.json({ ok: false, error: 'Missing credentials' }, { status: 400 });
  }

  const base = env === 'demo'
    ? 'https://demo.trading212.com/api/v0'
    : 'https://live.trading212.com/api/v0';

  const headers = {
    Authorization: 'Basic ' + encoded,
    'Content-Type': 'application/json',
  };

  async function safeFetch(url: string) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return null;
      return r.json() as Promise<unknown>;
    } catch { return null; }
  }

  const [positionsRaw, cashRaw, ordersRaw] = await Promise.all([
    // Was /equity/portfolio, an older endpoint whose currentPrice/averagePrice
    // are documented as "in instrument currency" (USD for a US stock) with no
    // account-currency figure at all — every position's value/P&L was being
    // computed as curr*qty and displayed with a £ prefix as if that were
    // already GBP. Confirmed live: T212's own app showed £5,230.96 invested,
    // this route reported £7,134.82 for the same 17-position portfolio — a
    // ~36% inflation, consistent with US-stock $ face values read as £ with
    // no FX conversion (GBP/USD ~0.73 explains the ratio almost exactly).
    // /equity/positions is the current endpoint and includes walletImpact,
    // which T212 computes in the account's own currency — use that instead
    // of reconstructing an FX conversion ourselves.
    safeFetch(`${base}/equity/positions`),
    safeFetch(`${base}/equity/account/cash`),
    safeFetch(`${base}/equity/orders?limit=50`),
  ]);

  // Normalise positions
  type T212WalletImpact = {
    currency?: string; currentValue?: number; fxImpact?: number;
    totalCost?: number; unrealizedProfitLoss?: number;
  };
  type T212RawPos = {
    quantity?: number; averagePricePaid?: number; currentPrice?: number;
    createdAt?: string; instrument?: { ticker?: string; name?: string; currency?: string };
    walletImpact?: T212WalletImpact;
  };
  const rawItems = Array.isArray(positionsRaw) ? (positionsRaw as T212RawPos[]) : [];

  const positions = rawItems.map((p: T212RawPos) => {
    const qty   = Number(p.quantity ?? 0);
    // Per-share prices stay in instrument currency (USD etc.) for display —
    // that's the stock's real quoted price, genuinely useful as-is. Only the
    // aggregated value/P&L need the account-currency figures below.
    const entry = Number(p.averagePricePaid ?? 0);
    const curr  = Number(p.currentPrice ?? 0);
    const wi    = p.walletImpact;
    const value = Number(wi?.currentValue ?? (curr * qty));
    const pnl   = Number(wi?.unrealizedProfitLoss ?? ((curr - entry) * qty));
    const totalCost = Number(wi?.totalCost ?? (entry * qty));
    return {
      ticker:       String(p.instrument?.ticker ?? ''),
      name:         String(p.instrument?.ticker ?? '').replace(/_[A-Z]{2}_[A-Z]{2}$/, ''),
      quantity:     qty,
      averagePrice: entry,
      currentPrice: curr,
      pnl:          Math.round(pnl * 100) / 100,
      pnlPct:       totalCost > 0 ? Math.round((pnl / totalCost) * 10000) / 100 : 0,
      value:        Math.round(value * 100) / 100,
      initialFillDate: p.createdAt,
    };
  });

  // Cash
  type T212Cash = { free?: number; total?: number; ppl?: number; invested?: number; blocked?: number };
  const cash = cashRaw as T212Cash | null;

  // Working orders
  type T212Order = {
    id?: number; ticker?: string; type?: string; quantity?: number;
    limitPrice?: number; stopPrice?: number; status?: string; creationTime?: string;
  };
  const ordersData = ordersRaw as { items?: T212Order[] } | T212Order[] | null;
  const orders = Array.isArray(ordersData)
    ? (ordersData as T212Order[])
    : ((ordersData as { items?: T212Order[] } | null)?.items ?? []);

  const totalValue  = positions.reduce((s, p) => s + p.value, 0);
  const totalPnL    = positions.reduce((s, p) => s + p.pnl, 0);

  return NextResponse.json({
    ok:             true,
    positions,
    orders,
    cash: {
      available:  cash?.free     ?? 0,
      total:      cash?.total    ?? 0,
      invested:   cash?.invested ?? 0,
      ppl:        cash?.ppl      ?? totalPnL,
      blocked:    cash?.blocked  ?? 0,
    },
    summary: {
      totalValue:  Math.round((totalValue + (cash?.free ?? 0)) * 100) / 100,
      totalPnL,
      positionCount: positions.length,
    },
  });
}

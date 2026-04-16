import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/portfolio/t212
 * Body: { encoded: string (btoa(key+':'+secret)), env: 'live'|'demo' }
 *
 * Fetches T212 positions + cash + account summary in one shot.
 */
export async function POST(request: NextRequest) {
  const body = await request.json() as { encoded?: string; key?: string; secret?: string; env?: string };
  const { env = 'live' } = body;

  // Accept either pre-encoded Basic auth or raw key+secret
  let encoded = body.encoded;
  if (!encoded && body.key && body.secret) {
    encoded = Buffer.from(`${body.key}:${body.secret}`).toString('base64');
  }

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
    safeFetch(`${base}/equity/portfolio`),
    safeFetch(`${base}/equity/account/cash`),
    safeFetch(`${base}/equity/orders?limit=50`),
  ]);

  // Normalise positions
  type T212RawPos = {
    ticker?: string; quantity?: number; averagePrice?: number;
    currentPrice?: number; ppl?: number; fxPpl?: number; initialFillDate?: string;
  };
  const rawItems = Array.isArray(positionsRaw)
    ? (positionsRaw as T212RawPos[])
    : ((positionsRaw as Record<string, T212RawPos[]> | null)?.items ?? []);

  const positions = rawItems.map((p: T212RawPos) => {
    const qty   = Number(p.quantity ?? 0);
    const entry = Number(p.averagePrice ?? 0);
    const curr  = Number(p.currentPrice ?? 0);
    const pnl   = Number(p.ppl ?? ((curr - entry) * qty));
    return {
      ticker:       String(p.ticker ?? ''),
      name:         String(p.ticker ?? '').replace(/_[A-Z]{2}_[A-Z]{2}$/, ''),
      quantity:     qty,
      averagePrice: entry,
      currentPrice: curr,
      pnl:          Math.round(pnl * 100) / 100,
      pnlPct:       entry > 0 ? Math.round(((curr - entry) / entry) * 10000) / 100 : 0,
      value:        Math.round(curr * qty * 100) / 100,
      initialFillDate: p.initialFillDate,
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

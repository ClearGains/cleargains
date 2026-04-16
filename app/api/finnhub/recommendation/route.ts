/**
 * GET /api/finnhub/recommendation?symbol=AAPL
 *
 * Returns the latest analyst consensus recommendation from Finnhub.
 * Only meaningful for US/UK stocks — returns null for forex/crypto.
 *
 * Cache: 1 hour (recommendations change infrequently)
 */

import { NextRequest, NextResponse } from 'next/server';
import { FINNHUB_KEY, FINNHUB_BASE } from '@/lib/finnhubConfig';

export interface RecommendationData {
  strongBuy:   number;
  buy:         number;
  hold:        number;
  sell:        number;
  strongSell:  number;
  total:       number;
  bullScore:   number;  // 0–100: proportion of buy+strongBuy (weighted)
  bearScore:   number;  // 0–100: proportion of sell+strongSell (weighted)
  period:      string;
}

const cache = new Map<string, { data: RecommendationData; expiresAt: number }>();
const TTL   = 60 * 60_000;  // 1 hour

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get('symbol') ?? '';
  if (!symbol) {
    return NextResponse.json({ ok: false, error: 'symbol required' }, { status: 400 });
  }

  const hit = cache.get(symbol);
  if (hit && hit.expiresAt > Date.now()) {
    return NextResponse.json({ ok: true, ...hit.data, cached: true });
  }

  if (!FINNHUB_KEY) {
    return NextResponse.json({ ok: false, error: 'FINNHUB_API_KEY not configured' }, { status: 503 });
  }

  try {
    const res = await fetch(
      `${FINNHUB_BASE}/stock/recommendation?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`,
      { signal: AbortSignal.timeout(6_000) },
    );

    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `Finnhub ${res.status}` }, { status: res.status });
    }

    const recs = await res.json() as Array<{
      strongBuy: number; buy: number; hold: number; sell: number; strongSell: number; period: string;
    }>;

    if (!recs || recs.length === 0) {
      return NextResponse.json({ ok: false, error: 'No recommendation data' }, { status: 404 });
    }

    const r     = recs[0];   // most recent period
    const total = r.strongBuy + r.buy + r.hold + r.sell + r.strongSell;

    // Weighted: strongBuy/strongSell count double
    const bullW = (r.strongBuy * 2 + r.buy);
    const bearW = (r.strongSell * 2 + r.sell);
    const maxW  = total * 2;

    const data: RecommendationData = {
      strongBuy:  r.strongBuy,
      buy:        r.buy,
      hold:       r.hold,
      sell:       r.sell,
      strongSell: r.strongSell,
      total,
      bullScore:  maxW > 0 ? Math.round((bullW / maxW) * 100) : 50,
      bearScore:  maxW > 0 ? Math.round((bearW / maxW) * 100) : 50,
      period:     r.period,
    };

    cache.set(symbol, { data, expiresAt: Date.now() + TTL });
    return NextResponse.json({ ok: true, ...data, cached: false });

  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

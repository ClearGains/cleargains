/**
 * /api/ig/candles
 *
 * Returns a real-time market snapshot (current price + previous close) using
 * Yahoo Finance's chart API.  No historical candles, no Finnhub, zero IG
 * historical-data allowance consumed.
 *
 * Signal logic:
 *   daily change > +0.3%  → BUY
 *   daily change < -0.3%  → SELL
 *   otherwise             → NEUTRAL
 *
 * IG is used only for order execution (positions/otc), never for prices here.
 */

import { NextRequest, NextResponse } from 'next/server';

// ── Symbol map ────────────────────────────────────────────────────────────────

const YAHOO_MAP: Record<string, string> = {
  // Indices
  'FTSE 100':      '^FTSE',
  'S&P 500':       '^GSPC',
  'NASDAQ 100':    '^IXIC',
  'Germany 40':    '^GDAXI',
  'Wall Street':   '^DJI',
  'Japan 225':     '^N225',
  'Australia 200': '^AXJO',
  // Commodities
  'Gold':          'GC=F',
  'Oil (WTI)':     'CL=F',
  'Brent Crude':   'BZ=F',
  'Silver':        'SI=F',
  'Natural Gas':   'NG=F',
  // Forex
  'GBP/USD':       'GBPUSD=X',
  'EUR/USD':       'EURUSD=X',
  'EUR/GBP':       'EURGBP=X',
  'USD/JPY':       'JPY=X',
  'AUD/USD':       'AUDUSD=X',
  'USD/CHF':       'USDCHF=X',
  // Crypto
  'Bitcoin':       'BTC-USD',
  'Ethereum':      'ETH-USD',
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MarketSnapshot {
  price:         number;
  previousClose: number;
  changePercent: number;
  signal:        'BUY' | 'SELL' | 'NEUTRAL';
  source:        'yahoo';
}

// ── Cache (5 min) ──────────────────────────────────────────────────────────────

const cache = new Map<string, { data: MarketSnapshot; expiresAt: number }>();
const CACHE_TTL = 5 * 60_000;

// ── Yahoo Finance fetch ───────────────────────────────────────────────────────

async function fetchSnapshot(name: string): Promise<MarketSnapshot | null> {
  const symbol = YAHOO_MAP[name];
  if (!symbol) return null;

  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/` +
    `${encodeURIComponent(symbol)}?interval=1d&range=2d`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) return null;

    const json = await res.json() as {
      chart?: {
        result?: Array<{
          meta?: {
            regularMarketPrice?: number;
            previousClose?: number;
            chartPreviousClose?: number;
          };
        }>;
        error?: { description?: string };
      };
    };

    if (json.chart?.error) return null;

    const meta = json.chart?.result?.[0]?.meta;
    if (!meta) return null;

    const price         = meta.regularMarketPrice;
    const previousClose = meta.previousClose ?? meta.chartPreviousClose;

    if (!price || !previousClose) return null;

    const changePercent = ((price - previousClose) / previousClose) * 100;
    const signal: MarketSnapshot['signal'] =
      changePercent >  0.3 ? 'BUY'  :
      changePercent < -0.3 ? 'SELL' :
      'NEUTRAL';

    return { price, previousClose, changePercent, signal, source: 'yahoo' };
  } catch {
    return null;
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const name = searchParams.get('name') ?? '';
  // timeframe is accepted but unused — signal is purely price-momentum based

  if (!name) {
    return NextResponse.json({ ok: false, error: 'name parameter required' }, { status: 400 });
  }
  if (!YAHOO_MAP[name]) {
    return NextResponse.json(
      { ok: false, error: `No Yahoo Finance symbol mapping for "${name}". Add it to YAHOO_MAP.` },
      { status: 400 },
    );
  }

  // Cache hit
  const hit = cache.get(name);
  if (hit && hit.expiresAt > Date.now()) {
    return NextResponse.json({ ok: true, ...hit.data, cached: true });
  }

  const snapshot = await fetchSnapshot(name);
  if (!snapshot) {
    return NextResponse.json(
      { ok: false, error: `Yahoo Finance returned no data for "${name}". Market may be closed.` },
      { status: 502 },
    );
  }

  cache.set(name, { data: snapshot, expiresAt: Date.now() + CACHE_TTL });
  return NextResponse.json({ ok: true, ...snapshot, cached: false });
}

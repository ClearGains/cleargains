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
  // ── Volatility ────────────────────────────────────────────────────────────
  'VIX':              '^VIX',
  // ── Indices ───────────────────────────────────────────────────────────────
  'FTSE 100':         '^FTSE',
  'FTSE 100 CFD':     '^FTSE',
  'S&P 500':          '^GSPC',
  'S&P 500 CFD':      '^GSPC',
  'NASDAQ 100':       '^NDX',
  'NASDAQ 100 CFD':   '^NDX',
  'Wall Street':      '^DJI',
  'Wall Street (Dow)':'^DJI',
  'Dow Jones':        '^DJI',
  'Germany 40':       '^GDAXI',
  'Germany 40 (DAX)': '^GDAXI',
  'Japan 225':        '^N225',
  'Australia 200':    '^AXJO',
  // ── Commodities ───────────────────────────────────────────────────────────
  'Gold':             'GC=F',
  'Silver':           'SI=F',
  'Oil (WTI)':        'CL=F',
  'Brent Crude':      'BZ=F',
  'Natural Gas':      'NG=F',
  // ── Forex ─────────────────────────────────────────────────────────────────
  'GBP/USD':          'GBPUSD=X',
  'EUR/USD':          'EURUSD=X',
  'EUR/GBP':          'EURGBP=X',
  'USD/JPY':          'JPY=X',
  'AUD/USD':          'AUDUSD=X',
  'USD/CHF':          'CHF=X',
  // ── Crypto ────────────────────────────────────────────────────────────────
  'Bitcoin':          'BTC-USD',
  'Ethereum':         'ETH-USD',
  // ── US Stocks ─────────────────────────────────────────────────────────────
  'Apple':            'AAPL',
  'Tesla':            'TSLA',
  'Microsoft':        'MSFT',
  'Amazon':           'AMZN',
  'NVIDIA':           'NVDA',
  'Meta':             'META',
  'Alphabet (GOOGL)': 'GOOGL',
  'Google':           'GOOGL',
  'Netflix':          'NFLX',
};

/**
 * Smart Yahoo Finance symbol guesser for instruments not in YAHOO_MAP.
 *
 * Priority order:
 *  1. UA.D.{TICKER}.CASH.IP  → extract ticker directly
 *  2. CS.D.{PAIR6}.*.IP      → reformat as {PAIR6}=X (forex)
 *  3. Heuristics on instrument name (indices, commodities, crypto)
 */
function guessYahooSymbol(name: string, epic?: string): string | null {
  // Stock CFDs: UA.D.AAPL.CASH.IP → AAPL
  if (epic) {
    const stockMatch = epic.match(/^UA\.D\.([A-Z]+)\.CASH\.IP$/);
    if (stockMatch) return stockMatch[1];

    // Forex rolling/today epics: CS.D.GBPUSD.TODAY.IP → GBPUSD=X
    const fxMatch = epic.match(/^CS\.D\.([A-Z]{6})\./);
    if (fxMatch) return `${fxMatch[1]}=X`;
  }

  const n = name.toLowerCase();

  // Index name heuristics
  if (n.includes('ftse') || n.includes('uk 100'))        return '^FTSE';
  if (n.includes('s&p') || n.includes('sp 500'))         return '^GSPC';
  if (n.includes('nasdaq'))                               return '^NDX';
  if (n.includes('dow') || n.includes('wall street'))     return '^DJI';
  if (n.includes('dax') || n.includes('germany 40'))      return '^GDAXI';
  if (n.includes('nikkei') || n.includes('japan 225'))    return '^N225';
  if (n.includes('hang seng') || n.includes('hong kong')) return '^HSI';
  if (n.includes('asx') || n.includes('australia'))       return '^AXJO';
  if (n.includes('cac') || n.includes('france 40'))       return '^FCHI';
  if (n.includes('euro stoxx'))                           return '^STOXX50E';

  // Commodity name heuristics
  if (n.includes('gold'))                                 return 'GC=F';
  if (n.includes('silver'))                               return 'SI=F';
  if (n.includes('crude') || n.includes('wti') || (n.includes('oil') && !n.includes('brent'))) return 'CL=F';
  if (n.includes('brent'))                                return 'BZ=F';
  if (n.includes('natural gas') || n.includes('natgas')) return 'NG=F';
  if (n.includes('copper'))                               return 'HG=F';
  if (n.includes('wheat'))                                return 'ZW=F';

  // Crypto heuristics
  if (n.includes('bitcoin') || n.includes('btc'))         return 'BTC-USD';
  if (n.includes('ethereum') || n.includes('eth'))        return 'ETH-USD';

  return null;
}

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

async function fetchSnapshot(name: string, epic?: string): Promise<MarketSnapshot | null> {
  const symbol = YAHOO_MAP[name] ?? guessYahooSymbol(name, epic);
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
  const epic = searchParams.get('epic') ?? undefined;

  if (!name) {
    return NextResponse.json({ ok: false, error: 'name parameter required' }, { status: 400 });
  }

  const resolvedSymbol = YAHOO_MAP[name] ?? guessYahooSymbol(name, epic);
  if (!resolvedSymbol) {
    return NextResponse.json(
      { ok: false, error: `No Yahoo Finance symbol mapping for "${name}". Add a mapping or pass epic= for auto-detection.` },
      { status: 400 },
    );
  }

  // Cache by name (symbol resolution is deterministic)
  const hit = cache.get(name);
  if (hit && hit.expiresAt > Date.now()) {
    return NextResponse.json({ ok: true, ...hit.data, cached: true });
  }

  const snapshot = await fetchSnapshot(name, epic);
  if (!snapshot) {
    return NextResponse.json(
      { ok: false, error: `Yahoo Finance returned no data for "${name}" (symbol: ${resolvedSymbol}). Market may be closed.` },
      { status: 502 },
    );
  }

  cache.set(name, { data: snapshot, expiresAt: Date.now() + CACHE_TTL });
  return NextResponse.json({ ok: true, ...snapshot, cached: false });
}

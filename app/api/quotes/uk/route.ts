import { NextRequest, NextResponse } from 'next/server';

// ── ADR mapping: LSE ticker → US-listed equivalent ────────────────────────────
// Used as fallback when Yahoo Finance is unavailable
const ADR_MAP: Record<string, { adr: string; name: string; exchange: string }> = {
  'VOD.L':  { adr: 'VOD',  name: 'Vodafone Group ADR',       exchange: 'NASDAQ' },
  'BARC.L': { adr: 'BCS',  name: 'Barclays PLC ADR',         exchange: 'NYSE'   },
  'LLOY.L': { adr: 'LYG',  name: 'Lloyds Banking Group ADR', exchange: 'NYSE'   },
  'BP.L':   { adr: 'BP',   name: 'BP PLC ADR',               exchange: 'NYSE'   },
  'SHEL.L': { adr: 'SHEL', name: 'Shell PLC ADR',            exchange: 'NYSE'   },
  'AZN.L':  { adr: 'AZN',  name: 'AstraZeneca ADR',          exchange: 'NASDAQ' },
  'GSK.L':  { adr: 'GSK',  name: 'GSK PLC ADR',              exchange: 'NYSE'   },
  'RIO.L':  { adr: 'RIO',  name: 'Rio Tinto ADR',            exchange: 'NYSE'   },
  'HSBA.L': { adr: 'HSBC', name: 'HSBC Holdings ADR',        exchange: 'NYSE'   },
  'DGE.L':  { adr: 'DEO',  name: 'Diageo ADR',               exchange: 'NYSE'   },
  'ULVR.L': { adr: 'UL',   name: 'Unilever ADR',             exchange: 'NYSE'   },
  'RR.L':   { adr: 'RYCEY',name: 'Rolls-Royce ADR',          exchange: 'OTC'    },
  'NWG.L':  { adr: 'NWG',  name: 'NatWest Group ADR',        exchange: 'NYSE'   },
  'STAN.L': { adr: 'SCBFF',name: 'Standard Chartered ADR',   exchange: 'OTC'    },
  'IAG.L':  { adr: 'ICAGY',name: 'IAG ADR',                  exchange: 'OTC'    },
};

type UKQuoteResult = {
  symbol: string;
  price: number;
  changePercent: number;
  prevClose: number;
  currency: string;
  source: 'yahoo' | 'adr';
  adrSymbol?: string;
  exchange?: string;
  badge: string;       // display label e.g. "🇬🇧 LSE · 15min delay" or "🇺🇸 NYSE ADR · USD"
};

/** Fetch a UK stock quote via Yahoo Finance (free, 15-min delay for LSE) */
async function fetchYahoo(ticker: string): Promise<UKQuoteResult | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ClearGains/1.0)',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return null;

    const data = await res.json() as {
      chart?: {
        result?: Array<{
          meta?: {
            regularMarketPrice?: number;
            regularMarketChangePercent?: number;
            previousClose?: number;
            currency?: string;
          };
        }>;
        error?: { code: string; description: string };
      };
    };

    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice || meta.regularMarketPrice <= 0) return null;

    return {
      symbol: ticker,
      price: meta.regularMarketPrice,
      // Yahoo returns change% already as a percentage value (e.g. -1.23 = -1.23%)
      changePercent: meta.regularMarketChangePercent ?? 0,
      prevClose: meta.previousClose ?? meta.regularMarketPrice,
      currency: meta.currency ?? 'GBp',  // 'GBp' = pence, 'GBP' = pounds
      source: 'yahoo',
      badge: '🇬🇧 LSE · 15min delay',
    };
  } catch {
    return null;
  }
}

/** Fetch a US ADR equivalent via Finnhub */
async function fetchADR(lseTicker: string, apiKey: string): Promise<UKQuoteResult | null> {
  const mapping = ADR_MAP[lseTicker];
  if (!mapping) return null;

  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/quote?symbol=${mapping.adr}&token=${apiKey}`,
      { signal: AbortSignal.timeout(5_000) }
    );
    if (!res.ok) return null;

    const q = await res.json() as { c: number; dp: number; pc: number };
    if (!q.c || q.c <= 0) return null;

    return {
      symbol: lseTicker,
      price: q.c,
      changePercent: q.dp ?? 0,
      prevClose: q.pc ?? q.c,
      currency: 'USD',
      source: 'adr',
      adrSymbol: mapping.adr,
      exchange: mapping.exchange,
      badge: `🇺🇸 ${mapping.exchange} ADR · USD`,
    };
  } catch {
    return null;
  }
}

/**
 * GET /api/quotes/uk?ticker=VOD.L
 *
 * Returns a quote for an LSE stock.
 * Stage 1: Yahoo Finance (GBP/GBp, 15-min delay)
 * Stage 2: US ADR via Finnhub (USD, real-time)
 */
export async function GET(request: NextRequest) {
  const ticker = request.nextUrl.searchParams.get('ticker');
  if (!ticker) {
    return NextResponse.json({ error: 'ticker query parameter required' }, { status: 400 });
  }

  const apiKey = process.env.FINNHUB_API_KEY ?? '';

  // Stage 1 — Yahoo Finance
  const yahoo = await fetchYahoo(ticker);
  if (yahoo) {
    return NextResponse.json(yahoo);
  }

  // Stage 2 — ADR fallback via Finnhub
  if (apiKey) {
    const adr = await fetchADR(ticker, apiKey);
    if (adr) {
      return NextResponse.json(adr);
    }
  }

  return NextResponse.json(
    { error: `Could not fetch quote for ${ticker} — Yahoo Finance and ADR fallback both failed` },
    { status: 503 }
  );
}

// Export helpers for use in other server-side routes
export { fetchYahoo, fetchADR, ADR_MAP };
export type { UKQuoteResult };

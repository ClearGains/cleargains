import { NextRequest, NextResponse } from 'next/server';

export const revalidate = 0;

/**
 * Debug endpoint — compares overnight price sources for a given symbol.
 * Usage: /api/market/debug?symbol=DOCN
 *
 * Requires in .env.local:
 *   ALPACA_API_KEY=<your key>
 *   ALPACA_SECRET_KEY=<your secret>
 */
export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get('symbol') ?? 'DOCN').toUpperCase();

  const alpacaKey    = process.env.ALPACA_API_KEY;
  const alpacaSecret = process.env.ALPACA_SECRET_KEY;

  const results: Record<string, unknown> = { symbol, timestamp: new Date().toISOString() };

  // ── 1. Yahoo Finance v7 quote ─────────────────────────────────────────────
  try {
    const yfRes = await fetch(
      `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${symbol}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'application/json',
        },
      },
    );
    if (yfRes.ok) {
      const raw = await yfRes.json() as { quoteResponse?: { result?: unknown[] } };
      const q = raw.quoteResponse?.result?.[0] as Record<string, unknown> | undefined;
      if (q) {
        results.yahoo = {
          regularMarketPrice:        q.regularMarketPrice,
          regularMarketChangePercent: q.regularMarketChangePercent,
          preMarketPrice:            q.preMarketPrice,
          preMarketChangePercent:    q.preMarketChangePercent,
          postMarketPrice:           q.postMarketPrice,
          postMarketChangePercent:   q.postMarketChangePercent,
          marketState:               q.marketState,
          // self-computed overnight % for comparison
          selfComputedPostPct: q.postMarketPrice && q.regularMarketPrice
            ? (((q.postMarketPrice as number) - (q.regularMarketPrice as number)) / (q.regularMarketPrice as number) * 100).toFixed(4) + '%'
            : null,
        };
      }
    } else {
      results.yahoo = { error: `HTTP ${yfRes.status}` };
    }
  } catch (e) {
    results.yahoo = { error: String(e) };
  }

  // ── 2. Finnhub ────────────────────────────────────────────────────────────
  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (finnhubKey) {
    try {
      const fhRes = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${finnhubKey}`,
        { signal: AbortSignal.timeout(5_000) },
      );
      if (fhRes.ok) {
        results.finnhub = await fhRes.json();
      } else {
        results.finnhub = { error: `HTTP ${fhRes.status}` };
      }
    } catch (e) {
      results.finnhub = { error: String(e) };
    }
  } else {
    results.finnhub = { error: 'FINNHUB_API_KEY not set' };
  }

  // ── 3. Alpaca Data API ────────────────────────────────────────────────────
  if (alpacaKey && alpacaSecret) {
    try {
      // Latest quote (bid/ask from ECNs — includes overnight activity)
      const alpacaQuoteRes = await fetch(
        `https://data.alpaca.markets/v2/stocks/quotes/latest?symbols=${symbol}&feed=iex`,
        {
          headers: {
            'APCA-API-KEY-ID':     alpacaKey,
            'APCA-API-SECRET-KEY': alpacaSecret,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(8_000),
        },
      );
      // Also fetch latest trade
      const alpacaTradeRes = await fetch(
        `https://data.alpaca.markets/v2/stocks/trades/latest?symbols=${symbol}&feed=iex`,
        {
          headers: {
            'APCA-API-KEY-ID':     alpacaKey,
            'APCA-API-SECRET-KEY': alpacaSecret,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(8_000),
        },
      );

      const [quoteData, tradeData] = await Promise.all([
        alpacaQuoteRes.ok ? alpacaQuoteRes.json() : { error: `HTTP ${alpacaQuoteRes.status}` },
        alpacaTradeRes.ok ? alpacaTradeRes.json() : { error: `HTTP ${alpacaTradeRes.status}` },
      ]);

      results.alpaca = {
        latestQuote: quoteData,
        latestTrade: tradeData,
      };
    } catch (e) {
      results.alpaca = { error: String(e) };
    }
  } else {
    results.alpaca = {
      error: 'ALPACA_API_KEY / ALPACA_SECRET_KEY not set in .env.local',
      howToGet: 'Sign up free at alpaca.markets → Paper Trading → API Keys',
    };
  }

  return NextResponse.json(results, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

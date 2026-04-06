import { NextRequest, NextResponse } from 'next/server';

type T212Instrument = {
  ticker: string;
  shortName: string;
  type: string;
  currencyCode: string;
  isinCode?: string;
};

export async function POST(request: NextRequest) {
  const encoded = request.headers.get('x-t212-auth');
  if (!encoded) {
    return NextResponse.json({ error: 'Missing x-t212-auth header.' }, { status: 400 });
  }

  const { symbol } = await request.json() as { symbol: string };

  try {
    const res = await fetch('https://live.trading212.com/api/v0/equity/metadata/instruments', {
      headers: {
        Authorization: 'Basic ' + encoded,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `T212 instruments returned ${res.status}` },
        { status: res.status }
      );
    }

    const instruments = await res.json() as T212Instrument[];

    if (!Array.isArray(instruments)) {
      return NextResponse.json({ error: 'Unexpected instruments response.' }, { status: 502 });
    }

    // Find instruments matching the symbol:
    // T212 tickers are like "AAPL_US_EQ" — search by ticker prefix or shortName
    const symbolUpper = symbol.toUpperCase();
    const match = instruments.find(
      (i) =>
        i.ticker.startsWith(symbolUpper + '_') ||
        i.shortName?.toUpperCase() === symbolUpper
    );

    if (symbol) {
      return NextResponse.json({
        ticker: match?.ticker ?? null,
        shortName: match?.shortName ?? null,
        found: !!match,
      });
    }

    // If no symbol provided, return the full list (for caching)
    return NextResponse.json({
      instruments: instruments.map((i) => ({
        ticker: i.ticker,
        shortName: i.shortName,
        currencyCode: i.currencyCode,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Request failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}

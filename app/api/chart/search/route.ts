import { NextRequest, NextResponse } from 'next/server';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

type Quote = {
  symbol?: string;
  shortname?: string;
  longname?: string;
  exchDisp?: string;
  quoteType?: string;
};

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim();
  if (!q) return NextResponse.json([]);

  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=15&newsCount=0&enableFuzzyQuery=true`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) return NextResponse.json([]);

    const raw = await res.json() as { quotes?: Quote[] };

    const results = (raw.quotes ?? [])
      .filter(q => q.symbol && q.quoteType !== 'MUTUALFUND' && q.quoteType !== 'CURRENCY' && q.quoteType !== 'INDEX')
      .slice(0, 10)
      .map(q => ({
        symbol:   q.symbol ?? '',
        name:     q.shortname ?? q.longname ?? q.symbol ?? '',
        exchange: q.exchDisp ?? '',
        type:     q.quoteType ?? '',
      }));

    return NextResponse.json(results);
  } catch {
    return NextResponse.json([]);
  }
}

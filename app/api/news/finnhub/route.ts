import { NextRequest } from 'next/server';

export interface FinnhubArticle {
  headline: string;
  source: string;
  datetime: number;
  url: string;
  summary: string;
  category: string;
  id: number;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol');
  const category = searchParams.get('category') ?? 'general';
  const key = process.env.FINNHUB_API_KEY;

  if (!key) {
    return Response.json({ error: 'FINNHUB_API_KEY not configured' }, { status: 500 });
  }

  try {
    let url: string;
    if (symbol) {
      const today = new Date().toISOString().split('T')[0];
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${weekAgo}&to=${today}&token=${key}`;
    } else {
      url = `https://finnhub.io/api/v1/news?category=${category}&minId=0&token=${key}`;
    }

    const res = await fetch(url, {
      headers: { 'User-Agent': 'ClearGains/1.0' },
      signal: AbortSignal.timeout(8000),
      next: { revalidate: 900 }, // 15-min cache
    });

    if (!res.ok) {
      return Response.json({ error: `Finnhub returned ${res.status}` }, { status: 502 });
    }

    const raw = await res.json() as FinnhubArticle[];
    const articles = (Array.isArray(raw) ? raw : [])
      .filter(a => a.headline && a.datetime)
      .slice(0, 40);

    return Response.json({ articles, success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg, articles: [] }, { status: 500 });
  }
}

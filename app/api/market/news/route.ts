import { NextRequest, NextResponse } from 'next/server';

export const revalidate = 0;

type NewsItem = { headline: string; source: string; url: string; datetime: number };

const cache = new Map<string, { data: NewsItem[]; ts: number }>();
const NEWS_TTL = 30 * 60_000; // 30 min — prevents hammering Finnhub

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get('symbol')?.trim().toUpperCase() ?? '';
  if (!symbol) return NextResponse.json([]);

  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.ts < NEWS_TTL) {
    return NextResponse.json(hit.data, { headers: { 'Cache-Control': 'no-store', 'X-Cache': 'HIT' } });
  }

  const key = process.env.FINNHUB_API_KEY;
  if (!key) return NextResponse.json([], { headers: { 'Cache-Control': 'no-store' } });

  const to   = new Date().toISOString().split('T')[0];
  const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&token=${key}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!res.ok) {
      cache.set(symbol, { data: [], ts: Date.now() });
      return NextResponse.json([]);
    }
    const raw = await res.json() as Array<{ headline?: string; source?: string; url?: string; datetime?: number }>;
    const news: NewsItem[] = (Array.isArray(raw) ? raw : [])
      .filter(n => n.headline && n.url)
      .slice(0, 3)
      .map(n => ({ headline: n.headline!, source: n.source ?? '', url: n.url!, datetime: n.datetime ?? 0 }));

    cache.set(symbol, { data: news, ts: Date.now() });
    return NextResponse.json(news, { headers: { 'Cache-Control': 'no-store', 'X-Cache': 'MISS' } });
  } catch {
    cache.set(symbol, { data: [], ts: Date.now() });
    return NextResponse.json([]);
  }
}

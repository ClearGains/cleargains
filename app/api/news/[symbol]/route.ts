import { NextRequest, NextResponse } from 'next/server';

export type RawArticle = {
  title: string;
  source: string;
  pubDate: string;
  link: string;
};

function parseRSS(xml: string): RawArticle[] {
  const items: RawArticle[] = [];
  const blocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  for (const match of blocks) {
    const block = match[1];
    const title = (
      block.match(/<title><!\[CDATA\[([^\]]*)\]\]><\/title>/)?.[1] ??
      block.match(/<title>([^<]*)<\/title>/)?.[1] ??
      ''
    ).trim();
    const source = (
      block.match(/<source[^>]*>([^<]*)<\/source>/)?.[1] ?? ''
    ).trim();
    const pubDate = (block.match(/<pubDate>([^<]*)<\/pubDate>/)?.[1] ?? '').trim();
    const link = (block.match(/<link>([^<]*)<\/link>/)?.[1] ?? '').trim();
    if (title) items.push({ title, source, pubDate, link });
  }
  return items.slice(0, 15);
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ symbol: string }> }
): Promise<NextResponse> {
  const { symbol } = await context.params;
  const upperSymbol = symbol.toUpperCase();
  const isUK = upperSymbol.endsWith('.L');
  const region = isUK ? 'GB' : 'US';
  const lang = isUK ? 'en-GB' : 'en-US';

  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(upperSymbol)}&region=${region}&lang=${lang}`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClearGains/1.0)' },
      signal: AbortSignal.timeout(8000),
      next: { revalidate: 300 }, // cache 5 min
    });

    if (!res.ok) {
      return NextResponse.json({ error: `Yahoo Finance returned ${res.status}` }, { status: 502 });
    }

    const xml = await res.text();
    const articles = parseRSS(xml);
    return NextResponse.json({ symbol: upperSymbol, articles });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Fetch failed: ${msg}` }, { status: 500 });
  }
}

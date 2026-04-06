import { NextRequest, NextResponse } from 'next/server';

type NewsItem = {
  title: string;
  source: string;
  pubDate: string;
  link: string;
};

function parseRSS(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  const itemMatches = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  for (const match of itemMatches) {
    const block = match[1];
    const title = (
      block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] ??
      block.match(/<title>([^<]*)<\/title>/)?.[1] ??
      ''
    ).trim();
    const source = (
      block.match(/<source[^>]*>([^<]*)<\/source>/)?.[1] ?? ''
    ).trim();
    const pubDate = (block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] ?? '').trim();
    const link = (block.match(/<link>([^<]*)<\/link>/)?.[1] ?? '').trim();
    if (title) items.push({ title, source, pubDate, link });
  }
  return items.slice(0, 12);
}

const BULLISH = [
  'beat', 'beats', 'surge', 'soar', 'gain', 'rises', 'rally', 'record',
  'upgrade', 'upgraded', 'outperform', 'growth', 'profit', 'boost',
  'strong', 'positive', 'raises', 'raised', 'exceed', 'exceeded', 'jumps',
];
const BEARISH = [
  'miss', 'misses', 'fall', 'falls', 'drop', 'drops', 'decline', 'plunge',
  'downgrade', 'downgraded', 'underperform', 'loss', 'losses', 'cut', 'cuts',
  'weak', 'concern', 'risk', 'negative', 'slump', 'warns', 'warning',
];

function deriveOutlook(items: NewsItem[]): {
  signal: 'BUY' | 'SELL' | 'HOLD';
  label: string;
  bullishCount: number;
  bearishCount: number;
  summary: string;
} {
  let bullishCount = 0;
  let bearishCount = 0;

  for (const item of items) {
    const lower = item.title.toLowerCase();
    bullishCount += BULLISH.filter((w) => lower.includes(w)).length;
    bearishCount += BEARISH.filter((w) => lower.includes(w)).length;
  }

  const total = bullishCount + bearishCount;
  let signal: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
  let label = 'Neutral';

  if (total > 0) {
    const bullishRatio = bullishCount / total;
    if (bullishRatio >= 0.6) { signal = 'BUY'; label = 'Bullish'; }
    else if (bullishRatio <= 0.4) { signal = 'SELL'; label = 'Bearish'; }
  }

  const sourceList = [...new Set(items.map((i) => i.source).filter(Boolean))].slice(0, 4);
  const summary =
    items.length === 0
      ? 'No recent news found for this ticker.'
      : `Based on ${items.length} recent news item${items.length !== 1 ? 's' : ''} from ${
          sourceList.length > 0 ? sourceList.join(', ') : 'various sources'
        }. Sentiment signals: ${bullishCount} bullish, ${bearishCount} bearish indicator${bearishCount !== 1 ? 's' : ''} in headlines.`;

  return { signal, label, bullishCount, bearishCount, summary };
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { ticker } = body as { ticker: string };

  if (!ticker) {
    return NextResponse.json({ error: 'ticker is required' }, { status: 400 });
  }

  const symbol = ticker.trim().toUpperCase();

  // Try Yahoo Finance RSS first, fall back to Google News RSS
  const feeds = [
    `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`,
    `https://news.google.com/rss/search?q=${encodeURIComponent(symbol + ' stock')}&hl=en-US&gl=US&ceid=US:en`,
  ];

  let items: NewsItem[] = [];
  let fetchError: string | null = null;

  for (const url of feeds) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClearGains/1.0)' },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const xml = await res.text();
        items = parseRSS(xml);
        if (items.length > 0) break;
      }
    } catch (err) {
      fetchError = err instanceof Error ? err.message : String(err);
    }
  }

  const outlook = deriveOutlook(items);

  return NextResponse.json({
    ticker: symbol,
    signal: outlook.signal,
    label: outlook.label,
    bullishCount: outlook.bullishCount,
    bearishCount: outlook.bearishCount,
    summary: outlook.summary,
    articles: items,
    fetchError: items.length === 0 ? fetchError : null,
    timestamp: new Date().toISOString(),
    // Legacy Signal fields for store compatibility
    riskScore: Math.round((outlook.bearishCount / Math.max(outlook.bullishCount + outlook.bearishCount, 1)) * 100),
    confidence: Math.min(items.length * 8, 90),
    reasoning: outlook.summary,
    sources: [...new Set(items.map((i) => i.source).filter(Boolean))],
  });
}

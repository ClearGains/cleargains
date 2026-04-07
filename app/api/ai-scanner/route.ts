import { NextRequest, NextResponse } from 'next/server';
import { ScanResult, NewsArticle } from '@/lib/types';

// Company name → ticker mapping (no API needed)
const COMPANY_MAP: Record<string, string> = {
  apple: 'AAPL', microsoft: 'MSFT', nvidia: 'NVDA', tesla: 'TSLA',
  amazon: 'AMZN', google: 'GOOGL', alphabet: 'GOOGL', meta: 'META',
  facebook: 'META', netflix: 'NFLX', 'berkshire hathaway': 'BRK-B',
  jpmorgan: 'JPM', 'johnson & johnson': 'JNJ', 'johnson and johnson': 'JNJ',
  visa: 'V', mastercard: 'MA', walmart: 'WMT', exxon: 'XOM',
  broadcom: 'AVGO', tsmc: 'TSM', asml: 'ASML',
  // UK
  vodafone: 'VOD.L', lloyds: 'LLOY.L', barclays: 'BARC.L', bp: 'BP.L',
  shell: 'SHEL.L', hsbc: 'HSBA.L', 'rio tinto': 'RIO.L', gsk: 'GSK.L',
  astrazeneca: 'AZN.L', unilever: 'ULVR.L', diageo: 'DGE.L',
  'rolls royce': 'RR.L', 'standard chartered': 'STAN.L', natwest: 'NWG.L',
};

function resolveQuery(query: string): string {
  const lower = query.trim().toLowerCase();
  if (COMPANY_MAP[lower]) return COMPANY_MAP[lower];
  // Try partial match
  for (const [name, ticker] of Object.entries(COMPANY_MAP)) {
    if (lower.includes(name) || name.includes(lower)) return ticker;
  }
  // Assume it's already a ticker symbol
  return query.trim().toUpperCase();
}

function getCompanyName(ticker: string): string {
  const reverse: Record<string, string> = {
    AAPL: 'Apple Inc.', MSFT: 'Microsoft Corp.', NVDA: 'Nvidia Corp.',
    TSLA: 'Tesla Inc.', AMZN: 'Amazon.com Inc.', GOOGL: 'Alphabet Inc.',
    META: 'Meta Platforms Inc.', NFLX: 'Netflix Inc.', JPM: 'JPMorgan Chase',
    V: 'Visa Inc.', MA: 'Mastercard Inc.', WMT: 'Walmart Inc.',
    XOM: 'Exxon Mobil Corp.', AVGO: 'Broadcom Inc.', TSM: 'TSMC',
    ASML: 'ASML Holding', 'BRK-B': 'Berkshire Hathaway',
    'VOD.L': 'Vodafone Group', 'LLOY.L': 'Lloyds Banking Group',
    'BARC.L': 'Barclays PLC', 'BP.L': 'BP PLC', 'SHEL.L': 'Shell PLC',
    'HSBA.L': 'HSBC Holdings', 'RIO.L': 'Rio Tinto PLC', 'GSK.L': 'GSK PLC',
    'AZN.L': 'AstraZeneca PLC', 'ULVR.L': 'Unilever PLC',
    'DGE.L': 'Diageo PLC', 'RR.L': 'Rolls-Royce Holdings',
    'STAN.L': 'Standard Chartered', 'NWG.L': 'NatWest Group',
  };
  return reverse[ticker] ?? ticker;
}

type RawItem = { title: string; source: string; pubDate: string; link: string };

function parseRSS(xml: string): RawItem[] {
  const items: RawItem[] = [];
  const blocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  for (const match of blocks) {
    const block = match[1];
    const title = (
      block.match(/<title><!\[CDATA\[([^\]]*)\]\]><\/title>/)?.[1] ??
      block.match(/<title>([^<]*)<\/title>/)?.[1] ??
      ''
    ).trim();
    const source = (block.match(/<source[^>]*>([^<]*)<\/source>/)?.[1] ?? '').trim();
    const pubDate = (block.match(/<pubDate>([^<]*)<\/pubDate>/)?.[1] ?? '').trim();
    const link = (block.match(/<link>([^<]*)<\/link>/)?.[1] ?? '').trim();
    if (title) items.push({ title, source, pubDate, link });
  }
  return items.slice(0, 12);
}

const BULLISH = [
  'beats', 'beat', 'surges', 'surge', 'soars', 'soar', 'rises', 'rise',
  'gains', 'gain', 'rallies', 'rally', 'record', 'upgrade', 'upgraded',
  'outperform', 'strong', 'growth', 'profit', 'profits', 'boost', 'boosted',
  'raises', 'raised', 'exceeds', 'exceeded', 'jumps', 'jump', 'climbs',
  'positive', 'up', 'higher', 'bullish', 'buy', 'overweight',
];
const BEARISH = [
  'misses', 'miss', 'falls', 'fall', 'drops', 'drop', 'declines', 'decline',
  'plunges', 'plunge', 'slumps', 'slump', 'loss', 'losses', 'cuts', 'cut',
  'downgrade', 'downgraded', 'underperform', 'weak', 'concern', 'concerns',
  'risk', 'risks', 'warning', 'warns', 'layoffs', 'disappoints', 'sell',
  'underweight', 'bearish', 'negative', 'lower', 'down', 'below',
];

function formatRelativeDate(dateStr: string): string {
  if (!dateStr) return '';
  try {
    const date = new Date(dateStr);
    const diffMs = Date.now() - date.getTime();
    const diffDays = diffMs / 86_400_000;
    if (diffDays < 7) {
      const diffMins = Math.floor(diffMs / 60_000);
      if (diffMins < 60) return `${diffMins}m ago`;
      const diffHrs = Math.floor(diffMs / 3_600_000);
      if (diffHrs < 24) return `${diffHrs}h ago`;
      return `${Math.floor(diffDays)}d ago`;
    }
    const diffWeeks = Math.floor(diffDays / 7);
    if (diffWeeks < 5) return `${diffWeeks} week${diffWeeks !== 1 ? 's' : ''} ago`;
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return dateStr.slice(0, 10);
  }
}

function buildSummary(title: string): string {
  // Simple one-line summary from the headline itself
  return title.length > 120 ? title.slice(0, 117) + '…' : title;
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { query } = body as { query: string };

  if (!query) {
    return NextResponse.json({ error: 'query is required' }, { status: 400 });
  }

  const ticker = resolveQuery(query);
  const isUK = ticker.endsWith('.L');
  const market: 'US' | 'UK' | 'OTHER' = isUK ? 'UK' : /^[A-Z]/.test(ticker) ? 'US' : 'OTHER';
  const region = isUK ? 'GB' : 'US';
  const lang = isUK ? 'en-GB' : 'en-US';
  const companyName = getCompanyName(ticker);

  const rssUrl = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=${region}&lang=${lang}`;

  let rawItems: RawItem[] = [];
  let fetchError: string | null = null;
  let isFallback = false;

  try {
    const res = await fetch(rssUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClearGains/1.0)' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      rawItems = parseRSS(await res.text());
    } else {
      fetchError = `Yahoo Finance returned ${res.status}`;
    }
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  // Fallback to Finnhub company news if Yahoo returned nothing
  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (rawItems.length === 0 && finnhubKey) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const threeMonthsAgo = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
      const fRes = await fetch(
        `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(ticker)}&from=${threeMonthsAgo}&to=${today}&token=${finnhubKey}`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (fRes.ok) {
        const fData = await fRes.json() as Array<{ headline: string; source: string; datetime: number; url: string }>;
        if (Array.isArray(fData) && fData.length > 0) {
          rawItems = fData.slice(0, 12).map(item => ({
            title: item.headline,
            source: item.source,
            pubDate: new Date(item.datetime * 1000).toISOString(),
            link: item.url,
          }));
          isFallback = true;
        } else {
          isFallback = true;
        }
      } else {
        isFallback = true;
      }
    } catch {
      isFallback = true;
    }
  } else if (rawItems.length === 0) {
    isFallback = true;
  }

  // Sentiment analysis
  let bullishCount = 0;
  let bearishCount = 0;
  for (const item of rawItems) {
    const lower = item.title.toLowerCase();
    const b = BULLISH.filter((w) => lower.includes(w)).length;
    const r = BEARISH.filter((w) => lower.includes(w)).length;
    bullishCount += b;
    bearishCount += r;
  }

  const total = bullishCount + bearishCount;
  let signal: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
  let confidence = 40;

  if (total > 0) {
    const bullRatio = bullishCount / total;
    if (bullRatio >= 0.6) {
      signal = 'BUY';
      confidence = Math.min(95, Math.round(50 + bullRatio * 50));
    } else if (bullRatio <= 0.4) {
      signal = 'SELL';
      confidence = Math.min(95, Math.round(50 + (1 - bullRatio) * 50));
    } else {
      signal = 'HOLD';
      confidence = Math.round(40 + rawItems.length * 2);
    }
  } else if (rawItems.length > 0) {
    confidence = Math.min(50, 20 + rawItems.length * 3);
  }

  const riskScore = total > 0
    ? Math.min(90, Math.round((bearishCount / total) * 100))
    : 50;

  let verdict: 'PROCEED' | 'CAUTION' | 'REJECT';
  if (signal === 'BUY' && confidence >= 60) verdict = 'PROCEED';
  else if (signal === 'SELL' && confidence >= 60) verdict = 'REJECT';
  else verdict = 'CAUTION';

  // Build reasoning
  const sourceList = [...new Set(rawItems.map((i) => i.source).filter(Boolean))].slice(0, 3);
  let reasoning: string;
  if (rawItems.length === 0) {
    reasoning = fetchError
      ? `Could not fetch news for ${ticker}: ${fetchError}. Signal is based on no data — treat with extreme caution.`
      : `No recent news found for ${ticker}. Unable to determine market sentiment.`;
  } else {
    const sentimentDesc =
      signal === 'BUY' ? `predominantly bullish (${bullishCount} positive vs ${bearishCount} negative indicators)`
      : signal === 'SELL' ? `predominantly bearish (${bearishCount} negative vs ${bullishCount} positive indicators)`
      : `mixed (${bullishCount} positive, ${bearishCount} negative indicators)`;
    const fallbackNote = isFallback ? ' No recent news found — showing most recent available articles.' : '';
    reasoning = `Based on ${rawItems.length} recent news article${rawItems.length !== 1 ? 's' : ''} from ${sourceList.join(', ') || 'various sources'}, headline sentiment is ${sentimentDesc}. Confidence is ${confidence}% — ${confidence >= 70 ? 'headlines show clear directional agreement' : confidence >= 50 ? 'some directional agreement in headlines' : 'limited signal — few headlines found'}.${fallbackNote}`;
  }

  const articles: NewsArticle[] = rawItems.slice(0, 5).map((item) => ({
    headline: item.title,
    source: item.source || 'Yahoo Finance',
    date: formatRelativeDate(item.pubDate),
    summary: buildSummary(item.title),
    link: item.link || undefined,
  }));

  const result: ScanResult = {
    ticker,
    companyName,
    signal,
    confidence,
    riskScore,
    verdict,
    reasoning,
    market,
    articles,
    timestamp: new Date().toISOString(),
    noRecentNews: isFallback,
  };

  return NextResponse.json(result);
}

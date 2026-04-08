import { NextResponse } from 'next/server';

// ── Types ─────────────────────────────────────────────────────────────────────
export type NewsCategory =
  | 'geopolitical' | 'economic' | 'central-bank' | 'commodities'
  | 'earnings'     | 'health-crisis' | 'energy' | 'tech-regulation';

export type Sentiment = 'bullish' | 'bearish' | 'neutral';

export type WorldNewsItem = {
  id: string;
  title: string;
  summary: string;
  url: string;
  source: string;
  publishedAt: string;
  relativeTime: string;
  category: NewsCategory;
  categoryLabel: string;
  categoryEmoji: string;
  sentiment: Sentiment;
  confidence: number;
  assetImpacts: { asset: string; direction: Sentiment }[];
  sectorImpacts: { sector: string; direction: 'bullish' | 'bearish' }[];
  currencyImpacts: { currency: string; direction: 'strengthen' | 'weaken' }[];
  commodityImpacts: { commodity: string; direction: 'rise' | 'fall'; reason: string }[];
};

// ── Categorisation keywords ───────────────────────────────────────────────────
const CAT_PATTERNS: Record<NewsCategory, string[]> = {
  geopolitical: ['war', 'military', 'sanction', 'election', 'tariff', 'trade war',
    'conflict', 'nato', 'ukraine', 'russia', 'china', 'taiwan', 'israel', 'iran',
    'coup', 'protest', 'invasion', 'nuclear', 'missile', 'troops', 'diplomat', 'geopolit'],
  economic: ['inflation', 'cpi', 'gdp', 'unemployment', 'recession', 'jobs report',
    'nonfarm', 'retail sales', 'trade deficit', 'trade surplus', 'economic growth',
    'slowdown', 'ppi', 'consumer price', 'economic data'],
  'central-bank': ['federal reserve', 'fed rate', 'ecb', 'bank of england', 'boe',
    'bank of japan', 'boj', 'rate hike', 'rate cut', 'interest rate decision',
    'monetary policy', 'quantitative', 'hawkish', 'dovish', 'fomc', 'powell',
    'lagarde', 'bailey', 'central bank'],
  commodities: ['oil price', 'crude oil', 'opec', 'gold price', 'silver', 'copper',
    'wheat', 'corn', 'soybean', 'natural gas', 'commodity', 'brent', 'wti', 'livestock'],
  earnings: ['quarterly earnings', 'q1 earnings', 'q2 earnings', 'q3 earnings',
    'q4 earnings', 'earnings per share', 'eps', 'revenue beat', 'revenue miss',
    'quarterly results', 'annual results', 'profit warning', 'earnings report'],
  'health-crisis': ['pandemic', 'covid', 'virus outbreak', 'epidemic',
    'natural disaster', 'earthquake', 'hurricane', 'flood', 'typhoon', 'health emergency'],
  energy: ['renewable energy', 'solar power', 'wind energy', 'electric vehicle',
    'energy transition', 'climate change', 'carbon', 'emission', 'pipeline',
    'lng', 'energy crisis', 'power grid', 'nuclear energy'],
  'tech-regulation': ['antitrust', 'ai regulation', 'artificial intelligence regulation',
    'data privacy', 'gdpr', 'tech regulation', 'sec enforcement', 'fca',
    'competition law', 'monopoly', 'big tech'],
};

const CAT_META: Record<NewsCategory, { label: string; emoji: string }> = {
  geopolitical:    { label: 'Geopolitical',   emoji: '🌍' },
  economic:        { label: 'Economic',        emoji: '💰' },
  'central-bank':  { label: 'Central Banks',  emoji: '🏦' },
  commodities:     { label: 'Commodities',     emoji: '🛢️' },
  earnings:        { label: 'Earnings',        emoji: '📊' },
  'health-crisis': { label: 'Health/Crisis',   emoji: '🦠' },
  energy:          { label: 'Energy',          emoji: '⚡' },
  'tech-regulation':{ label: 'Tech/Regulation',emoji: '🌐' },
};

const BULLISH_WORDS = ['surges', 'rally', 'beats', 'strong', 'growth', 'record',
  'upgrade', 'boost', 'rises', 'gains', 'recovery', 'optimism', 'improves', 'jumps', 'soars'];
const BEARISH_WORDS = ['falls', 'drops', 'miss', 'weak', 'concern', 'risk', 'crisis',
  'warning', 'cut', 'decline', 'slowdown', 'tension', 'threat', 'fear', 'plunges', 'slumps'];

function categorize(title: string, summary: string): NewsCategory {
  const text = (title + ' ' + summary).toLowerCase();
  let best: NewsCategory = 'economic';
  let bestScore = 0;
  for (const [cat, patterns] of Object.entries(CAT_PATTERNS)) {
    const score = patterns.filter(p => text.includes(p)).length;
    if (score > bestScore) { bestScore = score; best = cat as NewsCategory; }
  }
  return best;
}

function analyzeSentiment(title: string, summary: string): { sentiment: Sentiment; confidence: number } {
  const text = (title + ' ' + summary).toLowerCase();
  const b = BULLISH_WORDS.filter(w => text.includes(w)).length;
  const r = BEARISH_WORDS.filter(w => text.includes(w)).length;
  const total = b + r;
  if (total === 0) return { sentiment: 'neutral', confidence: 50 };
  const ratio = b / total;
  if (ratio >= 0.6) return { sentiment: 'bullish', confidence: Math.min(95, Math.round(50 + ratio * 50)) };
  if (ratio <= 0.4) return { sentiment: 'bearish', confidence: Math.min(95, Math.round(50 + (1 - ratio) * 50)) };
  return { sentiment: 'neutral', confidence: 50 };
}

function analyzeImpact(category: NewsCategory, title: string, summary: string, sentiment: Sentiment) {
  const text = (title + ' ' + summary).toLowerCase();
  const bullish = sentiment === 'bullish';
  const bearish = sentiment === 'bearish';

  const assetImpacts: WorldNewsItem['assetImpacts'] = [];
  const sectorImpacts: WorldNewsItem['sectorImpacts'] = [];
  const currencyImpacts: WorldNewsItem['currencyImpacts'] = [];
  const commodityImpacts: WorldNewsItem['commodityImpacts'] = [];

  switch (category) {
    case 'geopolitical':
      assetImpacts.push({ asset: 'Stocks', direction: 'bearish' }, { asset: 'Bonds', direction: 'bullish' });
      currencyImpacts.push({ currency: 'USD', direction: 'strengthen' }, { currency: 'JPY', direction: 'strengthen' }, { currency: 'CHF', direction: 'strengthen' });
      commodityImpacts.push({ commodity: 'Gold', direction: 'rise', reason: 'Safe haven demand' });
      sectorImpacts.push({ sector: 'Defence', direction: 'bullish' });
      if (text.includes('oil') || text.includes('opec') || text.includes('middle east') || text.includes('energy')) {
        commodityImpacts.push({ commodity: 'Oil', direction: 'rise', reason: 'Supply disruption risk' });
        sectorImpacts.push({ sector: 'Energy', direction: 'bullish' });
      }
      break;

    case 'economic':
      if (text.includes('inflation') || text.includes('rate hike') || text.includes('cpi')) {
        assetImpacts.push({ asset: 'Stocks', direction: 'bearish' }, { asset: 'Bonds', direction: 'bearish' });
        currencyImpacts.push({ currency: 'USD', direction: 'strengthen' });
        sectorImpacts.push({ sector: 'Growth Stocks', direction: 'bearish' }, { sector: 'Utilities', direction: 'bullish' });
      } else if (text.includes('rate cut') || text.includes('stimulus') || text.includes('easing')) {
        assetImpacts.push({ asset: 'Stocks', direction: 'bullish' }, { asset: 'Bonds', direction: 'bullish' });
        currencyImpacts.push({ currency: 'USD', direction: 'weaken' });
        sectorImpacts.push({ sector: 'Growth Stocks', direction: 'bullish' }, { sector: 'Real Estate', direction: 'bullish' });
      } else if (text.includes('recession') || text.includes('slowdown')) {
        assetImpacts.push({ asset: 'Stocks', direction: 'bearish' }, { asset: 'Bonds', direction: 'bullish' });
        sectorImpacts.push({ sector: 'Defensives', direction: 'bullish' }, { sector: 'Cyclicals', direction: 'bearish' });
        commodityImpacts.push({ commodity: 'Gold', direction: 'rise', reason: 'Recession hedge' });
      } else {
        assetImpacts.push({ asset: 'Stocks', direction: bullish ? 'bullish' : bearish ? 'bearish' : 'neutral' });
      }
      break;

    case 'central-bank': {
      const isHawkish = text.includes('rate hike') || text.includes('hawkish') || text.includes('tighten');
      const isDovish  = text.includes('rate cut') || text.includes('dovish') || text.includes('easing');
      assetImpacts.push({ asset: 'Stocks', direction: isHawkish ? 'bearish' : isDovish ? 'bullish' : 'neutral' });
      assetImpacts.push({ asset: 'Bonds', direction: isHawkish ? 'bearish' : isDovish ? 'bullish' : 'neutral' });
      const dir = isHawkish ? 'strengthen' : 'weaken';
      if (text.includes('fed') || text.includes('federal reserve') || text.includes('fomc'))
        currencyImpacts.push({ currency: 'USD', direction: dir });
      if (text.includes('ecb') || text.includes('european central'))
        currencyImpacts.push({ currency: 'EUR', direction: dir });
      if (text.includes('boe') || text.includes('bank of england'))
        currencyImpacts.push({ currency: 'GBP', direction: dir });
      if (text.includes('boj') || text.includes('bank of japan'))
        currencyImpacts.push({ currency: 'JPY', direction: dir });
      break;
    }

    case 'commodities':
      if (text.includes('oil') || text.includes('crude') || text.includes('opec')) {
        const oilDir = (bullish || text.includes('cut') || text.includes('supply reduction')) ? 'rise' : 'fall';
        commodityImpacts.push({ commodity: 'Oil', direction: oilDir, reason: oilDir === 'rise' ? 'Supply cut / demand rise' : 'Oversupply / demand weakness' });
        sectorImpacts.push({ sector: 'Energy', direction: oilDir === 'rise' ? 'bullish' : 'bearish' });
        sectorImpacts.push({ sector: 'Airlines', direction: oilDir === 'rise' ? 'bearish' : 'bullish' });
      }
      if (text.includes('gold')) commodityImpacts.push({ commodity: 'Gold', direction: bullish ? 'rise' : 'fall', reason: 'Commodity demand shift' });
      if (text.includes('copper')) commodityImpacts.push({ commodity: 'Copper', direction: bullish ? 'rise' : 'fall', reason: 'Industrial demand signal' });
      break;

    case 'earnings':
      assetImpacts.push({ asset: 'Stocks', direction: bullish ? 'bullish' : bearish ? 'bearish' : 'neutral' });
      if (text.includes('tech') || text.includes('software') || text.includes('ai'))
        sectorImpacts.push({ sector: 'Technology', direction: bullish ? 'bullish' : 'bearish' });
      else if (text.includes('bank') || text.includes('financial'))
        sectorImpacts.push({ sector: 'Financials', direction: bullish ? 'bullish' : 'bearish' });
      else if (text.includes('energy') || text.includes('oil'))
        sectorImpacts.push({ sector: 'Energy', direction: bullish ? 'bullish' : 'bearish' });
      else if (text.includes('health') || text.includes('pharma'))
        sectorImpacts.push({ sector: 'Healthcare', direction: bullish ? 'bullish' : 'bearish' });
      break;

    case 'health-crisis':
      assetImpacts.push({ asset: 'Stocks', direction: 'bearish' });
      sectorImpacts.push({ sector: 'Healthcare', direction: 'bullish' }, { sector: 'Travel', direction: 'bearish' });
      commodityImpacts.push({ commodity: 'Gold', direction: 'rise', reason: 'Safe haven demand' });
      break;

    case 'energy':
      if (text.includes('renewable') || text.includes('solar') || text.includes('ev') || text.includes('electric'))
        sectorImpacts.push({ sector: 'Clean Energy', direction: 'bullish' }, { sector: 'Oil & Gas', direction: 'bearish' });
      if (text.includes('gas') || text.includes('lng') || text.includes('pipeline'))
        commodityImpacts.push({ commodity: 'Natural Gas', direction: bullish ? 'rise' : 'fall', reason: 'Supply/demand dynamics' });
      break;

    case 'tech-regulation':
      assetImpacts.push({ asset: 'Stocks', direction: 'bearish' });
      sectorImpacts.push({ sector: 'Technology', direction: 'bearish' });
      break;
  }

  return { assetImpacts, sectorImpacts, currencyImpacts, commodityImpacts };
}

function formatRelativeTime(ts: number): string {
  const d = Date.now() - ts;
  const m = Math.floor(d / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(d / 3_600_000);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

type RawFeed = { title: string; url: string; source: string; publishedAt: number; summary: string };

function parseYahooRSS(xml: string, fallbackSource: string): RawFeed[] {
  const items: RawFeed[] = [];
  for (const m of [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]) {
    const b = m[1];
    const title = (b.match(/<title><!\[CDATA\[([^\]]*)\]\]><\/title>/)?.[1] ?? b.match(/<title>([^<]*)<\/title>/)?.[1] ?? '').trim();
    const source = (b.match(/<source[^>]*>([^<]*)<\/source>/)?.[1] ?? fallbackSource).trim();
    const pubDate = (b.match(/<pubDate>([^<]*)<\/pubDate>/)?.[1] ?? '').trim();
    const link = (b.match(/<link>([^<]*)<\/link>/)?.[1] ?? '').trim();
    const desc = (b.match(/<description><!\[CDATA\[([^\]]*)\]\]><\/description>/)?.[1] ?? b.match(/<description>([^<]*)<\/description>/)?.[1] ?? '').trim();
    if (title) items.push({ title, url: link, source, publishedAt: pubDate ? new Date(pubDate).getTime() : Date.now(), summary: desc });
  }
  return items.slice(0, 10);
}

export async function GET() {
  const key = process.env.FINNHUB_API_KEY;

  const fetches = await Promise.allSettled([
    key ? fetch(`https://finnhub.io/api/v1/news?category=general&token=${key}`,  { signal: AbortSignal.timeout(8000) }) : Promise.reject('no key'),
    key ? fetch(`https://finnhub.io/api/v1/news?category=forex&token=${key}`,    { signal: AbortSignal.timeout(8000) }) : Promise.reject('no key'),
    key ? fetch(`https://finnhub.io/api/v1/news?category=merger&token=${key}`,   { signal: AbortSignal.timeout(8000) }) : Promise.reject('no key'),
    fetch('https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC&region=US&lang=en-US', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClearGains/1.0)' }, signal: AbortSignal.timeout(8000) }),
    fetch('https://feeds.finance.yahoo.com/rss/2.0/headline?s=GC=F&region=US&lang=en-US',  { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClearGains/1.0)' }, signal: AbortSignal.timeout(8000) }),
    fetch('https://feeds.finance.yahoo.com/rss/2.0/headline?s=CL=F&region=US&lang=en-US',  { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClearGains/1.0)' }, signal: AbortSignal.timeout(8000) }),
  ]);

  const raw: RawFeed[] = [];

  // Finnhub sources (indices 0-2)
  for (let i = 0; i < 3; i++) {
    const r = fetches[i];
    if (r.status !== 'fulfilled' || !r.value.ok) continue;
    try {
      const items = await r.value.json() as Array<{ headline: string; url: string; source: string; datetime: number; summary: string }>;
      if (!Array.isArray(items)) continue;
      for (const item of items.slice(0, 20))
        raw.push({ title: item.headline, url: item.url, source: item.source, publishedAt: item.datetime * 1000, summary: item.summary ?? '' });
    } catch {}
  }

  // Yahoo RSS sources (indices 3-5)
  const rssLabels = ['S&P 500 News', 'Gold News', 'Oil News'];
  for (let i = 3; i < 6; i++) {
    const r = fetches[i];
    if (r.status !== 'fulfilled' || !r.value.ok) continue;
    try {
      const xml = await r.value.text();
      raw.push(...parseYahooRSS(xml, rssLabels[i - 3]));
    } catch {}
  }

  // Deduplicate by URL
  const seen = new Set<string>();
  const deduped = raw.filter(item => {
    const k = item.url || item.title.slice(0, 60);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => b.publishedAt - a.publishedAt).slice(0, 50);

  const analyzed: WorldNewsItem[] = deduped.map((item, idx) => {
    const category = categorize(item.title, item.summary);
    const { sentiment, confidence } = analyzeSentiment(item.title, item.summary);
    const meta = CAT_META[category];
    return {
      id: `${idx}-${item.publishedAt}`,
      title: item.title,
      summary: item.summary.slice(0, 220),
      url: item.url,
      source: item.source,
      publishedAt: new Date(item.publishedAt).toISOString(),
      relativeTime: formatRelativeTime(item.publishedAt),
      category,
      categoryLabel: meta.label,
      categoryEmoji: meta.emoji,
      sentiment,
      confidence,
      ...analyzeImpact(category, item.title, item.summary, sentiment),
    };
  });

  return NextResponse.json({ items: analyzed, count: analyzed.length, timestamp: new Date().toISOString() });
}

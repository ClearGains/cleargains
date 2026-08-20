import { NextRequest, NextResponse } from 'next/server';

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
// 'sinks'/'sink'/'tumbles'/'tumble' were missing entirely — confirmed live this
// let "GS Stock Sinks As Market Gains" score as 95% bullish (1 bullish hit on
// "gains", zero bearish hits since "sinks" matched nothing), when the headline
// is actually describing the stock underperforming a rising market.
const BEARISH_WORDS = ['falls', 'drops', 'miss', 'weak', 'concern', 'risk', 'crisis',
  'warning', 'cut', 'decline', 'slowdown', 'tension', 'threat', 'fear', 'plunges', 'slumps',
  'sinks', 'sink', 'tumbles', 'tumble'];
// "X sinks/falls/drops AS the market gains/rises" is a relative-performance
// headline template (Zacks/CNBC use it constantly) — the stock is
// underperforming even though a bullish-sounding word describes the market,
// not the asset. Without this, the naive bull/bear word ratio above reads
// "gains" as a bullish signal for the stock itself and gets it backwards.
const RELATIVE_UNDERPERFORM = /\b(sinks?|falls?|drops?|declines?|slumps?|tumbles?)\b[^.!?]{0,40}\bas\b[^.!?]{0,20}\b(market|index|s&p|nasdaq|dow)\b/i;

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
  let r = BEARISH_WORDS.filter(w => text.includes(w)).length;
  if (RELATIVE_UNDERPERFORM.test(title) || RELATIVE_UNDERPERFORM.test(summary)) r += 2;
  const total = b + r;
  if (total === 0) return { sentiment: 'neutral', confidence: 50 };
  const ratio = b / total;
  if (ratio >= 0.6) return { sentiment: 'bullish', confidence: Math.min(95, Math.round(50 + ratio * 50)) };
  if (ratio <= 0.4) return { sentiment: 'bearish', confidence: Math.min(95, Math.round(50 + (1 - ratio) * 50)) };
  return { sentiment: 'neutral', confidence: 50 };
}

// Previously: the headline-level sentiment (analyzeSentiment, a flat
// bull/bear word-count ratio over the whole text) and the per-asset impact
// directions below (keyword-matched per category, e.g. "easing" -> Stocks
// bullish) were computed completely independently, with nothing keeping
// them consistent. Confirmed live: "Stocks waver, dollar drops as US
// Treasury moves to lower bond yields" — text contains "drops" and "fears"
// (bearish word hits) AND "easing" (from "easing fears"), so the word-ratio
// read bearish 83% while this function's own 'easing' branch hardcoded
// Stocks/Bonds as bullish — the badge and the impact tags flatly
// contradicted each other on the same story. The category-specific rules
// below are the more domain-aware read (financial phrases like "rate cut"/
// "easing"/"inflation" have well-established market implications a generic
// word list can't capture), so this function now also returns an
// `overrideSentiment` whenever a specific rule actually fired — the caller
// uses that as the authoritative headline-level sentiment instead of the
// generic ratio, which is now only trusted when nothing more specific
// matched (the various category "else" branches).
function analyzeImpact(category: NewsCategory, title: string, summary: string, sentiment: Sentiment) {
  const text = (title + ' ' + summary).toLowerCase();
  const bullish = sentiment === 'bullish';
  const bearish = sentiment === 'bearish';

  const assetImpacts: WorldNewsItem['assetImpacts'] = [];
  const sectorImpacts: WorldNewsItem['sectorImpacts'] = [];
  const currencyImpacts: WorldNewsItem['currencyImpacts'] = [];
  const commodityImpacts: WorldNewsItem['commodityImpacts'] = [];
  let overrideSentiment: Sentiment | null = null;

  switch (category) {
    case 'geopolitical':
      assetImpacts.push({ asset: 'Stocks', direction: 'bearish' }, { asset: 'Bonds', direction: 'bullish' });
      currencyImpacts.push({ currency: 'USD', direction: 'strengthen' }, { currency: 'JPY', direction: 'strengthen' }, { currency: 'CHF', direction: 'strengthen' });
      commodityImpacts.push({ commodity: 'Gold', direction: 'rise', reason: 'Safe haven demand' });
      sectorImpacts.push({ sector: 'Defence', direction: 'bullish' });
      overrideSentiment = 'bearish';
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
        overrideSentiment = 'bearish';
      } else if (text.includes('rate cut') || text.includes('stimulus') || text.includes('easing')) {
        assetImpacts.push({ asset: 'Stocks', direction: 'bullish' }, { asset: 'Bonds', direction: 'bullish' });
        currencyImpacts.push({ currency: 'USD', direction: 'weaken' });
        sectorImpacts.push({ sector: 'Growth Stocks', direction: 'bullish' }, { sector: 'Real Estate', direction: 'bullish' });
        overrideSentiment = 'bullish';
      } else if (text.includes('recession') || text.includes('slowdown')) {
        assetImpacts.push({ asset: 'Stocks', direction: 'bearish' }, { asset: 'Bonds', direction: 'bullish' });
        sectorImpacts.push({ sector: 'Defensives', direction: 'bullish' }, { sector: 'Cyclicals', direction: 'bearish' });
        commodityImpacts.push({ commodity: 'Gold', direction: 'rise', reason: 'Recession hedge' });
        overrideSentiment = 'bearish';
      } else {
        assetImpacts.push({ asset: 'Stocks', direction: bullish ? 'bullish' : bearish ? 'bearish' : 'neutral' });
      }
      break;

    case 'central-bank': {
      const isHawkish = text.includes('rate hike') || text.includes('hawkish') || text.includes('tighten');
      const isDovish  = text.includes('rate cut') || text.includes('dovish') || text.includes('easing');
      assetImpacts.push({ asset: 'Stocks', direction: isHawkish ? 'bearish' : isDovish ? 'bullish' : 'neutral' });
      assetImpacts.push({ asset: 'Bonds', direction: isHawkish ? 'bearish' : isDovish ? 'bullish' : 'neutral' });
      if (isHawkish) overrideSentiment = 'bearish';
      else if (isDovish) overrideSentiment = 'bullish';
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
      overrideSentiment = 'bearish';
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
      overrideSentiment = 'bearish';
      break;
  }

  return { assetImpacts, sectorImpacts, currencyImpacts, commodityImpacts, overrideSentiment };
}

// ── Optional Gemini pass — on-demand only, never on the background auto-
// refresh timer ──────────────────────────────────────────────────────────
// Per explicit decision: a keyword scanner alone genuinely struggles with
// headlines like "X sinks as market gains" (fixed above, but that pattern
// won't be the last one), so a real read is worth it — but only when the
// user is actually looking at the page, not silently accumulating calls
// from an open tab's 15-min auto-refresh (the frontend only ever passes
// ai=1 on initial load / manual "Refresh All"). One batched call classifies
// every headline in a single request/response rather than one call per
// headline — the cost of reviewing one story, not fifty.
//
// Deliberately narrow scope: Gemini only returns category + sentiment +
// confidence + a one-line reason per headline. The actual asset/sector/
// currency/commodity impact tags are still generated by analyzeImpact()
// below, reusing the same (now-consistent) domain rules rather than asking
// Gemini to also invent structured impact data — that's a mechanical
// mapping from category+direction, not a judgment call, and keeping the
// prompt/response schema small for up to 50 headlines is more reliable
// than a large structured schema would be.
type GeminiClassification = { category: NewsCategory; sentiment: Sentiment; confidence: number; reasoning: string };

async function classifyWithGemini(items: RawFeed[]): Promise<GeminiClassification[] | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('[world-affairs gemini] no GEMINI_API_KEY configured'); return null; }
  if (items.length === 0) return null;

  const list = items.map((it, i) => `${i + 1}. ${it.title}${it.summary ? ` — ${it.summary.slice(0, 200)}` : ''}`).join('\n');

  const prompt = `You are a financial news analyst. Classify each headline below by category and market sentiment for the specific stock/asset it's actually about (not the broader market, unless the story has no specific target).

Watch specifically for relative-performance framing like "X sinks/falls/drops as the market gains/rises" — that means X is UNDERPERFORMING a rising market, which is bearish for X even though a bullish-sounding word ("gains") appears in the sentence. The bullish word there describes the market, not the asset.

Categories: geopolitical, economic, central-bank, commodities, earnings, health-crisis, energy, tech-regulation

Headlines:
${list}

Return ONLY a JSON array with exactly ${items.length} objects, one per headline, in the same order — no markdown, no other text:
[{"category":"economic","sentiment":"bullish","confidence":75,"reasoning":"under 12 words"}]`;

  try {
    // Pinned, not "-latest" — confirmed live just now (2x in a row) that
    // gemini-flash-latest returns 503 UNAVAILABLE ("high demand"), the same
    // undercapacity-on-newer-releases pattern bot-server's own gemini.ts
    // already hit and fixed by pinning to this exact version. thinkingBudget:0
    // for the same reason as there too — this model spends hidden "thinking"
    // tokens by default that can exhaust maxOutputTokens before the visible
    // JSON answer finishes, leaving a truncated/unparseable fragment.
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents:         [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 4000, thinkingConfig: { thinkingBudget: 0 } },
        }),
        signal: AbortSignal.timeout(20_000),
      }
    );
    if (!res.ok) {
      console.error('[world-affairs gemini] HTTP', res.status, (await res.text()).slice(0, 300));
      return null;
    }

    const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) { console.error('[world-affairs gemini] no JSON array in response:', text.slice(0, 300)); return null; }
    const parsed = JSON.parse(match[0]) as GeminiClassification[];
    // Length mismatch means the model dropped or merged entries — the
    // index-based mapping back to headlines below would silently
    // misattribute every result after the gap, so fail closed to the free
    // classifier rather than show confidently-wrong data.
    if (!Array.isArray(parsed) || parsed.length !== items.length) {
      console.error('[world-affairs gemini] length mismatch: got', Array.isArray(parsed) ? parsed.length : typeof parsed, 'expected', items.length);
      return null;
    }
    // Guard against a hallucinated/misspelled category or sentiment value —
    // CAT_META[category] downstream would otherwise throw on an unknown key.
    const validCats: NewsCategory[] = ['geopolitical', 'economic', 'central-bank', 'commodities', 'earnings', 'health-crisis', 'energy', 'tech-regulation'];
    const validSentiments: Sentiment[] = ['bullish', 'bearish', 'neutral'];
    for (const p of parsed) {
      if (!validCats.includes(p.category) || !validSentiments.includes(p.sentiment)) {
        console.error('[world-affairs gemini] invalid category/sentiment:', JSON.stringify(p).slice(0, 200));
        return null;
      }
      p.confidence = Math.max(0, Math.min(100, Number(p.confidence) || 50));
    }
    return parsed;
  } catch (e) {
    console.error('[world-affairs gemini] exception:', e instanceof Error ? e.message : String(e));
    return null;
  }
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

// Alpaca's news API — genuinely closer to real-time than Finnhub's free
// tier (confirmed: same account already used for bot-server's news stream
// and market data). Added alongside Finnhub/Yahoo rather than replacing
// them: Alpaca's coverage skews toward US-listed equities, while
// Finnhub/Yahoo still carry the broader macro/geopolitical stories this
// page's categories (geopolitical, central-bank, health-crisis, etc.) rely
// on — losing those would narrow the page, not improve it.
async function fetchAlpacaNews(): Promise<RawFeed[]> {
  const key    = process.env.ALPACA_PAPER_KEY;
  const secret = process.env.ALPACA_PAPER_SECRET;
  if (!key || !secret) return [];
  try {
    const res = await fetch('https://data.alpaca.markets/v1beta1/news?limit=50&sort=desc&include_content=false', {
      headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json() as { news?: Array<{ headline: string; url: string; source: string; created_at: string; summary?: string }> };
    return (data.news ?? []).map(n => ({
      title: n.headline, url: n.url, source: n.source || 'Alpaca',
      publishedAt: new Date(n.created_at).getTime(), summary: n.summary ?? '',
    }));
  } catch { return []; }
}

export async function GET(req: NextRequest) {
  const key = process.env.FINNHUB_API_KEY;
  const useAi = req.nextUrl.searchParams.get('ai') === '1';

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

  raw.push(...await fetchAlpacaNews());

  // Deduplicate by URL
  const seen = new Set<string>();
  const deduped = raw.filter(item => {
    const k = item.url || item.title.slice(0, 60);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => b.publishedAt - a.publishedAt).slice(0, 50);

  // Only spent on an explicit ai=1 request (initial load / manual refresh
  // from the frontend) — the background auto-refresh timer never sets this,
  // so an open tab doesn't quietly accumulate calls on its own.
  const geminiResults = useAi ? await classifyWithGemini(deduped) : null;

  const analyzed: WorldNewsItem[] = deduped.map((item, idx) => {
    const gemini = geminiResults?.[idx];
    // Gemini's read (when available) is the authoritative one — it already
    // accounts for things like relative-performance framing directly,
    // rather than needing the word-ratio + category-override fallback
    // chain below. That fallback chain only runs per-item when the Gemini
    // pass wasn't requested, or failed/returned a malformed response for
    // the whole batch (classifyWithGemini fails closed, not partially).
    const category = gemini?.category ?? categorize(item.title, item.summary);
    const wordRatio = gemini ? null : analyzeSentiment(item.title, item.summary);
    const { overrideSentiment, ...impacts } = analyzeImpact(category, item.title, item.summary, gemini?.sentiment ?? wordRatio!.sentiment);
    const meta = CAT_META[category];
    const sentiment  = gemini?.sentiment ?? overrideSentiment ?? wordRatio!.sentiment;
    const confidence = gemini?.confidence ?? (overrideSentiment ? 78 : wordRatio!.confidence);
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
      ...impacts,
    };
  });

  return NextResponse.json({
    items: analyzed,
    count: analyzed.length,
    timestamp: new Date().toISOString(),
    aiReviewed: geminiResults !== null,
  });
}

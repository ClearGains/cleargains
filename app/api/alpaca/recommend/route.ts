import Anthropic from '@anthropic-ai/sdk';

export const maxDuration = 30;

type StrategyName = 'rsi_mean_reversion' | 'ema_crossover' | 'orb' | 'vwap' | 'weekly_momentum';

type NewsItem = { headline: string; source: string; datetime: number; summary?: string };

export type StrategyRecommendation = {
  strategy:         StrategyName;
  confidence:       number;          // 0–100
  marketCondition:  string;          // e.g. "High volatility — Fed day"
  reasoning:        string;          // 2–3 sentence explanation
  suggestedSymbols: string[];
  allowShorts:      boolean;
  keyHeadlines:     { headline: string; source: string; sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL' }[];
  generatedAt:      string;
};

const STRATEGY_DESCRIPTIONS = `
1. rsi_mean_reversion — 5-min intraday. Best when market is choppy/range-bound and individual stocks are reverting. RSI < 30 buy, RSI > 70 sell. Stop 1.5× ATR.
2. ema_crossover — Daily swing. Best in trending markets with clear momentum. EMA9 crosses EMA21. Hold days to weeks.
3. orb — Intraday Opening Range Breakout. Best on high-volatility days (earnings, macro events, FOMC). Trade first-30-min range breakout.
4. vwap — 1-min intraday VWAP reversion. Best when market is directionless but liquid. Buy dips 0.5% below VWAP.
5. weekly_momentum — Weekly bars. Best in long-running bull trends, low-volatility environment. Above 12-week SMA + positive momentum.
`;

async function fetchFinnhubNews(key: string): Promise<NewsItem[]> {
  const res = await fetch(
    `https://finnhub.io/api/v1/news?category=general&minId=0&token=${key}`,
    { signal: AbortSignal.timeout(7_000), next: { revalidate: 900 } },
  );
  if (!res.ok) return [];
  const raw = await res.json() as NewsItem[];
  return Array.isArray(raw) ? raw.filter(a => a.headline).slice(0, 25) : [];
}

async function fetchFinnhubMarketNews(symbols: string[], key: string): Promise<NewsItem[]> {
  const today   = new Date().toISOString().split('T')[0];
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const results: NewsItem[] = [];

  await Promise.all(symbols.map(async sym => {
    try {
      const res = await fetch(
        `https://finnhub.io/api/v1/company-news?symbol=${sym}&from=${weekAgo}&to=${today}&token=${key}`,
        { signal: AbortSignal.timeout(5_000), next: { revalidate: 900 } },
      );
      if (!res.ok) return;
      const raw = await res.json() as NewsItem[];
      if (Array.isArray(raw)) results.push(...raw.slice(0, 5));
    } catch {}
  }));

  return results;
}

function marketContext(): string {
  const now    = new Date();
  const day    = now.getUTCDay();
  const hour   = now.getUTCHours();
  const days   = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const utcMin = hour * 60 + now.getUTCMinutes();

  const isWeekend   = day === 0 || day === 6;
  const preMarket   = !isWeekend && utcMin >= 9 * 60 && utcMin < 13 * 60 + 30;
  const marketOpen  = !isWeekend && utcMin >= 13 * 60 + 30 && utcMin < 21 * 60;
  const afterHours  = !isWeekend && utcMin >= 21 * 60;
  const earlyIntraday = marketOpen && utcMin < 15 * 60;

  let session = 'pre-market';
  if (isWeekend) session = 'weekend';
  else if (marketOpen && earlyIntraday) session = 'market open (first 90 minutes)';
  else if (marketOpen) session = 'market hours (mid-session)';
  else if (afterHours) session = 'after-hours';

  return `Today is ${days[day]}, ${now.toISOString().split('T')[0]}. Current session: ${session}.`;
}

export async function GET(): Promise<Response> {
  const finnhubKey = process.env.FINNHUB_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!finnhubKey || !anthropicKey) {
    return Response.json(
      { error: 'FINNHUB_API_KEY or ANTHROPIC_API_KEY not configured' },
      { status: 503 },
    );
  }

  // Fetch news in parallel
  const [generalNews, marketNews] = await Promise.all([
    fetchFinnhubNews(finnhubKey),
    fetchFinnhubMarketNews(['SPY', 'QQQ', 'AAPL', 'NVDA', 'TSLA'], finnhubKey),
  ]);

  const allNews = [...generalNews, ...marketNews]
    .filter((v, i, a) => a.findIndex(x => x.headline === v.headline) === i)  // dedupe
    .slice(0, 30);

  const headlineList = allNews
    .map(h => `- ${h.headline} (${h.source})`)
    .join('\n');

  const prompt = `You are a quantitative trading strategist. Today's date and market context: ${marketContext()}

Available trading strategies:
${STRATEGY_DESCRIPTIONS}

Today's market news headlines:
${headlineList || '(no headlines available)'}

Based on the current market session, news sentiment, and market conditions, recommend the single best strategy to run today.

Respond ONLY with valid JSON in this exact shape:
{
  "strategy": "<one of: rsi_mean_reversion | ema_crossover | orb | vwap | weekly_momentum>",
  "confidence": <integer 0–100>,
  "marketCondition": "<6–10 word summary of today's market environment>",
  "reasoning": "<2–3 sentences explaining why this strategy fits today's conditions>",
  "suggestedSymbols": ["TICK1", "TICK2", "...up to 6"],
  "allowShorts": <true|false>,
  "keyHeadlines": [
    { "headline": "<exact headline>", "source": "<source>", "sentiment": "BULLISH" | "BEARISH" | "NEUTRAL" }
  ]
}

Rules:
- keyHeadlines: pick the 3–5 most market-moving headlines only
- suggestedSymbols: pick liquid US stocks/ETFs that fit the strategy and news context
- allowShorts: true only if news is clearly bearish and the strategy supports it
- On weekends or when market is closed: prefer ema_crossover or weekly_momentum (not intraday)
- On high-volatility/news days: prefer orb
- On quiet trending days: prefer ema_crossover or vwap
- On choppy/mean-reverting days: prefer rsi_mean_reversion`;

  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages:   [{ role: 'user', content: prompt }],
    });

    const text    = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

    const parsed = JSON.parse(cleaned) as Omit<StrategyRecommendation, 'generatedAt'>;
    const result: StrategyRecommendation = { ...parsed, generatedAt: new Date().toISOString() };

    return Response.json({ recommendation: result, success: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ recommendation: null, success: false, error: msg }, { status: 500 });
  }
}

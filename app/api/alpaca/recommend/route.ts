export const maxDuration = 30;

type StrategyName = 'rsi_mean_reversion' | 'ema_crossover' | 'orb' | 'vwap' | 'weekly_momentum';

type NewsItem = { headline: string; source: string; datetime: number; summary?: string };

export type StrategyRecommendation = {
  strategy:         StrategyName;
  confidence:       number;
  marketCondition:  string;
  reasoning:        string;
  suggestedSymbols: string[];
  allowShorts:      boolean;
  keyHeadlines:     { headline: string; source: string; sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL' }[];
  generatedAt:      string;
  engine:           'gemini' | 'rules';
};

// ── Market context ────────────────────────────────────────────────────────────

type SessionInfo = {
  day:            number;   // 0=Sun … 6=Sat
  utcMin:         number;
  isWeekend:      boolean;
  isPreMarket:    boolean;
  isOpeningHour:  boolean;  // first 90 min of NYSE
  isMarketHours:  boolean;
  isAfterHours:   boolean;
  label:          string;
};

function getSession(): SessionInfo {
  const now    = new Date();
  const day    = now.getUTCDay();
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const days   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  const isWeekend     = day === 0 || day === 6;
  const isPreMarket   = !isWeekend && utcMin >= 9 * 60     && utcMin < 13 * 60 + 30;
  const isMarketHours = !isWeekend && utcMin >= 13 * 60 + 30 && utcMin < 21 * 60;
  const isOpeningHour = isMarketHours && utcMin < 15 * 60;
  const isAfterHours  = !isWeekend && utcMin >= 21 * 60;

  let label = 'pre-market';
  if (isWeekend)     label = 'weekend';
  else if (isOpeningHour)  label = 'market open (first 90 min)';
  else if (isMarketHours)  label = 'mid-session';
  else if (isAfterHours)   label = 'after-hours';

  return { day, utcMin, isWeekend, isPreMarket, isOpeningHour, isMarketHours, isAfterHours, label };
}

// ── Rule-based strategy selector ──────────────────────────────────────────────

const DEFAULT_SYMBOLS: Record<StrategyName, string[]> = {
  rsi_mean_reversion: ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN'],
  ema_crossover:      ['SPY', 'QQQ', 'AAPL', 'MSFT', 'GOOGL'],
  orb:                ['SPY', 'QQQ', 'NVDA', 'TSLA', 'META'],
  vwap:               ['SPY', 'QQQ', 'AAPL', 'AMZN', 'MSFT'],
  weekly_momentum:    ['SPY', 'QQQ', 'VTI', 'AAPL', 'MSFT'],
};

function ruleBasedRecommendation(sess: SessionInfo, bearishCount: number, bullishCount: number): Omit<StrategyRecommendation, 'keyHeadlines' | 'generatedAt' | 'engine'> {
  const newsSkew = bullishCount - bearishCount;
  const allowShorts = bearishCount >= 3 && newsSkew < -1;

  // Weekend / closed market → swing/weekly only
  if (sess.isWeekend || sess.isAfterHours || sess.isPreMarket) {
    const strategy: StrategyName = sess.day === 1 ? 'weekly_momentum' : 'ema_crossover';
    return {
      strategy,
      confidence:      55,
      marketCondition: sess.isWeekend ? 'Weekend — markets closed' : `${sess.label} — no live prices`,
      reasoning:       `Markets are ${sess.isWeekend ? 'closed for the weekend' : 'outside regular hours'}. ${strategy === 'weekly_momentum' ? 'Weekly momentum uses end-of-week bars and is ideal for Monday planning.' : 'EMA crossover works on daily bars and does not require intraday data.'}`,
      suggestedSymbols: DEFAULT_SYMBOLS[strategy],
      allowShorts,
    };
  }

  // Opening 90 min → ORB thrives on early volatility
  if (sess.isOpeningHour) {
    return {
      strategy:        'orb',
      confidence:      70,
      marketCondition: 'Opening range — high volatility window',
      reasoning:       'The first 90 minutes after NYSE open typically see the widest price swings. Opening Range Breakout captures the initial directional move after the 30-min range is established.',
      suggestedSymbols: DEFAULT_SYMBOLS['orb'],
      allowShorts,
    };
  }

  // Mid-session — pick between RSI and VWAP based on news skew
  if (newsSkew > 2) {
    return {
      strategy:        'ema_crossover',
      confidence:      65,
      marketCondition: 'Mid-session — bullish news momentum',
      reasoning:       'Strong bullish headline skew suggests a trending environment. EMA crossover captures sustained momentum better than mean-reversion strategies.',
      suggestedSymbols: DEFAULT_SYMBOLS['ema_crossover'],
      allowShorts: false,
    };
  }

  if (newsSkew < -2) {
    return {
      strategy:        'rsi_mean_reversion',
      confidence:      65,
      marketCondition: 'Mid-session — bearish headlines, choppy expected',
      reasoning:       'Bearish news skew often produces erratic price action where stocks overshoot and snap back. RSI mean reversion profits from these exaggerated moves.',
      suggestedSymbols: DEFAULT_SYMBOLS['rsi_mean_reversion'],
      allowShorts,
    };
  }

  // Neutral mid-session → VWAP reversion
  return {
    strategy:        'vwap',
    confidence:      60,
    marketCondition: 'Mid-session — directionless, liquid tape',
    reasoning:       'No strong news catalyst detected. VWAP reversion works best in calm mid-session conditions where price oscillates around the volume-weighted average.',
    suggestedSymbols: DEFAULT_SYMBOLS['vwap'],
    allowShorts,
  };
}

// ── News helpers ──────────────────────────────────────────────────────────────

async function fetchFinnhubNews(key: string): Promise<NewsItem[]> {
  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/news?category=general&minId=0&token=${key}`,
      { signal: AbortSignal.timeout(7_000), next: { revalidate: 900 } },
    );
    if (!res.ok) return [];
    const raw = await res.json() as NewsItem[];
    return Array.isArray(raw) ? raw.filter(a => a.headline).slice(0, 20) : [];
  } catch { return []; }
}

async function fetchSymbolNews(symbols: string[], key: string): Promise<NewsItem[]> {
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
      if (Array.isArray(raw)) results.push(...raw.slice(0, 4));
    } catch {}
  }));
  return results;
}

// Simple keyword sentiment — used before Gemini to inform rule selection
function quickSentiment(headlines: NewsItem[]): { bullish: number; bearish: number } {
  const bullWords = /surge|rally|soar|beat|record|gain|rise|jump|strong|buy|upgrade|profit|growth/i;
  const bearWords = /crash|plunge|fall|miss|loss|cut|warn|risk|fear|sell|downgrade|recession|tariff/i;
  let bullish = 0, bearish = 0;
  for (const h of headlines) {
    if (bullWords.test(h.headline)) bullish++;
    if (bearWords.test(h.headline)) bearish++;
  }
  return { bullish, bearish };
}

// ── Gemini enrichment ─────────────────────────────────────────────────────────

const STRATEGY_DESCRIPTIONS = `
rsi_mean_reversion — 5-min intraday. Choppy/range-bound markets. RSI <30 buy, >70 sell.
ema_crossover — Daily swing. Trending markets. EMA9 crosses EMA21.
orb — Opening Range Breakout. High-volatility/news days. Trade 30-min range breakout.
vwap — 1-min intraday. Directionless liquid tape. Buy dips below VWAP.
weekly_momentum — Weekly bars. Long bull trends, low volatility. Above 12-week SMA.
`;

async function enrichWithGemini(
  base: Omit<StrategyRecommendation, 'keyHeadlines' | 'generatedAt' | 'engine'>,
  headlines: NewsItem[],
  sess: SessionInfo,
  apiKey: string,
): Promise<Omit<StrategyRecommendation, 'generatedAt' | 'engine'> | null> {
  const headlineList = headlines.map(h => `- ${h.headline} (${h.source})`).join('\n');
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  const prompt = `You are a quantitative trading strategist. Today is ${days[sess.day]}, session: ${sess.label}.

Available strategies:
${STRATEGY_DESCRIPTIONS}

Rules engine selected: ${base.strategy} (confidence ${base.confidence}%)
Rules reasoning: ${base.reasoning}

Recent market headlines:
${headlineList || '(none available)'}

Your job: refine the rules selection. You may keep or change the strategy if news strongly justifies it.

Respond ONLY with valid JSON — no markdown, no extra text:
{
  "strategy": "<one of the 5 strategy names>",
  "confidence": <integer 0-100>,
  "marketCondition": "<6-10 word summary>",
  "reasoning": "<2-3 sentences>",
  "suggestedSymbols": ["UP","TO","6","TICKERS"],
  "allowShorts": <true|false>,
  "keyHeadlines": [
    {"headline":"<exact text>","source":"<source>","sentiment":"BULLISH"|"BEARISH"|"NEUTRAL"}
  ]
}
Rules: keyHeadlines = 3-5 most market-moving only. allowShorts only if clearly bearish.`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          contents:         [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 512 },
        }),
        signal: AbortSignal.timeout(12_000),
      },
    );

    if (!res.ok) return null;

    const data = await res.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    const text    = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned) as Omit<StrategyRecommendation, 'generatedAt' | 'engine'>;
  } catch {
    return null;
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(): Promise<Response> {
  const finnhubKey = process.env.FINNHUB_API_KEY;
  const geminiKey  = process.env.GEMINI_API_KEY;

  const sess = getSession();

  // Fetch news (best-effort — works without Finnhub key too)
  let headlines: NewsItem[] = [];
  if (finnhubKey) {
    const [general, market] = await Promise.all([
      fetchFinnhubNews(finnhubKey),
      fetchSymbolNews(['SPY', 'QQQ', 'AAPL', 'NVDA', 'TSLA'], finnhubKey),
    ]);
    headlines = [...general, ...market]
      .filter((v, i, a) => a.findIndex(x => x.headline === v.headline) === i)
      .slice(0, 30);
  }

  const { bullish, bearish } = quickSentiment(headlines);

  // Stage 1 — rule-based (always succeeds)
  const base = ruleBasedRecommendation(sess, bearish, bullish);

  // Stage 2 — Gemini enrichment (optional)
  let enriched: Omit<StrategyRecommendation, 'generatedAt' | 'engine'> | null = null;
  if (geminiKey) {
    enriched = await enrichWithGemini(base, headlines, sess, geminiKey);
  }

  // Fallback keyHeadlines if Gemini skipped
  const fallbackHeadlines = headlines.slice(0, 5).map(h => ({
    headline:  h.headline,
    source:    h.source,
    sentiment: 'NEUTRAL' as const,
  }));

  const result: StrategyRecommendation = {
    ...(enriched ?? base),
    keyHeadlines: enriched?.keyHeadlines ?? fallbackHeadlines,
    generatedAt:  new Date().toISOString(),
    engine:       enriched ? 'gemini' : 'rules',
  };

  return Response.json({ recommendation: result, success: true });
}

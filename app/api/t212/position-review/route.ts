import { NextRequest, NextResponse } from 'next/server';
import { UNIVERSE, ADR_MAP, type UniverseStock } from '@/lib/stockUniverse';

// ── T212 position review — longer-horizon, not the short-term demo-trader scan ─
// T212 positions are held for weeks/months, not hours/days like the IG bots
// this codebase otherwise runs — reusing the short-term momentum/6h-news scan
// from demo-trader/signals would flag "swap" on ordinary weekly noise. This
// looks at multi-week/multi-month trend and a 30-day news window instead, and
// defaults hard to KEEP — a swap is only suggested when both the price trend
// AND the news are genuinely negative over a real timeframe, not either alone.

type TrendResult = { trend4w: number | null; trend12w: number | null; currentPrice: number | null };

async function fetchTrend(yahooTicker: string): Promise<TrendResult> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}?interval=1d&range=6mo`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClearGains/1.0)', Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return { trend4w: null, trend12w: null, currentPrice: null };
    const data = await res.json() as {
      chart?: { result?: Array<{ indicators?: { quote?: Array<{ close?: (number | null)[] }> } }> };
    };
    const closes = (data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? []).filter(
      (c): c is number => c !== null && c !== undefined && c > 0,
    );
    if (closes.length < 10) return { trend4w: null, trend12w: null, currentPrice: closes.at(-1) ?? null };
    const last = closes[closes.length - 1];
    // ~5 trading days/week
    const idx4w  = Math.max(0, closes.length - 1 - 20);
    const idx12w = Math.max(0, closes.length - 1 - 60);
    const trend4w  = closes[idx4w]  > 0 ? ((last - closes[idx4w])  / closes[idx4w])  * 100 : null;
    const trend12w = closes[idx12w] > 0 ? ((last - closes[idx12w]) / closes[idx12w]) * 100 : null;
    return { trend4w, trend12w, currentPrice: last };
  } catch {
    return { trend4w: null, trend12w: null, currentPrice: null };
  }
}

const BULLISH = ['beats','beat','surges','surge','soars','soar','rises','rise','gains','gain',
  'rallies','rally','record','upgrade','upgraded','outperform','strong','growth','profit','profits',
  'boost','boosted','raises','raised','exceeds','positive','higher','bullish','buy','overweight',
  'breakthrough','approval','deal','wins','guidance raised'];
const BEARISH = ['misses','miss','falls','plunges','plunge','slumps','slump','loss','losses','cuts','cut',
  'downgrade','downgraded','underperform','weak','concern','concerns','risk','warning','warns',
  'layoffs','disappoints','sell','bearish','negative','lower','lawsuit','probe','recall',
  'guidance cut','bankruptcy','investigation','fraud','scandal'];

function sentimentScore(headlines: string[]): { score: number; bull: number; bear: number } {
  let bull = 0, bear = 0;
  for (const h of headlines) {
    const l = h.toLowerCase();
    bull += BULLISH.filter(w => l.includes(w)).length;
    bear += BEARISH.filter(w => l.includes(w)).length;
  }
  const total = bull + bear;
  return { score: total === 0 ? 0 : (bull - bear) / total, bull, bear };
}

async function fetch30DayNews(symbol: string, apiKey: string): Promise<{ headlines: string[]; sentiment: number; bull: number; bear: number }> {
  try {
    const to   = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const res = await fetch(
      `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&token=${apiKey}`,
      { signal: AbortSignal.timeout(6_000) },
    );
    if (!res.ok) return { headlines: [], sentiment: 0, bull: 0, bear: 0 };
    const raw = await res.json() as Array<{ headline?: string; datetime?: number }>;
    if (!Array.isArray(raw)) return { headlines: [], sentiment: 0, bull: 0, bear: 0 };
    const headlines = raw.filter(a => !!a.headline).sort((a, b) => (b.datetime ?? 0) - (a.datetime ?? 0))
      .slice(0, 15).map(a => a.headline!);
    const { score, bull, bear } = sentimentScore(headlines);
    return { headlines, sentiment: score, bull, bear };
  } catch {
    return { headlines: [], sentiment: 0, bull: 0, bear: 0 };
  }
}

function resolveYahooTicker(t212Ticker: string, symbolGuess: string): { yahoo: string; isUK: boolean } {
  const known = UNIVERSE.find(u => u.t212 === t212Ticker);
  if (known) return { yahoo: known.symbol, isUK: known.isUK };
  // Fallback: strip T212's _XX_EQ suffix
  const isUK = t212Ticker.includes('_GB_EQ');
  const base = symbolGuess.replace(/_[A-Z]{2}_EQ$/, '');
  return { yahoo: isUK ? `${base}.L` : base, isUK };
}

export async function POST(request: NextRequest) {
  const encoded = request.headers.get('x-t212-auth');
  if (!encoded) return NextResponse.json({ ok: false, error: 'Missing x-t212-auth header' }, { status: 400 });

  const body = await request.json().catch(() => ({})) as { env?: string };
  const env = body.env ?? 'live';
  const base = env === 'demo' ? 'https://demo.trading212.com/api/v0' : 'https://live.trading212.com/api/v0';
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return NextResponse.json({ ok: false, error: 'FINNHUB_API_KEY not configured' }, { status: 503 });

  // ── Fetch current positions ────────────────────────────────────────────────
  let positions: Array<{ ticker: string; quantity: number; averagePrice: number; currentPrice?: number; ppl?: number }>;
  try {
    const res = await fetch(`${base}/equity/portfolio`, {
      headers: { Authorization: 'Basic ' + encoded },
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) return NextResponse.json({ ok: false, error: `T212 error ${res.status}: ${text.slice(0, 300)}` }, { status: res.status });
    positions = JSON.parse(text);
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'Failed to fetch positions' }, { status: 500 });
  }

  if (!Array.isArray(positions) || positions.length === 0) {
    return NextResponse.json({ ok: true, reviews: [], note: 'No open positions to review.' });
  }

  // ── Review each holding — multi-week trend + 30-day news, default KEEP ──────
  type Review = {
    ticker: string; symbol: string; sector: string | null;
    quantity: number; averagePrice: number; currentPrice: number | null;
    unrealizedPnl: number | null;
    trend4w: number | null; trend12w: number | null;
    newsSentiment: number; recentHeadline: string | null;
    verdict: 'KEEP' | 'CONSIDER_SWAPPING';
    reason: string;
    alternative?: { symbol: string; name: string; t212: string; trend12w: number | null };
  };

  const reviews: Review[] = await Promise.all(positions.map(async pos => {
    const known = UNIVERSE.find(u => u.t212 === pos.ticker);
    const { yahoo, isUK } = resolveYahooTicker(pos.ticker, pos.ticker);
    const sector = known?.sector ?? null;

    const [trend, news] = await Promise.all([
      fetchTrend(yahoo),
      // News lookup needs a plain symbol — use ADR-mapped US ticker for UK
      // stocks (Finnhub's UK coverage is weak), matching the pattern already
      // used in the short-term scanner.
      fetch30DayNews(isUK ? (ADR_MAP[yahoo] ?? yahoo.replace('.L', '')) : yahoo, apiKey),
    ]);

    const unrealizedPnl = pos.ppl ?? (pos.currentPrice ? (pos.currentPrice - pos.averagePrice) * pos.quantity : null);

    // Require BOTH a genuinely negative multi-month trend AND clearly
    // negative recent news before suggesting anything — a real catalyst,
    // not daily noise. Deliberately conservative: only flags on sustained,
    // corroborated weakness.
    const trendBad = trend.trend12w !== null && trend.trend12w <= -12 && trend.trend4w !== null && trend.trend4w <= -5;
    const newsBad  = news.bear >= 2 && news.sentiment <= -0.3;
    const shouldFlag = trendBad && newsBad;

    let reason: string;
    if (shouldFlag) {
      reason = `Down ${trend.trend12w!.toFixed(1)}% over ~12 weeks (${trend.trend4w!.toFixed(1)}% over the last 4) with genuinely negative recent news (${news.bear} bearish headline${news.bear === 1 ? '' : 's'} in the last 30 days) — this isn't noise, the thesis looks like it's actually broken.`;
    } else if (trendBad && !newsBad) {
      reason = `Price is down over the last few months (${trend.trend12w?.toFixed(1)}%), but no clear negative catalyst in the news — could be sector-wide or temporary. Holding, but worth watching.`;
    } else if (!trendBad && newsBad) {
      reason = `Some negative headlines recently, but the multi-month trend is still intact — a single bad news cycle isn't reason enough to exit a longer-term position.`;
    } else if (trend.trend12w !== null) {
      reason = `Trend over ~12 weeks: ${trend.trend12w >= 0 ? '+' : ''}${trend.trend12w.toFixed(1)}%, no material negative news. Thesis looks intact.`;
    } else {
      reason = 'Not enough price history to assess trend — holding by default.';
    }

    let alternative: Review['alternative'];
    if (shouldFlag && sector) {
      // Same-sector candidates not currently held, same longer-term lens —
      // pick the best 12-week trend among them, not a short-term mover.
      const heldTickers = new Set(positions.map(p => p.ticker));
      const sectorPeers = UNIVERSE.filter(u => u.sector === sector && !heldTickers.has(u.t212)).slice(0, 6);
      const peerTrends = await Promise.all(sectorPeers.map(async peer => ({
        peer, trend: await fetchTrend(peer.symbol),
      })));
      const best = peerTrends
        .filter(p => p.trend.trend12w !== null && p.trend.trend12w > 0)
        .sort((a, b) => (b.trend.trend12w ?? -Infinity) - (a.trend.trend12w ?? -Infinity))[0];
      if (best) {
        alternative = { symbol: best.peer.symbol, name: best.peer.name, t212: best.peer.t212, trend12w: best.trend.trend12w };
      }
    }

    return {
      ticker: pos.ticker,
      symbol: yahoo.replace('.L', ''),
      sector,
      quantity: pos.quantity,
      averagePrice: pos.averagePrice,
      currentPrice: pos.currentPrice ?? trend.currentPrice,
      unrealizedPnl,
      trend4w: trend.trend4w,
      trend12w: trend.trend12w,
      newsSentiment: news.sentiment,
      recentHeadline: news.headlines[0] ?? null,
      verdict: shouldFlag ? 'CONSIDER_SWAPPING' : 'KEEP',
      reason,
      alternative,
    } satisfies Review;
  }));

  return NextResponse.json({
    ok: true,
    reviews,
    summary: {
      total: reviews.length,
      keep: reviews.filter(r => r.verdict === 'KEEP').length,
      considerSwapping: reviews.filter(r => r.verdict === 'CONSIDER_SWAPPING').length,
    },
    note: 'Longer-horizon review for buy-and-hold T212 positions: multi-week/month trend + 30-day news, not intraday signals. Defaults to KEEP — a swap is only suggested when both trend and news are genuinely negative over a real timeframe.',
  });
}

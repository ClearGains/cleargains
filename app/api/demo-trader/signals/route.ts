import { NextRequest, NextResponse } from 'next/server';

// Sector → stock universe
const SECTOR_STOCKS: Record<string, { symbol: string; name: string; t212: string }[]> = {
  Technology: [
    { symbol: 'AAPL', name: 'Apple Inc.', t212: 'AAPL_US_EQ' },
    { symbol: 'MSFT', name: 'Microsoft Corp.', t212: 'MSFT_US_EQ' },
    { symbol: 'NVDA', name: 'Nvidia Corp.', t212: 'NVDA_US_EQ' },
    { symbol: 'META', name: 'Meta Platforms', t212: 'META_US_EQ' },
    { symbol: 'GOOGL', name: 'Alphabet Inc.', t212: 'GOOGL_US_EQ' },
    { symbol: 'AMD', name: 'AMD', t212: 'AMD_US_EQ' },
    { symbol: 'TSLA', name: 'Tesla Inc.', t212: 'TSLA_US_EQ' },
    { symbol: 'INTC', name: 'Intel Corp.', t212: 'INTC_US_EQ' },
  ],
  Healthcare: [
    { symbol: 'JNJ', name: 'Johnson & Johnson', t212: 'JNJ_US_EQ' },
    { symbol: 'PFE', name: 'Pfizer Inc.', t212: 'PFE_US_EQ' },
    { symbol: 'UNH', name: 'UnitedHealth Group', t212: 'UNH_US_EQ' },
    { symbol: 'ABBV', name: 'AbbVie Inc.', t212: 'ABBV_US_EQ' },
    { symbol: 'LLY', name: 'Eli Lilly', t212: 'LLY_US_EQ' },
    { symbol: 'MRK', name: 'Merck & Co.', t212: 'MRK_US_EQ' },
  ],
  Energy: [
    { symbol: 'XOM', name: 'ExxonMobil Corp.', t212: 'XOM_US_EQ' },
    { symbol: 'CVX', name: 'Chevron Corp.', t212: 'CVX_US_EQ' },
    { symbol: 'COP', name: 'ConocoPhillips', t212: 'COP_US_EQ' },
    { symbol: 'SLB', name: 'SLB', t212: 'SLB_US_EQ' },
    { symbol: 'EOG', name: 'EOG Resources', t212: 'EOG_US_EQ' },
  ],
  Finance: [
    { symbol: 'JPM', name: 'JPMorgan Chase', t212: 'JPM_US_EQ' },
    { symbol: 'BAC', name: 'Bank of America', t212: 'BAC_US_EQ' },
    { symbol: 'V', name: 'Visa Inc.', t212: 'V_US_EQ' },
    { symbol: 'MA', name: 'Mastercard', t212: 'MA_US_EQ' },
    { symbol: 'GS', name: 'Goldman Sachs', t212: 'GS_US_EQ' },
    { symbol: 'MS', name: 'Morgan Stanley', t212: 'MS_US_EQ' },
  ],
  Consumer: [
    { symbol: 'WMT', name: 'Walmart Inc.', t212: 'WMT_US_EQ' },
    { symbol: 'COST', name: 'Costco Wholesale', t212: 'COST_US_EQ' },
    { symbol: 'MCD', name: "McDonald's Corp.", t212: 'MCD_US_EQ' },
    { symbol: 'NKE', name: 'Nike Inc.', t212: 'NKE_US_EQ' },
    { symbol: 'KO', name: 'Coca-Cola Co.', t212: 'KO_US_EQ' },
    { symbol: 'PEP', name: 'PepsiCo Inc.', t212: 'PEP_US_EQ' },
  ],
};

const BULLISH = ['beat', 'beats', 'surge', 'soar', 'gain', 'rise', 'record', 'upgrade', 'strong', 'growth', 'profit', 'boost', 'bullish', 'buy', 'positive', 'higher'];
const BEARISH = ['miss', 'fall', 'drop', 'decline', 'plunge', 'loss', 'cut', 'downgrade', 'weak', 'concern', 'risk', 'warning', 'sell', 'bearish', 'lower', 'below'];

function sentimentScore(headlines: string[]): number {
  let bull = 0, bear = 0;
  for (const h of headlines) {
    const lower = h.toLowerCase();
    bull += BULLISH.filter(w => lower.includes(w)).length;
    bear += BEARISH.filter(w => lower.includes(w)).length;
  }
  const total = bull + bear;
  if (total === 0) return 0;
  return (bull - bear) / total; // -1 to +1
}

export async function POST(request: NextRequest) {
  const { sectors } = await request.json() as { sectors: string[] };
  const apiKey = process.env.FINNHUB_API_KEY;

  if (!apiKey) {
    return NextResponse.json({ error: 'FINNHUB_API_KEY is not configured. Add it to your .env.local file. Get a free key at finnhub.io.' }, { status: 503 });
  }

  // Build the universe for requested sectors
  const universe = sectors.includes('All')
    ? Object.values(SECTOR_STOCKS).flat()
    : sectors.flatMap(s => SECTOR_STOCKS[s] ?? []);

  if (universe.length === 0) {
    return NextResponse.json({ error: 'No stocks found for selected sectors.' }, { status: 400 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  // Fetch quotes + news for all universe stocks in parallel (batched to avoid rate limits)
  const results: { symbol: string; name: string; t212: string; sector: string; score: number; price: number; changePercent: number; reason: string }[] = [];

  // Process in batches of 5 to stay within Finnhub free tier (60 req/min)
  const sectorOf = (symbol: string) => {
    for (const [sector, stocks] of Object.entries(SECTOR_STOCKS)) {
      if (stocks.some(s => s.symbol === symbol)) return sector;
    }
    return 'Unknown';
  };

  const batchSize = 5;
  for (let i = 0; i < universe.length; i += batchSize) {
    const batch = universe.slice(i, i + batchSize);
    await Promise.all(batch.map(async stock => {
      try {
        const [quoteRes, newsRes] = await Promise.all([
          fetch(`https://finnhub.io/api/v1/quote?symbol=${stock.symbol}&token=${apiKey}`, { signal: AbortSignal.timeout(5000) }),
          fetch(`https://finnhub.io/api/v1/company-news?symbol=${stock.symbol}&from=${yesterday}&to=${today}&token=${apiKey}`, { signal: AbortSignal.timeout(5000) }),
        ]);

        if (!quoteRes.ok) return;

        const quote = await quoteRes.json() as { c: number; pc: number; dp: number };
        const news = newsRes.ok ? await newsRes.json() as { headline: string }[] : [];

        const price = quote.c ?? 0;
        const changePercent = quote.dp ?? 0; // % change from previous close

        if (price <= 0) return; // Market closed / no data

        const headlines = (Array.isArray(news) ? news : []).slice(0, 10).map(n => n.headline);
        const sentiment = sentimentScore(headlines);

        // Combined score: 60% momentum, 40% sentiment
        const momentumScore = Math.max(-1, Math.min(1, changePercent / 3)); // normalise to -1..1 (3% = max)
        const score = momentumScore * 0.6 + sentiment * 0.4;

        const reason = `${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}% today · ${headlines.length} headlines · sentiment ${sentiment >= 0 ? 'positive' : 'negative'}`;

        results.push({ symbol: stock.symbol, name: stock.name, t212: stock.t212, sector: sectorOf(stock.symbol), score, price, changePercent, reason });
      } catch {
        // Skip failed stocks silently
      }
    }));
  }

  // Sort by score descending and return top signals
  results.sort((a, b) => b.score - a.score);

  const signals = results.slice(0, 10).map(r => ({
    symbol: r.symbol,
    name: r.name,
    t212Ticker: r.t212,
    sector: r.sector,
    score: Math.round(r.score * 100) / 100,
    currentPrice: r.price,
    changePercent: r.changePercent,
    signal: r.score >= 0.15 ? 'BUY' : r.score <= -0.15 ? 'SELL' : 'NEUTRAL',
    reason: r.reason,
  }));

  return NextResponse.json({ signals, scannedCount: results.length, timestamp: new Date().toISOString() });
}

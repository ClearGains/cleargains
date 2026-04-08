import { NextRequest, NextResponse } from 'next/server';

// ── Expanded stock universe: US large + mid cap + UK LSE ──────────────────────
const UNIVERSE: { symbol: string; name: string; t212: string; sector: string; isUK: boolean }[] = [
  // Technology — US
  { symbol: 'AAPL',  name: 'Apple Inc.',           t212: 'AAPL_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'MSFT',  name: 'Microsoft Corp.',       t212: 'MSFT_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'NVDA',  name: 'Nvidia Corp.',          t212: 'NVDA_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'AMD',   name: 'Advanced Micro Devices',t212: 'AMD_US_EQ',   sector: 'Technology', isUK: false },
  { symbol: 'META',  name: 'Meta Platforms',        t212: 'META_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'GOOGL', name: 'Alphabet Inc.',         t212: 'GOOGL_US_EQ', sector: 'Technology', isUK: false },
  { symbol: 'TSLA',  name: 'Tesla Inc.',            t212: 'TSLA_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'INTC',  name: 'Intel Corp.',           t212: 'INTC_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'QCOM',  name: 'Qualcomm Inc.',         t212: 'QCOM_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'AVGO',  name: 'Broadcom Inc.',         t212: 'AVGO_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'MU',    name: 'Micron Technology',     t212: 'MU_US_EQ',    sector: 'Technology', isUK: false },
  { symbol: 'AMAT',  name: 'Applied Materials',     t212: 'AMAT_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'PLTR',  name: 'Palantir Technologies', t212: 'PLTR_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'SNOW',  name: 'Snowflake Inc.',        t212: 'SNOW_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'CRM',   name: 'Salesforce Inc.',       t212: 'CRM_US_EQ',   sector: 'Technology', isUK: false },
  { symbol: 'ORCL',  name: 'Oracle Corp.',          t212: 'ORCL_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'ADBE',  name: 'Adobe Inc.',            t212: 'ADBE_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'UBER',  name: 'Uber Technologies',     t212: 'UBER_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'COIN',  name: 'Coinbase Global',       t212: 'COIN_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'RBLX',  name: 'Roblox Corp.',          t212: 'RBLX_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'SHOP',  name: 'Shopify Inc.',          t212: 'SHOP_US_EQ',  sector: 'Technology', isUK: false },
  // Healthcare — US
  { symbol: 'LLY',   name: 'Eli Lilly',            t212: 'LLY_US_EQ',   sector: 'Healthcare', isUK: false },
  { symbol: 'UNH',   name: 'UnitedHealth Group',   t212: 'UNH_US_EQ',   sector: 'Healthcare', isUK: false },
  { symbol: 'ABBV',  name: 'AbbVie Inc.',           t212: 'ABBV_US_EQ',  sector: 'Healthcare', isUK: false },
  { symbol: 'MRK',   name: 'Merck & Co.',          t212: 'MRK_US_EQ',   sector: 'Healthcare', isUK: false },
  { symbol: 'PFE',   name: 'Pfizer Inc.',           t212: 'PFE_US_EQ',   sector: 'Healthcare', isUK: false },
  { symbol: 'AMGN',  name: 'Amgen Inc.',            t212: 'AMGN_US_EQ',  sector: 'Healthcare', isUK: false },
  { symbol: 'GILD',  name: 'Gilead Sciences',       t212: 'GILD_US_EQ',  sector: 'Healthcare', isUK: false },
  { symbol: 'REGN',  name: 'Regeneron Pharma',     t212: 'REGN_US_EQ',  sector: 'Healthcare', isUK: false },
  { symbol: 'VRTX',  name: 'Vertex Pharmaceuticals',t212: 'VRTX_US_EQ', sector: 'Healthcare', isUK: false },
  { symbol: 'MRNA',  name: 'Moderna Inc.',          t212: 'MRNA_US_EQ',  sector: 'Healthcare', isUK: false },
  { symbol: 'BIIB',  name: 'Biogen Inc.',           t212: 'BIIB_US_EQ',  sector: 'Healthcare', isUK: false },
  // Energy — US
  { symbol: 'XOM',   name: 'ExxonMobil Corp.',     t212: 'XOM_US_EQ',   sector: 'Energy', isUK: false },
  { symbol: 'CVX',   name: 'Chevron Corp.',        t212: 'CVX_US_EQ',   sector: 'Energy', isUK: false },
  { symbol: 'COP',   name: 'ConocoPhillips',       t212: 'COP_US_EQ',   sector: 'Energy', isUK: false },
  { symbol: 'SLB',   name: 'SLB',                  t212: 'SLB_US_EQ',   sector: 'Energy', isUK: false },
  { symbol: 'OXY',   name: 'Occidental Petroleum', t212: 'OXY_US_EQ',   sector: 'Energy', isUK: false },
  { symbol: 'VLO',   name: 'Valero Energy',        t212: 'VLO_US_EQ',   sector: 'Energy', isUK: false },
  { symbol: 'EOG',   name: 'EOG Resources',        t212: 'EOG_US_EQ',   sector: 'Energy', isUK: false },
  { symbol: 'MPC',   name: 'Marathon Petroleum',   t212: 'MPC_US_EQ',   sector: 'Energy', isUK: false },
  // Finance — US
  { symbol: 'JPM',   name: 'JPMorgan Chase',       t212: 'JPM_US_EQ',   sector: 'Finance', isUK: false },
  { symbol: 'BAC',   name: 'Bank of America',      t212: 'BAC_US_EQ',   sector: 'Finance', isUK: false },
  { symbol: 'V',     name: 'Visa Inc.',            t212: 'V_US_EQ',     sector: 'Finance', isUK: false },
  { symbol: 'MA',    name: 'Mastercard',           t212: 'MA_US_EQ',    sector: 'Finance', isUK: false },
  { symbol: 'GS',    name: 'Goldman Sachs',        t212: 'GS_US_EQ',    sector: 'Finance', isUK: false },
  { symbol: 'MS',    name: 'Morgan Stanley',       t212: 'MS_US_EQ',    sector: 'Finance', isUK: false },
  { symbol: 'WFC',   name: 'Wells Fargo',          t212: 'WFC_US_EQ',   sector: 'Finance', isUK: false },
  { symbol: 'AXP',   name: 'American Express',     t212: 'AXP_US_EQ',   sector: 'Finance', isUK: false },
  { symbol: 'PYPL',  name: 'PayPal Holdings',      t212: 'PYPL_US_EQ',  sector: 'Finance', isUK: false },
  { symbol: 'HOOD',  name: 'Robinhood Markets',    t212: 'HOOD_US_EQ',  sector: 'Finance', isUK: false },
  // Consumer — US
  { symbol: 'WMT',   name: 'Walmart Inc.',         t212: 'WMT_US_EQ',   sector: 'Consumer', isUK: false },
  { symbol: 'COST',  name: 'Costco Wholesale',     t212: 'COST_US_EQ',  sector: 'Consumer', isUK: false },
  { symbol: 'MCD',   name: "McDonald's Corp.",     t212: 'MCD_US_EQ',   sector: 'Consumer', isUK: false },
  { symbol: 'NKE',   name: 'Nike Inc.',            t212: 'NKE_US_EQ',   sector: 'Consumer', isUK: false },
  { symbol: 'KO',    name: 'Coca-Cola Co.',        t212: 'KO_US_EQ',    sector: 'Consumer', isUK: false },
  { symbol: 'PEP',   name: 'PepsiCo Inc.',         t212: 'PEP_US_EQ',   sector: 'Consumer', isUK: false },
  { symbol: 'AMZN',  name: 'Amazon.com Inc.',      t212: 'AMZN_US_EQ',  sector: 'Consumer', isUK: false },
  { symbol: 'HD',    name: 'Home Depot Inc.',      t212: 'HD_US_EQ',    sector: 'Consumer', isUK: false },
  { symbol: 'TGT',   name: 'Target Corp.',         t212: 'TGT_US_EQ',   sector: 'Consumer', isUK: false },
  { symbol: 'SBUX',  name: 'Starbucks Corp.',      t212: 'SBUX_US_EQ',  sector: 'Consumer', isUK: false },
  // UK — LSE
  { symbol: 'VOD.L',  name: 'Vodafone Group',       t212: 'VOD_UK_EQ',   sector: 'Telecom',  isUK: true },
  { symbol: 'BARC.L', name: 'Barclays PLC',         t212: 'BARC_UK_EQ',  sector: 'Finance',  isUK: true },
  { symbol: 'LLOY.L', name: 'Lloyds Banking Group', t212: 'LLOY_UK_EQ',  sector: 'Finance',  isUK: true },
  { symbol: 'BP.L',   name: 'BP PLC',               t212: 'BP_UK_EQ',    sector: 'Energy',   isUK: true },
  { symbol: 'SHEL.L', name: 'Shell PLC',            t212: 'SHEL_UK_EQ',  sector: 'Energy',   isUK: true },
  { symbol: 'AZN.L',  name: 'AstraZeneca PLC',      t212: 'AZN_UK_EQ',   sector: 'Healthcare',isUK: true },
  { symbol: 'GSK.L',  name: 'GSK PLC',              t212: 'GSK_UK_EQ',   sector: 'Healthcare',isUK: true },
  { symbol: 'RIO.L',  name: 'Rio Tinto PLC',        t212: 'RIO_UK_EQ',   sector: 'Materials', isUK: true },
  { symbol: 'HSBA.L', name: 'HSBC Holdings',        t212: 'HSBA_UK_EQ',  sector: 'Finance',  isUK: true },
  { symbol: 'DGE.L',  name: 'Diageo PLC',           t212: 'DGE_UK_EQ',   sector: 'Consumer', isUK: true },
  { symbol: 'ULVR.L', name: 'Unilever PLC',         t212: 'ULVR_UK_EQ',  sector: 'Consumer', isUK: true },
  { symbol: 'RR.L',   name: 'Rolls-Royce Holdings', t212: 'RR_UK_EQ',    sector: 'Industrials',isUK: true },
  { symbol: 'IAG.L',  name: 'IAG (BA/Iberia)',      t212: 'IAG_UK_EQ',   sector: 'Transport', isUK: true },
  { symbol: 'NWG.L',  name: 'NatWest Group',        t212: 'NWG_UK_EQ',   sector: 'Finance',  isUK: true },
  { symbol: 'STAN.L', name: 'Standard Chartered',   t212: 'STAN_UK_EQ',  sector: 'Finance',  isUK: true },
];

// Sentiment word lists
const BULLISH = ['beats','beat','surges','surge','soars','soar','rises','rise','gains','gain',
  'rallies','rally','record','upgrade','upgraded','outperform','strong','growth','profit','profits',
  'boost','boosted','raises','raised','exceeds','jumps','jump','climbs','positive','higher','bullish',
  'buy','overweight','breakthrough','approval','deal','wins'];
const BEARISH = ['misses','miss','falls','fall','drops','drop','declines','decline','plunges','plunge',
  'slumps','slump','loss','losses','cuts','cut','downgrade','downgraded','underperform','weak',
  'concern','concerns','risk','risks','warning','warns','layoffs','disappoints','sell','bearish',
  'negative','lower','down','below','lawsuit','probe','recall','miss'];

function sentimentScore(headlines: string[]): number {
  let bull = 0, bear = 0;
  for (const h of headlines) {
    const l = h.toLowerCase();
    bull += BULLISH.filter(w => l.includes(w)).length;
    bear += BEARISH.filter(w => l.includes(w)).length;
  }
  const total = bull + bear;
  if (total === 0) return 0;
  return (bull - bear) / total;
}

export async function POST(request: NextRequest) {
  const { sectors } = await request.json() as { sectors: string[] };
  const apiKey = process.env.FINNHUB_API_KEY;

  if (!apiKey) {
    return NextResponse.json({
      error: 'FINNHUB_API_KEY is not configured. Add it to your .env.local file. Get a free key at finnhub.io.',
    }, { status: 503 });
  }

  // Filter universe by selected sectors
  const universe = sectors.includes('All')
    ? UNIVERSE
    : UNIVERSE.filter(s => sectors.includes(s.sector));

  if (universe.length === 0) {
    return NextResponse.json({ error: 'No stocks found for selected sectors.' }, { status: 400 });
  }

  const today     = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const sixHoursAgo = Math.floor((Date.now() - 6 * 3_600_000) / 1000);

  // ── PHASE 1: Fetch quotes for the whole universe ───────────────────────────
  type QuoteResult = {
    symbol: string; name: string; t212: string; sector: string; isUK: boolean;
    price: number; changePercent: number; open: number; high: number; low: number;
    volume: number; prevClose: number;
  };

  const quotes: QuoteResult[] = [];
  let apiCalls = 0;

  const batchSize = 8;
  for (let i = 0; i < universe.length; i += batchSize) {
    const batch = universe.slice(i, i + batchSize);
    await Promise.all(batch.map(async stock => {
      try {
        const res = await fetch(
          `https://finnhub.io/api/v1/quote?symbol=${stock.symbol}&token=${apiKey}`,
          { signal: AbortSignal.timeout(5_000) }
        );
        apiCalls++;
        if (!res.ok) return;
        const q = await res.json() as { c: number; dp: number; o: number; h: number; l: number; v: number; pc: number };
        if (!q.c || q.c <= 0) return;
        quotes.push({
          symbol: stock.symbol, name: stock.name, t212: stock.t212,
          sector: stock.sector, isUK: stock.isUK,
          price: q.c, changePercent: q.dp ?? 0,
          open: q.o ?? q.c, high: q.h ?? q.c, low: q.l ?? q.c,
          volume: q.v ?? 0, prevClose: q.pc ?? q.c,
        });
      } catch { /* skip */ }
    }));
  }

  if (quotes.length === 0) {
    return NextResponse.json({ error: 'Could not fetch any quotes. Check FINNHUB_API_KEY.' }, { status: 503 });
  }

  // Compute universe median volume for relative comparison
  const volumes = quotes.map(q => q.volume).filter(v => v > 0).sort((a, b) => a - b);
  const medianVolume = volumes[Math.floor(volumes.length / 2)] || 1;

  // ── PHASE 2: Filter momentum candidates & fetch news ─────────────────────
  // Qualify: moved at least 1.5% OR volume surge 2x median
  const candidates = quotes.filter(q =>
    Math.abs(q.changePercent) >= 1.5 || q.volume >= medianVolume * 2
  );

  // Fallback: if nothing qualifies (quiet day), take top 15 movers anyway
  const phase2Stocks = candidates.length >= 5
    ? candidates
    : [...quotes].sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent)).slice(0, 15);

  type ScoredResult = QuoteResult & {
    newsCount: number; recentNewsCount: number; sentimentRaw: number;
    momentumScore: number; volumeScore: number; newsScore: number; volatilityScore: number;
    profitScore: number; signal: 'BUY' | 'SELL' | 'NEUTRAL'; badges: string[]; reason: string;
  };

  const results: ScoredResult[] = [];

  await Promise.all(phase2Stocks.map(async stock => {
    try {
      const newsRes = await fetch(
        `https://finnhub.io/api/v1/company-news?symbol=${stock.symbol}&from=${yesterday}&to=${today}&token=${apiKey}`,
        { signal: AbortSignal.timeout(5_000) }
      );
      apiCalls++;

      const allNews = newsRes.ok
        ? (await newsRes.json() as Array<{ headline: string; datetime: number }>)
        : [];

      const newsCount = allNews.length;
      const recentNewsCount = allNews.filter(n => n.datetime >= sixHoursAgo).length;
      const headlines = allNews.slice(0, 10).map(n => n.headline);
      const sentimentRaw = sentimentScore(headlines);

      // ── Scoring ─────────────────────────────────────────────────────────
      // Momentum (0-35): bigger % move = better. Cap at 5%.
      const momentumScore = Math.min(35, Math.abs(stock.changePercent) * 7);

      // Volume surge (0-25): relative to universe median
      const volRatio = stock.volume > 0 && medianVolume > 0 ? stock.volume / medianVolume : 1;
      const volumeScore = Math.min(25, (volRatio - 1) * 12.5); // 3x median = 25pts

      // News catalyst (0-30): recent news weighted more
      const newsScore = Math.min(30, recentNewsCount * 12 + Math.min(newsCount, 5) * 2);

      // Intraday volatility (0-10): (high-low) / price
      const intradayRange = stock.high > 0 && stock.low > 0
        ? ((stock.high - stock.low) / stock.price) * 100
        : 0;
      const volatilityScore = Math.min(10, intradayRange * 2);

      const rawTotal = momentumScore + Math.max(0, volumeScore) + newsScore + volatilityScore;
      const profitScore = Math.round(Math.min(100, rawTotal));

      // ── Signal logic ─────────────────────────────────────────────────────
      const alreadyMoved = Math.abs(stock.changePercent) > 5;
      const hasNewsCatalyst = recentNewsCount >= 1 || newsCount >= 2;
      const hasVolumeConviction = volRatio >= 1.2;

      let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';

      if (!alreadyMoved && hasNewsCatalyst && hasVolumeConviction) {
        if (stock.changePercent >= 1.0 && sentimentRaw >= 0) {
          signal = 'BUY';
        } else if (stock.changePercent <= -1.0 && sentimentRaw <= 0) {
          signal = 'SELL';
        }
      } else if (!alreadyMoved && hasVolumeConviction && !hasNewsCatalyst) {
        // Strong momentum with volume but no news — lower conviction
        if (stock.changePercent >= 2.0) signal = 'BUY';
        else if (stock.changePercent <= -2.0) signal = 'SELL';
      }

      // ── Badges ───────────────────────────────────────────────────────────
      const badges: string[] = [];
      if (Math.abs(stock.changePercent) >= 1.0) {
        badges.push(`📈 ${stock.changePercent >= 0 ? '+' : ''}${stock.changePercent.toFixed(1)}%`);
      }
      if (recentNewsCount > 0) {
        badges.push(`📰 ${recentNewsCount} article${recentNewsCount !== 1 ? 's' : ''}`);
      } else if (newsCount > 0) {
        badges.push(`📰 ${newsCount} news`);
      }
      if (volRatio >= 1.5) {
        badges.push(`🔊 ${volRatio.toFixed(1)}× vol`);
      }
      if (intradayRange >= 2.5) {
        badges.push('⚡ Volatile');
      }
      if (alreadyMoved) {
        badges.push('⚠️ Momentum may be exhausted');
      }

      const sentimentLabel = sentimentRaw >= 0.1 ? 'positive' : sentimentRaw <= -0.1 ? 'negative' : 'neutral';
      const reason = [
        `${stock.changePercent >= 0 ? '+' : ''}${stock.changePercent.toFixed(2)}% today`,
        newsCount > 0 ? `${newsCount} headlines (${sentimentLabel} sentiment)` : 'no news found',
        volRatio >= 1.5 ? `${volRatio.toFixed(1)}× volume surge` : 'normal volume',
      ].join(' · ');

      results.push({
        ...stock,
        newsCount, recentNewsCount, sentimentRaw,
        momentumScore, volumeScore: Math.max(0, volumeScore), newsScore, volatilityScore,
        profitScore, signal, badges, reason,
      });
    } catch { /* skip */ }
  }));

  // Sort by profit score descending
  results.sort((a, b) => b.profitScore - a.profitScore);

  const signals = results.slice(0, 12).map(r => ({
    symbol: r.symbol,
    name: r.name,
    t212Ticker: r.t212,
    sector: r.sector,
    isUK: r.isUK,
    score: r.profitScore,
    currentPrice: r.price,
    changePercent: r.changePercent,
    volume: r.volume,
    volRatio: Math.round((r.volume / medianVolume) * 10) / 10,
    newsCount: r.newsCount,
    recentNewsCount: r.recentNewsCount,
    signal: r.signal,
    badges: r.badges,
    reason: r.reason,
  }));

  return NextResponse.json({
    signals,
    scannedCount: quotes.length,
    candidateCount: phase2Stocks.length,
    apiCallsUsed: apiCalls,
    timestamp: new Date().toISOString(),
    note: 'Selected based on momentum, volume surge, and news catalysts — not company size',
  });
}

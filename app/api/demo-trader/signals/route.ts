import { NextRequest, NextResponse } from 'next/server';
import { UNIVERSE, ADR_MAP as ADR_MAP_SIGNALS } from '@/lib/stockUniverse';

// ── UK quote helper (US ADR only — see ADR_MAP's own comment) ─────────────────
// Imported inline to avoid HTTP round-trips between internal API routes.
//
// Used to try Yahoo's LSE (pence-priced) quote first and fall back to the
// ADR. Removed 2026-08-31: every UK stock in UNIVERSE trades on T212 via its
// US ADR (T212 doesn't offer the native LSE listing for any of them at all —
// see lib/stockUniverse.ts's own comment), so this route's own `currentPrice`
// output feeds straight into calcQuantity(positionSize, price) in
// app/demo-trader/page.tsx with no currency conversion at all. Returning the
// LSE pence price there — a completely different number, for a differently
// share-ratio'd instrument than the ADR that actually executes — would size
// (and display) every UK trade off the wrong number, not a rounding
// difference. The ADR quote is the only one that matches what's really
// bought, so it's the only one this returns now.
type QuoteSource = 'finnhub' | 'adr';

async function fetchUKQuote(ticker: string, apiKey: string): Promise<{
  price: number; changePercent: number; open: number; high: number; low: number;
  volume: number; prevClose: number; source: QuoteSource; displayTicker: string; badge: string;
} | null> {
  const adr = ADR_MAP_SIGNALS[ticker];
  if (!adr || !apiKey) return null;
  try {
    const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${adr}&token=${apiKey}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      const q = await res.json() as { c: number; dp: number; o: number; h: number; l: number; v: number; pc: number };
      if (q.c > 0) {
        return {
          price: q.c, changePercent: q.dp ?? 0, open: q.o ?? q.c, high: q.h ?? q.c,
          low: q.l ?? q.c, volume: q.v ?? 0, prevClose: q.pc ?? q.c,
          source: 'adr', displayTicker: adr, badge: `🇺🇸 ADR · USD (${adr})`,
        };
      }
    }
  } catch { /* give up */ }
  return null;
}

// Reliable fallback symbols guaranteed to be in UNIVERSE (used when few qualify)
// UK .L stocks excluded — ADR equivalents (VOD, BP) included instead
const FALLBACK_SYMBOLS = ['AAPL', 'MSFT', 'TSLA', 'NVDA', 'AMZN', 'META', 'GOOGL', 'JPM', 'BAC', 'XOM', 'CVX', 'PFE'];

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

// ── Smart-Money Swing strategy rationale builder ─────────────────────────────
function buildSmartMoneyRationale(
  symbol: string,
  changePercent: number,
  volRatio: number,
  newsCount: number,
  recentNewsCount: number,
  sentimentRaw: number,
  profitScore: number,
): string {
  const parts: string[] = [];

  // Momentum leg
  const momTag = changePercent >= 2
    ? `Strong +${changePercent.toFixed(1)}% momentum`
    : changePercent >= 0.5
    ? `Positive +${changePercent.toFixed(1)}% trend`
    : `Consolidation near flat (${changePercent.toFixed(1)}%)`;
  parts.push(momTag);

  // Volume leg
  if (volRatio >= 3)
    parts.push(`Heavy vol surge ${volRatio.toFixed(1)}× avg — institutional accumulation`);
  else if (volRatio >= 1.5)
    parts.push(`Elevated vol ${volRatio.toFixed(1)}× avg — smart money interest`);
  else
    parts.push('Normal volume');

  // Catalyst leg
  if (recentNewsCount >= 2)
    parts.push(`${recentNewsCount} catalysts in last 6 h — ${sentimentRaw >= 0.1 ? 'bullish' : 'mixed'} sentiment`);
  else if (newsCount > 0)
    parts.push(`${newsCount} news article${newsCount > 1 ? 's' : ''} — ${sentimentRaw >= 0.1 ? 'positive' : sentimentRaw <= -0.1 ? 'cautious' : 'neutral'} tone`);
  else
    parts.push('Technicals-only signal — no news catalyst');

  // Risk leg
  parts.push('R:R 2:1 — SL −1.5 % · TP +3.0 %');

  return parts.join(' · ');
}

export async function POST(request: NextRequest) {
  const body = await request.json() as { sectors: string[]; strategy?: string };
  const { sectors, strategy } = body;
  const isSmartMoney = strategy === 'smart-money';
  const apiKey = process.env.FINNHUB_API_KEY;
  const debugLog: string[] = [];

  if (!apiKey) {
    return NextResponse.json({
      error: 'FINNHUB_API_KEY is not configured. Add it to your .env.local file. Get a free key at finnhub.io.',
      debugLog: ['❌ FINNHUB_API_KEY missing from environment'],
    }, { status: 503 });
  }

  // Filter universe by selected sectors
  const filteredUniverse = sectors.includes('All')
    ? UNIVERSE
    : UNIVERSE.filter(s => sectors.includes(s.sector));

  // Cap at 60 stocks per run to stay within Finnhub's 60 calls/minute limit.
  // A flat slice(0, 60) always covers the same first 60 in declaration
  // order — with the universe now past 60 (grew to 93 after the 2026-08-19
  // sector expansion), that meant Consumer, the new Industrials/
  // Communication/Utilities sectors, and every UK stock would never be
  // scanned at all under "All", regardless of being in UNIVERSE. Auto-scan
  // runs this every 5min, so instead rotate the 60-wide window each run —
  // over a couple of cycles the full list gets covered rather than the
  // same slice forever. Bucket width matches the frontend's own 300_000ms
  // auto-scan interval (app/demo-trader/page.tsx).
  const MAX_STOCKS = 60;
  const capped = filteredUniverse.length > MAX_STOCKS;
  // How many consecutive rotating windows it takes to cover the full
  // filtered universe once (e.g. 93 names / 60 per window = 2). The caller
  // (app/demo-trader/page.tsx) uses windowIndexInCycle to know whether this
  // response completes a full pass — it accumulates signals across windows
  // and only actually selects/trades once every window in the cycle has
  // been seen, rather than trading off whichever partial slice happened to
  // be scanned this run.
  const windowsPerCycle = capped ? Math.ceil(filteredUniverse.length / MAX_STOCKS) : 1;
  const bucket = Math.floor(Date.now() / 300_000);
  let universe = filteredUniverse;
  if (capped) {
    const offset = (bucket * MAX_STOCKS) % filteredUniverse.length;
    universe = [...filteredUniverse.slice(offset), ...filteredUniverse.slice(0, offset)].slice(0, MAX_STOCKS);
  }
  const windowIndexInCycle = bucket % windowsPerCycle;
  const cappedNote = capped
    ? ` (window ${windowIndexInCycle + 1}/${windowsPerCycle} — ${MAX_STOCKS} of ${filteredUniverse.length}, rotating)`
    : '';

  debugLog.push(`📋 Universe: ${universe.length} stocks for sectors: ${sectors.join(', ')}${cappedNote}`);

  if (universe.length === 0) {
    return NextResponse.json({ error: 'No stocks found for selected sectors.', debugLog }, { status: 400 });
  }

  const today     = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const sixHoursAgo = Math.floor((Date.now() - 6 * 3_600_000) / 1000);

  // ── PHASE 1: Fetch quotes — sequential with 100ms delay to avoid 429 ────────
  // UK stocks (.L suffix): Yahoo Finance first, ADR fallback via Finnhub.
  // US stocks: Finnhub only.
  // On 429: skip the stock (counted in skipped total, shown as summary not per-stock).
  type QuoteResult = {
    symbol: string; name: string; t212: string; sector: string; isUK: boolean;
    price: number; changePercent: number; open: number; high: number; low: number;
    volume: number; prevClose: number; badge?: string;
  };

  const quotes: QuoteResult[] = [];
  let skipped = 0;
  let rateLimited = 0;
  let apiCalls = 0;
  const ukSourceLog: string[] = [];

  debugLog.push(`🔍 Phase 1: Fetching quotes for ${universe.length} stocks (100ms delay, UK via Yahoo Finance)…`);

  for (const stock of universe) {
    // 100ms gap between every call to stay within Finnhub rate limits
    await new Promise<void>(r => setTimeout(r, 100));

    try {
      if (stock.isUK) {
        // UK stock → always its US ADR (see fetchUKQuote's own comment)
        const ukQuote = await fetchUKQuote(stock.symbol, apiKey);
        if (!ukQuote) { skipped++; continue; }
        quotes.push({
          symbol: stock.symbol, name: stock.name, t212: stock.t212,
          sector: stock.sector, isUK: true,
          price: ukQuote.price, changePercent: ukQuote.changePercent,
          open: ukQuote.open, high: ukQuote.high, low: ukQuote.low,
          volume: ukQuote.volume, prevClose: ukQuote.prevClose,
          badge: ukQuote.badge,
        });
        ukSourceLog.push(`${stock.symbol}: 🇺🇸 ADR (${ukQuote.displayTicker})`);
      } else {
        // US stock → Finnhub
        const res = await fetch(
          `https://finnhub.io/api/v1/quote?symbol=${stock.symbol}&token=${apiKey}`,
          { signal: AbortSignal.timeout(5_000) }
        );
        apiCalls++;

        if (res.status === 429) {
          // Rate limited — wait 1 second, skip this stock (do not retry in this scan)
          await new Promise<void>(r => setTimeout(r, 1_000));
          rateLimited++;
          skipped++;
          continue;
        }
        if (!res.ok) { skipped++; continue; }

        const q = await res.json() as { c: number; dp: number; o: number; h: number; l: number; v: number; pc: number };
        if (!q.c || q.c <= 0) { skipped++; continue; }

        quotes.push({
          symbol: stock.symbol, name: stock.name, t212: stock.t212,
          sector: stock.sector, isUK: false,
          price: q.c, changePercent: q.dp ?? 0,
          open: q.o ?? q.c, high: q.h ?? q.c, low: q.l ?? q.c,
          volume: q.v ?? 0, prevClose: q.pc ?? q.c,
        });
      }
    } catch {
      skipped++;
    }
  }

  // Clean summary (no per-stock error noise)
  debugLog.push(`✅ Phase 1 complete: ${quotes.length}/${universe.length} quotes received${skipped > 0 ? ` (${skipped} skipped${rateLimited > 0 ? ` — ${rateLimited} rate-limited` : ' — free tier limitations'})` : ''}`);
  if (ukSourceLog.length > 0) {
    debugLog.push(`🇬🇧 UK stocks: ${ukSourceLog.join(', ')}`);
  }
  if (rateLimited > 0) {
    debugLog.push(`⚠️ Rate limited — ${rateLimited} stocks skipped, will retry next scan`);
  }

  if (quotes.length === 0) {
    debugLog.push('❌ Zero valid quotes — market may be closed or API key invalid');
    return NextResponse.json({
      error: 'Could not fetch any quotes. Check FINNHUB_API_KEY and ensure markets are open.',
      debugLog,
    }, { status: 503 });
  }

  // Log a sample of quote data for debugging
  const sampleQuotes = quotes.slice(0, 5).map(q => `${q.symbol}: $${q.price.toFixed(2)} (${q.changePercent >= 0 ? '+' : ''}${q.changePercent.toFixed(2)}%)`);
  debugLog.push(`📊 Sample quotes: ${sampleQuotes.join(', ')}`);

  // Compute universe median volume for relative comparison
  const volumes = quotes.map(q => q.volume).filter(v => v > 0).sort((a, b) => a - b);
  const medianVolume = volumes[Math.floor(volumes.length / 2)] || 1;
  debugLog.push(`📈 Median volume: ${medianVolume.toLocaleString()}`);

  // ── PHASE 2: Filter momentum candidates & fetch news ─────────────────────
  // Qualify: moved at least 0.5% (lowered from 1.5%) OR volume surge 2x median
  const candidates = quotes.filter(q =>
    Math.abs(q.changePercent) >= 0.5 || q.volume >= medianVolume * 2
  );

  // Fallback: if nothing qualifies (flat day), take top 15 movers anyway
  const phase2Stocks = candidates.length >= 5
    ? candidates
    : [...quotes].sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent)).slice(0, 15);

  debugLog.push(`🎯 Phase 2: ${candidates.length} momentum candidates (≥0.5% move or 2× volume) → scanning ${phase2Stocks.length} stocks for news`);

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
      const volRatio = stock.volume > 0 && medianVolume > 0 ? stock.volume / medianVolume : 1;

      // Smart-Money weights: volume matters more (40 pts), news critical (35 pts)
      // Standard weights: momentum (35), volume (25), news (30), volatility (10)
      let momentumScore: number, volumeScore: number, newsScore: number, volatilityScore: number;

      const intradayRange = stock.high > 0 && stock.low > 0
        ? ((stock.high - stock.low) / stock.price) * 100
        : 0;

      if (isSmartMoney) {
        // Momentum (0-25): sweet spot 0.5-5% — parabolic moves lose points
        const absMov = Math.abs(stock.changePercent);
        momentumScore = absMov < 0.5 ? 0
          : absMov > 5 ? Math.max(0, 25 - (absMov - 5) * 4)   // penalise parabolic
          : Math.min(25, absMov * 5);
        // Volume (0-40): key filter — 3× median = full marks
        volumeScore = Math.min(40, (volRatio - 1) * 16);
        // Catalyst (0-35): recent news heavily rewarded
        newsScore = Math.min(35, recentNewsCount * 15 + Math.min(newsCount, 3) * 2);
        // Volatility (0-0): ignored for smart-money (we want controlled moves)
        volatilityScore = 0;
      } else {
        momentumScore  = Math.min(35, Math.abs(stock.changePercent) * 7);
        volumeScore    = Math.min(25, (volRatio - 1) * 12.5);
        newsScore      = Math.min(30, recentNewsCount * 12 + Math.min(newsCount, 5) * 2);
        volatilityScore = Math.min(10, intradayRange * 2);
      }

      const rawTotal = momentumScore + Math.max(0, volumeScore) + newsScore + volatilityScore;
      const profitScore = Math.round(Math.min(100, rawTotal));

      // ── Signal logic ──────────────────────────────────────────────────────
      let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';

      if (isSmartMoney) {
        // Smart-Money: require vol surge + catalyst + positive/flat move
        const volOk     = volRatio >= 1.3;
        const hasNews   = newsCount > 0;
        const movOk     = stock.changePercent >= 0.3 && stock.changePercent <= 6;
        const sentOk    = sentimentRaw > -0.4;
        const rangeOk   = intradayRange < 5; // not already a volatile blow-off

        if (volOk && hasNews && movOk && sentOk && rangeOk) {
          signal = 'BUY';
        } else if (stock.changePercent <= -1 && sentimentRaw <= -0.3 && volRatio >= 1.3) {
          signal = 'SELL';
        }
      } else {
        if (stock.changePercent >= 0.5) {
          signal = sentimentRaw <= -0.5 ? 'NEUTRAL' : 'BUY';
        } else if (stock.changePercent <= -0.5) {
          signal = sentimentRaw >= 0.5 ? 'NEUTRAL' : 'SELL';
        }
      }

      // ── Badges ───────────────────────────────────────────────────────────
      const badges: string[] = [];
      if (isSmartMoney) badges.push('🧠 Smart Money');
      if (Math.abs(stock.changePercent) >= 0.5) {
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
      if (!isSmartMoney && intradayRange >= 2.5) {
        badges.push('⚡ Volatile');
      }
      if (Math.abs(stock.changePercent) > 5) {
        badges.push('⚠️ Large move');
      }

      const sentimentLabel = sentimentRaw >= 0.1 ? 'positive' : sentimentRaw <= -0.1 ? 'negative' : 'neutral';
      const reason = isSmartMoney
        ? buildSmartMoneyRationale(stock.symbol, stock.changePercent, volRatio, newsCount, recentNewsCount, sentimentRaw, profitScore)
        : [
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

  const initialBuyCount = results.filter(r => r.signal === 'BUY').length;
  debugLog.push(`📊 After scoring: ${results.length} stocks processed — ${initialBuyCount} BUY, ${results.filter(r => r.signal === 'SELL').length} SELL, ${results.filter(r => r.signal === 'NEUTRAL').length} NEUTRAL`);

  // Log top signals for debugging
  results.slice(0, 5).forEach(r => {
    debugLog.push(`  ${r.signal === 'BUY' ? '🟢' : r.signal === 'SELL' ? '🔴' : '⚪'} ${r.symbol}: score=${r.profitScore} change=${r.changePercent.toFixed(2)}% sentiment=${r.sentimentRaw.toFixed(2)} news=${r.newsCount}`);
  });

  // ── Fallback: ensure at least 3 BUY signals ──────────────────────────────
  const buyCount = results.filter(r => r.signal === 'BUY').length;
  if (buyCount < 3) {
    const needed = 3 - buyCount;
    debugLog.push(`⚠️ Only ${buyCount} BUY signals — forcing top ${needed} positive movers to BUY`);

    // First try: non-BUY stocks with positive changePercent, sorted by score
    const positiveNonBuy = results
      .filter(r => r.signal !== 'BUY' && r.changePercent > 0)
      .slice(0, needed);

    for (const r of positiveNonBuy) {
      r.signal = 'BUY';
      debugLog.push(`  → Forced BUY: ${r.symbol} (score=${r.profitScore}, change=${r.changePercent.toFixed(2)}%)`);
    }

    // If still not enough, use top-scored regardless of direction
    const stillNeeded = 3 - results.filter(r => r.signal === 'BUY').length;
    if (stillNeeded > 0) {
      debugLog.push(`⚠️ Still ${stillNeeded} short — using top-scored stocks as BUY fallback`);
      results
        .filter(r => r.signal !== 'BUY')
        .slice(0, stillNeeded)
        .forEach(r => {
          r.signal = 'BUY';
          debugLog.push(`  → Forced BUY (top scorer): ${r.symbol} (score=${r.profitScore})`);
        });
    }

    // Last resort: fallback to hardcoded reliable stocks from quotes
    const finalBuyCount = results.filter(r => r.signal === 'BUY').length;
    if (finalBuyCount < 3) {
      debugLog.push(`⚠️ Fallback: using hardcoded reliable stocks`);
      const fallbackQuotes = quotes
        .filter(q => FALLBACK_SYMBOLS.includes(q.symbol) && !results.some(r => r.symbol === q.symbol && r.signal === 'BUY'))
        .sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))
        .slice(0, 3 - finalBuyCount);

      for (const q of fallbackQuotes) {
        const volRatio = q.volume > 0 && medianVolume > 0 ? q.volume / medianVolume : 1;
        const intradayRange = q.high > 0 && q.low > 0 ? ((q.high - q.low) / q.price) * 100 : 0;
        const momentumScore = Math.min(35, Math.abs(q.changePercent) * 7);
        const volumeScore = Math.max(0, Math.min(25, (volRatio - 1) * 12.5));
        const volatilityScore = Math.min(10, intradayRange * 2);
        const profitScore = Math.round(Math.min(100, momentumScore + volumeScore + volatilityScore + 10));

        const existing = results.find(r => r.symbol === q.symbol);
        if (existing) {
          existing.signal = 'BUY';
        } else {
          results.push({
            ...q,
            newsCount: 0, recentNewsCount: 0, sentimentRaw: 0,
            momentumScore, volumeScore, newsScore: 0, volatilityScore,
            profitScore,
            signal: 'BUY',
            badges: [`📈 ${q.changePercent >= 0 ? '+' : ''}${q.changePercent.toFixed(1)}%`, '📌 Fallback'],
            reason: `fallback signal · ${q.changePercent >= 0 ? '+' : ''}${q.changePercent.toFixed(2)}% today`,
          });
        }
        debugLog.push(`  → Fallback BUY: ${q.symbol} (change=${q.changePercent.toFixed(2)}%)`);
      }

      // Re-sort after adding fallback entries
      results.sort((a, b) => b.profitScore - a.profitScore);
    }
  }

  const finalBuyCount = results.filter(r => r.signal === 'BUY').length;
  debugLog.push(`✅ Final: ${finalBuyCount} BUY signals ready`);

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
    sourceBadge: r.badge,  // e.g. "🇬🇧 LSE · 15min delay" or "🇺🇸 ADR · USD (VOD)"
  }));

  const skippedSummary = skipped > 0
    ? `${quotes.length}/${universe.length} quotes received (${skipped} skipped — ${rateLimited > 0 ? `${rateLimited} rate-limited, ` : ''}free tier limitations)`
    : null;

  return NextResponse.json({
    signals,
    scannedCount: quotes.length,
    candidateCount: phase2Stocks.length,
    apiCallsUsed: apiCalls,
    skippedSummary,
    timestamp: new Date().toISOString(),
    capped,
    windowsPerCycle,
    windowIndexInCycle,
    note: isSmartMoney
      ? 'Smart Money Swing: vol ≥1.3× + news catalyst + 0.3–6% move. R:R 2:1 (SL −1.5%, TP +3%). Risk 1% portfolio per trade.'
      : 'Selected based on momentum, volume surge, and news catalysts — not company size. UK stocks shown as LSE (Yahoo Finance, 15min delay) or US ADR.',
    debugLog,
  });
}

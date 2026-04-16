/**
 * GET /api/finnhub/opportunities?limit=10&minMove=0.5
 *
 * Screens the entire TIER1 US stock universe for live trading opportunities.
 * No hardcoded watchlist — every scan cycle discovers what is actually moving.
 *
 * Pipeline:
 *  1. Fetch Finnhub quotes for all TIER1_SYMBOLS (US stocks ~70 symbols)
 *  2. Filter: |changePercent| > minMove% AND volume > 0
 *  3. Fetch Yahoo Finance indicators for every survivor (RSI, EMA, MACD, VWAP)
 *  4. Score each instrument 0–100 using a composite ranking formula
 *  5. Return top `limit` ranked by opportunityScore, direction must be BUY or SELL
 *
 * Cache: 4 minutes (stays fresh intraday without hammering Yahoo)
 */

import { NextRequest, NextResponse } from 'next/server';
import { FINNHUB_KEY, FINNHUB_BASE, TIER1_SYMBOLS, toIgEpic } from '@/lib/finnhubConfig';
import { fetchYahooIndicators } from '@/lib/yahooIndicators';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Opportunity {
  symbol:           string;
  igEpic:           string;
  yahooSymbol:      string;
  price:            number;
  changePercent:    number;
  volume:           number;
  rsi14:            number;
  emaCross:         'bullish' | 'bearish' | 'neutral';
  macdCross:        'bullish' | 'bearish' | 'neutral';
  macdHistogram:    number;
  volumeSurge:      number;
  vwapDeviation:    number;
  bullScore:        number;
  bearScore:        number;
  opportunityScore: number;
  direction:        'BUY' | 'SELL';
}

// ── Cache (4 min) ──────────────────────────────────────────────────────────────

const cache = new Map<string, { opps: Opportunity[]; expiresAt: number; screened: number }>();
const TTL   = 4 * 60_000;

// ── Fetch a single Finnhub quote ───────────────────────────────────────────────

async function fetchQuote(symbol: string): Promise<{ c: number; dp: number; v: number } | null> {
  if (!FINNHUB_KEY) return null;
  try {
    const r = await fetch(
      `${FINNHUB_BASE}/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!r.ok) return null;
    const d = await r.json() as { c: number; dp: number; v?: number };
    if (!d.c || d.c === 0) return null;
    return { c: d.c, dp: d.dp, v: d.v ?? 0 };
  } catch { return null; }
}

// ── Opportunity scoring ────────────────────────────────────────────────────────
// Rewards: strong directional score, RSI in tradeable zone, volume confirmation,
// EMA+MACD alignment, price momentum.

function scoreOpportunity(
  changePercent: number,
  bullScore: number,
  bearScore: number,
  rsi14: number,
  volumeSurge: number,
  emaCross: string,
  macdCross: string,
): { opportunityScore: number; direction: 'BUY' | 'SELL' | 'NEUTRAL' } {
  const dirScore = Math.max(bullScore, bearScore);
  const isBull   = bullScore >= bearScore;
  const direction: 'BUY' | 'SELL' | 'NEUTRAL' =
    dirScore >= 50 ? (isBull ? 'BUY' : 'SELL') : 'NEUTRAL';

  // RSI bonus: ideal setup zones earn extra points; extremes penalised
  const rsiBonus =
    isBull ? (rsi14 < 30 ? 20 : rsi14 < 45 ? 12 : rsi14 > 70 ? -10 : 0)
           : (rsi14 > 70 ? 20 : rsi14 > 55 ? 12 : rsi14 < 30 ? -10 : 0);

  const volBonus     = volumeSurge >= 2 ? 15 : volumeSurge >= 1.5 ? 8 : volumeSurge >= 1.2 ? 3 : 0;
  const alignBonus   = (emaCross  === (isBull ? 'bullish' : 'bearish') ? 8 : 0)
                     + (macdCross === (isBull ? 'bullish' : 'bearish') ? 8 : 0);
  const pct          = Math.abs(changePercent);
  const momBonus     = pct >= 3 ? 10 : pct >= 2 ? 7 : pct >= 1 ? 4 : pct >= 0.5 ? 2 : 0;

  return {
    opportunityScore: Math.min(100, Math.max(0, dirScore + rsiBonus + volBonus + alignBonus + momBonus)),
    direction,
  };
}

// ── Route handler ──────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const limit   = Math.min(20, parseInt(searchParams.get('limit')   ?? '10', 10));
  const minMove = parseFloat(searchParams.get('minMove') ?? '0.5');

  const cacheKey = `${limit}:${minMove}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    return NextResponse.json({ ok: true, opportunities: hit.opps, screened: hit.screened, cached: true });
  }

  // ── Step 1: Fetch Finnhub quotes for all US TIER1 symbols ────────────────
  const symbols = TIER1_SYMBOLS['US_STOCK'];
  const BATCH   = 10;
  const quoted: Array<{ symbol: string; price: number; changePercent: number; volume: number }> = [];

  for (let i = 0; i < symbols.length; i += BATCH) {
    const slice  = symbols.slice(i, i + BATCH);
    const quotes = await Promise.all(slice.map(s => fetchQuote(s)));
    for (let j = 0; j < slice.length; j++) {
      const q = quotes[j];
      if (q) quoted.push({ symbol: slice[j], price: q.c, changePercent: q.dp, volume: q.v });
    }
    if (i + BATCH < symbols.length) await new Promise(r => setTimeout(r, 150));
  }

  // ── Step 2: Filter — must be moving above threshold ──────────────────────
  const movers = quoted
    .filter(q => Math.abs(q.changePercent) >= minMove)
    .sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))
    .slice(0, 30); // cap before indicator fetch to stay within rate limits

  if (movers.length === 0) {
    return NextResponse.json({ ok: true, opportunities: [], screened: quoted.length, cached: false,
      note: `No symbols moved more than ${minMove}% — market may be quiet` });
  }

  // ── Step 3: Fetch Yahoo Finance indicators for every mover ───────────────
  const results: Opportunity[] = [];
  const IND_BATCH = 5;

  for (let i = 0; i < movers.length; i += IND_BATCH) {
    const slice = movers.slice(i, i + IND_BATCH);
    const inds  = await Promise.all(slice.map(m => fetchYahooIndicators(m.symbol)));

    for (let j = 0; j < slice.length; j++) {
      const m   = slice[j];
      const ind = inds[j];
      if (!ind) continue;

      const igEpic = toIgEpic(m.symbol, 'US_STOCK');
      if (!igEpic) continue;

      const { opportunityScore, direction } = scoreOpportunity(
        m.changePercent, ind.bullScore, ind.bearScore,
        ind.rsi14, ind.volumeSurge, ind.emaCross, ind.macdCross,
      );
      if (direction === 'NEUTRAL') continue;

      results.push({
        symbol:           m.symbol,
        igEpic,
        yahooSymbol:      m.symbol,
        price:            ind.price > 0 ? ind.price : m.price,
        changePercent:    ind.changePercent !== 0 ? ind.changePercent : m.changePercent,
        volume:           m.volume,
        rsi14:            ind.rsi14,
        emaCross:         ind.emaCross,
        macdCross:        ind.macdCross,
        macdHistogram:    ind.macdHistogram,
        volumeSurge:      ind.volumeSurge,
        vwapDeviation:    ind.vwapDeviation,
        bullScore:        ind.bullScore,
        bearScore:        ind.bearScore,
        opportunityScore,
        direction,
      });
    }
    if (i + IND_BATCH < movers.length) await new Promise(r => setTimeout(r, 200));
  }

  // ── Step 4: Rank by opportunityScore, return top N ────────────────────────
  const ranked = results
    .sort((a, b) => b.opportunityScore - a.opportunityScore)
    .slice(0, limit);

  cache.set(cacheKey, { opps: ranked, screened: movers.length, expiresAt: Date.now() + TTL });
  return NextResponse.json({ ok: true, opportunities: ranked, screened: movers.length, cached: false });
}

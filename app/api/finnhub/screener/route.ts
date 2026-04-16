/**
 * GET /api/finnhub/screener?category=US_STOCK&limit=50&offset=0
 *
 * Pre-filters the symbol universe to the top movers using Finnhub quote data.
 * - Fetches quotes for symbols in parallel (batches of 10)
 * - Keeps symbols where |changePercent| > 0.3% OR significant volume
 * - Sorts by abs(changePercent) descending
 * - Returns top `limit` results with quote data, IG epic and Yahoo symbol
 *
 * Cache: 5 minutes (quotes change quickly but we don't need tick-by-tick)
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  FINNHUB_KEY, FINNHUB_BASE, TIER1_SYMBOLS,
  toIgEpic, toYahooSymbol,
  type FinnhubCategory,
} from '@/lib/finnhubConfig';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ScreenerResult {
  symbol:       string;
  description:  string;
  category:     FinnhubCategory;
  price:        number;
  changePercent: number;
  volume:       number;
  high:         number;
  low:          number;
  previousClose: number;
  igEpic:       string | null;
  yahooSymbol:  string | null;
}

// ── Cache (5 min) ──────────────────────────────────────────────────────────────

const cache = new Map<string, { results: ScreenerResult[]; expiresAt: number }>();
const TTL   = 5 * 60_000;

// ── Fetch a single Finnhub quote ───────────────────────────────────────────────

async function fetchQuote(symbol: string): Promise<{
  c: number; d: number; dp: number; h: number; l: number; pc: number; v?: number;
} | null> {
  if (!FINNHUB_KEY) return null;
  try {
    const r = await fetch(
      `${FINNHUB_BASE}/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!r.ok) return null;
    const d = await r.json() as { c: number; d: number; dp: number; h: number; l: number; pc: number; v?: number };
    if (!d.c || d.c === 0) return null;  // 0 = no data
    return d;
  } catch {
    return null;
  }
}

// ── Batch fetch quotes (10 in parallel, rate-limited) ─────────────────────────

async function batchQuotes(
  symbols: string[],
  cat: FinnhubCategory,
  descriptions: Map<string, string>,
): Promise<ScreenerResult[]> {
  const results: ScreenerResult[] = [];
  const BATCH = 10;

  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch  = symbols.slice(i, i + BATCH);
    const quotes = await Promise.all(batch.map(s => fetchQuote(s)));

    for (let j = 0; j < batch.length; j++) {
      const sym   = batch[j];
      const quote = quotes[j];
      if (!quote) continue;

      results.push({
        symbol:        sym,
        description:   descriptions.get(sym) ?? sym,
        category:      cat,
        price:         quote.c,
        changePercent: quote.dp,
        volume:        quote.v ?? 0,
        high:          quote.h,
        low:           quote.l,
        previousClose: quote.pc,
        igEpic:        toIgEpic(sym, cat),
        yahooSymbol:   toYahooSymbol(sym, cat),
      });
    }

    // Small delay between batches to stay under rate limit
    if (i + BATCH < symbols.length) await new Promise(r => setTimeout(r, 200));
  }

  return results;
}

// ── Route handler ──────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const cat    = (searchParams.get('category') ?? 'US_STOCK') as FinnhubCategory;
  const limit  = Math.min(100, parseInt(searchParams.get('limit') ?? '50', 10));
  const offset = parseInt(searchParams.get('offset') ?? '0', 10);

  const valid: FinnhubCategory[] = ['US_STOCK', 'UK_STOCK', 'FOREX', 'CRYPTO'];
  if (!valid.includes(cat)) {
    return NextResponse.json({ ok: false, error: `Invalid category: ${cat}` }, { status: 400 });
  }

  const cacheKey = `${cat}:${offset}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    return NextResponse.json({ ok: true, results: hit.results.slice(0, limit), cached: true });
  }

  // Get symbol list — try to fetch full universe from our cache/universe route
  // Fall back to tier-1 if Finnhub unavailable
  const tier1 = TIER1_SYMBOLS[cat];
  const symbols = tier1.slice(offset, offset + Math.min(100, tier1.length));
  const descMap = new Map(tier1.map(s => [s, s]));

  if (!FINNHUB_KEY) {
    // No API key — return tier-1 symbols with null quotes (indicators will fill them in)
    const fallback: ScreenerResult[] = symbols.map(s => ({
      symbol: s, description: s, category: cat,
      price: 0, changePercent: 0, volume: 0, high: 0, low: 0, previousClose: 0,
      igEpic: toIgEpic(s, cat), yahooSymbol: toYahooSymbol(s, cat),
    }));
    return NextResponse.json({ ok: true, results: fallback.slice(0, limit), cached: false, noKey: true });
  }

  // Fetch quotes for this batch
  const all = await batchQuotes(symbols, cat, descMap);

  // Filter: keep any mover with |changePercent| > 0.3%
  // For no-change periods, still return the top N by volume so scanner has something to work with
  const movers = all
    .filter(r => Math.abs(r.changePercent) > 0.3 || r.volume > 500_000)
    .sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));

  // If fewer than limit passed the filter, backfill with remaining symbols
  const moverSyms = new Set(movers.map(m => m.symbol));
  const extras    = all
    .filter(r => !moverSyms.has(r.symbol))
    .sort((a, b) => b.volume - a.volume);

  const final = [...movers, ...extras].slice(0, limit);

  cache.set(cacheKey, { results: final, expiresAt: Date.now() + TTL });
  return NextResponse.json({ ok: true, results: final, cached: false });
}

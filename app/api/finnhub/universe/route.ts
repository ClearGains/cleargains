/**
 * GET /api/finnhub/universe?category=US_STOCK|UK_STOCK|FOREX|CRYPTO
 *
 * Returns the full symbol list for a category from Finnhub.
 * Filters to tradeable, clean symbols and caches for 24 hours.
 *
 * Falls back to the curated TIER1_SYMBOLS list when Finnhub is unavailable
 * or FINNHUB_API_KEY is not configured.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  FINNHUB_KEY, FINNHUB_BASE, FINNHUB_EXCHANGE,
  TIER1_SYMBOLS, toIgEpic, toYahooSymbol,
  type FinnhubCategory,
} from '@/lib/finnhubConfig';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface UniverseSymbol {
  symbol:       string;
  description:  string;
  category:     FinnhubCategory;
  igEpic:       string | null;
  yahooSymbol:  string | null;
}

// ── Cache (24 h) ───────────────────────────────────────────────────────────────

const cache = new Map<string, { symbols: UniverseSymbol[]; expiresAt: number }>();
const TTL   = 24 * 60 * 60_000;

// ── Fetch and normalise ────────────────────────────────────────────────────────

async function fetchSymbols(cat: FinnhubCategory): Promise<UniverseSymbol[]> {
  // Always include tier-1 so there's a guaranteed base set
  const tier1 = TIER1_SYMBOLS[cat].map(s => ({
    symbol:      s,
    description: s,
    category:    cat,
    igEpic:      toIgEpic(s, cat),
    yahooSymbol: toYahooSymbol(s, cat),
  }));

  if (!FINNHUB_KEY) return tier1;

  const { type, exchange } = FINNHUB_EXCHANGE[cat];
  const endpoint =
    type === 'stock'  ? `${FINNHUB_BASE}/stock/symbol?exchange=${exchange}&token=${FINNHUB_KEY}` :
    type === 'forex'  ? `${FINNHUB_BASE}/forex/symbol?exchange=${exchange}&token=${FINNHUB_KEY}` :
                        `${FINNHUB_BASE}/crypto/symbol?exchange=${exchange}&token=${FINNHUB_KEY}`;

  try {
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return tier1;

    const raw = await res.json() as Array<{
      symbol: string;
      description?: string;
      displaySymbol?: string;
      type?: string;
    }>;

    const seen = new Set<string>();
    const out: UniverseSymbol[] = [];

    for (const item of raw) {
      const sym = item.symbol?.trim();
      if (!sym || seen.has(sym)) continue;

      // Quality filter per category
      if (cat === 'US_STOCK') {
        // Only common stocks with clean 1-5 char tickers (no warrants, ETFs, preferred)
        if (item.type !== 'Common Stock') continue;
        if (!/^[A-Z]{1,5}$/.test(sym)) continue;
      } else if (cat === 'UK_STOCK') {
        if (item.type !== 'Common Stock') continue;
        if (!/^[A-Z]{2,6}\.L$/.test(sym)) continue;
      } else if (cat === 'FOREX') {
        if (!sym.includes(':')) continue;
      } else if (cat === 'CRYPTO') {
        if (!sym.endsWith('USDT')) continue;  // only USDT pairs
      }

      const igEpic     = toIgEpic(sym, cat);
      const yahooSymbol = toYahooSymbol(sym, cat);

      seen.add(sym);
      out.push({
        symbol:      sym,
        description: item.description ?? item.displaySymbol ?? sym,
        category:    cat,
        igEpic,
        yahooSymbol,
      });
    }

    // Merge: tier-1 first (preserves ordering), then extras from Finnhub up to 500 total
    const tier1Syms = new Set(tier1.map(t => t.symbol));
    const extras    = out.filter(s => !tier1Syms.has(s.symbol)).slice(0, 500 - tier1.length);
    return [...tier1, ...extras];

  } catch {
    return tier1;
  }
}

// ── Route handler ──────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const cat = (request.nextUrl.searchParams.get('category') ?? 'US_STOCK') as FinnhubCategory;
  const valid: FinnhubCategory[] = ['US_STOCK', 'UK_STOCK', 'FOREX', 'CRYPTO'];
  if (!valid.includes(cat)) {
    return NextResponse.json({ ok: false, error: `Invalid category: ${cat}` }, { status: 400 });
  }

  const hit = cache.get(cat);
  if (hit && hit.expiresAt > Date.now()) {
    return NextResponse.json({ ok: true, symbols: hit.symbols, total: hit.symbols.length, cached: true });
  }

  const symbols = await fetchSymbols(cat);
  cache.set(cat, { symbols, expiresAt: Date.now() + TTL });
  return NextResponse.json({ ok: true, symbols, total: symbols.length, cached: false });
}

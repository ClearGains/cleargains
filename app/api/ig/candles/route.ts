/**
 * /api/ig/candles
 *
 * Fetches OHLCV candle data from Finnhub (NOT from IG historical prices).
 * This completely avoids the IG exceeded-account-historical-data-allowance
 * error because IG's /prices endpoint is never called here.
 *
 * Signal generation uses Finnhub data; IG is used only for:
 *   - GET  /positions/otc  (read open positions)
 *   - POST /positions/otc  (open a position)
 *   - POST /positions/otc  + _method:DELETE  (close a position)
 *   - GET  /markets/{epic} (snapshot price only)
 */

import { NextRequest, NextResponse } from 'next/server';
import type { Candle } from '@/lib/igStrategyEngine';

// ── Finnhub symbol map ────────────────────────────────────────────────────────
//
// Each IG market name maps to a Finnhub symbol + asset class.
// Stock/ETF proxies are used for indices (these work on Finnhub free tier).
// Forex uses OANDA: prefix.  Crypto uses BINANCE: prefix.
//
type AssetClass = 'stock' | 'forex' | 'crypto';

interface SymbolEntry {
  type: AssetClass;
  symbol: string;
  fallback?: { type: AssetClass; symbol: string };
}

const SYMBOL_MAP: Record<string, SymbolEntry> = {
  'FTSE 100':     { type: 'stock',  symbol: 'ISF.L',            fallback: { type: 'stock',  symbol: 'EWU'             } },
  'S&P 500':      { type: 'stock',  symbol: 'SPY'                                                                        },
  'Gold':         { type: 'forex',  symbol: 'OANDA:XAU_USD',    fallback: { type: 'stock',  symbol: 'GLD'             } },
  'NASDAQ 100':   { type: 'stock',  symbol: 'QQQ'                                                                        },
  'Germany 40':   { type: 'stock',  symbol: 'EWG'                                                                        },
  'Wall Street':  { type: 'stock',  symbol: 'DIA'                                                                        },
  'Oil (WTI)':    { type: 'stock',  symbol: 'USO'                                                                        },
  'Brent Crude':  { type: 'stock',  symbol: 'BNO'                                                                        },
  'GBP/USD':      { type: 'forex',  symbol: 'OANDA:GBP_USD'                                                              },
  'EUR/USD':      { type: 'forex',  symbol: 'OANDA:EUR_USD'                                                              },
  'EUR/GBP':      { type: 'forex',  symbol: 'OANDA:EUR_GBP'                                                              },
  'Bitcoin':      { type: 'crypto', symbol: 'BINANCE:BTCUSDT'                                                            },
  'Ethereum':     { type: 'crypto', symbol: 'BINANCE:ETHUSDT'                                                            },
};

// ── Timeframe → Finnhub resolution + lookback ────────────────────────────────

interface TimeframeCfg {
  resolution: string; // Finnhub: '1','5','15','30','60','D','W','M'
  lookbackDays: number;
  minCandles: number;
}

const TIMEFRAME_CFG: Record<string, TimeframeCfg> = {
  hourly:   { resolution: '5',  lookbackDays: 2,   minCandles: 25  },
  daily:    { resolution: '60', lookbackDays: 6,   minCandles: 55  },
  longterm: { resolution: 'D',  lookbackDays: 320, minCandles: 200 },
  rsi2:     { resolution: 'D',  lookbackDays: 330, minCandles: 210 },
};

// ── Cache ─────────────────────────────────────────────────────────────────────
//
// Keyed by "name:timeframe". TTL matches how often candles actually change:
//   5-min bars  → 5 min
//   hourly bars → 4 hours  (same day data barely changes intraday)
//   daily bars  → 12 hours (new bar added once per trading day)
//
const candleCache = new Map<string, { data: Candle[]; expiresAt: number }>();

const CACHE_TTL: Record<string, number> = {
  hourly:   5  * 60_000,
  daily:    4  * 60 * 60_000,
  longterm: 12 * 60 * 60_000,
  rsi2:     12 * 60 * 60_000,
};

// ── Finnhub fetch helpers ─────────────────────────────────────────────────────

interface FinnhubCandles {
  s: string;
  c?: number[];
  h?: number[];
  l?: number[];
  o?: number[];
  t?: number[];
  v?: number[];
}

async function fetchFinnhubCandles(
  type: AssetClass,
  symbol: string,
  resolution: string,
  from: number,
  to: number,
  token: string,
): Promise<Candle[] | null> {
  const base = 'https://finnhub.io/api/v1';
  const path = type === 'forex'  ? 'forex/candle'
             : type === 'crypto' ? 'crypto/candle'
             :                     'stock/candle';

  const url = `${base}/${path}?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${from}&to=${to}&token=${token}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const data = await res.json() as FinnhubCandles;
    if (data.s !== 'ok' || !data.c || !data.t || data.c.length === 0) return null;

    return data.c.map((close, i) => ({
      time:   new Date((data.t![i]) * 1000).toISOString(),
      open:   data.o?.[i] ?? close,
      high:   data.h?.[i] ?? close,
      low:    data.l?.[i] ?? close,
      close,
      volume: data.v?.[i] ?? 0,
    }));
  } catch {
    return null;
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const name      = searchParams.get('name') ?? '';
  const timeframe = searchParams.get('timeframe') ?? 'rsi2';

  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: 'FINNHUB_API_KEY not configured' }, { status: 503 });
  }
  if (!name) {
    return NextResponse.json({ ok: false, error: 'name parameter required' }, { status: 400 });
  }

  const entry = SYMBOL_MAP[name];
  if (!entry) {
    return NextResponse.json(
      { ok: false, error: `No Finnhub symbol mapping for market "${name}". Add it to SYMBOL_MAP.` },
      { status: 400 },
    );
  }

  const cfg = TIMEFRAME_CFG[timeframe] ?? TIMEFRAME_CFG.rsi2;

  // Cache check
  const cacheKey = `${name}:${timeframe}`;
  const cached   = candleCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json({ ok: true, candles: cached.data, source: 'finnhub', cached: true });
  }

  const now  = Math.floor(Date.now() / 1000);
  const from = now - cfg.lookbackDays * 86_400;

  // Primary symbol
  let candles = await fetchFinnhubCandles(entry.type, entry.symbol, cfg.resolution, from, now, apiKey);

  // Fallback symbol if primary returned nothing
  if ((!candles || candles.length < cfg.minCandles) && entry.fallback) {
    const fb = entry.fallback;
    candles = await fetchFinnhubCandles(fb.type, fb.symbol, cfg.resolution, from, now, apiKey);
  }

  if (!candles || candles.length < cfg.minCandles) {
    return NextResponse.json({
      ok: false,
      error: `Finnhub returned insufficient data for "${name}" (${candles?.length ?? 0} candles, need ${cfg.minCandles}). Market may be closed or symbol unavailable.`,
    }, { status: 502 });
  }

  // Cache and return
  const ttl = CACHE_TTL[timeframe] ?? CACHE_TTL.rsi2;
  candleCache.set(cacheKey, { data: candles, expiresAt: Date.now() + ttl });

  return NextResponse.json({ ok: true, candles, source: 'finnhub', cached: false });
}

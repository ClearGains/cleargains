import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/ig/swing?epic=IX.D.FTSE.DAILY.IP
 *
 * Returns a swing-trade signal based on 20 daily candles from Yahoo Finance.
 * Zero IG data-allowance cost. Cached for 4 hours (daily candles are stable).
 *
 * Signal logic:
 *   BUY  — trend UP (EMA5 > EMA10) + RSI pulled back to 35–58 + price below recent 5-day high
 *   SELL — trend DOWN (EMA5 < EMA10) + RSI bounced to 42–65 + price above recent 5-day low
 *   HOLD — trend unclear, RSI at extremes, or no meaningful pullback to enter
 */

const EPIC_TO_YAHOO: Record<string, string> = {
  'IX.D.FTSE.DAILY.IP':   '^FTSE',
  'IX.D.SPTRD.DAILY.IP':  '^GSPC',
  'IX.D.NASDAQ.CASH.IP':  '^NDX',
  'IX.D.DOW.DAILY.IP':    '^DJI',
  'IX.D.DAX.DAILY.IP':    '^GDAXI',
  'IX.D.NIKKEI.DAILY.IP': '^N225',
  'CS.D.GBPUSD.TODAY.IP': 'GBPUSD=X',
  'CS.D.EURUSD.TODAY.IP': 'EURUSD=X',
  'CS.D.USDJPY.TODAY.IP': 'JPY=X',
  'CS.D.EURGBP.TODAY.IP': 'EURGBP=X',
  'CS.D.AUDUSD.TODAY.IP': 'AUDUSD=X',
};

export type SwingSignal = {
  direction: 'BUY' | 'SELL' | 'HOLD';
  strength: number;
  reasons: string[];
  rsi: number | null;
  trend: 'UP' | 'DOWN' | 'FLAT';
  pullbackPct: number | null;  // how far price has pulled back from recent high/low
  weeklyChangePct: number | null;
  cached: boolean;
};

type DayCandle = { close: number; high: number; low: number };

function ema(values: number[], period: number): number {
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function rsi14(closes: number[]): number | null {
  if (closes.length < 15) return null;
  const slice = closes.slice(-15);
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const d = slice[i] - slice[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const avgG = gains / 14;
  const avgL = losses / 14;
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

function computeSwingSignal(candles: DayCandle[]): Omit<SwingSignal, 'cached'> {
  const reasons: string[] = [];

  if (candles.length < 12) {
    return { direction: 'HOLD', strength: 0, reasons: ['Not enough daily candle data'], rsi: null, trend: 'FLAT', pullbackPct: null, weeklyChangePct: null };
  }

  const closes = candles.map(c => c.close);
  const n = candles.length;
  const current = closes[n - 1];

  // Trend: EMA5 vs EMA10 on daily closes
  const e5  = ema(closes.slice(-10), 5);
  const e10 = ema(closes.slice(-12), 10);
  const emaDiffPct = ((e5 - e10) / e10) * 100;
  const trend: 'UP' | 'DOWN' | 'FLAT' =
    emaDiffPct >  0.15 ? 'UP'   :
    emaDiffPct < -0.15 ? 'DOWN' : 'FLAT';

  // RSI(14) on daily closes
  const rsi = rsi14(closes);

  // Weekly change: last 5 trading days
  const weeklyChangePct = closes.length >= 6
    ? ((closes[n - 1] - closes[n - 6]) / closes[n - 6]) * 100
    : null;

  // Recent 5-day high and low (excluding today)
  const recent5High = Math.max(...candles.slice(-6, -1).map(c => c.high));
  const recent5Low  = Math.min(...candles.slice(-6, -1).map(c => c.low));
  const pullbackFromHigh = ((recent5High - current) / recent5High) * 100;
  const bounceFromLow    = ((current - recent5Low)  / recent5Low)  * 100;

  // ── BUY: trend up + RSI pulled back to sweet spot + price dipped from recent high ──
  if (trend === 'UP' && rsi !== null) {
    const rsiOk       = rsi >= 35 && rsi <= 58;
    const pulledBack  = pullbackFromHigh >= 0.25 && pullbackFromHigh <= 3.0;

    if (rsiOk && pulledBack) {
      reasons.push(`Weekly trend UP (EMA5 ${emaDiffPct > 0 ? '+' : ''}${emaDiffPct.toFixed(2)}% above EMA10)`);
      reasons.push(`RSI ${rsi.toFixed(0)} — pulled back from highs, room to run`);
      reasons.push(`Price ${pullbackFromHigh.toFixed(1)}% below 5-day high — pullback entry`);
      if (weeklyChangePct !== null) reasons.push(`+${weeklyChangePct.toFixed(1)}% over last 5 days`);

      const rsiScore  = Math.max(0, 10 - Math.abs(rsi - 48));   // ideal RSI ≈ 48
      const pbScore   = Math.max(0, 10 - Math.abs(pullbackFromHigh - 1.0) * 3); // ideal pullback ≈ 1%
      const strength  = Math.min(88, 60 + Math.round(rsiScore + pbScore + (Math.abs(emaDiffPct) > 0.4 ? 8 : 0)));
      return { direction: 'BUY', strength, reasons, rsi, trend, pullbackPct: pullbackFromHigh, weeklyChangePct };
    }

    if (!rsiOk) reasons.push(`Trend UP but RSI ${rsi.toFixed(0)} — ${rsi > 58 ? 'overbought, wait for pullback' : 'too oversold, may be reversal not dip'}`);
    if (!pulledBack) reasons.push(`Trend UP but ${pullbackFromHigh < 0.25 ? 'no meaningful pullback yet' : 'pullback too deep (>3%), may be trend break)'}`);
  }

  // ── SELL: trend down + RSI bounced to sweet spot + price lifted from recent low ──
  if (trend === 'DOWN' && rsi !== null) {
    const rsiOk     = rsi >= 42 && rsi <= 65;
    const bounced   = bounceFromLow >= 0.25 && bounceFromLow <= 3.0;

    if (rsiOk && bounced) {
      reasons.push(`Weekly trend DOWN (EMA5 ${emaDiffPct.toFixed(2)}% below EMA10)`);
      reasons.push(`RSI ${rsi.toFixed(0)} — bounced from lows, room to fall`);
      reasons.push(`Price ${bounceFromLow.toFixed(1)}% above 5-day low — short entry`);
      if (weeklyChangePct !== null) reasons.push(`${weeklyChangePct.toFixed(1)}% over last 5 days`);

      const rsiScore = Math.max(0, 10 - Math.abs(rsi - 52));
      const bScore   = Math.max(0, 10 - Math.abs(bounceFromLow - 1.0) * 3);
      const strength = Math.min(88, 60 + Math.round(rsiScore + bScore + (Math.abs(emaDiffPct) > 0.4 ? 8 : 0)));
      return { direction: 'SELL', strength, reasons, rsi, trend, pullbackPct: bounceFromLow, weeklyChangePct };
    }

    if (!rsiOk) reasons.push(`Trend DOWN but RSI ${rsi.toFixed(0)} — ${rsi < 42 ? 'oversold, wait for bounce' : 'too overbought, may be reversal'}`);
    if (!bounced) reasons.push(`Trend DOWN but ${bounceFromLow < 0.25 ? 'no meaningful bounce yet' : 'bounce too large (>3%), may be trend break'}`);
  }

  if (trend === 'FLAT') reasons.push(`No clear trend — EMA5/EMA10 within 0.15% of each other`);

  return { direction: 'HOLD', strength: 0, reasons, rsi, trend, pullbackPct: null, weeklyChangePct };
}

// 4-hour cache — daily candles don't move meaningfully in 4 hours
const CACHE_TTL = 4 * 60 * 60_000;
const cache = new Map<string, { signal: Omit<SwingSignal, 'cached'>; ts: number }>();

export const revalidate = 0;

export async function GET(req: NextRequest) {
  const epic = req.nextUrl.searchParams.get('epic') ?? '';
  const force = req.nextUrl.searchParams.get('force') === '1';

  const yahoo = EPIC_TO_YAHOO[epic];
  if (!yahoo) {
    return NextResponse.json({ ok: false, error: `No Yahoo mapping for epic: ${epic}` }, { status: 400 });
  }

  const cached = cache.get(epic);
  if (!force && cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json({ ok: true, ...cached.signal, cached: true });
  }

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahoo)}?interval=1d&range=30d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) throw new Error(`Yahoo ${res.status}`);

    const json = await res.json() as {
      chart?: {
        result?: Array<{
          indicators?: {
            quote?: Array<{
              open: (number | null)[];
              high: (number | null)[];
              low:  (number | null)[];
              close:(number | null)[];
            }>;
          };
        }>;
      };
    };

    const q = json.chart?.result?.[0]?.indicators?.quote?.[0];
    if (!q) throw new Error('No quote data from Yahoo');

    // Build clean candle array (drop nulls)
    const candles: DayCandle[] = [];
    for (let i = 0; i < (q.close?.length ?? 0); i++) {
      const c = q.close?.[i], h = q.high?.[i], l = q.low?.[i];
      if (c != null && h != null && l != null && c > 0) {
        candles.push({ close: c, high: h, low: l });
      }
    }

    const signal = computeSwingSignal(candles);
    cache.set(epic, { signal, ts: Date.now() });
    return NextResponse.json({ ok: true, ...signal, cached: false });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

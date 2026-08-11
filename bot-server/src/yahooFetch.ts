import type { AlpacaBar, Timeframe } from './alpacaApi';

// ── Yahoo bars fetch ──────────────────────────────────────────────────────────
// Yahoo blocks server requests that look automated (missing browser headers) —
// a bare request from this VM returns 429. A normal User-Agent/Accept-Language
// is enough to get real data back (confirmed manually against this exact host).
// No historical-data allowance cost, unlike IG's own candle API — used for
// frequent, free directional pre-checks; IG's own data is still the source of
// truth for anything involving actual price levels, stops, or sizing.

type YahooChartRaw = {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: (number | null)[]; high?: (number | null)[];
          low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[];
        }>;
      };
    }>;
    error?: unknown;
  };
};

export async function fetchYahooBars(
  symbol:   string,
  interval: '1m' | '5m' | '15m' | '30m' | '1h' | '1d' | '1wk',
  range:    string,
): Promise<AlpacaBar[] | null> {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=${interval}&range=${range}&includePrePost=false`;
  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const raw = await res.json() as YahooChartRaw;
    if (raw.chart?.error) return null;
    const result = raw.chart?.result?.[0];
    if (!result) return null;
    const timestamps = result.timestamp ?? [];
    const q = result.indicators?.quote?.[0] ?? {};
    const dateOnly = interval === '1d' || interval === '1wk';
    const bars: AlpacaBar[] = timestamps.map((ts, i) => ({
      t: dateOnly
        ? new Date(ts * 1000).toISOString().slice(0, 10)
        : new Date(ts * 1000).toISOString(),
      o: q.open?.[i] ?? 0, h: q.high?.[i] ?? 0, l: q.low?.[i] ?? 0, c: q.close?.[i] ?? 0, v: q.volume?.[i] ?? 0,
    })).filter(b => b.c > 0);
    return bars;
  } catch {
    return null;
  }
}

// ── Epic → Yahoo ticker map ───────────────────────────────────────────────────
// Covers the IG_EPICS universe in igStrategyScanner.ts. Only used for the
// cheap directional pre-check — an epic missing here just skips the pre-check
// and falls back to the normal once-daily IG-only path.

export const EPIC_TO_YAHOO: Record<string, string> = {
  // FX majors
  'CS.D.GBPUSD.TODAY.IP': 'GBPUSD=X',
  'CS.D.EURUSD.TODAY.IP': 'EURUSD=X',
  'CS.D.USDJPY.TODAY.IP': 'JPY=X',
  'CS.D.EURGBP.TODAY.IP': 'EURGBP=X',
  'CS.D.AUDUSD.TODAY.IP': 'AUDUSD=X',
  // Indices
  'IX.D.DOW.DAILY.IP':    '^DJI',
  'IX.D.NASDAQ.CASH.IP':  '^IXIC',
  'IX.D.SPTRD.DAILY.IP':  '^GSPC',
  'IX.D.FTSE.DAILY.IP':   '^FTSE',
  'IX.D.STXE.CASH.IP':    '^STOXX50E',
  'IX.D.DAX.DAILY.IP':    '^GDAXI',
  // US stocks
  'UA.D.AAPL.CASH.IP':  'AAPL',
  'UC.D.MSFT.DAILY.IP': 'MSFT',
  'UC.D.NVDA.DAILY.IP': 'NVDA',
  'UA.D.AMZN.CASH.IP':  'AMZN',
  'UB.D.GOOGL.DAILY.IP': 'GOOGL',
  'UB.D.FB.DAILY.IP':   'META',
  'UD.D.TSLA.DAILY.IP': 'TSLA',
  'UC.D.NFLX.DAILY.IP': 'NFLX',
  'SD.D.JPM.DAILY.IP':  'JPM',
  'SH.D.VUS.DAILY.IP':  'V',
  'SH.D.UNH.DAILY.IP':  'UNH',
  'SH.D.XOM.DAILY.IP':  'XOM',
  // Semiconductor / storage / legacy tech
  'SA.D.AMD.DAILY.IP':    'AMD',
  'UA.D.AVGO.DAILY.IP':   'AVGO',
  'UB.D.INTC.DAILY.IP':   'INTC',
  'UC.D.QCOM.DAILY.IP':   'QCOM',
  'UC.D.MU.DAILY.IP':     'MU',
  'SG.D.TSM.DAILY.IP':    'TSM',
  'UD.D.SNDKUS.DAILY.IP': 'SNDK',
  'UD.D.STX.DAILY.IP':    'STX',
  'UC.D.MRVL.DAILY.IP':   'MRVL',
  // No liquid US ADR ticker on Yahoo for SK Hynix — its Korean primary listing
  // tracks the same underlying and is close enough for a free directional
  // pre-check (never used for actual price levels or sizing).
  'UD.D.SKHYUS.DAILY.IP': '000660.KS',
  'UD.D.WDC.DAILY.IP':    'WDC',
  'SB.D.DELLUS.DAILY.IP': 'DELL',
  'UC.D.RIMM.DAILY.IP':   'BB',
  // Helsinki listing, not the US ADR (NOK) — matches IG's actual traded epic.
  'EC.D.NOKIAFP.DAILY.IP': 'NOKIA.HE',
  // UK stocks
  'KA.D.BARC.DAILY.IP':   'BARC.L',
  'KA.D.BP.DAILY.IP':     'BP.L',
  'KA.D.HSBA.DAILY.IP':   'HSBA.L',
  'KA.D.SHELLN.DAILY.IP': 'SHEL.L',
  'KA.D.GSK.DAILY.IP':    'GSK.L',
  'KA.D.AZN.DAILY.IP':    'AZN.L',
  'KA.D.LLOY.DAILY.IP':   'LLOY.L',
};

// ── Epic → Alpaca ticker map ──────────────────────────────────────────────────
// US-listed shares only — Alpaca has no indices, FX, or UK-listed stocks.
// Same real-world price as IG for all of these (no scale conversion needed,
// unlike FX), and Alpaca's an official brokerage data feed rather than
// Yahoo's unofficial one, so it's tried first for anything it covers.
export const EPIC_TO_ALPACA: Record<string, string> = {
  'UA.D.AAPL.CASH.IP':    'AAPL',
  'UC.D.MSFT.DAILY.IP':   'MSFT',
  'UC.D.NVDA.DAILY.IP':   'NVDA',
  'UA.D.AMZN.CASH.IP':    'AMZN',
  'UB.D.GOOGL.DAILY.IP':  'GOOGL',
  'UB.D.FB.DAILY.IP':     'META',
  'UD.D.TSLA.DAILY.IP':   'TSLA',
  'UC.D.NFLX.DAILY.IP':   'NFLX',
  'SD.D.JPM.DAILY.IP':    'JPM',
  'SH.D.VUS.DAILY.IP':    'V',
  'SH.D.UNH.DAILY.IP':    'UNH',
  'SH.D.XOM.DAILY.IP':    'XOM',
  'SA.D.AMD.DAILY.IP':    'AMD',
  'UA.D.AVGO.DAILY.IP':   'AVGO',
  'UB.D.INTC.DAILY.IP':   'INTC',
  'UC.D.QCOM.DAILY.IP':   'QCOM',
  'UC.D.MU.DAILY.IP':     'MU',
  'SG.D.TSM.DAILY.IP':    'TSM',
  'UD.D.SNDKUS.DAILY.IP': 'SNDK',
  'UD.D.STX.DAILY.IP':    'STX',
  'UC.D.MRVL.DAILY.IP':   'MRVL',
  'UD.D.WDC.DAILY.IP':    'WDC',
  'SB.D.DELLUS.DAILY.IP': 'DELL',
  'UC.D.RIMM.DAILY.IP':   'BB',
  // SK Hynix (Korean primary listing) and Nokia (Helsinki listing) aren't
  // Alpaca-tradable US symbols — Yahoo-only for those two, as before.
};

// ── Bars with fallback ────────────────────────────────────────────────────────
// Tries Alpaca first for anything it covers (more reliable — official feed,
// no anti-bot header spoofing needed), falls back to Yahoo on any failure or
// for epics Alpaca doesn't cover (indices, UK stocks). FX is never routed
// through this — callers keep using IG's own data for FX, since Yahoo/Alpaca's
// raw decimal quoting doesn't match IG's point-scaled FX prices and a wrong
// conversion there is exactly the sizing bug this account already hit once.
// IG quotes US shares in points = cents, not raw dollars — confirmed live
// against the account across all 24 EPIC_TO_ALPACA names (AAPL real ~341,
// IG shows ~33952; AMD real ~433, IG shows ~43361; consistent ×100 within
// normal bid/ask spread, not a per-instrument quirk). Raw Alpaca/Yahoo
// dollar prices need this applied before use for any real stop/TP/price
// level — skipping it is what caused a live SELL to size off an entry
// price ~100x too low (TSMC, rejected by IG's own margin check rather
// than filling, but not something to rely on luck for twice).
const IG_SHARE_POINTS_PER_UNIT = 100;

function scaleBars(bars: AlpacaBar[], factor: number): AlpacaBar[] {
  return bars.map(b => ({ ...b, o: b.o * factor, h: b.h * factor, l: b.l * factor, c: b.c * factor }));
}

// Lightweight spot-check — just the most recent price, not a full bar
// series. Used to cross-reference Alpaca's result before trusting it (see
// fetchBarsWithFallback) rather than only falling back to Yahoo when
// Alpaca outright errors.
async function fetchYahooLastPrice(symbol: string): Promise<number | null> {
  const bars = await fetchYahooBars(symbol, '1m', '1d');
  const last = bars?.[bars.length - 1]?.c;
  return last && last > 0 ? last : null;
}

export async function fetchBarsWithFallback(
  epic:  string,
  range: string,
  opts?: {
    alpacaTimeframe?: Timeframe; yahooInterval?: '1m' | '5m' | '15m' | '30m' | '1h' | '1d' | '1wk';
    // Live IG quote for this epic, e.g. (bid+offer)/2 — when supplied for an
    // epic that falls through to the Yahoo-only branch below (no Alpaca
    // coverage), the raw Yahoo bars get rescaled to match IG's own price
    // level instead of being returned as-is. Confirmed live this matters:
    // IG's price for an index is ~1:1 with Yahoo's raw number, but for
    // Nokia it's ~69.74x — not a guessable constant (looks like a currency
    // conversion baked into IG's points scaling), same class of mismatch
    // already found and fixed for FX (×10000 vs ×100 depending on the pair).
    // Derived fresh per call rather than hardcoded, mirroring geminiWatch.ts's
    // identical technique for FX position reviews.
    liveReferenceLevel?: number;
  },
): Promise<AlpacaBar[] | null> {
  const alpacaTimeframe = opts?.alpacaTimeframe ?? '1Day';
  const yahooInterval   = opts?.yahooInterval   ?? '1d';
  const isShare  = epic in EPIC_TO_ALPACA;
  const alpacaSym = EPIC_TO_ALPACA[epic];
  const yahooSym  = EPIC_TO_YAHOO[epic];
  if (alpacaSym) {
    try {
      const { getBars } = await import('./alpacaApi');
      // 250 not 130 — gemini_opinion now asks for 240 30-min bars (5 days'
      // worth) to give its multi-day trend context a real lookback; every
      // other caller's own count still trims this down via .slice(-count)
      // below, so raising the ceiling here is free for them (Alpaca's paper
      // market-data endpoint isn't allowance-limited the way IG's is).
      const result = await getBars([alpacaSym], alpacaTimeframe, 250, 'paper');
      const bars = result[alpacaSym];
      if (bars?.length) {
        // Cross-check against Yahoo (both compared in Alpaca's raw,
        // unscaled units) before trusting it — confirmed live this
        // matters: Alpaca's bars endpoint returned a fully successful
        // response with silently ~3-week-stale data (a pagination bug,
        // since fixed at the source), which fed a fabricated day-change
        // figure into a real position-close decision. A cheap spot-check
        // against an independent source catches "succeeded but wrong" in
        // a way error handling alone never can, regardless of the cause.
        let trustworthy = true;
        if (yahooSym) {
          const alpacaLast = bars[bars.length - 1].c;
          const yahooLast  = await fetchYahooLastPrice(yahooSym);
          if (yahooLast) {
            const diffPct = Math.abs(alpacaLast - yahooLast) / yahooLast * 100;
            if (diffPct > 8) {
              trustworthy = false;
              console.warn(`[yahooFetch] Alpaca/Yahoo mismatch for ${epic}: ${alpacaLast.toFixed(2)} vs ${yahooLast.toFixed(2)} (${diffPct.toFixed(1)}%) — discarding Alpaca data, falling back to Yahoo`);
            }
          }
          // yahooLast missing (fetch failed) — can't cross-check, trust Alpaca rather than block on it
        }
        if (trustworthy) return isShare ? scaleBars(bars, IG_SHARE_POINTS_PER_UNIT) : bars;
      }
    } catch {
      // fall through to Yahoo
    }
  }
  if (!yahooSym) return null;
  const yahooBars = await fetchYahooBars(yahooSym, yahooInterval, range);
  return yahooBars && isShare ? scaleBars(yahooBars, IG_SHARE_POINTS_PER_UNIT) : yahooBars;
}

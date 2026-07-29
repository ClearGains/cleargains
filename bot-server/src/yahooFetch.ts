import type { AlpacaBar } from './alpacaApi';

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
  interval: '5m' | '1h' | '1d',
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
    const bars: AlpacaBar[] = timestamps.map((ts, i) => ({
      t: interval === '1d'
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
  'IX.D.NASDAQ.DAILY.IP': '^IXIC',
  'IX.D.SANDA.DAILY.IP':  '^GSPC',
  'IX.D.FTSE.DAILY.IP':   '^FTSE',
  'IX.D.EUROST.DAILY.IP': '^STOXX50E',
  'IX.D.DAX.DAILY.IP':    '^GDAXI',
  // US stocks
  'UA.D.AAPL.CASH.IP':  'AAPL',
  'UA.D.MSFT.CASH.IP':  'MSFT',
  'UA.D.NVDA.CASH.IP':  'NVDA',
  'UA.D.AMZN.CASH.IP':  'AMZN',
  'UA.D.GOOGL.CASH.IP': 'GOOGL',
  'UA.D.META.CASH.IP':  'META',
  'UA.D.TSLA.CASH.IP':  'TSLA',
  'UA.D.NFLX.CASH.IP':  'NFLX',
  'UA.D.JPM.CASH.IP':   'JPM',
  'UA.D.V.CASH.IP':     'V',
  'UA.D.UNH.CASH.IP':   'UNH',
  'UA.D.XOM.CASH.IP':   'XOM',
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
  'UC.D.BARC.CASH.IP': 'BARC.L',
  'UC.D.BP.CASH.IP':   'BP.L',
  'UC.D.HSBA.CASH.IP': 'HSBA.L',
  'UC.D.SHEL.CASH.IP': 'SHEL.L',
  'UC.D.GSK.CASH.IP':  'GSK.L',
  'UC.D.AZN.CASH.IP':  'AZN.L',
  'UC.D.LLOY.CASH.IP': 'LLOY.L',
};

// ── Epic → Alpaca ticker map ──────────────────────────────────────────────────
// US-listed shares only — Alpaca has no indices, FX, or UK-listed stocks.
// Same real-world price as IG for all of these (no scale conversion needed,
// unlike FX), and Alpaca's an official brokerage data feed rather than
// Yahoo's unofficial one, so it's tried first for anything it covers.
export const EPIC_TO_ALPACA: Record<string, string> = {
  'UA.D.AAPL.CASH.IP':    'AAPL',
  'UA.D.MSFT.CASH.IP':    'MSFT',
  'UA.D.NVDA.CASH.IP':    'NVDA',
  'UA.D.AMZN.CASH.IP':    'AMZN',
  'UA.D.GOOGL.CASH.IP':   'GOOGL',
  'UA.D.META.CASH.IP':    'META',
  'UA.D.TSLA.CASH.IP':    'TSLA',
  'UA.D.NFLX.CASH.IP':    'NFLX',
  'UA.D.JPM.CASH.IP':     'JPM',
  'UA.D.V.CASH.IP':       'V',
  'UA.D.UNH.CASH.IP':     'UNH',
  'UA.D.XOM.CASH.IP':     'XOM',
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
export async function fetchBarsWithFallback(
  epic:  string,
  range: string,
): Promise<AlpacaBar[] | null> {
  const alpacaSym = EPIC_TO_ALPACA[epic];
  if (alpacaSym) {
    try {
      const { getBars } = await import('./alpacaApi');
      const result = await getBars([alpacaSym], '1Day', 130, 'paper');
      const bars = result[alpacaSym];
      if (bars?.length) return bars;
    } catch {
      // fall through to Yahoo
    }
  }
  const yahooSym = EPIC_TO_YAHOO[epic];
  if (!yahooSym) return null;
  return fetchYahooBars(yahooSym, '1d', range);
}

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
  includePrePost = false,
): Promise<AlpacaBar[] | null> {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=${interval}&range=${range}&includePrePost=${includePrePost}`;
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
  // Missing entirely until now, despite Japan 225 being explicitly pinned to
  // gemini_opinion's watchlist on every cycle by user request (see
  // PRIORITY_EPIC in igStrategyScanner.ts) — meant every single evaluation
  // fell through to IG's own allowance-limited fetchCandleHistory instead of
  // this free path, confirmed live 2026-08-18 as the actual cause of an
  // exceeded-account-historical-data-allowance error. Ratio confirmed live
  // against real IG bid the same day (~1.00, unscaled — see
  // lib/epicToYahoo.ts's NON_STOCK_SCALE_FACTOR verification).
  'IX.D.NIKKEI.DAILY.IP': '^N225',
  // CFD-account epics — different codes from the spread-bet ones above for
  // the same underlying instrument, confirmed live (IX.D.FTSE.CFD.IP vs
  // IX.D.FTSE.DAILY.IP, CS.D.GBPUSD.CFD.IP vs CS.D.GBPUSD.TODAY.IP). Also
  // confirmed live: unlike spread-bet FX (~×10000 scaled), CFD FX/index
  // prices are raw/unscaled — matches Yahoo's own value 1:1 (checked
  // directly: IG CFD FTSE ~10792 vs Yahoo ^FTSE ~10773, GBP/USD CFD
  // ~1.3495 vs Yahoo GBPUSD=X ~1.3497) — so these route through the same
  // unscaled pure-Yahoo path everything else here does, no special-casing.
  'IX.D.FTSE.CFD.IP':     '^FTSE',
  'CS.D.GBPUSD.CFD.IP':   'GBPUSD=X',
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
  // US High-beta / Screener regulars — added to IG_STOCK_EPICS but never
  // mapped here, so fetchBarsWithFallback returned null forever for these
  // ("Not enough bar data yet" every scan, not a transient warm-up state).
  'SE.D.PLTRUS.DAILY.IP':  'PLTR',
  'UA.D.COINUS.DAILY.IP':  'COIN',
  'SG.D.SNAPUS.DAILY.IP':  'SNAP',
  'SH.D.UBERUS.DAILY.IP':  'UBER',
  'SG.D.SHOPUS.DAILY.IP':  'SHOP',
  'SG.D.SQUS.DAILY.IP':    'SQ',
  'UC.D.PYPLVUS.DAILY.IP': 'PYPL',
  'SG.D.RBLXUS.DAILY.IP':  'RBLX',
  'UB.D.DKNGUS.DAILY.IP':  'DKNG',
  'UC.D.RIVNUS.DAILY.IP':  'RIVN',
  'SE.D.NIOUS.DAILY.IP':   'NIO',
  'SC.D.GMEUS.DAILY.IP':   'GME',
  // Commodities/crypto/Ford from the same 2026-08-15 batch — same missing-
  // mapping gap. Tickers match the leaderboard's own convention for these
  // exact instruments (see lib/yahooClient.ts / lib/backtest.ts).
  'CS.D.USCSI.TODAY.IP':   'SI=F',
  'CC.D.LCO.USS.IP':       'BZ=F',
  'CC.D.NG.USS.IP':        'NG=F',
  'CS.D.BITCOIN.TODAY.IP': 'BTC-USD',
  'CS.D.BITCOIN.CFD.IP':   'BTC-USD',
  'SC.D.F.DAILY.IP':       'F',

  // ── CFD-account .CASH.IP epics for the same stocks above ──────────────
  // igCfdBot.ts swaps most of these ".DAILY.IP" epics for a distinct,
  // genuinely CFD-dealable ".CASH.IP" epic (see CFD_STOCK_EPIC_OVERRIDES
  // there) — this map is keyed by exact epic string, so those lookups
  // missed entirely without these additional entries, silently starving
  // the CFD bot of bar data ("Not enough bar data yet" forever) even
  // though order placement itself was already fixed. Same underlying
  // company/ticker as the .DAILY.IP entry above in each case.
  'UC.D.MSFT.CASH.IP':    'MSFT',
  'UC.D.NVDA.CASH.IP':    'NVDA',
  'UB.D.GOOGL.CASH.IP':   'GOOGL',
  'UB.D.FB.CASH.IP':      'META',
  'UD.D.TSLA.CASH.IP':    'TSLA',
  'UC.D.NFLX.CASH.IP':    'NFLX',
  'SA.D.AMD.CASH.IP':     'AMD',
  'UA.D.AVGO.CASH.IP':    'AVGO',
  'UB.D.INTC.CASH.IP':    'INTC',
  'UC.D.QCOM.CASH.IP':    'QCOM',
  'UC.D.MU.CASH.IP':      'MU',
  'UD.D.SNDKUS.CASH.IP':  'SNDK',
  'UD.D.STX.CASH.IP':     'STX',
  'UC.D.MRVL.CASH.IP':    'MRVL',
  'UD.D.SKHYUS.CASH.IP':  '000660.KS',
  'UD.D.WDC.CASH.IP':     'WDC',
  'UC.D.RIMM.CASH.IP':    'BB',
  'EC.D.NOKIAFP.CASH.IP': 'NOKIA.HE',
  'KA.D.BARC.CASH.IP':    'BARC.L',
  'KA.D.BP.CASH.IP':      'BP.L',
  'KA.D.HSBA.CASH.IP':    'HSBA.L',
  'KA.D.SHELLN.CASH.IP':  'SHEL.L',
  'KA.D.GSK.CASH.IP':     'GSK.L',
  'KA.D.AZN.CASH.IP':     'AZN.L',
  'KA.D.LLOY.CASH.IP':    'LLOY.L',
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
  // US High-beta / Screener regulars — same missing-mapping gap as in
  // EPIC_TO_YAHOO above; all confirmed Alpaca-tradable US common stock.
  'SE.D.PLTRUS.DAILY.IP':  'PLTR',
  'UA.D.COINUS.DAILY.IP':  'COIN',
  'SG.D.SNAPUS.DAILY.IP':  'SNAP',
  'SH.D.UBERUS.DAILY.IP':  'UBER',
  'SG.D.SHOPUS.DAILY.IP':  'SHOP',
  'SG.D.SQUS.DAILY.IP':    'SQ',
  'UC.D.PYPLVUS.DAILY.IP': 'PYPL',
  'SG.D.RBLXUS.DAILY.IP':  'RBLX',
  'UB.D.DKNGUS.DAILY.IP':  'DKNG',
  'UC.D.RIVNUS.DAILY.IP':  'RIVN',
  'SE.D.NIOUS.DAILY.IP':   'NIO',
  'SC.D.GMEUS.DAILY.IP':   'GME',
  'SC.D.F.DAILY.IP':       'F',
  // SK Hynix (Korean primary listing) and Nokia (Helsinki listing) aren't
  // Alpaca-tradable US symbols — Yahoo-only for those two, as before.
  // Silver/Brent Crude/Natural Gas/Bitcoin are commodities/crypto, not
  // Alpaca-tradable equities — Yahoo-only (see EPIC_TO_YAHOO above).

  // CFD-account .CASH.IP equivalents — see the matching block in
  // EPIC_TO_YAHOO above for why these are needed as separate keys.
  'UC.D.MSFT.CASH.IP':   'MSFT',
  'UC.D.NVDA.CASH.IP':   'NVDA',
  'UB.D.GOOGL.CASH.IP':  'GOOGL',
  'UB.D.FB.CASH.IP':     'META',
  'UD.D.TSLA.CASH.IP':   'TSLA',
  'UC.D.NFLX.CASH.IP':   'NFLX',
  'SA.D.AMD.CASH.IP':    'AMD',
  'UA.D.AVGO.CASH.IP':   'AVGO',
  'UB.D.INTC.CASH.IP':   'INTC',
  'UC.D.QCOM.CASH.IP':   'QCOM',
  'UC.D.MU.CASH.IP':     'MU',
  'UD.D.SNDKUS.CASH.IP': 'SNDK',
  'UD.D.STX.CASH.IP':    'STX',
  'UC.D.MRVL.CASH.IP':   'MRVL',
  'UD.D.WDC.CASH.IP':    'WDC',
  'UC.D.RIMM.CASH.IP':   'BB',
  // UK stocks aren't Alpaca-tradable either — Yahoo-only (BARC/BP/HSBA/etc.
  // already have .CASH.IP entries in EPIC_TO_YAHOO above).
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
    // Skip the ×100 IG_SHARE_POINTS_PER_UNIT scaling below even for a
    // share epic. That scaling is the spread-bet account's own convention
    // (IG quotes spread-bet shares in points = cents) — confirmed live
    // repeatedly that CFD share prices are raw/unscaled instead, matching
    // Yahoo/Alpaca's own dollar values 1:1. Every CFD-bot caller must set
    // this — the bug this comment replaces had every CFD stop/take-profit
    // distance computed ~100x too wide (real price vs a still-scaled
    // signal price), meaning positions had essentially no working stop.
    rawShares?: boolean;
    // Extended-hours mode — for IG's "24 Hour" US share CFDs, which are
    // live/dealable well outside NASDAQ's 13:30-20:00 UTC regular session
    // (confirmed live: MSFT/SNAP showing TRADEABLE with a moving bid/offer
    // at ~00:30 UTC Monday, hours before real pre-market even opens ~08:00
    // UTC). Alpaca's free IEX feed is skipped entirely when this is set —
    // its own bars endpoint has no extended-hours toggle, and the existing
    // Alpaca/Yahoo price cross-check below only catches a *wrong* price,
    // not a *stale-but-still-accurate* one: if Friday's close hasn't moved
    // much overnight, Alpaca's frozen Friday bar would pass the trust check
    // and get returned with its own (stale) timestamp regardless of how
    // fresh Yahoo's data is. Going straight to Yahoo with includePrePost on
    // sidesteps that rather than trying to patch the trust check to reason
    // about staleness as well as price.
    includePrePost?: boolean;
  },
): Promise<AlpacaBar[] | null> {
  const alpacaTimeframe = opts?.alpacaTimeframe ?? '1Day';
  const yahooInterval   = opts?.yahooInterval   ?? '1d';
  const isShare  = epic in EPIC_TO_ALPACA && !opts?.rawShares;
  const alpacaSym = EPIC_TO_ALPACA[epic];
  const yahooSym  = EPIC_TO_YAHOO[epic];
  if (alpacaSym && !opts?.includePrePost) {
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
  const yahooBars = await fetchYahooBars(yahooSym, yahooInterval, range, opts?.includePrePost ?? false);
  if (!yahooBars?.length) return yahooBars;
  if (isShare) return scaleBars(yahooBars, IG_SHARE_POINTS_PER_UNIT);
  // liveReferenceLevel was documented above (and has been since this file's
  // FX-rescaling comment cited Nokia's ~69.74x mismatch as the reason it
  // exists) but was never actually consumed here — every caller passing it
  // silently got raw, unscaled Yahoo bars back regardless. Confirmed live
  // tonight: SK Hynix's IG CFD is a USD-priced ADR ("SK hynix Inc - ADR"),
  // but its only free-data fallback (000660.KS) is the KRW-priced Korea
  // Exchange primary listing — ~1,593,000 vs a USD ADR price, not even the
  // same currency, let alone scale. Rescale to the real IG level whenever
  // one's supplied, same technique geminiWatch.ts already uses for FX.
  if (opts?.liveReferenceLevel !== undefined && opts.liveReferenceLevel > 0) {
    const lastClose = yahooBars[yahooBars.length - 1].c;
    if (lastClose > 0) return scaleBars(yahooBars, opts.liveReferenceLevel / lastClose);
  }
  return yahooBars;
}

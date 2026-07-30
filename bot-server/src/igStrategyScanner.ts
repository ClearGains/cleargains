import { fetchCandleHistory, type IGSession, type CandleBar } from './igApi';
import { calcRsi, calcEma, calcAtr, calcVwap, calcSma, calcMacdHist } from './alpacaStrategies';
import type { AlpacaBar } from './alpacaApi';
import type { IgStrategyName } from './igStrategyBot';
import { fetchBarsWithFallback, EPIC_TO_ALPACA } from './yahooFetch';

// ── Curated liquid IG epic universe ───────────────────────────────────────────
// Indices, major US/UK stocks, and FX majors. Stake sizing is risk-based
// (£risk ÷ stop-distance-in-points, computed off actual returned prices) —
// scale-agnostic, so it's correct for FX's ~1.3 price / 0.0001 point size
// alongside indices' ~10,000 price / 1.0 point size without special-casing.

export const IG_EPICS: { epic: string; name: string }[] = [
  // FX majors
  { epic: 'CS.D.GBPUSD.TODAY.IP', name: 'GBP/USD'      },
  { epic: 'CS.D.EURUSD.TODAY.IP', name: 'EUR/USD'      },
  { epic: 'CS.D.USDJPY.TODAY.IP', name: 'USD/JPY'      },
  { epic: 'CS.D.EURGBP.TODAY.IP', name: 'EUR/GBP'      },
  { epic: 'CS.D.AUDUSD.TODAY.IP', name: 'AUD/USD'      },
  // US indices
  { epic: 'IX.D.DOW.DAILY.IP',    name: 'Wall St'      },
  { epic: 'IX.D.NASDAQ.DAILY.IP', name: 'US Tech 100'  },
  { epic: 'IX.D.SANDA.DAILY.IP',  name: 'US 500'       },
  // UK / EU indices
  { epic: 'IX.D.FTSE.DAILY.IP',   name: 'UK 100'       },
  { epic: 'IX.D.EUROST.DAILY.IP', name: 'EU Stocks 50' },
  { epic: 'IX.D.DAX.DAILY.IP',    name: 'Germany 40'   },
  // Major US stocks (IG spreadbet format)
  { epic: 'UA.D.AAPL.CASH.IP',    name: 'Apple'        },
  { epic: 'UA.D.MSFT.CASH.IP',    name: 'Microsoft'    },
  { epic: 'UA.D.NVDA.CASH.IP',    name: 'NVIDIA'       },
  { epic: 'UA.D.AMZN.CASH.IP',    name: 'Amazon'       },
  { epic: 'UA.D.GOOGL.CASH.IP',   name: 'Alphabet'     },
  { epic: 'UA.D.META.CASH.IP',    name: 'Meta'         },
  { epic: 'UA.D.TSLA.CASH.IP',    name: 'Tesla'        },
  { epic: 'UA.D.NFLX.CASH.IP',    name: 'Netflix'      },
  { epic: 'UA.D.JPM.CASH.IP',     name: 'JPMorgan'     },
  { epic: 'UA.D.V.CASH.IP',       name: 'Visa'         },
  { epic: 'UA.D.UNH.CASH.IP',     name: 'UnitedHealth' },
  { epic: 'UA.D.XOM.CASH.IP',     name: 'ExxonMobil'   },
  // Semiconductor / storage / legacy tech — added for the sector's characteristically
  // sharp trend moves (rally-then-reversal), which is exactly what the
  // trend-following strategies (Donchian/EMA/MACD) are built to catch.
  { epic: 'SA.D.AMD.DAILY.IP',    name: 'AMD'          },
  { epic: 'UA.D.AVGO.DAILY.IP',   name: 'Broadcom'     },
  { epic: 'UB.D.INTC.DAILY.IP',   name: 'Intel'        },
  { epic: 'UC.D.QCOM.DAILY.IP',   name: 'Qualcomm'     },
  { epic: 'UC.D.MU.DAILY.IP',     name: 'Micron'       },
  { epic: 'SG.D.TSM.DAILY.IP',    name: 'TSMC'         },
  { epic: 'UD.D.SNDKUS.DAILY.IP', name: 'SanDisk'      },
  { epic: 'UD.D.STX.DAILY.IP',    name: 'Seagate'      },
  { epic: 'UC.D.MRVL.DAILY.IP',   name: 'Marvell'      },
  { epic: 'UD.D.SKHYUS.DAILY.IP', name: 'SK Hynix'     },
  { epic: 'UD.D.WDC.DAILY.IP',    name: 'Western Digital' },
  { epic: 'SB.D.DELLUS.DAILY.IP', name: 'Dell'         },
  { epic: 'UC.D.RIMM.DAILY.IP',   name: 'BlackBerry'   },
  { epic: 'EC.D.NOKIAFP.DAILY.IP', name: 'Nokia'       },
  // Major UK stocks
  { epic: 'UC.D.BARC.CASH.IP',    name: 'Barclays'     },
  { epic: 'UC.D.BP.CASH.IP',      name: 'BP'           },
  { epic: 'UC.D.HSBA.CASH.IP',    name: 'HSBC'         },
  { epic: 'UC.D.SHEL.CASH.IP',    name: 'Shell'        },
  { epic: 'UC.D.GSK.CASH.IP',     name: 'GSK'          },
  { epic: 'UC.D.AZN.CASH.IP',     name: 'AstraZeneca'  },
  { epic: 'UC.D.LLOY.CASH.IP',    name: 'Lloyds'       },
];

// ── IG resolution per strategy ────────────────────────────────────────────────

const SCAN_RESOLUTION: Record<IgStrategyName, { resolution: string; count: number }> = {
  rsi_mean_reversion: { resolution: 'MINUTE_5', count: 60 },
  ema_crossover:      { resolution: 'DAY',       count: 30 },
  orb:                { resolution: 'MINUTE_5',  count: 60 },
  vwap:               { resolution: 'MINUTE',    count: 60 },
  weekly_momentum:    { resolution: 'WEEK',       count: 20 },
  donchian_breakout:  { resolution: 'DAY',       count: 40 },
  donchian_hourly:    { resolution: 'HOUR',       count: 40 },
  macd_crossover:     { resolution: 'DAY',       count: 50 },
};

// ── Bar conversion ────────────────────────────────────────────────────────────

function igBarToAlpacaBar(b: CandleBar): AlpacaBar {
  return {
    t: b.snapshotTime,
    o: b.openPrice.mid  ?? b.openPrice.bid,
    h: b.highPrice.mid  ?? b.highPrice.bid,
    l: b.lowPrice.mid   ?? b.lowPrice.bid,
    c: b.closePrice.mid ?? b.closePrice.bid,
    v: 0,
  };
}

// ── Per-strategy scorers (mirrors alpacaScanner logic) ────────────────────────

type Scored = { epic: string; name: string; score: number };

function scoreRsi(bars: AlpacaBar[], epic: string, name: string): Scored {
  if (bars.length < 20) return { epic, name, score: -1 };
  const rsi = calcRsi(bars);
  if (rsi === null) return { epic, name, score: -1 };
  return { epic, name, score: Math.abs(rsi - 50) };
}

function scoreEma(bars: AlpacaBar[], epic: string, name: string): Scored {
  if (bars.length < 25) return { epic, name, score: -1 };
  const closes = bars.map(b => b.c);
  const ema9   = calcEma(closes, 9);
  const ema21  = calcEma(closes, 21);
  if (ema9.length < 2 || ema21.length < 2) return { epic, name, score: -1 };
  const last9  = ema9[ema9.length - 1];
  const last21 = ema21[ema21.length - 1];
  const prev9  = ema9[ema9.length - 2]  ?? last9;
  const prev21 = ema21[ema21.length - 2] ?? last21;
  const crossed = (last9 > last21 && prev9 <= prev21) || (last9 < last21 && prev9 >= prev21);
  const sep     = Math.abs(last9 - last21) / last21 * 100;
  return { epic, name, score: (crossed ? 40 : 0) + sep * 10 };
}

function scoreOrb(bars: AlpacaBar[], epic: string, name: string): Scored {
  if (bars.length < 10) return { epic, name, score: -1 };
  const recent    = bars.slice(-10);
  const avgVol    = bars.slice(0, -10).reduce((s, b) => s + b.v, 0) / Math.max(bars.length - 10, 1);
  const recentVol = recent.reduce((s, b) => s + b.v, 0) / recent.length;
  const relVol    = avgVol > 0 ? recentVol / avgVol : 1;
  const atr       = calcAtr(bars);
  const atrPct    = atr && bars[bars.length - 1].c > 0 ? (atr / bars[bars.length - 1].c) * 100 : 0;
  return { epic, name, score: relVol * 20 + atrPct * 5 };
}

function scoreVwap(bars: AlpacaBar[], epic: string, name: string): Scored {
  if (bars.length < 20) return { epic, name, score: -1 };
  const vwap = calcVwap(bars);
  if (!vwap) return { epic, name, score: -1 };
  const price  = bars[bars.length - 1].c;
  const devPct = Math.abs(price - vwap) / vwap * 100;
  return { epic, name, score: devPct * 10 };
}

function scoreWeekly(bars: AlpacaBar[], epic: string, name: string): Scored {
  if (bars.length < 15) return { epic, name, score: -1 };
  const sma12 = calcSma(bars, 12);
  if (!sma12) return { epic, name, score: -1 };
  const price = bars[bars.length - 1].c;
  if (price < sma12) return { epic, name, score: 0 };
  const mom = (price - (bars[bars.length - 4]?.c ?? price)) / (bars[bars.length - 4]?.c ?? price) * 100;
  return { epic, name, score: (price / sma12 - 1) * 100 + Math.max(0, mom) };
}

function scoreDonchian(bars: AlpacaBar[], epic: string, name: string): Scored {
  if (bars.length < 21) return { epic, name, score: -1 };
  const n = bars.length;
  const window = bars.slice(n - 21, n - 1);
  const last = bars[n - 1].c;
  const high = Math.max(...window.map(b => b.h));
  const low  = Math.min(...window.map(b => b.l));
  // Positive = already broken out (favour these); negative = how close to breaking
  const proximity = Math.max((last - high) / high * 100, (low - last) / low * 100);
  return { epic, name, score: proximity > 0 ? 50 + proximity * 20 : 20 + proximity };
}

function scoreMacd(bars: AlpacaBar[], epic: string, name: string): Scored {
  const macd = calcMacdHist(bars);
  if (!macd) return { epic, name, score: -1 };
  const crossed = (macd.hist > 0 && macd.prevHist <= 0) || (macd.hist < 0 && macd.prevHist >= 0);
  const momentum = Math.abs(macd.hist - macd.prevHist);
  return { epic, name, score: (crossed ? 40 : 0) + momentum * 1000 };
}

// Every strategy scores off free Alpaca/Yahoo bars instead of IG's allowance-
// limited candle API — a 44-epic scan was burning a meaningful chunk of IG's
// weekly historical-data allowance on every bot start or strategy switch, on
// top of the per-poll confirm calls, and a 30-call IG scan alone was enough
// to trip the account-wide non-trading allowance and lock the whole account
// out for several minutes (confirmed live) — not something worth risking
// even once per strategy. EPIC_TO_YAHOO covers the full IG_EPICS universe,
// so every strategy can scan for free; per-strategy timeframe/interval is
// looked up below instead of defaulting every strategy to daily bars.
const YAHOO_SCAN_STRATEGIES = new Set<IgStrategyName>([
  'donchian_breakout', 'donchian_hourly', 'ema_crossover', 'macd_crossover',
  'rsi_mean_reversion', 'orb', 'vwap', 'weekly_momentum',
]);

// vwap/orb/rsi_mean_reversion are all timeframe 'intraday' — igStrategyBot.ts's
// poll() gates the *entire* cycle on isNYSEOpen() for these, not per-epic. A
// non-Alpaca epic (different exchange, different real trading hours) gets
// zero benefit from a watchlist slot: it's blocked by the NYSE-hours gate
// exactly the same as everything else, but without free data or Gemini
// confirmation on top. Restricting these strategies to Alpaca-covered epics
// only means every watched slot is actually usable during the one window
// the bot ever polls intraday strategies in.
const ALPACA_ONLY_STRATEGIES = new Set<IgStrategyName>(['vwap', 'orb', 'rsi_mean_reversion']);

// Mirrors igStrategyBot.ts's FREE_DATA_PARAMS — duplicated rather than
// imported to avoid a circular import (igStrategyBot.ts already imports
// scanIgEpics from this file).
const SCAN_FREE_PARAMS: Partial<Record<IgStrategyName, { range: string; alpacaTimeframe: '1Min' | '5Min' | '1Hour' | '1Week'; yahooInterval: '1m' | '5m' | '1h' | '1wk' }>> = {
  rsi_mean_reversion: { range: '1mo', alpacaTimeframe: '5Min', yahooInterval: '5m' },
  orb:                { range: '5d',  alpacaTimeframe: '1Min', yahooInterval: '1m' },
  vwap:               { range: '5d',  alpacaTimeframe: '1Min', yahooInterval: '1m' },
  weekly_momentum:    { range: '5y',  alpacaTimeframe: '1Week', yahooInterval: '1wk' },
  donchian_hourly:    { range: '1mo', alpacaTimeframe: '1Hour', yahooInterval: '1h' },
};

// Volatility-matched routing — a fast (hourly) strategy wants instruments
// that actually move enough intraday to matter; a slow (daily) strategy
// wants calmer ones, since extreme volatility on a multi-day hold is what
// blew stop-sizing past the loss ceiling repeatedly on semiconductors
// today (SanDisk/Micron/AMD etc — confirmed live, ATR-implied stops came
// out 5-9x the instrument's own price). Rather than a hard filter, this
// scales the score so the "right" timeframe for an instrument's own
// volatility naturally outranks the "wrong" one instead of excluding
// anything outright — a calm stock can still win a slot on the daily
// strategy if nothing more volatile is currently breaking out.
function volatilityMultiplier(strategy: IgStrategyName, bars: AlpacaBar[]): number {
  if (strategy !== 'donchian_breakout' && strategy !== 'donchian_hourly') return 1;
  if (!bars.length) return 1;
  const atr      = calcAtr(bars);
  const price    = bars[bars.length - 1].c;
  if (!atr || price <= 0) return 1;
  const atrPct = (atr / price) * 100;

  if (strategy === 'donchian_hourly') {
    // Hourly wants movement — a name barely moving intraday just gets
    // chopped by noise. Penalize (not exclude) anything too calm.
    return atrPct < 1.5 ? 0.4 : 1;
  }
  // donchian_breakout (daily) wants steadier multi-day trends — extreme
  // volatility is exactly what's been forcing the loss-ceiling to skip
  // entries all day. Penalize (not exclude) anything this hot.
  return atrPct > 4 ? 0.4 : 1;
}

// Shared with the recommendations feature in igStrategyBot.ts, which needs
// the same conviction score to rank "best pick of the day" — not just a
// bare BUY/SELL, since more than one instrument can have a live signal at
// once and only the strongest is worth a single daily highlight.
export function scoreForStrategy(strategy: IgStrategyName, bars: AlpacaBar[], epic: string, name: string): number {
  const base = (() => {
    switch (strategy) {
      case 'rsi_mean_reversion': return scoreRsi(bars, epic, name).score;
      case 'ema_crossover':      return scoreEma(bars, epic, name).score;
      case 'orb':                return scoreOrb(bars, epic, name).score;
      case 'vwap':               return scoreVwap(bars, epic, name).score;
      case 'weekly_momentum':    return scoreWeekly(bars, epic, name).score;
      case 'donchian_breakout':  return scoreDonchian(bars, epic, name).score;
      case 'donchian_hourly':    return scoreDonchian(bars, epic, name).score;
      case 'macd_crossover':     return scoreMacd(bars, epic, name).score;
      default:                   return -1;
    }
  })();
  return base <= 0 ? base : base * volatilityMultiplier(strategy, bars);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function scanIgEpics(
  strategy: IgStrategyName,
  session:  IGSession,
  exclude:  string[],
  count:    number,
  log:      (msg: string) => void = console.log,
): Promise<string[]> {
  const alpacaOnly = ALPACA_ONLY_STRATEGIES.has(strategy);
  const pool = IG_EPICS.filter(e => !exclude.includes(e.epic) && (!alpacaOnly || e.epic in EPIC_TO_ALPACA));
  const useYahoo = YAHOO_SCAN_STRATEGIES.has(strategy);
  log(`[ig-scanner] Fetching bars for ${pool.length} epics (strategy: ${strategy}, source: ${useYahoo ? 'yahoo (free)' : 'ig'})…`);

  const { resolution, count: barCount } = SCAN_RESOLUTION[strategy];
  const scored: Scored[] = [];

  const freeParams = SCAN_FREE_PARAMS[strategy];
  for (const { epic, name } of pool) {
    try {
      const bars = useYahoo
        ? freeParams
          ? await fetchBarsWithFallback(epic, freeParams.range, freeParams) ?? []
          : await fetchBarsWithFallback(epic, '6mo') ?? []
        : (await fetchCandleHistory(session, epic, resolution, barCount)).map(igBarToAlpacaBar);
      scored.push({ epic, name, score: scoreForStrategy(strategy, bars, epic, name) });
    } catch {
      // Epic unavailable or market closed — skip silently
    }
    // IG's non-trading allowance is exceeded (403 error.public-api.exceeded-*-allowance)
    // by a 30-call scan at 150ms spacing — confirmed empirically, and once tripped it
    // doesn't clear for a while, taking the whole account (not just the scan) down with
    // it for the next several minutes. Yahoo has no such allowance, so only throttle
    // when actually calling IG.
    await new Promise(r => setTimeout(r, useYahoo ? 250 : 1200));
  }

  let top = scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, count);

  // When IG's own historical-data allowance is exhausted, only Alpaca-covered
  // epics can actually get their entry signal confirmed and sized (see
  // evaluateEpic in igStrategyBot.ts) — everything else just sits unconfirmed.
  // A pure top-score list can end up with zero Alpaca-covered picks purely by
  // chance (exactly what happened live: SK Hynix/FX/indices outscored every
  // share this cycle), leaving the bot watching instruments it can't actually
  // act on. Guarantee at least half the slots are Alpaca-covered when enough
  // scored candidates exist, swapping in the best-scoring ones that didn't
  // make the raw cut rather than leaving the list to chance.
  const minAlpaca = Math.ceil(count / 2);
  const alpacaInTop = top.filter(s => s.epic in EPIC_TO_ALPACA).length;
  if (alpacaInTop < minAlpaca) {
    // No score>0 floor here deliberately — an Alpaca-covered epic sitting at
    // a middling/negative score is still confirmable right now, which beats
    // an IG-only epic that can't be confirmed at all while the allowance is
    // exhausted, regardless of how good that epic's raw score looks.
    const alpacaCandidates = scored
      .filter(s => s.epic in EPIC_TO_ALPACA && s.score !== -1 && !top.some(t => t.epic === s.epic))
      .sort((a, b) => b.score - a.score);
    const need = minAlpaca - alpacaInTop;
    const nonAlpaca = top.filter(s => !(s.epic in EPIC_TO_ALPACA));
    const alreadyAlpaca = top.filter(s => s.epic in EPIC_TO_ALPACA);
    const backfilled = alpacaCandidates.slice(0, need);
    // Drop the lowest-scoring non-Alpaca picks to make room, keeping the list length stable.
    const trimmedNonAlpaca = nonAlpaca.sort((a, b) => b.score - a.score).slice(0, Math.max(0, count - alreadyAlpaca.length - backfilled.length));
    top = [...alreadyAlpaca, ...backfilled, ...trimmedNonAlpaca].sort((a, b) => b.score - a.score);
  }

  log(`[ig-scanner] Best picks: ${top.map(s => `${s.name}(${s.score.toFixed(1)}${s.epic in EPIC_TO_ALPACA ? ', alpaca' : ''})`).join(', ') || 'none'}`);
  return top.length >= count
    ? top.map(s => s.epic)
    : [...top.map(s => s.epic), ...pool.map(e => e.epic).filter(e => !top.some(t => t.epic === e)).slice(0, count - top.length)];
}

export function epicName(epic: string): string {
  return IG_EPICS.find(e => e.epic === epic)?.name ?? epic.split('.').slice(0, 3).join('.');
}

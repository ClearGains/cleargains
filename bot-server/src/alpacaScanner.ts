import { getBars, getSnapshots, type AccountMode, type AlpacaBar } from './alpacaApi';
import { calcRsi, calcEma, calcAtr, calcVwap, calcSma } from './alpacaStrategies';
import type { StrategyName } from './alpacaStrategies';

// ── Broad universe (~300 liquid US stocks + ETFs) ─────────────────────────────

const UNIVERSE: string[] = [
  // Broad market & sector ETFs
  'SPY','QQQ','IWM','DIA','VTI','VXX',
  'XLK','XLF','XLE','XLV','XLI','XLY','XLP','XLU','XLB','XLRE',
  'GLD','SLV','TLT','HYG','LQD','EEM','EFA',
  // Mega-cap tech
  'AAPL','MSFT','NVDA','GOOGL','GOOG','AMZN','META','TSLA','AVGO','ORCL',
  'CRM','ADBE','NFLX','CSCO','AMD','INTC','QCOM','TXN','AMAT','LRCX',
  'MU','MRVL','KLAC','SNPS','CDNS','ANSS','FTNT','PANW','CRWD','ZS',
  // Finance
  'JPM','BAC','WFC','GS','MS','C','BLK','BX','KKR','AXP',
  'V','MA','PYPL','SQ','COF','USB','PNC','TFC','SCHW','CME',
  // Healthcare
  'UNH','JNJ','ABBV','LLY','MRK','PFE','TMO','ABT','DHR','BMY',
  'AMGN','GILD','ISRG','SYK','BSX','MDT','CVS','CI','HUM','ELV',
  // Consumer
  'WMT','AMZN','HD','COST','TGT','LOW','MCD','SBUX','NKE','LULU',
  'YUM','CMG','DG','DLTR','ROST','TJX','EBAY','ETSY','W','CHWY',
  // Energy
  'XOM','CVX','COP','EOG','SLB','MPC','VLO','PSX','OXY','HAL',
  'DVN','FANG','APA','HES','BKR','WMB','KMI','ET','EPD','MMP',
  // Industrials
  'CAT','BA','HON','GE','UPS','FDX','DE','EMR','ETN','PH',
  'ROK','IR','AME','CTAS','RSG','WM','VRSK','CPRT','ODFL','JBHT',
  // Communication
  'GOOGL','META','DIS','CMCSA','T','VZ','TMUS','CHTR','NFLX','SNAP',
  'PINS','RDDT','MTCH','ZM','RBLX','EA','TTWO','ATVI',
  // Real estate / utilities
  'AMT','PLD','EQIX','CCI','PSA','O','WELL','AVB','EQR','DLR',
  'NEE','DUK','SO','AEP','XEL','PCG','EXC','SRE','D','ES',
  // Growth / momentum
  'UBER','LYFT','ABNB','COIN','PLTR','HOOD','SOFI','AFRM','UPST','OPENDOOR',
  'SHOP','MELI','SEA','BIDU','JD','PDD','BABA','NIO','RIVN','LCID',
  // Semis & hardware
  'TSM','ASML','NXPI','ON','STX','WDC','NTAP','HPE','HPQ','DELL',
  'NET','DDOG','MDB','SNOW','TEAM','HUBS','VEEV','WDAY','NOW','ADSK',
  // Biotech / pharma
  'MRNA','BNTX','REGN','VRTX','BIIB','ALNY','INCY','SGEN','EXAS','ILMN',
].filter((v, i, a) => a.indexOf(v) === i); // dedupe

// Liquidity thresholds for snapshot pre-filter
const MIN_PRICE  = 5;     // ignore penny stocks
const MAX_PRICE  = 2000;  // ignore Berkshire-style outliers
const MIN_VOLUME = 300_000; // min daily volume

// ── Stage 1: snapshot pre-filter ─────────────────────────────────────────────
// Returns the top `keep` symbols by dollar volume (price × daily volume)

async function liquidFilter(
  symbols: string[],
  mode:    AccountMode,
  keep:    number,
): Promise<string[]> {
  const snaps = await getSnapshots(symbols, mode);

  return symbols
    .map(sym => {
      const s     = snaps[sym];
      const price = s?.latestTrade?.p ?? s?.dailyBar?.c ?? 0;
      const vol   = s?.dailyBar?.v ?? 0;
      return { sym, dollarVol: price * vol, price };
    })
    .filter(x => x.price >= MIN_PRICE && x.price <= MAX_PRICE && x.dollarVol >= MIN_PRICE * MIN_VOLUME)
    .sort((a, b) => b.dollarVol - a.dollarVol)
    .slice(0, keep)
    .map(x => x.sym);
}

// ── Stage 2: detailed bar fetch ───────────────────────────────────────────────

const BARS_BATCH = 15;

async function fetchBatched(
  symbols:   string[],
  timeframe: Parameters<typeof getBars>[1],
  limit:     number,
  mode:      AccountMode,
): Promise<Record<string, AlpacaBar[]>> {
  const result: Record<string, AlpacaBar[]> = {};
  for (let i = 0; i < symbols.length; i += BARS_BATCH) {
    const batch = symbols.slice(i, i + BARS_BATCH);
    try {
      const bars = await getBars(batch, timeframe, limit, mode);
      Object.assign(result, bars);
    } catch {}
    if (i + BARS_BATCH < symbols.length) await new Promise(r => setTimeout(r, 300));
  }
  return result;
}

// ── Per-strategy scorers ──────────────────────────────────────────────────────

type Scored = { symbol: string; score: number };

function scoreRsiMeanReversion(barsMap: Record<string, AlpacaBar[]>): Scored[] {
  return Object.entries(barsMap).map(([symbol, bars]) => {
    if (bars.length < 20) return { symbol, score: -1 };
    const rsi = calcRsi(bars);
    if (rsi === null) return { symbol, score: -1 };
    return { symbol, score: Math.abs(rsi - 50) };
  });
}

function scoreEmaCrossover(barsMap: Record<string, AlpacaBar[]>): Scored[] {
  return Object.entries(barsMap).map(([symbol, bars]) => {
    if (bars.length < 25) return { symbol, score: -1 };
    const closes = bars.map(b => b.c);
    const ema9   = calcEma(closes, 9);
    const ema21  = calcEma(closes, 21);
    if (!ema9.length || !ema21.length) return { symbol, score: -1 };
    const last9  = ema9[ema9.length - 1];
    const last21 = ema21[ema21.length - 1];
    const prev9  = ema9[ema9.length - 2]  ?? last9;
    const prev21 = ema21[ema21.length - 2] ?? last21;
    const crossed = (last9 > last21 && prev9 <= prev21) || (last9 < last21 && prev9 >= prev21);
    const sep     = Math.abs(last9 - last21) / last21 * 100;
    return { symbol, score: (crossed ? 40 : 0) + sep * 10 };
  });
}

function scoreOrb(barsMap: Record<string, AlpacaBar[]>): Scored[] {
  return Object.entries(barsMap).map(([symbol, bars]) => {
    if (bars.length < 10) return { symbol, score: -1 };
    const recent    = bars.slice(-10);
    const avgVol    = bars.slice(0, -10).reduce((s, b) => s + b.v, 0) / Math.max(bars.length - 10, 1);
    const recentVol = recent.reduce((s, b) => s + b.v, 0) / recent.length;
    const relVol    = avgVol > 0 ? recentVol / avgVol : 1;
    const atr       = calcAtr(bars);
    const atrPct    = atr && bars[bars.length - 1].c > 0 ? (atr / bars[bars.length - 1].c) * 100 : 0;
    return { symbol, score: relVol * 20 + atrPct * 5 };
  });
}

function scoreVwap(barsMap: Record<string, AlpacaBar[]>): Scored[] {
  return Object.entries(barsMap).map(([symbol, bars]) => {
    if (bars.length < 20) return { symbol, score: -1 };
    const vwap = calcVwap(bars);
    if (!vwap) return { symbol, score: -1 };
    const price  = bars[bars.length - 1].c;
    const devPct = Math.abs(price - vwap) / vwap * 100;
    return { symbol, score: devPct * 10 };
  });
}

function scoreWeeklyMomentum(barsMap: Record<string, AlpacaBar[]>): Scored[] {
  return Object.entries(barsMap).map(([symbol, bars]) => {
    if (bars.length < 15) return { symbol, score: -1 };
    const sma12 = calcSma(bars, 12);
    if (!sma12) return { symbol, score: -1 };
    const price = bars[bars.length - 1].c;
    if (price < sma12) return { symbol, score: 0 };
    const mom = (price - (bars[bars.length - 4]?.c ?? price)) / (bars[bars.length - 4]?.c ?? price) * 100;
    return { symbol, score: (price / sma12 - 1) * 100 + Math.max(0, mom) };
  });
}

function scoreOptionsDirectional(barsMap: Record<string, AlpacaBar[]>): Scored[] {
  return Object.entries(barsMap).map(([symbol, bars]) => {
    if (bars.length < 20) return { symbol, score: -1 };
    const rsi = calcRsi(bars);
    if (rsi === null) return { symbol, score: -1 };
    // Score by how extreme RSI is — further from 50 = more likely to get an options signal
    const extremeness = Math.abs(rsi - 50);
    if (extremeness < 20) return { symbol, score: 0 }; // RSI 30–70: not extreme enough
    const atr    = calcAtr(bars);
    const price  = bars[bars.length - 1].c;
    const atrPct = atr && price > 0 ? (atr / price) * 100 : 0;
    // Prefer liquid, volatile stocks where options have tighter spreads
    return { symbol, score: extremeness * 2 + atrPct * 5 };
  });
}

// ── Diversification filter ────────────────────────────────────────────────────
// Scoring alone ranks by signal strength only — nothing stops the bot ending
// up simultaneously long 3 correlated momentum names. Greedily skip a
// candidate whose return series correlates too strongly with an already-picked
// symbol, using the same bars already fetched for scoring (no extra API calls).

const CORRELATION_LIMIT = 0.75;
const MIN_OVERLAP        = 5; // too few shared bars to trust a correlation — don't block on it

function periodReturns(bars: AlpacaBar[]): number[] {
  const rets: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].c;
    if (prev > 0) rets.push((bars[i].c - prev) / prev);
  }
  return rets;
}

function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < MIN_OVERLAP) return 0;
  const av = a.slice(-n), bv = b.slice(-n);
  const meanA = av.reduce((s, v) => s + v, 0) / n;
  const meanB = bv.reduce((s, v) => s + v, 0) / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = av[i] - meanA, db = bv[i] - meanB;
    cov += da * db; va += da * da; vb += db * db;
  }
  const denom = Math.sqrt(va * vb);
  return denom > 0 ? cov / denom : 0;
}

function selectDiversified(
  ranked:  Scored[],
  barsMap: Record<string, AlpacaBar[]>,
  count:   number,
): { picks: string[]; skipped: number } {
  const returns = new Map<string, number[]>();
  for (const r of ranked) returns.set(r.symbol, periodReturns(barsMap[r.symbol] ?? []));

  const picks: string[] = [];
  let skipped = 0;
  for (const cand of ranked) {
    if (picks.length >= count) break;
    const candRet = returns.get(cand.symbol) ?? [];
    const tooCorrelated = picks.some(p => Math.abs(correlation(candRet, returns.get(p) ?? [])) > CORRELATION_LIMIT);
    if (tooCorrelated) { skipped++; continue; }
    picks.push(cand.symbol);
  }
  return { picks, skipped };
}

// ── Public API ────────────────────────────────────────────────────────────────

const TIMEFRAME: Record<StrategyName, { tf: Parameters<typeof getBars>[1]; limit: number }> = {
  rsi_mean_reversion:  { tf: '5Min',  limit: 50 },
  ema_crossover:       { tf: '1Day',  limit: 30 },
  orb:                 { tf: '5Min',  limit: 60 },
  vwap:                { tf: '1Min',  limit: 60 },
  weekly_momentum:     { tf: '1Week', limit: 16 },
  options_directional: { tf: '5Min',  limit: 60 },
  donchian_breakout:   { tf: '1Day',  limit: 30 },
  donchian_hourly:     { tf: '1Hour', limit: 40 },
  macd_crossover:      { tf: '1Day',  limit: 40 },
  pivot_points:        { tf: '1Day',  limit: 30 },
  gemini_opinion:      { tf: '1Hour', limit: 40 },
  rule_based_analysis: { tf: '1Day',  limit: 260 }, // needs ~250 for its SMA200 trend filter, see alpacaStrategies.ts
};

/**
 * Two-stage scan:
 *  1. Snapshot filter — 3 API calls for 300 stocks → top 50 by dollar volume
 *  2. Bars + scoring  — 4 batched calls for 50 stocks → top `count` by strategy score
 */
export async function scanForBestSymbols(
  strategy: StrategyName,
  mode:     AccountMode,
  exclude:  string[],
  count:    number,
  log:      (msg: string) => void = console.log,
): Promise<string[]> {
  const pool = UNIVERSE.filter(s => !exclude.includes(s));
  log(`[scanner] Stage 1: snapshot filter across ${pool.length} symbols…`);

  const liquid = await liquidFilter(pool, mode, 50).catch(() => pool.slice(0, 50));
  log(`[scanner] Stage 2: scoring top ${liquid.length} liquid stocks for ${strategy}…`);

  const { tf, limit } = TIMEFRAME[strategy];
  const barsMap = await fetchBatched(liquid, tf, limit, mode);

  let scored: Scored[];
  switch (strategy) {
    case 'rsi_mean_reversion':  scored = scoreRsiMeanReversion(barsMap);  break;
    case 'ema_crossover':       scored = scoreEmaCrossover(barsMap);      break;
    case 'orb':                 scored = scoreOrb(barsMap);               break;
    case 'vwap':                scored = scoreVwap(barsMap);              break;
    case 'weekly_momentum':     scored = scoreWeeklyMomentum(barsMap);    break;
    case 'options_directional': scored = scoreOptionsDirectional(barsMap); break;
    default: return liquid.slice(0, count);
  }

  const ranked = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score);
  const { picks: top, skipped } = selectDiversified(ranked, barsMap, count);
  if (skipped) log(`[scanner] Diversification: skipped ${skipped} candidate(s) correlated >${CORRELATION_LIMIT} with an already-picked symbol`);

  log(`[scanner] Best picks: ${top.join(', ') || 'none — falling back to liquid top'}`);
  if (top.length >= count) return top;
  // Backfill with the most liquid names not already picked
  const backfill = liquid.filter(s => !top.includes(s)).slice(0, count - top.length);
  return [...top, ...backfill];
}

import { summarizeIndicators, type LWCandle } from './chartIndicators';
import { calcSupportResistance } from './supportResistance';

// Inlined from the main app's app/api/analyse/chart/route.ts — kept in
// sync by hand, this file is a deliberate port (see the "why don't we add
// that rule-based strategy" integration, 2026-08-15), not a shared package.
export type TradeRec = {
  timeframe: 'scalp' | 'swing';
  direction: 'LONG' | 'SHORT' | 'FLAT';
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  riskReward: number;
  confidence: number;
  reasoning: string;
  invalidation: string;
};

export type AnalysisResult = {
  ticker: string;
  price: number;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  summary: string;
  keyLevels: { label: string; price: number; type: 'support' | 'resistance' }[];
  scalp: TradeRec;
  swing: TradeRec;
  risks: string[];
  catalysts: string[];
};

function estimateATR(candles: LWCandle[], period = 14): number {
  const slice = candles.slice(-period - 1);
  if (slice.length < 2) return Number(candles[candles.length - 1]?.close ?? 1) * 0.01;
  let total = 0;
  for (let i = 1; i < slice.length; i++) {
    const c    = slice[i];
    const prev = slice[i - 1];
    total += Math.max(
      Number(c.high) - Number(c.low),
      Math.abs(Number(c.high) - Number(prev.close)),
      Math.abs(Number(c.low)  - Number(prev.close)),
    );
  }
  return total / (slice.length - 1);
}

function round(n: number, price: number): number {
  // Round to same decimal precision as the price
  const decimals = price < 1 ? 6 : price < 10 ? 4 : price < 1000 ? 2 : 0;
  return parseFloat(n.toFixed(decimals));
}

export function ruleBasedAnalysis(ticker: string, candles: LWCandle[]): AnalysisResult {
  const ind   = summarizeIndicators(candles);
  const sr    = calcSupportResistance(candles);
  const last  = candles[candles.length - 1];
  const price = Number(last.close);
  const atr   = estimateATR(candles);

  // ── Score bullish vs bearish ──────────────────────────────────────────────
  let bull = 0, bear = 0;
  const signals: string[] = [];

  if (ind.rsi !== null) {
    if (ind.rsi < 30)      { bull += 3; signals.push('RSI deeply oversold (<30)'); }
    else if (ind.rsi < 40) { bull += 1; signals.push('RSI approaching oversold zone'); }
    else if (ind.rsi > 70) { bear += 3; signals.push('RSI deeply overbought (>70)'); }
    else if (ind.rsi > 60) { bear += 1; signals.push('RSI elevated above 60'); }
    if (ind.rsiTrend === 'rising')  bull += 1;
    if (ind.rsiTrend === 'falling') bear += 1;
  }

  if (ind.macdCross === 'bullish') { bull += 3; signals.push('MACD bullish crossover confirmed'); }
  if (ind.macdCross === 'bearish') { bear += 3; signals.push('MACD bearish crossover confirmed'); }
  if (ind.macdHist > 0)            bull += 1;
  if (ind.macdHist < 0)            bear += 1;

  if (ind.sma20 !== null && ind.sma50 !== null) {
    if (price > ind.sma20 && ind.sma20 > ind.sma50) { bull += 2; signals.push('price above rising SMA20/50'); }
    if (price < ind.sma20 && ind.sma20 < ind.sma50) { bear += 2; signals.push('price below falling SMA20/50'); }
    else if (price > ind.sma20 && price < ind.sma50) { bear += 1; signals.push('price between SMAs — resistance above'); }
  }

  if (ind.priceVsBB === 'below') { bull += 2; signals.push('price at/below BB lower band'); }
  if (ind.priceVsBB === 'above') { bear += 2; signals.push('price at/above BB upper band'); }

  // Volume confirms which way the crowd is actually leaning — it doesn't
  // create a direction on its own (heavy volume with no other signal is
  // just as often capitulation/distribution as a real breakout), but it
  // does say whether the signals above are backed by real participation or
  // not. Only amplifies whichever side is already ahead; a tie stays a tie.
  let volNote = '';
  if (ind.volRatio !== null) {
    if (ind.volRatio >= 1.6) {
      if (bull > bear)      { bull += 2; volNote = `Volume running ${ind.volRatio.toFixed(1)}x average — real demand behind the bullish signals`; }
      else if (bear > bull) { bear += 2; volNote = `Volume running ${ind.volRatio.toFixed(1)}x average — real supply behind the bearish signals`; }
      if (volNote) signals.push(volNote);
    } else if (ind.volRatio <= 0.5) {
      volNote = `Volume only ${ind.volRatio.toFixed(1)}x average — this move lacks real participation, weight it less`;
      signals.push(volNote);
    }
  }

  // A name that's already made most of today's move before this signal even
  // fires is being chased into strength/weakness, not caught at the start
  // of it — confirmed live this matters (Uber bought at 78.51 on a day that
  // ranged 73.97-79.31, i.e. right near the day's own high, on a fairly
  // thin 5/10-confidence signal). Dampens whichever side is already
  // leading rather than vetoing outright — a genuinely strong setup with
  // several signals aligned still clears the bar; a marginal one riding
  // mostly on "it already moved today" gets pulled back toward neutral.
  let extensionNote = '';
  const todaysMovePct = Number(last.open) > 0 ? ((price - Number(last.open)) / Number(last.open)) * 100 : 0;
  const EXTENDED_TODAY_PCT = 4;
  if (todaysMovePct >= EXTENDED_TODAY_PCT && bull > bear) {
    bull -= 2;
    extensionNote = `Already up ${todaysMovePct.toFixed(1)}% just today — this would be chasing an extended move, not catching the start of one`;
    signals.push(extensionNote);
  } else if (todaysMovePct <= -EXTENDED_TODAY_PCT && bear > bull) {
    bear -= 2;
    extensionNote = `Already down ${todaysMovePct.toFixed(1)}% just today — this would be chasing an extended move, not catching the start of one`;
    signals.push(extensionNote);
  }

  const bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' =
    bull > bear + 2 ? 'BULLISH' : bear > bull + 2 ? 'BEARISH' : 'NEUTRAL';

  const scoreDiff = Math.abs(bull - bear);

  // Confidence scales from how one-sided the signals are:
  //   purity=0  (50/50 split) → core=1  (no conviction)
  //   purity=1  (all agree)   → core=7  (strong conviction)
  // Plus bonuses for high-quality signals (MACD cross, RSI extremes, signal count)
  function confidence(isScalp: boolean): number {
    const total  = bull + bear;
    const purity = total > 0 ? scoreDiff / total : 0;          // 0–1
    const core   = Math.round(1 + purity * 6);                 // 1–7
    const macdBonus  = ind.macdCross !== 'none' ? 2 : 0;
    const rsiBonus   = ind.rsi !== null && (ind.rsi < 35 || ind.rsi > 65) ? 1 : 0;
    const countBonus = signals.length >= 3 ? 1 : 0;
    const scalpBonus = isScalp ? 1 : 0;
    return Math.min(10, Math.max(1, core + macdBonus + rsiBonus + countBonus + scalpBonus));
  }

  // ── S/R levels ────────────────────────────────────────────────────────────
  const supports    = sr.filter(z => z.type === 'support').sort((a, b) => b.price - a.price);
  const resistances = sr.filter(z => z.type === 'resistance').sort((a, b) => a.price - b.price);

  const nearSup  = supports[0]?.price    ?? price - atr * 2;
  const farSup   = supports[1]?.price    ?? price - atr * 4;
  const nearRes  = resistances[0]?.price ?? price + atr * 2;
  const farRes   = resistances[1]?.price ?? price + atr * 4;

  // ── Build trade setups ────────────────────────────────────────────────────
  function makeScalp(): TradeRec {
    const dir: 'LONG' | 'SHORT' | 'FLAT' =
      bias === 'BULLISH' ? 'LONG' : bias === 'BEARISH' ? 'SHORT' : 'FLAT';

    let entry: number, sl: number, tp1: number, tp2: number;

    if (dir === 'LONG') {
      entry = price;
      sl    = round(Math.max(nearSup - atr * 0.3, price - atr * 1.2), price);
      tp1   = round(price + atr * 1.5, price);
      tp2   = round(nearRes > price + atr * 0.5 ? nearRes : price + atr * 2.5, price);
    } else if (dir === 'SHORT') {
      entry = price;
      sl    = round(Math.min(nearRes + atr * 0.3, price + atr * 1.2), price);
      tp1   = round(price - atr * 1.5, price);
      tp2   = round(nearSup < price - atr * 0.5 ? nearSup : price - atr * 2.5, price);
    } else {
      entry = price; sl = round(price - atr, price);
      tp1   = round(price + atr, price); tp2 = round(price + atr * 2, price);
    }

    const risk   = Math.abs(entry - sl)  || 1;
    const reward = Math.abs(tp1   - entry) || 1;

    return {
      timeframe: 'scalp',
      direction: dir,
      entry: round(entry, price),
      stopLoss: sl, takeProfit1: tp1, takeProfit2: tp2,
      riskReward: parseFloat((reward / risk).toFixed(2)),
      confidence: confidence(true),
      reasoning: `${bias} bias: ${signals.slice(0, 2).join('; ')}. Scalp targets ${dir === 'LONG' ? 'nearest resistance' : 'nearest support'} within 1–2 ATR.`,
      invalidation: dir === 'LONG'
        ? `Hourly close below ${sl} negates setup.`
        : dir === 'SHORT'
          ? `Hourly close above ${sl} negates setup.`
          : 'No clear bias — stand aside.',
    };
  }

  function makeSwing(): TradeRec {
    let dir: 'LONG' | 'SHORT' | 'FLAT' =
      bias === 'BULLISH' ? 'LONG' : bias === 'BEARISH' ? 'SHORT' : 'FLAT';

    // Trend filter — backtested 2026-08-15 across 27 instruments, 2 years
    // of daily bars, walk-forward with no lookahead: taking every raw
    // RSI/BB-driven swing signal as-is netted essentially zero edge
    // (480 trades, total R=1.02, avg 0.002R/trade) because the mean-
    // reversion logic above keeps firing counter-trend against strongly
    // trending names — confirmed live in the backtest as NVIDIA's exact
    // failure mode (11% win rate, -20R over 28 trades: repeatedly shorting
    // "overbought RSI" into a persistent uptrend). Refusing to fight an
    // established trend — SHORT while price is still well above its own
    // SMA200, or LONG while still well below it — took the same backtest
    // to 435 trades, total R=43.56, avg 0.10R/trade: a ~50x improvement,
    // and it helped on 15 of 27 instruments with only mild cost on a few
    // (Amazon, Lloyds). FX barely moves this filter since pairs rarely sit
    // 5%+ from their own SMA200 — it's mainly indices/commodities/shares.
    let trendFiltered = false;
    if (ind.sma200 !== null) {
      const band = ind.sma200 * 0.05;
      if (dir === 'SHORT' && price > ind.sma200 + band) { dir = 'FLAT'; trendFiltered = true; }
      if (dir === 'LONG'  && price < ind.sma200 - band) { dir = 'FLAT'; trendFiltered = true; }
    }

    // Near-high extension veto — a HARD block, not the same-day-only
    // extensionNote dampener above (which only knocks 2 points off the
    // score, letting a "confident enough" setup still clear the bar and
    // trade anyway). Confirmed live 2026-08-25: Visa and Ford got bought
    // and closed for a loss repeatedly. First attempt at this fix used a
    // cumulative % move threshold (8% over 5 trading days) — checked
    // against Visa's real price history and it would NOT have fired: its
    // 5/10/15/20/30-day moves were all under 7%. What was actually true is
    // sharper: Visa was sitting exactly AT its 3-month high (0.0% below
    // it) from a long, steady, low-volatility grind, with RSI pinned in
    // elevated-to-extreme territory precisely because there'd been so few
    // down days to reset it. A raw % move threshold misses a slow grind to
    // a fresh high entirely — proximity to a real recent high, combined
    // with RSI already elevated, is the actual signal. Distinct from the
    // SMA200 trend filter above too: that one stops the bot fighting an
    // established trend; this one stops it CHASING one that's already
    // sitting at the top of its own recent range, even in the "right"
    // direction. There's no "let it play out" theory that holds for an
    // entry made at the high with RSI already elevated.
    const NEAR_HIGH_LOOKBACK_DAYS = 60; // ~3 months of daily bars
    const NEAR_HIGH_PCT           = 3;  // within 3% of that lookback's high/low counts as "sitting at it"
    const EXTENDED_RSI            = 65; // "elevated" — matches this codebase's own existing "RSI elevated above 60" bar, not full textbook-overbought 70+
    let multiDayExtended = false;
    if (!trendFiltered && dir !== 'FLAT' && candles.length >= 10 && ind.rsi !== null) {
      const lookback     = candles.slice(-Math.min(NEAR_HIGH_LOOKBACK_DAYS, candles.length));
      const recentHigh   = Math.max(...lookback.map(c => Number(c.high)));
      const recentLow    = Math.min(...lookback.map(c => Number(c.low)));
      const pctBelowHigh = recentHigh > 0 ? ((recentHigh - price) / recentHigh) * 100 : 100;
      const pctAboveLow  = recentLow  > 0 ? ((price - recentLow) / recentLow) * 100 : 100;
      if (
        (dir === 'LONG'  && pctBelowHigh <= NEAR_HIGH_PCT && ind.rsi >= EXTENDED_RSI) ||
        (dir === 'SHORT' && pctAboveLow  <= NEAR_HIGH_PCT && ind.rsi <= (100 - EXTENDED_RSI))
      ) {
        dir = 'FLAT';
        multiDayExtended = true;
      }
    }

    let entry: number, sl: number, tp1: number, tp2: number;

    if (dir === 'LONG') {
      entry = price;
      sl    = round(nearSup - atr * 0.8, price);
      tp1   = round(farRes > price + atr ? farRes : price + atr * 4, price);
      tp2   = round(tp1 + atr * 3, price);
    } else if (dir === 'SHORT') {
      entry = price;
      sl    = round(nearRes + atr * 0.8, price);
      tp1   = round(farSup < price - atr ? farSup : price - atr * 4, price);
      tp2   = round(tp1 - atr * 3, price);
    } else {
      entry = price; sl = round(price - atr * 2, price);
      tp1   = round(price + atr * 2, price); tp2 = round(price + atr * 4, price);
    }

    const risk   = Math.abs(entry - sl)  || 1;
    const reward = Math.abs(tp1   - entry) || 1;

    return {
      timeframe: 'swing',
      direction: dir,
      entry: round(entry, price),
      stopLoss: sl, takeProfit1: tp1, takeProfit2: tp2,
      riskReward: parseFloat((reward / risk).toFixed(2)),
      confidence: confidence(false),
      reasoning: trendFiltered
        ? `${bias} bias from RSI/MACD/BB, but this would be a ${bias === 'BULLISH' ? 'LONG' : 'SHORT'} against price still well ${bias === 'BULLISH' ? 'below' : 'above'} its own SMA200 — standing aside rather than fighting the established trend.`
        : multiDayExtended
          ? `${bias} bias from RSI/MACD/BB, but the instrument is already sitting within ${NEAR_HIGH_PCT}% of its own ${NEAR_HIGH_LOOKBACK_DAYS}-day ${dir === 'LONG' ? 'high' : 'low'} with RSI already elevated — standing aside rather than chasing a move that's already largely played out.`
          : `Swing trade targets ${dir === 'LONG' ? 'upper S/R cluster' : 'lower S/R cluster'} over days–weeks. ${signals[0] ?? 'Mixed signals'} supports the ${bias.toLowerCase()} bias.`,
      invalidation: dir === 'LONG'
        ? `Daily close below ${sl} and loss of SMA20 invalidates.`
        : dir === 'SHORT'
          ? `Daily close above ${sl} invalidates.`
          : trendFiltered
            ? 'Would need price to reclaim the SMA200 trend before this setup is worth taking.'
            : multiDayExtended
              ? `Would need a real pullback off the recent extreme and RSI to reset before this is a fresh setup rather than a chase.`
              : 'No clear structure — wait for breakout confirmation.',
    };
  }

  // ── Key levels ────────────────────────────────────────────────────────────
  const keyLevels: AnalysisResult['keyLevels'] = [
    ...supports.slice(0, 3).map(z => ({
      label: `Support (${z.strength}×)`,
      price: round(z.price, price),
      type: 'support' as const,
    })),
    ...resistances.slice(0, 3).map(z => ({
      label: `Resistance (${z.strength}×)`,
      price: round(z.price, price),
      type: 'resistance' as const,
    })),
    ...(ind.sma20 ? [{ label: 'SMA 20', price: round(ind.sma20, price), type: (price > ind.sma20 ? 'support' : 'resistance') as 'support' | 'resistance' }] : []),
    ...(ind.sma50 ? [{ label: 'SMA 50', price: round(ind.sma50, price), type: (price > ind.sma50 ? 'support' : 'resistance') as 'support' | 'resistance' }] : []),
  ];

  // ── Summary ───────────────────────────────────────────────────────────────
  const trendDesc =
    bias === 'BULLISH' ? 'Bullish structure intact'
    : bias === 'BEARISH' ? 'Bearish pressure dominant'
    : 'Price in consolidation with no clear directional bias';

  const rsiDesc = ind.rsi !== null
    ? `RSI(14) at ${ind.rsi.toFixed(0)} is ${ind.rsi < 35 ? 'oversold' : ind.rsi > 65 ? 'overbought' : 'neutral'} and ${ind.rsiTrend}.`
    : '';

  const macdDesc = ind.macdCross !== 'none'
    ? `A ${ind.macdCross} MACD crossover has just fired.`
    : `MACD histogram is ${ind.macdHist > 0 ? 'positive (bullish momentum)' : 'negative (bearish momentum)'}.`;

  const summary = `${trendDesc}. ${signals[0] ? signals[0] + '.' : ''} ${rsiDesc} ${macdDesc}`.replace(/\s+/g, ' ').trim();

  // ── Risks & catalysts ─────────────────────────────────────────────────────
  const risks: string[] = [
    'Rule-based signals — confirm with your own analysis before trading',
    ind.bbWidth !== null && ind.bbWidth < 4
      ? 'Bollinger Band squeeze detected — breakout direction is uncertain'
      : 'Normal volatility environment — respect stop losses',
    bias === 'NEUTRAL' ? 'No clear trend — range-bound conditions increase false-signal risk' : 'Momentum trades can reverse sharply on news events',
    ...(ind.volRatio !== null && ind.volRatio <= 0.5 ? [volNote] : []),
    ...(extensionNote ? [extensionNote] : []),
  ];

  const catalysts: string[] = [
    ind.macdCross !== 'none'
      ? `${ind.macdCross.charAt(0).toUpperCase() + ind.macdCross.slice(1)} MACD crossover — momentum shift signal`
      : `MACD momentum is ${ind.macdHist > 0 ? 'building bullishly' : 'declining bearishly'}`,
    ind.rsi !== null && ind.rsi < 35
      ? 'Deeply oversold RSI — historically high probability of bounce'
      : ind.rsi !== null && ind.rsi > 65
        ? 'Overbought RSI — watch for mean reversion'
        : `SMA ${ind.sma20 && price > ind.sma20 ? 'support holding' : 'acting as resistance'}`,
    ...(ind.volRatio !== null && ind.volRatio >= 1.6 ? [volNote] : []),
  ];

  return {
    ticker,
    price,
    bias,
    summary,
    keyLevels,
    scalp: makeScalp(),
    swing: makeSwing(),
    risks,
    catalysts,
  };
}

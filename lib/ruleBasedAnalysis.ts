import { summarizeIndicators, type LWCandle } from './chartIndicators';
import { calcSupportResistance } from './supportResistance';
import type { AnalysisResult, TradeRec } from '@/app/api/analyse/chart/route';

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
        : `Swing trade targets ${dir === 'LONG' ? 'upper S/R cluster' : 'lower S/R cluster'} over days–weeks. ${signals[0] ?? 'Mixed signals'} supports the ${bias.toLowerCase()} bias.`,
      invalidation: dir === 'LONG'
        ? `Daily close below ${sl} and loss of SMA20 invalidates.`
        : dir === 'SHORT'
          ? `Daily close above ${sl} invalidates.`
          : trendFiltered
            ? 'Would need price to reclaim the SMA200 trend before this setup is worth taking.'
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

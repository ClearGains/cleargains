// Per-stock risk profiling and position-sizing for IG spread bets.
// Stop and target distances are returned in price points (same units as
// the spread-bet price), ready to pass directly as stopDistance /
// profitDistance in the /api/ig/order body.

export type VolatilityClass = 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH';

export type StockRiskProfile = {
  ticker:            string;
  sector:            string;
  volatilityClass:   VolatilityClass;
  beta:              number;
  atr:               number;    // average daily range as % of price
  // percentages (may be widened by news context)
  suggestedStopPct:    number;
  suggestedTargetPct:  number;
  maxPositionSizePct:  number;
  // derived from current price + above percentages
  stopDistance:    number;   // points — pass to IG as stopDistance
  targetDistance:  number;   // points — pass to IG as profitDistance
  stopPrice:       number;   // absolute level for display
  targetPrice:     number;   // absolute level for display
  // position sizing (£/pt) so that hitting the stop costs ≤ 1% of capital
  sizePerPoint:    number;
  maxRisk:         number;   // £ risk if stop hit
  targetProfit:    number;   // £ reward if target hit
  riskRewardRatio: number;
  reasoning:       string;
};

// ── Volatility profiles ────────────────────────────────────────────────────────
// beta: how much stock moves vs. market
// atr:  typical daily range as % of price
// suggestedStopPct / suggestedTargetPct: base values before news adjustment
// maxPositionSizePct: max position value as % of capital

const PROFILES: Record<string, {
  volatilityClass: VolatilityClass;
  beta:            number;
  atr:             number;
  suggestedStopPct:   number;
  suggestedTargetPct: number;
  maxPositionSizePct: number;
  sector:          string;
}> = {
  // ── Very High Volatility ───────────────────────────────────────────────────
  'TSLA': { volatilityClass: 'VERY_HIGH', beta: 2.0, atr: 3.5, suggestedStopPct: 4.0, suggestedTargetPct: 8.0, maxPositionSizePct: 3,  sector: 'Consumer Discretionary' },
  'NVDA': { volatilityClass: 'VERY_HIGH', beta: 1.9, atr: 3.2, suggestedStopPct: 4.0, suggestedTargetPct: 8.0, maxPositionSizePct: 3,  sector: 'Technology' },
  // ── High Volatility ────────────────────────────────────────────────────────
  'AMD':  { volatilityClass: 'HIGH', beta: 1.7, atr: 2.8, suggestedStopPct: 3.5, suggestedTargetPct: 7.0, maxPositionSizePct: 4,  sector: 'Technology' },
  'META': { volatilityClass: 'HIGH', beta: 1.4, atr: 2.2, suggestedStopPct: 3.0, suggestedTargetPct: 6.0, maxPositionSizePct: 5,  sector: 'Technology' },
  'AMZN': { volatilityClass: 'HIGH', beta: 1.3, atr: 2.0, suggestedStopPct: 3.0, suggestedTargetPct: 6.0, maxPositionSizePct: 5,  sector: 'Consumer Discretionary' },
  'NFLX': { volatilityClass: 'HIGH', beta: 1.3, atr: 2.5, suggestedStopPct: 3.5, suggestedTargetPct: 7.0, maxPositionSizePct: 4,  sector: 'Communication Services' },
  'BARC': { volatilityClass: 'HIGH', beta: 1.4, atr: 2.0, suggestedStopPct: 3.0, suggestedTargetPct: 6.0, maxPositionSizePct: 5,  sector: 'Financials' },
  'GS':   { volatilityClass: 'HIGH', beta: 1.4, atr: 1.8, suggestedStopPct: 3.0, suggestedTargetPct: 6.0, maxPositionSizePct: 5,  sector: 'Financials' },
  // ── Medium Volatility ──────────────────────────────────────────────────────
  'AAPL': { volatilityClass: 'MEDIUM', beta: 1.2, atr: 1.5, suggestedStopPct: 2.5, suggestedTargetPct: 5.0, maxPositionSizePct: 8,  sector: 'Technology' },
  'MSFT': { volatilityClass: 'MEDIUM', beta: 1.1, atr: 1.4, suggestedStopPct: 2.5, suggestedTargetPct: 5.0, maxPositionSizePct: 8,  sector: 'Technology' },
  'GOOGL':{ volatilityClass: 'MEDIUM', beta: 1.1, atr: 1.6, suggestedStopPct: 2.5, suggestedTargetPct: 5.0, maxPositionSizePct: 8,  sector: 'Technology' },
  'JPM':  { volatilityClass: 'MEDIUM', beta: 1.1, atr: 1.3, suggestedStopPct: 2.0, suggestedTargetPct: 4.0, maxPositionSizePct: 8,  sector: 'Financials' },
  'BAC':  { volatilityClass: 'MEDIUM', beta: 1.2, atr: 1.5, suggestedStopPct: 2.5, suggestedTargetPct: 5.0, maxPositionSizePct: 8,  sector: 'Financials' },
  'XOM':  { volatilityClass: 'MEDIUM', beta: 0.9, atr: 1.4, suggestedStopPct: 2.0, suggestedTargetPct: 4.0, maxPositionSizePct: 8,  sector: 'Energy' },
  'CVX':  { volatilityClass: 'MEDIUM', beta: 0.9, atr: 1.4, suggestedStopPct: 2.0, suggestedTargetPct: 4.0, maxPositionSizePct: 8,  sector: 'Energy' },
  'VOD':  { volatilityClass: 'MEDIUM', beta: 0.8, atr: 1.5, suggestedStopPct: 2.0, suggestedTargetPct: 4.0, maxPositionSizePct: 8,  sector: 'Communication Services' },
  'BP':   { volatilityClass: 'MEDIUM', beta: 0.9, atr: 1.6, suggestedStopPct: 2.5, suggestedTargetPct: 5.0, maxPositionSizePct: 8,  sector: 'Energy' },
  'SHEL': { volatilityClass: 'MEDIUM', beta: 0.8, atr: 1.5, suggestedStopPct: 2.0, suggestedTargetPct: 4.0, maxPositionSizePct: 8,  sector: 'Energy' },
  'HSBA': { volatilityClass: 'MEDIUM', beta: 0.9, atr: 1.4, suggestedStopPct: 2.0, suggestedTargetPct: 4.0, maxPositionSizePct: 8,  sector: 'Financials' },
  'LLOY': { volatilityClass: 'MEDIUM', beta: 1.0, atr: 1.6, suggestedStopPct: 2.5, suggestedTargetPct: 5.0, maxPositionSizePct: 8,  sector: 'Financials' },
  // ── Low Volatility ─────────────────────────────────────────────────────────
  'JNJ':  { volatilityClass: 'LOW', beta: 0.7, atr: 0.9, suggestedStopPct: 1.5, suggestedTargetPct: 3.0, maxPositionSizePct: 12, sector: 'Healthcare' },
  'PFE':  { volatilityClass: 'LOW', beta: 0.7, atr: 1.0, suggestedStopPct: 1.5, suggestedTargetPct: 3.0, maxPositionSizePct: 12, sector: 'Healthcare' },
  'AZN':  { volatilityClass: 'LOW', beta: 0.6, atr: 1.1, suggestedStopPct: 1.5, suggestedTargetPct: 3.0, maxPositionSizePct: 12, sector: 'Healthcare' },
  'GSK':  { volatilityClass: 'LOW', beta: 0.6, atr: 1.0, suggestedStopPct: 1.5, suggestedTargetPct: 3.0, maxPositionSizePct: 12, sector: 'Healthcare' },
  'INTC': { volatilityClass: 'LOW', beta: 0.8, atr: 1.2, suggestedStopPct: 2.0, suggestedTargetPct: 4.0, maxPositionSizePct: 10, sector: 'Technology' },
};

const SECTOR_DEFAULTS: Record<string, { volatilityClass: VolatilityClass; beta: number; atr: number; suggestedStopPct: number; suggestedTargetPct: number; maxPositionSizePct: number }> = {
  'Technology':              { volatilityClass: 'MEDIUM', beta: 1.2, atr: 1.8, suggestedStopPct: 2.5, suggestedTargetPct: 5.0, maxPositionSizePct: 6 },
  'Financials':              { volatilityClass: 'MEDIUM', beta: 1.1, atr: 1.5, suggestedStopPct: 2.5, suggestedTargetPct: 5.0, maxPositionSizePct: 7 },
  'Healthcare':              { volatilityClass: 'LOW',    beta: 0.8, atr: 1.2, suggestedStopPct: 2.0, suggestedTargetPct: 4.0, maxPositionSizePct: 10 },
  'Energy':                  { volatilityClass: 'MEDIUM', beta: 1.0, atr: 1.6, suggestedStopPct: 2.5, suggestedTargetPct: 5.0, maxPositionSizePct: 7 },
  'Consumer Discretionary':  { volatilityClass: 'MEDIUM', beta: 1.2, atr: 1.8, suggestedStopPct: 3.0, suggestedTargetPct: 6.0, maxPositionSizePct: 6 },
  'Communication Services':  { volatilityClass: 'MEDIUM', beta: 1.0, atr: 1.5, suggestedStopPct: 2.5, suggestedTargetPct: 5.0, maxPositionSizePct: 7 },
};

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Calculate stop/target/size for an IG stock spread bet.
 *
 * @param ticker        Stock symbol
 * @param currentPrice  Current spread-bet price (USD for US stocks, pence for UK)
 * @param direction     LONG or SHORT
 * @param newsContext   Signal reasoning text — used to widen levels on catalysts
 * @param availableCapital  Account available balance in £
 */
export function calculateStockRisk(
  ticker:           string,
  currentPrice:     number,
  direction:        'LONG' | 'SHORT',
  newsContext:      string,
  availableCapital: number,
): StockRiskProfile {
  const p = PROFILES[ticker.toUpperCase()];
  const sector = p?.sector ?? 'Unknown';
  const sd = SECTOR_DEFAULTS[sector] ?? SECTOR_DEFAULTS['Technology'];

  const volatilityClass   = p?.volatilityClass   ?? sd.volatilityClass;
  const beta              = p?.beta              ?? sd.beta;
  const atr               = p?.atr               ?? sd.atr;
  const maxPositionSizePct = p?.maxPositionSizePct ?? sd.maxPositionSizePct;

  let stopPct   = p?.suggestedStopPct   ?? sd.suggestedStopPct;
  let targetPct = p?.suggestedTargetPct ?? sd.suggestedTargetPct;

  // Widen target on strong catalysts
  const ctx = newsContext.toLowerCase();
  if (ctx.includes('earnings beat') || ctx.includes('upgrade') || ctx.includes('record') || ctx.includes('breakout')) {
    targetPct = Math.round(targetPct * 1.5 * 10) / 10;
  }

  // Widen stop in volatile macro environment
  if (ctx.includes('volatile') || ctx.includes('uncertainty') || ctx.includes('war') || ctx.includes('crisis') || ctx.includes('crash')) {
    stopPct = Math.round(stopPct * 1.3 * 10) / 10;
  }

  // Distances in price points (same units as spread-bet price)
  const stopDistance   = Math.max(1, Math.round(currentPrice * stopPct   / 100));
  const targetDistance = Math.max(1, Math.round(currentPrice * targetPct / 100));

  // Absolute levels for display
  const stopPrice   = direction === 'LONG'
    ? currentPrice - stopDistance
    : currentPrice + stopDistance;
  const targetPrice = direction === 'LONG'
    ? currentPrice + targetDistance
    : currentPrice - targetDistance;

  // Size so hitting the stop costs exactly 1% of capital.
  // Also capped so position value ≤ maxPositionSizePct % of capital.
  const maxRiskAmount    = availableCapital * 0.01;
  const sizeByRisk       = maxRiskAmount / stopDistance;
  const maxPositionValue = availableCapital * (maxPositionSizePct / 100);
  const sizeByPosition   = maxPositionValue / currentPrice;
  const rawSize          = Math.min(sizeByRisk, sizeByPosition);
  const sizePerPoint     = Math.max(0.1, Math.round(rawSize * 10) / 10);

  const maxRisk      = sizePerPoint * stopDistance;
  const targetProfit = sizePerPoint * targetDistance;
  const rr           = targetDistance / stopDistance;

  const reasoning =
    `${volatilityClass.replace('_', ' ')} volatility stock (β=${beta}). ` +
    `Typical daily range ${atr}%. ` +
    `Stop at ${stopPct}% accounts for normal price fluctuation. ` +
    `Target at ${targetPct}% based on typical move for this volatility class. ` +
    `Size £${sizePerPoint}/pt risks £${maxRisk.toFixed(0)} if stop hit (1% of capital).`;

  return {
    ticker, sector, volatilityClass, beta, atr,
    suggestedStopPct:    stopPct,
    suggestedTargetPct:  targetPct,
    maxPositionSizePct,
    stopDistance, targetDistance,
    stopPrice, targetPrice,
    sizePerPoint, maxRisk, targetProfit,
    riskRewardRatio: rr,
    reasoning,
  };
}

/** Human-readable volatility label. */
export function volatilityLabel(vc: VolatilityClass): string {
  switch (vc) {
    case 'LOW':       return 'Low Volatility';
    case 'MEDIUM':    return 'Medium Volatility';
    case 'HIGH':      return 'High Volatility';
    case 'VERY_HIGH': return 'Very High Volatility';
  }
}

/** Colour class for volatility badge. */
export function volatilityColor(vc: VolatilityClass): string {
  switch (vc) {
    case 'LOW':       return 'bg-emerald-500/20 text-emerald-400';
    case 'MEDIUM':    return 'bg-blue-500/20 text-blue-400';
    case 'HIGH':      return 'bg-amber-500/20 text-amber-400';
    case 'VERY_HIGH': return 'bg-red-500/20 text-red-400';
  }
}

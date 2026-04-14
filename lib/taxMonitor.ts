import { Trade, TaxTrade, Section104Pool } from './types';

const CGT_AEA = 3_000;
const HIGHER_RATE = 0.24;

export function getTaxYear(date: Date): { start: Date; end: Date; label: string } {
  const y = date.getFullYear();
  const aprSix = new Date(y, 3, 6);
  if (date >= aprSix) {
    return { start: aprSix, end: new Date(y + 1, 3, 5, 23, 59, 59), label: `${y}/${String(y + 1).slice(2)}` };
  }
  return { start: new Date(y - 1, 3, 6), end: new Date(y, 3, 5, 23, 59, 59), label: `${y - 1}/${String(y).slice(2)}` };
}

export function getDaysRemainingInTaxYear(): number {
  const { end } = getTaxYear(new Date());
  return Math.max(0, Math.ceil((end.getTime() - Date.now()) / 86_400_000));
}

/** Filter TaxTrades to those in the current UK tax year */
export function filterCurrentTaxYear(trades: TaxTrade[]): TaxTrade[] {
  const { start, end } = getTaxYear(new Date());
  return trades.filter(t => {
    const d = new Date(t.disposalDate);
    return d >= start && d <= end;
  });
}

/** Build running Section 104 pool from Trade[] (buy/sell history) */
export function buildLivePool(ticker: string, trades: Trade[]): Section104Pool {
  const pool: Section104Pool = { ticker, totalShares: 0, totalCost: 0, averageCost: 0 };
  const sorted = [...trades]
    .filter(t => t.ticker === ticker && !t.isISA)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  for (const t of sorted) {
    if (t.type === 'BUY') {
      pool.totalShares += t.quantity;
      pool.totalCost += t.gbpValue + t.fees;
    } else {
      const avg = pool.totalShares > 0 ? pool.totalCost / pool.totalShares : 0;
      const cost = avg * t.quantity;
      pool.totalShares = Math.max(0, pool.totalShares - t.quantity);
      pool.totalCost = Math.max(0, pool.totalCost - cost);
    }
    pool.averageCost = pool.totalShares > 0 ? pool.totalCost / pool.totalShares : 0;
  }
  return pool;
}

/**
 * Calculate CGT for a single disposal.
 * Uses simplified rule matching:
 * 1. Same-day rule
 * 2. Bed & breakfast (looks at buys AFTER sell within 30 days — can only flag warning in real-time)
 * 3. Section 104 pool
 */
export function calcDisposalCGT(opts: {
  ticker: string;
  isISA: boolean;
  disposalDate: string;
  quantity: number;
  proceedsGBP: number;
  trades: Trade[];                 // all trades in the store for this ticker
  existingTaxTrades: TaxTrade[];  // already calculated this tax year (for cumulative AEA)
  carriedForwardLosses: number;
  source: 't212-live' | 't212-isa' | 'manual';
  accountType: 'invest' | 'isa' | 'demo';
}): TaxTrade {
  const { ticker, isISA, disposalDate, quantity, proceedsGBP, trades, existingTaxTrades, carriedForwardLosses, source, accountType } = opts;
  const id = Math.random().toString(36).slice(2, 12);

  // ISA — always tax free
  if (isISA) {
    return {
      id, ticker, isISA: true, accountType, disposalDate, quantity,
      proceedsGBP, allowableCostGBP: 0, gainGBP: 0, lossGBP: 0,
      rule: 'section104', taxDueGBP: 0, taxRate: 0,
      cumulativeAEAUsed: 0, bbWarning: false, source, notes: 'ISA — Tax Free',
    };
  }

  const sellDate = new Date(disposalDate);
  const sellDateStr = disposalDate.slice(0, 10);

  // 1. Same-day rule: any buy of this ticker on same day?
  const sameDayBuys = trades.filter(t =>
    t.type === 'BUY' && t.ticker === ticker && !t.isISA && t.date.slice(0, 10) === sellDateStr
  );
  const sameDayQty = sameDayBuys.reduce((s, t) => s + t.quantity, 0);
  const sameDayCost = sameDayBuys.reduce((s, t) => s + t.gbpValue + t.fees, 0);

  // 2. B&B: any buy within 30 days AFTER sell?
  const bbBuys = trades.filter(t => {
    if (t.type !== 'BUY' || t.ticker !== ticker || t.isISA) return false;
    const bd = new Date(t.date);
    const diff = (bd.getTime() - sellDate.getTime()) / 86_400_000;
    return diff > 0 && diff <= 30;
  });
  const bbWarning = bbBuys.length > 0;

  let rule: TaxTrade['rule'] = 'section104';
  let allowableCostGBP = 0;

  if (sameDayQty >= quantity) {
    // Fully matched same-day
    rule = 'same-day';
    const costPerShare = sameDayQty > 0 ? sameDayCost / sameDayQty : 0;
    allowableCostGBP = costPerShare * quantity;
  } else if (bbWarning) {
    // B&B applies — use first repurchase cost
    rule = 'bed-and-breakfast';
    const firstBb = bbBuys[0];
    const costPerShare = firstBb.quantity > 0 ? (firstBb.gbpValue + firstBb.fees) / firstBb.quantity : 0;
    allowableCostGBP = costPerShare * quantity;
  } else {
    // Section 104 pool
    const pool = buildLivePool(ticker, trades.filter(t => new Date(t.date) < sellDate || t.type === 'BUY'));
    allowableCostGBP = pool.averageCost * quantity;
  }

  const rawGain = proceedsGBP - allowableCostGBP;
  const gainGBP = rawGain > 0 ? rawGain : 0;
  const lossGBP = rawGain < 0 ? Math.abs(rawGain) : 0;

  // Running cumulative AEA (tax year only, non-ISA)
  const { start, end } = getTaxYear(new Date(disposalDate));
  const yearTrades = existingTaxTrades.filter(t => {
    if (t.isISA) return false;
    const d = new Date(t.disposalDate);
    return d >= start && d <= end;
  });
  const prevNetGain = Math.max(0,
    yearTrades.reduce((s, t) => s + t.gainGBP, 0) -
    yearTrades.reduce((s, t) => s + t.lossGBP, 0) -
    carriedForwardLosses
  );
  const newNetGain = Math.max(0, prevNetGain + gainGBP - lossGBP);
  const cumulativeAEAUsed = Math.min(newNetGain, CGT_AEA);

  const taxableGain = Math.max(0, newNetGain - CGT_AEA);
  const taxDueGBP = taxableGain * HIGHER_RATE; // conservative estimate
  const taxRate = HIGHER_RATE;

  return {
    id, ticker, isISA: false, accountType, disposalDate, quantity,
    proceedsGBP, allowableCostGBP, gainGBP, lossGBP,
    rule, taxDueGBP, taxRate, cumulativeAEAUsed, bbWarning, source,
    notes: bbWarning ? 'Bed & breakfast rule may apply — repurchase within 30 days detected' : undefined,
  };
}

/** Compute current-tax-year summary from TaxTrade[] */
export function computeTaxYearSummary(trades: TaxTrade[], carriedForwardLosses: number) {
  const yearTrades = filterCurrentTaxYear(trades);
  const nonIsaTrades = yearTrades.filter(t => !t.isISA);
  const totalGains = nonIsaTrades.reduce((s, t) => s + t.gainGBP, 0);
  const totalLosses = nonIsaTrades.reduce((s, t) => s + t.lossGBP, 0);
  const isaGains = yearTrades.filter(t => t.isISA).reduce((s, t) => s + t.gainGBP, 0);
  const netGain = Math.max(0, totalGains - totalLosses - carriedForwardLosses);
  const aeaUsed = Math.min(netGain, CGT_AEA);
  const aeaRemaining = Math.max(0, CGT_AEA - netGain);
  const taxableGain = Math.max(0, netGain - CGT_AEA);
  const estimatedCGT = taxableGain * HIGHER_RATE;
  return {
    totalGains, totalLosses, isaGains, netGain, aeaUsed, aeaRemaining,
    taxableGain, estimatedCGT, disposalCount: nonIsaTrades.length,
    daysRemaining: getDaysRemainingInTaxYear(),
    taxYear: getTaxYear(new Date()),
  };
}

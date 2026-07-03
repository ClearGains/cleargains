import { Trade, Section104Pool, CGTCalculation, SA108Data } from './types';

// ── Section 104 share pool + UK matching rules ──────────────────────────────

export function calculateSection104(trades: Trade[]): CGTCalculation[] {
  const calculations: CGTCalculation[] = [];

  // Group trades by ticker (exclude ISA positions)
  const byTicker: Record<string, Trade[]> = {};
  for (const trade of trades) {
    if (trade.isISA) continue;
    if (!byTicker[trade.ticker]) byTicker[trade.ticker] = [];
    byTicker[trade.ticker].push(trade);
  }

  for (const [ticker, tickerTrades] of Object.entries(byTicker)) {
    // Sort by date
    const sorted = [...tickerTrades].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );

    // Per-trade remaining quantities so partial matches are handled correctly:
    // a buy can satisfy several sells (or part of one), and whatever is left
    // of it enters the Section 104 pool.
    const buyRemaining = new Map<string, number>();
    for (const t of sorted) {
      if (t.type === 'BUY') buyRemaining.set(t.id, t.quantity);
    }
    const sellRemaining = new Map<string, number>();
    for (const t of sorted) {
      if (t.type === 'SELL') sellRemaining.set(t.id, t.quantity);
    }

    const sells = sorted.filter((t) => t.type === 'SELL');

    const record = (
      sell: Trade,
      buyCostPerShare: number,
      matchedQty: number,
      rule: CGTCalculation['rule']
    ) => {
      const proceedsPerShare = (sell.gbpValue - sell.fees) / sell.quantity;
      const matchedProceeds = proceedsPerShare * matchedQty;
      const matchedCost = buyCostPerShare * matchedQty;
      const gain = matchedProceeds - matchedCost;
      calculations.push({
        ticker,
        date: sell.date,
        disposal: matchedProceeds,
        allowableCost: matchedCost,
        gain: gain > 0 ? gain : 0,
        loss: gain < 0 ? Math.abs(gain) : 0,
        rule,
        quantity: matchedQty,
      });
    };

    // 1. Same-day rule (TCGA92 s105): match each sell against buys on the same day
    for (const sell of sells) {
      let remaining = sellRemaining.get(sell.id)!;
      if (remaining <= 0) continue;
      for (const buy of sorted) {
        if (remaining <= 0) break;
        if (buy.type !== 'BUY') continue;
        if (buy.date.slice(0, 10) !== sell.date.slice(0, 10)) continue;
        const avail = buyRemaining.get(buy.id)!;
        if (avail <= 0) continue;
        const matchedQty = Math.min(remaining, avail);
        record(sell, (buy.gbpValue + buy.fees) / buy.quantity, matchedQty, 'same-day');
        remaining -= matchedQty;
        buyRemaining.set(buy.id, avail - matchedQty);
      }
      sellRemaining.set(sell.id, remaining);
    }

    // 2. Bed & Breakfast rule (TCGA92 s106A): buys within 30 days AFTER the
    //    sell, matched earliest-acquisition first
    for (const sell of sells) {
      let remaining = sellRemaining.get(sell.id)!;
      if (remaining <= 0) continue;
      const sellTime = new Date(sell.date).getTime();
      for (const buy of sorted) {
        if (remaining <= 0) break;
        if (buy.type !== 'BUY') continue;
        const diffDays = (new Date(buy.date).getTime() - sellTime) / 86_400_000;
        if (diffDays <= 0 || diffDays > 30) continue;
        const avail = buyRemaining.get(buy.id)!;
        if (avail <= 0) continue;
        const matchedQty = Math.min(remaining, avail);
        record(sell, (buy.gbpValue + buy.fees) / buy.quantity, matchedQty, 'bed-and-breakfast');
        remaining -= matchedQty;
        buyRemaining.set(buy.id, avail - matchedQty);
      }
      sellRemaining.set(sell.id, remaining);
    }

    // 3. Section 104 pool: chronological replay. Unmatched buy remainders
    //    enter the pool as their date passes; each remaining sell quantity
    //    consumes pool shares at average cost AND DEPLETES THE POOL, so later
    //    disposals use the correct reduced pool.
    let poolShares = 0;
    let poolCost = 0;
    for (const t of sorted) {
      if (t.type === 'BUY') {
        const qtyIntoPool = buyRemaining.get(t.id)!;
        if (qtyIntoPool > 0) {
          poolShares += qtyIntoPool;
          poolCost += ((t.gbpValue + t.fees) / t.quantity) * qtyIntoPool;
        }
      } else {
        const remaining = sellRemaining.get(t.id)!;
        if (remaining <= 0 || poolShares <= 0) continue;
        const matchedQty = Math.min(remaining, poolShares);
        const avgCost = poolCost / poolShares;
        record(t, avgCost, matchedQty, 'section104');
        poolShares -= matchedQty;
        poolCost -= avgCost * matchedQty;
        sellRemaining.set(t.id, remaining - matchedQty);
      }
    }
  }

  return calculations;
}

export function calculateTax(
  gains: number,
  losses: number,
  aea: number,
  basicRateBand: number = 0
): { basicRateTax: number; higherRateTax: number; total: number } {
  const netGain = Math.max(0, gains - losses);
  const taxableGain = Math.max(0, netGain - aea);

  if (taxableGain <= 0) {
    return { basicRateTax: 0, higherRateTax: 0, total: 0 };
  }

  const basicRatePortion = Math.min(taxableGain, basicRateBand);
  const higherRatePortion = Math.max(0, taxableGain - basicRateBand);

  const basicRateTax = basicRatePortion * 0.18;
  const higherRateTax = higherRatePortion * 0.24;
  const total = basicRateTax + higherRateTax;

  return { basicRateTax, higherRateTax, total };
}

export function buildSection104Pools(
  trades: Trade[]
): Record<string, Section104Pool> {
  const pools: Record<string, Section104Pool> = {};

  const sorted = [...trades]
    .filter((t) => !t.isISA)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  for (const trade of sorted) {
    if (!pools[trade.ticker]) {
      pools[trade.ticker] = {
        ticker: trade.ticker,
        totalShares: 0,
        totalCost: 0,
        averageCost: 0,
      };
    }

    const pool = pools[trade.ticker];

    if (trade.type === 'BUY') {
      pool.totalShares += trade.quantity;
      pool.totalCost += trade.gbpValue + trade.fees;
    } else {
      const avgCost = pool.totalShares > 0 ? pool.totalCost / pool.totalShares : 0;
      const costOfSold = avgCost * trade.quantity;
      pool.totalShares = Math.max(0, pool.totalShares - trade.quantity);
      pool.totalCost = Math.max(0, pool.totalCost - costOfSold);
    }

    pool.averageCost =
      pool.totalShares > 0 ? pool.totalCost / pool.totalShares : 0;
  }

  return pools;
}

export function generateSA108Preview(
  calculations: CGTCalculation[],
  aea: number = 3000
): SA108Data {
  const totalProceeds = calculations.reduce((sum, c) => sum + c.disposal, 0);
  const totalAllowableCosts = calculations.reduce(
    (sum, c) => sum + c.allowableCost,
    0
  );
  const totalGains = calculations.reduce((sum, c) => sum + c.gain, 0);
  const totalLosses = calculations.reduce((sum, c) => sum + c.loss, 0);
  const netGain = Math.max(0, totalGains - totalLosses);
  const taxableGain = Math.max(0, netGain - aea);

  const { basicRateTax, higherRateTax, total } = calculateTax(
    totalGains,
    totalLosses,
    aea
  );

  return {
    totalProceeds,
    totalAllowableCosts,
    totalGains,
    totalLosses,
    netGain,
    aea,
    taxableGain,
    basicRateTax,
    higherRateTax,
    totalTax: total,
    calculations,
  };
}

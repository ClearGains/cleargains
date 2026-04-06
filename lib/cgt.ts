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

    // Section 104 pool
    let poolShares = 0;
    let poolCost = 0;

    // Track remaining unmatched sells
    const unmatchedSells: Array<Trade & { remainingQty: number }> = [];

    for (const trade of sorted) {
      if (trade.type === 'BUY') {
        poolShares += trade.quantity;
        poolCost += trade.gbpValue + trade.fees;
      } else {
        unmatchedSells.push({ ...trade, remainingQty: trade.quantity });
      }
    }

    // Reset pool and process all trades with matching rules
    poolShares = 0;
    poolCost = 0;

    const processedSells = new Set<string>();

    for (const sell of [...sorted].filter((t) => t.type === 'SELL')) {
      if (processedSells.has(sell.id)) continue;

      const sellDate = new Date(sell.date);
      let remainingQty = sell.quantity;
      const proceeds = sell.gbpValue - sell.fees;

      // 1. Same-day rule: match against buys on the same day
      const sameDayBuys = sorted.filter(
        (t) =>
          t.type === 'BUY' &&
          t.date.slice(0, 10) === sell.date.slice(0, 10) &&
          !processedSells.has(t.id)
      );

      for (const buy of sameDayBuys) {
        if (remainingQty <= 0) break;
        const matchedQty = Math.min(remainingQty, buy.quantity);
        const costPerShare = (buy.gbpValue + buy.fees) / buy.quantity;
        const matchedCost = matchedQty * costPerShare;
        const matchedProceeds = (proceeds / sell.quantity) * matchedQty;
        const gain = matchedProceeds - matchedCost;

        calculations.push({
          ticker,
          date: sell.date,
          disposal: matchedProceeds,
          allowableCost: matchedCost,
          gain: gain > 0 ? gain : 0,
          loss: gain < 0 ? Math.abs(gain) : 0,
          rule: 'same-day',
          quantity: matchedQty,
        });

        remainingQty -= matchedQty;
        processedSells.add(buy.id);
      }

      if (remainingQty <= 0) {
        processedSells.add(sell.id);
        continue;
      }

      // 2. Bed & Breakfast rule: match against buys in next 30 days
      const bbBuys = sorted.filter((t) => {
        if (t.type !== 'BUY') return false;
        const buyDate = new Date(t.date);
        const diffDays =
          (buyDate.getTime() - sellDate.getTime()) / (1000 * 60 * 60 * 24);
        return diffDays > 0 && diffDays <= 30 && !processedSells.has(t.id);
      });

      for (const buy of bbBuys) {
        if (remainingQty <= 0) break;
        const matchedQty = Math.min(remainingQty, buy.quantity);
        const costPerShare = (buy.gbpValue + buy.fees) / buy.quantity;
        const matchedCost = matchedQty * costPerShare;
        const matchedProceeds = (proceeds / sell.quantity) * matchedQty;
        const gain = matchedProceeds - matchedCost;

        calculations.push({
          ticker,
          date: sell.date,
          disposal: matchedProceeds,
          allowableCost: matchedCost,
          gain: gain > 0 ? gain : 0,
          loss: gain < 0 ? Math.abs(gain) : 0,
          rule: 'bed-and-breakfast',
          quantity: matchedQty,
        });

        remainingQty -= matchedQty;
        processedSells.add(buy.id);
      }

      if (remainingQty <= 0) {
        processedSells.add(sell.id);
        continue;
      }

      // 3. Section 104 pool: match remaining quantity
      // Rebuild pool up to (but not including) this sell date
      let s104Shares = 0;
      let s104Cost = 0;
      for (const t of sorted) {
        if (new Date(t.date) >= new Date(sell.date)) break;
        if (t.type === 'BUY' && !processedSells.has(t.id)) {
          s104Shares += t.quantity;
          s104Cost += t.gbpValue + t.fees;
        }
      }

      if (s104Shares > 0 && remainingQty > 0) {
        const matchedQty = Math.min(remainingQty, s104Shares);
        const avgCost = s104Cost / s104Shares;
        const matchedCost = matchedQty * avgCost;
        const matchedProceeds = (proceeds / sell.quantity) * matchedQty;
        const gain = matchedProceeds - matchedCost;

        calculations.push({
          ticker,
          date: sell.date,
          disposal: matchedProceeds,
          allowableCost: matchedCost,
          gain: gain > 0 ? gain : 0,
          loss: gain < 0 ? Math.abs(gain) : 0,
          rule: 'section104',
          quantity: matchedQty,
        });

        remainingQty -= matchedQty;
      }

      processedSells.add(sell.id);
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

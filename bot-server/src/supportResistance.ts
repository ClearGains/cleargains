import type { LWCandle } from './chartIndicators';

export type SRZone = {
  price: number;
  type: 'support' | 'resistance';
  strength: number;
  priceHigh: number;
  priceLow: number;
};

export function calcSupportResistance(
  candles: LWCandle[],
  lookback = 60,
  minTouches = 2,
  clusterPct = 0.005,
): SRZone[] {
  const slice = candles.slice(-lookback);
  if (slice.length < 10) return [];

  const currentPrice = Number(slice[slice.length - 1].close);

  const pivots: { price: number }[] = [];
  for (let i = 2; i < slice.length - 2; i++) {
    const { high, low } = slice[i];
    const isHigh =
      high > slice[i - 1].high && high > slice[i - 2].high &&
      high > slice[i + 1].high && high > slice[i + 2].high;
    const isLow =
      low < slice[i - 1].low && low < slice[i - 2].low &&
      low < slice[i + 1].low && low < slice[i + 2].low;
    if (isHigh) pivots.push({ price: high });
    if (isLow)  pivots.push({ price: low });
  }

  const used = new Set<number>();
  const zones: SRZone[] = [];

  for (let i = 0; i < pivots.length; i++) {
    if (used.has(i)) continue;
    const base = pivots[i].price;
    const cluster: number[] = [base];
    used.add(i);
    for (let j = i + 1; j < pivots.length; j++) {
      if (used.has(j)) continue;
      if (Math.abs(pivots[j].price - base) / base <= clusterPct) {
        cluster.push(pivots[j].price);
        used.add(j);
      }
    }
    if (cluster.length >= minTouches) {
      const avg = cluster.reduce((a, b) => a + b, 0) / cluster.length;
      zones.push({
        price: avg,
        type: avg < currentPrice ? 'support' : 'resistance',
        strength: cluster.length,
        priceHigh: Math.max(...cluster),
        priceLow: Math.min(...cluster),
      });
    }
  }

  return zones.sort((a, b) => b.strength - a.strength).slice(0, 8);
}

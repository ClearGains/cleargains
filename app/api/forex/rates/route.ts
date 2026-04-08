import { NextResponse } from 'next/server';

const NEEDED = ['EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD'];

const FALLBACK_RATES: Record<string, number> = {
  EUR: 0.92,
  GBP: 0.79,
  JPY: 149.50,
  CHF: 0.90,
  AUD: 1.53,
  CAD: 1.36,
  NZD: 1.63,
};

function pickRates(raw: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const code of NEEDED) {
    out[code] = raw[code] ?? FALLBACK_RATES[code];
  }
  return out;
}

export async function GET() {
  // Primary: exchangerate-api.com (free, no key required)
  try {
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClearGains/1.0)' },
      signal: AbortSignal.timeout(6000),
      next: { revalidate: 60 },
    });
    if (res.ok) {
      const data = await res.json() as { rates?: Record<string, number> };
      if (data.rates && typeof data.rates === 'object') {
        return NextResponse.json({
          rates: pickRates(data.rates),
          source: 'exchangerate-api',
          timestamp: new Date().toISOString(),
        });
      }
    }
  } catch { /* fall through */ }

  // Secondary: Finnhub (requires API key)
  const key = process.env.FINNHUB_API_KEY;
  if (key) {
    try {
      const res = await fetch(`https://finnhub.io/api/v1/forex/rates?base=USD&token=${key}`, {
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const data = await res.json() as { quote?: Record<string, number> };
        if (data.quote) {
          return NextResponse.json({
            rates: pickRates(data.quote),
            source: 'finnhub',
            timestamp: new Date().toISOString(),
          });
        }
      }
    } catch { /* fall through */ }
  }

  // Fallback: hardcoded rates
  return NextResponse.json({
    rates: FALLBACK_RATES,
    source: 'fallback',
    timestamp: new Date().toISOString(),
  });
}

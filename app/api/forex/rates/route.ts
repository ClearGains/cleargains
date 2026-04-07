import { NextResponse } from 'next/server';

const FALLBACK_RATES: Record<string, number> = {
  EUR: 0.92,
  GBP: 0.79,
  JPY: 149.50,
  CHF: 0.90,
  AUD: 1.53,
  CAD: 1.36,
  NZD: 1.63,
};

export async function GET() {
  const key = process.env.FINNHUB_API_KEY;

  if (key) {
    try {
      const res = await fetch(`https://finnhub.io/api/v1/forex/rates?base=USD&token=${key}`, {
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const data = await res.json() as { quote?: Record<string, number> };
        const quote = data.quote ?? {};
        const rates: Record<string, number> = {};
        for (const code of Object.keys(FALLBACK_RATES)) {
          if (quote[code] !== undefined) rates[code] = quote[code];
          else rates[code] = FALLBACK_RATES[code];
        }
        return NextResponse.json({ rates, timestamp: new Date().toISOString() });
      }
    } catch {
      // fall through to fallback
    }
  }

  return NextResponse.json({ rates: FALLBACK_RATES, timestamp: new Date().toISOString() });
}

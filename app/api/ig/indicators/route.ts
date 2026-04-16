/**
 * /api/ig/indicators
 *
 * Calculates technical indicators from 3 months of Yahoo Finance daily data.
 * No IG allowance consumed — all data from Yahoo.
 *
 * Query params:
 *   name=<instrument name>  — look up Yahoo symbol by instrument name
 *   epic=<IG epic>          — optional hint for symbol resolution
 *   symbol=<Yahoo symbol>   — direct pass-through (bypasses name lookup)
 *
 * Returns: price, RSI14, EMA20/50, MACD, volumeSurge, vwapDeviation,
 *          bullScore, bearScore, confidenceScore, direction
 *
 * Cache: 30 minutes per symbol
 */

import { NextRequest, NextResponse } from 'next/server';
import { fetchYahooIndicators } from '@/lib/yahooIndicators';

// ── Yahoo symbol map ───────────────────────────────────────────────────────────

const YAHOO_MAP: Record<string, string> = {
  'FTSE 100': '^FTSE', 'FTSE 100 CFD': '^FTSE',
  'S&P 500': '^GSPC', 'S&P 500 CFD': '^GSPC',
  'NASDAQ 100': '^NDX', 'NASDAQ 100 CFD': '^NDX',
  'Wall Street': '^DJI', 'Wall Street (Dow)': '^DJI', 'Dow Jones': '^DJI',
  'Germany 40': '^GDAXI', 'Germany 40 (DAX)': '^GDAXI',
  'Japan 225': '^N225', 'Australia 200': '^AXJO',
  'VIX': '^VIX',
  'Gold': 'GC=F', 'Silver': 'SI=F',
  'Oil (WTI)': 'CL=F', 'Brent Crude': 'BZ=F', 'Natural Gas': 'NG=F',
  'GBP/USD': 'GBPUSD=X', 'EUR/USD': 'EURUSD=X', 'EUR/GBP': 'EURGBP=X',
  'USD/JPY': 'JPY=X', 'AUD/USD': 'AUDUSD=X', 'USD/CHF': 'CHF=X',
  'Bitcoin': 'BTC-USD', 'Ethereum': 'ETH-USD',
  'Apple': 'AAPL', 'Tesla': 'TSLA', 'Microsoft': 'MSFT', 'Amazon': 'AMZN',
  'NVIDIA': 'NVDA', 'Meta': 'META', 'Alphabet (GOOGL)': 'GOOGL',
  'Google': 'GOOGL', 'Netflix': 'NFLX',
};

function guessYahooSymbol(name: string, epic?: string): string | null {
  if (epic) {
    const stockMatch = epic.match(/^UA\.D\.([A-Z]+)\.CASH\.IP$/);
    if (stockMatch) return stockMatch[1];
    const fxMatch = epic.match(/^CS\.D\.([A-Z]{6})\./);
    if (fxMatch) return `${fxMatch[1]}=X`;
  }
  const n = name.toLowerCase();
  if (n.includes('ftse') || n.includes('uk 100'))        return '^FTSE';
  if (n.includes('s&p') || n.includes('sp 500'))         return '^GSPC';
  if (n.includes('nasdaq'))                               return '^NDX';
  if (n.includes('dow') || n.includes('wall street'))     return '^DJI';
  if (n.includes('dax') || n.includes('germany 40'))      return '^GDAXI';
  if (n.includes('nikkei') || n.includes('japan 225'))    return '^N225';
  if (n.includes('hang seng') || n.includes('hong kong')) return '^HSI';
  if (n.includes('asx') || n.includes('australia'))       return '^AXJO';
  if (n.includes('cac') || n.includes('france 40'))       return '^FCHI';
  if (n.includes('euro stoxx'))                           return '^STOXX50E';
  if (n.includes('gold'))                                 return 'GC=F';
  if (n.includes('silver'))                               return 'SI=F';
  if (n.includes('crude') || n.includes('wti') || (n.includes('oil') && !n.includes('brent'))) return 'CL=F';
  if (n.includes('brent'))                                return 'BZ=F';
  if (n.includes('natural gas') || n.includes('natgas')) return 'NG=F';
  if (n.includes('copper'))                               return 'HG=F';
  if (n.includes('bitcoin') || n.includes('btc'))         return 'BTC-USD';
  if (n.includes('ethereum') || n.includes('eth'))        return 'ETH-USD';
  return null;
}

// Re-export the output type for consumers
export type { IndicatorResult as IndicatorOutput } from '@/lib/yahooIndicators';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const name   = searchParams.get('name') ?? '';
  const epic   = searchParams.get('epic') ?? undefined;
  const direct = searchParams.get('symbol') ?? undefined;

  if (!name && !direct) {
    return NextResponse.json({ ok: false, error: 'name or symbol parameter required' }, { status: 400 });
  }

  const symbol = direct ?? YAHOO_MAP[name] ?? guessYahooSymbol(name, epic);
  if (!symbol) {
    return NextResponse.json(
      { ok: false, error: `No Yahoo Finance symbol for "${name}". Pass epic= for auto-detection.` },
      { status: 400 },
    );
  }

  const indicators = await fetchYahooIndicators(symbol);
  if (!indicators) {
    return NextResponse.json({ ok: false, error: `Could not fetch/compute indicators for ${symbol}` }, { status: 502 });
  }

  return NextResponse.json({ ok: true, ...indicators });
}

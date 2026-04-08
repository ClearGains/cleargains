import { NextResponse } from 'next/server';

export type IndexQuote = {
  name: string;
  symbol: string;
  country: string;
  flag: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
};

export type CommodityQuote = {
  name: string;
  symbol: string;
  unit: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  isLive: boolean;
};

// ETF proxies that definitely work with Finnhub free tier
const INDICES: Omit<IndexQuote, 'price' | 'change' | 'changePercent'>[] = [
  { name: 'S&P 500',          symbol: 'SPY',   country: 'US',  flag: '🇺🇸' },
  { name: 'NASDAQ 100',       symbol: 'QQQ',   country: 'US',  flag: '🇺🇸' },
  { name: 'FTSE 100',         symbol: 'ISF.L', country: 'UK',  flag: '🇬🇧' },
  { name: 'DAX (Germany)',    symbol: 'EWG',   country: 'DE',  flag: '🇩🇪' },
  { name: 'Nikkei (Japan)',   symbol: 'EWJ',   country: 'JP',  flag: '🇯🇵' },
  { name: 'Hang Seng (HK)',   symbol: 'EWH',   country: 'HK',  flag: '🇭🇰' },
  { name: 'China (Shanghai)', symbol: 'MCHI',  country: 'CN',  flag: '🇨🇳' },
];

type CommodityDef = Omit<CommodityQuote, 'price' | 'change' | 'changePercent' | 'isLive'> & { fallback: number; altSymbol?: string };
const COMMODITIES: CommodityDef[] = [
  { name: 'Gold',             symbol: 'OANDA:XAU_USD', altSymbol: 'GLD',  unit: 'USD/troy oz',  fallback: 2350 },
  { name: 'Silver',           symbol: 'OANDA:XAG_USD', altSymbol: 'SLV',  unit: 'USD/troy oz',  fallback: 28.5 },
  { name: 'Crude Oil (WTI)',  symbol: 'USO',            unit: 'USD/barrel', fallback: 78.5 },
  { name: 'Natural Gas',      symbol: 'UNG',            unit: 'USD/MMBtu',  fallback: 2.8  },
  { name: 'Copper',           symbol: 'COPX',           unit: 'USD/lb',     fallback: 4.2  },
  { name: 'Wheat',            symbol: 'WEAT',           unit: 'USD/bushel', fallback: 5.4  },
  { name: 'Brent Crude',     symbol: 'BNO',            unit: 'USD/barrel', fallback: 82.5 },
];

async function fetchQuote(symbol: string, key: string): Promise<{ c: number; d: number; dp: number } | null> {
  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const data = await res.json() as { c: number; d: number; dp: number };
    if (!data.c || data.c === 0) return null;
    return data;
  } catch {
    return null;
  }
}

export async function GET() {
  const key = process.env.FINNHUB_API_KEY;

  if (!key) {
    return NextResponse.json({
      indices: INDICES.map(i => ({ ...i, price: null, change: null, changePercent: null })),
      commodities: COMMODITIES.map(c => ({ name: c.name, symbol: c.symbol, unit: c.unit, price: c.fallback, change: 0, changePercent: 0, isLive: false })),
      timestamp: new Date().toISOString(),
    });
  }

  // Fetch all in parallel (indices + primary commodity symbols)
  const [indexResults, commodityResults] = await Promise.all([
    Promise.all(INDICES.map(i => fetchQuote(i.symbol, key))),
    Promise.all(COMMODITIES.map(async c => {
      const primary = await fetchQuote(c.symbol, key);
      if (primary) return { data: primary, live: true };
      // Try alt symbol if defined
      if (c.altSymbol) {
        const alt = await fetchQuote(c.altSymbol, key);
        if (alt) return { data: alt, live: true };
      }
      return { data: null, live: false };
    })),
  ]);

  const indices: IndexQuote[] = INDICES.map((idx, i) => ({
    ...idx,
    price: indexResults[i]?.c ?? null,
    change: indexResults[i]?.d ?? null,
    changePercent: indexResults[i]?.dp ?? null,
  }));

  const commodities: CommodityQuote[] = COMMODITIES.map((com, i) => {
    const { data, live } = commodityResults[i];
    return {
      name: com.name,
      symbol: com.symbol,
      unit: com.unit,
      price: data?.c ?? com.fallback,
      change: data?.d ?? 0,
      changePercent: data?.dp ?? 0,
      isLive: live,
    };
  });

  return NextResponse.json({ indices, commodities, timestamp: new Date().toISOString() });
}

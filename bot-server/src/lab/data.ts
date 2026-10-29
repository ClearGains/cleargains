// ── Strategy Lab: price history (2026-10-29) ─────────────────────────────────
// The lab is a sandbox: nothing here trades or touches the live bots.
// Prices come from Yahoo's public chart API (no key), cached on disk for 6h.
//   1m  -> last 7 days    (Yahoo's limit for 1-minute bars)
//   5m  -> last 60 days   (Yahoo's limit for 5-minute bars)
//   1h  -> last ~2 years
//   1d  -> last 5 years
//   1wk -> last 20 years
import * as fs from 'fs';
import * as path from 'path';

export type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };
export type Timeframe = '1m' | '5m' | '1h' | '1d' | '1wk';
export type Series = { symbol: string; timeframe: Timeframe; tz: string; bars: Bar[]; daily: Bar[] };

// Lab market list: IG markets (via their Yahoo equivalents) plus any US stock
// ticker. spreadPct approximates IG's spread so results include trading costs.
export const LAB_MARKETS: Record<string, { yahoo: string; name: string; spreadPct: number }> = {
  US500:     { yahoo: '^GSPC',    name: 'US 500',       spreadPct: 0.009 },
  USTECH100: { yahoo: '^NDX',     name: 'US Tech 100',  spreadPct: 0.008 },
  WALLST:    { yahoo: '^DJI',     name: 'Wall Street',  spreadPct: 0.008 },
  DE40:      { yahoo: '^GDAXI',   name: 'Germany 40',   spreadPct: 0.006 },
  UK100:     { yahoo: '^FTSE',    name: 'FTSE 100',     spreadPct: 0.009 },
  JP225:     { yahoo: '^N225',    name: 'Japan 225',    spreadPct: 0.014 },
  EU50:      { yahoo: '^STOXX50E', name: 'EU Stocks 50', spreadPct: 0.02 },
  GBPUSD:    { yahoo: 'GBPUSD=X', name: 'GBP/USD',      spreadPct: 0.007 },
  EURUSD:    { yahoo: 'EURUSD=X', name: 'EUR/USD',      spreadPct: 0.006 },
  AUDUSD:    { yahoo: 'AUDUSD=X', name: 'AUD/USD',      spreadPct: 0.009 },
  USDJPY:    { yahoo: 'JPY=X',    name: 'USD/JPY',      spreadPct: 0.007 },
  NATGAS:    { yahoo: 'NG=F',     name: 'Natural Gas',  spreadPct: 0.15 },
  BRENT:     { yahoo: 'BZ=F',     name: 'Brent Crude',  spreadPct: 0.04 },
  SILVER:    { yahoo: 'SI=F',     name: 'Silver',       spreadPct: 0.05 },
  GOLD:      { yahoo: 'GC=F',     name: 'Gold',         spreadPct: 0.02 },
};
export const US_STOCK_SPREAD_PCT = 0.05;

const CACHE_DIR = path.join(__dirname, '..', '..', 'lab-cache');
// 1wk uses 20y: with 'max' Yahoo silently switches to 3-month bars.
const RANGE: Record<Timeframe, string> = { '1m': '7d', '5m': '60d', '1h': '730d', '1d': '5y', '1wk': '20y' };

async function fetchYahoo(symbol: string, interval: Timeframe, range: string): Promise<{ bars: Bar[]; tz: string }> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`Yahoo ${r.status} for ${symbol}`);
  const j = await r.json() as { chart?: { result?: Array<{ meta: { exchangeTimezoneName?: string }; timestamp?: number[]; indicators: { quote: Array<{ open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }> } }> } };
  const res = j.chart?.result?.[0];
  if (!res?.timestamp) throw new Error(`No data for ${symbol} (${interval})`);
  const q = res.indicators.quote[0];
  const bars: Bar[] = [];
  res.timestamp.forEach((t, i) => {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if (o != null && h != null && l != null && c != null) bars.push({ t, o, h, l, c, v: q.volume[i] ?? 0 });
  });
  return { bars, tz: res.meta.exchangeTimezoneName ?? 'UTC' };
}

async function cached<T>(key: string, maxAgeMs: number, load: () => Promise<T>): Promise<T> {
  const file = path.join(CACHE_DIR, key.replace(/[^A-Za-z0-9_.=-]/g, '_') + '.json');
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < maxAgeMs) return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch { /* not cached */ }
  const v = await load();
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify(v)); } catch { /* best effort */ }
  return v;
}

export function resolveMarket(key: string): { yahoo: string; name: string; spreadPct: number } {
  const k = key.toUpperCase();
  if (LAB_MARKETS[k]) return LAB_MARKETS[k];
  if (/^[A-Z.]{1,6}$/.test(k)) return { yahoo: k, name: k, spreadPct: US_STOCK_SPREAD_PCT };
  throw new Error(`Unknown market ${key}`);
}

export async function loadSeries(marketKey: string, timeframe: Timeframe): Promise<Series> {
  const m = resolveMarket(marketKey);
  const ttl = timeframe === '1m' ? 30 * 60_000 : 6 * 3_600_000;
  const main = await cached(`${m.yahoo}_${timeframe}`, ttl, () => fetchYahoo(m.yahoo, timeframe, RANGE[timeframe]));
  const daily = timeframe === '1d' ? main : await cached(`${m.yahoo}_1d`, ttl, () => fetchYahoo(m.yahoo, '1d', '5y'));
  return { symbol: m.yahoo, timeframe, tz: main.tz, bars: main.bars, daily: daily.bars };
}

// Exchange-local calendar date of a timestamp (bars are grouped into days by it).
export function dayKey(t: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(t * 1000));
}

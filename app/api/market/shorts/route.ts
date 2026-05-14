import { NextRequest, NextResponse } from 'next/server';
import { getYahooCrumb, yfHeaders } from '@/lib/yahooServer';
import { fetchFinnhubBatch } from '@/lib/finnhub';
import type { Mover } from '../movers/route';

export const revalidate = 0;

// ── Universes ─────────────────────────────────────────────────────────────────

// Liquid large/mid-cap stocks and sector ETFs — used for conviction + day trade
const MAIN_US = [
  'AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD','NFLX','INTC',
  'PLTR','COIN','RIVN','SNAP','SOFI','HOOD','LYFT','NIO','SPCE','LCID',
  'CHPT','EVGO','OPEN','DKNG','RBLX','PARA','WKHS','BLNK',
  'NKLA','GOEV','RIDE','XPEV','LI','BYND','FCEL','PLUG',
  'ARKK','XLK','XLF','XLE','XLV','XLY','XLI','XLU','XLRE',
  'BAC','C','WFC','JPM','GS','XOM','CVX','SPY','QQQ','IWM',
];

// Small/micro-cap speculative names — prone to pump-and-dump cycles
const SMALL_CAP_US = [
  'MMAT','SNDL','TLRY','CLOV','WISH','NKLA','GOEV','RIDE','WKHS',
  'BLNK','FCEL','BYND','GREE','BBBY','HYZN','PTRA','ARVL',
  'BNGO','OCGN','MULN','FFIE','LUCY','VINC','PHVS','NXTP',
  'BBAI','LIDR','OUST','CANO','HIMS','MAPS','BODY',
  'IONQ','RXRX','SPCE','CHPT','EVGO','OPEN','BLNK',
];

const MAIN_UK = [
  'LLOY.L','BARC.L','VOD.L','BP.L','SHEL.L','AZN.L','GSK.L','HSBA.L',
  'RR.L','NWG.L','BT-A.L','IAG.L','EZJ.L','MKS.L','JD.L','BOO.L',
  'OCDO.L','ITV.L','SBRY.L','DGE.L','STAN.L','WPP.L',
];

const SMALL_CAP_UK = [
  'BOO.L','OCDO.L','ITV.L','EZJ.L','IAG.L','JD.L',
  'KAPE.L','THG.L','MADE.L','HUMN.L','PFC.L','SFOR.L',
];

const MAIN_SCREENERS      = ['day_losers', 'most_actives'];
const SMALL_CAP_SCREENERS = ['small_cap_gainers', 'day_losers'];

// ── Types ─────────────────────────────────────────────────────────────────────

type ShortSignal = 'STRONG_SHORT' | 'SHORT' | 'WATCH' | 'AVOID';

export type ShortCandidate = Mover & {
  shortSignal:  ShortSignal;
  shortReasons: string[];
  shortScore:   number;
  scannedAt:    string;
  squeezeRisk:  boolean;
  category:     'conviction' | 'daytrade' | 'smallcap';
};

export type ShortsApiResponse = {
  conviction: ShortCandidate[];
  dayTrade:   ShortCandidate[];
  smallCap:   ShortCandidate[];
  scannedAt:  string;
};

type RawQuote = {
  symbol: string;
  shortName?: string; longName?: string;
  regularMarketPrice?: number;
  regularMarketChangePercent?: number;
  regularMarketVolume?: number;
  averageDailyVolume3Month?: number;
  marketCap?: number;
  fiftyTwoWeekHigh?: number; fiftyTwoWeekLow?: number;
  currency?: string; fullExchangeName?: string;
  regularMarketDayHigh?: number; regularMarketDayLow?: number;
  fiftyDayAverage?: number; twoHundredDayAverage?: number;
  preMarketPrice?: number; preMarketChangePercent?: number;
  postMarketPrice?: number; postMarketChangePercent?: number;
  marketState?: string;
};

// ── Cache ─────────────────────────────────────────────────────────────────────

const MODULE_CACHE_TTL = 60_000;
const scanCache = new Map<string, { data: ShortsApiResponse; ts: number }>();

// ── Screener helper ───────────────────────────────────────────────────────────

async function fetchScreenerSymbols(
  scrId: string,
  auth: { crumb: string; cookie: string } | null,
): Promise<string[]> {
  const base = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=25&scrIds=${scrId}&start=0`;
  const url  = auth?.crumb ? `${base}&crumb=${encodeURIComponent(auth.crumb)}` : base;
  try {
    const res = await fetch(url, { headers: yfHeaders(auth?.cookie) });
    if (!res.ok) return [];
    const raw = await res.json() as {
      finance?: { result?: Array<{ quotes?: Array<{ symbol: string }> }> };
    };
    return raw.finance?.result?.[0]?.quotes?.map(q => q.symbol) ?? [];
  } catch { return []; }
}

// ── Raw-quote → Mover mapper ───────────────────────────────────────────────────

function mapToMover(q: RawQuote, fhPrice?: number): Mover {
  const closePrice = q.regularMarketPrice ?? 0;
  const w52h   = q.fiftyTwoWeekHigh ?? closePrice;
  const w52l   = q.fiftyTwoWeekLow  ?? closePrice;
  const avgVol = q.averageDailyVolume3Month ?? 1;
  const vol    = q.regularMarketVolume ?? 0;
  const sma50  = q.fiftyDayAverage ?? closePrice;
  const sma200 = q.twoHundredDayAverage ?? closePrice;

  const effectiveChange =
    q.marketState === 'PRE' && q.preMarketChangePercent != null
      ? q.preMarketChangePercent
      : (q.regularMarketChangePercent ?? 0);

  const currentPrice =
    (fhPrice && fhPrice > 0)                        ? fhPrice           :
    q.marketState === 'REGULAR'                     ? closePrice        :
    (q.marketState === 'POST' && q.postMarketPrice) ? q.postMarketPrice :
    (q.marketState === 'PRE'  && q.preMarketPrice)  ? q.preMarketPrice  :
    (q.postMarketPrice ?? q.preMarketPrice ?? closePrice);

  return {
    symbol:        q.symbol,
    name:          q.shortName ?? q.longName ?? q.symbol,
    price:         currentPrice,
    closePrice,
    changePercent: effectiveChange,
    volume:        vol,
    avgVolume:     avgVol,
    volumeRatio:   avgVol > 0 ? vol / avgVol : 1,
    marketCap:     q.marketCap,
    week52High:    w52h,
    week52Low:     w52l,
    fromHigh:      w52h > 0 ? ((closePrice - w52h) / w52h) * 100 : 0,
    fromLow:       w52l > 0 ? ((closePrice - w52l) / w52l) * 100 : 0,
    currency:      q.currency ?? 'USD',
    exchange:      q.fullExchangeName ?? '',
    dayHigh:       q.regularMarketDayHigh ?? closePrice,
    dayLow:        q.regularMarketDayLow  ?? closePrice,
    sma50,
    sma200,
    aboveSma50:    closePrice > sma50,
    aboveSma200:   closePrice > sma200,
    goldenCross:   sma50 > sma200,
    marketState:   q.marketState,
    extendedChangePercent: (() => {
      if (q.marketState === 'REGULAR') return undefined;
      const ext = (fhPrice && fhPrice > 0) ? fhPrice : (q.postMarketPrice ?? q.preMarketPrice);
      return ext && closePrice > 0 ? ((ext - closePrice) / closePrice) * 100 : undefined;
    })(),
    extendedLabel: (() => {
      if (q.marketState === 'REGULAR') return undefined;
      return (q.marketState === 'PRE' ? 'PRE' : 'POST') as 'PRE' | 'POST';
    })(),
  };
}

// ── Scoring functions ─────────────────────────────────────────────────────────

function scoreConviction(q: Mover) {
  const reasons: string[] = [];
  let score = 0;
  const overnight   = q.extendedChangePercent ?? 0;
  const totalChange = q.changePercent + overnight;

  // Hard gate: if the stock is rising today it has buyers in control.
  // Shorting a stock that is actively going up is fighting the trend — wait
  // for exhaustion and reversal confirmation before entering a conviction short.
  if (totalChange > 1) {
    return {
      shortSignal: 'AVOID' as const,
      shortReasons: [`Up ${totalChange.toFixed(1)}% today — wait for reversal confirmation before shorting`],
      shortScore: 0,
    };
  }

  if (!q.goldenCross && !q.aboveSma50) { score += 3; reasons.push('Death cross + below SMA50 — bearish structure'); }
  else if (!q.goldenCross)             { score += 2; reasons.push('Death cross (SMA50 < SMA200)'); }
  if (!q.aboveSma200)                  { score += 2; reasons.push('Below SMA200 — long-term downtrend confirmed'); }

  if (totalChange < 0 && q.volumeRatio > 3)   { score += 3; reasons.push(`Volume ${q.volumeRatio.toFixed(1)}× avg on sell-off — distribution`); }
  else if (totalChange < 0 && q.volumeRatio > 2)   { score += 2; reasons.push(`Volume ${q.volumeRatio.toFixed(1)}× on decline`); }
  else if (totalChange < 0 && q.volumeRatio > 1.5) { score += 1; reasons.push(`Elevated volume ${q.volumeRatio.toFixed(1)}× on decline`); }

  if (q.fromHigh > -5 && totalChange < -2)  { score += 3; reasons.push('Rejected near 52w high — distribution top'); }
  else if (q.fromHigh > -10 && totalChange < 0) { score += 1; reasons.push('Pulling back from near 52w high'); }

  if (totalChange < -15)     { score += 1; reasons.push(`Down ${Math.abs(totalChange).toFixed(1)}% — may be overextended`); }
  else if (totalChange < -8) { score += 3; reasons.push(`Down ${Math.abs(totalChange).toFixed(1)}% — strong selling`); }
  else if (totalChange < -4) { score += 2; reasons.push(`Down ${Math.abs(totalChange).toFixed(1)}% — bearish momentum`); }
  else if (totalChange < -2) { score += 1; reasons.push(`Down ${Math.abs(totalChange).toFixed(1)}% today`); }

  if (overnight < -5)  { score += 2; reasons.push(`Down ${Math.abs(overnight).toFixed(1)}% overnight`); }
  else if (overnight < -2) { score += 1; reasons.push(`Down ${Math.abs(overnight).toFixed(1)}% overnight`); }

  if (q.fromHigh < -40) { score += 1; reasons.push(`${Math.abs(q.fromHigh).toFixed(0)}% below 52w high — extended downtrend`); }

  if (q.fromLow < 3)  { score -= 4; reasons.push('Near 52w low — high squeeze risk'); }
  else if (q.fromLow < 8) { score -= 2; reasons.push('Within 8% of 52w low — elevated squeeze risk'); }

  if (totalChange > 10)      { score -= 3; reasons.push('Rising sharply — momentum against short'); }
  else if (totalChange > 4)  { score -= 2; reasons.push('Rising today — counter-trend'); }
  else if (totalChange > 1)  { score -= 1; reasons.push('Up slightly today'); }

  if (q.goldenCross && q.aboveSma50) { score -= 2; reasons.push('Golden cross — bullish structure, risky short'); }

  const sig: ShortSignal = score >= 8 ? 'STRONG_SHORT' : score >= 5 ? 'SHORT' : score >= 2 ? 'WATCH' : 'AVOID';
  return { shortSignal: sig, shortReasons: reasons.slice(0, 5), shortScore: score };
}

function scoreDayTrade(q: Mover) {
  const reasons: string[] = [];
  let score = 0;
  const overnight   = q.extendedChangePercent ?? 0;
  const totalChange = q.changePercent + overnight;

  // Volume is critical — low volume = can't day trade reliably
  if (q.volumeRatio > 4)        { score += 4; reasons.push(`Volume ${q.volumeRatio.toFixed(1)}× — high liquidity`); }
  else if (q.volumeRatio > 2.5) { score += 3; reasons.push(`Volume ${q.volumeRatio.toFixed(1)}× avg`); }
  else if (q.volumeRatio > 1.5) { score += 2; reasons.push(`Volume ${q.volumeRatio.toFixed(1)}× avg`); }
  else if (q.volumeRatio < 0.8) { score -= 3; reasons.push('Low volume — avoid day trading'); }

  // Intraday momentum is the core signal — must be falling NOW to day-trade short
  if (totalChange > 0) {
    return {
      shortSignal: 'AVOID' as const,
      shortReasons: [`Up ${totalChange.toFixed(1)}% today — day-trade shorts require active downward momentum`],
      shortScore: 0,
    };
  }
  if (totalChange < -8)       { score += 4; reasons.push(`Down ${Math.abs(totalChange).toFixed(1)}% intraday — strong momentum`); }
  else if (totalChange < -5)  { score += 3; reasons.push(`Down ${Math.abs(totalChange).toFixed(1)}% — bearish momentum`); }
  else if (totalChange < -3)  { score += 2; reasons.push(`Down ${Math.abs(totalChange).toFixed(1)}% today`); }
  else if (totalChange < -1)  { score += 1; reasons.push(`Down ${Math.abs(totalChange).toFixed(1)}% — early weakness`); }

  // Price in day's range — near lows = momentum continuing
  const dayRange = q.dayHigh - q.dayLow;
  if (dayRange > 0) {
    const pos = (q.price - q.dayLow) / dayRange;
    if (pos < 0.3)      { score += 2; reasons.push('Trading near day low — downward momentum continuing'); }
    else if (pos > 0.75) { score -= 1; reasons.push('Near day high — risky short entry'); }
  }

  // Technical structure (secondary for day trades)
  if (!q.goldenCross && !q.aboveSma50) { score += 2; reasons.push('Death cross + below SMA50'); }
  else if (!q.goldenCross)             { score += 1; reasons.push('Death cross'); }

  // Squeeze risk — even worse intraday (can spike fast)
  if (q.fromLow < 5)       { score -= 4; reasons.push('Near 52w low — extreme intraday squeeze risk'); }
  else if (q.fromLow < 12) { score -= 1; reasons.push('Approaching 52w low — watch for reversal'); }

  // Already down too much — likely to bounce intraday
  if (totalChange < -15) { score -= 2; reasons.push('Very extended intraday — high bounce risk'); }

  const sig: ShortSignal = score >= 7 ? 'STRONG_SHORT' : score >= 4 ? 'SHORT' : score >= 2 ? 'WATCH' : 'AVOID';
  return { shortSignal: sig, shortReasons: reasons.slice(0, 5), shortScore: score };
}

function scoreSmallCap(q: Mover) {
  const reasons: string[] = [];
  let score = 0;
  const overnight   = q.extendedChangePercent ?? 0;
  const totalChange = q.changePercent + overnight;

  // Small caps can pump 20-50% on a single headline. Shorting on an up day is
  // extremely dangerous — the squeeze risk is too high. Only short when actually falling.
  if (totalChange > 2) {
    return {
      shortSignal: 'AVOID' as const,
      shortReasons: [`Up ${totalChange.toFixed(1)}% today — small cap momentum, extreme squeeze risk if shorted`],
      shortScore: 0,
    };
  }

  // Post-pump reversal is the best small-cap short setup
  if (q.fromHigh < -15 && !q.goldenCross && totalChange < 0) {
    score += 3; reasons.push('Post-pump reversal — down from inflated highs, still falling');
  }

  if (!q.goldenCross && !q.aboveSma50) { score += 3; reasons.push('Death cross + below SMA50'); }
  else if (!q.goldenCross)             { score += 2; reasons.push('Death cross'); }
  if (!q.aboveSma200)                  { score += 2; reasons.push('Below SMA200 — sustained downtrend'); }

  // Volume on down for small cap = real retail exit
  if (totalChange < 0 && q.volumeRatio > 3) { score += 3; reasons.push(`Volume ${q.volumeRatio.toFixed(1)}× on sell-off — retail exiting`); }
  else if (totalChange < 0 && q.volumeRatio > 2) { score += 2; reasons.push(`Volume ${q.volumeRatio.toFixed(1)}× on decline`); }

  if (totalChange < -10)     { score += 2; reasons.push(`Down ${Math.abs(totalChange).toFixed(1)}% — sharp decline`); }
  else if (totalChange < -5) { score += 2; reasons.push(`Down ${Math.abs(totalChange).toFixed(1)}% today`); }
  else if (totalChange < -2) { score += 1; reasons.push(`Down ${Math.abs(totalChange).toFixed(1)}%`); }

  if (q.fromHigh < -60) { score += 2; reasons.push(`${Math.abs(q.fromHigh).toFixed(0)}% below 52w high — failed recovery`); }
  else if (q.fromHigh < -40) { score += 1; reasons.push(`${Math.abs(q.fromHigh).toFixed(0)}% below 52w high`); }

  // Small caps can triple on one news headline — strong squeeze penalties
  if (q.fromLow < 5)       { score -= 5; reasons.push('Near 52w low — extreme squeeze risk for small cap, avoid'); }
  else if (q.fromLow < 15) { score -= 3; reasons.push('Approaching 52w low — small cap squeeze risk'); }

  if (totalChange > 10)      { score -= 5; reasons.push('Rising sharply — small cap momentum, very dangerous to short'); }
  else if (totalChange > 5)  { score -= 3; reasons.push('Rising today — avoid small cap short on up day'); }
  else if (totalChange > 2)  { score -= 1; reasons.push('Slightly up today'); }

  if (q.goldenCross && q.aboveSma50) { score -= 3; reasons.push('Golden cross — bullish structure, very risky short'); }

  const sig: ShortSignal = score >= 7 ? 'STRONG_SHORT' : score >= 4 ? 'SHORT' : score >= 2 ? 'WATCH' : 'AVOID';
  return { shortSignal: sig, shortReasons: reasons.slice(0, 5), shortScore: score };
}

// ── Yahoo batch fetcher ───────────────────────────────────────────────────────

async function fetchQuotes(
  symbols: string[],
  auth: { crumb: string; cookie: string } | null,
  fhMap: Map<string, { c: number; pc: number; dp: number }>,
  category: ShortCandidate['category'],
  scorer: (q: Mover) => { shortSignal: ShortSignal; shortReasons: string[]; shortScore: number },
  scannedAt: string,
): Promise<ShortCandidate[]> {
  if (symbols.length === 0) return [];
  const baseUrl = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(','))}`;
  const url     = auth?.crumb ? `${baseUrl}&crumb=${encodeURIComponent(auth.crumb)}` : baseUrl;
  const res     = await fetch(url, { headers: yfHeaders(auth?.cookie) });
  if (!res.ok) throw new Error(`Yahoo ${res.status}`);

  const raw    = await res.json() as { quoteResponse?: { result?: RawQuote[] } };
  const quotes = raw.quoteResponse?.result ?? [];

  return quotes.map(q => {
    const base = mapToMover(q, fhMap.get(q.symbol)?.c);
    const scored = scorer(base);
    return {
      ...base,
      ...scored,
      scannedAt,
      squeezeRisk: base.fromLow < 10,
      category,
    };
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────

async function buildResponse(mainUniverse: string[], smallUniverse: string[], market: string): Promise<ShortsApiResponse> {
  const auth      = await getYahooCrumb();
  const scannedAt = new Date().toISOString();

  // Supplement universes with live screener data
  const [mainExtra, smallExtra] = await Promise.all([
    Promise.all(MAIN_SCREENERS.map(id => fetchScreenerSymbols(id, auth))),
    Promise.all(SMALL_CAP_SCREENERS.map(id => fetchScreenerSymbols(id, auth))),
  ]);

  const mainSymbols  = [...new Set([...mainUniverse,  ...mainExtra.flat()])].slice(0, 80);
  const smallSymbols = [...new Set([...smallUniverse, ...smallExtra.flat()])].slice(0, 60);

  // Fetch Finnhub for main universe only (rate limit: 60/min free tier)
  const fhMap = market === 'US'
    ? await fetchFinnhubBatch(mainSymbols, 40)
    : new Map<string, { c: number; pc: number; dp: number }>();
  const emptyFh = new Map<string, { c: number; pc: number; dp: number }>();

  // Fetch both universes in parallel
  const [mainQuotes, smallQuotes] = await Promise.all([
    fetchQuotes(mainSymbols, auth, fhMap,    'conviction', scoreConviction, scannedAt),
    fetchQuotes(smallSymbols, auth, emptyFh, 'smallcap',   scoreSmallCap,  scannedAt),
  ]);

  // Conviction: STRONG_SHORT + SHORT from main, sorted by score
  const conviction = mainQuotes
    .filter(q => q.shortSignal === 'STRONG_SHORT' || q.shortSignal === 'SHORT')
    .sort((a, b) => b.shortScore - a.shortScore);

  // Day trade: re-score main universe with day trade function, filter WATCH and above
  const dayTrade = mainQuotes
    .filter(q => q.volumeRatio > 1.2)         // need some volume
    .map(q => ({ ...q, ...scoreDayTrade(q), category: 'daytrade' as const }))
    .filter(q => q.shortSignal !== 'AVOID')
    .sort((a, b) => b.shortScore - a.shortScore)
    .slice(0, 15);

  // Small cap: filter out AVOID
  const smallCap = smallQuotes
    .filter(q => q.shortSignal !== 'AVOID')
    .sort((a, b) => b.shortScore - a.shortScore);

  return { conviction, dayTrade, smallCap, scannedAt };
}

export async function GET(req: NextRequest) {
  const market = (req.nextUrl.searchParams.get('market') ?? 'US').toUpperCase();
  const force  = req.nextUrl.searchParams.get('force') === '1';
  const key    = market;

  const cached = scanCache.get(key);
  if (!force && cached && Date.now() - cached.ts < MODULE_CACHE_TTL) {
    return NextResponse.json(cached.data, {
      headers: { 'Cache-Control': 'no-store', 'X-Cache': 'HIT' },
    });
  }

  const mainUniverse  = market === 'UK' ? MAIN_UK  : MAIN_US;
  const smallUniverse = market === 'UK' ? SMALL_CAP_UK : SMALL_CAP_US;

  try {
    const data = await buildResponse(mainUniverse, smallUniverse, market);
    scanCache.set(key, { data, ts: Date.now() });
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store', 'X-Cache': 'MISS' } });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

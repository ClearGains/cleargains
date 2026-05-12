import {
  authenticate, getSession,
  placeMarketOrder, updatePositionLevels, fetchAccountFunds, fetchFullPositions,
  type IGSession,
} from './igApi';
import { isMarketOpen } from './marketHours';

// ── Stock epics ───────────────────────────────────────────────────────────────

const STOCK_EPICS: Record<string, { epic: string; name: string; exchange: string; currency: 'USD'|'GBP'; minSize: number }> = {
  'AAPL':  { epic: 'UC.D.AAPL.DAILY.IP',  name: 'Apple Inc',          exchange: 'NASDAQ', currency: 'USD', minSize: 1 },
  'MSFT':  { epic: 'UC.D.MSFT.DAILY.IP',  name: 'Microsoft',          exchange: 'NASDAQ', currency: 'USD', minSize: 1 },
  'GOOGL': { epic: 'UC.D.GOOGL.DAILY.IP', name: 'Alphabet',           exchange: 'NASDAQ', currency: 'USD', minSize: 1 },
  'AMZN':  { epic: 'UC.D.AMZN.DAILY.IP',  name: 'Amazon',             exchange: 'NASDAQ', currency: 'USD', minSize: 1 },
  'NVDA':  { epic: 'UC.D.NVDA.DAILY.IP',  name: 'NVIDIA',             exchange: 'NASDAQ', currency: 'USD', minSize: 1 },
  'META':  { epic: 'UC.D.META.DAILY.IP',  name: 'Meta Platforms',     exchange: 'NASDAQ', currency: 'USD', minSize: 1 },
  'TSLA':  { epic: 'UC.D.TSLA.DAILY.IP',  name: 'Tesla',              exchange: 'NASDAQ', currency: 'USD', minSize: 1 },
  'NFLX':  { epic: 'UC.D.NFLX.DAILY.IP',  name: 'Netflix',            exchange: 'NASDAQ', currency: 'USD', minSize: 1 },
  'AMD':   { epic: 'UC.D.AMD.DAILY.IP',   name: 'AMD',                exchange: 'NASDAQ', currency: 'USD', minSize: 1 },
  'INTC':  { epic: 'UC.D.INTC.DAILY.IP',  name: 'Intel',              exchange: 'NASDAQ', currency: 'USD', minSize: 1 },
  'JPM':   { epic: 'UC.D.JPM.DAILY.IP',   name: 'JPMorgan Chase',     exchange: 'NYSE',   currency: 'USD', minSize: 1 },
  'BAC':   { epic: 'UC.D.BAC.DAILY.IP',   name: 'Bank of America',    exchange: 'NYSE',   currency: 'USD', minSize: 1 },
  'GS':    { epic: 'UC.D.GS.DAILY.IP',    name: 'Goldman Sachs',      exchange: 'NYSE',   currency: 'USD', minSize: 1 },
  'XOM':   { epic: 'UC.D.XOM.DAILY.IP',   name: 'ExxonMobil',         exchange: 'NYSE',   currency: 'USD', minSize: 1 },
  'CVX':   { epic: 'UC.D.CVX.DAILY.IP',   name: 'Chevron',            exchange: 'NYSE',   currency: 'USD', minSize: 1 },
  'JNJ':   { epic: 'UC.D.JNJ.DAILY.IP',   name: 'Johnson & Johnson',  exchange: 'NYSE',   currency: 'USD', minSize: 1 },
  'PFE':   { epic: 'UC.D.PFE.DAILY.IP',   name: 'Pfizer',             exchange: 'NYSE',   currency: 'USD', minSize: 1 },
  'VOD':   { epic: 'UC.D.VOD.DAILY.IP',   name: 'Vodafone',           exchange: 'LSE',    currency: 'GBP', minSize: 1 },
  'BP':    { epic: 'UC.D.BP.DAILY.IP',    name: 'BP',                 exchange: 'LSE',    currency: 'GBP', minSize: 1 },
  'SHEL':  { epic: 'UC.D.SHEL.DAILY.IP',  name: 'Shell',              exchange: 'LSE',    currency: 'GBP', minSize: 1 },
  'BARC':  { epic: 'UC.D.BARC.DAILY.IP',  name: 'Barclays',           exchange: 'LSE',    currency: 'GBP', minSize: 1 },
  'LLOY':  { epic: 'UC.D.LLOY.DAILY.IP',  name: 'Lloyds Banking',     exchange: 'LSE',    currency: 'GBP', minSize: 1 },
  'AZN':   { epic: 'UC.D.AZN.DAILY.IP',   name: 'AstraZeneca',        exchange: 'LSE',    currency: 'GBP', minSize: 1 },
  'GSK':   { epic: 'UC.D.GSK.DAILY.IP',   name: 'GSK',                exchange: 'LSE',    currency: 'GBP', minSize: 1 },
  'HSBA':  { epic: 'UC.D.HSBA.DAILY.IP',  name: 'HSBC',               exchange: 'LSE',    currency: 'GBP', minSize: 1 },
};

const LSE_TICKERS = new Set(['VOD', 'BP', 'SHEL', 'BARC', 'LLOY', 'AZN', 'GSK', 'HSBA']);

const EARNINGS_DATES: Record<string, string> = {
  'NVDA': '2026-08-27', 'AAPL': '2026-07-31', 'MSFT': '2026-07-29',
  'GOOGL': '2026-07-28', 'AMZN': '2026-07-30', 'META': '2026-07-29',
  'TSLA': '2026-07-22', 'AMD': '2026-07-28', 'NFLX': '2026-07-15',
};

// ── Exported types ────────────────────────────────────────────────────────────

export type StockBotSettings = {
  riskPerTrade:     number;
  maxPositions:     number;
  stopAtrMult:      number;
  targetRR:         number;
  minStrength:      number;
  scanIntervalMins: number;
  earningsBlackout: boolean;
};

export type StockSignal = {
  ticker:     string;
  price:      number;
  rsi:        number | null;
  macdHist:   number | null;
  macdCross:  'bullish' | 'bearish' | 'none';
  sma20:      number | null;
  direction:  'BUY' | 'SELL' | 'NEUTRAL';
  strength:   number;
  reason:     string;
  marketOpen: boolean;
  blackout:   boolean;
  scanning:   boolean;
  lastScanned: string;
  error?:     string;
};

export type StockPosition = {
  dealId:        string;
  ticker:        string;
  epic:          string;
  instrumentName: string;
  direction:     'BUY' | 'SELL';
  size:          number;
  level:         number;
  upl:           number;
  currency:      string;
  bid:           number;
  offer:         number;
  stopLevel?:    number;
  limitLevel?:   number;
};

export type StockLogEntry = {
  id:   string;
  ts:   string;
  type: 'info' | 'buy' | 'sell' | 'close' | 'error' | 'warn';
  msg:  string;
};

export type StockBotStatus = {
  running:     boolean;
  paused:      boolean;
  settings:    StockBotSettings | null;
  tickers:     string[];
  signals:     Record<string, StockSignal>;
  positions:   StockPosition[];
  logs:        StockLogEntry[];
  available:   number | null;
  balance:     number | null;
  lastScanAt:  string | null;
  nextScanAt:  string | null;
  sessionOk:   boolean;
};

export type StockBotStartParams = {
  tickers:  string[];
  settings: StockBotSettings;
};

// ── Inline indicators (no external deps) ──────────────────────────────────────

type Candle = { open: number; high: number; low: number; close: number };

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    out.push(i === 0 ? values[0] : values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function calcRSI(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const closes = candles.map(c => c.close);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
}

function calcMACDHist(candles: Candle[], fast = 12, slow = 26, signal = 9): { hist: number; prevHist: number } {
  if (candles.length < slow + signal) return { hist: 0, prevHist: 0 };
  const closes   = candles.map(c => c.close);
  const fastEma  = ema(closes, fast);
  const slowEma  = ema(closes, slow);
  const macdLine = closes.map((_, i) => fastEma[i] - slowEma[i]);
  const sigLine  = ema(macdLine, signal);
  const n = macdLine.length;
  return {
    hist:     macdLine[n - 1] - sigLine[n - 1],
    prevHist: n > 1 ? macdLine[n - 2] - sigLine[n - 2] : 0,
  };
}

function calcSMA(candles: Candle[], period: number): number | null {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  return slice.reduce((s, c) => s + c.close, 0) / period;
}

function calcATR(candles: Candle[], period = 14): number {
  const s = candles.slice(-(period + 1));
  if (s.length < 2) return (candles[candles.length - 1]?.close ?? 1) * 0.02;
  let sum = 0;
  for (let i = 1; i < s.length; i++) {
    sum += Math.max(
      s[i].high - s[i].low,
      Math.abs(s[i].high - s[i - 1].close),
      Math.abs(s[i].low  - s[i - 1].close),
    );
  }
  return sum / (s.length - 1);
}

// ── Yahoo Finance hourly candle fetch ─────────────────────────────────────────

const YF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
let yfCrumb: { crumb: string; cookie: string; ts: number } | null = null;

async function getYahooCrumb(): Promise<{ crumb: string; cookie: string } | null> {
  if (yfCrumb && Date.now() - yfCrumb.ts < 25 * 60_000) return yfCrumb;
  try {
    const r = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': YF_UA, Accept: 'text/html' },
      redirect: 'manual',
      signal: AbortSignal.timeout(8_000),
    });
    const setCookie = r.headers.get('set-cookie') ?? '';
    const m = /\b(?:A1|A1S|A3)=([^;,\s]+)/.exec(setCookie);
    const cookie = m ? `${m[0].split('=')[0]}=${m[1]}` : '';
    const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': YF_UA, Accept: 'text/plain', ...(cookie ? { Cookie: cookie } : {}) },
      signal: AbortSignal.timeout(5_000),
    });
    if (!crumbRes.ok) return null;
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.length > 50 || crumb.includes('<')) return null;
    yfCrumb = { crumb, cookie, ts: Date.now() };
    return yfCrumb;
  } catch { return null; }
}

async function fetchHourlyCandles(ticker: string): Promise<Candle[]> {
  const sym  = LSE_TICKERS.has(ticker) ? `${ticker}.L` : ticker;
  const auth = await getYahooCrumb();
  const base = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1h&range=10d`;
  const url  = auth?.crumb ? `${base}&crumb=${encodeURIComponent(auth.crumb)}` : base;

  const res = await fetch(url, {
    headers: {
      'User-Agent': YF_UA,
      Accept: 'application/json',
      ...(auth?.cookie ? { Cookie: auth.cookie } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Yahoo ${res.status} for ${sym}`);

  const raw = await res.json() as {
    chart?: {
      result?: Array<{
        timestamp?: number[];
        indicators?: { quote?: Array<{ open?: (number|null)[]; high?: (number|null)[]; low?: (number|null)[]; close?: (number|null)[] }> };
      }>;
    };
  };

  const result = raw.chart?.result?.[0];
  if (!result?.timestamp?.length) throw new Error(`No data for ${sym}`);

  const q = result.indicators?.quote?.[0] ?? {};
  return result.timestamp
    .map((_, i) => ({
      open:  q.open?.[i]  ?? 0,
      high:  q.high?.[i]  ?? 0,
      low:   q.low?.[i]   ?? 0,
      close: q.close?.[i] ?? 0,
    }))
    .filter(c => c.close > 0);
}

// ── Signal engine ─────────────────────────────────────────────────────────────

function isEarningsBlackout(ticker: string, enabled: boolean): boolean {
  if (!enabled) return false;
  const d = EARNINGS_DATES[ticker];
  if (!d) return false;
  const days = (new Date(d).getTime() - Date.now()) / 86_400_000;
  return days >= 0 && days <= 3;
}

async function computeSignal(ticker: string, earningsBlackout: boolean): Promise<StockSignal> {
  const info = STOCK_EPICS[ticker];
  const base: StockSignal = {
    ticker, price: 0, rsi: null, macdHist: null, macdCross: 'none', sma20: null,
    direction: 'NEUTRAL', strength: 0, reason: 'No data',
    marketOpen: isMarketOpen(info?.epic ?? '').open,
    blackout: isEarningsBlackout(ticker, earningsBlackout),
    scanning: false, lastScanned: new Date().toISOString(),
  };
  try {
    const candles = await fetchHourlyCandles(ticker);
    if (candles.length < 20) throw new Error('Not enough candles');

    const price = candles[candles.length - 1].close;
    const rsi   = calcRSI(candles, 14);
    const { hist: lastH, prevHist } = calcMACDHist(candles, 12, 26, 9);
    const macdCross: 'bullish'|'bearish'|'none' =
      prevHist < 0 && lastH > 0 ? 'bullish' : prevHist > 0 && lastH < 0 ? 'bearish' : 'none';
    const sma20 = calcSMA(candles, 20);

    let bull = 0, bear = 0;
    const reasons: string[] = [];
    if (rsi !== null) {
      if (rsi < 25)      { bull += 40; reasons.push(`RSI ${rsi.toFixed(0)} deeply oversold`); }
      else if (rsi < 35) { bull += 22; reasons.push(`RSI ${rsi.toFixed(0)} oversold`); }
      else if (rsi > 75) { bear += 40; reasons.push(`RSI ${rsi.toFixed(0)} deeply overbought`); }
      else if (rsi > 65) { bear += 22; reasons.push(`RSI ${rsi.toFixed(0)} overbought`); }
    }
    if (macdCross === 'bullish') { bull += 35; reasons.push('MACD bullish cross'); }
    else if (macdCross === 'bearish') { bear += 35; reasons.push('MACD bearish cross'); }
    else if (lastH > 0) bull += 15; else if (lastH < 0) bear += 15;
    if (sma20 !== null) { if (price > sma20) bull += 10; else bear += 10; }

    const total    = bull + bear;
    const strength = total > 0 ? Math.round((Math.max(bull, bear) / total) * 100) : 0;
    const direction: 'BUY'|'SELL'|'NEUTRAL' =
      bull > bear + 20 && strength >= 60 ? 'BUY'  :
      bear > bull + 20 && strength >= 60 ? 'SELL' : 'NEUTRAL';

    return {
      ...base, price, rsi, macdHist: lastH, macdCross, sma20, direction, strength,
      reason: reasons.join(' · ') || 'No strong signal',
    };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : 'Scan failed' };
  }
}

// ── Bot factory ───────────────────────────────────────────────────────────────

export type StockBotHandle = {
  start:  (params: StockBotStartParams) => Promise<{ ok: boolean; error?: string }>;
  stop:   () => void;
  pause:  () => void;
  resume: () => void;
  status: () => StockBotStatus;
};

function resolveCredentials(accountKey: 'demo' | 'live') {
  if (accountKey === 'live') {
    return {
      apiKey:   process.env.IG_LIVE_API_KEY   ?? '',
      username: process.env.IG_LIVE_USERNAME  ?? '',
      password: process.env.IG_LIVE_PASSWORD  ?? '',
      env:      'live' as const,
    };
  }
  return {
    apiKey:   process.env.IG_DEMO_API_KEY  ?? process.env.IG_API_KEY   ?? '',
    username: process.env.IG_DEMO_USERNAME ?? process.env.IG_USERNAME  ?? '',
    password: process.env.IG_DEMO_PASSWORD ?? process.env.IG_PASSWORD  ?? '',
    env:      'demo' as const,
  };
}

export function createStockBot(accountKey: 'demo' | 'live'): StockBotHandle {
  const tag = `stockBot:${accountKey}`;

  let session:    IGSession | null = null;
  let running     = false;
  let paused      = false;
  let settings:   StockBotSettings | null = null;
  let tickers:    string[] = [];
  let signals:    Record<string, StockSignal> = {};
  let positions:  StockPosition[] = [];
  let available:  number | null = null;
  let balance:    number | null = null;
  let lastScanAt: string | null = null;
  let nextScanAt: string | null = null;
  let scanTimer:  ReturnType<typeof setTimeout> | null = null;
  let peakProfit: Map<string, number> = new Map();

  const logs: StockLogEntry[] = [];

  function uid()  { return Math.random().toString(36).slice(2, 9); }
  function addLog(type: StockLogEntry['type'], msg: string) {
    logs.unshift({ id: uid(), ts: new Date().toISOString(), type, msg });
    if (logs.length > 200) logs.splice(200);
    const level = type === 'error' ? 'error' : 'log';
    console[level](`[${tag}] [${type.toUpperCase()}] ${msg}`);
  }

  async function refreshFunds() {
    if (!session) return;
    try {
      const f = await fetchAccountFunds(session);
      available = f.available;
      balance   = f.balance;
    } catch { /* non-critical */ }
  }

  async function refreshPositions() {
    if (!session) return;
    try {
      const raw = await fetchFullPositions(session);
      positions = raw
        .filter(p => p.epic.startsWith('UC.D.'))
        .map(p => {
          const ticker = Object.entries(STOCK_EPICS).find(([, v]) => v.epic === p.epic)?.[0] ?? '';
          const info   = STOCK_EPICS[ticker];
          return {
            dealId: p.dealId, ticker, epic: p.epic,
            instrumentName: info?.name ?? p.epic,
            direction: p.direction, size: p.size, level: p.level,
            upl: p.upl, currency: info?.currency ?? 'USD',
            bid: p.bid, offer: p.offer,
            stopLevel: p.stopLevel, limitLevel: p.limitLevel,
          };
        });
    } catch { /* non-critical */ }
  }

  async function manageTrailingStops() {
    if (!session) return;
    for (const pos of positions) {
      if (!pos.stopLevel) continue;
      const isLong   = pos.direction === 'BUY';
      const stopDist = Math.abs(pos.level - pos.stopLevel);
      const current  = isLong ? pos.bid : pos.offer;
      const uplPts   = isLong ? current - pos.level : pos.level - current;
      const peak     = Math.max(peakProfit.get(pos.dealId) ?? 0, uplPts);
      peakProfit.set(pos.dealId, peak);

      let newStop: number | null = null;
      if (peak >= stopDist && uplPts >= 0) {
        const breakeven = isLong ? pos.level + 0.1 : pos.level - 0.1;
        const betterBreak = isLong ? breakeven > (pos.stopLevel ?? 0) : breakeven < (pos.stopLevel ?? 0);
        if (betterBreak) newStop = Math.round(breakeven * 10) / 10;
      }
      if (peak >= stopDist * 2) {
        const trail    = isLong ? pos.level + peak * 0.60 : pos.level - peak * 0.60;
        const rounded  = Math.round(trail * 10) / 10;
        const betterTrail = isLong ? rounded > (pos.stopLevel ?? 0) : rounded < (pos.stopLevel ?? 0);
        if (betterTrail) newStop = rounded;
      }

      if (newStop !== null) {
        try {
          await updatePositionLevels(session, pos.dealId, newStop, pos.limitLevel ?? null);
          const label = newStop === Math.round((pos.level + (isLong ? 0.1 : -0.1)) * 10) / 10
            ? 'breakeven' : `${newStop.toFixed(2)}`;
          addLog('info', `${pos.ticker} stop → ${label} (peak +${peak.toFixed(1)}pts)`);
        } catch { /* retry next cycle */ }
        await new Promise(r => setTimeout(r, 200));
      }
    }
  }

  async function runScan() {
    if (!running || paused || !session || !settings) return;
    addLog('info', `Scanning ${tickers.length} stocks…`);
    lastScanAt = new Date().toISOString();

    await Promise.all([refreshFunds(), refreshPositions()]);

    if (available !== null && available < 100) {
      addLog('warn', `Scan skipped — available £${available.toFixed(0)} too low`);
      scheduleNext();
      return;
    }

    const heldEpics = new Set(positions.map(p => p.epic));
    let newTrades = 0;

    for (const ticker of tickers) {
      if (!running || paused) break;

      const sig = await computeSignal(ticker, settings.earningsBlackout);
      signals[ticker] = sig;

      if (sig.blackout)    { addLog('warn', `${ticker} — earnings blackout`); continue; }
      if (!sig.marketOpen)  continue;
      if (sig.direction === 'NEUTRAL') continue;
      if (sig.strength < settings.minStrength) continue;
      if (newTrades + positions.length >= settings.maxPositions) {
        addLog('warn', `Max positions (${settings.maxPositions}) reached`); break;
      }
      const info = STOCK_EPICS[ticker];
      if (!info || heldEpics.has(info.epic)) continue;
      if (sig.error) continue;

      // Fund check
      if (available !== null && available < 100) { addLog('warn', 'Funds too low to trade'); break; }

      const atr       = sig.price * 0.02;
      const stopDist  = Math.max(1, Math.round(atr * settings.stopAtrMult * 10) / 10);
      const limitDist = Math.max(1, Math.round(stopDist * settings.targetRR * 10) / 10);
      const rawSize   = Math.max(info.minSize, Math.round((settings.riskPerTrade / stopDist) * 10) / 10);
      // Cap so notional (size × price) ≤ 5% of available funds
      const maxNotional = available !== null ? available * 0.05 : settings.riskPerTrade * 20;
      const pctCap    = Math.max(info.minSize, Math.floor((maxNotional / Math.max(sig.price, 1)) * 10) / 10);
      const size      = Math.max(info.minSize, Math.min(rawSize, pctCap));

      try {
        const direction = sig.direction as 'BUY' | 'SELL';
        const { dealId, level } = await placeMarketOrder(
          session, info.epic, direction, size,
          stopDist, limitDist, 'GBP',
        );
        const stopLevel  = direction === 'BUY' ? level - stopDist  : level + stopDist;
        const limitLevel = direction === 'BUY' ? level + limitDist : level - limitDist;
        addLog(direction === 'BUY' ? 'buy' : 'sell',
          `${direction} ${info.name} £${size}/pt @ ${level.toFixed(2)} · stop ${stopLevel.toFixed(2)} · target ${limitLevel.toFixed(2)} (deal: ${dealId})`
        );
        newTrades++;
        heldEpics.add(info.epic);
        void refreshFunds();
        void refreshPositions();
      } catch (e) {
        addLog('error', `Order failed for ${ticker}: ${e instanceof Error ? e.message : String(e)}`);
      }

      await new Promise(r => setTimeout(r, 500));
    }

    addLog('info', `Scan complete — ${newTrades} new trade(s)`);
    await manageTrailingStops();
    scheduleNext();
  }

  function scheduleNext() {
    if (!running || !settings) return;
    if (scanTimer) clearTimeout(scanTimer);
    const ms = settings.scanIntervalMins * 60_000;
    nextScanAt = new Date(Date.now() + ms).toISOString();
    scanTimer  = setTimeout(() => void runScan(), ms);
  }

  async function start(params: StockBotStartParams): Promise<{ ok: boolean; error?: string }> {
    stop();
    const creds = resolveCredentials(accountKey);
    if (!creds.apiKey || !creds.username || !creds.password) {
      return { ok: false, error: `${accountKey === 'live' ? 'IG_LIVE' : 'IG_DEMO'} env vars not set` };
    }

    try {
      const existing = getSession(accountKey);
      if (existing && Date.now() < existing.expiresAt - 2 * 60_000) {
        session = existing;
      } else {
        session = await authenticate(creds.apiKey, creds.username, creds.password, creds.env, accountKey);
      }

      settings    = params.settings;
      tickers     = params.tickers.filter(t => STOCK_EPICS[t]);
      signals     = {};
      peakProfit  = new Map();
      running     = true;
      paused      = false;

      addLog('info', `Stock bot started on ${accountKey.toUpperCase()} · risk £${settings.riskPerTrade}/trade · ${tickers.length} tickers`);
      await refreshFunds();
      // First scan after 2s
      scanTimer = setTimeout(() => void runScan(), 2_000);
      nextScanAt = new Date(Date.now() + 2_000).toISOString();
      return { ok: true };
    } catch (e) {
      running = false;
      const msg = e instanceof Error ? e.message : String(e);
      addLog('error', `Start failed: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  function stop() {
    running = false;
    paused  = false;
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    nextScanAt = null;
    if (logs.length) addLog('info', 'Stock bot stopped');
  }

  function pause() {
    if (!running) return;
    paused = true;
    addLog('info', 'Stock bot paused — existing positions unaffected');
  }

  function resume() {
    if (!running) return;
    paused = false;
    addLog('info', 'Stock bot resumed');
    scanTimer = setTimeout(() => void runScan(), 1_000);
  }

  function status(): StockBotStatus {
    return {
      running, paused, settings, tickers, signals,
      positions, logs: logs.slice(0, 150),
      available, balance, lastScanAt, nextScanAt,
      sessionOk: !!session && Date.now() < session.expiresAt,
    };
  }

  return { start, stop, pause, resume, status };
}

// ── Singleton instances ───────────────────────────────────────────────────────
export const demoStockBot = createStockBot('demo');
export const liveStockBot = createStockBot('live');

export function getStockBot(key: 'demo' | 'live') {
  return key === 'live' ? liveStockBot : demoStockBot;
}

// Walk-forward backtest of lib/ruleBasedAnalysis.ts's SWING recommendation
// exactly as the Daily Brief page would have generated it each day — only
// ever fed candles up to and including "today" (no lookahead), same rule,
// same entry/stop/TP1 levels it actually shows. One open trade per
// instrument at a time. Scalp/hourly setups aren't backtested here — the
// Daily Brief itself only pulls 10 days of hourly data for those, nowhere
// near enough history for a meaningful backtest; swing uses daily bars and
// 2 years of Yahoo history is trivially available.
import { ruleBasedAnalysis } from '../lib/ruleBasedAnalysis';
import { summarizeIndicators, type LWCandle } from '../lib/chartIndicators';

// Trend filter: don't take a swing trade that fights the established
// long-term trend — e.g. a mean-reversion SHORT on "overbought RSI" while
// price is still well above its own SMA200 (NVIDIA's exact failure mode:
// 11% win rate, -20R). TREND_BAND is how far above/below SMA200 counts as
// "established" rather than noise.
const TREND_BAND = 0.05; // 5%
function passesTrendFilter(direction: 'LONG' | 'SHORT', price: number, sma200: number | null): boolean {
  if (sma200 === null) return true; // not enough history yet — no opinion, let it through
  if (direction === 'SHORT' && price > sma200 * (1 + TREND_BAND)) return false;
  if (direction === 'LONG'  && price < sma200 * (1 - TREND_BAND)) return false;
  return true;
}

const MARKETS: { name: string; yahooSymbol: string }[] = [
  { name: 'FTSE 100',    yahooSymbol: '^FTSE' },
  { name: 'S&P 500',     yahooSymbol: '^GSPC' },
  { name: 'NASDAQ 100',  yahooSymbol: '^IXIC' },
  { name: 'Germany 40',  yahooSymbol: '^GDAXI' },
  { name: 'Wall Street', yahooSymbol: '^DJI' },
  { name: 'Japan 225',   yahooSymbol: '^N225' },
  { name: 'GBP/USD',     yahooSymbol: 'GBPUSD=X' },
  { name: 'EUR/USD',     yahooSymbol: 'EURUSD=X' },
  { name: 'USD/JPY',     yahooSymbol: 'JPY=X' },
  { name: 'EUR/GBP',     yahooSymbol: 'EURGBP=X' },
  { name: 'AUD/USD',     yahooSymbol: 'AUDUSD=X' },
  { name: 'Gold',        yahooSymbol: 'GC=F' },
  { name: 'Oil (WTI)',   yahooSymbol: 'CL=F' },
  { name: 'Silver',      yahooSymbol: 'SI=F' },
  { name: 'Bitcoin',     yahooSymbol: 'BTC-USD' },
  { name: 'Lloyds',      yahooSymbol: 'LLOY.L' },
  { name: 'Barclays',    yahooSymbol: 'BARC.L' },
  { name: 'BP',          yahooSymbol: 'BP.L' },
  { name: 'Shell',       yahooSymbol: 'SHEL.L' },
  { name: 'Rolls-Royce', yahooSymbol: 'RR.L' },
  { name: 'Vodafone',    yahooSymbol: 'VOD.L' },
  { name: 'Apple',       yahooSymbol: 'AAPL' },
  { name: 'NVIDIA',      yahooSymbol: 'NVDA' },
  { name: 'Tesla',       yahooSymbol: 'TSLA' },
  { name: 'Amazon',      yahooSymbol: 'AMZN' },
  { name: 'Microsoft',   yahooSymbol: 'MSFT' },
  { name: 'Meta',        yahooSymbol: 'META' },
];

async function fetchDailyBars(symbol: string): Promise<LWCandle[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) return [];
  const d = await r.json() as any;
  const result = d?.chart?.result?.[0];
  if (!result) return [];
  const ts = result.timestamp as number[] | undefined;
  const q  = result.indicators?.quote?.[0];
  if (!ts || !q) return [];
  const out: LWCandle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    out.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: q.volume?.[i] ?? undefined });
  }
  return out;
}

type Trade = {
  market: string; direction: 'LONG' | 'SHORT';
  entryIdx: number; entry: number; stop: number; tp1: number;
  exitIdx: number; exit: number; outcome: 'WIN' | 'LOSS' | 'TIMEOUT';
  r: number;
};

const MAX_HOLD_DAYS = 90;

function backtestOne(name: string, candles: LWCandle[], useTrendFilter: boolean): Trade[] {
  const trades: Trade[] = [];
  let openTrade: { direction: 'LONG' | 'SHORT'; entryIdx: number; entry: number; stop: number; tp1: number } | null = null;

  for (let i = 60; i < candles.length; i++) {
    if (openTrade) {
      const bar = candles[i];
      const held = i - openTrade.entryIdx;
      let outcome: 'WIN' | 'LOSS' | 'TIMEOUT' | null = null;
      let exitPrice = bar.close;
      if (openTrade.direction === 'LONG') {
        if (bar.low <= openTrade.stop) { outcome = 'LOSS'; exitPrice = openTrade.stop; }
        else if (bar.high >= openTrade.tp1) { outcome = 'WIN'; exitPrice = openTrade.tp1; }
      } else {
        if (bar.high >= openTrade.stop) { outcome = 'LOSS'; exitPrice = openTrade.stop; }
        else if (bar.low <= openTrade.tp1) { outcome = 'WIN'; exitPrice = openTrade.tp1; }
      }
      if (!outcome && held >= MAX_HOLD_DAYS) { outcome = 'TIMEOUT'; exitPrice = bar.close; }

      if (outcome) {
        const risk = Math.abs(openTrade.entry - openTrade.stop) || 1;
        const raw  = openTrade.direction === 'LONG' ? exitPrice - openTrade.entry : openTrade.entry - exitPrice;
        trades.push({
          market: name, direction: openTrade.direction,
          entryIdx: openTrade.entryIdx, entry: openTrade.entry, stop: openTrade.stop, tp1: openTrade.tp1,
          exitIdx: i, exit: exitPrice, outcome, r: raw / risk,
        });
        openTrade = null;
      } else {
        continue; // still open, don't evaluate a fresh signal on top of it
      }
    }

    if (!openTrade) {
      const slice = candles.slice(0, i + 1); // only data up to and including "today" — no lookahead
      let analysis;
      try { analysis = ruleBasedAnalysis(name, slice); } catch { continue; }
      const swing = analysis.swing;
      if (swing.direction === 'FLAT') continue;
      if (useTrendFilter) {
        const sma200 = summarizeIndicators(slice).sma200;
        if (!passesTrendFilter(swing.direction, analysis.price, sma200)) continue;
      }
      openTrade = {
        direction: swing.direction, entryIdx: i,
        entry: swing.entry, stop: swing.stopLoss, tp1: swing.takeProfit1,
      };
    }
  }
  return trades;
}

function summarize(label: string, trades: Trade[]) {
  const wins = trades.filter(t => t.outcome === 'WIN').length;
  const losses = trades.filter(t => t.outcome === 'LOSS').length;
  const timeouts = trades.filter(t => t.outcome === 'TIMEOUT').length;
  const totalR = trades.reduce((s, t) => s + t.r, 0);
  console.log(`\n=== ${label} ===`);
  console.log(`Total trades: ${trades.length}`);
  console.log(`Wins: ${wins}  Losses: ${losses}  Timeouts: ${timeouts}`);
  console.log(`Win rate: ${trades.length ? (wins / trades.length * 100).toFixed(1) : '—'}%`);
  console.log(`Total R: ${totalR.toFixed(2)}`);
  console.log(`Avg R per trade: ${trades.length ? (totalR / trades.length).toFixed(3) : '—'}`);
}

async function main() {
  const allUnfiltered: Trade[] = [];
  const allFiltered: Trade[] = [];
  const perMarket: Array<{ name: string; unfilt: Trade[]; filt: Trade[] }> = [];

  for (const m of MARKETS) {
    const bars = await fetchDailyBars(m.yahooSymbol);
    if (bars.length < 100) { console.log(`${m.name}: skipped, only ${bars.length} bars`); continue; }
    const unfilt = backtestOne(m.name, bars, false);
    const filt   = backtestOne(m.name, bars, true);
    allUnfiltered.push(...unfilt);
    allFiltered.push(...filt);
    perMarket.push({ name: m.name, unfilt, filt });
    await new Promise(r => setTimeout(r, 200)); // be polite to Yahoo
  }

  console.log('market          unfilt(n, R)        filtered(n, R)');
  for (const pm of perMarket) {
    const uR = pm.unfilt.reduce((s, t) => s + t.r, 0);
    const fR = pm.filt.reduce((s, t) => s + t.r, 0);
    console.log(`${pm.name.padEnd(14)}  n=${String(pm.unfilt.length).padStart(3)} R=${uR.toFixed(2).padStart(7)}    n=${String(pm.filt.length).padStart(3)} R=${fR.toFixed(2).padStart(7)}`);
  }

  summarize('UNFILTERED (baseline)', allUnfiltered);
  summarize('WITH TREND FILTER', allFiltered);
}
main().catch(e => { console.error('ERR', e); process.exit(1); });

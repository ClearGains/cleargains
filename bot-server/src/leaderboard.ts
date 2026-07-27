import * as fs from 'fs';
import * as path from 'path';
import {
  runBacktest, BT_STRATEGY_LABELS, BT_DATA_NEEDS, BT_DEFAULT_PARAMS,
  BT_UNIVERSE_SYMBOLS, defaultSpreadBpsFor,
  type BTStrategy, type BTBar, type BTResult,
} from './backtest';

// ── Yahoo bars fetch ──────────────────────────────────────────────────────────
// Yahoo blocks server requests that look automated (missing browser headers) —
// a bare request from this VM returns 429. A normal User-Agent/Accept-Language
// is enough to get real data back (confirmed manually against this exact host).

type YahooChartRaw = {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: (number | null)[]; high?: (number | null)[];
          low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[];
        }>;
      };
    }>;
    error?: unknown;
  };
};

async function fetchYahooBars(symbol: string, interval: '5m' | '1d', range: string): Promise<BTBar[] | null> {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=${interval}&range=${range}&includePrePost=false`;
  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const raw = await res.json() as YahooChartRaw;
    if (raw.chart?.error) return null;
    const result = raw.chart?.result?.[0];
    if (!result) return null;
    const timestamps = result.timestamp ?? [];
    const q = result.indicators?.quote?.[0] ?? {};
    const bars = timestamps.map((ts, i) => ({
      t: interval === '5m'
        ? new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ')
        : new Date(ts * 1000).toISOString().slice(0, 10),
      o: q.open?.[i] ?? 0, h: q.high?.[i] ?? 0, l: q.low?.[i] ?? 0, c: q.close?.[i] ?? 0, v: q.volume?.[i] ?? 0,
    })).filter(b => b.c > 0);
    return bars;
  } catch {
    return null;
  }
}

// ── Sweep ─────────────────────────────────────────────────────────────────────

export type LbRow = {
  strategy:           BTStrategy;
  symbolsTested:      number;
  symbolsSkipped:     number;
  trades:             number;
  avgReturnPct:       number;
  winRate:            number;
  profitFactor:       number;
  avgMaxDrawdownPct:  number;
  profitableSymbols:  number;
};

export type LbState = {
  rows:      LbRow[];
  lastRun:   string;
  running:   boolean;
  durationMs: number;
};

const STATE_FILE = path.join(__dirname, '..', 'leaderboard-state.json');
let current: LbState = { rows: [], lastRun: '', running: false, durationMs: 0 };

function loadState(): void {
  try { current = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as LbState; } catch { /* no prior run */ }
}
function saveState(): void {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(current), 'utf8'); } catch {}
}

export function getLeaderboardState(): LbState {
  return current;
}

// Pace requests — polite to Yahoo and avoids looking like a scraper hammering
// their edge, which is what triggers the bot-detection block in the first place.
const REQUEST_DELAY_MS = 400;

export async function runLeaderboardSweep(): Promise<void> {
  if (current.running) return;
  current.running = true;
  saveState();
  const started = Date.now();

  const strategies = Object.keys(BT_STRATEGY_LABELS) as BTStrategy[];
  const barCache = new Map<string, BTBar[] | null>();

  const getBars = async (symbol: string, interval: '5m' | '1d', range: string): Promise<BTBar[] | null> => {
    const key = `${symbol}:${interval}`;
    if (barCache.has(key)) return barCache.get(key)!;
    const bars = await fetchYahooBars(symbol, interval, range);
    barCache.set(key, bars);
    await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));
    return bars;
  };

  const rows: LbRow[] = [];
  for (const strat of strategies) {
    const { interval, range } = BT_DATA_NEEDS[strat];
    const stratResults: BTResult[] = [];
    let skipped = 0;

    for (const symbol of BT_UNIVERSE_SYMBOLS) {
      const bars = await getBars(symbol, interval, range);
      if (!bars) { skipped++; continue; }
      const r = runBacktest(symbol, strat, bars, { ...BT_DEFAULT_PARAMS, slippageBps: defaultSpreadBpsFor(symbol) });
      if (!r) { skipped++; continue; }
      stratResults.push(r);
    }

    const allTrades = stratResults.flatMap(r => r.trades);
    const wins = allTrades.filter(t => t.retPct > 0);
    const losses = allTrades.filter(t => t.retPct <= 0);
    const grossWin  = wins.reduce((s, t) => s + t.retPct, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.retPct, 0));

    rows.push({
      strategy: strat,
      symbolsTested:  stratResults.length,
      symbolsSkipped: skipped,
      trades: allTrades.length,
      avgReturnPct: stratResults.length
        ? stratResults.reduce((s, r) => s + r.stats.totalReturnPct, 0) / stratResults.length : 0,
      winRate: allTrades.length ? (wins.length / allTrades.length) * 100 : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 99 : 0),
      avgMaxDrawdownPct: stratResults.length
        ? stratResults.reduce((s, r) => s + r.stats.maxDrawdownPct, 0) / stratResults.length : 0,
      profitableSymbols: stratResults.filter(r => r.stats.totalReturnPct > 0).length,
    });
  }

  rows.sort((a, b) => b.avgReturnPct - a.avgReturnPct);
  current = { rows, lastRun: new Date().toISOString(), running: false, durationMs: Date.now() - started };
  saveState();
}

// ── Scheduling ────────────────────────────────────────────────────────────────
// A handful of hours between sweeps — this isn't time-sensitive (backtests
// don't go stale in hours) and keeps request volume against Yahoo modest.
const SWEEP_INTERVAL_MS = 6 * 60 * 60_000;
let scheduled = false;

export function startLeaderboardSchedule(): void {
  if (scheduled) return;
  scheduled = true;
  loadState();

  const tick = () => {
    void runLeaderboardSweep()
      .then(() => console.log(`[leaderboard] Sweep complete in ${(current.durationMs / 1000).toFixed(0)}s — ${current.rows.length} strategies`))
      .catch(e => console.error('[leaderboard] Sweep failed:', e instanceof Error ? e.message : String(e)));
  };

  // Run once shortly after boot (staggered so it doesn't compete with other
  // startup work), then on the fixed interval.
  setTimeout(tick, 30_000);
  setInterval(tick, SWEEP_INTERVAL_MS);
}

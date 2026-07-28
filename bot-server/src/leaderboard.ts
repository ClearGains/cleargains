import * as fs from 'fs';
import * as path from 'path';
import {
  runBacktest, BT_STRATEGY_LABELS, BT_DATA_NEEDS, BT_DEFAULT_PARAMS,
  BT_UNIVERSE_SYMBOLS, defaultSpreadBpsFor,
  type BTStrategy, type BTBar, type BTResult,
} from './backtest';
import { fetchYahooBars as fetchYahooBarsShared } from './yahooFetch';

// Backtest sim only needs 5m/1d; the shared fetcher also supports 1h for the
// IG bot's daily-strategy pre-checks.
async function fetchYahooBars(symbol: string, interval: '5m' | '1d', range: string): Promise<BTBar[] | null> {
  return fetchYahooBarsShared(symbol, interval, range);
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

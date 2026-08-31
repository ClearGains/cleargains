// ── Cross-bot performance aggregation ───────────────────────────────────────
// Built 2026-08-31: before this, per-strategy results lived in six separate
// journal files readable only one at a time — there was literally no way to
// answer "is this system making money overall?" from any one place. This
// rolls every journal up into one summary the /performance page renders.
//
// Two views per strategy, deliberately:
//  - lifetime: every exit ever journalled.
//  - currentEra: exits since the strategy's last material rewrite
//    (EDGE_STATS_CUTOFF in quant.ts). options_directional is the reason this
//    exists — its lifetime shows 38 straight losses from a sizing bug and a
//    strategy that were both replaced on 2026-08-24; judging today's logic
//    by that history would be exactly the mistake quant.ts's own comment
//    documents. Where no cutoff exists the two views are the same and
//    currentEra is omitted.
import { getJournal, type JournalMode, type JournalEvent } from './tradeJournal';
import { EDGE_STATS_CUTOFF } from './quant';

const ALL_MODES: JournalMode[] = ['paper', 'live', 'ig-demo', 'ig-live', 't212-demo', 't212-live'];

// Account currency per journal mode — Alpaca journals are USD, IG/T212 GBP.
const MODE_CURRENCY: Record<JournalMode, '$' | '£'> = {
  paper: '$', live: '$', 'ig-demo': '£', 'ig-live': '£', 't212-demo': '£', 't212-live': '£',
};

export type StrategyPerf = {
  trades:   number;
  wins:     number;
  winRate:  number;  // %
  totalPl:  number;  // account currency
  avgWin:   number;  // account currency, positive
  avgLoss:  number;  // account currency, positive magnitude
  avgPlPct: number;  // mean plPct per exit
  last30dPl: number;
  // Cumulative P&L over exit time — sparkline data, thinned to ≤80 points.
  curve: Array<{ ts: string; cum: number }>;
};

export type StrategyRow = {
  strategy:   string;
  lifetime:   StrategyPerf;
  currentEra?: StrategyPerf; // only when EDGE_STATS_CUTOFF names this strategy
  cutoff?:    string;
};

export type ModePerf = {
  mode:       JournalMode;
  currency:   '$' | '£';
  totalPl:    number;
  last30dPl:  number;
  trades:     number;
  strategies: StrategyRow[];
};

// Collapses repeated-close duplicates — a real, now-fixed bug (alpacaBot.ts,
// options on a dead/no-bid contract re-journaled the identical exit on
// every poll cycle while a resting close order sat unfilled, before a
// stillPending guard was added) left 32 duplicate rows in the paper journal
// alone, inflating options_directional's headline P&L by ~7x (-$71,145
// shown vs -$9,643 real: PLTR logged 17x, GOOGL 10x, GLD 9x, always the
// exact same symbol+qty+plUsd). Confirmed live journal for what it is
// rather than edited/deleted — this collapses same (symbol, qty, plUsd)
// exits within a strategy into one counted trade when they land within 14
// days of each other, since a genuine second trade producing the exact
// same P&L to the cent by coincidence is not realistic. Keeps the earliest
// timestamp for the equity curve.
function dedupeRepeatedCloses(exits: JournalEvent[]): JournalEvent[] {
  const DUP_WINDOW_MS = 14 * 86_400_000;
  const kept: JournalEvent[] = [];
  const lastSeen = new Map<string, { ts: number; keptIdx: number }>();
  for (const r of exits) {
    const key = `${r.symbol}|${r.qty}|${r.plUsd}`;
    const ts = new Date(r.ts).getTime();
    const prev = lastSeen.get(key);
    if (prev && ts - prev.ts <= DUP_WINDOW_MS) {
      lastSeen.set(key, { ts, keptIdx: prev.keptIdx }); // extend the window from this occurrence, don't re-add
      continue;
    }
    lastSeen.set(key, { ts, keptIdx: kept.length });
    kept.push(r);
  }
  return kept;
}

function computePerf(exits: JournalEvent[]): StrategyPerf {
  const wins   = exits.filter(r => (r.plUsd ?? 0) > 0);
  const losses = exits.filter(r => (r.plUsd ?? 0) <= 0);
  const totalPl = exits.reduce((s, r) => s + (r.plUsd ?? 0), 0);
  const cutoff30 = Date.now() - 30 * 86_400_000;

  let cum = 0;
  let curve = exits.map(r => { cum += r.plUsd ?? 0; return { ts: r.ts, cum: Math.round(cum * 100) / 100 }; });
  if (curve.length > 80) {
    const step = Math.ceil(curve.length / 80);
    curve = curve.filter((_, i) => i % step === 0 || i === curve.length - 1);
  }

  return {
    trades: exits.length,
    wins: wins.length,
    winRate: exits.length ? (wins.length / exits.length) * 100 : 0,
    totalPl: Math.round(totalPl * 100) / 100,
    avgWin:  wins.length   ? Math.round((wins.reduce((s, r) => s + (r.plUsd ?? 0), 0) / wins.length) * 100) / 100 : 0,
    avgLoss: losses.length ? Math.round(Math.abs(losses.reduce((s, r) => s + (r.plUsd ?? 0), 0) / losses.length) * 100) / 100 : 0,
    avgPlPct: exits.length ? Math.round((exits.reduce((s, r) => s + (r.plPct ?? 0), 0) / exits.length) * 100) / 100 : 0,
    last30dPl: Math.round(exits.filter(r => new Date(r.ts).getTime() >= cutoff30).reduce((s, r) => s + (r.plUsd ?? 0), 0) * 100) / 100,
    curve,
  };
}

export function getPerformanceSummary(): { modes: ModePerf[] } {
  const modes: ModePerf[] = [];

  for (const mode of ALL_MODES) {
    const { records } = getJournal(mode, 5000);
    const exitsByStrategy = new Map<string, JournalEvent[]>();
    for (const r of records) {
      if (r.event !== 'exit' || r.plUsd === undefined) continue;
      const arr = exitsByStrategy.get(r.strategy) ?? [];
      arr.push(r);
      exitsByStrategy.set(r.strategy, arr);
    }
    if (exitsByStrategy.size === 0) continue;

    const strategies: StrategyRow[] = [];
    for (const [strategy, rawExits] of exitsByStrategy) {
      rawExits.sort((a, b) => a.ts.localeCompare(b.ts));
      const exits = dedupeRepeatedCloses(rawExits);
      const row: StrategyRow = { strategy, lifetime: computePerf(exits) };
      const cutoff = EDGE_STATS_CUTOFF[strategy];
      if (cutoff) {
        row.cutoff = cutoff;
        row.currentEra = computePerf(exits.filter(r => r.ts >= cutoff));
      }
      strategies.push(row);
    }
    strategies.sort((a, b) => (b.currentEra ?? b.lifetime).totalPl - (a.currentEra ?? a.lifetime).totalPl);

    modes.push({
      mode, currency: MODE_CURRENCY[mode],
      totalPl:   Math.round(strategies.reduce((s, r) => s + r.lifetime.totalPl, 0) * 100) / 100,
      last30dPl: Math.round(strategies.reduce((s, r) => s + r.lifetime.last30dPl, 0) * 100) / 100,
      trades:    strategies.reduce((s, r) => s + r.lifetime.trades, 0),
      strategies,
    });
  }

  return { modes };
}

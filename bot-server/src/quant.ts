// ── Quant/actuarial sizing layer ────────────────────────────────────────
// Turns each bot's own real trade-journal history into two things any
// bot's sizing logic can use on top of its existing sizing: an
// expected-value gate (skip a strategy that's demonstrably losing on its
// own numbers) and a Kelly-derived size multiplier (scale size toward what
// a strategy's real track record supports, not just how confident Gemini
// sounded on any single trade). Built 2026-08-24 at the user's request,
// after noting every bot's sizing was riding entirely on point-in-time AI
// confidence with no feedback loop from what actually happened historically.
//
// Deliberately conservative in two ways:
//  1. Requires a real sample size before doing anything but a neutral 1.0x
//     multiplier — a handful of trades is noise, not edge.
//  2. Filters out any exit that predates a strategy's own last material
//     rewrite (EDGE_STATS_CUTOFF below). This was NOT optional — while
//     building this, Alpaca's `options_directional` journal turned out to
//     be 38 straight losses (0% win rate, -96.6% avg) entirely from
//     2026-08-21, three days before that same strategy was rewritten from
//     RSI mean-reversion to EMA trend-following and a stale-price sizing
//     bug (which alone caused several of those losses) was fixed. Using
//     that history unfiltered would have driven sizing toward zero based
//     on a strategy that no longer exists.
import { getJournal, type JournalMode } from './tradeJournal';

const MIN_SAMPLE_FOR_MULTIPLIER = 15; // below this: not enough signal, stay neutral
const MIN_SAMPLE_FOR_HARD_GATE  = 30; // below this: size down on bad edge, but don't refuse to trade outright — could still be noise
const FRACTIONAL_KELLY = 0.5;         // half-Kelly — full Kelly is well known to be too aggressive against real-world estimation error in win-rate/payoff
const MULTIPLIER_MIN = 0.4;
const MULTIPLIER_MAX = 1.4;
const HARD_GATE_KELLY = -0.15;        // a real, not-marginal negative edge

// Bump forward (to the ISO timestamp of the change) whenever a strategy's
// entry/exit logic changes materially enough that its prior trade history
// stops being a fair predictor of future performance.
export const EDGE_STATS_CUTOFF: Partial<Record<string, string>> = {
  options_directional: '2026-08-24T20:00:00Z', // rewritten RSI mean-reversion -> EMA trend-following; stale-price sizing bug fixed same day
};

export type EdgeStats = {
  strategy:   string;
  sampleSize: number;
  winRate:    number; // 0..1
  avgWinPct:  number; // positive
  avgLossPct: number; // positive magnitude
  evPct:      number; // expected value per trade, %
  kelly:      number; // full-Kelly fraction — can be negative (no edge)
};

export function computeEdgeStats(mode: JournalMode, strategy: string): EdgeStats | null {
  const { records } = getJournal(mode, 5000);
  const cutoff = EDGE_STATS_CUTOFF[strategy];
  const exits = records.filter(r =>
    r.event === 'exit' && r.strategy === strategy && r.plPct !== undefined
    && (!cutoff || r.ts >= cutoff),
  );
  if (exits.length < MIN_SAMPLE_FOR_MULTIPLIER) return null;

  const wins   = exits.filter(r => (r.plPct ?? 0) > 0);
  const losses = exits.filter(r => (r.plPct ?? 0) <= 0);
  const winRate    = wins.length / exits.length;
  const avgWinPct  = wins.length   ? wins.reduce((s, r) => s + (r.plPct ?? 0), 0) / wins.length : 0;
  const avgLossPct = losses.length ? Math.abs(losses.reduce((s, r) => s + (r.plPct ?? 0), 0) / losses.length) : 0;
  const evPct = winRate * avgWinPct - (1 - winRate) * avgLossPct;
  // Standard Kelly f* = p - q/b, b = payoff ratio (avg win / avg loss).
  // No losses on record at all (b undefined) is treated as maximally
  // favorable only if there were also wins; an all-flat/no-signal sample
  // (winRate 0, no losses either) has no edge to speak of.
  const kelly = avgLossPct > 0 ? winRate - (1 - winRate) / (avgWinPct / avgLossPct) : (winRate > 0 ? 1 : 0);

  return { strategy, sampleSize: exits.length, winRate, avgWinPct, avgLossPct, evPct, kelly };
}

export type EdgeSizing = { multiplier: number; reason: string; skip: boolean };

// Applied ON TOP of a bot's own existing size (confidence-scaled, or
// flat-risk) — never replaces it. Gemini's per-trade confidence still
// gates whether to trade at all; this only scales how much, informed by
// what the strategy has actually done, not how any one trade feels.
export function edgeSizing(mode: JournalMode, strategy: string): EdgeSizing {
  const stats = computeEdgeStats(mode, strategy);
  if (!stats) {
    return { multiplier: 1, skip: false, reason: 'Not enough closed trades under the current strategy logic yet — sizing unchanged' };
  }

  if (stats.sampleSize >= MIN_SAMPLE_FOR_HARD_GATE && stats.kelly <= HARD_GATE_KELLY) {
    return {
      multiplier: 0,
      skip: true,
      reason: `${stats.strategy}'s own track record (${stats.sampleSize} trades, ${(stats.winRate * 100).toFixed(0)}% win rate, EV ${stats.evPct >= 0 ? '+' : ''}${stats.evPct.toFixed(1)}%/trade) shows a clear, sustained negative edge — skipping rather than sizing into a strategy that's losing on its own numbers`,
    };
  }

  const raw = 1 + stats.kelly * FRACTIONAL_KELLY;
  const multiplier = Math.max(MULTIPLIER_MIN, Math.min(MULTIPLIER_MAX, raw));
  const reason = `${stats.strategy} track record: ${stats.sampleSize} trades, ${(stats.winRate * 100).toFixed(0)}% win rate, avg win +${stats.avgWinPct.toFixed(1)}% / avg loss -${stats.avgLossPct.toFixed(1)}%, EV ${stats.evPct >= 0 ? '+' : ''}${stats.evPct.toFixed(1)}%/trade — sizing ${multiplier >= 1 ? 'up' : 'down'} to ${(multiplier * 100).toFixed(0)}% of base`;
  return { multiplier, skip: false, reason };
}

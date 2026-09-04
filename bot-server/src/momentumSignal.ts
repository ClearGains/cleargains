// ── Shared momentum-scoring primitives ──────────────────────────────────────
// Added 2026-09-03 per explicit request: for a spread-bet position currently
// sitting in profit, the hold-vs-lock-in decision should be made "the way
// momentum was determined on the original T212 strategy" — i.e. the same
// objective, rules-based signal t212Bot.ts's scanMomentumCandidates uses for
// entries (today's price move, relative volume, and real-headline
// sentiment) — rather than Gemini's free-form judgment call, which is what
// geminiWatch.ts used before this. Deliberately extracted here rather than
// importing from t212Bot.ts: that file's version is entry-scoring-specific
// (candidate ranking, universe rotation); this is the smaller, reusable core
// (sentiment scoring + the weighted 0-100 formula + the continuation check)
// that both a fresh entry decision and an already-open position's
// hold-vs-close decision can share without geminiWatch.ts depending on
// t212Bot.ts's entry-scanning internals.

const BULLISH = ['beats', 'beat', 'surges', 'surge', 'soars', 'soar', 'rises', 'rise', 'gains', 'gain',
  'rallies', 'rally', 'record', 'upgrade', 'upgraded', 'outperform', 'strong', 'growth', 'profit', 'profits',
  'boost', 'boosted', 'raises', 'raised', 'exceeds', 'positive', 'higher', 'bullish', 'buy', 'overweight',
  'breakthrough', 'approval', 'deal', 'wins', 'guidance raised'];
const BEARISH = ['misses', 'miss', 'falls', 'plunges', 'plunge', 'slumps', 'slump', 'loss', 'losses', 'cuts', 'cut',
  'downgrade', 'downgraded', 'underperform', 'weak', 'concern', 'concerns', 'risk', 'warning', 'warns',
  'layoffs', 'disappoints', 'sell', 'bearish', 'negative', 'lower', 'lawsuit', 'probe', 'recall',
  'guidance cut', 'bankruptcy', 'investigation', 'fraud', 'scandal'];

export function sentimentScore(headlines: string[]): { score: number; bull: number; bear: number } {
  let bull = 0, bear = 0;
  for (const h of headlines) {
    const l = h.toLowerCase();
    bull += BULLISH.filter(w => l.includes(w)).length;
    bear += BEARISH.filter(w => l.includes(w)).length;
  }
  const total = bull + bear;
  return { score: total === 0 ? 0 : (bull - bear) / total, bull, bear };
}

// Same weighted 0-100 formula as t212Bot.ts's scanMomentumCandidates —
// kept numerically identical on purpose so "momentum" means the same thing
// whether it's gating a fresh T212 entry or an already-open spread-bet
// position's continuation.
export function momentumScore(params: {
  dayChangePercent: number; volumeSurgeMultiple?: number; headlineCount: number; intradayRangePct?: number;
}): number {
  const momentum   = Math.min(35, Math.abs(params.dayChangePercent) * 7);
  const volRatio   = params.volumeSurgeMultiple ?? 1;
  const volume     = Math.max(0, Math.min(25, (volRatio - 1) * 12.5));
  const news       = Math.min(30, params.headlineCount * 6);
  const volatility = Math.min(10, (params.intradayRangePct ?? 0) * 2);
  return Math.round(Math.min(100, momentum + volume + news + volatility));
}

// The actual hold-vs-lock-in question for an already-open, currently-
// profitable position. Default disposition is to LOCK IN the gain — this
// only says "keep holding" when there's active, real evidence the move is
// still going, not merely "hasn't reversed yet" (that would let a position
// that's gone dead flat ride forever, never banking anything, which is
// exactly the opposite of what this was built to do). MIN_CONTINUATION_MOVE_PCT
// matches scanMomentumCandidates' own qualifying bar for a fresh entry
// (t212Bot.ts's movers filter) — "still trending" needs the same real,
// active move a brand-new momentum candidate would need, not a lower bar
// just because a position is already open.
const MIN_CONTINUATION_MOVE_PCT = 0.5;
export function momentumStillSupports(
  direction: 'BUY' | 'SELL', dayChangePercent: number, sentiment: number,
): boolean {
  if (direction === 'BUY') return dayChangePercent >= MIN_CONTINUATION_MOVE_PCT && sentiment > -0.5;
  return dayChangePercent <= -MIN_CONTINUATION_MOVE_PCT && sentiment < 0.5;
}

// ── Long-horizon trend + extension read ─────────────────────────────────────
// Added 2026-09-04 per explicit request to reuse igOptionsBot.ts's monthly
// stock-options strategy elsewhere (the Alpaca options bot specifically) —
// same question as that strategy and, before it, the T212 ISA bot: a real,
// sustained multi-week uptrend/downtrend, not already extended (most of the
// move already priced in, elevated mean-reversion risk). Deliberately takes
// plain `{t,o,h,l,c,v}` bars rather than fetching them itself, so any
// broker's own already-fetched daily bars can be passed in directly — IG's
// via fetchBarsWithFallback, Alpaca's via its own getBars, no broker-specific
// dependency here.
export type TrendBar = { t: string; o: number; h: number; l: number; c: number; v: number };
export type TrendRead = {
  trend12w: number | null; trend4w: number | null; pctBelowHigh: number | null;
  currentPrice: number | null; isExtended: boolean;
};
const EXTENDED_TREND_12W_PCT    = 40; // % — a run this large already reflects a major re-rating
const EXTENDED_NEAR_EXTREME_PCT = 4;  // % off the 52-week high/low counts as "sitting at the extreme" of that move
export function readTrend(bars: TrendBar[], direction: 'BUY' | 'SELL'): TrendRead {
  const empty: TrendRead = { trend12w: null, trend4w: null, pctBelowHigh: null, currentPrice: null, isExtended: false };
  if (bars.length < 60) return empty;
  const closes = bars.map(b => b.c);
  const last = closes[closes.length - 1];
  const idx4w  = Math.max(0, closes.length - 1 - 20);
  const idx12w = Math.max(0, closes.length - 1 - 60);
  const trend4w  = closes[idx4w]  > 0 ? ((last - closes[idx4w])  / closes[idx4w])  * 100 : null;
  const trend12w = closes[idx12w] > 0 ? ((last - closes[idx12w]) / closes[idx12w]) * 100 : null;
  const window = closes.slice(Math.max(0, closes.length - 252));
  let isExtended = false;
  let pctBelowHigh: number | null = null;
  if (direction === 'BUY') {
    const high52w = Math.max(...window);
    pctBelowHigh = high52w > 0 ? ((high52w - last) / high52w) * 100 : null;
    isExtended = trend12w !== null && trend12w >= EXTENDED_TREND_12W_PCT && pctBelowHigh !== null && pctBelowHigh < EXTENDED_NEAR_EXTREME_PCT;
  } else {
    const low52w = Math.min(...window);
    pctBelowHigh = low52w > 0 ? ((last - low52w) / low52w) * 100 : null; // "% above the low" for a short thesis, same field reused
    isExtended = trend12w !== null && trend12w <= -EXTENDED_TREND_12W_PCT && pctBelowHigh !== null && pctBelowHigh < EXTENDED_NEAR_EXTREME_PCT;
  }
  return { trend12w, trend4w, pctBelowHigh, currentPrice: last, isExtended };
}

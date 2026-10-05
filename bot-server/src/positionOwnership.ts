// ── Who owns a position on the shared IG account ───────────────────────────
// Added 2026-10-03 after a confirmed live collision.
//
// Every bot in this process trades the SAME IG account, and IG's /positions
// endpoint returns the whole account to whichever bot asks. igStrategyBot's
// mechanical guards (severe-loss, weekend, stuck-loss) and geminiWatch's
// auto-watch sweep both iterate that raw list, so both were acting on
// positions owned by meanReversionBot's instances.
//
// Confirmed live on Spot Silver: it appeared in igStrategyBot's own position
// list AND in the commodities instance's tracked state at the same time, and
// the journal recorded the same close twice, 15 minutes apart, under two
// different strategy tags:
//     09-28 05:45  rsi_mean_reversion          Silver  +9.34  [Profit floor] ...
//     09-28 06:00  donchian_daily_commodities  Silver   0.00  Closed outside this bot's own code
// The worst case is not a confused journal — it's one bot force-closing a
// position whose exit thesis belongs to a different bot entirely.
//
// meanReversionBot imports from igStrategyBot, so importing it statically
// from either consumer would be circular. Dynamic import (the same pattern
// igStrategyBot already uses for geminiWatch) dodges that; Node caches the
// module after first load, so the per-tick cost is a map lookup.

export type ForeignOwnership = { dealIds: Set<string>; epics: Set<string> };

const EMPTY: ForeignOwnership = { dealIds: new Set(), epics: new Set() };
const TTL_MS = 30_000;
let cache: { at: number; owned: ForeignOwnership } | null = null;

// Positions and instruments belonging to OTHER bots on this account.
// Cached briefly: the guards walk every open position each tick and this
// can't change between positions within one tick.
export async function getForeignOwnership(): Promise<ForeignOwnership> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.owned;
  try {
    const mr = await import('./meanReversionBot');
    const opts = await import('./igOptionsBot');
    // igOptionsBot added 2026-10-06: confirmed live, igStrategyBot's severe-
    // loss guard (£20 ceiling) was trying every 30s to close the options
    // bot's NVDA/PLTR demo positions (-£468/-£842) — option premiums swing
    // far past that ceiling by design, and their exits belong to that bot.
    const dealIds = mr.meanReversionOwnedDealIds();
    for (const id of opts.igOptionsOwnedDealIds()) dealIds.add(id);
    cache = {
      at: Date.now(),
      owned: { dealIds, epics: mr.meanReversionOwnedEpics() },
    };
  } catch {
    // Never let an ownership lookup failure block a real safety guard —
    // claiming nothing is foreign restores the previous behaviour rather
    // than silently disabling protection on genuinely own positions.
    cache = { at: Date.now(), owned: EMPTY };
  }
  return cache.owned;
}

// True when this position belongs to another bot and the caller must not act
// on it. `openedByCaller` wins outright: if this bot actually placed the deal
// it owns it, even on an instrument another bot also trades.
export function isForeignPosition(
  dealId: string,
  epic: string,
  owned: ForeignOwnership,
  openedByCaller: boolean,
): boolean {
  if (openedByCaller) return false;
  if (owned.dealIds.has(dealId)) return true;
  // Coarser second signal — covers the window where another bot has opened a
  // position but hasn't persisted its dealId yet (mid-entry, or just before a
  // state write). An instrument only that bot ever trades isn't ours to touch.
  return owned.epics.has(epic);
}

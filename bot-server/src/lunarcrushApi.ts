// ── LunarCrush — social hype score ──────────────────────────────────────────
// Unlike DexScreener/Jupiter/RugCheck/GoPlus, this one genuinely needs a paid
// API key — confirmed live 2026-09-05 (no key returns 401 "DEMO DATA MODE:
// you must have a LunarCrush subscription to unlock real data"). Fails open
// exactly like this account's other optional-signal integrations (Finnhub
// with no key, e.g.): no key or any failure returns a neutral/absent score
// rather than blocking the strategy — memeCoinBot.ts falls back to
// DexScreener's own volume/txn velocity as its hype proxy when this is
// unavailable, so the bot is fully usable before this key exists and
// upgrades automatically once LUNARCRUSH_API_KEY is set, no other change
// needed.
//
// Exact response shape below is built from LunarCrush's documented v4
// "public coin" endpoint convention, NOT verified against a real
// subscription response (this account has no key yet) — re-verify the field
// names (galaxy_score, alt_rank, social_volume) against a live call the
// first time a real key is added, before trusting this in a live decision.

const BASE = 'https://lunarcrush.com/api4/public';

export type HypeRead = { score: number | null; source: 'lunarcrush' | 'none'; raw?: unknown };

export async function getHypeScore(symbol: string): Promise<HypeRead> {
  const apiKey = process.env.LUNARCRUSH_API_KEY;
  if (!apiKey) return { score: null, source: 'none' };
  try {
    const res = await fetch(`${BASE}/coins/${encodeURIComponent(symbol)}/v1`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { score: null, source: 'none' };
    const data = await res.json() as { data?: { galaxy_score?: number } };
    const galaxyScore = data.data?.galaxy_score;
    if (typeof galaxyScore !== 'number') return { score: null, source: 'none' };
    // Galaxy Score is documented as 0-100 already — passed through as-is.
    return { score: galaxyScore, source: 'lunarcrush', raw: data.data };
  } catch {
    return { score: null, source: 'none' };
  }
}

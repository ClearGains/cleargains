// Real per-instrument news for Gemini's entry confirmation — same Finnhub
// source the Alpaca "AI Strategy Recommendation" panel already uses
// (app/api/alpaca/recommend/route.ts), just wired into actual IG trade
// decisions for a specific instrument instead of a general strategy pick.
// Best-effort: returns [] on any failure (no key, rate limit, network) so
// callers just proceed without headlines rather than blocking the trade.
//
// companyName filter: Finnhub's company-news endpoint, queried with
// symbol=WDC, still returned sector-roundup articles that were actually
// about Seagate/SanDisk/Micron/Intel with no WDC-specific content at all —
// confirmed live, Gemini built a SELL reasoning off "memory crash" headlines
// none of which explained WDC's own +15.8% move that same day. Finnhub
// evidently cross-tags broad sector articles under every related ticker.
// Requiring the actual company name to appear in the headline text filters
// those out — better to surface fewer, genuinely-relevant headlines than
// hand Gemini a stack of sector noise about competitors.
export async function fetchCompanyHeadlines(ticker: string, limit = 5, companyName?: string): Promise<string[]> {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return [];

  const today   = new Date().toISOString().split('T')[0];
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(ticker)}&from=${weekAgo}&to=${today}&token=${key}`,
      { signal: AbortSignal.timeout(6_000) },
    );
    if (!res.ok) return [];
    const raw = await res.json() as Array<{ headline?: string; datetime?: number }>;
    if (!Array.isArray(raw)) return [];

    // Match on the first word of the display name (e.g. "Western" out of
    // "Western Digital") rather than the full name — headlines commonly
    // abbreviate ("Western Digital Corp", "WD") but rarely drop the
    // distinctive first word entirely.
    const nameFragment = companyName?.split(' ')[0]?.toLowerCase();
    const relevant = (h: string) => {
      const lower = h.toLowerCase();
      return lower.includes(ticker.toLowerCase()) || (!!nameFragment && lower.includes(nameFragment));
    };

    return raw
      .filter(a => !!a.headline && (!companyName || relevant(a.headline)))
      .sort((a, b) => (b.datetime ?? 0) - (a.datetime ?? 0))
      .slice(0, limit)
      .map(a => a.headline!);
  } catch {
    return [];
  }
}

// Real per-instrument news for Gemini's entry confirmation — same Finnhub
// source the Alpaca "AI Strategy Recommendation" panel already uses
// (app/api/alpaca/recommend/route.ts), just wired into actual IG trade
// decisions for a specific instrument instead of a general strategy pick.
// Best-effort: returns [] on any failure (no key, rate limit, network) so
// callers just proceed without headlines rather than blocking the trade.
export async function fetchCompanyHeadlines(ticker: string, limit = 5): Promise<string[]> {
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
    return raw
      .filter(a => !!a.headline)
      .sort((a, b) => (b.datetime ?? 0) - (a.datetime ?? 0))
      .slice(0, limit)
      .map(a => a.headline!);
  } catch {
    return [];
  }
}

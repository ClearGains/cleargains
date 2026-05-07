/**
 * Server-side Finnhub helper.
 * Fetches real-time quotes in parallel, capped to avoid hitting the
 * free-tier rate limit (60 req/min). Import only from API routes.
 */

export type FinnhubQuote = { c: number; pc: number; dp: number };

export async function fetchFinnhubBatch(
  symbols: string[],
  cap = 50,
): Promise<Map<string, FinnhubQuote>> {
  const key = process.env.FINNHUB_API_KEY;
  if (!key || symbols.length === 0) return new Map();

  const map = new Map<string, FinnhubQuote>();
  await Promise.all(
    symbols.slice(0, cap).map(async sym => {
      try {
        const res = await fetch(
          `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${key}`,
          { signal: AbortSignal.timeout(5_000) },
        );
        if (!res.ok) return;
        const d = await res.json() as { c?: number; pc?: number; dp?: number };
        if (d.c && d.c > 0) map.set(sym, { c: d.c, pc: d.pc ?? 0, dp: d.dp ?? 0 });
      } catch { /* skip */ }
    }),
  );
  return map;
}

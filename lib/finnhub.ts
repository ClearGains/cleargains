/**
 * Server-side Finnhub helper.
 * Fetches real-time quotes and company news in parallel, capped to avoid
 * hitting the free-tier rate limit (60 req/min). Import only from API routes.
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

// ── Company news ────────────────────────────────────────────────────────────

export type NewsResult = {
  count: number;        // articles in last 24h
  topHeadline: string | null;
};

// 30-min server-side cache — news doesn't change minute-to-minute
const _newsCache = new Map<string, { data: NewsResult; ts: number }>();
const NEWS_TTL   = 30 * 60_000;

/**
 * Fetch recent company news for a batch of symbols.
 * Only fetches for symbols not already in cache.
 * Cap = max symbols to actually call the API for (default 15, free tier safe).
 */
export async function fetchFinnhubNewsBatch(
  symbols: string[],
  cap = 15,
): Promise<Map<string, NewsResult>> {
  const key = process.env.FINNHUB_API_KEY;
  if (!key || symbols.length === 0) return new Map();

  const out     = new Map<string, NewsResult>();
  const now     = Date.now();
  const toDate  = new Date(now).toISOString().slice(0, 10);
  const fromDate = new Date(now - 48 * 3_600_000).toISOString().slice(0, 10);
  const cutoff24h = now - 24 * 3_600_000;

  // Serve cached results first
  const toFetch = symbols.filter(sym => {
    const hit = _newsCache.get(sym);
    if (hit && now - hit.ts < NEWS_TTL) { out.set(sym, hit.data); return false; }
    return true;
  });

  await Promise.all(
    toFetch.slice(0, cap).map(async sym => {
      try {
        const res = await fetch(
          `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(sym)}&from=${fromDate}&to=${toDate}&token=${key}`,
          { signal: AbortSignal.timeout(6_000) },
        );
        if (!res.ok) return;
        const articles = await res.json() as { headline: string; datetime: number }[];
        const recent   = articles.filter(a => a.datetime * 1000 >= cutoff24h);
        const result: NewsResult = {
          count:       recent.length,
          topHeadline: recent[0]?.headline ?? null,
        };
        out.set(sym, result);
        _newsCache.set(sym, { data: result, ts: now });
      } catch { /* skip — news is additive context, not required */ }
    }),
  );
  return out;
}

// Earnings-date guard — mean-reversion and breakout entries right before an
// earnings report are coin flips with fat tails. When FINNHUB_API_KEY is set,
// the bot skips new entries on symbols reporting within the next N days.
// Without a key the guard is a no-op (never blocks trading).

type CalendarEntry = { symbol?: string; date?: string };

let cacheDay = '';
let upcoming = new Set<string>();
let fetchFailed = false;

const GUARD_DAYS = 2;

async function refresh(): Promise<void> {
  const key = process.env.FINNHUB_API_KEY ?? '';
  if (!key) return;

  const today = new Date();
  const from  = today.toISOString().slice(0, 10);
  const to    = new Date(today.getTime() + GUARD_DAYS * 86_400_000).toISOString().slice(0, 10);
  const url   = `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${key}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Finnhub ${res.status}`);
    const data = await res.json() as { earningsCalendar?: CalendarEntry[] };
    upcoming = new Set(
      (data.earningsCalendar ?? [])
        .map(e => (e.symbol ?? '').toUpperCase())
        .filter(Boolean)
    );
    fetchFailed = false;
    console.log(`[earnings-guard] ${upcoming.size} symbols report within ${GUARD_DAYS} days`);
  } catch (e) {
    fetchFailed = true;
    console.error(`[earnings-guard] refresh failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * True when the symbol has earnings within the next 2 days and entries should
 * be skipped. Fails OPEN (returns false) when no API key is configured or the
 * calendar fetch failed — the guard must never halt trading by itself.
 */
export async function hasImminentEarnings(symbol: string): Promise<boolean> {
  if (!process.env.FINNHUB_API_KEY) return false;
  const today = new Date().toISOString().slice(0, 10);
  if (cacheDay !== today) {
    cacheDay = today;
    await refresh();
  }
  if (fetchFailed) return false;
  return upcoming.has(symbol.toUpperCase());
}

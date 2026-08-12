// Real macro/economic-calendar events for the FX bot's entry prompt.
// Uses Forex Factory's own public calendar feed (the same JSON backend its
// widget uses — no API key, no auth) rather than Finnhub's economic-
// calendar endpoint: confirmed live that endpoint 403s on this account's
// Finnhub plan (a paid-tier-only feature, unlike the company-news endpoint
// newsFetch.ts already uses successfully). This feed is also a better fit
// for FX specifically — it tags events by currency code directly
// (USD/GBP/EUR/JPY/AUD/...) rather than country, with exactly the
// impact/forecast/previous fields needed here.
//
// Deliberately doesn't attempt to compute a numeric "inflation
// differential" or similar model — that would just be guessing at a
// relationship rather than reporting a real one. This surfaces the actual
// reported/scheduled events (rate decisions, CPI, employment, GDP) and
// lets Gemini reason about them, same pattern as fetchCompanyHeadlines for
// stock news. Fails closed (returns []) on any fetch/parse problem — never
// falls back to placeholder/sample data the way the app's own World
// Affairs calendar page does, since fabricated macro data feeding a real
// trade decision would be actively misleading, not just cosmetically off.

type FFEvent = {
  title?:    string;
  country?:  string;  // actually a currency code (USD, GBP, EUR, JPY, ...), not an ISO country
  date?:     string;  // ISO datetime with timezone offset
  impact?:   string;  // 'High' | 'Medium' | 'Low' | 'Holiday'
  forecast?: string;
  previous?: string;
};

async function fetchWeek(which: 'lastweek' | 'thisweek' | 'nextweek'): Promise<FFEvent[]> {
  try {
    const res = await fetch(`https://nfs.faireconomy.media/ff_calendar_${which}.json`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return [];
    const data = await res.json() as unknown;
    return Array.isArray(data) ? data as FFEvent[] : [];
  } catch {
    return [];
  }
}

export async function fetchMacroEvents(currencyCodes: string[], limit = 6): Promise<string[]> {
  if (!currencyCodes.length) return [];
  const currencies = new Set(currencyCodes);

  // Covers a rolling window regardless of where "today" falls within the
  // calendar week — thisweek alone would miss a recent event from late
  // last week, or an upcoming one landing just into next week.
  const [last, thisW, next] = await Promise.all([
    fetchWeek('lastweek'), fetchWeek('thisweek'), fetchWeek('nextweek'),
  ]);
  const all = [...last, ...thisW, ...next];

  const now      = Date.now();
  const windowMs = 3 * 86_400_000; // 3 days either side of now

  return all
    .filter(e => e.title && e.country && e.impact === 'High' && currencies.has(e.country))
    .map(e => ({ ts: e.date ? new Date(e.date).getTime() : NaN, e }))
    .filter(({ ts }) => Number.isFinite(ts) && Math.abs(ts - now) <= windowMs)
    .sort((a, b) => Math.abs(a.ts - now) - Math.abs(b.ts - now)) // closest to right-now first
    .slice(0, limit)
    .map(({ ts, e }) => {
      const dateLabel = new Date(ts).toISOString().slice(0, 10);
      const timing    = ts > now ? 'upcoming' : 'past';
      const figures   = [e.previous ? `prev ${e.previous}` : '', e.forecast ? `est ${e.forecast}` : ''].filter(Boolean).join(', ');
      return `[${dateLabel}, ${timing}] ${e.country}: ${e.title}${figures ? ` (${figures})` : ''}`;
    });
}

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
export async function fetchCompanyHeadlines(ticker: string, limit = 8, companyName?: string): Promise<string[]> {
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

    // Dated, not just a bag of recent headlines — confirmed live Gemini had
    // no way to tell "this happened today" from "this happened 6 days ago"
    // within the same 7-day window, so it couldn't build any real sense of
    // how a story has developed day to day (a beat that's already 4 days
    // old and priced in reads very differently from one that broke an hour
    // ago).
    return raw
      .filter(a => !!a.headline && (!companyName || relevant(a.headline)))
      .sort((a, b) => (b.datetime ?? 0) - (a.datetime ?? 0))
      .slice(0, limit)
      .map(a => {
        const dateLabel = a.datetime
          ? new Date(a.datetime * 1000).toISOString().slice(0, 10)
          : '?';
        return `[${dateLabel}] ${a.headline!}`;
      });
  } catch {
    return [];
  }
}

// Finviz's per-ticker news table — a second, independent source alongside
// Finnhub above. Not an official API (no key/ToS-sanctioned access), so
// treat it the same way this codebase already treats Yahoo's own unofficial
// endpoints: best-effort, cached, low-frequency, never surfaced to users as
// raw redistributed content — only ever fed into Gemini's own reasoning as
// one more input, same as Finnhub's headlines already are. Checked
// finviz.com/robots.txt before building this: /quote.ashx isn't disallowed
// and, unlike finance.yahoo.com/robots.txt, Finviz's file has no
// ClaudeBot/Claude-Web/anthropic-ai-specific block.
const FINVIZ_CACHE_TTL_MS = 20 * 60_000;
const finvizCache = new Map<string, { at: number; headlines: string[] }>();

function monthIndex(abbr: string): number {
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(abbr);
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

export async function fetchFinvizHeadlines(ticker: string, limit = 8): Promise<string[]> {
  const cached = finvizCache.get(ticker);
  if (cached && Date.now() - cached.at < FINVIZ_CACHE_TTL_MS) return cached.headlines.slice(0, limit);

  try {
    const res = await fetch(`https://finviz.com/quote.ashx?t=${encodeURIComponent(ticker)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return cached?.headlines.slice(0, limit) ?? [];
    const html = await res.text();

    // Each news row: a time cell ("Today HH:MMAM/PM", "Mon-DD-YY HH:MMAM/PM",
    // or a bare "HH:MMAM/PM" that inherits the date from the most recent
    // row above it that did specify one) followed by a headline link.
    const rowRe = /<tr class="cursor-pointer has-label"[^>]*>\s*<td width="130" align="right">\s*([^<]+?)\s*<\/td>[\s\S]*?<a class="tab-link-news"[^>]*>\s*([^<]+?)\s*<\/a>/g;
    const today = new Date();
    let currentDateISO = today.toISOString().slice(0, 10);
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(html)) && out.length < limit * 3) {
      const timeCell = m[1].trim();
      const headline = decodeHtmlEntities(m[2].trim().replace(/\s+/g, ' '));
      const dateMatch = timeCell.match(/^([A-Z][a-z]{2})-(\d{2})-(\d{2})\s/);
      if (timeCell.startsWith('Today')) {
        currentDateISO = today.toISOString().slice(0, 10);
      } else if (dateMatch) {
        const mIdx = monthIndex(dateMatch[1]);
        if (mIdx >= 0) {
          const day  = Number(dateMatch[2]);
          const year = 2000 + Number(dateMatch[3]);
          currentDateISO = new Date(Date.UTC(year, mIdx, day)).toISOString().slice(0, 10);
        }
      }
      // else: bare time-only row — keep currentDateISO as carried forward
      if (headline) out.push(`[${currentDateISO}] ${headline}`);
    }

    finvizCache.set(ticker, { at: Date.now(), headlines: out });
    return out.slice(0, limit);
  } catch {
    return cached?.headlines.slice(0, limit) ?? [];
  }
}

// Merges both sources for callers that just want "the news" without caring
// where it came from — Finnhub and Finviz both surface real stories the
// other one misses often enough that neither alone is reliably complete.
// Drop-in replacement for a bare fetchCompanyHeadlines call; same "[date]
// headline" format, same best-effort semantics.
export async function fetchAllHeadlines(ticker: string, limit = 8, companyName?: string): Promise<string[]> {
  const [finnhub, finviz] = await Promise.all([
    fetchCompanyHeadlines(ticker, limit, companyName),
    fetchFinvizHeadlines(ticker, limit),
  ]);
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const h of [...finnhub, ...finviz]) {
    // Dedupe on the headline text alone (post-date-prefix) — the same
    // story often appears through both sources with a different source
    // label attached, and Gemini doesn't need to see it twice.
    const key = h.replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(h);
  }
  // Most-recent-first — both sources already return newest-first, but
  // re-sort once merged since interleaving two separately-sorted lists
  // doesn't preserve that on its own.
  return merged
    .sort((a, b) => (b.match(/^\[([\d-]+)\]/)?.[1] ?? '').localeCompare(a.match(/^\[([\d-]+)\]/)?.[1] ?? ''))
    .slice(0, limit);
}

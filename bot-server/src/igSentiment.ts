// ── IG client sentiment (2026-10-29) ─────────────────────────────────────────
// What share of IG's clients are long vs short each market the bots trade.
// Shown on the site's IG tab and in Opus's briefing as crowd positioning
// (IG's clients are mostly retail; heavy one-sidedness is often read as a
// contrary signal). Cached for 5 minutes; market IDs for a day.
import { authenticate, type IGSession } from './igApi';
import { resolveCredentials } from './igStrategyBot';

const BASE = { demo: 'https://demo-api.ig.com/gateway/deal', live: 'https://api.ig.com/gateway/deal' } as const;

export type SentimentRow = { key: string; name: string; epic: string; marketId: string; longPct: number; shortPct: number };

let session: IGSession | null = null;
let sessionAt = 0;
const marketIds = new Map<string, string>();   // epic -> marketId
let marketIdsAt = 0;
let cache: { at: number; rows: SentimentRow[] } | null = null;

async function igSession(): Promise<IGSession> {
  if (session && Date.now() - sessionAt < 4 * 3_600_000) return session;
  const c = resolveCredentials('demo');
  session = await authenticate(c.apiKey, c.username, c.password, 'demo', 'sentiment');
  sessionAt = Date.now();
  return session;
}

async function igGet<T>(path: string, version: string): Promise<T> {
  const s = await igSession();
  const r = await fetch(`${BASE[s.env]}${path}`, {
    headers: { 'X-IG-API-KEY': s.apiKey, CST: s.cst, 'X-SECURITY-TOKEN': s.securityToken, Accept: 'application/json; charset=UTF-8', Version: version },
    signal: AbortSignal.timeout(10_000),
  });
  if (r.status === 401) { session = null; throw new Error('IG session expired'); }
  if (!r.ok) throw new Error(`IG ${r.status}: ${(await r.text()).slice(0, 150)}`);
  return r.json() as Promise<T>;
}

export async function getIgSentiment(markets: Record<string, { epic: string; name: string }>): Promise<SentimentRow[]> {
  if (cache && Date.now() - cache.at < 5 * 60_000) return cache.rows;
  const epics = Object.values(markets).map(m => m.epic);
  if (Date.now() - marketIdsAt > 86_400_000 || epics.some(e => !marketIds.has(e))) {
    for (let i = 0; i < epics.length; i += 40) {
      const d = await igGet<{ marketDetails?: Array<{ instrument?: { epic?: string; marketId?: string } }> }>(`/markets?epics=${epics.slice(i, i + 40).map(encodeURIComponent).join(',')}`, '2');
      for (const m of d.marketDetails ?? []) if (m.instrument?.epic && m.instrument.marketId) marketIds.set(m.instrument.epic, m.instrument.marketId);
    }
    marketIdsAt = Date.now();
  }
  const ids = [...new Set(epics.map(e => marketIds.get(e)).filter((x): x is string => !!x))];
  const d = await igGet<{ clientSentiments?: Array<{ marketId: string; longPositionPercentage: number; shortPositionPercentage: number }> }>(`/clientsentiment?marketIds=${ids.map(encodeURIComponent).join(',')}`, '1');
  const byId = new Map((d.clientSentiments ?? []).map(x => [x.marketId, x]));
  const rows: SentimentRow[] = [];
  for (const [key, m] of Object.entries(markets)) {
    const id = marketIds.get(m.epic);
    const x = id ? byId.get(id) : undefined;
    if (x) rows.push({ key, name: m.name, epic: m.epic, marketId: id!, longPct: x.longPositionPercentage, shortPct: x.shortPositionPercentage });
  }
  cache = { at: Date.now(), rows };
  return rows;
}

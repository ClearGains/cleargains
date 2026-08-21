// Bot-vs-manual P&L attribution for the IG live account — built after two
// dead ends: IG's own activity/transaction endpoints share no exact join
// key (dealId isn't on /history/transactions at all, and its own
// `reference` field is a different ID space from a real position dealId —
// confirmed live, 0/42 matched on an exact join). A fuzzy join (same
// instrument, open timestamp within 15s, via each transaction's own
// openDateUtc) recovers a real match rate instead — confirmed live at 86%
// on a 3-day sample.
//
// Hard limitation, not fixable here: IG's /history/activity endpoint only
// ever returns roughly the last 2-3 days of real data no matter how far
// back `from` is set or how many pages are requested — confirmed live
// twice now (an earlier session and this one). This makes true multi-week
// historical attribution impossible via this API; the result below is
// only ever as deep as that window allows.
import { authenticate, type IGSession } from './igApi';
import { IG_EPICS } from './igStrategyScanner';
import { resolveCredentials, type IgMode } from './igStrategyBot';

const FX_EPIC_NAMES: Record<string, string> = {
  'CS.D.GBPUSD.TODAY.IP': 'GBP/USD',
  'CS.D.EURUSD.TODAY.IP': 'EUR/USD',
  'CS.D.USDJPY.TODAY.IP': 'USD/JPY',
  'CS.D.EURGBP.TODAY.IP': 'EUR/GBP',
  'CS.D.AUDUSD.TODAY.IP': 'AUD/USD',
};

const MATCH_WINDOW_MS = 15_000;

export type AttributionBucket = {
  trades:  number;
  plGbp:   number;
  winRate: number; // %
};

export type TradeAttribution = {
  ok: true;
  activityWindowFrom: string | null;
  activityWindowTo:   string | null;
  bot:      AttributionBucket;
  manual:   AttributionBucket;
  matched:  number;
  total:    number;
  note:     string;
};

function parsePl(s: unknown): number {
  return parseFloat(String(s).replace(/[^0-9.-]/g, '')) || 0;
}

export async function computeTradeAttribution(mode: IgMode): Promise<TradeAttribution | { ok: false; error: string }> {
  const creds = resolveCredentials(mode);
  if (!creds.apiKey || !creds.username || !creds.password) {
    return { ok: false, error: `${mode} IG credentials not configured` };
  }

  let session: IGSession;
  try {
    session = await authenticate(creds.apiKey, creds.username, creds.password, creds.env);
  } catch (e) {
    return { ok: false, error: `IG auth failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const base = session.env === 'live' ? 'https://api.ig.com/gateway/deal' : 'https://demo-api.ig.com/gateway/deal';
  const headers = {
    'X-IG-API-KEY': creds.apiKey, 'CST': session.cst, 'X-SECURITY-TOKEN': session.securityToken,
    'Accept': 'application/json; charset=UTF-8',
  };
  const from = new Date(Date.now() - 20 * 24 * 3600_000).toISOString().slice(0, 19);

  // Activity: real dealId + channel, but IG only ever returns ~2-3 days
  // regardless of `from` — pull generously anyway in case that changes.
  let activities: Array<{ date: string; epic: string; dealId: string; channel: string; type: string; status: string; description: string }> = [];
  for (let page = 1; page <= 10; page++) {
    const r = await fetch(`${base}/history/activity?from=${from}&pageSize=200&pageNumber=${page}`,
      { headers: { ...headers, 'Version': '3' }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) break;
    const d = await r.json() as { activities?: typeof activities };
    if (!d.activities?.length) break;
    activities = activities.concat(d.activities);
    if (d.activities.length < 200) break;
  }
  const opens = activities.filter(a => a.type === 'POSITION' && a.status === 'ACCEPTED' && /position opened/i.test(a.description ?? ''));
  const dates = activities.map(a => a.date).sort();

  const epicToName = new Map<string, string>(IG_EPICS.map(e => [e.epic, e.name]));
  for (const [epic, name] of Object.entries(FX_EPIC_NAMES)) epicToName.set(epic, name);

  // Transactions: real £ P&L, but no reliable dealId of its own.
  const txRes = await fetch(`${base}/history/transactions?type=ALL_DEAL&from=${from}&pageSize=200`,
    { headers: { ...headers, 'Version': '2' }, signal: AbortSignal.timeout(10_000) });
  const txData = txRes.ok ? await txRes.json() as { transactions?: any[] } : { transactions: [] };
  const txs = (txData.transactions ?? []).filter((t: any) => t.transactionType === 'DEAL');

  let botTrades = 0, manualTrades = 0, botPl = 0, manualPl = 0, botWins = 0, manualWins = 0, matched = 0;
  for (const t of txs) {
    const openTime = new Date(t.openDateUtc + 'Z').getTime();
    let best: (typeof opens)[number] | null = null, bestDelta = Infinity;
    for (const a of opens) {
      const shortName = epicToName.get(a.epic);
      if (!shortName) continue;
      const nameMatches = t.instrumentName.includes(shortName) || shortName.includes(String(t.instrumentName).split(' ')[0]);
      if (!nameMatches) continue;
      const delta = Math.abs(new Date(a.date + 'Z').getTime() - openTime);
      if (delta < bestDelta) { bestDelta = delta; best = a; }
    }
    if (!best || bestDelta > MATCH_WINDOW_MS) continue;
    matched++;
    const pl = parsePl(t.profitAndLoss);
    if (best.channel === 'PUBLIC_WEB_API') {
      botTrades++; botPl += pl; if (pl > 0) botWins++;
    } else {
      manualTrades++; manualPl += pl; if (pl > 0) manualWins++;
    }
  }

  return {
    ok: true,
    activityWindowFrom: dates[0] ?? null,
    activityWindowTo:   dates[dates.length - 1] ?? null,
    bot:    { trades: botTrades, plGbp: Math.round(botPl * 100) / 100, winRate: botTrades ? Math.round(botWins / botTrades * 1000) / 10 : 0 },
    manual: { trades: manualTrades, plGbp: Math.round(manualPl * 100) / 100, winRate: manualTrades ? Math.round(manualWins / manualTrades * 1000) / 10 : 0 },
    matched,
    total: txs.length,
    note: 'Fuzzy-matched by instrument + open-time proximity (IG exposes no exact join key between its own history endpoints). Only covers whatever window IG\'s activity endpoint actually returns (typically the last 2-3 days) — not a full historical record.',
  };
}

// Persistent trade journal — survives bot restarts so per-strategy performance
// can actually be measured. One JSON file per account mode, written on every
// record; loaded lazily on first access.

import fs from 'fs';
import path from 'path';

// 'paper'/'live' are the Alpaca auto-trader's own modes; 'ig-demo'/'ig-live'
// are the IG strategy bot's; 't212-demo'/'t212-live' are the ISA bot's —
// kept as distinct values (not reused generic 'live') so the systems' P&L
// never gets aggregated together in one strategy's stats despite genuinely
// being different accounts/instruments.
export type JournalMode = 'paper' | 'live' | 'ig-demo' | 'ig-live' | 't212-demo' | 't212-live' | 'meme-paper';

export type JournalEvent = {
  id:       string;
  ts:       string;            // ISO timestamp
  mode:     JournalMode;
  event:    'entry' | 'exit';
  symbol:   string;
  strategy: string;
  side:     'long' | 'short';
  qty:      number;
  price:    number;            // fill/reference price at the time
  reason:   string;            // signal reason that caused it
  confidence?: number;         // 0-100, when the strategy produced one (e.g. gemini_opinion, gemini_confirmed)
  plUsd?:   number;            // exits only — realized P&L in account currency (USD for Alpaca, GBP for IG)
  plPct?:   number;            // exits only — realized P&L %
};

export type StrategyAggregate = {
  strategy:    string;
  entries:     number;
  exits:       number;
  wins:        number;
  losses:      number;
  totalPlUsd:  number;
  avgPlPct:    number;
  winRate:     number;         // %
};

const MAX_RECORDS = 5_000;

function journalPath(mode: JournalMode): string {
  return path.join(process.cwd(), `trade-journal-${mode}.json`);
}

const cache = new Map<JournalMode, JournalEvent[]>();

function load(mode: JournalMode): JournalEvent[] {
  const cached = cache.get(mode);
  if (cached) return cached;
  let records: JournalEvent[] = [];
  try {
    const raw = fs.readFileSync(journalPath(mode), 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) records = parsed as JournalEvent[];
  } catch { /* no file yet */ }
  cache.set(mode, records);
  return records;
}

function persist(mode: JournalMode, records: JournalEvent[]): void {
  try {
    fs.writeFileSync(journalPath(mode), JSON.stringify(records), 'utf8');
  } catch (e) {
    console.error(`[journal] persist failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function recordJournalEvent(ev: Omit<JournalEvent, 'id' | 'ts'>): void {
  const records = load(ev.mode);
  records.push({
    ...ev,
    id: Math.random().toString(36).slice(2, 10),
    ts: new Date().toISOString(),
  });
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
  persist(ev.mode, records);
}

export function getJournal(mode: JournalMode, limit = 500): {
  records: JournalEvent[];
  aggregates: StrategyAggregate[];
} {
  const records = load(mode);

  const byStrategy = new Map<string, JournalEvent[]>();
  for (const r of records) {
    const arr = byStrategy.get(r.strategy) ?? [];
    arr.push(r);
    byStrategy.set(r.strategy, arr);
  }

  const aggregates: StrategyAggregate[] = [...byStrategy.entries()].map(([strategy, evs]) => {
    const exits  = evs.filter(e => e.event === 'exit');
    const wins   = exits.filter(e => (e.plUsd ?? 0) > 0);
    const losses = exits.filter(e => (e.plUsd ?? 0) <= 0);
    const totalPlUsd = exits.reduce((s, e) => s + (e.plUsd ?? 0), 0);
    const avgPlPct = exits.length
      ? exits.reduce((s, e) => s + (e.plPct ?? 0), 0) / exits.length
      : 0;
    return {
      strategy,
      entries: evs.filter(e => e.event === 'entry').length,
      exits: exits.length,
      wins: wins.length,
      losses: losses.length,
      totalPlUsd,
      avgPlPct,
      winRate: exits.length ? (wins.length / exits.length) * 100 : 0,
    };
  }).sort((a, b) => b.totalPlUsd - a.totalPlUsd);

  return { records: records.slice(-limit).reverse(), aggregates };
}

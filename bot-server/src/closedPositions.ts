// ── Closed positions, from the brokers' own records (2026-10-23) ─────────────
// Feeds the "Closed positions" card on the Alpaca and IG spread-bet tabs
// (owner: "easy to find", last week or so). The brokers are the ground
// truth, not any bot's journal:
//  - IG: the transaction history (open/close level, P&L as IG booked it).
//  - Alpaca: account fills, paired first-in-first-out per symbol into round
//    trips. Opening fills are read from 90 days back, so a trade opened weeks
//    ago and closed this week still pairs correctly.
// Each trade is labelled with who opened it when Opus has a matching record
// (same market, opened within a few minutes); otherwise "other bot / manual".
import { getFillsSince } from './alpacaApi';
import { authenticate, fetchClosedTransactions } from './igApi';
import { resolveCredentials } from './igStrategyBot';
import { opusClosedRefs } from './opusTrader';
import { momentumHistory } from './momentumBot';

export type ClosedTrade = {
  market:     string;
  direction:  'long' | 'short';
  qty:        number | null;
  openedAt:   string | null;
  closedAt:   string;
  entry:      number | null;
  exit:       number | null;
  pl:         number;          // account currency (USD Alpaca, GBP IG)
  heldHours:  number | null;
  openedBy:   'opus' | 'momentum' | 'other';
  probe?:     boolean;
};

const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

async function alpacaClosed(mode: 'paper' | 'live', days: number): Promise<ClosedTrade[]> {
  const fills = await getFillsSince(mode, new Date(Date.now() - 90 * DAY).toISOString());
  const cutoff = Date.now() - days * DAY;
  const opus = mode === 'paper' ? opusClosedRefs().filter(r => r.account === 'alpaca_paper') : [];
  type Lot = { qty: number; price: number; ts: number };
  const lots = new Map<string, { side: 'long' | 'short'; lots: Lot[] }>();
  const out: ClosedTrade[] = [];
  for (const f of fills) {
    const qty = parseFloat(f.qty), price = parseFloat(f.price), ts = Date.parse(f.transaction_time);
    const isBuy = f.side === 'buy';
    // Option contracts are 100 shares each.
    const mult = /\d{6}[CP]\d{8}$/.test(f.symbol) ? 100 : 1;
    let book = lots.get(f.symbol);
    let remaining = qty;
    // A fill against an existing book closes it (FIFO) before opening anything new.
    if (book && book.lots.length && (book.side === 'long') !== isBuy) {
      while (remaining > 1e-9 && book.lots.length) {
        const lot = book.lots[0];
        const take = Math.min(lot.qty, remaining);
        const pl = (book.side === 'long' ? price - lot.price : lot.price - price) * take * mult;
        if (ts >= cutoff) {
          const ref = opus.find(r => r.symbol === f.symbol && Math.abs(r.openedAt - lot.ts) < 10 * 60_000);
          out.push({ market: f.symbol, direction: book.side, qty: take, openedAt: new Date(lot.ts).toISOString(), closedAt: f.transaction_time,
            entry: lot.price, exit: price, pl: round2(pl), heldHours: round2((ts - lot.ts) / 3_600_000), openedBy: ref ? 'opus' : 'other', probe: ref?.probe });
        }
        lot.qty -= take; remaining -= take;
        if (lot.qty <= 1e-9) book.lots.shift();
      }
    }
    if (remaining > 1e-9) {
      if (!book || !book.lots.length) { book = { side: isBuy ? 'long' : 'short', lots: [] }; lots.set(f.symbol, book); }
      book.lots.push({ qty: remaining, price, ts });
    }
  }
  return out;
}

async function igClosed(mode: 'demo' | 'live', days: number): Promise<ClosedTrade[]> {
  const c = resolveCredentials(mode);
  const session = await authenticate(c.apiKey, c.username, c.password, mode, 'closed-positions');
  const tx = await fetchClosedTransactions(session, new Date(Date.now() - days * DAY).toISOString());
  const opus = mode === 'demo' ? opusClosedRefs().filter(r => r.account === 'ig_demo') : [];
  // Momentum Testbot (same demo account, own process): matched on open time and level.
  const momentum = momentumHistory(mode);   // demo and live copies keep separate histories
  return tx.map(t => {
    const opened = t.openDateUtc ? Date.parse(t.openDateUtc + 'Z') : null;
    const closed = Date.parse(t.closeDateUtc + 'Z');
    // IG's history has no direction field: a gain with a rising price (or a
    // loss with a falling one) means it was a long.
    const moved = (t.closeLevel ?? 0) - (t.openLevel ?? 0);
    const direction: 'long' | 'short' = moved === 0 ? 'long' : (moved > 0) === (t.profitAndLoss >= 0) ? 'long' : 'short';
    const mom = opened !== null ? momentum.find(d => Math.abs(Date.parse(d.opened_utc) - opened) < 3 * 60_000 && (d.level === null || t.openLevel == null || Math.abs(d.level - t.openLevel) <= Math.max(1, d.level * 0.001))) : undefined;
    const ref = !mom && opened !== null ? opus.find(r => Math.abs(r.openedAt - opened) < 5 * 60_000) : undefined;
    return {
      market: t.instrumentName, direction, qty: null,
      openedAt: opened !== null ? new Date(opened).toISOString() : null, closedAt: new Date(closed).toISOString(),
      entry: t.openLevel ?? null, exit: t.closeLevel ?? null, pl: round2(t.profitAndLoss),
      heldHours: opened !== null ? round2((closed - opened) / 3_600_000) : null,
      openedBy: mom ? 'momentum' as const : ref ? 'opus' as const : 'other' as const, probe: ref?.probe,
    };
  });
}

export async function getClosedPositions(broker: 'alpaca' | 'ig', mode: string, days: number): Promise<{ trades: ClosedTrade[]; currency: '$' | '£' }> {
  const d = Math.min(Math.max(days, 1), 60);
  const trades = broker === 'alpaca'
    ? await alpacaClosed(mode === 'live' ? 'live' : 'paper', d)
    : await igClosed(mode === 'live' ? 'live' : 'demo', d);
  // One exit can fill in several pieces (and pair against several opening
  // lots), so merge rows for the same market, minute, entry and exit.
  const merged = new Map<string, ClosedTrade>();
  for (const t of trades) {
    const key = `${t.market}|${t.closedAt.slice(0, 16)}|${t.entry}|${t.exit}|${t.direction}`;
    const m = merged.get(key);
    if (!m) { merged.set(key, { ...t }); continue; }
    m.pl = round2(m.pl + t.pl);
    if (m.qty !== null && t.qty !== null) m.qty = round2(m.qty + t.qty);
  }
  const out = [...merged.values()].sort((a, b) => b.closedAt.localeCompare(a.closedAt));
  return { trades: out, currency: broker === 'alpaca' ? '$' : '£' };
}

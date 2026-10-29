// ── Options positioning for a US stock (2026-10-29) ──────────────────────────
// The options "order book" the owner asked for on the Alpaca side: how much
// is riding on calls vs puts, at which strikes, and where fresh money went in
// today. From Alpaca (open interest from the contracts endpoint, today's
// volume from the option snapshots), expiries up to 180 days, strikes within
// ±20% of the price. Cached 15 minutes per symbol.
//
// Reading it: open interest is positions already open; volume above open
// interest on a contract means new positions today (often the larger, more
// informed players). Puts are also bought as insurance by funds, so a high
// put/call ratio isn't automatically bearish. Very large open-interest
// strikes can act as magnets or walls near their expiry.

const DATA = 'https://data.alpaca.markets/v1beta1/options/snapshots';
const TRADE = 'https://paper-api.alpaca.markets/v2/options/contracts';

export type OptionsFlow = {
  symbol: string; price: number; asOf: string;
  callOI: number; putOI: number; putCallOI: number | null;
  callVol: number; putVol: number; putCallVol: number | null;
  topCallStrikes: Array<{ strike: number; oi: number }>;
  topPutStrikes: Array<{ strike: number; oi: number }>;
  unusual: Array<{ contract: string; type: 'call' | 'put'; strike: number; expiry: string; volume: number; oi: number }>;
};

const cache = new Map<string, { at: number; flow: OptionsFlow }>();

function headers() {
  return { 'APCA-API-KEY-ID': process.env.ALPACA_PAPER_KEY ?? process.env.ALPACA_API_KEY ?? '', 'APCA-API-SECRET-KEY': process.env.ALPACA_PAPER_SECRET ?? process.env.ALPACA_SECRET_KEY ?? '' };
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Alpaca ${r.status}: ${(await r.text()).slice(0, 150)}`);
  return r.json() as Promise<T>;
}

export async function getOptionsFlow(symbol: string, price: number): Promise<OptionsFlow> {
  const sym = symbol.toUpperCase();
  const hit = cache.get(sym);
  if (hit && Date.now() - hit.at < 15 * 60_000) return hit.flow;
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const lo = (price * 0.8).toFixed(2), hi = (price * 1.2).toFixed(2);

  // Open interest per contract.
  type Contract = { symbol: string; type: 'call' | 'put'; strike_price: string; expiration_date: string; open_interest?: string | null };
  const contracts: Contract[] = [];
  let token = '';
  for (let p = 0; p < 6; p++) {
    const d = await getJson<{ option_contracts?: Contract[]; next_page_token?: string | null }>(
      `${TRADE}?underlying_symbols=${sym}&status=active&expiration_date_gte=${day(0)}&expiration_date_lte=${day(180)}&strike_price_gte=${lo}&strike_price_lte=${hi}&limit=1000${token ? `&page_token=${token}` : ''}`);
    contracts.push(...(d.option_contracts ?? []));
    if (!d.next_page_token) break;
    token = d.next_page_token;
  }

  // Today's volume per contract (only bars dated today count).
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const vol = new Map<string, number>();
  token = '';
  for (let p = 0; p < 6; p++) {
    const d = await getJson<{ snapshots?: Record<string, { dailyBar?: { v?: number; t?: string } }>; next_page_token?: string | null }>(
      `${DATA}/${sym}?feed=indicative&limit=1000&expiration_date_gte=${day(0)}&expiration_date_lte=${day(180)}&strike_price_gte=${lo}&strike_price_lte=${hi}${token ? `&page_token=${token}` : ''}`);
    for (const [k, s] of Object.entries(d.snapshots ?? {})) {
      const t = s.dailyBar?.t ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(s.dailyBar.t)) : '';
      if (t === today && s.dailyBar?.v) vol.set(k, s.dailyBar.v);
    }
    if (!d.next_page_token) break;
    token = d.next_page_token;
  }

  let callOI = 0, putOI = 0, callVol = 0, putVol = 0;
  const callByStrike = new Map<number, number>(), putByStrike = new Map<number, number>();
  const unusual: OptionsFlow['unusual'] = [];
  for (const c of contracts) {
    const oi = Number(c.open_interest ?? 0) || 0;
    const v = vol.get(c.symbol) ?? 0;
    const strike = Number(c.strike_price);
    if (c.type === 'call') { callOI += oi; callVol += v; callByStrike.set(strike, (callByStrike.get(strike) ?? 0) + oi); }
    else { putOI += oi; putVol += v; putByStrike.set(strike, (putByStrike.get(strike) ?? 0) + oi); }
    if (v >= 500 && v > oi) unusual.push({ contract: c.symbol, type: c.type, strike, expiry: c.expiration_date, volume: v, oi });
  }
  const top = (m: Map<number, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([strike, oi]) => ({ strike, oi }));
  const flow: OptionsFlow = {
    symbol: sym, price, asOf: new Date().toISOString(),
    callOI, putOI, putCallOI: callOI > 0 ? Math.round((putOI / callOI) * 100) / 100 : null,
    callVol, putVol, putCallVol: callVol > 0 ? Math.round((putVol / callVol) * 100) / 100 : null,
    topCallStrikes: top(callByStrike), topPutStrikes: top(putByStrike),
    unusual: unusual.sort((a, b) => b.volume - a.volume).slice(0, 4),
  };
  cache.set(sym, { at: Date.now(), flow });
  return flow;
}

export function describeFlow(f: OptionsFlow): string {
  const n = (x: number) => x.toLocaleString('en-US');
  const strikes = (xs: Array<{ strike: number; oi: number }>) => xs.map(x => `${x.strike} (${n(x.oi)})`).join(', ') || 'none';
  const lines = [
    `Options positioning for ${f.symbol} (price ${f.price.toFixed(2)}; expiries up to 180 days, strikes within ±20%):`,
    `- Open interest: calls ${n(f.callOI)} vs puts ${n(f.putOI)} (put/call ${f.putCallOI ?? '—'}). Today's volume: calls ${n(f.callVol)} vs puts ${n(f.putVol)} (put/call ${f.putCallVol ?? '—'}).`,
    `- Biggest call open interest at strikes ${strikes(f.topCallStrikes)}; biggest put open interest at ${strikes(f.topPutStrikes)}.`,
    f.unusual.length
      ? `- Fresh positioning today (volume above open interest, often larger players): ${f.unusual.map(u => `${u.strike} ${u.type} ${u.expiry} vol ${n(u.volume)} vs OI ${n(u.oi)}`).join('; ')}.`
      : '- No unusual fresh positioning today (no contract traded more than its open interest with 500+ volume).',
    '- Read with care: funds buy puts as insurance, so a high put/call ratio is not automatically bearish; large open-interest strikes can pin or cap price near their expiry.',
  ];
  return lines.join('\n');
}

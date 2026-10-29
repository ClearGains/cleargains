// ── CFTC Commitments of Traders (2026-10-29) ─────────────────────────────────
// Weekly positioning of the big players ("non-commercials": funds and
// large traders) in the US futures behind the IG markets the bots trade.
// Free public data from the US regulator (publicreporting.cftc.gov, legacy
// futures-only report). Published Fridays for the Tuesday before; cached 6h.

export type CotRow = {
  key: string;            // IG market key (e.g. NATGAS)
  market: string;         // CFTC market name
  reportDate: string;     // YYYY-MM-DD (positions as of this Tuesday)
  specLongPct: number;    // big speculators: long / (long + short), %
  specNet: number;        // long - short, contracts
  netChangeWeek: number;  // change in net over the week, contracts
  note?: string;
  source: 'legacy' | 'tff';
  // Financial futures only (TFF report): specLongPct/specNet/netChangeWeek are
  // the ASSET MANAGERS (pensions, funds: the real money); hedge funds below.
  hfLongPct?: number;
  hfNetChangeWeek?: number;
};

// IG market -> CFTC contract code. Brent uses WTI (Brent trades on ICE, which
// the CFTC report doesn't cover). FX futures are quoted against the dollar,
// so for USD/JPY a yen long is a bet on USD/JPY falling.
// Financial futures (indices, FX) use the Traders in Financial Futures report
// (2026-10-29): the legacy 'non-commercial' figure there mixes in hedging and
// arbitrage (S&P 500 read 38% long when asset managers were 84% long).
const TFF = new Set(['13874A', '209742', '124603', '096742', '099741', '097741', '232741']);

const CODES: Record<string, { code: string; note?: string }> = {
  NATGAS:    { code: '023651' },
  BRENT:     { code: '067651', note: 'WTI crude used as the proxy for Brent' },
  US500:     { code: '13874A' },
  USTECH100: { code: '209742' },
  WALLST:    { code: '124603' },
  GBPUSD:    { code: '096742' },
  EURUSD:    { code: '099741' },
  USDJPY:    { code: '097741', note: 'yen futures: being long yen = betting USD/JPY falls' },
  AUDUSD:    { code: '232741' },
  SILVER:    { code: '084691' },
};

let cache: { at: number; rows: CotRow[] } | null = null;

async function latestByCode(dataset: string, codes: string[], fields: string): Promise<Map<string, Record<string, string>>> {
  const params = new URLSearchParams({
    $select: `market_and_exchange_names,cftc_contract_market_code,report_date_as_yyyy_mm_dd,${fields}`,
    $where: `cftc_contract_market_code in(${codes.map(c => `'${c}'`).join(',')})`,
    $order: 'report_date_as_yyyy_mm_dd DESC',
    $limit: String(codes.length * 3),
  });
  const r = await fetch(`https://publicreporting.cftc.gov/resource/${dataset}.json?${params}`, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`CFTC ${r.status}`);
  const latest = new Map<string, Record<string, string>>();
  for (const d of await r.json() as Array<Record<string, string>>) if (!latest.has(d.cftc_contract_market_code)) latest.set(d.cftc_contract_market_code, d);
  return latest;
}

export async function getCot(): Promise<CotRow[]> {
  if (cache && Date.now() - cache.at < 6 * 3_600_000) return cache.rows;
  const codes = [...new Set(Object.values(CODES).map(c => c.code))];
  const [legacy, tff] = await Promise.all([
    latestByCode('6dca-aqww', codes.filter(c => !TFF.has(c)), 'noncomm_positions_long_all,noncomm_positions_short_all,change_in_noncomm_long_all,change_in_noncomm_short_all'),
    latestByCode('gpe5-46if', codes.filter(c => TFF.has(c)), 'asset_mgr_positions_long,asset_mgr_positions_short,change_in_asset_mgr_long,change_in_asset_mgr_short,lev_money_positions_long,lev_money_positions_short,change_in_lev_money_long,change_in_lev_money_short'),
  ]);
  const pct = (l: number, s: number) => Math.round((l / (l + s)) * 100);
  const rows: CotRow[] = [];
  for (const [key, { code, note }] of Object.entries(CODES)) {
    if (TFF.has(code)) {
      const d = tff.get(code);
      if (!d) continue;
      const aL = Number(d.asset_mgr_positions_long), aS = Number(d.asset_mgr_positions_short);
      const hL = Number(d.lev_money_positions_long), hS = Number(d.lev_money_positions_short);
      rows.push({ key, market: d.market_and_exchange_names.split(' - ')[0], reportDate: d.report_date_as_yyyy_mm_dd.slice(0, 10), source: 'tff',
        specLongPct: pct(aL, aS), specNet: aL - aS, netChangeWeek: Number(d.change_in_asset_mgr_long) - Number(d.change_in_asset_mgr_short),
        hfLongPct: pct(hL, hS), hfNetChangeWeek: Number(d.change_in_lev_money_long) - Number(d.change_in_lev_money_short), note });
    } else {
      const d = legacy.get(code);
      if (!d) continue;
      const L = Number(d.noncomm_positions_long_all), S = Number(d.noncomm_positions_short_all);
      rows.push({ key, market: d.market_and_exchange_names.split(' - ')[0], reportDate: d.report_date_as_yyyy_mm_dd.slice(0, 10), source: 'legacy',
        specLongPct: pct(L, S), specNet: L - S, netChangeWeek: Number(d.change_in_noncomm_long_all) - Number(d.change_in_noncomm_short_all), note });
    }
  }
  cache = { at: Date.now(), rows };
  return rows;
}

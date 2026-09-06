// ── DexScreener — Solana pair discovery ─────────────────────────────────────
// Public API, no key required (confirmed live 2026-09-05). Used purely for
// DISCOVERY (what's actively trading right now) and as a secondary liquidity
// sanity check where the field is present — the actual tradability/liquidity
// depth decision always comes from a live Jupiter quote (jupiterApi.ts), not
// from anything reported here. Confirmed live that a pre-migration pump.fun
// bonding-curve pair reports NO `liquidity` field at all (it's not a
// standard AMM pool yet), so this field is treated as optional/advisory
// throughout, never required.

const BASE = 'https://api.dexscreener.com';

export type DexPair = {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  priceChange?: { h1?: number; h6?: number; h24?: number };
  volume?: { h24?: number; h6?: number; h1?: number; m5?: number };
  txns?: { h1?: { buys: number; sells: number }; h24?: { buys: number; sells: number } };
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
};

async function dsFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  }
}

export async function getPair(chainId: string, pairAddress: string): Promise<DexPair | null> {
  const data = await dsFetch<{ pairs?: DexPair[]; pair?: DexPair }>(`/latest/dex/pairs/${chainId}/${pairAddress}`);
  return data?.pair ?? data?.pairs?.[0] ?? null;
}

// Boosted listings — paid promotion, not a pure organic ranking, so this is
// used only as a candidate SEED list (things worth then checking with our
// own volume/age filters below), never trusted on its own as "this is
// trending." Filtered to Solana here; DexScreener returns all chains mixed.
export async function getBoostedSolanaTokens(): Promise<Array<{ tokenAddress: string; chainId: string }>> {
  const data = await dsFetch<Array<{ tokenAddress: string; chainId: string }>>('/token-boosts/top/v1');
  if (!Array.isArray(data)) return [];
  return data.filter(t => t.chainId === 'solana');
}

// All pairs for a token address — a boosted/newly-seen token can have
// several pairs (different DEXs, or SOL vs USDC quote); the caller picks the
// most liquid/highest-volume one. Confirmed live 2026-09-05: `/tokens/v1/...`
// is the working endpoint and returns a bare array, NOT `{pairs: [...]}` —
// `/latest/dex/tokens/{chainId}/{address}` (the shape used elsewhere in this
// file for a single pair lookup) 404s for this multi-pair-by-token query.
export async function getTokenPairs(chainId: string, tokenAddress: string): Promise<DexPair[]> {
  const data = await dsFetch<DexPair[]>(`/tokens/v1/${chainId}/${tokenAddress}`);
  return Array.isArray(data) ? data : [];
}

// Organic momentum filter — separate from the paid-boost seed list above.
// "Real" hype shows up here regardless of any boost: a genuine volume/txn
// spike on a young pair. AGE_MAX_HOURS keeps this scoped to actually-new
// tokens (per the user's own framing: coins trading on fresh social hype,
// not an established name having an ordinary active day).
const AGE_MAX_HOURS = 72;
const MIN_H1_VOLUME_USD = 2_000;
const MIN_H1_TXNS = 20;
// Added 2026-09-06 alongside isAlreadyExtended below, same root-cause fix:
// confirmed live that this filter was passing tokens actively DECLINING
// (e.g. -44% in the last hour) purely because volume/txn count was high —
// a token crashing on panic-sell volume looks identical to one pumping on
// buy volume from these two numbers alone. This bot only ever buys (no
// shorting), so "momentum" has to mean price is actually going up, not
// just that a lot of trading is happening.
const MIN_H1_PRICE_CHANGE_PCT = 3;
export function passesOrganicMomentumFilter(pair: DexPair): boolean {
  const ageHours = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3_600_000 : Infinity;
  const h1Vol = pair.volume?.h1 ?? 0;
  const h1Txns = (pair.txns?.h1?.buys ?? 0) + (pair.txns?.h1?.sells ?? 0);
  const h1Change = pair.priceChange?.h1 ?? 0;
  return ageHours <= AGE_MAX_HOURS && h1Vol >= MIN_H1_VOLUME_USD && h1Txns >= MIN_H1_TXNS && h1Change >= MIN_H1_PRICE_CHANGE_PCT;
}

// "Already extended" veto — added 2026-09-06 after the first real $20k-scale
// run: 5/5 positions crashed 35-91% within ~3h of entry, all sourced from
// the boosted (paid-promotion) seed list, all showing near-zero peak% (i.e.
// they never ran up after entry, just declined). Confirmed independently
// via a live DexScreener check that the loss was real, not a bug. Boosted
// listings are a known vector for exactly this: paying to attract buyers
// right before insiders sell into that demand — the volume/txn filter above
// can't tell "the start of a move" from "the middle of a dump" since both
// look identical on activity level alone. This checks the one thing that
// actually distinguishes them: has the price already run hard recently. A
// token already up a large amount in the last hour or six is far more
// likely near/past its local top than at the start of one — directly the
// "avoid the tail end, don't become exit liquidity" principle. Not a
// guarantee (a token can still crash after clearing this), just removes the
// most obvious version of buying the top.
const EXTENDED_H1_PCT = 40;
const EXTENDED_H6_PCT = 150;
export function isAlreadyExtended(pair: DexPair): boolean {
  const h1 = pair.priceChange?.h1 ?? 0;
  const h6 = pair.priceChange?.h6 ?? 0;
  return h1 > EXTENDED_H1_PCT || h6 > EXTENDED_H6_PCT;
}

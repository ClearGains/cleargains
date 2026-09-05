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
export function passesOrganicMomentumFilter(pair: DexPair): boolean {
  const ageHours = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3_600_000 : Infinity;
  const h1Vol = pair.volume?.h1 ?? 0;
  const h1Txns = (pair.txns?.h1?.buys ?? 0) + (pair.txns?.h1?.sells ?? 0);
  return ageHours <= AGE_MAX_HOURS && h1Vol >= MIN_H1_VOLUME_USD && h1Txns >= MIN_H1_TXNS;
}

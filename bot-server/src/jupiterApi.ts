// ── Jupiter — the ONLY source of truth for what a trade would actually get ──
// Public quote API, no key required (confirmed live 2026-09-05, including
// against a pre-migration pump.fun bonding-curve token — Jupiter routes
// those directly, label "Pump.fun"). Deliberately the single place every
// simulated fill in memeCoinBot.ts goes through, for both entry and exit —
// per explicit design requirement, a paper trade must never be priced off a
// reference/last-trade price (DexScreener's `priceUsd`, say); it has to be
// what a real swap of that exact size would actually return right now,
// including real price impact against the real pool. A null return here
// means "no route exists" — the same outcome a real swap attempt would hit
// against a dead/illiquid pool — and callers must treat that as a failed
// trade, never fall back to estimating a price some other way.

const QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export type JupiterQuote = {
  inAmount: string;        // raw base units of inputMint
  outAmount: string;       // raw base units of outputMint
  otherAmountThreshold: string; // worst-case out amount at the given slippage tolerance
  priceImpactPct: number;
  usdValue: number | null; // swapUsdValue, when Jupiter reports one
};

// slippageBps: 100 = 1%. Kept as a parameter (not a fixed default) so entry
// and exit can reason about it explicitly — a quote that only clears at a
// much wider tolerance than the strategy is willing to accept live is,
// functionally, the same as no route at all.
export async function getQuote(
  inputMint: string, outputMint: string, amountRaw: string, slippageBps: number,
): Promise<JupiterQuote | null> {
  try {
    const url = `${QUOTE_URL}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null; // includes the "no route found" case — Jupiter 400s on that
    const data = await res.json() as {
      inAmount?: string; outAmount?: string; otherAmountThreshold?: string;
      priceImpactPct?: string; swapUsdValue?: string;
    };
    if (!data.outAmount || !data.otherAmountThreshold) return null;
    return {
      inAmount: data.inAmount ?? amountRaw,
      outAmount: data.outAmount,
      otherAmountThreshold: data.otherAmountThreshold,
      priceImpactPct: Number(data.priceImpactPct ?? '0'),
      usdValue: data.swapUsdValue ? Number(data.swapUsdValue) : null,
    };
  } catch {
    return null;
  }
}

// Convenience — SOL is the paper account's own "cash" and every buy/sell
// routes through it (SOL -> token to enter, token -> SOL to exit), same
// as a real wallet would. 9 decimals for SOL, lamports as the raw unit.
export function solToLamports(sol: number): string {
  return Math.round(sol * 1e9).toString();
}
export function lamportsToSol(lamports: string): number {
  return Number(lamports) / 1e9;
}

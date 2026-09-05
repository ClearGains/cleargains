// ── Rug-pull safety veto — RugCheck + GoPlus, combined ──────────────────────
// Both public APIs, no key required (confirmed live 2026-09-05). This is a
// HARD VETO, not a score fed into a weighted decision — per explicit design
// requirement, a real rug is categorically different from ordinary
// volatility, so a real red flag here blocks the trade outright rather than
// just docking confidence. Two independent sources on purpose (same
// "don't trust one source alone" discipline as fetchAllHeadlines merging
// Finnhub+Finviz elsewhere in this account) — RugCheck's own composite risk
// score plus GoPlus's separate mint/freeze/transfer-authority read catch
// different things. Fails CLOSED: if neither source can be reached, treat
// the token as unsafe rather than trading on zero information.

const RUGCHECK_URL = 'https://api.rugcheck.xyz/v1/tokens';
const GOPLUS_URL   = 'https://api.gopluslabs.io/api/v1/solana/token_security';

type RugCheckReport = {
  rugged?: boolean;
  score_normalised?: number;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  risks?: Array<{ name: string; level: string; description?: string }>;
  totalMarketLiquidity?: number;
};

type GoPlusResult = {
  mintable?: { status: string };
  freezable?: { status: string };
  closable?: { status: string };
  transfer_hook?: unknown[];
  non_transferable?: string;
};

// Above this, RugCheck's own composite risk score is treated as too risky
// regardless of individual flags — tuned conservatively (low) since this
// account would rather skip a real opportunity than hold a rug; can be
// loosened later against real paper-trade evidence, same way every other
// strategy threshold in this codebase has been tuned against live results.
const RUGCHECK_MAX_SCORE = 50;

export type SafetyResult = { safe: boolean; reasons: string[] };

async function fetchRugCheck(mint: string): Promise<RugCheckReport | null> {
  try {
    const res = await fetch(`${RUGCHECK_URL}/${mint}/report`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return await res.json() as RugCheckReport;
  } catch {
    return null;
  }
}

async function fetchGoPlus(mint: string): Promise<GoPlusResult | null> {
  try {
    const res = await fetch(`${GOPLUS_URL}?contract_addresses=${mint}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = await res.json() as { code?: number; result?: Record<string, GoPlusResult> };
    if (data.code !== 1) return null;
    return data.result?.[mint] ?? null;
  } catch {
    return null;
  }
}

export async function checkTokenSafety(mint: string): Promise<SafetyResult> {
  const [rc, gp] = await Promise.all([fetchRugCheck(mint), fetchGoPlus(mint)]);
  const reasons: string[] = [];

  if (!rc && !gp) {
    return { safe: false, reasons: ['Both RugCheck and GoPlus unreachable — cannot verify, skipping'] };
  }

  if (rc) {
    if (rc.rugged) reasons.push('RugCheck: already flagged as rugged');
    if (rc.mintAuthority) reasons.push('RugCheck: mint authority not renounced — supply can be inflated');
    if (rc.freezeAuthority) reasons.push('RugCheck: freeze authority present — holder wallets can be frozen');
    const dangerRisks = (rc.risks ?? []).filter(r => r.level === 'danger');
    for (const r of dangerRisks) reasons.push(`RugCheck: ${r.name}${r.description ? ` — ${r.description}` : ''}`);
    if ((rc.score_normalised ?? 0) > RUGCHECK_MAX_SCORE) {
      reasons.push(`RugCheck: composite risk score ${rc.score_normalised} exceeds ${RUGCHECK_MAX_SCORE}`);
    }
  }

  if (gp) {
    if (gp.mintable?.status === '1') reasons.push('GoPlus: token is mintable');
    if (gp.freezable?.status === '1') reasons.push('GoPlus: token is freezable');
    if (gp.closable?.status === '1') reasons.push('GoPlus: token account can be closed by an authority');
    if (gp.non_transferable === '1') reasons.push('GoPlus: token is non-transferable — could not be sold at all');
    if (Array.isArray(gp.transfer_hook) && gp.transfer_hook.length > 0) {
      reasons.push('GoPlus: transfer hook present — a hook can block or tax transfers arbitrarily');
    }
  }

  return { safe: reasons.length === 0, reasons };
}

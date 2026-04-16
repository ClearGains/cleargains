/**
 * Central IG configuration — epic mapping table, account IDs, stop distances.
 * Imported by both client components and server API routes.
 * Contains NO secrets — all values are safe to expose client-side.
 */

// ── Account IDs ───────────────────────────────────────────────────────────────
// NEXT_PUBLIC_ prefix is required for browser bundles (webpack inlines at build).
// Server routes also have access to the non-prefixed variants via process.env.
// .trim() guards against trailing newlines that can appear when env vars are set
// via `echo "..." | vercel env add` piping.

export type AccountType = 'SPREADBET' | 'CFD';

export const IG_ACCOUNT_CFD: string =
  (process.env.NEXT_PUBLIC_IG_ACCOUNT_CFD ?? process.env.IG_ACCOUNT_CFD ?? 'Z6AFSH').trim();

export const IG_ACCOUNT_SPREADBET: string =
  (process.env.NEXT_PUBLIC_IG_ACCOUNT_SPREADBET ?? process.env.IG_ACCOUNT_SPREADBET ?? 'Z6AFSI').trim();

/** Derive account type from account ID */
export function accountTypeOf(accountId: string): AccountType {
  if (accountId === IG_ACCOUNT_CFD) return 'CFD';
  return 'SPREADBET';
}

/** Activity-log label — e.g. "[CFD | Z6AFSH]" */
export function accountLabel(accountId: string): string {
  const type = accountTypeOf(accountId);
  return `${type} | ${accountId}`;
}

// ── Market Types ──────────────────────────────────────────────────────────────
export type MarketType = 'INDEX' | 'FOREX' | 'COMMODITY' | 'CRYPTO' | 'STOCK';

// ── Epic Mapping Table ────────────────────────────────────────────────────────
// Single source of truth for all IG epics.
// Every trade looks up the correct epic here — never hardcode epics inline.

export type EpicEntry = {
  name:       string;
  spreadbet:  string;   // DFB / TODAY rolling instruments for UK spread-bet accounts
  cfd:        string;   // CFD equivalent
  marketType: MarketType;
};

export const EPIC_TABLE: EpicEntry[] = [
  // ── Indices ──────────────────────────────────────────────────────────────────
  { name: 'FTSE 100',   spreadbet: 'IX.D.FTSE.DAILY.IP',   cfd: 'IX.D.FTSE.CFD.IP',   marketType: 'INDEX' },
  { name: 'S&P 500',    spreadbet: 'IX.D.SPTRD.DAILY.IP',  cfd: 'IX.D.SPTRD.CFD.IP',  marketType: 'INDEX' },
  { name: 'NASDAQ 100', spreadbet: 'IX.D.NASDAQ.DAILY.IP', cfd: 'IX.D.NASDAQ.CFD.IP', marketType: 'INDEX' },
  { name: 'Dow Jones',  spreadbet: 'IX.D.DOW.DAILY.IP',    cfd: 'IX.D.DOW.CFD.IP',    marketType: 'INDEX' },
  { name: 'Germany 40', spreadbet: 'IX.D.DAX.DAILY.IP',    cfd: 'IX.D.DAX.CFD.IP',    marketType: 'INDEX' },
  { name: 'Japan 225',  spreadbet: 'IX.D.NIKKEI.DAILY.IP', cfd: 'IX.D.NIKKEI.CFD.IP', marketType: 'INDEX' },
  // ── Forex ─────────────────────────────────────────────────────────────────────
  { name: 'GBP/USD',    spreadbet: 'CS.D.GBPUSD.TODAY.IP', cfd: 'CS.D.GBPUSD.CFD.IP', marketType: 'FOREX' },
  { name: 'EUR/USD',    spreadbet: 'CS.D.EURUSD.TODAY.IP', cfd: 'CS.D.EURUSD.CFD.IP', marketType: 'FOREX' },
  { name: 'USD/JPY',    spreadbet: 'CS.D.USDJPY.TODAY.IP', cfd: 'CS.D.USDJPY.CFD.IP', marketType: 'FOREX' },
  { name: 'USD/CHF',    spreadbet: 'CS.D.USDCHF.TODAY.IP', cfd: 'CS.D.USDCHF.CFD.IP', marketType: 'FOREX' },
  { name: 'AUD/USD',    spreadbet: 'CS.D.AUDUSD.TODAY.IP', cfd: 'CS.D.AUDUSD.CFD.IP', marketType: 'FOREX' },
  // ── Commodities ───────────────────────────────────────────────────────────────
  { name: 'Gold',       spreadbet: 'CS.D.GOLD.TODAY.IP',    cfd: 'CS.D.GOLD.CFD.IP',    marketType: 'COMMODITY' },
  { name: 'Silver',     spreadbet: 'CS.D.SILVER.TODAY.IP',  cfd: 'CS.D.SILVER.CFD.IP',  marketType: 'COMMODITY' },
  { name: 'Oil (WTI)',  spreadbet: 'CS.D.OILCRUD.TODAY.IP', cfd: 'CS.D.OILCRUD.CFD.IP', marketType: 'COMMODITY' },
  // ── Crypto ────────────────────────────────────────────────────────────────────
  { name: 'Bitcoin',    spreadbet: 'CS.D.BITCOIN.TODAY.IP', cfd: 'CS.D.BITCOIN.CFD.IP', marketType: 'CRYPTO' },
];

// Fast lookup maps (built once at module load)
const _bySB   = new Map<string, EpicEntry>(EPIC_TABLE.map(e => [e.spreadbet, e]));
const _byCFD  = new Map<string, EpicEntry>(EPIC_TABLE.map(e => [e.cfd,       e]));
const _byName = new Map<string, EpicEntry>(EPIC_TABLE.map(e => [e.name,      e]));

/** All known valid epics (spread-bet + CFD) in a single Set */
export const ALL_KNOWN_EPICS = new Set<string>([
  ...EPIC_TABLE.map(e => e.spreadbet),
  ...EPIC_TABLE.map(e => e.cfd),
]);

/** Look up an EpicEntry by any epic string (SB or CFD) */
export function lookupEpic(epic: string): EpicEntry | null {
  return _bySB.get(epic) ?? _byCFD.get(epic) ?? null;
}

/** Given a market name + account type, return the correct epic string */
export function epicForAccount(name: string, accountType: AccountType): string | null {
  const e = _byName.get(name);
  if (!e) return null;
  return accountType === 'CFD' ? e.cfd : e.spreadbet;
}

/** Convert a spread-bet epic to its CFD equivalent (null if not in table) */
export function toCfdEpic(sbEpic: string): string | null {
  return _bySB.get(sbEpic)?.cfd ?? null;
}

/** Convert a CFD epic to its spread-bet equivalent (null if not in table) */
export function toSpreadbetEpic(cfdEpic: string): string | null {
  return _byCFD.get(cfdEpic)?.spreadbet ?? null;
}

/**
 * Returns true if the epic is a CFD instrument.
 * Covers table entries AND IG's UA.D.* stock CFD format.
 */
export function isCfdEpic(epic: string): boolean {
  return _byCFD.has(epic) || epic.startsWith('UA.D.') || epic.includes('.CFD.IP');
}

// ── Stop / Limit distances by account type + market type ─────────────────────

export function getStopDistances(
  marketType: MarketType,
  accountType: AccountType,
): { stopDist: number; limitDist: number } {
  if (accountType === 'CFD') {
    switch (marketType) {
      case 'INDEX':     return { stopDist: 20,  limitDist: 40  };
      case 'FOREX':     return { stopDist: 10,  limitDist: 20  };
      case 'COMMODITY': return { stopDist: 15,  limitDist: 30  };
      case 'CRYPTO':
      case 'STOCK':     return { stopDist: 50,  limitDist: 100 };
    }
  }
  // SPREADBET
  switch (marketType) {
    case 'INDEX':     return { stopDist: 20, limitDist: 40  };
    case 'FOREX':     return { stopDist: 20, limitDist: 40  };
    case 'COMMODITY': return { stopDist: 2,  limitDist: 4   };
    case 'CRYPTO':
    case 'STOCK':     return { stopDist: 50, limitDist: 100 };
  }
}

// ── Minimum signal strength thresholds ────────────────────────────────────────
// CFD: 75% (higher bar — taxable, margin-based)
// SPREADBET: 65% (lower bar acceptable — tax-free)

export const MIN_STRENGTH: Record<AccountType, number> = {
  CFD:       75,
  SPREADBET: 65,
};

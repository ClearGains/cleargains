// Stock universe for the T212 momentum+news strategy — a direct copy of
// lib/stockUniverse.ts (the same list the old /demo-trader page's client-side
// scanner used, the one the user identified as the actual source of the
// MSFT/PLTR/etc. positions on the T212 demo account and asked to have ported
// into the real bot). Kept as a separate file rather than importing across
// the app/bot-server boundary — bot-server is deployed standalone (scp+pm2,
// no shared node_modules/lib with the Next.js app) — so this needs to be
// manually kept in sync with lib/stockUniverse.ts if that ever changes.

export type UniverseStock = { symbol: string; name: string; t212: string; sector: string; isUK: boolean };

/** ADR mapping: LSE ticker → US-listed ADR symbol (Finnhub quote symbol —
 * the same real instrument as the UNIVERSE entry's own `t212` ticker above,
 * just without T212's own "_US_EQ" suffix). Kept as the single source both
 * fetchMomentumQuote's isUK branch (Finnhub) and the UNIVERSE's `t212` field
 * (order execution) key off of — see fetchMomentumQuote's own comment for
 * why these two must always name the exact same instrument. Unilever and
 * Standard Chartered corrected 2026-08-31 to match what T212 actually lists
 * (UN / SCBFY) — the previous symbols (UL / SCBFF) are real ADRs too, just a
 * different listing of the same underlying than the one T212 trades. */
export const ADR_MAP: Record<string, string> = {
  'VOD.L': 'VOD', 'BARC.L': 'BCS', 'LLOY.L': 'LYG', 'BP.L': 'BP',
  'SHEL.L': 'SHEL', 'AZN.L': 'AZN', 'GSK.L': 'GSK', 'RIO.L': 'RIO',
  'HSBA.L': 'HSBC', 'DGE.L': 'DEO', 'ULVR.L': 'UN', 'RR.L': 'RYCEY',
  'NWG.L': 'NWG', 'STAN.L': 'SCBFY', 'IAG.L': 'ICAGY',
};

export const UNIVERSE: UniverseStock[] = [
  // Technology — US
  { symbol: 'AAPL',  name: 'Apple Inc.',           t212: 'AAPL_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'MSFT',  name: 'Microsoft Corp.',       t212: 'MSFT_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'NVDA',  name: 'Nvidia Corp.',          t212: 'NVDA_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'AMD',   name: 'Advanced Micro Devices',t212: 'AMD_US_EQ',   sector: 'Technology', isUK: false },
  // T212 still lists Meta under its legacy pre-rename ticker code — 'META_US_EQ'
  // doesn't exist and 404'd on every entry attempt (confirmed directly
  // against T212's own instrument list, 2026-08-31).
  { symbol: 'META',  name: 'Meta Platforms',        t212: 'FB_US_EQ',    sector: 'Technology', isUK: false },
  { symbol: 'GOOGL', name: 'Alphabet Inc.',         t212: 'GOOGL_US_EQ', sector: 'Technology', isUK: false },
  { symbol: 'TSLA',  name: 'Tesla Inc.',            t212: 'TSLA_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'INTC',  name: 'Intel Corp.',           t212: 'INTC_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'QCOM',  name: 'Qualcomm Inc.',         t212: 'QCOM_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'AVGO',  name: 'Broadcom Inc.',         t212: 'AVGO_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'MU',    name: 'Micron Technology',     t212: 'MU_US_EQ',    sector: 'Technology', isUK: false },
  { symbol: 'AMAT',  name: 'Applied Materials',     t212: 'AMAT_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'PLTR',  name: 'Palantir Technologies', t212: 'PLTR_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'SNOW',  name: 'Snowflake Inc.',        t212: 'SNOW_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'CRM',   name: 'Salesforce Inc.',       t212: 'CRM_US_EQ',   sector: 'Technology', isUK: false },
  { symbol: 'ORCL',  name: 'Oracle Corp.',          t212: 'ORCL_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'ADBE',  name: 'Adobe Inc.',            t212: 'ADBE_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'UBER',  name: 'Uber Technologies',     t212: 'UBER_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'COIN',  name: 'Coinbase Global',       t212: 'COIN_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'RBLX',  name: 'Roblox Corp.',          t212: 'RBLX_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'SHOP',  name: 'Shopify Inc.',          t212: 'SHOP_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'NFLX',  name: 'Netflix Inc.',          t212: 'NFLX_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'ASML',  name: 'ASML Holding',          t212: 'ASML_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'ON',    name: 'ON Semiconductor',      t212: 'ON_US_EQ',    sector: 'Technology', isUK: false },
  { symbol: 'TSM',   name: 'Taiwan Semiconductor',  t212: 'TSM_US_EQ',   sector: 'Technology', isUK: false },
  { symbol: 'MRVL',  name: 'Marvell Technology',    t212: 'MRVL_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'NOK',   name: 'Nokia Corp.',           t212: 'NOK_US_EQ',   sector: 'Technology', isUK: false },
  { symbol: 'WDC',   name: 'Western Digital',       t212: 'WDC_US_EQ',   sector: 'Technology', isUK: false },
  { symbol: 'SNDK',  name: 'SanDisk Corp.',         t212: 'SNDK1_US_EQ', sector: 'Technology', isUK: false },
  { symbol: 'DELL',  name: 'Dell Technologies',     t212: 'DELL_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'STX',   name: 'Seagate Technology',    t212: 'STX_US_EQ',   sector: 'Technology', isUK: false },
  // Healthcare — US
  { symbol: 'LLY',   name: 'Eli Lilly',            t212: 'LLY_US_EQ',   sector: 'Healthcare', isUK: false },
  { symbol: 'UNH',   name: 'UnitedHealth Group',   t212: 'UNH_US_EQ',   sector: 'Healthcare', isUK: false },
  { symbol: 'ABBV',  name: 'AbbVie Inc.',           t212: 'ABBV_US_EQ',  sector: 'Healthcare', isUK: false },
  { symbol: 'MRK',   name: 'Merck & Co.',          t212: 'MRK_US_EQ',   sector: 'Healthcare', isUK: false },
  { symbol: 'PFE',   name: 'Pfizer Inc.',           t212: 'PFE_US_EQ',   sector: 'Healthcare', isUK: false },
  { symbol: 'AMGN',  name: 'Amgen Inc.',            t212: 'AMGN_US_EQ',  sector: 'Healthcare', isUK: false },
  { symbol: 'GILD',  name: 'Gilead Sciences',       t212: 'GILD_US_EQ',  sector: 'Healthcare', isUK: false },
  { symbol: 'REGN',  name: 'Regeneron Pharma',     t212: 'REGN_US_EQ',  sector: 'Healthcare', isUK: false },
  { symbol: 'VRTX',  name: 'Vertex Pharmaceuticals',t212: 'VRTX_US_EQ', sector: 'Healthcare', isUK: false },
  { symbol: 'MRNA',  name: 'Moderna Inc.',          t212: 'MRNA_US_EQ',  sector: 'Healthcare', isUK: false },
  { symbol: 'BIIB',  name: 'Biogen Inc.',           t212: 'BIIB_US_EQ',  sector: 'Healthcare', isUK: false },
  { symbol: 'JNJ',   name: 'Johnson & Johnson',     t212: 'JNJ_US_EQ',   sector: 'Healthcare', isUK: false },
  // Energy — US
  { symbol: 'XOM',   name: 'ExxonMobil Corp.',     t212: 'XOM_US_EQ',   sector: 'Energy', isUK: false },
  { symbol: 'CVX',   name: 'Chevron Corp.',        t212: 'CVX_US_EQ',   sector: 'Energy', isUK: false },
  { symbol: 'COP',   name: 'ConocoPhillips',       t212: 'COP_US_EQ',   sector: 'Energy', isUK: false },
  { symbol: 'SLB',   name: 'SLB',                  t212: 'SLB_US_EQ',   sector: 'Energy', isUK: false },
  { symbol: 'OXY',   name: 'Occidental Petroleum', t212: 'OXY_US_EQ',   sector: 'Energy', isUK: false },
  { symbol: 'VLO',   name: 'Valero Energy',        t212: 'VLO_US_EQ',   sector: 'Energy', isUK: false },
  { symbol: 'EOG',   name: 'EOG Resources',        t212: 'EOG_US_EQ',   sector: 'Energy', isUK: false },
  { symbol: 'MPC',   name: 'Marathon Petroleum',   t212: 'MPC_US_EQ',   sector: 'Energy', isUK: false },
  // Finance — US
  { symbol: 'JPM',   name: 'JPMorgan Chase',       t212: 'JPM_US_EQ',   sector: 'Finance', isUK: false },
  { symbol: 'BAC',   name: 'Bank of America',      t212: 'BAC_US_EQ',   sector: 'Finance', isUK: false },
  { symbol: 'V',     name: 'Visa Inc.',            t212: 'V_US_EQ',     sector: 'Finance', isUK: false },
  { symbol: 'MA',    name: 'Mastercard',           t212: 'MA_US_EQ',    sector: 'Finance', isUK: false },
  { symbol: 'GS',    name: 'Goldman Sachs',        t212: 'GS_US_EQ',    sector: 'Finance', isUK: false },
  { symbol: 'MS',    name: 'Morgan Stanley',       t212: 'MS_US_EQ',    sector: 'Finance', isUK: false },
  { symbol: 'WFC',   name: 'Wells Fargo',          t212: 'WFC_US_EQ',   sector: 'Finance', isUK: false },
  { symbol: 'AXP',   name: 'American Express',     t212: 'AXP_US_EQ',   sector: 'Finance', isUK: false },
  { symbol: 'PYPL',  name: 'PayPal Holdings',      t212: 'PYPL_US_EQ',  sector: 'Finance', isUK: false },
  { symbol: 'HOOD',  name: 'Robinhood Markets',    t212: 'HOOD_US_EQ',  sector: 'Finance', isUK: false },
  // Consumer — US
  { symbol: 'WMT',   name: 'Walmart Inc.',         t212: 'WMT_US_EQ',   sector: 'Consumer', isUK: false },
  { symbol: 'COST',  name: 'Costco Wholesale',     t212: 'COST_US_EQ',  sector: 'Consumer', isUK: false },
  { symbol: 'MCD',   name: "McDonald's Corp.",     t212: 'MCD_US_EQ',   sector: 'Consumer', isUK: false },
  { symbol: 'NKE',   name: 'Nike Inc.',            t212: 'NKE_US_EQ',   sector: 'Consumer', isUK: false },
  { symbol: 'KO',    name: 'Coca-Cola Co.',        t212: 'KO_US_EQ',    sector: 'Consumer', isUK: false },
  { symbol: 'PEP',   name: 'PepsiCo Inc.',         t212: 'PEP_US_EQ',   sector: 'Consumer', isUK: false },
  { symbol: 'AMZN',  name: 'Amazon.com Inc.',      t212: 'AMZN_US_EQ',  sector: 'Consumer', isUK: false },
  { symbol: 'HD',    name: 'Home Depot Inc.',      t212: 'HD_US_EQ',    sector: 'Consumer', isUK: false },
  { symbol: 'TGT',   name: 'Target Corp.',         t212: 'TGT_US_EQ',   sector: 'Consumer', isUK: false },
  { symbol: 'SBUX',  name: 'Starbucks Corp.',      t212: 'SBUX_US_EQ',  sector: 'Consumer', isUK: false },
  // Industrials — US
  { symbol: 'BA',    name: 'Boeing Co.',            t212: 'BA_US_EQ',    sector: 'Industrials', isUK: false },
  { symbol: 'CAT',   name: 'Caterpillar Inc.',      t212: 'CAT_US_EQ',   sector: 'Industrials', isUK: false },
  { symbol: 'HON',   name: 'Honeywell International', t212: 'HON_US_EQ', sector: 'Industrials', isUK: false },
  // Communication/Media — US
  { symbol: 'DIS',   name: 'Walt Disney Co.',       t212: 'DIS_US_EQ',   sector: 'Communication', isUK: false },
  { symbol: 'T',     name: 'AT&T Inc.',             t212: 'T_US_EQ',     sector: 'Communication', isUK: false },
  // Utilities — US
  { symbol: 'NEE',   name: 'NextEra Energy',        t212: 'NEE_US_EQ',   sector: 'Utilities', isUK: false },
  // UK — LSE
  // T212 doesn't list any of these under the "_UK_EQ" codes this file
  // originally guessed — every one 404'd as "Ticker does not exist" (first
  // caught on META, then confirmed for all of these directly against T212's
  // own instrument list, 2026-08-31). Corrected to each stock's actual
  // US-dollar ADR ticker (T212 doesn't offer these at all on the native LSE
  // listing) — see fetchMomentumQuote's own comment for why the quote source
  // for isUK stocks had to change alongside this (an ADR isn't priced or
  // share-ratio'd 1:1 with the LSE listing, so it needs its own USD quote,
  // not the LSE one this used to fetch). IAG dropped entirely — no
  // US-dollar-listed ADR exists for it on T212 at all.
  { symbol: 'VOD.L',  name: 'Vodafone Group',       t212: 'VOD_US_EQ',   sector: 'Telecom',  isUK: true },
  { symbol: 'BARC.L', name: 'Barclays PLC',         t212: 'BCS_US_EQ',   sector: 'Finance',  isUK: true },
  { symbol: 'LLOY.L', name: 'Lloyds Banking Group', t212: 'LYG_US_EQ',   sector: 'Finance',  isUK: true },
  { symbol: 'BP.L',   name: 'BP PLC',               t212: 'BP_US_EQ',    sector: 'Energy',   isUK: true },
  { symbol: 'SHEL.L', name: 'Shell PLC',            t212: 'SHEL_US_EQ',  sector: 'Energy',   isUK: true },
  { symbol: 'AZN.L',  name: 'AstraZeneca PLC',      t212: 'AZN_US_EQ',   sector: 'Healthcare',isUK: true },
  { symbol: 'GSK.L',  name: 'GSK PLC',              t212: 'GSK_US_EQ',   sector: 'Healthcare',isUK: true },
  { symbol: 'RIO.L',  name: 'Rio Tinto PLC',        t212: 'RIO_US_EQ',   sector: 'Materials', isUK: true },
  { symbol: 'HSBA.L', name: 'HSBC Holdings',        t212: 'HSBC_US_EQ',  sector: 'Finance',  isUK: true },
  { symbol: 'DGE.L',  name: 'Diageo PLC',           t212: 'DEO_US_EQ',   sector: 'Consumer', isUK: true },
  { symbol: 'ULVR.L', name: 'Unilever PLC',         t212: 'UN_US_EQ',    sector: 'Consumer', isUK: true },
  { symbol: 'RR.L',   name: 'Rolls-Royce Holdings', t212: 'RYCEY_US_EQ',sector: 'Industrials',isUK: true },
  { symbol: 'NWG.L',  name: 'NatWest Group',        t212: 'NWG_US_EQ',   sector: 'Finance',  isUK: true },
  { symbol: 'STAN.L', name: 'Standard Chartered',   t212: 'SCBFY_US_EQ',sector: 'Finance',  isUK: true },
];

// Shared stock universe — used by the short-term demo-trader signal scanner
// and the longer-term T212 position review. Extracted from
// app/api/demo-trader/signals/route.ts so both share one list instead of
// maintaining duplicate copies that can drift apart.

export type UniverseStock = { symbol: string; name: string; t212: string; sector: string; isUK: boolean };

/** ADR mapping: LSE ticker → US-listed ADR symbol, for UK quote fallback. */
export const ADR_MAP: Record<string, string> = {
  'VOD.L': 'VOD', 'BARC.L': 'BCS', 'LLOY.L': 'LYG', 'BP.L': 'BP',
  'SHEL.L': 'SHEL', 'AZN.L': 'AZN', 'GSK.L': 'GSK', 'RIO.L': 'RIO',
  'HSBA.L': 'HSBC', 'DGE.L': 'DEO', 'ULVR.L': 'UL', 'RR.L': 'RYCEY',
  'NWG.L': 'NWG', 'STAN.L': 'SCBFF', 'IAG.L': 'ICAGY',
};

export const UNIVERSE: UniverseStock[] = [
  // Technology — US
  { symbol: 'AAPL',  name: 'Apple Inc.',           t212: 'AAPL_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'MSFT',  name: 'Microsoft Corp.',       t212: 'MSFT_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'NVDA',  name: 'Nvidia Corp.',          t212: 'NVDA_US_EQ',  sector: 'Technology', isUK: false },
  { symbol: 'AMD',   name: 'Advanced Micro Devices',t212: 'AMD_US_EQ',   sector: 'Technology', isUK: false },
  { symbol: 'META',  name: 'Meta Platforms',        t212: 'META_US_EQ',  sector: 'Technology', isUK: false },
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
  // UK — LSE
  { symbol: 'VOD.L',  name: 'Vodafone Group',       t212: 'VOD_UK_EQ',   sector: 'Telecom',  isUK: true },
  { symbol: 'BARC.L', name: 'Barclays PLC',         t212: 'BARC_UK_EQ',  sector: 'Finance',  isUK: true },
  { symbol: 'LLOY.L', name: 'Lloyds Banking Group', t212: 'LLOY_UK_EQ',  sector: 'Finance',  isUK: true },
  { symbol: 'BP.L',   name: 'BP PLC',               t212: 'BP_UK_EQ',    sector: 'Energy',   isUK: true },
  { symbol: 'SHEL.L', name: 'Shell PLC',            t212: 'SHEL_UK_EQ',  sector: 'Energy',   isUK: true },
  { symbol: 'AZN.L',  name: 'AstraZeneca PLC',      t212: 'AZN_UK_EQ',   sector: 'Healthcare',isUK: true },
  { symbol: 'GSK.L',  name: 'GSK PLC',              t212: 'GSK_UK_EQ',   sector: 'Healthcare',isUK: true },
  { symbol: 'RIO.L',  name: 'Rio Tinto PLC',        t212: 'RIO_UK_EQ',   sector: 'Materials', isUK: true },
  { symbol: 'HSBA.L', name: 'HSBC Holdings',        t212: 'HSBA_UK_EQ',  sector: 'Finance',  isUK: true },
  { symbol: 'DGE.L',  name: 'Diageo PLC',           t212: 'DGE_UK_EQ',   sector: 'Consumer', isUK: true },
  { symbol: 'ULVR.L', name: 'Unilever PLC',         t212: 'ULVR_UK_EQ',  sector: 'Consumer', isUK: true },
  { symbol: 'RR.L',   name: 'Rolls-Royce Holdings', t212: 'RR_UK_EQ',    sector: 'Industrials',isUK: true },
  { symbol: 'IAG.L',  name: 'IAG (BA/Iberia)',      t212: 'IAG_UK_EQ',   sector: 'Transport', isUK: true },
  { symbol: 'NWG.L',  name: 'NatWest Group',        t212: 'NWG_UK_EQ',   sector: 'Finance',  isUK: true },
  { symbol: 'STAN.L', name: 'Standard Chartered',   t212: 'STAN_UK_EQ',  sector: 'Finance',  isUK: true },
];

export type Country = {
  code: string;
  name: string;
  flag: string;
  currency: string;
  currencySymbol: string;
  taxYear: string;
  filingDeadline: string;
  filingDeadlineMonth: number;
  filingDeadlineDay: number;
  cgRates: { basic: number; higher: number; flat?: number };
  aea: number;
  aeaLabel: string;
  taxSystem: string;
  notes: string;
};

export type Trade = {
  id: string;
  ticker: string;
  isin?: string;
  type: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  currency: string;
  gbpValue: number;
  date: string;
  fees: number;
  isISA: boolean;
  source: 'manual' | 't212';
  pool?: Section104Pool;
};

export type Section104Pool = {
  ticker: string;
  totalShares: number;
  totalCost: number;
  averageCost: number;
};

export type CGTCalculation = {
  ticker: string;
  date: string;
  disposal: number;
  allowableCost: number;
  gain: number;
  loss: number;
  rule: 'section104' | 'same-day' | 'bed-and-breakfast';
  quantity: number;
};

export type SA108Data = {
  totalProceeds: number;
  totalAllowableCosts: number;
  totalGains: number;
  totalLosses: number;
  netGain: number;
  aea: number;
  taxableGain: number;
  basicRateTax: number;
  higherRateTax: number;
  totalTax: number;
  calculations: CGTCalculation[];
};

export type Signal = {
  ticker: string;
  signal: 'BUY' | 'SELL' | 'HOLD';
  riskScore: number;
  confidence: number;
  reasoning: string;
  sources: string[];
  timestamp: string;
};

export type NewsArticle = {
  headline: string;
  source: string;
  date: string;
  summary: string;
  link?: string;
};

export type ScanResult = {
  ticker: string;
  companyName: string;
  signal: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  riskScore: number;
  verdict: 'PROCEED' | 'CAUTION' | 'REJECT';
  reasoning: string;
  market: 'US' | 'UK' | 'OTHER';
  articles: NewsArticle[];
  timestamp: string;
  noRecentNews?: boolean;
};

export type FxPosition = {
  id: string;
  pair: string;
  direction: 'long' | 'short';
  units: number;
  entryRate: number;
  currentRate: number;
  stopLossPips: number;
  takeProfitPips: number;
  pnlPips: number;
  pnlGbp: number;
  openedAt: string;
  trailingActive?: boolean;
  autoManaged?: boolean;
};

export type FxTrade = {
  id: string;
  pair: string;
  direction: 'long' | 'short';
  units: number;
  entryRate: number;
  exitRate: number;
  pnlPips: number;
  pnlGbp: number;
  openedAt: string;
  closedAt: string;
  closeReason: 'stop-loss' | 'take-profit' | 'manual' | 'trailing-stop';
};

export type T212Account = {
  id: string;
  type: 'LIVE' | 'DEMO';
  currency: string;
  cash: number;
  portfolioValue: number;
  positions: T212Position[];
};

export type T212Position = {
  ticker: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  ppl: number;
  fxPpl: number;
  initialFillDate: string;
  isISA: boolean;
};

export type T212Order = {
  id: string;
  ticker: string;
  type: 'LIMIT' | 'MARKET' | 'STOP';
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  status: string;
  fillDate: string;
  taxes: number;
  currency: string;
};

export type DemoPosition = {
  id: string;
  ticker: string;       // Finnhub symbol e.g. "AAPL"
  t212Ticker: string;   // T212 instrument e.g. "AAPL_US_EQ"
  companyName: string;
  sector: string;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  stopLoss: number;     // entryPrice * 0.98
  takeProfit: number;   // entryPrice * 1.04
  pnl: number;
  pnlPct: number;
  openedAt: string;
  signal: string;
};

export type DemoTrade = {
  id: string;
  ticker: string;
  t212Ticker: string;
  companyName: string;
  sector: string;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  pnlPct: number;
  openedAt: string;
  closedAt: string;
  closeReason: 'stop-loss' | 'take-profit' | 'manual';
};

export type RiskCheck = {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail' | 'pending';
  assessment: string;
};

export type Deadline = {
  country: string;
  countryCode: string;
  type: string;
  date: string;
  description: string;
  reminderSet: boolean;
};

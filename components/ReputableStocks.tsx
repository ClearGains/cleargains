'use client';

import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Shield, Zap, TrendingUp, ArrowDown, ArrowUp, AlertCircle } from 'lucide-react';
import { clsx } from 'clsx';
import { NewsStrip } from '@/components/ui/NewsStrip';

// ── Universe ──────────────────────────────────────────────────────────────────

type Volatility = 'LOW' | 'MEDIUM' | 'HIGH';
type Market     = 'US_TECH' | 'US_SEMI' | 'US_FINANCE' | 'US_DEFENSIVE' | 'US_ENERGY' | 'US_PHARMA' | 'US_INFRA' | 'UK' | 'ETF';

type StockDef = {
  symbol:     string;
  name:       string;
  market:     Market;
  volatility: Volatility;
  sector:     string;
  why:        string;   // one-line thesis
};

const UNIVERSE: StockDef[] = [
  // US Tech — established giants
  { symbol: 'AAPL',  name: 'Apple',           market: 'US_TECH',       volatility: 'MEDIUM', sector: 'Technology',  why: "World's most valuable company, ecosystem lock-in, consistent buybacks" },
  { symbol: 'MSFT',  name: 'Microsoft',        market: 'US_TECH',       volatility: 'MEDIUM', sector: 'Technology',  why: 'Azure cloud + Office 365 — two dominant recurring revenue engines' },
  { symbol: 'GOOGL', name: 'Alphabet',         market: 'US_TECH',       volatility: 'MEDIUM', sector: 'Technology',  why: 'Search monopoly + YouTube + Google Cloud — cash-generative at scale' },
  { symbol: 'AMZN',  name: 'Amazon',           market: 'US_TECH',       volatility: 'MEDIUM', sector: 'Technology',  why: 'AWS provides 60%+ of operating profit; e-commerce moat worldwide' },
  { symbol: 'META',  name: 'Meta Platforms',   market: 'US_TECH',       volatility: 'MEDIUM', sector: 'Technology',  why: '3.3B daily active users across Facebook/Instagram/WhatsApp' },
  { symbol: 'NVDA',  name: 'NVIDIA',           market: 'US_SEMI',       volatility: 'HIGH',   sector: 'AI / GPU',    why: 'Dominant AI/GPU chip maker; H100/H200 data-centre demand surging multi-year' },
  { symbol: 'TSLA',  name: 'Tesla',            market: 'US_TECH',       volatility: 'HIGH',   sector: 'Automotive',  why: 'EV and energy storage market leader; expanding into FSD and robotics' },
  // AI, Semiconductors & Storage
  { symbol: 'AMD',   name: 'Advanced Micro Devices', market: 'US_SEMI', volatility: 'HIGH',   sector: 'AI / GPU',    why: 'MI300 AI GPU challenging NVIDIA; dominant PC and server CPU share gains' },
  { symbol: 'MU',    name: 'Micron Technology', market: 'US_SEMI',      volatility: 'HIGH',   sector: 'Memory / AI', why: 'HBM3e memory essential for AI inference; cycle recovery + pricing power' },
  { symbol: 'STX',   name: 'Seagate Technology',market: 'US_SEMI',      volatility: 'MEDIUM', sector: 'Storage',     why: 'Hard-drive market leader; mass-capacity storage demand driven by AI data lakes' },
  { symbol: 'WDC',   name: 'Western Digital',   market: 'US_SEMI',      volatility: 'HIGH',   sector: 'Storage',     why: 'HDD + NAND flash; AI cloud build-out is a multi-year tailwind for capacity demand' },
  { symbol: 'AVGO',  name: 'Broadcom',          market: 'US_SEMI',      volatility: 'MEDIUM', sector: 'AI Networking',why: 'Custom AI chips (XPUs) for Google/Meta + dominant networking silicon' },
  { symbol: 'QCOM',  name: 'Qualcomm',          market: 'US_SEMI',      volatility: 'MEDIUM', sector: 'Mobile / Edge AI', why: 'Snapdragon on-device AI leader; licensing moat + auto/IoT diversification' },
  { symbol: 'INTC',  name: 'Intel',             market: 'US_SEMI',      volatility: 'MEDIUM', sector: 'Semiconductors', why: 'Deep discount to peers; foundry strategy + Panther Lake recovery catalyst' },
  { symbol: 'ASML',  name: 'ASML Holding',      market: 'US_SEMI',      volatility: 'MEDIUM', sector: 'Chip Equipment', why: 'Monopoly on EUV lithography — every advanced chip on earth needs ASML machines' },
  { symbol: 'AMAT',  name: 'Applied Materials', market: 'US_SEMI',      volatility: 'MEDIUM', sector: 'Chip Equipment', why: 'Largest semiconductor equipment maker; benefits from every new fab built globally' },
  { symbol: 'PLTR',  name: 'Palantir',          market: 'US_SEMI',      volatility: 'HIGH',   sector: 'AI Software',  why: 'AIP AI platform winning enterprise and US government contracts at scale' },
  // US Finance
  { symbol: 'JPM',   name: 'JPMorgan Chase',   market: 'US_FINANCE',    volatility: 'MEDIUM', sector: 'Finance',     why: "World's largest bank by assets; best-in-class capital allocation" },
  { symbol: 'GS',    name: 'Goldman Sachs',    market: 'US_FINANCE',    volatility: 'MEDIUM', sector: 'Finance',     why: 'Premier investment bank; benefits from high-rate trading and M&A' },
  { symbol: 'BRK-B', name: 'Berkshire Hathaway',market:'US_FINANCE',   volatility: 'LOW',    sector: 'Finance',     why: 'Buffett-managed conglomerate; $168B cash reserve, defensive hold' },
  // US Defensive / Dividend
  { symbol: 'JNJ',   name: 'Johnson & Johnson',market: 'US_DEFENSIVE',  volatility: 'LOW',    sector: 'Healthcare',  why: 'Dividend Aristocrat 60+ years; pharma + med-device diversification' },
  { symbol: 'PG',    name: 'Procter & Gamble', market: 'US_DEFENSIVE',  volatility: 'LOW',    sector: 'Consumer',    why: 'Essential consumer brands; pricing power through economic cycles' },
  { symbol: 'KO',    name: 'Coca-Cola',        market: 'US_DEFENSIVE',  volatility: 'LOW',    sector: 'Consumer',    why: 'Global beverage dominant; 60-year dividend streak; Buffett core holding' },
  { symbol: 'WMT',   name: 'Walmart',          market: 'US_DEFENSIVE',  volatility: 'LOW',    sector: 'Retail',      why: 'Recession-proof retailer; growing e-commerce and advertising revenue' },
  { symbol: 'UNH',   name: 'UnitedHealth',     market: 'US_DEFENSIVE',  volatility: 'LOW',    sector: 'Healthcare',  why: 'Largest US health insurer; compounding earnings at scale' },
  { symbol: 'HD',    name: 'Home Depot',       market: 'US_DEFENSIVE',  volatility: 'LOW',    sector: 'Retail',      why: 'Home improvement market leader; long renovation super-cycle tailwind' },
  // Pharmaceuticals
  { symbol: 'LLY',   name: 'Eli Lilly',         market: 'US_PHARMA',     volatility: 'HIGH',   sector: 'GLP-1 / Pharma',   why: 'Mounjaro + Zepbound GLP-1 drugs — multi-billion market with years of runway' },
  { symbol: 'NVO',   name: 'Novo Nordisk',       market: 'US_PHARMA',     volatility: 'MEDIUM', sector: 'GLP-1 / Pharma',   why: 'Ozempic + Wegovy first-mover advantage in weight-loss; global supply scaling' },
  { symbol: 'ABBV',  name: 'AbbVie',             market: 'US_PHARMA',     volatility: 'LOW',    sector: 'Immunology',       why: 'Skyrizi + Rinvoq replacing Humira revenue; strong dividend + buybacks' },
  { symbol: 'MRK',   name: 'Merck',              market: 'US_PHARMA',     volatility: 'LOW',    sector: 'Oncology',         why: 'Keytruda is the world\'s best-selling cancer drug; robust pipeline behind it' },
  { symbol: 'PFE',   name: 'Pfizer',             market: 'US_PHARMA',     volatility: 'LOW',    sector: 'Pharma',           why: 'Trading at a deep discount post-COVID; Paxlovid + oncology acquisitions undervalued' },
  { symbol: 'REGN',  name: 'Regeneron',          market: 'US_PHARMA',     volatility: 'MEDIUM', sector: 'Biotech',          why: 'Dupixent blockbuster + PCSK9 + Eylea; strong R&D engine with capital returns' },
  { symbol: 'BMY',   name: 'Bristol-Myers Squibb',market:'US_PHARMA',     volatility: 'LOW',    sector: 'Oncology',         why: 'Diversified oncology portfolio (Opdivo, Revlimid successor); attractive valuation' },
  // Infrastructure
  { symbol: 'NEE',   name: 'NextEra Energy',     market: 'US_INFRA',      volatility: 'LOW',    sector: 'Renewable Energy', why: "World's largest renewable energy company; AI data-centre power demand tailwind" },
  { symbol: 'AMT',   name: 'American Tower',     market: 'US_INFRA',      volatility: 'LOW',    sector: 'Cell Towers',      why: '200,000+ tower assets globally; 5G densification + AI connectivity demand' },
  { symbol: 'EQIX',  name: 'Equinix',            market: 'US_INFRA',      volatility: 'MEDIUM', sector: 'Data Centres',     why: 'Global data centre REIT; AI model training and inference demand is structural' },
  { symbol: 'AWK',   name: 'American Water Works',market:'US_INFRA',      volatility: 'LOW',    sector: 'Water Utility',    why: 'Largest US water utility monopoly; essential service with regulated pricing power' },
  { symbol: 'UNP',   name: 'Union Pacific',      market: 'US_INFRA',      volatility: 'LOW',    sector: 'Freight Rail',     why: 'US western rail duopoly; re-shoring trade flows driving sustained cargo demand' },
  { symbol: 'WM',    name: 'Waste Management',   market: 'US_INFRA',      volatility: 'LOW',    sector: 'Waste & Recycling',why: 'Largest US waste company; pricing power + landfill gas-to-energy optionality' },
  // US Energy
  { symbol: 'XOM',   name: 'ExxonMobil',       market: 'US_ENERGY',     volatility: 'MEDIUM', sector: 'Energy',      why: 'Largest US oil major; capital discipline + $35B buyback program' },
  { symbol: 'CVX',   name: 'Chevron',          market: 'US_ENERGY',     volatility: 'MEDIUM', sector: 'Energy',      why: 'Strong free cash flow; balance sheet fortress; top-quartile dividend' },
  // UK Blue Chips
  { symbol: 'AZN.L', name: 'AstraZeneca',      market: 'UK',            volatility: 'MEDIUM', sector: 'Pharma',      why: 'World-class oncology pipeline; consistent 10%+ revenue growth' },
  { symbol: 'SHEL.L',name: 'Shell',            market: 'UK',            volatility: 'MEDIUM', sector: 'Energy',      why: "Europe's largest oil major; LNG leader + $23B annual buybacks" },
  { symbol: 'BP.L',  name: 'BP',               market: 'UK',            volatility: 'MEDIUM', sector: 'Energy',      why: 'Recovering free cash flow; discount to peers offers upside' },
  { symbol: 'HSBA.L',name: 'HSBC',             market: 'UK',            volatility: 'LOW',    sector: 'Finance',     why: 'Global banking franchise; Asia exposure with 6%+ dividend yield' },
  { symbol: 'DGE.L', name: 'Diageo',           market: 'UK',            volatility: 'LOW',    sector: 'Consumer',    why: 'Premium spirits portfolio (Johnnie Walker, Guinness); pricing power' },
  { symbol: 'LLOY.L',name: 'Lloyds Banking',   market: 'UK',            volatility: 'MEDIUM', sector: 'Finance',     why: 'UK retail banking dominant; trading at significant discount to book' },
  // ETFs
  { symbol: 'SPY',   name: 'S&P 500 ETF',      market: 'ETF',           volatility: 'LOW',    sector: 'Broad Market',why: 'Broadest US equity exposure; annualised ~10% return over 30 years' },
  { symbol: 'QQQ',   name: 'NASDAQ-100 ETF',   market: 'ETF',           volatility: 'MEDIUM', sector: 'Tech Index',  why: 'Top 100 Nasdaq companies; concentrated tech upside with diversification' },
  { symbol: 'GLD',   name: 'Gold ETF',         market: 'ETF',           volatility: 'LOW',    sector: 'Commodity',   why: 'Safe-haven hedge; historically rises during equity drawdowns' },
];

// ── Timeframe config ──────────────────────────────────────────────────────────

type TF = 'hours' | 'day' | 'week' | 'month' | 'longterm';

const TF_OPTIONS: { value: TF; label: string; desc: string }[] = [
  { value: 'hours',    label: 'Hours',     desc: 'Intraday — tight stops, same-session exit' },
  { value: 'day',      label: 'Day',       desc: 'Daily trade — sized for today\'s range' },
  { value: 'week',     label: 'Week',      desc: 'Swing — multi-day holding, 1–2 weeks' },
  { value: 'month',    label: 'Month',     desc: 'Position trade — held 2–6 weeks' },
  { value: 'longterm', label: 'Long-term', desc: 'Investment — 3+ months' },
];

// Stop loss as % below entry (TP = stop×2 for 2:1 R:R)
const STOP_PCT: Record<TF, Record<Volatility, number>> = {
  hours:    { LOW: 0.4,  MEDIUM: 0.8,  HIGH: 1.5  },
  day:      { LOW: 1.0,  MEDIUM: 2.0,  HIGH: 3.5  },
  week:     { LOW: 2.5,  MEDIUM: 4.5,  HIGH: 7.0  },
  month:    { LOW: 6.0,  MEDIUM: 10.0, HIGH: 15.0 },
  longterm: { LOW: 15.0, MEDIUM: 22.0, HIGH: 30.0 },
};

// ── Types ─────────────────────────────────────────────────────────────────────

type QuoteData = {
  symbol:        string;
  price:         number;
  changePercent: number;
  currency:      string;
  sma50?:        number;
  sma200?:       number;
  week52High?:   number;
  week52Low?:    number;
};

type StockRow = StockDef & QuoteData & {
  entry:      number;
  stopLoss:   number;
  takeProfit: number;
  stopDist:   number;
  tpDist:     number;
  stopPct:    number;
  signal:     'MOMENTUM' | 'DIP_BUY' | 'STEADY';
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const MARKET_LABELS: Record<Market, string> = {
  US_TECH:      'US Tech',
  US_SEMI:      'AI & Semis',
  US_FINANCE:   'US Finance',
  US_DEFENSIVE: 'US Defensive',
  US_ENERGY:    'US Energy',
  US_PHARMA:    'Pharmaceuticals',
  US_INFRA:     'Infrastructure',
  UK:           'UK Blue Chip',
  ETF:          'ETF',
};

function fmtPrice(price: number, currency: string): string {
  if (currency === 'GBp') return `${price.toFixed(1)}p`;
  if (currency === 'GBP') return `£${price.toFixed(2)}`;
  return `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: price < 10 ? 4 : 2 })}`;
}

function round2(n: number) { return Math.round(n * 100) / 100; }

function computeRow(def: StockDef, q: QuoteData, tf: TF): StockRow {
  const stopPct  = STOP_PCT[tf][def.volatility];
  const price    = q.price;
  const stopDist = round2(price * stopPct / 100);
  const tpDist   = round2(stopDist * 2);
  const stopLoss = round2(price - stopDist);
  const takeProfit = round2(price + tpDist);
  const signal: StockRow['signal'] =
    q.changePercent > 1   ? 'MOMENTUM' :
    q.changePercent < -1.5 ? 'DIP_BUY'  : 'STEADY';
  return { ...def, ...q, entry: round2(price), stopLoss, takeProfit, stopDist, tpDist, stopPct, signal };
}

// ── Volatility badge ──────────────────────────────────────────────────────────

function VolBadge({ v }: { v: Volatility }) {
  return v === 'LOW'    ? <span className="inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded border bg-emerald-500/10 text-emerald-400 border-emerald-500/30"><Shield className="h-2.5 w-2.5" />Low Volatility</span>
       : v === 'MEDIUM' ? <span className="inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded border bg-amber-500/10  text-amber-400  border-amber-500/30"><Shield className="h-2.5 w-2.5" />Med Volatility</span>
       :                  <span className="inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded border bg-red-500/10    text-red-400    border-red-500/30"><Zap    className="h-2.5 w-2.5" />High Volatility</span>;
}

function SignalBadge({ s }: { s: StockRow['signal'] }) {
  return s === 'MOMENTUM' ? <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/25">↑ Momentum</span>
       : s === 'DIP_BUY'  ? <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-400 border border-purple-500/25">↓ Dip Buy</span>
       :                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-gray-700/50 text-gray-400 border border-gray-700">Steady</span>;
}

function RankBadge({ rank }: { rank: number }) {
  const cls =
    rank === 1 ? 'text-yellow-400 border-yellow-500/50 bg-yellow-500/10' :
    rank === 2 ? 'text-slate-300  border-slate-400/50  bg-slate-500/10'  :
    rank === 3 ? 'text-orange-400 border-orange-500/50 bg-orange-600/10' :
                 'text-gray-600   border-gray-700/50   bg-gray-800/40';
  return <span className={clsx('text-[9px] font-bold px-1.5 py-0.5 rounded border shrink-0 tabular-nums', cls)}>#{rank}</span>;
}

// ── Sort helper: DIP_BUY first (best entry), then STEADY, then MOMENTUM ──────
// Within each tier: LOW vol > MEDIUM > HIGH so safer options appear at top

const SIG_ORDER: Record<StockRow['signal'], number> = { DIP_BUY: 0, STEADY: 1, MOMENTUM: 2 };
const VOL_ORDER: Record<Volatility, number>          = { LOW: 0, MEDIUM: 1, HIGH: 2 };

function sortRows(rows: StockRow[]): StockRow[] {
  return [...rows].sort((a, b) => {
    const s = SIG_ORDER[a.signal] - SIG_ORDER[b.signal];
    if (s !== 0) return s;
    return VOL_ORDER[a.volatility] - VOL_ORDER[b.volatility];
  });
}

// ── Stock card ────────────────────────────────────────────────────────────────

function StockCard({ row, rank, total, tf }: { row: StockRow; rank: number; total: number; tf: TF }) {
  const cur = row.currency;
  const up  = row.changePercent >= 0;
  const tfLabel = TF_OPTIONS.find(t => t.value === tf)?.label ?? tf;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3 hover:border-gray-700 transition-colors">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <RankBadge rank={rank} />
            <span className="font-bold text-white font-mono">{row.symbol}</span>
            <VolBadge v={row.volatility} />
            <SignalBadge s={row.signal} />
          </div>
          <div className="text-xs text-gray-500 mt-0.5 truncate max-w-[220px]">{row.name}</div>
          <div className="text-[10px] text-gray-700 mt-0.5">{MARKET_LABELS[row.market]} · {row.sector}</div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-sm font-bold text-white font-mono">{fmtPrice(row.price, cur)}</div>
          <div className={clsx('text-xs font-semibold', up ? 'text-emerald-400' : 'text-red-400')}>
            {up ? '+' : ''}{row.changePercent.toFixed(2)}% today
          </div>
        </div>
      </div>

      {/* Why reputable */}
      <p className="text-[10px] text-gray-500 leading-relaxed border-l-2 border-gray-700 pl-2">{row.why}</p>

      {/* Level grid */}
      <div className="grid grid-cols-3 gap-1.5 text-xs font-mono">
        <div className="bg-blue-950/30 rounded-lg p-2 border border-blue-900/20">
          <div className="text-[9px] text-blue-400 font-semibold mb-0.5">ENTRY</div>
          <div className="text-white font-bold">{fmtPrice(row.entry, cur)}</div>
          <div className="text-[9px] text-blue-900">current price</div>
        </div>
        <div className="bg-red-950/30 rounded-lg p-2 border border-red-900/20">
          <div className="text-[9px] text-red-400 font-semibold mb-0.5 flex items-center gap-0.5"><ArrowDown className="h-2 w-2" />STOP LOSS</div>
          <div className="text-red-400 font-bold">{fmtPrice(row.stopLoss, cur)}</div>
          <div className="text-[9px] text-red-900">{row.stopDist.toFixed(2)} · {row.stopPct.toFixed(1)}% below</div>
        </div>
        <div className="bg-emerald-950/30 rounded-lg p-2 border border-emerald-900/20">
          <div className="text-[9px] text-emerald-400 font-semibold mb-0.5 flex items-center gap-0.5"><ArrowUp className="h-2 w-2" />TAKE PROFIT</div>
          <div className="text-emerald-400 font-bold">{fmtPrice(row.takeProfit, cur)}</div>
          <div className="text-[9px] text-emerald-900">{row.tpDist.toFixed(2)} · {(row.stopPct * 2).toFixed(1)}% above</div>
        </div>
      </div>

      {/* R:R + timeframe context */}
      <div className="flex items-center gap-2 flex-wrap text-[10px] text-gray-600">
        <span>2:1 R:R</span>
        <span>·</span>
        <span>{tfLabel} hold</span>
        <span>·</span>
        <span>Ranked #{rank} of {total}</span>
        {row.sma50 && (
          <>
            <span>·</span>
            <span className={clsx(row.price > row.sma50 ? 'text-emerald-700' : 'text-red-700')}>
              {row.price > row.sma50 ? '▲' : '▼'} SMA50
            </span>
          </>
        )}
        {row.week52High && row.week52Low && (
          <>
            <span>·</span>
            <span title="% from 52w high" className="text-gray-700">
              {(((row.price - row.week52High) / row.week52High) * 100).toFixed(1)}% from 52wH
            </span>
          </>
        )}
      </div>

      {/* News */}
      <div className="border-t border-gray-800/60 pt-2">
        <NewsStrip symbol={row.symbol} />
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

type MarketFilter = 'ALL' | Market;

const FILTER_TABS: { value: MarketFilter; label: string }[] = [
  { value: 'ALL',          label: 'All' },
  { value: 'US_SEMI',      label: 'AI & Semis' },
  { value: 'US_TECH',      label: 'US Tech' },
  { value: 'US_FINANCE',   label: 'US Finance' },
  { value: 'US_DEFENSIVE', label: 'US Defensive' },
  { value: 'US_ENERGY',    label: 'US Energy' },
  { value: 'US_PHARMA',    label: 'Pharmaceuticals' },
  { value: 'US_INFRA',     label: 'Infrastructure' },
  { value: 'UK',           label: 'UK Blue Chip' },
  { value: 'ETF',          label: 'ETFs' },
];

export function ReputableStocks() {
  const [tf,        setTf]        = useState<TF>('day');
  const [mktFilter, setMktFilter] = useState<MarketFilter>('ALL');
  const [rows,      setRows]      = useState<StockRow[]>([]);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState('');
  const [lastFetch, setLastFetch] = useState<Date | null>(null);

  const fetch_ = useCallback(async (timeframe: TF) => {
    setLoading(true);
    setError('');
    try {
      const symbols = UNIVERSE.map(s => s.symbol).join(',');
      const r = await fetch(`/api/market/quotes?symbols=${encodeURIComponent(symbols)}`);
      if (!r.ok) throw new Error(`Quotes API ${r.status}`);
      const quotes = await r.json() as QuoteData[];
      const qMap = new Map(quotes.map(q => [q.symbol, q]));

      const computed: StockRow[] = [];
      for (const def of UNIVERSE) {
        const q = qMap.get(def.symbol);
        if (!q || !q.price) continue;
        computed.push(computeRow(def, q, timeframe));
      }
      setRows(sortRows(computed));
      setLastFetch(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load prices');
    } finally {
      setLoading(false);
    }
  }, []);

  // Re-compute levels instantly when timeframe changes (no re-fetch needed)
  useEffect(() => {
    if (rows.length > 0) {
      setRows(prev => sortRows(prev.map(r => computeRow(r, r, tf))));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tf]);

  // Initial load
  useEffect(() => { void fetch_(tf); }, []); // eslint-disable-line

  const displayed = mktFilter === 'ALL' ? rows : rows.filter(r => r.market === mktFilter);

  const tfConf = TF_OPTIONS.find(t => t.value === tf)!;

  return (
    <div className="space-y-5">

      {/* Timeframe selector */}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-1.5">
          {TF_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setTf(opt.value)}
              className={clsx(
                'px-4 py-2 rounded-lg text-sm font-semibold border transition-all',
                tf === opt.value
                  ? 'bg-emerald-600/20 text-emerald-400 border-emerald-600/40'
                  : 'text-gray-500 border-gray-700 hover:border-gray-600 hover:text-gray-300',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-gray-600">{tfConf.desc} · Stop distances adjust automatically per volatility tier</p>
      </div>

      {/* Volatility legend */}
      <div className="flex flex-wrap items-center gap-4 px-4 py-3 bg-gray-900 border border-gray-800 rounded-xl text-[10px]">
        <span className="text-gray-500 font-semibold uppercase tracking-wide">Stop sizes for {tfConf.label}</span>
        {(['LOW', 'MEDIUM', 'HIGH'] as Volatility[]).map(v => (
          <div key={v} className="flex items-center gap-2">
            <VolBadge v={v} />
            <span className="text-gray-400">{STOP_PCT[tf][v].toFixed(1)}% stop · {(STOP_PCT[tf][v] * 2).toFixed(1)}% target</span>
          </div>
        ))}
      </div>

      {/* Controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex gap-1 flex-wrap">
          {FILTER_TABS.map(tab => (
            <button
              key={tab.value}
              onClick={() => setMktFilter(tab.value)}
              className={clsx(
                'px-3 py-1 rounded-lg text-xs font-semibold border transition-all',
                mktFilter === tab.value
                  ? 'bg-blue-600/20 text-blue-400 border-blue-600/40'
                  : 'text-gray-500 border-gray-700 hover:border-gray-600',
              )}
            >
              {tab.label}
              <span className="ml-1 text-gray-600">
                ({tab.value === 'ALL' ? rows.length : rows.filter(r => r.market === tab.value).length})
              </span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {lastFetch && (
            <span className="text-xs text-gray-600">
              Updated {lastFetch.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button
            onClick={() => void fetch_(tf)}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 rounded-lg text-xs text-gray-400 transition-colors"
          >
            <RefreshCw className={clsx('h-3.5 w-3.5', loading && 'animate-spin')} />
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 bg-red-950/20 border border-red-900/40 rounded-xl px-4 py-3">
          <AlertCircle className="h-4 w-4 text-red-400 shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && rows.length === 0 && (
        <div className="flex items-center justify-center gap-2 py-20 text-gray-500 text-sm">
          <RefreshCw className="h-4 w-4 animate-spin" />
          Fetching live prices…
        </div>
      )}

      {/* Signal type groups */}
      {!loading && displayed.length > 0 && (
        <div className="space-y-6">
          {/* Dip Buy */}
          {displayed.filter(r => r.signal === 'DIP_BUY').length > 0 && (
            <section className="space-y-3">
              <h2 className="text-xs font-semibold text-purple-400 uppercase tracking-wide flex items-center gap-2">
                <TrendingUp className="h-3.5 w-3.5" />
                Dip Buy Opportunities
                <span className="text-gray-600 font-normal">— trading below recent levels, potential bounce</span>
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {displayed.filter(r => r.signal === 'DIP_BUY').map((row, i) => (
                  <StockCard key={row.symbol} row={row} rank={rows.indexOf(row) + 1} total={displayed.length} tf={tf} />
                ))}
              </div>
            </section>
          )}

          {/* Steady */}
          {displayed.filter(r => r.signal === 'STEADY').length > 0 && (
            <section className="space-y-3">
              <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide flex items-center gap-2">
                Steady — Consolidating
                <span className="text-gray-600 font-normal">— flat today, awaiting catalyst</span>
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {displayed.filter(r => r.signal === 'STEADY').map((row, i) => (
                  <StockCard key={row.symbol} row={row} rank={rows.indexOf(row) + 1} total={displayed.length} tf={tf} />
                ))}
              </div>
            </section>
          )}

          {/* Momentum */}
          {displayed.filter(r => r.signal === 'MOMENTUM').length > 0 && (
            <section className="space-y-3">
              <h2 className="text-xs font-semibold text-blue-400 uppercase tracking-wide flex items-center gap-2">
                <TrendingUp className="h-3.5 w-3.5" />
                Momentum
                <span className="text-gray-600 font-normal">— running today, enter on pullback or breakout</span>
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {displayed.filter(r => r.signal === 'MOMENTUM').map((row, i) => (
                  <StockCard key={row.symbol} row={row} rank={rows.indexOf(row) + 1} total={displayed.length} tf={tf} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {!loading && !error && rows.length > 0 && displayed.length === 0 && (
        <p className="text-center py-12 text-gray-600 text-sm">No stocks in this category.</p>
      )}

      <p className="text-[10px] text-gray-700 text-center pt-2">
        Levels shown are indicative based on timeframe and volatility tier — not financial advice. Always verify before entering a trade. Spread betting involves significant risk of loss.
      </p>
    </div>
  );
}

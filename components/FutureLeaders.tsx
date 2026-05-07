'use client';

import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Zap, Shield, TrendingUp, ArrowDown, ArrowUp, AlertCircle, Rocket, FlaskConical } from 'lucide-react';
import { clsx } from 'clsx';
import { NewsStrip } from '@/components/ui/NewsStrip';

// ── Types ──────────────────────────────────────────────────────────────────────

type Volatility  = 'MEDIUM' | 'HIGH';
type Conviction  = 'HIGH' | 'MEDIUM';
type Horizon     = '1-3yr' | '3-5yr' | '5-10yr';
type Sector      = 'AI_INFRA' | 'CYBERSECURITY' | 'CLEAN_ENERGY' | 'SPACE' | 'BIOTECH' | 'DEFENSE_TECH' | 'EV' | 'QUANTUM' | 'FINTECH' | 'DATA_CLOUD' | 'ROBOTICS' | 'CRYPTO_INFRA';

type LeaderDef = {
  symbol:     string;
  name:       string;
  sector:     Sector;
  volatility: Volatility;
  conviction: Conviction;
  horizon:    Horizon;
  thesis:     string;
  catalysts:  string[];   // 2-3 upcoming milestones
};

const LEADERS: LeaderDef[] = [
  // ── AI Infrastructure ──────────────────────────────────────────────────────
  {
    symbol: 'SMCI', name: 'Super Micro Computer', sector: 'AI_INFRA',
    volatility: 'HIGH', conviction: 'HIGH', horizon: '1-3yr',
    thesis: 'Builds the GPU server racks that power NVIDIA-based AI clusters; custom liquid-cooled solutions for hyperscalers',
    catalysts: ['Hyperscaler AI capex expansion 2025-26', 'New Blackwell-ready rack launch', 'Accounting restatement resolved — discount to peers closing'],
  },
  {
    symbol: 'ARM', name: 'ARM Holdings', sector: 'AI_INFRA',
    volatility: 'HIGH', conviction: 'HIGH', horizon: '1-3yr',
    thesis: 'Chip architecture inside every smartphone and rapidly expanding into data-centre AI; royalty model scales without manufacturing risk',
    catalysts: ['CSS compute subsystem adoption in AI chips', 'Data-centre ARM share gains vs x86', 'v9 architecture royalty rate lift'],
  },
  {
    symbol: 'CRM', name: 'Salesforce', sector: 'AI_INFRA',
    volatility: 'MEDIUM', conviction: 'HIGH', horizon: '1-3yr',
    thesis: 'Agentforce autonomous AI agents embedded in enterprise CRM workflows; owns the customer data AI needs to be useful',
    catalysts: ['Agentforce seat adoption metrics', 'Einstein AI upsell penetration', 'Data Cloud growth converting free to paid'],
  },
  {
    symbol: 'DELL', name: 'Dell Technologies', sector: 'AI_INFRA',
    volatility: 'MEDIUM', conviction: 'MEDIUM', horizon: '1-3yr',
    thesis: 'AI server order book growing 3× YoY; PowerEdge GPU servers and storage benefiting from enterprise AI build-out',
    catalysts: ['Infrastructure Solutions Group AI revenue disclosures', 'PC refresh cycle 2025-26', 'AI PC Copilot+ certification rollout'],
  },
  // ── Cybersecurity ─────────────────────────────────────────────────────────
  {
    symbol: 'CRWD', name: 'CrowdStrike', sector: 'CYBERSECURITY',
    volatility: 'HIGH', conviction: 'HIGH', horizon: '1-3yr',
    thesis: 'AI-native Falcon platform consolidating endpoint, cloud and identity security; net revenue retention consistently above 120%',
    catalysts: ['Falcon Flex platform module attach expansion', 'Outage remediation discount programme concluding', 'SIEM and data protection module adoption'],
  },
  {
    symbol: 'PANW', name: 'Palo Alto Networks', sector: 'CYBERSECURITY',
    volatility: 'HIGH', conviction: 'HIGH', horizon: '1-3yr',
    thesis: 'Platformisation strategy consolidating 3-4 point solutions into one; XSIAM AI SOC replacing legacy SIEMs at enterprise scale',
    catalysts: ['Platformisation billings acceleration', 'Precision AI product suite adoption', 'Federal security contract expansions'],
  },
  {
    symbol: 'NET', name: 'Cloudflare', sector: 'CYBERSECURITY',
    volatility: 'HIGH', conviction: 'HIGH', horizon: '3-5yr',
    thesis: 'Sits between every internet user and every server; SASE, Zero Trust and AI inference at the edge — compounding network effects',
    catalysts: ['Workers AI inference revenue materialising', 'Zero Trust SASE enterprise deals', 'AI Gateway and R2 storage monetisation'],
  },
  {
    symbol: 'S', name: 'SentinelOne', sector: 'CYBERSECURITY',
    volatility: 'HIGH', conviction: 'MEDIUM', horizon: '1-3yr',
    thesis: 'Purple AI autonomous threat detection; taking share from legacy AV vendors as AI-native security becomes the standard',
    catalysts: ['Purple AI enterprise seats growth', 'Data platform ARR contribution', 'Path to profitability milestones'],
  },
  // ── Clean Energy ──────────────────────────────────────────────────────────
  {
    symbol: 'FSLR', name: 'First Solar', sector: 'CLEAN_ENERGY',
    volatility: 'HIGH', conviction: 'HIGH', horizon: '1-3yr',
    thesis: "Only US-manufactured thin-film solar panels; IRA domestic content adder makes it the most cost-competitive utility-scale option",
    catalysts: ['Series 7 panel ramp to 20GW capacity', 'IRA domestic content bonus credits', 'Data-centre solar procurement contracts'],
  },
  {
    symbol: 'ENPH', name: 'Enphase Energy', sector: 'CLEAN_ENERGY',
    volatility: 'HIGH', conviction: 'HIGH', horizon: '3-5yr',
    thesis: 'Microinverter + home battery ecosystem; IQ9 architecture expanding margin as interest rates ease and residential solar recovers',
    catalysts: ['IQ Battery 5P global rollout', 'EV charger integration expansion', 'European installer channel growth'],
  },
  {
    symbol: 'BE', name: 'Bloom Energy', sector: 'CLEAN_ENERGY',
    volatility: 'HIGH', conviction: 'MEDIUM', horizon: '3-5yr',
    thesis: 'Solid-oxide fuel cells providing always-on clean power to AI data centres — directly addresses AI grid stress without transmission build',
    catalysts: ['AI data-centre power agreement pipeline', 'Electrolyser hydrogen revenue', 'South Korea utility fleet expansion'],
  },
  {
    symbol: 'NEE', name: 'NextEra Energy', sector: 'CLEAN_ENERGY',
    volatility: 'MEDIUM', conviction: 'HIGH', horizon: '1-3yr',
    thesis: "World's largest renewable energy utility; contracted backlog growing with AI data-centre electricity demand creating 10%+ earnings growth",
    catalysts: ['Data-centre power purchase agreements', '35GW backlog execution 2025-27', 'FPL regulated rate case outcome'],
  },
  // ── Space ─────────────────────────────────────────────────────────────────
  {
    symbol: 'RKLB', name: 'Rocket Lab', sector: 'SPACE',
    volatility: 'HIGH', conviction: 'HIGH', horizon: '3-5yr',
    thesis: 'Only commercial alternative to SpaceX for small-satellite launch; Neutron medium-lift rocket could unlock national security contracts',
    catalysts: ['Neutron first flight 2026', 'Photon spacecraft bus revenue', 'National security NSSL Phase 3 contract award'],
  },
  {
    symbol: 'ASTS', name: 'AST SpaceMobile', sector: 'SPACE',
    volatility: 'HIGH', conviction: 'HIGH', horizon: '3-5yr',
    thesis: 'Space-based cellular network using commercial smartphones — eliminates dead zones globally; AT&T and Verizon already signed',
    catalysts: ['BlueBird Block 2 constellation launch', 'Commercial service revenue with AT&T/Verizon', 'International carrier partnership announcements'],
  },
  // ── Biotech ───────────────────────────────────────────────────────────────
  {
    symbol: 'MRNA', name: 'Moderna', sector: 'BIOTECH',
    volatility: 'HIGH', conviction: 'HIGH', horizon: '3-5yr',
    thesis: 'mRNA platform beyond COVID — personalised cancer vaccines (mRNA-4157 with Merck), flu combo shots, RSV, rare disease pipeline',
    catalysts: ['mRNA-4157 melanoma Phase 3 readout', 'Combo flu/COVID vaccine approval', 'CMV vaccine Phase 3 enrolment'],
  },
  {
    symbol: 'CRSP', name: 'CRISPR Therapeutics', sector: 'BIOTECH',
    volatility: 'HIGH', conviction: 'HIGH', horizon: '3-5yr',
    thesis: 'Casgevy is the first approved gene-editing therapy (sickle cell); proof-of-concept opens a pipeline of single-treatment cures',
    catalysts: ['Casgevy reimbursement coverage expansion', 'CTX310 cardiovascular trial data', 'In-vivo CRISPR programmes Phase 1 initiation'],
  },
  {
    symbol: 'RXRX', name: 'Recursion Pharmaceuticals', sector: 'BIOTECH',
    volatility: 'HIGH', conviction: 'MEDIUM', horizon: '3-5yr',
    thesis: 'AI-powered drug discovery using massive biological datasets; NVIDIA investment validates the platform; pipeline cost per candidate far below industry',
    catalysts: ['REC-994 Phase 2 readout', 'Roche/Genentech collaboration milestones', 'NVIDIA Quantum-2 biology compute partnership output'],
  },
  // ── Defense Tech ─────────────────────────────────────────────────────────
  {
    symbol: 'AXON', name: 'Axon Enterprise', sector: 'DEFENSE_TECH',
    volatility: 'HIGH', conviction: 'HIGH', horizon: '1-3yr',
    thesis: 'AI evidence platform (Draft One + TASER) creating a closed-loop public safety ecosystem; government SaaS with high switching costs',
    catalysts: ['Draft One AI writing tool adoption in PD contracts', 'TASER 10 international expansion', 'Axon Evidence cloud contract renewals'],
  },
  {
    symbol: 'KTOS', name: 'Kratos Defense', sector: 'DEFENSE_TECH',
    volatility: 'HIGH', conviction: 'HIGH', horizon: '3-5yr',
    thesis: 'Low-cost autonomous drones (Valkyrie, Gremlins) — designed to be attritable; fills a gap no legacy defence prime can address cheaply',
    catalysts: ['Valkyrie production contract award', 'Hypersonic target drone revenues', 'Collaborative Combat Aircraft programme selection'],
  },
  {
    symbol: 'LDOS', name: 'Leidos Holdings', sector: 'DEFENSE_TECH',
    volatility: 'MEDIUM', conviction: 'HIGH', horizon: '1-3yr',
    thesis: 'US government IT and defence services; AI-enabled intelligence and logistics systems with long-term federal contract visibility',
    catalysts: ['DOGE reallocation of contracts to efficieny providers', 'Health IT digital modernisation awards', 'JADC2 battlespace connectivity programme'],
  },
  // ── Electric Vehicles ─────────────────────────────────────────────────────
  {
    symbol: 'RIVN', name: 'Rivian', sector: 'EV',
    volatility: 'HIGH', conviction: 'MEDIUM', horizon: '3-5yr',
    thesis: 'Amazon exclusive delivery van fleet + R1T/R1S consumers; next-gen R2 platform lowers cost structure significantly in 2026',
    catalysts: ['R2 platform launch and order book', 'Amazon EDV fleet scale-up to 100,000', 'Joint venture with Volkswagen production milestones'],
  },
  {
    symbol: 'NIO', name: 'NIO', sector: 'EV',
    volatility: 'HIGH', conviction: 'MEDIUM', horizon: '3-5yr',
    thesis: 'Battery-swap infrastructure creates switching costs; premium Chinese EV brand with ONVO sub-brand targeting mass market',
    catalysts: ['ONVO L60 volume ramp vs BYD', 'Battery-swap station network 3,000 milestone', 'EU market entry with swap-compatible vehicles'],
  },
  // ── Quantum Computing ────────────────────────────────────────────────────
  {
    symbol: 'IONQ', name: 'IonQ', sector: 'QUANTUM',
    volatility: 'HIGH', conviction: 'MEDIUM', horizon: '5-10yr',
    thesis: 'Trapped-ion quantum computers with best-in-class error rates; early enterprise SaaS contracts and government research agreements',
    catalysts: ['Forte Enterprise system commercial deployment', '#AQ error rate milestone announcements', 'Networking modules linking quantum systems'],
  },
  // ── Fintech ───────────────────────────────────────────────────────────────
  {
    symbol: 'SOFI', name: 'SoFi Technologies', sector: 'FINTECH',
    volatility: 'HIGH', conviction: 'HIGH', horizon: '1-3yr',
    thesis: 'National bank charter unlocks deposit funding at lower cost than peers; one-app financial services compounding member cross-sell',
    catalysts: ['Loan platform 3rd-party volume growth', 'Technology Platform (Galileo/Apex) revenue', 'Member product cross-sell ratio improvement'],
  },
  {
    symbol: 'NU', name: 'Nu Holdings', sector: 'FINTECH',
    volatility: 'HIGH', conviction: 'HIGH', horizon: '3-5yr',
    thesis: '110M+ customers across Brazil/Mexico/Colombia; digital banking without branches achieving 30%+ ROE ahead of incumbent banks',
    catalysts: ['Mexico + Colombia profitability inflection', 'Nubank credit card market share in Brazil', 'Ultra-high net worth product launch'],
  },
  {
    symbol: 'AFRM', name: 'Affirm', sector: 'FINTECH',
    volatility: 'HIGH', conviction: 'HIGH', horizon: '1-3yr',
    thesis: 'BNPL embedded in Shopify, Amazon, Apple Pay — becoming the default alternative to credit cards for Gen Z/Millennial spending',
    catalysts: ['GMV growth acceleration with Apple Pay Later replacement', 'UK/Canada market expansion', 'Debit+ card adoption as primary spend account'],
  },
  // ── Data & Cloud ─────────────────────────────────────────────────────────
  {
    symbol: 'SNOW', name: 'Snowflake', sector: 'DATA_CLOUD',
    volatility: 'HIGH', conviction: 'HIGH', horizon: '1-3yr',
    thesis: 'AI data cloud where enterprises store data models are trained on; Cortex AI + Snowpark making it the default AI data platform',
    catalysts: ['Cortex AI product consumption growth', 'Iceberg Table open format adoption', 'Data sharing marketplace revenue'],
  },
  {
    symbol: 'DDOG', name: 'Datadog', sector: 'DATA_CLOUD',
    volatility: 'HIGH', conviction: 'HIGH', horizon: '1-3yr',
    thesis: 'Cloud observability platform expanding into AI observability (LLM monitoring, pipeline tracing); benefits from every AI workload deployed',
    catalysts: ['LLM Observability product adoption by AI-native companies', 'Bits AI assistant GA launch', 'Log Management + SIEM expansion'],
  },
  {
    symbol: 'MDB', name: 'MongoDB', sector: 'DATA_CLOUD',
    volatility: 'HIGH', conviction: 'MEDIUM', horizon: '1-3yr',
    thesis: 'Flexible document database preferred for AI application development; Atlas vector search making it the default for AI app backends',
    catalysts: ['Atlas Vector Search adoption metric growth', 'Atlas Stream Processing GA', 'Relational Migrator converting Oracle/Postgres workloads'],
  },
  // ── Robotics ─────────────────────────────────────────────────────────────
  {
    symbol: 'ISRG', name: 'Intuitive Surgical', sector: 'ROBOTICS',
    volatility: 'MEDIUM', conviction: 'HIGH', horizon: '1-3yr',
    thesis: 'da Vinci robotic surgery monopoly with 40,000+ installed systems; razor-and-blade instrument revenue compounding; new Ion lung biopsy expanding market',
    catalysts: ['da Vinci 5 system rollout and incremental procedure growth', 'Ion bronchoscopy commercialisation', 'Single-port SP system international expansion'],
  },
  {
    symbol: 'COIN', name: 'Coinbase', sector: 'CRYPTO_INFRA',
    volatility: 'HIGH', conviction: 'MEDIUM', horizon: '1-3yr',
    thesis: 'Regulated crypto exchange and custody provider; Base L2 network growing into the Ethereum ecosystem; stablecoin interest income is recurring',
    catalysts: ['US spot Bitcoin ETF custody wins (BlackRock, Fidelity)', 'USDC stablecoin yield as rates stabilise', 'Base L2 transaction fee revenue growth'],
  },
];

// ── Sector config ─────────────────────────────────────────────────────────────

type SectorMeta = { label: string; color: string; textColor: string; borderColor: string; icon: string };

const SECTOR_META: Record<Sector, SectorMeta> = {
  AI_INFRA:      { label: 'AI Infrastructure',   color: 'bg-violet-500/10', textColor: 'text-violet-400', borderColor: 'border-violet-500/30', icon: '🤖' },
  CYBERSECURITY: { label: 'Cybersecurity',        color: 'bg-blue-500/10',   textColor: 'text-blue-400',   borderColor: 'border-blue-500/30',   icon: '🛡️' },
  CLEAN_ENERGY:  { label: 'Clean Energy',         color: 'bg-emerald-500/10',textColor: 'text-emerald-400',borderColor: 'border-emerald-500/30',icon: '⚡' },
  SPACE:         { label: 'Space',                color: 'bg-indigo-500/10', textColor: 'text-indigo-400', borderColor: 'border-indigo-500/30', icon: '🚀' },
  BIOTECH:       { label: 'Biotech / Gene',       color: 'bg-pink-500/10',   textColor: 'text-pink-400',   borderColor: 'border-pink-500/30',   icon: '🧬' },
  DEFENSE_TECH:  { label: 'Defense Tech',         color: 'bg-slate-500/10',  textColor: 'text-slate-300',  borderColor: 'border-slate-500/30',  icon: '🎯' },
  EV:            { label: 'Electric Vehicles',    color: 'bg-teal-500/10',   textColor: 'text-teal-400',   borderColor: 'border-teal-500/30',   icon: '🔋' },
  QUANTUM:       { label: 'Quantum Computing',    color: 'bg-cyan-500/10',   textColor: 'text-cyan-400',   borderColor: 'border-cyan-500/30',   icon: '⚛️' },
  FINTECH:       { label: 'Fintech',              color: 'bg-amber-500/10',  textColor: 'text-amber-400',  borderColor: 'border-amber-500/30',  icon: '💳' },
  DATA_CLOUD:    { label: 'Data & Cloud',         color: 'bg-sky-500/10',    textColor: 'text-sky-400',    borderColor: 'border-sky-500/30',    icon: '☁️' },
  ROBOTICS:      { label: 'Robotics & Automation',color: 'bg-orange-500/10', textColor: 'text-orange-400', borderColor: 'border-orange-500/30', icon: '🦾' },
  CRYPTO_INFRA:  { label: 'Crypto Infrastructure',color: 'bg-yellow-500/10', textColor: 'text-yellow-400', borderColor: 'border-yellow-500/30', icon: '₿' },
};

const SECTOR_ORDER: Sector[] = [
  'AI_INFRA', 'CYBERSECURITY', 'DATA_CLOUD', 'CLEAN_ENERGY',
  'DEFENSE_TECH', 'BIOTECH', 'FINTECH', 'SPACE',
  'ROBOTICS', 'EV', 'QUANTUM', 'CRYPTO_INFRA',
];

// ── Timeframe config ──────────────────────────────────────────────────────────

type TF = 'hours' | 'day' | 'week' | 'month' | 'longterm';

const TF_OPTIONS: { value: TF; label: string; desc: string }[] = [
  { value: 'hours',    label: 'Hours',     desc: 'Intraday — tight stops, same-session exit' },
  { value: 'day',      label: 'Day',       desc: 'Daily trade — sized for today\'s range' },
  { value: 'week',     label: 'Week',      desc: 'Swing — multi-day, 1–2 weeks' },
  { value: 'month',    label: 'Month',     desc: 'Position trade — 2–6 weeks' },
  { value: 'longterm', label: 'Long-term', desc: 'Investment — 3+ months, matches the thesis horizon' },
];

const STOP_PCT: Record<TF, Record<'MEDIUM' | 'HIGH', number>> = {
  hours:    { MEDIUM: 0.8,  HIGH: 1.5  },
  day:      { MEDIUM: 2.0,  HIGH: 3.5  },
  week:     { MEDIUM: 4.5,  HIGH: 7.0  },
  month:    { MEDIUM: 10.0, HIGH: 15.0 },
  longterm: { MEDIUM: 22.0, HIGH: 30.0 },
};

// ── Quote type ────────────────────────────────────────────────────────────────

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

type LeaderRow = LeaderDef & QuoteData & {
  entry:      number;
  stopLoss:   number;
  takeProfit: number;
  stopDist:   number;
  tpDist:     number;
  stopPct:    number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPrice(price: number, currency: string): string {
  if (currency === 'GBp') return `${price.toFixed(1)}p`;
  if (currency === 'GBP') return `£${price.toFixed(2)}`;
  return `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: price < 10 ? 4 : 2 })}`;
}

function r2(n: number) { return Math.round(n * 100) / 100; }

function computeRow(def: LeaderDef, q: QuoteData, tf: TF): LeaderRow {
  const stopPct  = STOP_PCT[tf][def.volatility];
  const stopDist = r2(q.price * stopPct / 100);
  const tpDist   = r2(stopDist * 2);
  return {
    ...def, ...q,
    entry:      r2(q.price),
    stopLoss:   r2(q.price - stopDist),
    takeProfit: r2(q.price + tpDist),
    stopDist, tpDist, stopPct,
  };
}

// ── Badges ────────────────────────────────────────────────────────────────────

function ConvictionBadge({ c }: { c: Conviction }) {
  return c === 'HIGH'
    ? <span className="inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded border bg-emerald-500/15 text-emerald-400 border-emerald-500/30"><Zap className="h-2.5 w-2.5" />High Conviction</span>
    : <span className="inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded border bg-amber-500/10 text-amber-400 border-amber-500/30"><Shield className="h-2.5 w-2.5" />Med Conviction</span>;
}

function HorizonBadge({ h }: { h: Horizon }) {
  const cls =
    h === '1-3yr'  ? 'text-blue-400  border-blue-500/30  bg-blue-500/10'  :
    h === '3-5yr'  ? 'text-purple-400 border-purple-500/30 bg-purple-500/10' :
                     'text-gray-400  border-gray-600/30  bg-gray-700/20';
  return <span className={clsx('text-[9px] font-bold px-1.5 py-0.5 rounded border', cls)}>⏱ {h}</span>;
}

function VolBadge({ v }: { v: 'MEDIUM' | 'HIGH' }) {
  return v === 'HIGH'
    ? <span className="inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded border bg-red-500/10 text-red-400 border-red-500/30"><Zap className="h-2.5 w-2.5" />High Vol</span>
    : <span className="inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded border bg-amber-500/10 text-amber-400 border-amber-500/30"><Shield className="h-2.5 w-2.5" />Med Vol</span>;
}

function RankBadge({ rank }: { rank: number }) {
  const cls =
    rank === 1 ? 'text-yellow-400 border-yellow-500/50 bg-yellow-500/10' :
    rank === 2 ? 'text-slate-300  border-slate-400/50  bg-slate-500/10'  :
    rank === 3 ? 'text-orange-400 border-orange-500/50 bg-orange-600/10' :
                 'text-gray-600   border-gray-700/50   bg-gray-800/40';
  return <span className={clsx('text-[9px] font-bold px-1.5 py-0.5 rounded border shrink-0 tabular-nums', cls)}>#{rank}</span>;
}

// ── Leader card ───────────────────────────────────────────────────────────────

function LeaderCard({ row, rank, total, tf }: { row: LeaderRow; rank: number; total: number; tf: TF }) {
  const cur     = row.currency;
  const up      = row.changePercent >= 0;
  const sm      = SECTOR_META[row.sector];
  const tfLabel = TF_OPTIONS.find(t => t.value === tf)?.label ?? tf;

  return (
    <div className={clsx('bg-gray-900 rounded-xl border p-4 space-y-3 hover:border-gray-700 transition-colors', sm.borderColor)}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <RankBadge rank={rank} />
            <span className="font-bold text-white font-mono">{row.symbol}</span>
            <ConvictionBadge c={row.conviction} />
            <HorizonBadge h={row.horizon} />
            <VolBadge v={row.volatility} />
          </div>
          <div className="text-xs text-gray-500 mt-0.5 truncate">{row.name}</div>
          <div className={clsx('text-[10px] font-semibold mt-0.5', sm.textColor)}>
            {sm.icon} {sm.label}
          </div>
        </div>
        <div className="text-right shrink-0">
          {row.price > 0 ? (
            <>
              <div className="text-sm font-bold text-white font-mono">{fmtPrice(row.price, cur)}</div>
              <div className={clsx('text-xs font-semibold', up ? 'text-emerald-400' : 'text-red-400')}>
                {up ? '+' : ''}{row.changePercent.toFixed(2)}%
              </div>
            </>
          ) : (
            <div className="text-xs text-gray-600">Loading…</div>
          )}
        </div>
      </div>

      {/* Thesis */}
      <p className="text-[10px] text-gray-400 leading-relaxed border-l-2 border-gray-700 pl-2">{row.thesis}</p>

      {/* Catalysts */}
      <div className="space-y-1">
        <div className="text-[9px] text-gray-600 uppercase tracking-wider font-semibold flex items-center gap-1">
          <Rocket className="h-2.5 w-2.5" /> Key Catalysts
        </div>
        <ul className="space-y-0.5">
          {row.catalysts.map((c, i) => (
            <li key={i} className="flex gap-1.5 text-[10px] text-gray-500">
              <span className="text-emerald-700 shrink-0 mt-0.5">▸</span>{c}
            </li>
          ))}
        </ul>
      </div>

      {/* Trade levels (only shown if we have a price) */}
      {row.price > 0 && (
        <div className="grid grid-cols-3 gap-1.5 text-xs font-mono">
          <div className="bg-blue-950/30 rounded-lg p-2 border border-blue-900/20">
            <div className="text-[9px] text-blue-400 font-semibold mb-0.5">ENTRY</div>
            <div className="text-white font-bold">{fmtPrice(row.entry, cur)}</div>
            <div className="text-[9px] text-blue-900">market price</div>
          </div>
          <div className="bg-red-950/30 rounded-lg p-2 border border-red-900/20">
            <div className="text-[9px] text-red-400 font-semibold mb-0.5 flex items-center gap-0.5"><ArrowDown className="h-2 w-2" />STOP LOSS</div>
            <div className="text-red-400 font-bold">{fmtPrice(row.stopLoss, cur)}</div>
            <div className="text-[9px] text-red-900">{row.stopPct.toFixed(1)}% below</div>
          </div>
          <div className="bg-emerald-950/30 rounded-lg p-2 border border-emerald-900/20">
            <div className="text-[9px] text-emerald-400 font-semibold mb-0.5 flex items-center gap-0.5"><ArrowUp className="h-2 w-2" />TARGET</div>
            <div className="text-emerald-400 font-bold">{fmtPrice(row.takeProfit, cur)}</div>
            <div className="text-[9px] text-emerald-900">{(row.stopPct * 2).toFixed(1)}% above</div>
          </div>
        </div>
      )}

      {/* Footer */}
      {row.price > 0 && (
        <div className="flex items-center gap-2 flex-wrap text-[10px] text-gray-700">
          <span>2:1 R:R · {tfLabel} hold</span>
          <span>· #{rank} of {total}</span>
          {row.sma200 && (
            <span className={clsx(row.price > row.sma200 ? 'text-emerald-700' : 'text-red-700')}>
              · {row.price > row.sma200 ? '▲' : '▼'} SMA200
            </span>
          )}
          {row.week52High && (
            <span title="from 52w high">
              · {(((row.price - row.week52High) / row.week52High) * 100).toFixed(1)}% 52wH
            </span>
          )}
        </div>
      )}

      {/* News */}
      <div className="border-t border-gray-800/60 pt-2">
        <NewsStrip symbol={row.symbol} />
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

type SectorFilter = 'ALL' | Sector;
type ConvFilter   = 'ALL' | Conviction;

export function FutureLeaders() {
  const [tf,          setTf]          = useState<TF>('longterm');
  const [sectorFilter,setSectorFilter] = useState<SectorFilter>('ALL');
  const [convFilter,  setConvFilter]  = useState<ConvFilter>('ALL');
  const [rows,        setRows]        = useState<LeaderRow[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState('');
  const [lastFetch,   setLastFetch]   = useState<Date | null>(null);

  const fetch_ = useCallback(async (timeframe: TF) => {
    setLoading(true);
    setError('');
    try {
      const symbols = LEADERS.map(s => s.symbol).join(',');
      const r = await fetch(`/api/market/quotes?symbols=${encodeURIComponent(symbols)}`);
      if (!r.ok) throw new Error(`Quotes API ${r.status}`);
      const quotes = await r.json() as QuoteData[];
      const qMap = new Map(quotes.map(q => [q.symbol, q]));
      const computed = LEADERS.map(def => {
        const q = qMap.get(def.symbol);
        if (!q || !q.price) return computeRow(def, { symbol: def.symbol, price: 0, changePercent: 0, currency: 'USD' }, timeframe);
        return computeRow(def, q, timeframe);
      });
      setRows(computed);
      setLastFetch(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load prices');
    } finally {
      setLoading(false);
    }
  }, []);

  // Recompute levels instantly on timeframe change
  useEffect(() => {
    if (rows.length > 0) {
      setRows(prev => prev.map(r => computeRow(r, r, tf)));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tf]);

  useEffect(() => { void fetch_(tf); }, []); // eslint-disable-line

  const filtered = rows
    .filter(r => sectorFilter === 'ALL' || r.sector === sectorFilter)
    .filter(r => convFilter   === 'ALL' || r.conviction === convFilter);

  // Group by sector in defined order
  const bySector = SECTOR_ORDER
    .map(sector => ({ sector, cards: filtered.filter(r => r.sector === sector) }))
    .filter(g => g.cards.length > 0);

  const tfConf = TF_OPTIONS.find(t => t.value === tf)!;

  return (
    <div className="space-y-5">

      {/* Timeframe selector */}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-1.5">
          {TF_OPTIONS.map(opt => (
            <button key={opt.value} onClick={() => setTf(opt.value)}
              className={clsx('px-4 py-2 rounded-lg text-sm font-semibold border transition-all',
                tf === opt.value
                  ? 'bg-emerald-600/20 text-emerald-400 border-emerald-600/40'
                  : 'text-gray-500 border-gray-700 hover:border-gray-600 hover:text-gray-300',
              )}>
              {opt.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-gray-600">{tfConf.desc}</p>
      </div>

      {/* Conviction filter + sector filter */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="flex gap-1">
          {(['ALL', 'HIGH', 'MEDIUM'] as const).map(c => (
            <button key={c} onClick={() => setConvFilter(c)}
              className={clsx('px-3 py-1 rounded-lg text-xs font-semibold border transition-all',
                convFilter === c
                  ? 'bg-emerald-600/20 text-emerald-400 border-emerald-600/40'
                  : 'text-gray-500 border-gray-700 hover:border-gray-600',
              )}>
              {c === 'ALL' ? 'All Conviction' : c === 'HIGH' ? '⚡ High Conviction' : '🟡 Med Conviction'}
            </button>
          ))}
        </div>
        <div className="flex gap-1 flex-wrap">
          <button onClick={() => setSectorFilter('ALL')}
            className={clsx('px-2 py-1 rounded text-[10px] font-semibold border transition-all',
              sectorFilter === 'ALL' ? 'bg-blue-600/20 text-blue-400 border-blue-600/30' : 'text-gray-500 border-gray-700 hover:border-gray-600'
            )}>All Sectors</button>
          {SECTOR_ORDER.map(s => {
            const m = SECTOR_META[s];
            const count = rows.filter(r => r.sector === s).length;
            if (count === 0) return null;
            return (
              <button key={s} onClick={() => setSectorFilter(s)}
                className={clsx('px-2 py-1 rounded text-[10px] font-semibold border transition-all',
                  sectorFilter === s ? `${m.color} ${m.textColor} ${m.borderColor}` : 'text-gray-500 border-gray-700 hover:border-gray-600'
                )}>
                {m.icon} {m.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs text-gray-600">
          {filtered.length} future leader{filtered.length !== 1 ? 's' : ''} · stops sized for <span className="text-white">{tfConf.label}</span> timeframe
        </p>
        <div className="flex items-center gap-2">
          {lastFetch && (
            <span className="text-xs text-gray-600">
              Updated {lastFetch.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button onClick={() => void fetch_(tf)} disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 rounded-lg text-xs text-gray-400 transition-colors">
            <RefreshCw className={clsx('h-3.5 w-3.5', loading && 'animate-spin')} />
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 bg-red-950/20 border border-red-900/40 rounded-xl px-4 py-3">
          <AlertCircle className="h-4 w-4 text-red-400 shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {loading && rows.length === 0 && (
        <div className="flex items-center justify-center gap-2 py-20 text-gray-500 text-sm">
          <RefreshCw className="h-4 w-4 animate-spin" /> Fetching live prices…
        </div>
      )}

      {/* Cards by sector */}
      {bySector.map(({ sector, cards }) => {
        const sm = SECTOR_META[sector];
        return (
          <section key={sector} className="space-y-3">
            <h2 className={clsx('text-xs font-bold uppercase tracking-wide flex items-center gap-2', sm.textColor)}>
              <span>{sm.icon}</span>
              <span>{sm.label}</span>
              <span className="text-gray-600 font-normal">({cards.length})</span>
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {cards.map((row, i) => (
                <LeaderCard
                  key={row.symbol}
                  row={row}
                  rank={rows.indexOf(row) + 1}
                  total={filtered.length}
                  tf={tf}
                />
              ))}
            </div>
          </section>
        );
      })}

      {!loading && filtered.length === 0 && rows.length > 0 && (
        <p className="text-center py-12 text-gray-600 text-sm">No stocks match the selected filters.</p>
      )}

      <p className="text-[10px] text-gray-700 text-center pt-2">
        Future leaders are higher-risk growth companies — not all will succeed. These are not financial recommendations.
        Entry/stop/target levels are indicative only. Spread betting involves significant risk of loss.
      </p>
    </div>
  );
}

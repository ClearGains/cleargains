'use client';

import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, TrendingUp, TrendingDown, Minus, AlertCircle, ChevronDown, ChevronUp, Zap, AlertTriangle } from 'lucide-react';
import { clsx } from 'clsx';
import { ruleBasedAnalysis } from '@/lib/ruleBasedAnalysis';
import { TIMEFRAME_CONFIG, type Timeframe } from '@/lib/igStrategyEngine';
import type { AnalysisResult } from '@/app/api/analyse/chart/route';
import type { LWCandle } from '@/lib/chartIndicators';

// ── Market universe ───────────────────────────────────────────────────────────

type MarketDef = {
  name:         string;
  yahooSymbol:  string;
  igEpic:       string;
  type:         'INDEX' | 'FOREX' | 'COMMODITY' | 'CRYPTO' | 'SHARES_UK' | 'SHARES_US';
  priceFactor:  number;  // Yahoo price × priceFactor = IG points
  marginPct:    number;  // IG margin rate as decimal (e.g. 0.05 = 5%)
  spread:       number;  // typical bid-ask spread in IG points
};

const MARKETS: MarketDef[] = [
  // Indices
  { name: 'FTSE 100',    yahooSymbol: '^FTSE',     igEpic: 'IX.D.FTSE.DAILY.IP',     type: 'INDEX',     priceFactor: 1,     marginPct: 0.05,  spread: 1   },
  { name: 'S&P 500',     yahooSymbol: '^GSPC',     igEpic: 'IX.D.SPTRD.DAILY.IP',    type: 'INDEX',     priceFactor: 1,     marginPct: 0.05,  spread: 0.6 },
  { name: 'NASDAQ 100',  yahooSymbol: '^IXIC',     igEpic: 'IX.D.NASDAQ.DAILY.IP',   type: 'INDEX',     priceFactor: 1,     marginPct: 0.05,  spread: 1   },
  { name: 'Germany 40',  yahooSymbol: '^GDAXI',    igEpic: 'IX.D.DAX.DAILY.IP',      type: 'INDEX',     priceFactor: 1,     marginPct: 0.05,  spread: 1   },
  { name: 'Wall Street', yahooSymbol: '^DJI',      igEpic: 'IX.D.DOW.DAILY.IP',      type: 'INDEX',     priceFactor: 1,     marginPct: 0.05,  spread: 2   },
  { name: 'Japan 225',   yahooSymbol: '^N225',     igEpic: 'IX.D.NIKKEI.DAILY.IP',   type: 'INDEX',     priceFactor: 1,     marginPct: 0.05,  spread: 6   },
  // Forex
  { name: 'GBP/USD',     yahooSymbol: 'GBPUSD=X',  igEpic: 'CS.D.GBPUSD.TODAY.IP',  type: 'FOREX',     priceFactor: 10000, marginPct: 0.03,  spread: 0.9 },
  { name: 'EUR/USD',     yahooSymbol: 'EURUSD=X',  igEpic: 'CS.D.EURUSD.TODAY.IP',  type: 'FOREX',     priceFactor: 10000, marginPct: 0.03,  spread: 0.8 },
  { name: 'USD/JPY',     yahooSymbol: 'JPY=X',     igEpic: 'CS.D.USDJPY.TODAY.IP',  type: 'FOREX',     priceFactor: 100,   marginPct: 0.03,  spread: 0.8 },
  { name: 'EUR/GBP',     yahooSymbol: 'EURGBP=X',  igEpic: 'CS.D.EURGBP.TODAY.IP',  type: 'FOREX',     priceFactor: 10000, marginPct: 0.03,  spread: 0.9 },
  { name: 'AUD/USD',     yahooSymbol: 'AUDUSD=X',  igEpic: 'CS.D.AUDUSD.TODAY.IP',  type: 'FOREX',     priceFactor: 10000, marginPct: 0.03,  spread: 1   },
  // Commodities
  { name: 'Gold',        yahooSymbol: 'GC=F',      igEpic: 'MT.D.GC.Month2.IP',     type: 'COMMODITY', priceFactor: 1,     marginPct: 0.05,  spread: 0.4 },
  { name: 'Oil (WTI)',   yahooSymbol: 'CL=F',      igEpic: 'MT.D.CL.Month1.IP',     type: 'COMMODITY', priceFactor: 1,     marginPct: 0.05,  spread: 0.3 },
  { name: 'Silver',      yahooSymbol: 'SI=F',      igEpic: 'MT.D.SI.Month1.IP',     type: 'COMMODITY', priceFactor: 1,     marginPct: 0.05,  spread: 0.02},
  // Crypto
  { name: 'Bitcoin',     yahooSymbol: 'BTC-USD',   igEpic: 'CS.D.BITCOIN.TODAY.IP', type: 'CRYPTO',    priceFactor: 1,     marginPct: 0.50,  spread: 40  },
  // UK Shares
  { name: 'Lloyds',      yahooSymbol: 'LLOY.L',    igEpic: 'CS.D.LLOYDS.TODAY.IP',  type: 'SHARES_UK', priceFactor: 100,   marginPct: 0.20,  spread: 0.1 },
  { name: 'Barclays',    yahooSymbol: 'BARC.L',    igEpic: 'CS.D.BARC.TODAY.IP',    type: 'SHARES_UK', priceFactor: 100,   marginPct: 0.20,  spread: 0.1 },
  { name: 'BP',          yahooSymbol: 'BP.L',      igEpic: 'CS.D.BP.TODAY.IP',      type: 'SHARES_UK', priceFactor: 100,   marginPct: 0.20,  spread: 0.1 },
  { name: 'Shell',       yahooSymbol: 'SHEL.L',    igEpic: 'CS.D.SHELL.TODAY.IP',   type: 'SHARES_UK', priceFactor: 100,   marginPct: 0.20,  spread: 0.5 },
  { name: 'Rolls-Royce', yahooSymbol: 'RR.L',      igEpic: 'CS.D.RR.TODAY.IP',      type: 'SHARES_UK', priceFactor: 100,   marginPct: 0.20,  spread: 0.1 },
  { name: 'Vodafone',    yahooSymbol: 'VOD.L',     igEpic: 'CS.D.VODAFONE.TODAY.IP',type: 'SHARES_UK', priceFactor: 100,   marginPct: 0.20,  spread: 0.1 },
  { name: 'Barclays',    yahooSymbol: 'BARC.L',    igEpic: 'CS.D.BARC.TODAY.IP',    type: 'SHARES_UK', priceFactor: 100,   marginPct: 0.20,  spread: 0.1 },
  // US Shares
  { name: 'Apple',       yahooSymbol: 'AAPL',      igEpic: 'CS.D.AAPL.TODAY.IP',    type: 'SHARES_US', priceFactor: 100,   marginPct: 0.20,  spread: 2   },
  { name: 'NVIDIA',      yahooSymbol: 'NVDA',      igEpic: 'CS.D.NVDA.TODAY.IP',    type: 'SHARES_US', priceFactor: 100,   marginPct: 0.20,  spread: 5   },
  { name: 'Tesla',       yahooSymbol: 'TSLA',      igEpic: 'CS.D.TSLA.TODAY.IP',    type: 'SHARES_US', priceFactor: 100,   marginPct: 0.20,  spread: 5   },
  { name: 'Amazon',      yahooSymbol: 'AMZN',      igEpic: 'CS.D.AMZN.TODAY.IP',    type: 'SHARES_US', priceFactor: 100,   marginPct: 0.20,  spread: 3   },
  { name: 'Microsoft',   yahooSymbol: 'MSFT',      igEpic: 'CS.D.MSFT.TODAY.IP',    type: 'SHARES_US', priceFactor: 100,   marginPct: 0.20,  spread: 2   },
  { name: 'Meta',        yahooSymbol: 'META',      igEpic: 'CS.D.META.TODAY.IP',    type: 'SHARES_US', priceFactor: 100,   marginPct: 0.20,  spread: 3   },
];

// De-duplicate by yahooSymbol
const UNIQUE_MARKETS = MARKETS.filter((m, i, arr) => arr.findIndex(x => x.yahooSymbol === m.yahooSymbol) === i);

// ── Types ─────────────────────────────────────────────────────────────────────

type QuoteRow = {
  market:        MarketDef;
  price:         number;   // Yahoo price
  igPrice:       number;   // IG points
  changePercent: number;
  signal:        'BUY' | 'SELL' | 'NEUTRAL';
};

type TradeIdea = {
  market:          MarketDef;
  analysis:        AnalysisResult;
  direction:       'BUY' | 'SELL';
  igEntry:         number;
  igStopLoss:      number;
  igTakeProfit1:   number;
  igTakeProfit2:   number;
  stopDistance:    number;
  tp1Distance:     number;
  suggestedSize:   number;   // £/pt
  estimatedMargin: number;   // £
  riskReward:      number;
  confidence:      number;
  compositeScore:  number;
  setupUsed:       'scalp' | 'swing';
};

type RawAnalysis = { market: MarketDef; row: QuoteRow; analysis: AnalysisResult };

function buildIdeas(raws: RawAnalysis[], tf: Timeframe, riskPerTrade: number, minConf: number): TradeIdea[] {
  const useSwing = tf === 'weekly' || tf === 'longterm';
  const ideas: TradeIdea[] = [];
  for (const { market, analysis } of raws) {
    const setup = useSwing ? analysis.swing : analysis.scalp;
    if (setup.direction === 'FLAT') continue;
    if (setup.confidence < minConf) continue;
    const direction = setup.direction === 'LONG' ? 'BUY' : 'SELL';
    const pf           = market.priceFactor;
    const igEntry      = setup.entry       * pf;
    const igStopLoss   = setup.stopLoss    * pf;
    const igTP1        = setup.takeProfit1 * pf;
    const igTP2        = setup.takeProfit2 * pf;
    const stopDistance = Math.abs(igEntry - igStopLoss);
    const tp1Distance  = Math.abs(igTP1 - igEntry);
    if (stopDistance < 0.001) continue;
    const suggestedSize   = Math.max(0.01, riskPerTrade / stopDistance);
    const estimatedMargin = suggestedSize * igEntry * market.marginPct;
    ideas.push({
      market, analysis, direction,
      igEntry, igStopLoss, igTakeProfit1: igTP1, igTakeProfit2: igTP2,
      stopDistance, tp1Distance, suggestedSize, estimatedMargin,
      riskReward:     setup.riskReward,
      confidence:     setup.confidence,
      compositeScore: setup.confidence * setup.riskReward,
      setupUsed:      useSwing ? 'swing' : 'scalp',
    });
  }
  return ideas.sort((a, b) => b.compositeScore - a.compositeScore);
}

type IGLivePosition = {
  dealId:      string;
  direction:   string;
  size:        number;
  level:       number;
  upl:         number;
  currency:    string;
  epic:        string;
  instrumentName: string;
  bid:         number;
  offer:       number;
  stopLevel?:  number;
  limitLevel?: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtIGPrice(pts: number, type: string): string {
  if (type === 'FOREX') return pts.toFixed(1);
  if (type === 'CRYPTO') return pts.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (type.startsWith('SHARES')) return pts.toFixed(1);
  return pts.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function fmtSize(size: number): string {
  if (size < 0.1) return `£${size.toFixed(2)}/pt`;
  if (size < 1)   return `£${size.toFixed(2)}/pt`;
  return `£${size.toFixed(2)}/pt`;
}

function typeColor(type: string) {
  switch (type) {
    case 'INDEX':     return 'bg-blue-500/10 text-blue-400 border-blue-500/25';
    case 'FOREX':     return 'bg-purple-500/10 text-purple-400 border-purple-500/25';
    case 'COMMODITY': return 'bg-amber-500/10 text-amber-400 border-amber-500/25';
    case 'CRYPTO':    return 'bg-orange-500/10 text-orange-400 border-orange-500/25';
    case 'SHARES_UK': return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25';
    case 'SHARES_US': return 'bg-sky-500/10 text-sky-400 border-sky-500/25';
    default:          return 'bg-gray-500/10 text-gray-400 border-gray-500/25';
  }
}

function typeLabel(type: string) {
  return { INDEX: 'Index', FOREX: 'Forex', COMMODITY: 'Commodity', CRYPTO: 'Crypto', SHARES_UK: 'UK Share', SHARES_US: 'US Share' }[type] ?? type;
}

const FILTER_TABS = ['ALL', 'INDEX', 'FOREX', 'COMMODITY', 'CRYPTO', 'SHARES_UK', 'SHARES_US'] as const;

// ── Market Snapshot card ──────────────────────────────────────────────────────

function QuoteCard({ row }: { row: QuoteRow }) {
  const up = row.changePercent >= 0;
  const sigColor = row.signal === 'BUY' ? 'text-emerald-400' : row.signal === 'SELL' ? 'text-red-400' : 'text-gray-500';
  const SigIcon  = row.signal === 'BUY' ? TrendingUp : row.signal === 'SELL' ? TrendingDown : Minus;
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 hover:border-gray-700 transition-colors">
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="text-sm font-bold text-white">{row.market.name}</div>
          <span className={clsx('text-[10px] px-1.5 py-0.5 rounded border font-medium', typeColor(row.market.type))}>{typeLabel(row.market.type)}</span>
        </div>
        <SigIcon className={clsx('h-4 w-4 mt-0.5', sigColor)} />
      </div>
      <div className="font-mono font-bold text-white">{fmtIGPrice(row.igPrice, row.market.type)}</div>
      <div className={clsx('text-xs font-semibold mt-0.5', up ? 'text-emerald-400' : 'text-red-400')}>
        {up ? '+' : ''}{row.changePercent.toFixed(2)}%
      </div>
      <div className="text-[10px] text-gray-600 mt-1 font-mono truncate">{row.market.igEpic}</div>
    </div>
  );
}

// ── Trade Idea card ───────────────────────────────────────────────────────────

type IdeaSettings = { riskPerTrade: number; availableFunds: number; marginOverride: number | null };

function IdeaCard({ idea, settings }: { idea: TradeIdea; settings: IdeaSettings }) {
  const [expanded, setExpanded] = useState(false);
  const isBuy = idea.direction === 'BUY';
  const borderColor = isBuy ? 'border-emerald-600/30' : 'border-red-600/30';
  const accentColor = isBuy ? 'text-emerald-400' : 'text-red-400';
  const badgeBg     = isBuy ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400';

  // ── Live size calculation ──────────────────────────────────────────────────
  const { riskPerTrade, availableFunds, marginOverride } = settings;
  const effectiveMarginPct = marginOverride !== null ? marginOverride / 100 : idea.market.marginPct;
  const idealSize          = idea.stopDistance > 0 ? riskPerTrade / idea.stopDistance : idea.suggestedSize;
  const maxByFunds         = availableFunds > 0 && idea.igEntry > 0
    ? availableFunds / (idea.igEntry * effectiveMarginPct)
    : Infinity;
  const actualSize         = Math.max(0.01, Math.min(idealSize, maxByFunds));
  const actualMargin       = actualSize * idea.igEntry * effectiveMarginPct;
  const fundsCapped        = isFinite(maxByFunds) && maxByFunds < idealSize;
  const maxRisk            = actualSize * idea.stopDistance;
  // ──────────────────────────────────────────────────────────────────────────

  const pctSlippage = (idea.market.spread / idea.igEntry) * 100;

  return (
    <div className={clsx('bg-gray-900 border rounded-xl overflow-hidden transition-all', borderColor)}>
      {/* Header */}
      <button className="w-full text-left px-4 py-3" onClick={() => setExpanded(v => !v)}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-white">{idea.market.name}</span>
            <span className={clsx('text-xs font-bold px-2 py-0.5 rounded-full', badgeBg)}>{idea.direction}</span>
            <span className={clsx('text-[10px] px-1.5 py-0.5 rounded border font-medium', typeColor(idea.market.type))}>{typeLabel(idea.market.type)}</span>
            <span className="text-xs text-gray-500">Confidence <span className={clsx('font-semibold', accentColor)}>{idea.confidence}/10</span></span>
            <span className="text-xs text-gray-500">R:R <span className="text-white font-semibold">{idea.riskReward.toFixed(1)}:1</span></span>
          </div>
          {expanded ? <ChevronUp className="h-4 w-4 text-gray-500 shrink-0" /> : <ChevronDown className="h-4 w-4 text-gray-500 shrink-0" />}
        </div>
        <p className="text-xs text-gray-500 mt-1 line-clamp-1">{idea.analysis.summary}</p>
      </button>

      {/* Level summary — always visible */}
      <div className="px-4 pb-3 grid grid-cols-3 gap-3">
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-0.5">Entry (pts)</div>
          <div className={clsx('font-mono font-bold text-sm', accentColor)}>{fmtIGPrice(idea.igEntry, idea.market.type)}</div>
          <div className="text-[10px] text-gray-600">Spread ~{idea.market.spread} pts</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-0.5">Stop Loss</div>
          <div className="font-mono font-bold text-sm text-red-400">{fmtIGPrice(idea.igStopLoss, idea.market.type)}</div>
          <div className="text-[10px] text-gray-600">{idea.stopDistance.toFixed(1)} pts away</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-0.5">Target 1</div>
          <div className="font-mono font-bold text-sm text-emerald-400">{fmtIGPrice(idea.igTakeProfit1, idea.market.type)}</div>
          <div className="text-[10px] text-gray-600">{idea.tp1Distance.toFixed(1)} pts away</div>
        </div>
      </div>

      {/* Size + margin — always visible, live-computed from settings */}
      <div className="px-4 pb-3 border-t border-gray-800/60 pt-2 space-y-2">
        <div className="flex items-center gap-4 flex-wrap">
          <div>
            <span className="text-[10px] text-gray-500 uppercase tracking-wide mr-1">Size</span>
            <span className="text-sm font-bold text-white font-mono">{fmtSize(actualSize)}</span>
            {fundsCapped && (
              <span className="text-[10px] text-amber-400 ml-1">(ideal {fmtSize(idealSize)})</span>
            )}
          </div>
          <div>
            <span className="text-[10px] text-gray-500 uppercase tracking-wide mr-1">Margin ~</span>
            <span className="text-sm font-semibold text-amber-400">£{actualMargin.toFixed(0)}</span>
          </div>
          <div>
            <span className="text-[10px] text-gray-500 uppercase tracking-wide mr-1">Max loss</span>
            <span className="text-sm font-semibold text-red-400">£{maxRisk.toFixed(2)}</span>
          </div>
          <div>
            <span className="text-[10px] text-gray-500 uppercase tracking-wide mr-1">Slippage</span>
            <span className="text-[10px] text-gray-400">{pctSlippage.toFixed(3)}%</span>
          </div>
        </div>
        {fundsCapped && (
          <div className="flex items-start gap-1.5 bg-amber-950/30 border border-amber-700/30 rounded-lg px-3 py-2 text-xs text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>Size scaled down from {fmtSize(idealSize)} to {fmtSize(actualSize)} — insufficient funds for full margin. Add more capital or reduce margin rate.</span>
          </div>
        )}
      </div>

      {/* Expanded: full detail */}
      {expanded && (
        <div className="border-t border-gray-800 px-4 py-4 space-y-4">
          {/* Full levels grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: 'Entry Level',    val: fmtIGPrice(idea.igEntry,       idea.market.type), sub: 'Place limit order here',      col: accentColor },
              { label: 'Stop Loss',      val: fmtIGPrice(idea.igStopLoss,    idea.market.type), sub: `${idea.stopDistance.toFixed(1)} pts · max risk £${(idea.stopDistance * actualSize).toFixed(2)}`, col: 'text-red-400' },
              { label: 'Target 1',       val: fmtIGPrice(idea.igTakeProfit1, idea.market.type), sub: `${idea.tp1Distance.toFixed(1)} pts — take ½ position`, col: 'text-emerald-400' },
              { label: 'Target 2',       val: fmtIGPrice(idea.igTakeProfit2, idea.market.type), sub: 'Trail stop for remainder',     col: 'text-emerald-300' },
            ].map(({ label, val, sub, col }) => (
              <div key={label} className="bg-gray-800/50 rounded-lg p-3">
                <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">{label}</div>
                <div className={clsx('font-mono font-bold text-base', col)}>{val}</div>
                <div className="text-[10px] text-gray-600 mt-0.5">{sub}</div>
              </div>
            ))}
          </div>

          {/* How-to trade box */}
          <div className="bg-gray-800/40 border border-gray-700/50 rounded-lg p-3 space-y-1.5 text-xs">
            <div className="font-semibold text-gray-300 mb-2">How to place this trade on IG</div>
            <div className="text-gray-400">1. Search <span className="font-mono text-white">{idea.market.igEpic}</span> on IG or search &quot;{idea.market.name}&quot;</div>
            <div className="text-gray-400">2. Choose <span className={clsx('font-semibold', accentColor)}>{idea.direction}</span> · set order type: <span className="text-white">Limit</span> at <span className="font-mono text-white">{fmtIGPrice(idea.igEntry, idea.market.type)}</span></div>
            <div className="text-gray-400">3. Size: <span className="text-white font-semibold">{fmtSize(actualSize)}</span> · Stop: <span className="text-red-400 font-mono">{fmtIGPrice(idea.igStopLoss, idea.market.type)}</span> · Limit: <span className="text-emerald-400 font-mono">{fmtIGPrice(idea.igTakeProfit1, idea.market.type)}</span></div>
            <div className="text-gray-400">4. Estimated margin required: <span className="text-amber-400 font-semibold">£{actualMargin.toFixed(0)}</span> · Max loss: <span className="text-red-400 font-semibold">£{maxRisk.toFixed(2)}</span></div>
          </div>

          {/* Key levels */}
          {idea.analysis.keyLevels.length > 0 && (
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-2">Key Support / Resistance (Yahoo price)</div>
              <div className="flex flex-wrap gap-1.5">
                {idea.analysis.keyLevels.map((lvl, i) => (
                  <span key={i} className={clsx('text-xs px-2 py-0.5 rounded border font-mono',
                    lvl.type === 'support' ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400' : 'bg-red-500/10 border-red-500/25 text-red-400'
                  )}>
                    {lvl.label}: {lvl.price}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Analysis summary */}
          <div>
            <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">Analysis</div>
            <p className="text-xs text-gray-400 leading-relaxed">{idea.analysis.summary}</p>
          </div>

          {/* Invalidation */}
          <div className="bg-red-950/20 border border-red-900/30 rounded-lg px-3 py-2">
            <div className="text-[10px] text-red-500 uppercase tracking-wide mb-0.5">Invalidation</div>
            <p className="text-xs text-red-400">{idea.setupUsed === 'swing' ? idea.analysis.swing.invalidation : idea.analysis.scalp.invalidation}</p>
          </div>

          <p className="text-[10px] text-gray-600">Rule-based analysis — not financial advice. Verify before trading. Spread betting involves significant risk of loss.</p>
        </div>
      )}
    </div>
  );
}

// ── Live positions ────────────────────────────────────────────────────────────

function LivePositions() {
  const [positions, setPositions]     = useState<IGLivePosition[]>([]);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');
  const [connectedEnv, setConnectedEnv] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      for (const env of ['demo', 'live'] as const) {
        try {
          const sessRaw = localStorage.getItem(`ig_session_${env}`);
          if (!sessRaw) continue;
          const sess = JSON.parse(sessRaw) as { cst: string; securityToken: string; apiKey: string; authenticatedAt: number };
          if (!sess.cst || Date.now() - sess.authenticatedAt > 5 * 3_600_000) continue;

          const r = await fetch('/api/ig/positions', {
            headers: {
              'x-ig-cst': sess.cst, 'x-ig-security-token': sess.securityToken,
              'x-ig-api-key': sess.apiKey, 'x-ig-env': env,
            },
          });
          const d = await r.json() as { ok: boolean; positions?: IGLivePosition[]; error?: string };
          if (d.ok) {
            setPositions(d.positions ?? []);
            setConnectedEnv(env);
            break;
          }
        } catch { /* try next env */ }
      }
      setLoading(false);
    })();
  }, []);

  if (loading) return (
    <div className="flex items-center gap-2 text-gray-500 text-sm py-4">
      <RefreshCw className="h-4 w-4 animate-spin" /> Loading live IG positions…
    </div>
  );

  if (!connectedEnv) return (
    <div className="text-sm text-gray-600 py-4">No active IG session found — connect in Settings → Accounts to see live positions here.</div>
  );

  if (!positions.length) return (
    <div className="text-sm text-gray-600 py-4">No open positions on {connectedEnv.toUpperCase()} account.</div>
  );

  return (
    <div className="space-y-2">
      <div className="text-xs text-gray-500 mb-3">Showing {positions.length} position(s) from <span className="text-white font-semibold">{connectedEnv.toUpperCase()}</span></div>
      {positions.map(pos => {
        const isProfit = pos.upl >= 0;
        const targetRange = pos.limitLevel ? Math.abs(pos.limitLevel - pos.level) : 0;
        const pctToTarget = targetRange > 0 ? Math.min(100, (pos.upl / (targetRange * pos.size)) * 100) : 0;
        return (
          <div key={pos.dealId} className={clsx('bg-gray-900 border rounded-xl p-4', isProfit ? 'border-emerald-600/30' : 'border-red-600/20')}>
            <div className="flex items-start justify-between mb-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-bold text-white">{pos.instrumentName}</span>
                  <span className={clsx('text-xs font-bold px-1.5 py-0.5 rounded-full', pos.direction === 'BUY' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400')}>{pos.direction}</span>
                  <span className="text-xs text-gray-500 font-mono">{pos.epic}</span>
                </div>
                <div className="text-xs text-gray-500 mt-0.5">Size: £{pos.size}/pt · Entry: {pos.level.toFixed(2)}</div>
              </div>
              <div className="text-right">
                <div className={clsx('font-bold text-lg', isProfit ? 'text-emerald-400' : 'text-red-400')}>
                  {isProfit ? '+' : ''}£{pos.upl.toFixed(2)}
                </div>
                <div className="text-xs text-gray-500">Unrealised P&L</div>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3 text-xs">
              <div><div className="text-gray-500">Current Bid</div><div className="font-mono text-white">{pos.bid.toFixed(2)}</div></div>
              <div><div className="text-gray-500">Stop Loss</div><div className="font-mono text-red-400">{pos.stopLevel?.toFixed(2) ?? '—'}</div></div>
              <div><div className="text-gray-500">Limit (TP)</div><div className="font-mono text-emerald-400">{pos.limitLevel?.toFixed(2) ?? '—'}</div></div>
            </div>
            {targetRange > 0 && (
              <div className="mt-3">
                <div className="flex justify-between text-[10px] text-gray-500 mb-1">
                  <span>Progress to target</span>
                  <span>{pctToTarget.toFixed(0)}%</span>
                </div>
                <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                  <div className={clsx('h-full rounded-full transition-all', isProfit ? 'bg-emerald-500' : 'bg-red-500')} style={{ width: `${Math.max(0, pctToTarget)}%` }} />
                </div>
              </div>
            )}
          </div>
        );
      })}
      {error && <div className="text-xs text-red-400">{error}</div>}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function DailyBrief() {
  const [quotes,       setQuotes]       = useState<QuoteRow[]>([]);
  const [tradeIdeas,   setTradeIdeas]   = useState<TradeIdea[]>([]);
  const [loading,      setLoading]      = useState(false);
  const [progress,     setProgress]     = useState('');
  const [error,        setError]        = useState('');
  const [lastRefresh,  setLastRefresh]  = useState<Date | null>(null);
  const [riskPerTrade,    setRiskPerTrade]    = useState(100);
  const [availableFunds,  setAvailableFunds]  = useState(0);
  const [marginOverride,  setMarginOverride]  = useState('');
  const [filter,          setFilter]          = useState<string>('ALL');
  const [minConf,         setMinConf]         = useState(5);
  const [timeframe,       setTimeframe]       = useState<Timeframe>('daily');
  const [rawAnalyses,     setRawAnalyses]     = useState<RawAnalysis[]>([]);

  const ideaSettings: IdeaSettings = {
    riskPerTrade,
    availableFunds,
    marginOverride: marginOverride !== '' ? parseFloat(marginOverride) : null,
  };

  useEffect(() => {
    setTradeIdeas(buildIdeas(rawAnalyses, timeframe, riskPerTrade, minConf));
  }, [rawAnalyses, timeframe, riskPerTrade, minConf]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    setProgress('Fetching market quotes…');
    setQuotes([]);
    setTradeIdeas([]);

    try {
      // 1. Batch quote fetch
      const symbols = UNIQUE_MARKETS.map(m => m.yahooSymbol).join(',');
      const qRes = await fetch(`/api/market/quotes?symbols=${encodeURIComponent(symbols)}`);
      if (!qRes.ok) throw new Error(`Quotes API error ${qRes.status}`);
      const rawQuotes = await qRes.json() as Array<{ symbol: string; price: number; changePercent: number }>;

      const quoteMap = new Map(rawQuotes.map(q => [q.symbol, q]));

      // Build snapshot rows
      const rows: QuoteRow[] = [];
      for (const mkt of UNIQUE_MARKETS) {
        const q = quoteMap.get(mkt.yahooSymbol);
        if (!q || !q.price) continue;
        const igPrice = q.price * mkt.priceFactor;
        const signal: 'BUY' | 'SELL' | 'NEUTRAL' =
          q.changePercent > 0.3 ? 'BUY' : q.changePercent < -0.3 ? 'SELL' : 'NEUTRAL';
        rows.push({ market: mkt, price: q.price, igPrice, changePercent: q.changePercent, signal });
      }
      setQuotes(rows);

      // 2. Fetch candle history + run analysis for each market
      const raws: RawAnalysis[] = [];
      let done = 0;

      for (const row of rows) {
        setProgress(`Analysing ${row.market.name}… (${++done}/${rows.length})`);
        try {
          const hRes = await fetch(`/api/chart/history?symbol=${encodeURIComponent(row.market.yahooSymbol)}&resolution=3M`);
          if (!hRes.ok) continue;
          const hData = await hRes.json() as { candles?: LWCandle[] };
          const candles = hData.candles ?? [];
          if (candles.length < 20) continue;
          const analysis = ruleBasedAnalysis(row.market.yahooSymbol, candles);
          if (analysis.bias === 'NEUTRAL') continue;
          if (analysis.scalp.direction === 'FLAT' && analysis.swing.direction === 'FLAT') continue;
          raws.push({ market: row.market, row, analysis });
        } catch { /* skip market */ }
        await new Promise(r => setTimeout(r, 150));
      }

      setRawAnalyses(raws);
      setLastRefresh(new Date());
      setProgress('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load data');
      setProgress('');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, []); // eslint-disable-line

  const filteredQuotes = filter === 'ALL' ? quotes : quotes.filter(r => r.market.type === filter);
  const filteredIdeas  = filter === 'ALL' ? tradeIdeas : tradeIdeas.filter(i => i.market.type === filter);

  const buyIdeas  = filteredIdeas.filter(i => i.direction === 'BUY');
  const sellIdeas = filteredIdeas.filter(i => i.direction === 'SELL');

  return (
    <div className="space-y-6">

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5">
            <span className="text-xs text-gray-500">Risk/trade</span>
            <span className="text-white font-semibold">£</span>
            <input
              type="number" min={10} max={10000} step={10}
              value={riskPerTrade}
              onChange={e => setRiskPerTrade(Number(e.target.value))}
              className="w-16 bg-transparent text-white text-sm font-mono focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-2 bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5">
            <span className="text-xs text-gray-500">Min confidence</span>
            <input
              type="number" min={1} max={10} step={1}
              value={minConf}
              onChange={e => setMinConf(Number(e.target.value))}
              className="w-8 bg-transparent text-white text-sm font-mono focus:outline-none"
            />
            <span className="text-xs text-gray-500">/10</span>
          </div>
          <div className="flex items-center gap-2 bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5">
            <span className="text-xs text-gray-500">Timeframe</span>
            <select
              value={timeframe}
              onChange={e => setTimeframe(e.target.value as Timeframe)}
              className="bg-transparent text-white text-xs font-medium focus:outline-none cursor-pointer"
            >
              {(Object.keys(TIMEFRAME_CONFIG) as Timeframe[]).map(tf => (
                <option key={tf} value={tf} className="bg-gray-900 text-white">{TIMEFRAME_CONFIG[tf].label}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2 bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5">
            <span className="text-xs text-gray-500">Available funds</span>
            <span className="text-white font-semibold">£</span>
            <input
              type="number" min={0} step={50}
              value={availableFunds || ''}
              placeholder="0"
              onChange={e => setAvailableFunds(Number(e.target.value))}
              className="w-20 bg-transparent text-white text-sm font-mono focus:outline-none placeholder-gray-600"
            />
          </div>
          <div className="flex items-center gap-2 bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5">
            <span className="text-xs text-gray-500">Margin %</span>
            <input
              type="number" min={0} max={100} step={0.5}
              value={marginOverride}
              placeholder="auto"
              onChange={e => setMarginOverride(e.target.value)}
              className="w-14 bg-transparent text-white text-sm font-mono focus:outline-none placeholder-gray-600"
            />
            {marginOverride === '' && <span className="text-[10px] text-gray-600">per market</span>}
          </div>
          {lastRefresh && (
            <span className="text-xs text-gray-600">Updated {lastRefresh.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
          )}
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm font-semibold text-white transition-all"
        >
          <RefreshCw className={clsx('h-4 w-4', loading && 'animate-spin')} />
          {loading ? 'Scanning…' : 'Refresh'}
        </button>
      </div>

      {/* Progress */}
      {loading && progress && (
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Zap className="h-4 w-4 text-emerald-400 animate-pulse" />
          {progress}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 bg-red-950/20 border border-red-900/40 rounded-xl px-4 py-3">
          <AlertCircle className="h-4 w-4 text-red-400 shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Filter tabs */}
      {quotes.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {FILTER_TABS.map(tab => (
            <button key={tab}
              onClick={() => setFilter(tab)}
              className={clsx('px-3 py-1 rounded-lg text-xs font-semibold border transition-all',
                filter === tab ? 'bg-emerald-600/20 text-emerald-400 border-emerald-600/40' : 'text-gray-500 border-gray-700 hover:border-gray-600'
              )}
            >
              {tab === 'ALL' ? 'All' : typeLabel(tab)}
              {tab !== 'ALL' && (
                <span className="ml-1 text-gray-600">
                  ({quotes.filter(r => r.market.type === tab).length})
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Market snapshot */}
      {filteredQuotes.length > 0 && (
        <section>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Market Snapshot</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 gap-2">
            {filteredQuotes.map(row => <QuoteCard key={row.market.yahooSymbol} row={row} />)}
          </div>
        </section>
      )}

      {/* Trade ideas */}
      {(buyIdeas.length > 0 || sellIdeas.length > 0) && (
        <section className="space-y-6">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Trade Ideas — {filteredIdeas.length} setup{filteredIdeas.length !== 1 ? 's' : ''} · {TIMEFRAME_CONFIG[timeframe].label} · £{riskPerTrade} risk/trade{availableFunds > 0 ? ` · £${availableFunds} funds` : ''}
          </h2>

          {buyIdeas.length > 0 && (
            <div>
              <h3 className="text-xs text-emerald-500 font-semibold uppercase tracking-wide mb-2 flex items-center gap-1.5">
                <TrendingUp className="h-3.5 w-3.5" /> BUY setups ({buyIdeas.length})
              </h3>
              <div className="space-y-2">
                {buyIdeas.map(i => <IdeaCard key={i.market.yahooSymbol + i.direction} idea={i} settings={ideaSettings} />)}
              </div>
            </div>
          )}

          {sellIdeas.length > 0 && (
            <div>
              <h3 className="text-xs text-red-500 font-semibold uppercase tracking-wide mb-2 flex items-center gap-1.5">
                <TrendingDown className="h-3.5 w-3.5" /> SELL setups ({sellIdeas.length})
              </h3>
              <div className="space-y-2">
                {sellIdeas.map(i => <IdeaCard key={i.market.yahooSymbol + i.direction} idea={i} settings={ideaSettings} />)}
              </div>
            </div>
          )}
        </section>
      )}

      {!loading && !error && quotes.length > 0 && filteredIdeas.length === 0 && (
        <div className="text-center py-8 text-gray-500 text-sm">
          No setups meet the confidence threshold ({minConf}/10) right now. Lower the threshold or check back later.
        </div>
      )}

      {/* Live IG positions */}
      <section>
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Live IG Positions</h2>
        <LivePositions />
      </section>
    </div>
  );
}

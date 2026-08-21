// ── T212 CFD Ideas — on-demand, read-only trade recommendations ────────────
// Trading212's CFD account has no API access at all (confirmed by the user
// directly) — there is nothing to execute against, and nothing to connect
// to. This exists purely to hand back a list the user reads and manually
// opens themselves in the real T212 CFD app. No position tracking, no
// execution, no persistence — every call is a fresh scan.
//
// Reuses the exact same proven rules engine already backtest-confirmed and
// live-tuned all session for the IG stock strategy (ruleBasedAnalysis — real
// RSI/MACD/SMA/BB/volume scoring, real ATR-based stop/TP levels), run
// directly against real Alpaca $ prices with no IG-specific point scaling
// applied at any stage, since T212 CFD prices (like IG's underlying
// reference price) are just the real market price, not IG's spread-bet
// points system. That's the whole reason this is a separate module rather
// than just relabelling igStrategyBot.ts's own recommendations: those are
// computed for IG's own scaled epic pricing and would need an error-prone
// manual conversion to be usable for a T212 CFD order.
//
// Deliberately does NOT call Gemini (unlike gemini_confirmed on IG) — per
// explicit decision: this only ever produces a read-only reference the user
// reviews themselves before manually placing anything, so the user IS the
// confirmation layer. Spending Gemini calls (shared allowance with the live
// IG/FX bots) for a second AI opinion the user reviews anyway wasn't worth
// the cost. Headlines are still fetched and returned, but purely as
// informational context alongside the numbers — not fed to any model.
//
// Universe: the US-listed half of lib/stockUniverse.ts's UNIVERSE (the same
// list the T212 demo-trader/position-review features use) — kept as an
// explicit copy here since bot-server can't import from the Next.js app's
// lib/ directory. UK names are excluded for now: they'd need the same
// dynamic Yahoo-to-live-quote rescaling igStrategyBot.ts uses for
// usesYahooScaled epics, which only exists there because it has an IG live
// quote to rescale against — there's no equivalent reference price
// available here, so real UK $ price levels can't be produced right now.
import { getBars } from './alpacaApi';
import { MIN_SWING_CONFIDENCE, MIN_DAILY_EFFICIENCY_RATIO, calcEfficiencyRatio } from './alpacaStrategies';
import { ruleBasedAnalysis } from './ruleBasedAnalysis';
import { fetchAllHeadlines } from './newsFetch';
import { RULE_BASED_ANALYSIS_CONFIRMED_EPICS } from './igStrategyScanner';
import { EPIC_TO_ALPACA } from './yahooFetch';

// Ticker -> epic, so a CFD idea can be checked against the same
// backtest-confirmed universe the live IG bot restricts rule_based_analysis
// to. Confirmed live this gap mattered: this panel surfaced a 9/10-
// confidence Costco SHORT despite Costco already backtesting as a clear
// loser under this exact engine (-12.22% return, PF 0.26) — this panel had
// no equivalent restriction, unlike the IG bot. A symbol with no IG epic
// mapping at all (never backtested there either) is excluded too, same
// reasoning: "never verified" isn't a reason to trust it more than "verified
// and failed."
const ALPACA_TO_EPIC: Record<string, string> = Object.fromEntries(
  Object.entries(EPIC_TO_ALPACA).map(([epic, ticker]) => [ticker, epic]),
);

const CFD_IDEAS_UNIVERSE: Array<{ symbol: string; name: string; sector: string }> = [
  { symbol: 'AAPL',  name: 'Apple Inc.',                sector: 'Technology' },
  { symbol: 'MSFT',  name: 'Microsoft Corp.',            sector: 'Technology' },
  { symbol: 'NVDA',  name: 'Nvidia Corp.',               sector: 'Technology' },
  { symbol: 'AMD',   name: 'Advanced Micro Devices',     sector: 'Technology' },
  { symbol: 'META',  name: 'Meta Platforms',             sector: 'Technology' },
  { symbol: 'GOOGL', name: 'Alphabet Inc.',              sector: 'Technology' },
  { symbol: 'TSLA',  name: 'Tesla Inc.',                 sector: 'Technology' },
  { symbol: 'INTC',  name: 'Intel Corp.',                sector: 'Technology' },
  { symbol: 'QCOM',  name: 'Qualcomm Inc.',              sector: 'Technology' },
  { symbol: 'AVGO',  name: 'Broadcom Inc.',              sector: 'Technology' },
  { symbol: 'MU',    name: 'Micron Technology',          sector: 'Technology' },
  { symbol: 'AMAT',  name: 'Applied Materials',          sector: 'Technology' },
  { symbol: 'PLTR',  name: 'Palantir Technologies',      sector: 'Technology' },
  { symbol: 'SNOW',  name: 'Snowflake Inc.',             sector: 'Technology' },
  { symbol: 'CRM',   name: 'Salesforce Inc.',            sector: 'Technology' },
  { symbol: 'ORCL',  name: 'Oracle Corp.',               sector: 'Technology' },
  { symbol: 'ADBE',  name: 'Adobe Inc.',                 sector: 'Technology' },
  { symbol: 'UBER',  name: 'Uber Technologies',          sector: 'Technology' },
  { symbol: 'COIN',  name: 'Coinbase Global',            sector: 'Technology' },
  { symbol: 'RBLX',  name: 'Roblox Corp.',               sector: 'Technology' },
  { symbol: 'SHOP',  name: 'Shopify Inc.',               sector: 'Technology' },
  { symbol: 'NFLX',  name: 'Netflix Inc.',               sector: 'Technology' },
  { symbol: 'ASML',  name: 'ASML Holding',               sector: 'Technology' },
  { symbol: 'ON',    name: 'ON Semiconductor',           sector: 'Technology' },
  { symbol: 'TSM',   name: 'Taiwan Semiconductor',       sector: 'Technology' },
  { symbol: 'MRVL',  name: 'Marvell Technology',         sector: 'Technology' },
  { symbol: 'NOK',   name: 'Nokia Corp.',                sector: 'Technology' },
  { symbol: 'WDC',   name: 'Western Digital',            sector: 'Technology' },
  { symbol: 'SNDK',  name: 'SanDisk Corp.',              sector: 'Technology' },
  { symbol: 'DELL',  name: 'Dell Technologies',          sector: 'Technology' },
  { symbol: 'STX',   name: 'Seagate Technology',         sector: 'Technology' },
  { symbol: 'LLY',   name: 'Eli Lilly',                  sector: 'Healthcare' },
  { symbol: 'UNH',   name: 'UnitedHealth Group',         sector: 'Healthcare' },
  { symbol: 'ABBV',  name: 'AbbVie Inc.',                sector: 'Healthcare' },
  { symbol: 'MRK',   name: 'Merck & Co.',                sector: 'Healthcare' },
  { symbol: 'PFE',   name: 'Pfizer Inc.',                sector: 'Healthcare' },
  { symbol: 'AMGN',  name: 'Amgen Inc.',                 sector: 'Healthcare' },
  { symbol: 'GILD',  name: 'Gilead Sciences',            sector: 'Healthcare' },
  { symbol: 'REGN',  name: 'Regeneron Pharma',           sector: 'Healthcare' },
  { symbol: 'VRTX',  name: 'Vertex Pharmaceuticals',     sector: 'Healthcare' },
  { symbol: 'MRNA',  name: 'Moderna Inc.',               sector: 'Healthcare' },
  { symbol: 'BIIB',  name: 'Biogen Inc.',                sector: 'Healthcare' },
  { symbol: 'JNJ',   name: 'Johnson & Johnson',          sector: 'Healthcare' },
  { symbol: 'XOM',   name: 'ExxonMobil Corp.',           sector: 'Energy' },
  { symbol: 'CVX',   name: 'Chevron Corp.',              sector: 'Energy' },
  { symbol: 'COP',   name: 'ConocoPhillips',             sector: 'Energy' },
  { symbol: 'SLB',   name: 'SLB',                        sector: 'Energy' },
  { symbol: 'OXY',   name: 'Occidental Petroleum',       sector: 'Energy' },
  { symbol: 'VLO',   name: 'Valero Energy',              sector: 'Energy' },
  { symbol: 'EOG',   name: 'EOG Resources',              sector: 'Energy' },
  { symbol: 'MPC',   name: 'Marathon Petroleum',         sector: 'Energy' },
  { symbol: 'JPM',   name: 'JPMorgan Chase',             sector: 'Finance' },
  { symbol: 'BAC',   name: 'Bank of America',            sector: 'Finance' },
  { symbol: 'V',     name: 'Visa Inc.',                  sector: 'Finance' },
  { symbol: 'MA',    name: 'Mastercard',                 sector: 'Finance' },
  { symbol: 'GS',    name: 'Goldman Sachs',              sector: 'Finance' },
  { symbol: 'MS',    name: 'Morgan Stanley',             sector: 'Finance' },
  { symbol: 'WFC',   name: 'Wells Fargo',                sector: 'Finance' },
  { symbol: 'AXP',   name: 'American Express',           sector: 'Finance' },
  { symbol: 'PYPL',  name: 'PayPal Holdings',            sector: 'Finance' },
  { symbol: 'HOOD',  name: 'Robinhood Markets',          sector: 'Finance' },
  { symbol: 'WMT',   name: 'Walmart Inc.',               sector: 'Consumer' },
  { symbol: 'COST',  name: 'Costco Wholesale',           sector: 'Consumer' },
  { symbol: 'MCD',   name: "McDonald's Corp.",           sector: 'Consumer' },
  { symbol: 'NKE',   name: 'Nike Inc.',                  sector: 'Consumer' },
  { symbol: 'KO',    name: 'Coca-Cola Co.',              sector: 'Consumer' },
  { symbol: 'PEP',   name: 'PepsiCo Inc.',               sector: 'Consumer' },
  { symbol: 'AMZN',  name: 'Amazon.com Inc.',            sector: 'Consumer' },
  { symbol: 'HD',    name: 'Home Depot Inc.',            sector: 'Consumer' },
  { symbol: 'TGT',   name: 'Target Corp.',               sector: 'Consumer' },
  { symbol: 'SBUX',  name: 'Starbucks Corp.',            sector: 'Consumer' },
  { symbol: 'BA',    name: 'Boeing Co.',                 sector: 'Industrials' },
  { symbol: 'CAT',   name: 'Caterpillar Inc.',           sector: 'Industrials' },
  { symbol: 'HON',   name: 'Honeywell International',    sector: 'Industrials' },
  { symbol: 'DIS',   name: 'Walt Disney Co.',            sector: 'Communication' },
  { symbol: 'T',     name: 'AT&T Inc.',                  sector: 'Communication' },
  { symbol: 'NEE',   name: 'NextEra Energy',             sector: 'Utilities' },
];

export type CfdIdea = {
  symbol:      string;
  name:        string;
  sector:      string;
  direction:   'LONG' | 'SHORT';
  price:       number;   // real $ — same units you'd see quoted for the CFD
  stopLoss:    number;
  takeProfit:  number;
  ruleConfidence: number; // 1-10, the rule engine's own conviction — the only score here, no AI involved
  reason:      string;
  headlines:   string[]; // plain informational context — not fed to any model, just shown alongside the numbers
  computedAt:  string;
  // Whether this exact symbol has already been walk-forward backtested
  // under this exact rules engine and come back genuinely profitable (see
  // RULE_BASED_ANALYSIS_CONFIRMED_EPICS) — most of this universe never has
  // been (different, separately-built list), so false means "untested,"
  // not "proven bad." Per explicit decision: flagged rather than filtered
  // out, since excluding everything untested would have cut this universe
  // from 77 names to 10 — shown so the user can weight it themselves
  // instead of the panel silently deciding for them.
  backtestConfirmed: boolean;
};

// Sequential with a short stagger — mirrors the same rate-limit courtesy
// every other Alpaca-fetching loop in this codebase already uses (e.g.
// yahooFetch.ts's per-epic prewarm, demo-trader's signals route).
const FETCH_DELAY_MS = 120;

export async function scanCfdIdeas(
  onProgress?: (msg: string) => void,
): Promise<CfdIdea[]> {
  const ideas: CfdIdea[] = [];

  for (const stock of CFD_IDEAS_UNIVERSE) {
    try {
      const epic = ALPACA_TO_EPIC[stock.symbol];
      const backtestConfirmed = !!epic && RULE_BASED_ANALYSIS_CONFIRMED_EPICS.has(epic);

      const barsBySymbol = await getBars([stock.symbol], '1Day', 250, 'paper');
      const bars = barsBySymbol[stock.symbol];
      if (!bars || bars.length < 60) continue;

      const candles = bars.map(b => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
      const analysis = ruleBasedAnalysis(stock.symbol, candles);
      const swing = analysis.swing;

      // Same bars rule_based_analysis/gemini_confirmed require on IG, no AI
      // layer on top of it here.
      if (swing.direction === 'FLAT' || swing.confidence < MIN_SWING_CONFIDENCE) continue;

      // Same chop gate the IG bot now has — a stock that's moved a lot but
      // gone nowhere over the last month can still fire a clean-looking
      // RSI/MACD/BB signal.
      const efficiencyRatio = calcEfficiencyRatio(bars, 20);
      if (efficiencyRatio !== null && efficiencyRatio < MIN_DAILY_EFFICIENCY_RATIO) {
        onProgress?.(`${stock.symbol}: skipped — too choppy over the last month (efficiency ratio ${efficiencyRatio.toFixed(2)} < ${MIN_DAILY_EFFICIENCY_RATIO})`);
        continue;
      }

      const last = bars[bars.length - 1].c;
      const headlines = await fetchAllHeadlines(stock.symbol, 8, stock.name);

      onProgress?.(`${stock.symbol}: rules ${swing.direction} ${swing.confidence}/10 — qualified${backtestConfirmed ? ' (backtest-confirmed)' : ' (not yet backtested)'}`);

      ideas.push({
        symbol:         stock.symbol,
        name:           stock.name,
        sector:         stock.sector,
        direction:      swing.direction === 'LONG' ? 'LONG' : 'SHORT',
        price:          last,
        stopLoss:       swing.stopLoss,
        takeProfit:     swing.takeProfit1,
        ruleConfidence: swing.confidence,
        reason:         swing.reasoning,
        headlines,
        computedAt:     new Date().toISOString(),
        backtestConfirmed,
      });
    } catch (e) {
      onProgress?.(`${stock.symbol}: skipped — ${e instanceof Error ? e.message : String(e)}`);
    }
    await new Promise(r => setTimeout(r, FETCH_DELAY_MS));
  }

  return ideas.sort((a, b) => b.ruleConfidence - a.ruleConfidence);
}

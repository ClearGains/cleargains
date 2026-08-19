// ── T212 CFD Ideas — on-demand, read-only trade recommendations ────────────
// Trading212's CFD account has no API access at all (confirmed by the user
// directly) — there is nothing to execute against, and nothing to connect
// to. This exists purely to hand back a list the user reads and manually
// opens themselves in the real T212 CFD app. No position tracking, no
// execution, no persistence — every call is a fresh scan.
//
// Reuses the exact same proven engine already backtest-confirmed and
// live-tuned all session for the IG stock strategy (ruleBasedAnalysis +
// askGeminiConfirmStockTrade, the same two-layer "rules qualify, Gemini
// confirms" structure as the gemini_confirmed IG strategy) — but run
// directly against real Alpaca $ prices with no IG-specific point scaling
// applied at any stage, since T212 CFD prices (like IG's underlying
// reference price) are just the real market price, not IG's spread-bet
// points system. That's the whole reason this is a separate module rather
// than just relabelling igStrategyBot.ts's own recommendations: those are
// computed for IG's own scaled epic pricing and would need an error-prone
// manual conversion to be usable for a T212 CFD order.
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
import { calcRsi, calcMacdHist, MIN_SWING_CONFIDENCE } from './alpacaStrategies';
import { ruleBasedAnalysis } from './ruleBasedAnalysis';
import { fetchAllHeadlines } from './newsFetch';
import { askGeminiConfirmStockTrade } from './gemini';

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
  confidence:  number;   // Gemini's own 0-100 confirmation confidence
  ruleConfidence: number; // 1-10, the underlying rule engine's own conviction
  reason:      string;
  computedAt:  string;
};

const CONFIRM_MIN_CONFIDENCE = 70; // same floor gemini_confirmed/gemini_opinion require on IG

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
      const barsBySymbol = await getBars([stock.symbol], '1Day', 250, 'paper');
      const bars = barsBySymbol[stock.symbol];
      if (!bars || bars.length < 60) continue;

      const candles = bars.map(b => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
      const analysis = ruleBasedAnalysis(stock.symbol, candles);
      const swing = analysis.swing;

      // Zero-cost mechanical gate before any Gemini spend — same bar
      // rule_based_analysis/gemini_confirmed require on IG.
      if (swing.direction === 'FLAT' || swing.confidence < MIN_SWING_CONFIDENCE) continue;

      const last = bars[bars.length - 1].c;
      const rsi  = calcRsi(bars, 14);
      const macd = calcMacdHist(bars, 12, 26, 9);
      const headlines = await fetchAllHeadlines(stock.symbol, 8, stock.name);

      const today = new Date().toISOString().slice(0, 10);
      const todaysBars = bars.filter(b => b.t.slice(0, 10) === today);
      const dayOpen = todaysBars[0]?.o ?? bars[0]?.o;
      const dayChangePercent = dayOpen ? ((last - dayOpen) / dayOpen) * 100 : undefined;

      const recent5 = bars.slice(-5);
      const prior20 = bars.slice(-25, -5);
      const avgRecent = recent5.reduce((s, b) => s + b.v, 0) / Math.max(recent5.length, 1);
      const avgPrior  = prior20.reduce((s, b) => s + b.v, 0) / Math.max(prior20.length, 1);
      const volumeSurgeMultiple = prior20.length >= 10 && avgPrior > 0 ? avgRecent / avgPrior : undefined;

      onProgress?.(`${stock.symbol}: rules ${swing.direction} ${swing.confidence}/10 — asking Gemini to confirm…`);

      const verdict = await askGeminiConfirmStockTrade({
        instrumentName: stock.name,
        suggestedDir:   swing.direction === 'LONG' ? 'BUY' : 'SELL',
        ruleReasoning:  swing.reasoning,
        ruleConfidence: swing.confidence,
        price:          last,
        rsi,
        macdHist:       macd?.hist ?? null,
        lastCandles:    candles.slice(-8).map(c => ({ open: c.open, high: c.high, low: c.low, close: c.close })),
        headlines,
        dayChangePercent,
        volumeSurgeMultiple,
        // No peer-group context here — getPeerGroupChange is keyed off IG
        // epics/SECTOR_MAP, populated by the live IG bot's own poll cycle,
        // and this scan has no IG epic to look up. Everything else Gemini
        // needs (technicals, news, volume, day change) is still supplied.
      });

      if (verdict.direction === 'SKIP' || verdict.confidence < CONFIRM_MIN_CONFIDENCE) continue;

      ideas.push({
        symbol:         stock.symbol,
        name:           stock.name,
        sector:         stock.sector,
        direction:      swing.direction === 'LONG' ? 'LONG' : 'SHORT',
        price:          last,
        stopLoss:       swing.stopLoss,
        takeProfit:     swing.takeProfit1,
        confidence:     verdict.confidence,
        ruleConfidence: swing.confidence,
        reason:         `Rules (${swing.confidence}/10): ${swing.reasoning} | Gemini confirmed ${verdict.confidence}%: ${verdict.reason}`,
        computedAt:     new Date().toISOString(),
      });
    } catch (e) {
      onProgress?.(`${stock.symbol}: skipped — ${e instanceof Error ? e.message : String(e)}`);
    }
    await new Promise(r => setTimeout(r, FETCH_DELAY_MS));
  }

  return ideas.sort((a, b) => b.confidence - a.confidence);
}

'use client';

import { useState } from 'react';
import { BookOpen, ChevronDown, ChevronRight, ExternalLink, AlertTriangle, CheckCircle2, TrendingUp, Shield } from 'lucide-react';
import { clsx } from 'clsx';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type Section = {
  id: string;
  title: string;
  emoji: string;
  content: React.ReactNode;
};

function Accordion({ title, emoji, children }: { title: string; emoji: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-gray-800/50 transition-colors"
      >
        <span className="flex items-center gap-3 text-sm font-semibold text-white">
          <span className="text-xl">{emoji}</span>
          {title}
        </span>
        {open ? <ChevronDown className="h-4 w-4 text-gray-500" /> : <ChevronRight className="h-4 w-4 text-gray-500" />}
      </button>
      {open && <div className="px-5 pb-5 text-sm text-gray-400 space-y-3">{children}</div>}
    </div>
  );
}

function Term({ term, definition }: { term: string; definition: string }) {
  return (
    <div className="border-b border-gray-800 pb-2 last:border-0 last:pb-0">
      <span className="text-white font-semibold">{term}</span>
      <span className="text-gray-500 ml-2">—</span>
      <span className="text-gray-400 ml-2">{definition}</span>
    </div>
  );
}

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer"
      className="text-emerald-400 hover:text-emerald-300 inline-flex items-center gap-1">
      {children} <ExternalLink className="h-3 w-3" />
    </a>
  );
}

export default function TradingGuidePage() {
  // Suppress unused import warnings
  void TrendingUp;
  void Shield;

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <BookOpen className="h-6 w-6 text-emerald-400" />
          Day Trading Guide
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          A complete guide to day trading in the UK — from terminology to tax
        </p>
      </div>

      {/* Warning banner */}
      <div className="flex items-start gap-3 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3">
        <AlertTriangle className="h-5 w-5 text-red-400 flex-shrink-0 mt-0.5" />
        <div className="text-sm text-red-200/80">
          <strong className="text-red-300">Risk Warning:</strong> Day trading carries significant risk of loss.
          The majority of retail traders lose money. Never trade with money you cannot afford to lose.
          All content here is educational only and not financial advice.
          <span className="text-red-400 font-semibold"> Past performance does not guarantee future results.</span>
        </div>
      </div>

      {/* Quick start steps */}
      <div>
        <h2 className="text-base font-semibold text-white mb-3">Quick Start — 7 Steps to Begin</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[
            { step: 1, title: 'Learn the basics', desc: 'Study order types, charts, and market mechanics. Spend at least 1-3 months learning before risking real money.' },
            { step: 2, title: 'Choose a broker', desc: 'Open an FCA-regulated account (see brokers below). Start with a demo account to practice for free.' },
            { step: 3, title: 'Pick your market', desc: 'UK traders commonly start with FTSE stocks, FX pairs (GBP/USD), or index CFDs (UK100). Start with one market only.' },
            { step: 4, title: 'Build a strategy', desc: 'Decide your entry signals, stop-loss rules, and profit targets BEFORE entering a trade. Write it down.' },
            { step: 5, title: 'Set risk limits', desc: 'Never risk more than 1-2% of your account per trade. Set a daily loss limit (e.g. 3%) and stop if hit.' },
            { step: 6, title: 'Start small', desc: 'Trade minimum size for at least 3 months. Prove your strategy works before increasing position sizes.' },
            { step: 7, title: 'Track everything', desc: 'Record every trade: entry, exit, reason, outcome. Review weekly. Losing traders ignore this step.' },
          ].map(item => (
            <div key={item.step} className="flex gap-3 bg-gray-900 border border-gray-800 rounded-xl p-4">
              <div className="flex-shrink-0 w-7 h-7 rounded-full bg-emerald-500/20 text-emerald-400 text-xs font-bold flex items-center justify-center">{item.step}</div>
              <div>
                <p className="text-sm font-semibold text-white">{item.title}</p>
                <p className="text-xs text-gray-500 mt-0.5">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Accordion sections */}
      <div className="space-y-3">

        <Accordion title="Key Trading Terminology" emoji="📖">
          <div className="space-y-2">
            <Term term="Bid / Ask" definition="Bid is the price a buyer will pay; Ask is what a seller wants. The spread is the difference — your immediate loss on entry." />
            <Term term="Spread" definition="The difference between bid and ask. Lower spreads = lower trading costs. GBP/USD typically has a 0.5-1 pip spread at major brokers." />
            <Term term="Pip" definition="Smallest price move in forex. For GBP/USD, one pip = 0.0001. For GBP/JPY, one pip = 0.01." />
            <Term term="Lot Size" definition="The volume of a trade. Standard lot = 100,000 units. Mini lot = 10,000. Micro lot = 1,000. Start with micro lots." />
            <Term term="Leverage" definition="Borrowed capital to control a larger position. 30:1 leverage means £100 controls £3,000. Amplifies both gains AND losses." />
            <Term term="Margin" definition="The deposit required to open a leveraged position. If margin is 3.33%, you need £33 to control a £1,000 position." />
            <Term term="Stop-Loss (SL)" definition="An order to automatically close a losing trade at a specified price. ALWAYS use one. No exceptions." />
            <Term term="Take-Profit (TP)" definition="An order to automatically close a winning trade at a target price. Locks in gains without needing to watch the screen." />
            <Term term="Risk/Reward Ratio" definition="The ratio of potential profit to potential loss. A 1:2 ratio means risking £50 to potentially make £100. Aim for 1:1.5 minimum." />
            <Term term="Going Long" definition="Buying with expectation the price will rise. Standard trade direction." />
            <Term term="Going Short" definition="Selling something you don't own, expecting price to fall. Profit if price drops. Requires CFD/spread bet account." />
            <Term term="CFD" definition="Contract for Difference. Lets you speculate on price movement without owning the asset. Gains/losses are the difference in price." />
            <Term term="Spread Betting" definition="Similar to CFDs but profits are tax-free in the UK (no CGT or stamp duty). Treated as gambling by HMRC." />
            <Term term="ISA" definition="Individual Savings Account. Shares ISA allows buying actual stocks tax-free (no CGT on gains). £20,000/year allowance." />
            <Term term="Candlestick" definition="A chart element showing open, high, low, close prices for a period. Green = price rose. Red = price fell." />
            <Term term="Support / Resistance" definition="Support = price level where buying interest is strong (floor). Resistance = where selling pressure appears (ceiling)." />
            <Term term="Moving Average (MA)" definition="Average closing price over N periods. 20 MA = average of last 20 candles. Used to identify trend direction." />
            <Term term="RSI" definition="Relative Strength Index. Momentum indicator 0-100. Above 70 = overbought. Below 30 = oversold." />
            <Term term="Volume" definition="Number of shares/contracts traded. High volume on a breakout confirms the move is genuine." />
            <Term term="Breakout" definition="When price moves decisively above resistance or below support, often starting a new trend." />
            <Term term="Scalping" definition="Very short-term trading (seconds to minutes), targeting small profits many times a day. Very high skill and stress." />
            <Term term="Swing Trading" definition="Holding trades for days to weeks to capture larger price moves. Less stressful than day trading." />
            <Term term="P&L" definition="Profit and Loss. Your total gains minus losses." />
            <Term term="Drawdown" definition="Peak-to-trough decline in account value during a losing streak. Maximum drawdown = worst drop from peak." />
          </div>
        </Accordion>

        <Accordion title="Trading Strategies Explained" emoji="📈">
          <div className="space-y-4">
            <div>
              <h3 className="text-white font-semibold mb-1">Momentum Trading</h3>
              <p>Trade in the direction of strong price movement. Buy stocks/pairs moving up strongly on high volume. Use indicators like RSI and MACD to confirm. Works best in trending markets.</p>
              <p className="mt-1 text-gray-500 text-xs">Example: GBP/USD breaks above a key level on high volume after positive UK economic data → buy.</p>
            </div>
            <div>
              <h3 className="text-white font-semibold mb-1">Breakout Trading</h3>
              <p>Wait for price to break above resistance or below support, then trade in the breakout direction. Set stop-loss just inside the broken level. Wait for confirmed close above/below the level.</p>
            </div>
            <div>
              <h3 className="text-white font-semibold mb-1">News Trading</h3>
              <p>Trade on economic releases (CPI, NFP, interest rate decisions). Prices move sharply on surprises vs expectations. Very high risk — spreads widen, slippage is common. Professionals only.</p>
            </div>
            <div>
              <h3 className="text-white font-semibold mb-1">Mean Reversion</h3>
              <p>Assume prices return to average after extreme moves. Buy when RSI &lt;30 (oversold), sell when RSI &gt;70 (overbought). Works in range-bound markets, fails in strong trends.</p>
            </div>
            <div>
              <h3 className="text-white font-semibold mb-1">Scalping</h3>
              <p>Make many very small profits per day (2-5 pips in forex). Requires ultra-fast execution, low spreads, and intense focus. Not recommended for beginners. Very high transaction costs.</p>
            </div>
          </div>
        </Accordion>

        <Accordion title="UK Brokers & Platforms" emoji="🏦">
          <div className="space-y-4">
            <div className="bg-gray-800/50 rounded-lg p-3">
              <p className="text-white font-semibold mb-0.5">For Stocks (UK shares, ISA)</p>
              <ul className="space-y-1 text-xs">
                <li>• <ExtLink href="https://www.trading212.com">Trading 212</ExtLink> — Zero commission, shares ISA, fractional shares. Good for beginners. (App-based)</li>
                <li>• <ExtLink href="https://www.freetrade.io">Freetrade</ExtLink> — Commission-free, ISA available. Simple interface. Limited instruments.</li>
                <li>• <ExtLink href="https://www.hl.co.uk">Hargreaves Lansdown</ExtLink> — UK&apos;s largest broker. ISA, SIPP. Higher fees but excellent research. FCA regulated.</li>
                <li>• <ExtLink href="https://www.interactivebrokers.co.uk">Interactive Brokers</ExtLink> — Professional-grade. Very low commissions. Advanced tools. For experienced traders.</li>
                <li>• <ExtLink href="https://www.ajbell.co.uk">AJ Bell</ExtLink> — ISA/SIPP specialist. Good for long-term investing alongside trading.</li>
              </ul>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-3">
              <p className="text-white font-semibold mb-0.5">For CFDs, Spread Betting &amp; Forex</p>
              <ul className="space-y-1 text-xs">
                <li>• <ExtLink href="https://www.ig.com/uk">IG Markets</ExtLink> — UK&apos;s largest CFD broker. Spread betting (tax-free). 17,000+ markets. FCA regulated.</li>
                <li>• <ExtLink href="https://www.cmcmarkets.com/en-gb">CMC Markets</ExtLink> — Competitive spreads. Good platform. Spread betting available.</li>
                <li>• <ExtLink href="https://www.spreadex.com">Spreadex</ExtLink> — Spread betting focused. Good for indices and forex.</li>
                <li>• <ExtLink href="https://www.pepperstone.com/en-gb">Pepperstone</ExtLink> — FCA regulated. Low forex spreads. MT4/MT5 support. Popular with algo traders.</li>
                <li>• <ExtLink href="https://www.etoro.com">eToro</ExtLink> — Social trading, copy trading. Easy to use. Good for learning. CFDs, stocks.</li>
              </ul>
            </div>
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 text-xs text-amber-200/80">
              <strong className="text-amber-300">Important:</strong> Always verify an FCA registration at the FCA register: <ExtLink href="https://register.fca.org.uk">register.fca.org.uk</ExtLink>. Never use unregulated brokers. CFD brokers must display the % of retail clients who lose money.
            </div>
          </div>
        </Accordion>

        <Accordion title="Useful Websites & Tools" emoji="🌐">
          <div className="space-y-3">
            <div>
              <p className="text-white font-semibold mb-1">Charts &amp; Analysis</p>
              <ul className="space-y-1 text-xs">
                <li>• <ExtLink href="https://www.tradingview.com">TradingView</ExtLink> — The best free charting platform. Huge community, custom indicators, screeners. Start here.</li>
                <li>• <ExtLink href="https://www.finviz.com">Finviz</ExtLink> — US stock screener and heat maps. Excellent for finding momentum stocks.</li>
                <li>• <ExtLink href="https://uk.investing.com">Investing.com</ExtLink> — Economic calendar, live prices, news. Essential bookmark.</li>
              </ul>
            </div>
            <div>
              <p className="text-white font-semibold mb-1">News &amp; Research</p>
              <ul className="space-y-1 text-xs">
                <li>• <ExtLink href="https://www.ft.com">Financial Times</ExtLink> — Premium financial news. Best for macro and company news.</li>
                <li>• <ExtLink href="https://www.reuters.com/markets">Reuters Markets</ExtLink> — Free, real-time financial news. Very reliable.</li>
                <li>• <ExtLink href="https://www.bbc.co.uk/news/business">BBC Business</ExtLink> — UK business news. Free.</li>
                <li>• <ExtLink href="https://www.thisismoney.co.uk">This is Money</ExtLink> — UK retail investor news. Share tips, analysis.</li>
                <li>• <ExtLink href="https://uk.finance.yahoo.com">Yahoo Finance UK</ExtLink> — Free stock quotes, news, basic charts.</li>
                <li>• <ExtLink href="https://www.proactiveinvestors.co.uk">Proactive Investors</ExtLink> — UK small-cap and AIM company news.</li>
              </ul>
            </div>
            <div>
              <p className="text-white font-semibold mb-1">Economic Calendar</p>
              <ul className="space-y-1 text-xs">
                <li>• <ExtLink href="https://uk.investing.com/economic-calendar">Investing.com Calendar</ExtLink> — Best free economic calendar. Filter by country and impact.</li>
                <li>• <ExtLink href="https://www.forexfactory.com">Forex Factory</ExtLink> — Forex-focused economic calendar. Community forums.</li>
                <li>• <ExtLink href="https://www.bankofengland.co.uk/monetary-policy/the-interest-rate-bank-rate">Bank of England</ExtLink> — Official BoE interest rate decisions.</li>
              </ul>
            </div>
            <div>
              <p className="text-white font-semibold mb-1">Learning Resources</p>
              <ul className="space-y-1 text-xs">
                <li>• <ExtLink href="https://www.babypips.com">BabyPips</ExtLink> — The best free forex trading course. Start with &quot;School of Pipsology&quot;.</li>
                <li>• <ExtLink href="https://www.ig.com/uk/trading-strategies">IG Trading Academy</ExtLink> — Free video courses from a major UK broker.</li>
                <li>• <ExtLink href="https://www.investopedia.com">Investopedia</ExtLink> — Comprehensive financial education site. Great for definitions.</li>
                <li>• <ExtLink href="https://www.reddit.com/r/UKInvesting">r/UKInvesting</ExtLink> — UK-focused investing community. Useful for peer discussion.</li>
              </ul>
            </div>
          </div>
        </Accordion>

        <Accordion title="Tax Treatment in the UK" emoji="🧾">
          <div className="space-y-3">
            <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3 text-xs text-emerald-200/80">
              <strong className="text-emerald-300">Good news:</strong> Spread betting profits in the UK are exempt from Capital Gains Tax and Income Tax. This is because HMRC treats spread betting as gambling.
            </div>

            <div>
              <p className="text-white font-semibold mb-1">Capital Gains Tax (CGT) — for shares and CFDs</p>
              <ul className="space-y-1 text-xs">
                <li>• Basic rate taxpayers: <span className="text-white">18%</span> on gains from shares (10% for other assets)</li>
                <li>• Higher/additional rate taxpayers: <span className="text-white">24%</span> on share gains (20% for other assets)</li>
                <li>• Annual CGT allowance 2024/25: <span className="text-white">£3,000</span> — gains below this are tax-free</li>
                <li>• Use <span className="text-white">Shares ISA</span> to shield gains entirely (£20,000/year allowance)</li>
                <li>• CFD profits are subject to CGT</li>
                <li>• Report on <span className="text-white">Self Assessment tax return</span> if gains &gt; £3,000 or if you sold assets &gt; £50,000</li>
              </ul>
            </div>

            <div>
              <p className="text-white font-semibold mb-1">Income Tax — for frequent traders</p>
              <ul className="space-y-1 text-xs">
                <li>• HMRC may classify you as a <span className="text-white">professional trader</span> if trading is your main income</li>
                <li>• Profits then subject to Income Tax (20%, 40%, or 45%) not CGT</li>
                <li>• No clear threshold — HMRC looks at frequency, expertise, and intention</li>
                <li>• Can deduct business expenses (platform fees, data, home office) against income</li>
              </ul>
            </div>

            <div>
              <p className="text-white font-semibold mb-1">Forex Trading Tax</p>
              <ul className="space-y-1 text-xs">
                <li>• <span className="text-white">Spread betting on FX</span>: Tax-free (treated as gambling)</li>
                <li>• <span className="text-white">FX CFDs</span>: Subject to CGT as above</li>
                <li>• <span className="text-white">Physical FX</span> (buying currency): Generally CGT on gains</li>
                <li>• Frequent FX traders may be assessed for Income Tax</li>
              </ul>
            </div>

            <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 text-xs text-amber-200/80">
              <strong className="text-amber-300">Disclaimer:</strong> This is general information only. Tax rules change. Consult a qualified UK tax adviser or accountant for your specific situation. HMRC guidance: <ExtLink href="https://www.gov.uk/capital-gains-tax/what-you-pay-it-on">gov.uk</ExtLink>
            </div>
          </div>
        </Accordion>

        <Accordion title="Risk Management — The Most Important Section" emoji="🛡">
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {[
                { rule: '1% Rule', desc: 'Never risk more than 1-2% of your total account on a single trade. If you have £1,000, risk no more than £10-£20 per trade.' },
                { rule: 'Daily Loss Limit', desc: 'Set a maximum daily loss (e.g. 3% of account). If hit, stop trading for the day. Prevents revenge trading.' },
                { rule: 'Risk/Reward', desc: 'Only take trades where potential reward is at least 1.5× the risk. Over time, this overcomes a 40% win rate.' },
                { rule: 'Position Sizing', desc: 'Calculate your position size from your stop-loss distance. Decide on £ risk first, then work backwards to lot size.' },
                { rule: 'Avoid Overtrading', desc: 'Fewer, higher-quality trades beat many low-quality ones. Aim for 2-5 trades per day maximum when starting.' },
                { rule: 'Never Add to Losers', desc: 'Adding to a losing position ("averaging down") turns small losses into account-destroying losses. Cut losses, not profits.' },
              ].map(item => (
                <div key={item.rule} className="flex gap-2 bg-gray-800/50 rounded-lg p-3">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-white text-xs font-semibold">{item.rule}</p>
                    <p className="text-gray-500 text-xs mt-0.5">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-xs">
              <p className="text-red-300 font-semibold mb-1">Common Mistakes That Cause Losses</p>
              <ul className="text-red-200/70 space-y-0.5">
                <li>• Trading without a stop-loss</li>
                <li>• Moving stop-loss further away when losing</li>
                <li>• Risking too much per trade (FOMO on &quot;sure things&quot;)</li>
                <li>• Trading when emotional (angry, euphoric, tired)</li>
                <li>• Overtrading to &quot;make back&quot; losses — revenge trading</li>
                <li>• Using too much leverage too soon</li>
                <li>• Not having a written trading plan</li>
                <li>• Ignoring the economic calendar before trading</li>
              </ul>
            </div>
          </div>
        </Accordion>

        <Accordion title="Reading Charts — Basics" emoji="📊">
          <div className="space-y-3">
            <p>Go to <ExtLink href="https://www.tradingview.com">TradingView.com</ExtLink> (free) and open any symbol. This is the industry standard charting tool.</p>
            <div>
              <p className="text-white font-semibold mb-1">Essential chart types</p>
              <ul className="space-y-1 text-xs">
                <li>• <span className="text-white">Candlestick chart</span> — shows open/high/low/close. Most traders use this. Green candle = price went up. Red = went down.</li>
                <li>• <span className="text-white">Line chart</span> — just closing prices. Cleaner but less information.</li>
                <li>• <span className="text-white">Bar chart</span> — similar to candlestick, different visual style.</li>
              </ul>
            </div>
            <div>
              <p className="text-white font-semibold mb-1">Timeframes</p>
              <ul className="space-y-1 text-xs">
                <li>• <span className="text-white">1M/5M/15M</span> — Very short term. Used by scalpers and day traders to time entries.</li>
                <li>• <span className="text-white">1H</span> — Good for day trading. Most day traders use 1H for direction and 5M for entry.</li>
                <li>• <span className="text-white">4H/Daily</span> — Swing trading. Shows the bigger trend. Always check higher timeframe before shorter.</li>
                <li>• <span className="text-white">Weekly/Monthly</span> — Long-term investment timeframe.</li>
              </ul>
            </div>
            <div>
              <p className="text-white font-semibold mb-1">Essential indicators (add in TradingView)</p>
              <ul className="space-y-1 text-xs">
                <li>• <span className="text-white">20 EMA + 50 EMA</span> — Moving averages. Price above both EMAs = uptrend. EMA crossover signals trend change.</li>
                <li>• <span className="text-white">RSI (14)</span> — Momentum. Set levels at 30 and 70.</li>
                <li>• <span className="text-white">MACD</span> — Trend/momentum. MACD line crossing signal line = potential entry signal.</li>
                <li>• <span className="text-white">Volume</span> — Always show volume. High volume confirms price moves. Low volume moves are unreliable.</li>
                <li>• <span className="text-white">Bollinger Bands</span> — Volatility indicator. Price touching lower band = potential buy. Upper band = potential sell (in range).</li>
              </ul>
            </div>
          </div>
        </Accordion>

        <Accordion title="UK Regulations & FCA" emoji="⚖️">
          <div className="space-y-3">
            <p>All investment services offered to UK retail clients must be regulated by the <ExtLink href="https://www.fca.org.uk">Financial Conduct Authority (FCA)</ExtLink>.</p>
            <div>
              <p className="text-white font-semibold mb-1">Key regulations for retail traders</p>
              <ul className="space-y-1 text-xs">
                <li>• <span className="text-white">Leverage limits (ESMA rules)</span>: Max 30:1 on major FX pairs, 20:1 on minor FX, 10:1 on equities, 2:1 on crypto</li>
                <li>• <span className="text-white">Negative balance protection</span>: You cannot lose more than your deposit with FCA-regulated brokers</li>
                <li>• <span className="text-white">FSCS protection</span>: Up to £85,000 per person per firm if a regulated broker fails</li>
                <li>• <span className="text-white">Risk disclosures</span>: Brokers must state what % of retail clients lose money. Typical: 70-80%</li>
              </ul>
            </div>
            <div>
              <p className="text-white font-semibold mb-1">Verify your broker</p>
              <ul className="space-y-1 text-xs">
                <li>• Check the <ExtLink href="https://register.fca.org.uk">FCA Register</ExtLink> — search for the firm name or FRN number</li>
                <li>• Check FCA <ExtLink href="https://www.fca.org.uk/consumers/warning-list">Warning List</ExtLink> for scam firms</li>
                <li>• Legitimate brokers never cold-call you with investment opportunities</li>
                <li>• If it sounds too good to be true, it is. Investment scams cost UK investors £1.2B/year</li>
              </ul>
            </div>
          </div>
        </Accordion>

      </div>

      {/* Footer note */}
      <div className="text-xs text-gray-600 text-center">
        This guide is for educational purposes only. Not financial advice. Always do your own research.
      </div>
    </div>
  );
}

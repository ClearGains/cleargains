'use client';

import { useState } from 'react';
import {
  HelpCircle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Zap,
  BookOpen,
  Calculator,
  ShieldCheck,
  Wifi,
} from 'lucide-react';
import { Card, CardHeader } from '@/components/ui/Card';
import { clsx } from 'clsx';
import Link from 'next/link';

const FAQ = [
  {
    q: 'Is ClearGains regulated financial advice?',
    a: 'No. ClearGains is an educational simulation tool only. It is not authorised or regulated by the Financial Conduct Authority (FCA). Nothing on this platform constitutes financial, investment, or tax advice. Always consult a qualified financial adviser and/or tax professional.',
  },
  {
    q: 'How does the Trading 212 integration work?',
    a: 'You provide your Trading 212 API key in a .env.local file (T212_API_KEY=your_key). ClearGains calls the Trading 212 REST API server-side to fetch your portfolio positions and order history. Your API key is never exposed to the browser. You can generate a read-only API key in Trading 212: go to Settings → API (demo or live account).',
  },
  {
    q: 'How accurate is the CGT calculator?',
    a: 'The CGT calculator implements the three HMRC matching rules: same-day, bed & breakfast (30-day), and Section 104 share pooling. It is a best-effort calculation for educational purposes. ISA holdings are automatically excluded. However, tax calculations can be complex and you must verify all figures against HMRC guidance and your own records before filing.',
  },
  {
    q: 'What is the Section 104 share pool?',
    a: 'The Section 104 pool is an HMRC accounting method for shares of the same class. All acquisitions are pooled together at their average cost. When you sell, the proportional average cost is your allowable deduction. The pool is adjusted for each buy and sell transaction.',
  },
  {
    q: 'What is the bed and breakfast rule?',
    a: 'The 30-day bed & breakfast rule prevents artificial loss creation. If you sell shares and buy the same shares back within 30 days, HMRC matches the disposal against the repurchase rather than the original pool. This rule applies even if you sell in one account and buy in another (except ISAs).',
  },
  {
    q: 'Why are ISA trades excluded from CGT calculations?',
    a: 'Stocks held within a Stocks & Shares ISA are completely sheltered from Capital Gains Tax and Income Tax on dividends. Any gains made inside an ISA do not need to be reported on your Self Assessment. Always mark ISA trades correctly in the Trade Ledger.',
  },
  {
    q: 'How do I get an Anthropic API key for the AI scanner?',
    a: 'Sign up at console.anthropic.com to get an API key. Add it as ANTHROPIC_API_KEY in your .env.local file. Without it, the scanner returns simulated signals for demonstration. The AI uses Claude with web search to find recent news about your ticker.',
  },
  {
    q: 'What does the Risk Engine measure?',
    a: 'The Risk Engine calculates portfolio concentration (HHI index), position weights, and estimates a rough 1-day Value at Risk (VaR) assuming 2% average daily volatility. It also runs a set of best-practice checks including ISA usage, diversification, and single-position limits. These are educational estimates only.',
  },
  {
    q: 'Can I use ClearGains for my actual tax return?',
    a: 'No. ClearGains is for educational and planning purposes. You must use HMRC\'s official Self Assessment (SA108 form) for reporting capital gains. Always verify all calculations and consult a qualified accountant or tax adviser.',
  },
  {
    q: 'Is my data stored on your servers?',
    a: 'No. ClearGains stores all data locally in your browser using localStorage (via Zustand persist). Your API keys are stored only in .env.local on your machine. No data is sent to any ClearGains servers — API calls go directly from your browser/server to Trading 212 and Anthropic.',
  },
];

const GUIDES = [
  {
    icon: <Wifi className="h-5 w-5 text-emerald-400" />,
    title: 'Getting Started',
    steps: [
      'Select your country on the Onboarding screen',
      'Optionally add your Trading 212 API key to .env.local',
      'Click "Sync with T212" on the Dashboard to import your portfolio',
      'Add or import trades in the Trade Ledger',
      'Use the CGT Calculator to estimate your tax liability',
    ],
  },
  {
    icon: <BookOpen className="h-5 w-5 text-blue-400" />,
    title: 'Trade Ledger',
    steps: [
      'Add trades manually using the form on the left',
      'Mark ISA trades with the ISA toggle — these are CGT-exempt',
      'Import trades automatically from Trading 212 using the "Import T212" button',
      'All trades feed into the CGT Calculator and Risk Engine',
    ],
  },
  {
    icon: <Calculator className="h-5 w-5 text-yellow-400" />,
    title: 'CGT Calculator',
    steps: [
      'Select the tax year you want to calculate',
      'The calculator applies HMRC matching rules automatically',
      'Same-day rule first, then 30-day bed & breakfast, then Section 104 pool',
      'View your SA108 summary and estimated tax',
      'Expand the calculations table to see individual disposals',
    ],
  },
  {
    icon: <Zap className="h-5 w-5 text-purple-400" />,
    title: 'AI Scanner',
    steps: [
      'Enter a ticker symbol and click "Analyse"',
      'Claude AI searches the web for recent news about the stock',
      'A BUY/SELL/HOLD signal is generated with risk score and reasoning',
      'Signals are for educational purposes only — not trading recommendations',
      'All signals are saved in your session history',
    ],
  },
  {
    icon: <ShieldCheck className="h-5 w-5 text-red-400" />,
    title: 'Risk Engine',
    steps: [
      'Sync your portfolio from Trading 212 first',
      'The engine calculates concentration metrics (HHI) and VaR',
      'Six risk checks evaluate your portfolio against best practices',
      'Use the concentration chart to see position weights',
      'Review the tips section for UK-specific risk guidance',
    ],
  },
];

export default function HelpPage() {
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <HelpCircle className="h-6 w-6 text-emerald-400" />
          Help Centre
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Documentation, guides, and frequently asked questions
        </p>
      </div>

      {/* Quick start guides */}
      <Card className="mb-6">
        <CardHeader
          title="Feature Guides"
          subtitle="Step-by-step instructions for each section"
          icon={<BookOpen className="h-4 w-4" />}
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {GUIDES.map(({ icon, title, steps }) => (
            <div key={title} className="bg-gray-800/50 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-3">
                {icon}
                <span className="font-semibold text-white text-sm">{title}</span>
              </div>
              <ol className="space-y-1.5">
                {steps.map((step, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-gray-400">
                    <span className="flex-shrink-0 w-4 h-4 rounded-full bg-gray-700 text-gray-300 text-[10px] flex items-center justify-center font-bold">
                      {i + 1}
                    </span>
                    {step}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </Card>

      {/* Environment setup */}
      <Card className="mb-6">
        <CardHeader
          title="Environment Setup"
          subtitle="Configure API keys in .env.local"
          icon={<Zap className="h-4 w-4" />}
        />
        <div className="bg-gray-800 rounded-lg px-4 py-3 font-mono text-xs text-gray-300 mb-4 overflow-x-auto">
          <div className="text-gray-500"># cleargains/.env.local</div>
          <div className="mt-2">
            <span className="text-emerald-400">T212_API_KEY</span>=your_trading212_api_key<br />
            <span className="text-emerald-400">ANTHROPIC_API_KEY</span>=your_anthropic_api_key<br />
            <span className="text-gray-500"># Optional: for live FX rates</span><br />
            <span className="text-emerald-400">FX_API_KEY</span>=your_exchangerate_api_key
          </div>
        </div>
        <div className="space-y-2 text-xs text-gray-500">
          <div className="flex items-center justify-between">
            <span>T212_API_KEY</span>
            <a
              href="https://www.trading212.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300 flex items-center gap-1"
            >
              trading212.com → Settings → API <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          <div className="flex items-center justify-between">
            <span>ANTHROPIC_API_KEY</span>
            <a
              href="https://console.anthropic.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300 flex items-center gap-1"
            >
              console.anthropic.com <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          <div className="flex items-center justify-between">
            <span>FX_API_KEY (optional)</span>
            <a
              href="https://www.exchangerate-api.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300 flex items-center gap-1"
            >
              exchangerate-api.com <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
      </Card>

      {/* FAQ */}
      <Card>
        <CardHeader
          title="Frequently Asked Questions"
          subtitle={`${FAQ.length} questions`}
          icon={<HelpCircle className="h-4 w-4" />}
        />
        <div className="space-y-2">
          {FAQ.map((faq, i) => (
            <div key={i} className="border border-gray-800 rounded-lg overflow-hidden">
              <button
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-800/40 transition-colors text-left"
                onClick={() => setOpenFaq(openFaq === i ? null : i)}
              >
                <span className="text-sm font-medium text-gray-200">{faq.q}</span>
                {openFaq === i ? (
                  <ChevronUp className="h-4 w-4 text-gray-500 flex-shrink-0 ml-2" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-gray-500 flex-shrink-0 ml-2" />
                )}
              </button>
              {openFaq === i && (
                <div className="px-4 pb-4 border-t border-gray-800">
                  <p className="text-sm text-gray-400 mt-3 leading-relaxed">{faq.a}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>

      {/* External links */}
      <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          {
            title: 'HMRC CGT Guide',
            url: 'https://www.gov.uk/capital-gains-tax',
            desc: 'Official HMRC guidance on Capital Gains Tax',
          },
          {
            title: 'SA108 Form',
            url: 'https://www.gov.uk/government/publications/self-assessment-capital-gains-summary-sa108',
            desc: 'Self Assessment: Capital Gains Summary form',
          },
          {
            title: 'T212 API Docs',
            url: 'https://www.trading212.com',
            desc: 'Trading 212 API documentation and key generation',
          },
        ].map(({ title, url, desc }) => (
          <a
            key={title}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="block bg-gray-900 border border-gray-800 hover:border-gray-600 rounded-xl p-4 transition-colors"
          >
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm font-medium text-white">{title}</span>
              <ExternalLink className="h-3.5 w-3.5 text-gray-500" />
            </div>
            <p className="text-xs text-gray-500">{desc}</p>
          </a>
        ))}
      </div>
    </div>
  );
}

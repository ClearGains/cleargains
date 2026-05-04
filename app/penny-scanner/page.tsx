'use client';

import { useState } from 'react';
import { Zap, AlertTriangle, ScanLine, Bot } from 'lucide-react';
import PennyScanner from '@/components/PennyScanner';
import IGSharesAutoTrader from '@/components/ig/IGSharesAutoTrader';

type Tab = 'scanner' | 'autotrader';

export default function PennyScannerPage() {
  const [tab, setTab] = useState<Tab>('scanner');

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Zap className="h-6 w-6 text-purple-400" />
          Penny Scanner & Auto-Trader
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Identify investment opportunities and automatically execute trades on IG via AI-powered analysis
        </p>
      </div>

      {/* Disclaimer */}
      <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-4 py-3 mb-5 flex items-start gap-3">
        <AlertTriangle className="h-4 w-4 text-yellow-500 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-yellow-400">
          <span className="font-semibold">Educational & High Risk.</span> The penny scanner uses public market
          data for research only — no trading platform required. The IG Auto-Trader places real spread bets:
          losses can exceed deposits. Past analysis does not guarantee future results. Not financial advice.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 mb-5 w-fit">
        <button
          onClick={() => setTab('scanner')}
          className={[
            'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
            tab === 'scanner' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300',
          ].join(' ')}
        >
          <ScanLine className="h-4 w-4" />
          Penny Stock Scanner
        </button>
        <button
          onClick={() => setTab('autotrader')}
          className={[
            'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
            tab === 'autotrader' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300',
          ].join(' ')}
        >
          <Bot className="h-4 w-4" />
          IG Auto-Trader
          <span className="text-xs bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded-full font-semibold">NEW</span>
        </button>
      </div>

      {tab === 'scanner' ? (
        <PennyScanner />
      ) : (
        <IGSharesAutoTrader />
      )}
    </div>
  );
}

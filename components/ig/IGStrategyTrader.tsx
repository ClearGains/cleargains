'use client';

import { useState } from 'react';
import { clsx } from 'clsx';
import { IG_ACCOUNT_CFD, IG_ACCOUNT_SPREADBET } from '@/lib/igConfig';
import { IGAccountPanel } from './IGAccountPanel';

const IG_ENV: 'demo' | 'live' =
  process.env.NEXT_PUBLIC_IG_DEMO === 'false' ? 'live' : 'demo';

export function IGStrategyTrader() {
  const [activeTab, setActiveTab] = useState<'cfd' | 'sb'>('cfd');

  return (
    <div className="flex flex-col min-h-0">
      {/* ── Tab bar ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 bg-gray-950 border-b border-gray-800 px-4 sticky top-0 z-20">
        <button
          onClick={() => setActiveTab('cfd')}
          className={clsx(
            'px-4 py-3 text-sm font-medium transition-colors border-b-2 -mb-px',
            activeTab === 'cfd'
              ? 'border-blue-500 text-blue-400'
              : 'border-transparent text-gray-400 hover:text-gray-200',
          )}
        >
          📊 CFD Account
          <span className="ml-2 text-xs opacity-60">{IG_ACCOUNT_CFD}</span>
        </button>

        <button
          onClick={() => setActiveTab('sb')}
          className={clsx(
            'px-4 py-3 text-sm font-medium transition-colors border-b-2 -mb-px',
            activeTab === 'sb'
              ? 'border-emerald-500 text-emerald-400'
              : 'border-transparent text-gray-400 hover:text-gray-200',
          )}
        >
          📈 Spread Bet
          <span className="ml-2 text-xs opacity-60">{IG_ACCOUNT_SPREADBET}</span>
        </button>

        <div className="ml-auto text-xs text-gray-600 py-3">
          {IG_ENV === 'demo' ? '🟡 DEMO' : '🟢 LIVE'}
        </div>
      </div>

      {/* ── Panels — always mounted, CSS-hidden when inactive ──────────────── */}
      <div className={activeTab === 'cfd' ? 'block' : 'hidden'}>
        <IGAccountPanel
          accountId={IG_ACCOUNT_CFD}
          accountType="CFD"
          env={IG_ENV}
        />
      </div>

      <div className={activeTab === 'sb' ? 'block' : 'hidden'}>
        <IGAccountPanel
          accountId={IG_ACCOUNT_SPREADBET}
          accountType="SPREADBET"
          env={IG_ENV}
        />
      </div>
    </div>
  );
}

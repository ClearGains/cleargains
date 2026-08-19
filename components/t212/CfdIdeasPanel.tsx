'use client';

// Read-only, on-demand CFD trade ideas for manual execution on Trading212's
// CFD account. T212's CFD product has no API access at all, so this never
// connects to or authenticates with T212 in any way — it just runs the same
// rules-engine + Gemini-confirmation logic already proven on the IG live
// stock bot (see bot-server/src/cfdIdeas.ts for why levels here are real $
// prices, not IG's spread-bet points), and hands back a plain list for the
// user to read and manually open in the real T212 CFD app themselves.
//
// No scheduled scanning, no persistence between visits — every "Scan" click
// is a fresh, independent pass over the universe.

import { useState } from 'react';
import { RefreshCw, TrendingUp, TrendingDown, ChevronDown, ChevronUp } from 'lucide-react';
import { clsx } from 'clsx';
import { Card, CardHeader } from '@/components/ui/Card';

type CfdIdea = {
  symbol: string;
  name: string;
  sector: string;
  direction: 'LONG' | 'SHORT';
  price: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  ruleConfidence: number;
  reason: string;
  computedAt: string;
};

function fmtUSD(n: number) {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function IdeaCard({ idea }: { idea: CfdIdea }) {
  const [expanded, setExpanded] = useState(false);
  const riskPct   = Math.abs((idea.stopLoss   - idea.price) / idea.price) * 100;
  const rewardPct = Math.abs((idea.takeProfit - idea.price) / idea.price) * 100;
  const rr = riskPct > 0 ? (rewardPct / riskPct) : null;

  return (
    <div className="rounded-xl border border-gray-700/60 bg-gray-900/80 p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-white">{idea.name}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-400 font-mono">
              {idea.symbol}
            </span>
            <span className={clsx(
              'text-[10px] px-2 py-0.5 rounded-full font-semibold flex items-center gap-1',
              idea.direction === 'LONG' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
            )}>
              {idea.direction === 'LONG' ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
              {idea.direction}
            </span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-700/60 text-gray-400">
              {idea.sector}
            </span>
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-gray-400 flex-wrap">
            <span>{fmtUSD(idea.price)}</span>
            <span className={clsx('font-semibold',
              idea.confidence >= 85 ? 'text-emerald-400' : idea.confidence >= 70 ? 'text-blue-400' : 'text-amber-400'
            )}>
              Gemini {idea.confidence}%
            </span>
            <span className="text-gray-500">Rules {idea.ruleConfidence}/10</span>
            {rr !== null && <span className="text-gray-500">R:R ~{rr.toFixed(1)}:1</span>}
          </div>
        </div>
        <button
          onClick={() => setExpanded(v => !v)}
          className="text-[10px] text-gray-600 hover:text-gray-400 flex items-center gap-0.5 flex-shrink-0"
        >
          {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          {expanded ? 'Less' : 'Why'}
        </button>
      </div>

      {/* The actual manually-actionable levels — the whole point of this panel */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="bg-gray-800/60 rounded-lg py-2">
          <div className="text-[10px] text-gray-500 uppercase tracking-wide">Entry (~)</div>
          <div className="text-sm font-semibold text-white">{fmtUSD(idea.price)}</div>
        </div>
        <div className="bg-red-950/30 rounded-lg py-2">
          <div className="text-[10px] text-red-400/80 uppercase tracking-wide">Stop</div>
          <div className="text-sm font-semibold text-red-400">{fmtUSD(idea.stopLoss)}</div>
        </div>
        <div className="bg-emerald-950/30 rounded-lg py-2">
          <div className="text-[10px] text-emerald-400/80 uppercase tracking-wide">Take-Profit</div>
          <div className="text-sm font-semibold text-emerald-400">{fmtUSD(idea.takeProfit)}</div>
        </div>
      </div>

      {expanded && (
        <div className="bg-gray-800/50 rounded-lg p-3 text-xs text-gray-300 leading-relaxed">
          {idea.reason}
        </div>
      )}
    </div>
  );
}

export function CfdIdeasPanel() {
  const [ideas, setIdeas]       = useState<CfdIdea[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [scannedAt, setScannedAt] = useState<string | null>(null);

  async function runScan() {
    setScanning(true);
    setError(null);
    try {
      const res = await fetch('/api/cfd-ideas');
      const data = await res.json() as { ok: boolean; ideas?: CfdIdea[]; scannedAt?: string; error?: string };
      if (!data.ok) { setError(data.error ?? 'Scan failed.'); return; }
      setIdeas(data.ideas ?? []);
      setScannedAt(data.scannedAt ?? new Date().toISOString());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="CFD Ideas"
        subtitle="Read-only — for manually opening positions on your Trading212 CFD account. Nothing here connects to T212 or executes anything; levels are real $ prices from the same rules+Gemini engine proven on the live IG stock bot."
      />
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <button
            onClick={() => void runScan()}
            disabled={scanning}
            className={clsx(
              'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
              scanning ? 'bg-gray-800 text-gray-500' : 'bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30'
            )}
          >
            <RefreshCw className={clsx('h-4 w-4', scanning && 'animate-spin')} />
            {scanning ? 'Scanning universe (this can take a minute or two)…' : 'Scan for ideas'}
          </button>
          {scannedAt && !scanning && (
            <span className="text-xs text-gray-500">
              Last scanned {new Date(scannedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — {ideas.length} idea{ideas.length === 1 ? '' : 's'}
            </span>
          )}
        </div>

        {error && (
          <div className="text-xs text-red-400 bg-red-950/30 border border-red-900/50 rounded-lg p-3">
            {error}
          </div>
        )}

        {!scanning && !error && scannedAt && ideas.length === 0 && (
          <div className="text-center text-gray-600 text-sm py-8">
            No setups qualified this scan — nothing both cleared the rules-based bar and got confirmed by Gemini. Try again later.
          </div>
        )}

        {!scanning && !scannedAt && (
          <div className="text-center text-gray-600 text-sm py-8">
            Hit &quot;Scan for ideas&quot; to run a fresh pass over the universe. Each scan is independent — nothing is saved or auto-refreshed.
          </div>
        )}

        <div className="space-y-3">
          {ideas.map(idea => <IdeaCard key={idea.symbol} idea={idea} />)}
        </div>
      </div>
    </Card>
  );
}

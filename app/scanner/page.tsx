'use client';

import { useState } from 'react';
import {
  Search,
  Zap,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Minus,
  Clock,
  RefreshCw,
} from 'lucide-react';
import { useClearGainsStore } from '@/lib/store';
import { Signal } from '@/lib/types';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { clsx } from 'clsx';

const POPULAR_TICKERS = [
  'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN',
  'GOOGL', 'META', 'AVGO', 'TSM', 'ASML',
  'BP', 'LLOY', 'VOD', 'GSK', 'RIO',
];

function SignalIcon({ signal }: { signal: string }) {
  if (signal === 'BUY') return <TrendingUp className="h-4 w-4" />;
  if (signal === 'SELL') return <TrendingDown className="h-4 w-4" />;
  return <Minus className="h-4 w-4" />;
}

function RiskBar({ score }: { score: number }) {
  const color =
    score >= 70 ? 'bg-red-500' : score >= 45 ? 'bg-yellow-500' : 'bg-emerald-500';
  return (
    <div className="w-full bg-gray-800 rounded-full h-1.5 mt-1">
      <div className={clsx('h-1.5 rounded-full transition-all', color)} style={{ width: `${score}%` }} />
    </div>
  );
}

export default function ScannerPage() {
  const { signals, addSignal, selectedCountry, t212Positions } = useClearGainsStore();
  const [ticker, setTicker] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentSignal, setCurrentSignal] = useState<Signal | null>(null);

  async function runScan(symbol?: string) {
    const target = (symbol ?? ticker).trim().toUpperCase();
    if (!target) return;

    setLoading(true);
    setError(null);
    setCurrentSignal(null);

    try {
      const res = await fetch('/api/ai-scanner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: target, country: selectedCountry.code }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? 'Scanner failed');
      } else {
        setCurrentSignal(data);
        addSignal(data);
        setTicker('');
      }
    } catch {
      setError('Network error — please try again');
    } finally {
      setLoading(false);
    }
  }

  const portfolioTickers = t212Positions.map((p) => p.ticker).slice(0, 8);

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Zap className="h-6 w-6 text-emerald-400" />
          AI Scanner
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Claude AI powered stock analysis with live web search
        </p>
      </div>

      {/* Disclaimer */}
      <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-4 py-3 mb-6 flex items-start gap-3">
        <AlertTriangle className="h-4 w-4 text-yellow-500 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-yellow-400">
          <span className="font-semibold">Educational purposes only.</span> AI signals are not financial advice.
          The AI searches for publicly available information but may be outdated or inaccurate.
          Always do your own research before making any investment decisions.
        </p>
      </div>

      {/* Search */}
      <Card className="mb-6">
        <CardHeader title="Scan a Stock" subtitle="Enter a ticker symbol to get an AI-powered analysis" icon={<Search className="h-4 w-4" />} />

        <div className="flex gap-2">
          <input
            type="text"
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === 'Enter' && runScan()}
            placeholder="e.g. AAPL, TSLA, LLOY..."
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 font-mono"
          />
          <Button onClick={() => runScan()} loading={loading} icon={<Zap className="h-4 w-4" />}>
            Analyse
          </Button>
        </div>

        {/* Quick tickers */}
        <div className="mt-4">
          <p className="text-xs text-gray-600 mb-2">Popular tickers:</p>
          <div className="flex flex-wrap gap-1.5">
            {POPULAR_TICKERS.map((t) => (
              <button
                key={t}
                onClick={() => runScan(t)}
                disabled={loading}
                className="px-2.5 py-1 text-xs font-mono bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-emerald-500 text-gray-400 hover:text-emerald-400 rounded-md transition-colors disabled:opacity-50"
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {portfolioTickers.length > 0 && (
          <div className="mt-3">
            <p className="text-xs text-gray-600 mb-2">From your portfolio:</p>
            <div className="flex flex-wrap gap-1.5">
              {portfolioTickers.map((t) => (
                <button
                  key={t}
                  onClick={() => runScan(t)}
                  disabled={loading}
                  className="px-2.5 py-1 text-xs font-mono bg-emerald-600/10 hover:bg-emerald-600/20 border border-emerald-600/20 hover:border-emerald-500/40 text-emerald-400 rounded-md transition-colors disabled:opacity-50"
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        )}
      </Card>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 mb-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Current result */}
      {loading && (
        <Card className="mb-6">
          <div className="flex items-center gap-3 py-4 justify-center">
            <RefreshCw className="h-5 w-5 text-emerald-400 animate-spin" />
            <span className="text-gray-400 text-sm">Claude AI is searching and analysing…</span>
          </div>
        </Card>
      )}

      {currentSignal && !loading && (
        <Card className="mb-6 border-emerald-500/30">
          <div className="flex items-start justify-between mb-4">
            <div>
              <div className="flex items-center gap-3">
                <span className="text-2xl font-bold text-white font-mono">{currentSignal.ticker}</span>
                <Badge variant={currentSignal.signal.toLowerCase() as 'buy' | 'sell' | 'hold'}>
                  <SignalIcon signal={currentSignal.signal} />
                  <span className="ml-1">{currentSignal.signal}</span>
                </Badge>
              </div>
              <p className="text-xs text-gray-500 mt-1 flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {new Date(currentSignal.timestamp).toLocaleString('en-GB')}
              </p>
            </div>
            <div className="text-right">
              <div className="text-xs text-gray-500">Confidence</div>
              <div className="text-xl font-bold text-white">{currentSignal.confidence}%</div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <div className="text-xs text-gray-500 mb-1">Risk Score</div>
              <div className="text-lg font-bold text-white">{currentSignal.riskScore}/100</div>
              <RiskBar score={currentSignal.riskScore} />
            </div>
            <div>
              <div className="text-xs text-gray-500 mb-1">Signal</div>
              <div className={clsx(
                'text-lg font-bold',
                currentSignal.signal === 'BUY' ? 'text-emerald-400' :
                currentSignal.signal === 'SELL' ? 'text-red-400' : 'text-yellow-400'
              )}>
                {currentSignal.signal}
              </div>
            </div>
          </div>

          <div className="bg-gray-800 rounded-lg p-3 mb-3">
            <div className="text-xs text-gray-500 mb-1.5">AI Analysis</div>
            <p className="text-sm text-gray-300 leading-relaxed">{currentSignal.reasoning}</p>
          </div>

          {currentSignal.sources.length > 0 && (
            <div>
              <div className="text-xs text-gray-500 mb-1.5">Sources Referenced</div>
              <div className="flex flex-wrap gap-1.5">
                {currentSignal.sources.map((src, i) => (
                  <span key={i} className="text-xs bg-gray-800 border border-gray-700 px-2 py-0.5 rounded text-gray-400">
                    {src}
                  </span>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Signal history */}
      {signals.length > 0 && (
        <Card>
          <CardHeader
            title="Signal History"
            subtitle={`${signals.length} analyses this session`}
            icon={<Clock className="h-4 w-4" />}
          />
          <div className="space-y-2">
            {signals.map((signal, i) => (
              <div
                key={i}
                className="flex items-center justify-between py-2.5 px-3 bg-gray-800/50 rounded-lg border border-gray-700/50"
              >
                <div className="flex items-center gap-3">
                  <span className="font-mono font-semibold text-white text-sm w-16">{signal.ticker}</span>
                  <Badge variant={signal.signal.toLowerCase() as 'buy' | 'sell' | 'hold'}>
                    {signal.signal}
                  </Badge>
                  <span className="text-xs text-gray-500">
                    Risk {signal.riskScore}/100 · {signal.confidence}% confidence
                  </span>
                </div>
                <div className="text-xs text-gray-600 hidden sm:block">
                  {new Date(signal.timestamp).toLocaleDateString('en-GB')}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {signals.length === 0 && !currentSignal && !loading && (
        <div className="text-center py-12">
          <Zap className="h-12 w-12 text-gray-700 mx-auto mb-4" />
          <p className="text-gray-500 text-sm">Enter a ticker above to run your first AI analysis</p>
          <p className="text-gray-600 text-xs mt-1">
            Requires ANTHROPIC_API_KEY — demo mode returns simulated signals
          </p>
        </div>
      )}
    </div>
  );
}

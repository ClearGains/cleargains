'use client';

import { useState } from 'react';
import {
  Search,
  Newspaper,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Minus,
  Clock,
  RefreshCw,
  ExternalLink,
} from 'lucide-react';
import { useClearGainsStore } from '@/lib/store';
import { Signal } from '@/lib/types';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { clsx } from 'clsx';

type NewsArticle = {
  title: string;
  source: string;
  pubDate: string;
  link: string;
};

type ScanResult = {
  ticker: string;
  signal: 'BUY' | 'SELL' | 'HOLD';
  label: string;
  bullishCount: number;
  bearishCount: number;
  summary: string;
  articles: NewsArticle[];
  fetchError: string | null;
  timestamp: string;
  riskScore: number;
  confidence: number;
  reasoning: string;
  sources: string[];
};

const POPULAR_TICKERS = [
  'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN',
  'GOOGL', 'META', 'AVGO', 'TSM', 'ASML',
  'BP', 'LLOY', 'VOD', 'GSK', 'RIO',
];

function OutlookBadge({ signal, label }: { signal: string; label: string }) {
  const icon =
    signal === 'BUY' ? <TrendingUp className="h-3.5 w-3.5" /> :
    signal === 'SELL' ? <TrendingDown className="h-3.5 w-3.5" /> :
    <Minus className="h-3.5 w-3.5" />;

  return (
    <Badge variant={signal.toLowerCase() as 'buy' | 'sell' | 'hold'}>
      {icon}
      <span className="ml-1">{label}</span>
    </Badge>
  );
}

function formatDate(dateStr: string) {
  try {
    return new Date(dateStr).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

export default function ScannerPage() {
  const { signals, addSignal, t212Positions } = useClearGainsStore();
  const [ticker, setTicker] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);

  async function runScan(symbol?: string) {
    const target = (symbol ?? ticker).trim().toUpperCase();
    if (!target) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch('/api/ai-scanner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: target }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? 'Scan failed');
      } else {
        setResult(data);
        // Save to signal history (uses legacy Signal fields)
        const signal: Signal = {
          ticker: data.ticker,
          signal: data.signal,
          riskScore: data.riskScore,
          confidence: data.confidence,
          reasoning: data.reasoning,
          sources: data.sources,
          timestamp: data.timestamp,
        };
        addSignal(signal);
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
          <Newspaper className="h-6 w-6 text-emerald-400" />
          News Scanner
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Fetches the latest news for a stock and derives a market outlook from headline sentiment
        </p>
      </div>

      {/* Disclaimer */}
      <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-4 py-3 mb-6 flex items-start gap-3">
        <AlertTriangle className="h-4 w-4 text-yellow-500 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-yellow-400">
          <span className="font-semibold">Educational purposes only.</span> Outlook is derived from
          keyword sentiment in news headlines — not financial advice. Always do your own research
          before making any investment decisions.
        </p>
      </div>

      {/* Search */}
      <Card className="mb-6">
        <CardHeader
          title="Scan a Stock"
          subtitle="Enter a ticker to fetch latest news and sentiment"
          icon={<Search className="h-4 w-4" />}
        />

        <div className="flex gap-2">
          <input
            type="text"
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === 'Enter' && runScan()}
            placeholder="e.g. AAPL, TSLA, LLOY..."
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 font-mono"
          />
          <Button onClick={() => runScan()} loading={loading} icon={<Search className="h-4 w-4" />}>
            Scan News
          </Button>
        </div>

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

      {loading && (
        <Card className="mb-6">
          <div className="flex items-center gap-3 py-4 justify-center">
            <RefreshCw className="h-5 w-5 text-emerald-400 animate-spin" />
            <span className="text-gray-400 text-sm">Fetching latest news…</span>
          </div>
        </Card>
      )}

      {result && !loading && (
        <div className="mb-6 space-y-4">
          {/* Outlook summary */}
          <Card className="border-emerald-500/20">
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-3">
                <span className="text-2xl font-bold text-white font-mono">{result.ticker}</span>
                <OutlookBadge signal={result.signal} label={result.label} />
              </div>
              <p className="text-xs text-gray-600 flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {new Date(result.timestamp).toLocaleString('en-GB')}
              </p>
            </div>

            {/* Sentiment bar */}
            <div className="flex items-center gap-3 mb-3">
              <span className="text-xs text-emerald-400 w-20 flex-shrink-0">
                {result.bullishCount} bullish
              </span>
              <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden flex">
                {(result.bullishCount + result.bearishCount) > 0 && (
                  <>
                    <div
                      className="h-full bg-emerald-500 transition-all"
                      style={{ width: `${(result.bullishCount / (result.bullishCount + result.bearishCount)) * 100}%` }}
                    />
                    <div className="h-full bg-red-500 flex-1" />
                  </>
                )}
              </div>
              <span className="text-xs text-red-400 w-20 flex-shrink-0 text-right">
                {result.bearishCount} bearish
              </span>
            </div>

            <p className="text-xs text-gray-400 leading-relaxed">{result.summary}</p>

            {result.fetchError && (
              <p className="text-xs text-yellow-500/80 mt-2">
                Note: news fetch issue — {result.fetchError}
              </p>
            )}
          </Card>

          {/* News articles */}
          {result.articles.length > 0 && (
            <Card>
              <CardHeader
                title="Recent News"
                subtitle={`${result.articles.length} articles`}
                icon={<Newspaper className="h-4 w-4" />}
              />
              <div className="space-y-0 divide-y divide-gray-800">
                {result.articles.map((article, i) => {
                  const lower = article.title.toLowerCase();
                  const isBullish = BULLISH_WORDS.some((w) => lower.includes(w));
                  const isBearish = BEARISH_WORDS.some((w) => lower.includes(w));
                  return (
                    <div key={i} className="py-3 flex items-start gap-3">
                      <div
                        className={clsx(
                          'w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5',
                          isBullish && !isBearish ? 'bg-emerald-400' :
                          isBearish && !isBullish ? 'bg-red-400' : 'bg-gray-600'
                        )}
                      />
                      <div className="flex-1 min-w-0">
                        {article.link ? (
                          <a
                            href={article.link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm text-gray-200 hover:text-white leading-snug flex items-start gap-1 group"
                          >
                            <span>{article.title}</span>
                            <ExternalLink className="h-3 w-3 flex-shrink-0 mt-0.5 opacity-0 group-hover:opacity-60 transition-opacity" />
                          </a>
                        ) : (
                          <p className="text-sm text-gray-200 leading-snug">{article.title}</p>
                        )}
                        <div className="flex items-center gap-2 mt-1">
                          {article.source && (
                            <span className="text-xs text-gray-500">{article.source}</span>
                          )}
                          {article.pubDate && (
                            <span className="text-xs text-gray-600">{formatDate(article.pubDate)}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {result.articles.length === 0 && (
            <Card>
              <div className="text-center py-6">
                <Newspaper className="h-8 w-8 text-gray-700 mx-auto mb-2" />
                <p className="text-sm text-gray-500">No news articles found for {result.ticker}</p>
                <p className="text-xs text-gray-600 mt-1">Try a different ticker or check back later</p>
              </div>
            </Card>
          )}
        </div>
      )}

      {/* Scan history */}
      {signals.length > 0 && !loading && (
        <Card>
          <CardHeader
            title="Scan History"
            subtitle={`${signals.length} tickers scanned`}
            icon={<Clock className="h-4 w-4" />}
          />
          <div className="space-y-2">
            {signals.map((signal, i) => (
              <div
                key={i}
                className="flex items-center justify-between py-2.5 px-3 bg-gray-800/50 rounded-lg border border-gray-700/50 cursor-pointer hover:bg-gray-800"
                onClick={() => runScan(signal.ticker)}
              >
                <div className="flex items-center gap-3">
                  <span className="font-mono font-semibold text-white text-sm w-16">{signal.ticker}</span>
                  <Badge variant={signal.signal.toLowerCase() as 'buy' | 'sell' | 'hold'}>
                    {signal.signal === 'BUY' ? 'Bullish' : signal.signal === 'SELL' ? 'Bearish' : 'Neutral'}
                  </Badge>
                </div>
                <div className="text-xs text-gray-600 hidden sm:block">
                  {new Date(signal.timestamp).toLocaleDateString('en-GB')}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {signals.length === 0 && !result && !loading && (
        <div className="text-center py-12">
          <Newspaper className="h-12 w-12 text-gray-700 mx-auto mb-4" />
          <p className="text-gray-500 text-sm">Enter a ticker above to fetch the latest news</p>
        </div>
      )}
    </div>
  );
}

// Keyword lists referenced in JSX for dot colour logic
const BULLISH_WORDS = [
  'beat', 'beats', 'surge', 'soar', 'gain', 'rises', 'rally', 'record',
  'upgrade', 'upgraded', 'outperform', 'growth', 'profit', 'boost',
  'strong', 'positive', 'raises', 'raised', 'exceed', 'exceeded', 'jumps',
];
const BEARISH_WORDS = [
  'miss', 'misses', 'fall', 'falls', 'drop', 'drops', 'decline', 'plunge',
  'downgrade', 'downgraded', 'underperform', 'loss', 'losses', 'cut', 'cuts',
  'weak', 'concern', 'risk', 'negative', 'slump', 'warns', 'warning',
];

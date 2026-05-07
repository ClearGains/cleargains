'use client';

import { useState } from 'react';
import { Newspaper, ExternalLink, Loader2 } from 'lucide-react';

type NewsItem = { headline: string; source: string; url: string; datetime: number };

export function NewsStrip({ symbol }: { symbol: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done'>('idle');
  const [news, setNews]   = useState<NewsItem[]>([]);

  async function load() {
    if (state !== 'idle') return;
    setState('loading');
    try {
      const r = await fetch(`/api/market/news?symbol=${encodeURIComponent(symbol)}`);
      setNews(await r.json() as NewsItem[]);
    } catch { /* no-op — fail silently */ }
    setState('done');
  }

  if (state === 'idle') return (
    <button
      onClick={load}
      className="flex items-center gap-1.5 text-[10px] text-gray-700 hover:text-gray-400 transition-colors"
    >
      <Newspaper className="h-3 w-3" />
      Load recent news
    </button>
  );

  if (state === 'loading') return (
    <div className="flex items-center gap-1.5 text-[10px] text-gray-600">
      <Loader2 className="h-3 w-3 animate-spin" />
      Fetching news…
    </div>
  );

  if (news.length === 0) return (
    <p className="text-[10px] text-gray-700">No recent news found for {symbol}</p>
  );

  return (
    <div className="space-y-2">
      <div className="text-[9px] text-gray-600 uppercase tracking-wider font-semibold flex items-center gap-1">
        <Newspaper className="h-2.5 w-2.5" />
        Recent News
      </div>
      {news.map((n, i) => (
        <a
          key={i}
          href={n.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-start gap-2 group"
        >
          <ExternalLink className="h-2.5 w-2.5 text-gray-700 mt-0.5 shrink-0 group-hover:text-blue-400 transition-colors" />
          <div>
            <p className="text-[10px] text-gray-400 group-hover:text-gray-200 leading-snug transition-colors">
              {n.headline}
            </p>
            <p className="text-[9px] text-gray-700 mt-0.5">
              {n.source}
              {n.datetime > 0 && ` · ${new Date(n.datetime * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`}
            </p>
          </div>
        </a>
      ))}
    </div>
  );
}

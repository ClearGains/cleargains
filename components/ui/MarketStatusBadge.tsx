'use client';

import { useState, useEffect } from 'react';
import { getMarketStatus, getActiveForexSessions, formatNextOpen } from '@/lib/marketHours';
import type { ForexSession } from '@/lib/marketHours';

const SESSION_LABELS: Record<ForexSession, string> = {
  sydney: 'Sydney',
  tokyo: 'Tokyo',
  london: 'London',
  'new-york': 'New York',
};

function getLocalTimeStr(): string {
  return new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
}

export function MarketStatusBadge({ showForex = false }: { showForex?: boolean }) {
  const [status, setStatus] = useState(() => getMarketStatus());
  const [forexSessions, setForexSessions] = useState(() => getActiveForexSessions());
  const [localTime, setLocalTime] = useState(() => getLocalTimeStr());

  useEffect(() => {
    function tick() {
      setStatus(getMarketStatus());
      setForexSessions(getActiveForexSessions());
      setLocalTime(getLocalTimeStr());
    }
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);

  const { status: mStatus, nextOpenStr } = status;
  const nextOpen = formatNextOpen(nextOpenStr);

  const dotColor =
    mStatus === 'open' ? 'bg-emerald-400' :
    mStatus === 'pre-post' ? 'bg-amber-400' :
    'bg-red-500';

  const textColor =
    mStatus === 'open' ? 'text-emerald-400' :
    mStatus === 'pre-post' ? 'text-amber-400' :
    'text-red-400';

  const label =
    mStatus === 'open' ? 'Market Open' :
    mStatus === 'pre-post' ? 'Pre/After Market' :
    'Market Closed';

  return (
    <div className="inline-flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`} />
        <span className={`text-sm font-medium ${textColor}`}>{label}</span>
      </div>
      <p className="text-xs text-gray-500 pl-3.5">{localTime}</p>
      {mStatus === 'closed' && nextOpen && (
        <p className="text-xs text-gray-500 pl-3.5">Next: {nextOpen}</p>
      )}
      {showForex && (
        <div className="flex flex-wrap gap-1 pl-3.5 mt-0.5">
          {forexSessions.length === 0 ? (
            <span className="text-xs text-gray-600">No active sessions</span>
          ) : (
            forexSessions.map(s => (
              <span
                key={s}
                className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-500/15 text-blue-400 border border-blue-500/20"
              >
                {SESSION_LABELS[s]}
              </span>
            ))
          )}
        </div>
      )}
    </div>
  );
}

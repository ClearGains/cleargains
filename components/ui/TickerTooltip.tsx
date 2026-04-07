'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { clsx } from 'clsx';

type ProfileData = {
  symbol: string;
  name: string | null;
  exchange: string | null;
  industry: string | null;
  marketCap: number | null;
  logo: string | null;
  price: number | null;
  changePercent: number | null;
};

const CACHE_PREFIX = 'ticker_profile_';
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

function getCached(symbol: string): ProfileData | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + symbol);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw) as { data: ProfileData; ts: number };
    if (Date.now() - ts > CACHE_TTL) return null;
    return data;
  } catch {
    return null;
  }
}

function setCache(symbol: string, data: ProfileData) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(CACHE_PREFIX + symbol, JSON.stringify({ data, ts: Date.now() }));
  } catch {}
}

export function TickerTooltip({
  symbol,
  children,
}: {
  symbol: string;
  children: React.ReactNode;
}) {
  const [visible, setVisible] = useState(false);
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLSpanElement>(null);

  const fetchProfile = useCallback(async () => {
    const cached = getCached(symbol);
    if (cached) { setProfile(cached); return; }

    setLoading(true);
    try {
      const res = await fetch(`/api/stock/profile?symbol=${encodeURIComponent(symbol)}`);
      if (res.ok) {
        const data = await res.json() as ProfileData;
        setProfile(data);
        setCache(symbol, data);
      }
    } catch {}
    setLoading(false);
  }, [symbol]);

  function handleMouseEnter() {
    hoverTimer.current = setTimeout(() => {
      setVisible(true);
      fetchProfile();
    }, 300);
  }

  function handleMouseLeave() {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setVisible(false);
  }

  useEffect(() => {
    return () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); };
  }, []);

  return (
    <span
      ref={containerRef}
      className="relative inline-block cursor-default"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
      {visible && (
        <div className="absolute bottom-full left-0 mb-2 z-50 w-56 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl p-3 text-left pointer-events-none">
          {loading && !profile ? (
            <div className="text-xs text-gray-500">Loading…</div>
          ) : profile ? (
            <>
              <div className="flex items-center gap-2 mb-2">
                {profile.logo && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={profile.logo} alt="" className="h-5 w-5 rounded object-contain bg-white p-0.5" />
                )}
                <div>
                  <div className="text-xs font-semibold text-white leading-tight">
                    {profile.name ?? symbol}
                  </div>
                  {profile.exchange && (
                    <div className="text-[10px] text-gray-500">{profile.exchange}</div>
                  )}
                </div>
              </div>
              <div className="space-y-1">
                {profile.price != null && (
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-500">Price</span>
                    <span className="text-white font-mono">${profile.price.toFixed(2)}</span>
                  </div>
                )}
                {profile.changePercent != null && (
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-500">Change</span>
                    <span className={clsx('font-mono font-semibold', profile.changePercent >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                      {profile.changePercent >= 0 ? '+' : ''}{profile.changePercent.toFixed(2)}%
                    </span>
                  </div>
                )}
                {profile.marketCap != null && profile.marketCap > 0 && (
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-500">Market Cap</span>
                    <span className="text-gray-300 font-mono">
                      ${profile.marketCap >= 1000
                        ? `${(profile.marketCap / 1000).toFixed(1)}B`
                        : `${profile.marketCap.toFixed(0)}M`}
                    </span>
                  </div>
                )}
                {profile.industry && (
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-500">Sector</span>
                    <span className="text-gray-300 text-right max-w-[120px] truncate">{profile.industry}</span>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="text-xs text-gray-500">No data available</div>
          )}
        </div>
      )}
    </span>
  );
}

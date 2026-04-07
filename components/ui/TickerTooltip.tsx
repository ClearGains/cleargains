'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { clsx } from 'clsx';
import { useClearGainsStore } from '@/lib/store';
import { DemoPosition, DemoTrade } from '@/lib/types';
import { TrendingUp, TrendingDown, FlaskConical } from 'lucide-react';

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
  } catch { return null; }
}

function setCache(symbol: string, data: ProfileData) {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(CACHE_PREFIX + symbol, JSON.stringify({ data, ts: Date.now() })); } catch {}
}

function uid() { return Math.random().toString(36).slice(2, 10); }

const CARD_W = 256;
const CARD_H = 270; // estimated max height

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
  const [cardPos, setCardPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [actionDone, setActionDone] = useState<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const {
    demoPositions, paperBudget, addDemoPosition,
    removeDemoPosition, addDemoTrade, updateDemoPosition,
  } = useClearGainsStore();

  const openPosition = demoPositions.find(p => p.ticker === symbol) ?? null;

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

  function handleMouseEnter(e: React.MouseEvent) {
    const { clientX, clientY } = e;
    // Place card right of cursor; adjust if near edges
    let x = clientX + 16;
    let y = clientY - 20;
    if (typeof window !== 'undefined') {
      if (x + CARD_W > window.innerWidth - 8) x = clientX - CARD_W - 8;
      if (y + CARD_H > window.innerHeight - 8) y = window.innerHeight - CARD_H - 8;
      if (y < 8) y = 8;
    }
    setCardPos({ x, y });

    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      setVisible(true);
      fetchProfile();
    }, 200);
  }

  function handleMouseLeave() {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setVisible(false);
    setActionDone(null);
  }

  useEffect(() => {
    return () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      if (actionTimer.current) clearTimeout(actionTimer.current);
    };
  }, []);

  function handleBuy() {
    const price = profile?.price;
    if (!price || price <= 0) return;
    const invested = demoPositions.reduce((s, p) => s + p.entryPrice * p.quantity, 0);
    const available = Math.max(0, paperBudget - invested);
    const size = Math.min(100, available);
    if (size <= 0) { setActionDone('Insufficient paper budget'); return; }
    const quantity = Math.max(1, Math.floor(size / price));
    addDemoPosition({
      id: uid(),
      ticker: symbol,
      t212Ticker: symbol + '_US_EQ',
      companyName: profile?.name ?? symbol,
      sector: profile?.industry ?? 'Unknown',
      quantity,
      entryPrice: price,
      currentPrice: price,
      stopLoss: price * 0.98,
      takeProfit: price * 1.04,
      pnl: 0,
      pnlPct: 0,
      openedAt: new Date().toISOString(),
      signal: 'Tooltip quick-buy',
    });
    setActionDone(`Bought ${quantity}× @ $${price.toFixed(2)}`);
    actionTimer.current = setTimeout(() => setActionDone(null), 3000);
  }

  function handleSell() {
    if (!openPosition) return;
    const exitPrice = profile?.price ?? openPosition.currentPrice;
    const pnl = (exitPrice - openPosition.entryPrice) * openPosition.quantity;
    const pnlPct = ((exitPrice - openPosition.entryPrice) / openPosition.entryPrice) * 100;
    updateDemoPosition(openPosition.id, { currentPrice: exitPrice, pnl, pnlPct });
    addDemoTrade({
      id: uid(),
      ticker: openPosition.ticker,
      t212Ticker: openPosition.t212Ticker,
      companyName: openPosition.companyName,
      sector: openPosition.sector,
      quantity: openPosition.quantity,
      entryPrice: openPosition.entryPrice,
      exitPrice,
      pnl,
      pnlPct,
      openedAt: openPosition.openedAt,
      closedAt: new Date().toISOString(),
      closeReason: 'manual',
    } as DemoTrade);
    removeDemoPosition(openPosition.id);
    const sign = pnl >= 0 ? '+' : '';
    setActionDone(`Sold — P&L: ${sign}$${pnl.toFixed(2)}`);
    actionTimer.current = setTimeout(() => setActionDone(null), 3000);
  }

  return (
    <span
      className="relative inline-block cursor-default"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}

      {visible && (
        <div
          className="fixed z-[9999] bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden pointer-events-auto"
          style={{ left: cardPos.x, top: cardPos.y, minWidth: CARD_W }}
          onMouseEnter={() => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }}
          onMouseLeave={handleMouseLeave}
        >
          {loading && !profile ? (
            <div className="p-4 text-xs text-gray-500 flex items-center gap-2">
              <span className="h-3 w-3 rounded-full border-2 border-gray-600 border-t-emerald-400 animate-spin inline-block" />
              Loading…
            </div>
          ) : profile ? (
            <>
              {/* Header */}
              <div className="px-4 pt-4 pb-3 border-b border-gray-800">
                <div className="flex items-start gap-2.5">
                  {profile.logo && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={profile.logo} alt="" className="h-7 w-7 rounded object-contain bg-white p-0.5 flex-shrink-0 mt-0.5" />
                  )}
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-white leading-tight">
                      {profile.name ?? symbol}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {symbol}{profile.exchange ? ` · ${profile.exchange}` : ''}
                    </div>
                  </div>
                </div>
              </div>

              {/* Price row */}
              <div className="px-4 py-3 border-b border-gray-800">
                {profile.price != null ? (
                  <div className="flex items-end justify-between">
                    <span className="text-xl font-bold text-white font-mono">
                      ${profile.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                    {profile.changePercent != null && (
                      <span className={clsx(
                        'flex items-center gap-1 text-sm font-semibold',
                        profile.changePercent >= 0 ? 'text-emerald-400' : 'text-red-400'
                      )}>
                        {profile.changePercent >= 0
                          ? <TrendingUp className="h-3.5 w-3.5" />
                          : <TrendingDown className="h-3.5 w-3.5" />}
                        {profile.changePercent >= 0 ? '+' : ''}{profile.changePercent.toFixed(2)}%
                      </span>
                    )}
                  </div>
                ) : (
                  <span className="text-xs text-gray-500">Price unavailable</span>
                )}
              </div>

              {/* Meta rows */}
              <div className="px-4 py-3 space-y-1.5 border-b border-gray-800">
                {profile.industry && (
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-500">Sector</span>
                    <span className="text-gray-300 text-right max-w-[140px] truncate">{profile.industry}</span>
                  </div>
                )}
                {profile.marketCap != null && profile.marketCap > 0 && (
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-500">Market cap</span>
                    <span className="text-gray-300 font-mono">
                      ${profile.marketCap >= 1000
                        ? `${(profile.marketCap / 1000).toFixed(1)}B`
                        : `${profile.marketCap.toFixed(0)}M`}
                    </span>
                  </div>
                )}
                {openPosition && (
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-500">Open position</span>
                    <span className={clsx('font-mono font-semibold', openPosition.pnl >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                      {openPosition.quantity}× {openPosition.pnl >= 0 ? '+' : ''}${openPosition.pnl.toFixed(2)}
                    </span>
                  </div>
                )}
              </div>

              {/* Action feedback */}
              {actionDone && (
                <div className="px-4 py-2 text-xs text-emerald-400 bg-emerald-500/10 border-b border-gray-800">
                  {actionDone}
                </div>
              )}

              {/* BUY / SELL buttons */}
              <div className="px-4 py-3 flex gap-2">
                <button
                  onClick={handleBuy}
                  disabled={!profile.price || profile.price <= 0}
                  className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <FlaskConical className="h-3.5 w-3.5" />
                  BUY
                </button>
                <button
                  onClick={handleSell}
                  disabled={!openPosition}
                  className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-semibold bg-red-500/15 text-red-400 border border-red-500/30 hover:bg-red-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  SELL
                </button>
              </div>
            </>
          ) : (
            <div className="p-4 text-xs text-gray-500">No data available</div>
          )}
        </div>
      )}
    </span>
  );
}

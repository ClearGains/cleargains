'use client';

// "Closed positions" card for the Alpaca and IG spread-bet tabs (2026-10-23).
// Reads the brokers' own records via /api/closed-positions, so it shows what
// actually happened (including stop-outs), whichever bot or person opened it.
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, RefreshCw, History } from 'lucide-react';
import { clsx } from 'clsx';

type ClosedTrade = {
  market: string; direction: 'long' | 'short'; qty: number | null;
  openedAt: string | null; closedAt: string; entry: number | null; exit: number | null;
  pl: number; heldHours: number | null; openedBy: 'opus' | 'other'; probe?: boolean;
};

const fmtTime = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtHeld = (h: number | null) => h === null ? '—' : h < 48 ? `${h.toFixed(h < 10 ? 1 : 0)}h` : `${(h / 24).toFixed(1)}d`;
const fmtNum = (n: number | null) => n === null ? '—' : Math.abs(n) >= 1000 ? n.toLocaleString('en-GB', { maximumFractionDigits: 2 }) : String(Math.round(n * 10000) / 10000);

export function ClosedPositionsCard({ broker, mode }: { broker: 'alpaca' | 'ig'; mode: string }) {
  const [open, setOpen]       = useState(true);
  const [days, setDays]       = useState(7);
  const [trades, setTrades]   = useState<ClosedTrade[] | null>(null);
  const [currency, setCurrency] = useState<'$' | '£'>(broker === 'alpaca' ? '$' : '£');
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/closed-positions?broker=${broker}&mode=${encodeURIComponent(mode)}&days=${days}`, { cache: 'no-store' });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error ?? 'Failed to load');
      setTrades(d.trades); setCurrency(d.currency);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [broker, mode, days]);

  useEffect(() => { if (open) void load(); }, [open, load]);

  const total = (trades ?? []).reduce((s, t) => s + t.pl, 0);
  const wins  = (trades ?? []).filter(t => t.pl > 0).length;
  const money = (n: number) => `${n < 0 ? '−' : n > 0 ? '+' : ''}${currency}${Math.abs(n).toFixed(2)}`;

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <button onClick={() => setOpen(o => !o)} className="flex items-center gap-2 text-sm font-semibold text-slate-200 mr-auto">
          <History className="w-4 h-4 text-slate-400" />
          Closed positions
          {trades && <span className="text-xs font-normal text-slate-500">({trades.length} · {wins} won · <span className={total >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{money(total)}</span>)</span>}
          {open ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
        </button>
        {open && <>
          {[7, 30].map(d => (
            <button key={d} onClick={() => setDays(d)}
              className={clsx('px-2 py-1 rounded text-xs', days === d ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200')}>
              {d === 7 ? 'Last 7 days' : 'Last 30 days'}
            </button>
          ))}
          <button onClick={() => void load()} title="Refresh" className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-400">
            <RefreshCw className={clsx('w-3.5 h-3.5', loading && 'animate-spin')} />
          </button>
        </>}
      </div>

      {open && (
        <div className="px-4 pb-4">
          {error && <div className="text-xs text-rose-400 py-2">{error}</div>}
          {!error && trades === null && <div className="text-xs text-slate-500 py-2">Loading from the broker…</div>}
          {!error && trades && trades.length === 0 && <div className="text-xs text-slate-500 py-2">No positions closed in the last {days} days.</div>}
          {!error && trades && trades.length > 0 && (
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-xs min-w-[640px]">
                <thead>
                  <tr className="text-slate-500 text-left">
                    <th className="px-1 py-1.5 font-medium">Closed</th>
                    <th className="px-1 py-1.5 font-medium">Market</th>
                    <th className="px-1 py-1.5 font-medium">Side</th>
                    <th className="px-1 py-1.5 font-medium text-right">Entry → exit</th>
                    <th className="px-1 py-1.5 font-medium text-right">Held</th>
                    <th className="px-1 py-1.5 font-medium text-right">P&amp;L</th>
                    <th className="px-1 py-1.5 font-medium">Opened by</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t, i) => (
                    <tr key={`${t.closedAt}-${t.market}-${i}`} className="border-t border-slate-800/70">
                      <td className="px-1 py-1.5 text-slate-400 whitespace-nowrap">{fmtTime(t.closedAt)}</td>
                      <td className="px-1 py-1.5 text-slate-200">{t.market}{t.qty !== null && <span className="text-slate-500"> ×{t.qty}</span>}</td>
                      <td className={clsx('px-1 py-1.5', t.direction === 'long' ? 'text-emerald-400' : 'text-rose-400')}>{t.direction === 'long' ? 'Long' : 'Short'}</td>
                      <td className="px-1 py-1.5 text-right text-slate-300 whitespace-nowrap">{fmtNum(t.entry)} → {fmtNum(t.exit)}</td>
                      <td className="px-1 py-1.5 text-right text-slate-400">{fmtHeld(t.heldHours)}</td>
                      <td className={clsx('px-1 py-1.5 text-right font-medium whitespace-nowrap', t.pl > 0 ? 'text-emerald-400' : t.pl < 0 ? 'text-rose-400' : 'text-slate-400')}>{money(t.pl)}</td>
                      <td className="px-1 py-1.5">
                        {t.openedBy === 'opus'
                          ? <span className="px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300">Opus{t.probe ? ' (probe)' : ''}</span>
                          : <span className="text-slate-500">Other bot / manual</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

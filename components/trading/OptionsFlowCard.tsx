'use client';

// Options positioning card for the Alpaca tab (2026-10-29): for the stocks we
// hold options on (or any ticker typed in), how much is riding on calls vs
// puts, the strikes with the biggest open bets, and fresh money today.
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, RefreshCw, Layers, Search } from 'lucide-react';
import { clsx } from 'clsx';

type Strike = { strike: number; oi: number };
type Flow = {
  symbol: string; price: number; asOf: string; error?: string;
  callOI: number; putOI: number; putCallOI: number | null;
  callVol: number; putVol: number; putCallVol: number | null;
  topCallStrikes: Strike[]; topPutStrikes: Strike[];
  unusual: Array<{ contract: string; type: 'call' | 'put'; strike: number; expiry: string; volume: number; oi: number }>;
};

const n = (x: number) => x.toLocaleString('en-GB');

function Split({ calls, puts, label }: { calls: number; puts: number; label: string }) {
  const total = calls + puts;
  const c = total > 0 ? Math.round((calls / total) * 100) : 50;
  return (
    <div className="text-xs">
      <div className="flex justify-between mb-0.5">
        <span className="text-slate-400">{label}</span>
        <span className="text-slate-500"><span className="text-emerald-400">calls {n(calls)}</span> · <span className="text-rose-400">puts {n(puts)}</span></span>
      </div>
      <div className="flex h-1.5 rounded overflow-hidden bg-slate-800">
        <div className="bg-emerald-500/70" style={{ width: `${c}%` }} />
        <div className="bg-rose-500/70" style={{ width: `${100 - c}%` }} />
      </div>
    </div>
  );
}

export function OptionsFlowCard() {
  const [open, setOpen]       = useState(true);
  const [flows, setFlows]     = useState<Flow[] | null>(null);
  const [query, setQuery]     = useState('');
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (symbols = '') => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/options-flow?symbols=${encodeURIComponent(symbols)}`, { cache: 'no-store' });
      const d = await res.json() as { ok: boolean; flows?: Flow[]; error?: string };
      if (!d.ok) throw new Error(d.error ?? 'Failed to load');
      setFlows(d.flows ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (open) void load(); }, [open, load]);

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <button onClick={() => setOpen(o => !o)} className="flex items-center gap-2 text-sm font-semibold text-slate-200 mr-auto">
          <Layers className="w-4 h-4 text-violet-400" />
          Options positioning
          <span className="text-xs font-normal text-slate-500">calls vs puts · where the big bets sit</span>
          {open ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
        </button>
        {open && <>
          <form onSubmit={e => { e.preventDefault(); void load(query); }} className="flex items-center gap-1">
            <input value={query} onChange={e => setQuery(e.target.value.toUpperCase())} placeholder="Ticker e.g. NVDA"
              className="w-28 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-xs text-slate-200 placeholder:text-slate-600" />
            <button type="submit" title="Look up" className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-400"><Search className="w-3.5 h-3.5" /></button>
          </form>
          <button onClick={() => { setQuery(''); void load(); }} title="Show held options" className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-400">
            <RefreshCw className={clsx('w-3.5 h-3.5', loading && 'animate-spin')} />
          </button>
        </>}
      </div>
      {open && (
        <div className="px-4 pb-4 space-y-3">
          <p className="text-xs text-slate-500">
            For the stocks we hold options on (or any ticker you look up), expiries up to 6 months: open bets in calls vs puts, today&apos;s trading, the strikes with the most open contracts, and &quot;fresh money&quot;: contracts that traded more today than were open, which usually means new positions, often from bigger players. Funds buy puts as insurance, so lots of puts isn&apos;t automatically bearish.
          </p>
          {error && <div className="text-xs text-rose-400">{error}</div>}
          {!error && flows === null && <div className="text-xs text-slate-500">Loading from Alpaca…</div>}
          {flows && flows.length === 0 && <div className="text-xs text-slate-500">No options held right now. Type a ticker to look one up.</div>}
          {flows?.map(f => f.error ? (
            <div key={f.symbol} className="text-xs text-rose-400">{f.symbol}: {f.error}</div>
          ) : (
            <div key={f.symbol} className="border-t border-slate-800 pt-3 space-y-2">
              <div className="text-sm text-slate-200 font-semibold">{f.symbol} <span className="text-xs font-normal text-slate-500">${f.price.toFixed(2)}</span></div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Split calls={f.callOI} puts={f.putOI} label={`Open bets (put/call ${f.putCallOI ?? '—'})`} />
                <Split calls={f.callVol} puts={f.putVol} label={`Traded today (put/call ${f.putCallVol ?? '—'})`} />
              </div>
              <div className="grid gap-1 sm:grid-cols-2 text-xs text-slate-400">
                <div>Biggest call strikes: {f.topCallStrikes.map(s => <span key={s.strike} className="text-emerald-400/90 mr-2">${s.strike} ({n(s.oi)})</span>)}</div>
                <div>Biggest put strikes: {f.topPutStrikes.map(s => <span key={s.strike} className="text-rose-400/90 mr-2">${s.strike} ({n(s.oi)})</span>)}</div>
              </div>
              <div className="text-xs">
                {f.unusual.length ? (
                  <div className="text-slate-400">Fresh money today:{' '}
                    {f.unusual.map(u => (
                      <span key={u.contract} className={clsx('mr-3', u.type === 'call' ? 'text-emerald-400' : 'text-rose-400')}>
                        ${u.strike} {u.type} {new Date(u.expiry).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}: {n(u.volume)} traded vs {n(u.oi)} open
                      </span>
                    ))}
                  </div>
                ) : <div className="text-slate-600">No unusual fresh positioning today.</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

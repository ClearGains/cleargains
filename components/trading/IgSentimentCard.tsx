'use client';

// IG client sentiment card (2026-10-29): what share of IG's clients are long
// vs short each market the bots trade. Refreshes every 5 minutes.
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, RefreshCw, Users } from 'lucide-react';
import { clsx } from 'clsx';

type Row = { key: string; name: string; epic: string; longPct: number; shortPct: number };

export function IgSentimentCard() {
  const [open, setOpen]       = useState(true);
  const [rows, setRows]       = useState<Row[] | null>(null);
  const [at, setAt]           = useState<string | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/ig-sentiment', { cache: 'no-store' });
      const d = await res.json() as { ok: boolean; rows?: Row[]; at?: string; error?: string };
      if (!d.ok) throw new Error(d.error ?? 'Failed to load');
      setRows(d.rows ?? []); setAt(d.at ?? null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
    const t = setInterval(() => void load(), 5 * 60_000);
    return () => clearInterval(t);
  }, [open, load]);

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <button onClick={() => setOpen(o => !o)} className="flex items-center gap-2 text-sm font-semibold text-slate-200 mr-auto">
          <Users className="w-4 h-4 text-sky-400" />
          Buyers vs sellers
          <span className="text-xs font-normal text-slate-500">IG client sentiment{at ? ` · ${new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : ''}</span>
          {open ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
        </button>
        {open && <button onClick={() => void load()} title="Refresh" className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-400">
          <RefreshCw className={clsx('w-3.5 h-3.5', loading && 'animate-spin')} />
        </button>}
      </div>
      {open && (
        <div className="px-4 pb-4 space-y-2">
          <p className="text-xs text-slate-500">
            Share of IG&apos;s clients holding a long (buy) or short (sell) bet. They&apos;re mostly individual traders, so a very one-sided crowd (75%+) is often treated as a sign the market may go the other way. Opus sees these numbers too.
          </p>
          {error && <div className="text-xs text-rose-400">{error}</div>}
          {!error && rows === null && <div className="text-xs text-slate-500">Loading from IG…</div>}
          {rows && rows.length > 0 && (
            <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
              {rows.map(r => {
                const extreme = Math.max(r.longPct, r.shortPct) >= 75;
                return (
                  <div key={r.key} className="text-xs">
                    <div className="flex justify-between mb-0.5">
                      <span className="text-slate-300">{r.name}{extreme && <span className="ml-1.5 text-amber-400">one-sided</span>}</span>
                      <span className="text-slate-500"><span className="text-emerald-400">{r.longPct}% buying</span> · <span className="text-rose-400">{r.shortPct}% selling</span></span>
                    </div>
                    <div className="flex h-1.5 rounded overflow-hidden bg-slate-800">
                      <div className="bg-emerald-500/70" style={{ width: `${r.longPct}%` }} />
                      <div className="bg-rose-500/70" style={{ width: `${r.shortPct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

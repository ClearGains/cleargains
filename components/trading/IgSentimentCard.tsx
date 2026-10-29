'use client';

// Buyers vs sellers card (2026-10-29). Two views of positioning for the
// markets the bots trade:
//  - Big money: CFTC Commitments of Traders, funds and large speculators in
//    the US futures (weekly). The one that matters.
//  - Retail: IG client sentiment, share of IG's clients long vs short (live).
//    Owner: retail positioning means little next to the institutions'.
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, RefreshCw, Users } from 'lucide-react';
import { clsx } from 'clsx';

type Row = { key: string; name: string; epic: string; longPct: number; shortPct: number };
type Cot = { key: string; market: string; reportDate: string; specLongPct: number; specNet: number; netChangeWeek: number; note?: string };

function Bar({ longPct }: { longPct: number }) {
  return (
    <div className="flex h-1.5 rounded overflow-hidden bg-slate-800">
      <div className="bg-emerald-500/70" style={{ width: `${longPct}%` }} />
      <div className="bg-rose-500/70" style={{ width: `${100 - longPct}%` }} />
    </div>
  );
}

export function IgSentimentCard() {
  const [open, setOpen]       = useState(true);
  const [rows, setRows]       = useState<Row[] | null>(null);
  const [cot, setCot]         = useState<Cot[]>([]);
  const [at, setAt]           = useState<string | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/ig-sentiment', { cache: 'no-store' });
      const d = await res.json() as { ok: boolean; rows?: Row[]; cot?: Cot[]; at?: string; error?: string };
      if (!d.ok) throw new Error(d.error ?? 'Failed to load');
      setRows(d.rows ?? []); setCot(d.cot ?? []); setAt(d.at ?? null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
    const t = setInterval(() => void load(), 5 * 60_000);
    return () => clearInterval(t);
  }, [open, load]);

  const nameOf = (key: string) => rows?.find(r => r.key === key)?.name ?? key;

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <button onClick={() => setOpen(o => !o)} className="flex items-center gap-2 text-sm font-semibold text-slate-200 mr-auto">
          <Users className="w-4 h-4 text-sky-400" />
          Buyers vs sellers
          {open ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
        </button>
        {open && <button onClick={() => void load()} title="Refresh" className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-400">
          <RefreshCw className={clsx('w-3.5 h-3.5', loading && 'animate-spin')} />
        </button>}
      </div>
      {open && (
        <div className="px-4 pb-4 space-y-4">
          {error && <div className="text-xs text-rose-400">{error}</div>}
          {!error && rows === null && <div className="text-xs text-slate-500">Loading…</div>}

          {cot.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-slate-300">
                Big money <span className="font-normal text-slate-500">· funds and large traders in US futures (CFTC, weekly, as of {cot[0].reportDate})</span>
              </div>
              <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
                {cot.map(c => (
                  <div key={c.key} className="text-xs" title={c.note}>
                    <div className="flex justify-between mb-0.5 gap-2">
                      <span className="text-slate-300">{nameOf(c.key)}{c.note && <span className="text-slate-600"> *</span>}</span>
                      <span className="text-slate-500 whitespace-nowrap">
                        <span className="text-emerald-400">{c.specLongPct}% long</span> · <span className="text-rose-400">{100 - c.specLongPct}% short</span>
                        <span className={clsx('ml-1.5', c.netChangeWeek >= 0 ? 'text-emerald-500' : 'text-rose-500')}>{c.netChangeWeek >= 0 ? '▲' : '▼'} wk</span>
                      </span>
                    </div>
                    <Bar longPct={c.specLongPct} />
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-slate-600">▲/▼ wk = which way their net position moved this week. * hover for a note (Brent uses WTI; for USD/JPY a yen long is a bet USD/JPY falls).</p>
            </div>
          )}

          {rows && rows.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-slate-300">
                Retail <span className="font-normal text-slate-500">· IG&apos;s clients, live{at ? ` (${new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })})` : ''}. Minor signal: small traders barely move these markets.</span>
              </div>
              <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
                {rows.map(r => (
                  <div key={r.key} className="text-xs">
                    <div className="flex justify-between mb-0.5">
                      <span className="text-slate-400">{r.name}</span>
                      <span className="text-slate-500"><span className="text-emerald-400/80">{r.longPct}% buying</span> · <span className="text-rose-400/80">{r.shortPct}% selling</span></span>
                    </div>
                    <Bar longPct={r.longPct} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

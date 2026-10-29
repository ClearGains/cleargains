'use client';

// Momentum Testbot card for the IG demo tab (2026-10-29). The bot is its own
// Python service on the bot server; this shows its open trades and log, and
// flips its switches (pause, dry run, stop/start, close its trades).
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, RefreshCw, Zap } from 'lucide-react';
import { clsx } from 'clsx';

type Pos = {
  dealId: string; market: string; direction: 'BUY' | 'SELL'; size: number; level: number | null; opened_utc: string;
  upl: number | null; current: number | null; stopLevel: number | null; limitLevel: number | null;
};
type Status = {
  ok: boolean; error?: string; service: string; paused: boolean; dryRun: boolean;
  settings: { riskPerTradeGbp: number; minStrength: number; cooldownMinutes: number; maxLossesPerDay: number; scanSeconds: number };
  positions: Pos[]; igError: string | null; guard: Record<string, { losses: number; last_loss: number }>; opensToday: number; log: string[];
};

const money = (n: number) => `${n < 0 ? '−' : n > 0 ? '+' : ''}£${Math.abs(n).toFixed(2)}`;

export function MomentumBotCard() {
  const [open, setOpen]       = useState(true);
  const [st, setSt]           = useState<Status | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy]       = useState<string | null>(null);
  const [msg, setMsg]         = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/momentum', { cache: 'no-store' });
      const d = await res.json() as Status;
      if (!d.ok) throw new Error(d.error ?? 'Failed to load');
      setSt(d);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [open, load]);

  async function act(action: string) {
    // Destructive actions need a second click.
    if ((action === 'stop' || action === 'close-all') && confirm !== action) { setConfirm(action); return; }
    setConfirm(null); setBusy(action); setMsg(null);
    try {
      const res = await fetch('/api/momentum', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
      const d = await res.json() as { ok: boolean; message: string };
      setMsg(d.message);
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); void load(); }
  }

  const running = st?.service === 'active';
  const state = !st ? '…' : !running ? 'Stopped' : st.paused ? 'Paused' : st.dryRun ? 'Dry run' : 'Trading';
  const stateCls = !st ? 'text-slate-400' : !running ? 'text-rose-400' : st.paused ? 'text-amber-400' : st.dryRun ? 'text-sky-400' : 'text-emerald-400';
  const openPl = (st?.positions ?? []).reduce((s, p) => s + (p.upl ?? 0), 0);

  const Btn = ({ action, label, tone = 'slate' }: { action: string; label: string; tone?: 'slate' | 'amber' | 'rose' | 'emerald' }) => (
    <button onClick={() => void act(action)} disabled={busy !== null}
      className={clsx('px-3 py-1.5 rounded-lg text-xs font-medium border disabled:opacity-50',
        confirm === action ? 'bg-rose-600 border-rose-500 text-white' :
        tone === 'amber' ? 'bg-amber-500/10 border-amber-500/30 text-amber-300 hover:bg-amber-500/20' :
        tone === 'rose' ? 'bg-rose-500/10 border-rose-500/30 text-rose-300 hover:bg-rose-500/20' :
        tone === 'emerald' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20' :
        'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700')}>
      {busy === action ? 'Working…' : confirm === action ? `Confirm: ${label}` : label}
    </button>
  );

  return (
    <div className="bg-slate-900/60 border border-amber-500/20 rounded-xl">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <button onClick={() => setOpen(o => !o)} className="flex items-center gap-2 text-sm font-semibold text-slate-200 mr-auto">
          <Zap className="w-4 h-4 text-amber-400" />
          Momentum Testbot
          <span className={clsx('text-xs font-medium', stateCls)}>{state}</span>
          {st && st.positions.length > 0 && <span className="text-xs font-normal text-slate-500">({st.positions.length} open · <span className={openPl >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{money(openPl)}</span>)</span>}
          {open ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
        </button>
        {open && <button onClick={() => void load()} title="Refresh" className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-400">
          <RefreshCw className={clsx('w-3.5 h-3.5', loading && 'animate-spin')} />
        </button>}
      </div>

      {open && (
        <div className="px-4 pb-4 space-y-3">
          {error && <div className="text-xs text-rose-400">{error}</div>}
          {st && (<>
            <p className="text-xs text-slate-500">
              The April Testbot, run separately from Opus on the same demo account. Trades a day move over 0.3% while the market&apos;s own exchange is open
              (FX any time), risks about £{st.settings.riskPerTradeGbp} a trade, and rests a market for {st.settings.cooldownMinutes} min after a loss and for the day after {st.settings.maxLossesPerDay}.
              It only touches its own trades.
            </p>

            <div className="flex flex-wrap gap-2">
              {running
                ? (st.paused ? <Btn action="resume" label="Resume" tone="emerald" /> : <Btn action="pause" label="Pause new trades" tone="amber" />)
                : <Btn action="start" label="Start" tone="emerald" />}
              {running && (st.dryRun ? <Btn action="dry-run-off" label="Dry run: on (turn off)" /> : <Btn action="dry-run-on" label="Switch to dry run" />)}
              {running && <Btn action="stop" label="Stop bot" tone="rose" />}
              {st.positions.length > 0 && <Btn action="close-all" label="Close its trades" tone="rose" />}
              {confirm && <button onClick={() => setConfirm(null)} className="px-2 py-1.5 text-xs text-slate-400 hover:text-slate-200">Cancel</button>}
            </div>
            {confirm === 'stop' && <div className="text-xs text-amber-300">Stopping ends the program. Its open trades stay open with their stops and targets at IG.</div>}
            {confirm === 'close-all' && <div className="text-xs text-amber-300">This closes the Testbot&apos;s open trades now (not Opus&apos;s) and pauses it.</div>}
            {msg && <div className="text-xs text-slate-300">{msg}</div>}
            {st.igError && <div className="text-xs text-rose-400">Couldn&apos;t read live P&amp;L from IG: {st.igError}</div>}

            {st.positions.length > 0 ? (
              <div className="overflow-x-auto -mx-1">
                <table className="w-full text-xs min-w-[560px]">
                  <thead><tr className="text-slate-500 text-left">
                    <th className="px-1 py-1.5 font-medium">Market</th><th className="px-1 py-1.5 font-medium">Side</th>
                    <th className="px-1 py-1.5 font-medium text-right">£/pt</th><th className="px-1 py-1.5 font-medium text-right">Entry → now</th>
                    <th className="px-1 py-1.5 font-medium text-right">Stop / target</th><th className="px-1 py-1.5 font-medium text-right">P&amp;L</th>
                  </tr></thead>
                  <tbody>{st.positions.map(p => (
                    <tr key={p.dealId} className="border-t border-slate-800/70">
                      <td className="px-1 py-1.5 text-slate-200">{p.market}<span className="text-slate-500"> · {new Date(p.opened_utc).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span></td>
                      <td className={clsx('px-1 py-1.5', p.direction === 'BUY' ? 'text-emerald-400' : 'text-rose-400')}>{p.direction === 'BUY' ? 'Long' : 'Short'}</td>
                      <td className="px-1 py-1.5 text-right text-slate-300">{p.size}</td>
                      <td className="px-1 py-1.5 text-right text-slate-300 whitespace-nowrap">{p.level ?? '—'} → {p.current ?? '—'}</td>
                      <td className="px-1 py-1.5 text-right text-slate-400 whitespace-nowrap">{p.stopLevel ?? '—'} / {p.limitLevel ?? '—'}</td>
                      <td className={clsx('px-1 py-1.5 text-right font-medium', (p.upl ?? 0) > 0 ? 'text-emerald-400' : (p.upl ?? 0) < 0 ? 'text-rose-400' : 'text-slate-400')}>{p.upl === null ? '—' : money(p.upl)}</td>
                    </tr>))}
                  </tbody>
                </table>
              </div>
            ) : <div className="text-xs text-slate-500">No open trades.</div>}

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
              <span>Trades opened today: {st.opensToday}</span>
              {Object.entries(st.guard).map(([m, g]) => (
                <span key={m} className={g.losses >= st.settings.maxLossesPerDay ? 'text-rose-400' : 'text-amber-400'}>
                  {m}: {g.losses} loss{g.losses === 1 ? '' : 'es'} today{g.losses >= st.settings.maxLossesPerDay ? ' (done for the day)' : ''}
                </span>
              ))}
            </div>

            <button onClick={() => setShowLog(s => !s)} className="text-xs text-slate-400 hover:text-slate-200">
              {showLog ? 'Hide' : 'Show'} its log
            </button>
            {showLog && (
              <pre className="text-[11px] leading-relaxed text-slate-400 bg-slate-950/60 rounded-lg p-2 overflow-x-auto max-h-72 overflow-y-auto">
                {st.log.map(l => l.replace(/^\d{4}-\d{2}-\d{2} (\d{2}:\d{2}):\d{2},\d+ (INFO|WARNING|ERROR) /, '$1 UTC  ')).slice().reverse().join('\n')}
              </pre>
            )}
          </>)}
        </div>
      )}
    </div>
  );
}

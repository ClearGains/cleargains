'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Power, AlertTriangle, RefreshCw, Brain, Clock, Wallet, Play, Settings2, FileText, X } from 'lucide-react';
import { clsx } from 'clsx';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

type Account = 'alpaca_paper' | 'ig_demo' | 't212_live';
type ModelId = 'claude-fable-5-1' | 'claude-opus-5-5' | 'claude-sonnet-5-5';
type ModelInfo = { label: string; input: number; output: number };
type Config = {
  enabled: boolean; model: ModelId; shadowModel: ModelId | null; accounts: Record<Account, boolean>; monthlyCapUsd: number; cycleMinutes: number; offHoursMinutes: number; alpacaEveryMinutes: number;
  effort: 'low' | 'medium' | 'high' | 'xhigh'; alpacaMaxPositionUsd: number; alpacaMaxPositions: number;
  igMaxRiskGbp: number; igMaxRiskPct: number; igMaxPositions: number; t212MaxPositionGbp: number; t212MaxTotalGbp: number;
  t212MaxPositions: number; minConviction: number; minHoldHours: number; reentryCooldownHours: number;
  webResearch: boolean; searchesPerSession: number; researchSearches: number;
};
type TvAlert = { ts: string; symbol: string; signal: string; timeframe: string | null; price: number | null; note: string | null };
type Position = {
  id: string; account: Account; symbol: string; direction: 'BUY' | 'SELL'; size: number; entryPrice: number;
  stopPrice: number; openedAt: number; conviction: number; reason: string; livePl: number | null; liveCurrent: number | null;
};
type Closed = Position & { closedAt: number; closeReason: string; plApprox: number | null };
type LogEntry = { id: string; ts: string; type: 'info' | 'enter' | 'exit' | 'wait' | 'error' | 'think'; msg: string };
type Status = {
  running: boolean; busy: boolean; apiKeyConfigured: boolean; usSessionOpen: boolean;
  nextRunAt: number | null; lastRunAt: string | null; config: Config;
  spend: { month: string; usd: number; requests: number; cycles: number };
  budgetLeftUsd: number; models: Record<ModelId, ModelInfo>; positions: Position[];
  tradingviewConfigured: boolean; tradingviewSecret: string | null; tvAlerts: TvAlert[]; closed: Closed[]; notes: string; watchlistExtra: string[];
  log: LogEntry[]; error?: string;
};

const ACCOUNT_LABEL: Record<Account, string> = { alpaca_paper: 'Alpaca paper', ig_demo: 'IG demo', t212_live: 'T212 LIVE' };

function relTime(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.round((ms - Date.now()) / 1000);
  if (s <= 0) return 'due now';
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`;
}
function agoTime(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
function logColor(type: LogEntry['type']): string {
  switch (type) {
    case 'enter': return 'text-emerald-400';
    case 'exit':  return 'text-amber-400';
    case 'error': return 'text-red-400';
    case 'wait':  return 'text-gray-500';
    case 'think': return 'text-violet-300';
    default:      return 'text-sky-400';
  }
}

// Editable numeric settings shown in the settings card.
const NUMBER_FIELDS: Array<{ key: keyof Config; label: string; hint: string }> = [
  { key: 'monthlyCapUsd',        label: 'Monthly API cap ($)',        hint: 'Opus pauses once spend reaches this' },
  { key: 'cycleMinutes',         label: 'Review every (min)',         hint: '15-240, US session' },
  { key: 'alpacaEveryMinutes',   label: 'Alpaca review every (min)',  hint: '30-390; long-term account, so less often than IG' },
  { key: 'offHoursMinutes',      label: 'Off-hours IG review (min)',  hint: '0 = off, 30-480; weekdays outside US hours' },
  { key: 'igMaxRiskPct',         label: 'IG max risk (% of balance)', hint: '0-5; the larger of this and the £ figure' },
  { key: 'minConviction',        label: 'Min conviction (%)',         hint: 'Entries below this are rejected' },
  { key: 't212MaxPositionGbp',   label: 'T212 max / position (£)',    hint: 'Real money' },
  { key: 't212MaxTotalGbp',      label: 'T212 max total (£)',         hint: 'Real money, across Opus positions' },
  { key: 't212MaxPositions',     label: 'T212 max positions',         hint: '' },
  { key: 'igMaxRiskGbp',         label: 'IG max risk / trade (£)',    hint: 'Loss if the stop is hit' },
  { key: 'igMaxPositions',       label: 'IG max positions',           hint: '' },
  { key: 'alpacaMaxPositionUsd', label: 'Alpaca max / position ($)',  hint: 'Paper' },
  { key: 'alpacaMaxPositions',   label: 'Alpaca max positions',       hint: '' },
  { key: 'minHoldHours',         label: 'Min hold before closing (h)', hint: 'Stops still fire' },
  { key: 'reentryCooldownHours', label: 'Re-entry cooldown (h)',      hint: 'After closing a symbol' },
  { key: 'searchesPerSession',   label: 'Web searches / session',     hint: '0-10, ~$0.01 each plus reading' },
  { key: 'researchSearches',     label: 'Web searches / daily research', hint: '0-20, first session of the day' },
];

export default function OpusTraderPage() {
  const [status, setStatus]     = useState<Status | null>(null);
  const [error, setError]       = useState<string | null>(null);
  const [loading, setLoading]   = useState<string | null>(null);
  const [draft, setDraft]       = useState<Partial<Config>>({});
  const [briefing, setBriefing] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res  = await fetch('/api/opus');
      const data = await res.json() as Status & { ok?: boolean };
      if (data.error) { setError(data.error); return; }
      setStatus(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reach bot server');
    }
  }, []);

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    void fetchStatus();
    pollRef.current = setInterval(() => { void fetchStatus(); }, 10_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchStatus]);

  const post = async (action: string, body?: unknown, extra = '') => {
    setLoading(action);
    setError(null);
    try {
      const res  = await fetch(`/api/opus?action=${action}${extra}`, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json() as { ok: boolean; error?: string; message?: string };
      if (!data.ok) setError(data.error ?? data.message ?? 'Request failed');
      await fetchStatus();
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setLoading(null);
    }
  };

  const loadBriefing = async () => {
    setLoading('briefing');
    try {
      const res = await fetch('/api/opus?view=briefing');
      const data = await res.json() as { briefing?: string; error?: string };
      setBriefing(data.briefing ?? data.error ?? 'Unavailable');
    } finally { setLoading(null); }
  };

  const cfg = status?.config;
  const spendPct = cfg ? Math.min(100, (status!.spend.usd / cfg.monthlyCapUsd) * 100) : 0;
  const dirty = Object.keys(draft).length > 0;

  return (
    <main className="max-w-screen-2xl mx-auto px-4 py-6 space-y-4">

      <div className="flex items-baseline gap-3 mb-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Brain className="h-5 w-5 text-violet-400" />
          <h1 className="text-xl font-bold text-white">Opus Trader</h1>
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30">{(cfg && status?.models[cfg.model]?.label) ?? 'CLAUDE'}</span>
          {cfg?.shadowModel && <span className="text-[9px] px-1.5 py-0.5 rounded bg-gray-500/20 text-gray-400 border border-gray-500/30">shadow: {status?.models[cfg.shadowModel]?.label}</span>}
        </div>
        <span className="text-xs text-gray-500">
          Opus reviews the book every {cfg?.cycleMinutes ?? 30} minutes during the US session (and every {cfg?.offHoursMinutes ?? 120} minutes outside it for IG indices, FX and commodities) and opens, holds or closes positions on the accounts below. Every number it sees is computed by code; hard limits it can&apos;t override are enforced by code.
        </span>
      </div>

      {/* Controls */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 text-xs text-gray-500 flex-wrap">
          {status?.running
            ? <span className="flex items-center gap-1.5 text-emerald-400"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" /> Running{status.busy ? ' — session in progress' : ''}</span>
            : status && <span>Stopped</span>}
          {status && <span>Last session {agoTime(status.lastRunAt)}</span>}
          {status?.running && <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> Next in {relTime(status.nextRunAt)}{!status.usSessionOpen ? ' (waits for US session)' : ''}</span>}
          {status && !status.apiKeyConfigured && <span className="text-red-400">No Anthropic API key on the server</span>}
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => void loadBriefing()} loading={loading === 'briefing'} variant="secondary" icon={<FileText className="h-4 w-4" />}>
            Preview briefing
          </Button>
          <Button onClick={() => void post('run')} loading={loading === 'run'} variant="secondary" icon={<Play className="h-4 w-4" />} disabled={!status?.apiKeyConfigured || status?.busy}>
            Run session now
          </Button>
          <Button
            onClick={() => void post(status?.running ? 'stop' : 'start')}
            loading={loading === 'start' || loading === 'stop'}
            variant={status?.running ? 'danger' : 'primary'}
            icon={<Power className="h-4 w-4" />}
          >
            {status?.running ? 'Stop Opus' : 'Start Opus'}
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-xs text-red-400">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        <div className="lg:col-span-1 space-y-4">
          {/* Budget */}
          <Card>
            <CardHeader title="API spend this month" subtitle={status?.spend.month ?? ''} icon={<Wallet className="h-4 w-4" />} />
            {status && cfg ? (
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-white font-semibold tabular-nums">${status.spend.usd.toFixed(2)}</span>
                  <span className="text-gray-500 tabular-nums">of ${cfg.monthlyCapUsd}</span>
                </div>
                <div className="h-2 rounded bg-gray-800 overflow-hidden">
                  <div className={clsx('h-full', spendPct > 85 ? 'bg-red-500' : spendPct > 60 ? 'bg-amber-500' : 'bg-violet-500')} style={{ width: `${spendPct}%` }} />
                </div>
                <p className="text-[10px] text-gray-500">{status.spend.cycles} sessions · {status.spend.requests} API calls · ${status.budgetLeftUsd.toFixed(2)} left</p>
              </div>
            ) : <p className="text-xs text-gray-600">—</p>}
          </Card>

          {/* Accounts */}
          <Card>
            <CardHeader title="Accounts Opus may trade" icon={<Settings2 className="h-4 w-4" />} />
            <div className="space-y-2">
              {cfg && (Object.keys(ACCOUNT_LABEL) as Account[]).map(a => (
                <label key={a} className="flex items-center justify-between text-xs">
                  <span className={clsx(a === 't212_live' ? 'text-amber-300' : 'text-gray-300')}>{ACCOUNT_LABEL[a]}{a === 't212_live' ? ' (real money)' : ''}</span>
                  <input type="checkbox" className="accent-violet-500"
                    checked={(draft.accounts ?? cfg.accounts)[a]}
                    onChange={e => setDraft(d => ({ ...d, accounts: { ...(d.accounts ?? cfg.accounts), [a]: e.target.checked } }))} />
                </label>
              ))}
            </div>
          </Card>

          {/* Settings */}
          <Card>
            <CardHeader title="Limits" subtitle="Enforced in code — Opus can't override them" icon={<Settings2 className="h-4 w-4" />} />
            {cfg && (
              <div className="space-y-2">
                {NUMBER_FIELDS.map(f => (
                  <label key={f.key} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-gray-400" title={f.hint}>{f.label}</span>
                    <input type="number" className="w-24 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-right text-white tabular-nums"
                      value={String((draft[f.key] as number | undefined) ?? (cfg[f.key] as number))}
                      onChange={e => setDraft(d => ({ ...d, [f.key]: Number(e.target.value) }))} />
                  </label>
                ))}
                <label className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-gray-400" title="The model that trades">Trading model</span>
                  <select className="w-40 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-white"
                    value={draft.model ?? cfg.model}
                    onChange={e => setDraft(d => ({ ...d, model: e.target.value as ModelId }))}>
                    {status && (Object.keys(status.models) as ModelId[]).map(m => (
                      <option key={m} value={m}>{status.models[m].label} (${status.models[m].input}/${status.models[m].output})</option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-gray-400" title="Reads the same briefing each session and logs what it would do — never trades. Adds its cost.">Shadow model</span>
                  <select className="w-40 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-white"
                    value={(draft.shadowModel !== undefined ? draft.shadowModel : cfg.shadowModel) ?? ''}
                    onChange={e => setDraft(d => ({ ...d, shadowModel: (e.target.value || null) as ModelId | null }))}>
                    <option value="">off</option>
                    {status && (Object.keys(status.models) as ModelId[]).map(m => (
                      <option key={m} value={m}>{status.models[m].label}</option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-gray-400" title="How hard Opus thinks each session — higher costs more">Thinking effort</span>
                  <select className="w-24 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-white"
                    value={draft.effort ?? cfg.effort}
                    onChange={e => setDraft(d => ({ ...d, effort: e.target.value as Config['effort'] }))}>
                    <option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option>
                  </select>
                </label>
                <div className="flex gap-2 pt-1">
                  <Button onClick={async () => { const r = await post('config', draft); if (r?.ok) setDraft({}); }} loading={loading === 'config'} disabled={!dirty} variant="primary">Save</Button>
                  {dirty && <Button onClick={() => setDraft({})} variant="secondary">Discard</Button>}
                </div>
              </div>
            )}
          </Card>

          {/* Research + TradingView */}
          <Card>
            <CardHeader title="Research & TradingView" icon={<FileText className="h-4 w-4" />} />
            {cfg && (
              <div className="space-y-2 text-xs">
                <label className="flex items-center justify-between">
                  <span className="text-gray-300" title="Lets Opus search the web and read pages for its own research">Web research</span>
                  <input type="checkbox" className="accent-violet-500"
                    checked={draft.webResearch ?? cfg.webResearch}
                    onChange={e => setDraft(d => ({ ...d, webResearch: e.target.checked }))} />
                </label>
                <p className="text-[10px] text-gray-500">TradingView webhook URL:</p>
                <code className="block text-[10px] text-gray-300 break-all">https://cleargains1.vercel.app/api/tradingview</code>
                {status?.tradingviewConfigured ? (
                  <p className="text-[10px] text-gray-500">
                    Secret for the Pine script:{' '}
                    {showSecret
                      ? <code className="text-gray-300 break-all">{status.tradingviewSecret}</code>
                      : <button className="text-violet-300 hover:text-white" onClick={() => setShowSecret(true)}>show</button>}
                  </p>
                ) : <p className="text-[10px] text-amber-400">TRADINGVIEW_SECRET not set on the server</p>}
                <div className="pt-1">
                  <p className="text-[10px] text-gray-500 mb-1">Recent alerts ({status?.tvAlerts.length ?? 0})</p>
                  {!status?.tvAlerts.length ? <p className="text-[10px] text-gray-600">None received yet</p> : (
                    <div className="space-y-0.5 max-h-40 overflow-y-auto">
                      {status.tvAlerts.map(a => (
                        <p key={a.ts + a.symbol} className="text-[10px] text-gray-400">
                          <span className="text-gray-600">{a.ts.slice(5, 16).replace('T', ' ')}</span>{' '}
                          <span className="text-white">{a.symbol}</span>{' '}
                          <span className={a.signal.includes('BUY') ? 'text-emerald-400' : a.signal.includes('EXIT') || a.signal.includes('SELL') ? 'text-red-400' : 'text-sky-400'}>{a.signal}</span>
                          {a.price !== null && <> @ {a.price}</>}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </Card>

          {/* Notes */}
          <Card>
            <CardHeader title="Opus's strategy notes" subtitle="Written by Opus, carried between sessions" icon={<Brain className="h-4 w-4" />} />
            <pre className="text-[11px] text-gray-300 whitespace-pre-wrap font-sans">{status?.notes || 'No notes yet'}</pre>
            {!!status?.watchlistExtra.length && <p className="text-[10px] text-gray-500 mt-2">Extra watchlist: {status.watchlistExtra.join(', ')}</p>}
          </Card>
        </div>

        <div className="lg:col-span-2 space-y-4">
          {/* Positions */}
          <Card>
            <CardHeader title="Opus positions" subtitle={`${status?.positions.length ?? 0} open`} icon={<Wallet className="h-4 w-4" />} />
            {!status?.positions.length ? (
              <p className="text-xs text-gray-600 py-4 text-center">No positions open</p>
            ) : (
              <div className="space-y-2">
                {status.positions.map(p => (
                  <div key={p.id} className="rounded-lg border border-gray-800 bg-gray-900/60 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-bold text-white">
                        {p.symbol} <span className={p.direction === 'BUY' ? 'text-emerald-400' : 'text-red-400'}>{p.direction}</span>
                        <span className={clsx('ml-2 text-[10px] font-normal', p.account === 't212_live' ? 'text-amber-300' : 'text-gray-500')}>{ACCOUNT_LABEL[p.account]}</span>
                      </span>
                      <div className="flex items-center gap-3">
                        <span className={clsx('text-xs font-semibold tabular-nums', (p.livePl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                          {p.livePl === null ? '—' : `${p.livePl >= 0 ? '+' : ''}${p.livePl.toFixed(2)}`}
                        </span>
                        <button className="text-gray-500 hover:text-red-400" title="Close this position now"
                          onClick={() => void post('close', undefined, `&id=${p.id}`)}>
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                    <p className="text-[10px] text-gray-500 mt-0.5">
                      size {p.size} · entry {p.entryPrice} · stop {p.stopPrice} · now {p.liveCurrent ?? '—'} · conviction {p.conviction}% · {((Date.now() - p.openedAt) / 3_600_000).toFixed(1)}h held
                    </p>
                    <p className="text-[10px] text-gray-400 mt-1">{p.reason}</p>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {briefing !== null && (
            <Card>
              <CardHeader title="What Opus sees right now" subtitle="Free preview — no API call" icon={<FileText className="h-4 w-4" />} />
              <div className="flex justify-end -mt-2 mb-2"><button className="text-[10px] text-gray-500 hover:text-white" onClick={() => setBriefing(null)}>hide</button></div>
              <pre className="text-[10px] text-gray-300 whitespace-pre-wrap max-h-[50vh] overflow-y-auto font-mono">{briefing}</pre>
            </Card>
          )}

          {/* Activity */}
          <Card>
            <CardHeader title="Activity & reasoning" icon={<RefreshCw className="h-4 w-4" />} />
            {!status?.log?.length ? (
              <p className="text-xs text-gray-600 py-8 text-center">No activity yet</p>
            ) : (
              <div className="space-y-1 max-h-[60vh] overflow-y-auto font-mono text-[11px]">
                {status.log.map(l => (
                  <div key={l.id} className="flex gap-2 py-1 border-b border-gray-800/50">
                    <span className="text-gray-600 flex-shrink-0">{l.ts.slice(5, 16).replace('T', ' ')}</span>
                    <span className={clsx('flex-shrink-0 w-10 uppercase', logColor(l.type))}>{l.type}</span>
                    <span className="text-gray-300 whitespace-pre-wrap">{l.msg}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Closed */}
          <Card>
            <CardHeader title="Closed positions" subtitle="Most recent first" icon={<Clock className="h-4 w-4" />} />
            {!status?.closed.length ? (
              <p className="text-xs text-gray-600 py-4 text-center">None yet</p>
            ) : (
              <div className="space-y-1 text-[11px]">
                {status.closed.map(c => (
                  <div key={c.id + c.closedAt} className="flex gap-2 py-1 border-b border-gray-800/50">
                    <span className="text-gray-600 w-20 flex-shrink-0">{new Date(c.closedAt).toISOString().slice(5, 10)}</span>
                    <span className="text-white w-16 flex-shrink-0">{c.symbol}</span>
                    <span className="text-gray-500 w-24 flex-shrink-0">{ACCOUNT_LABEL[c.account]}</span>
                    <span className={clsx('w-16 flex-shrink-0 tabular-nums', (c.plApprox ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400')}>{c.plApprox === null ? '—' : c.plApprox.toFixed(2)}</span>
                    <span className="text-gray-400">{c.closeReason}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </main>
  );
}

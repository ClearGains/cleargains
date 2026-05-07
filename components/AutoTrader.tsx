'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Power, AlertTriangle, CheckCircle2, XCircle, RefreshCw, Settings,
  Activity, ShieldAlert, TrendingUp, TrendingDown, Clock, Zap,
  ToggleLeft, ToggleRight, Info, ChevronDown, ChevronUp,
  Wifi, WifiOff, Key, Search,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useClearGainsStore } from '@/lib/store';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { IG_STOCK_EPICS } from '@/lib/ig-stock-epics';
import type { TradeLogEntry, IGInstrument } from '@/lib/types';

// ── Types ─────────────────────────────────────────────────────────────────────

type IGSession = { cst: string; securityToken: string; apiKey: string };
type IGCreds   = { username: string; password: string; apiKey: string; connected: boolean };
type EngineStatus = 'idle' | 'running' | 'error' | 'circuit_breaker' | 'no_session';

type SignalItem = {
  symbol: string; name: string; price: number;
  dayHigh: number; dayLow: number;
  direction: 'BUY' | 'SELL'; signal: string; score: number; reasons: string[];
};

// ── Credential storage keys (shared with IGSharesAutoTrader) ──────────────────

const CRED_KEY = (env: 'demo' | 'live') => env === 'demo' ? 'ig_demo_credentials' : 'ig_live_credentials';
const SESS_KEY = (env: 'demo' | 'live') => `ig_session_${env}`;

function loadCreds(env: 'demo' | 'live'): IGCreds {
  try {
    const raw = localStorage.getItem(CRED_KEY(env));
    if (raw) return JSON.parse(raw) as IGCreds;
  } catch {}
  return { username: '', password: '', apiKey: '', connected: false };
}

function clearSession(env: 'demo' | 'live') {
  localStorage.removeItem(SESS_KEY(env));
}

// ── Session fetch — tries cache first, then re-auths from stored credentials ──

async function getIGSession(env: 'demo' | 'live'): Promise<IGSession | null> {
  try {
    // 1. Try cached session (5h TTL)
    const sessRaw = localStorage.getItem(SESS_KEY(env));
    if (sessRaw) {
      const c = JSON.parse(sessRaw) as IGSession & { authenticatedAt?: number };
      if (c.cst && c.securityToken && c.apiKey) {
        if (!c.authenticatedAt || Date.now() - c.authenticatedAt < 5 * 60 * 60 * 1000)
          return { cst: c.cst, securityToken: c.securityToken, apiKey: c.apiKey };
      }
    }
    // 2. Re-auth from stored credentials
    const creds = loadCreds(env);
    if (!creds.connected || !creds.username || !creds.password || !creds.apiKey) return null;
    const res = await fetch('/api/ig/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: creds.username, password: creds.password, apiKey: creds.apiKey, env }),
    });
    const data = await res.json() as { ok: boolean; cst?: string; securityToken?: string; accountId?: string };
    if (!data.ok || !data.cst) return null;
    const sess: IGSession = { cst: data.cst, securityToken: data.securityToken!, apiKey: creds.apiKey };
    localStorage.setItem(SESS_KEY(env), JSON.stringify({ ...sess, accountId: data.accountId, authenticatedAt: Date.now() }));
    return sess;
  } catch { return null; }
}

// ── IGConnectPanel — reads session from Settings, no duplicate credential entry ─

function IGConnectPanel({ env }: { env: 'demo' | 'live' }) {
  const isLive = env === 'live';
  const [creds, setCreds]   = useState<IGCreds>({ username: '', password: '', apiKey: '', connected: false });
  const [testing, setTesting] = useState(false);
  const [msg, setMsg]         = useState<{ ok: boolean; text: string } | null>(null);

  function refresh() { setCreds(loadCreds(env)); setMsg(null); }
  useEffect(() => { refresh(); }, [env]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleTest() {
    setTesting(true); setMsg(null); clearSession(env);
    try {
      const sess = await getIGSession(env);
      if (sess) {
        setMsg({ ok: true, text: 'Session active — engine can trade.' });
        refresh();
      } else {
        setMsg({ ok: false, text: 'Could not get a session. Re-save your credentials in Settings → Accounts.' });
      }
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
    setTesting(false);
  }

  const accent = isLive ? 'red' : 'orange';

  return (
    <div className={clsx('rounded-xl border p-4 space-y-3',
      isLive ? 'border-red-500/20 bg-red-500/5' : 'border-orange-500/20 bg-orange-500/5'
    )}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {creds.connected
            ? <Wifi className={clsx('h-4 w-4', isLive ? 'text-red-400' : 'text-orange-400')} />
            : <WifiOff className="h-4 w-4 text-gray-500" />}
          <span className="text-sm font-semibold text-white">
            IG {isLive ? 'Live' : 'Demo'}
            {isLive && <span className="ml-1.5 text-[9px] text-red-400 font-normal">REAL MONEY</span>}
          </span>
        </div>
        {creds.connected && (
          <span className={clsx('text-[9px] font-bold px-1.5 py-0.5 rounded border',
            isLive ? 'bg-red-500/20 text-red-400 border-red-500/30' : 'bg-orange-500/20 text-orange-400 border-orange-500/30'
          )}>CONNECTED</span>
        )}
      </div>

      {creds.connected ? (
        <p className="text-[11px] text-gray-400">
          Logged in as <span className="text-white font-medium">{creds.username}</span>
        </p>
      ) : (
        <div className="text-[11px] text-gray-500 bg-gray-800/50 rounded-lg px-3 py-2.5 space-y-1">
          <p className="text-gray-300 font-medium">No {isLive ? 'live' : 'demo'} account connected</p>
          <p>Go to <a href="/settings/accounts" className={clsx('font-medium underline', isLive ? 'text-red-400' : 'text-orange-400')}>Settings → Accounts</a> and connect your IG {isLive ? 'Live' : 'Demo'} account there — the engine will use that session automatically.</p>
        </div>
      )}

      {msg && (
        <div className={clsx('flex items-start gap-2 rounded-lg px-3 py-2 text-xs',
          msg.ok ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
                 : 'bg-red-500/10 border border-red-500/20 text-red-400'
        )}>
          {msg.ok ? <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                  : <XCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />}
          <span>{msg.text}</span>
        </div>
      )}

      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={refresh}
          icon={<RefreshCw className="h-3.5 w-3.5" />}>
          Refresh
        </Button>
        {creds.connected && (
          <Button size="sm" variant="outline" loading={testing} onClick={handleTest}>
            Test session
          </Button>
        )}
        {!creds.connected && (
          <Button size="sm" variant="outline"
            onClick={() => window.location.href = '/settings/accounts'}
            icon={<Key className="h-3.5 w-3.5" />}>
            Go to Settings
          </Button>
        )}
      </div>
    </div>
  );
}

function igH(sess: IGSession, env: 'demo' | 'live'): Record<string, string> {
  return {
    'x-ig-cst': sess.cst,
    'x-ig-security-token': sess.securityToken,
    'x-ig-api-key': sess.apiKey,
    'x-ig-env': env,
    'Content-Type': 'application/json',
  };
}

function calcLevels(price: number, dayHigh: number, dayLow: number, dir: 'BUY' | 'SELL') {
  const r = (n: number) => Math.round(n * 100) / 100;
  if (dir === 'BUY') {
    const rawStop = Math.max(dayLow * 0.99, price * 0.95);
    const risk = Math.max(price - rawStop, price * 0.01);
    return { stopDist: r(risk), tpDist: r(risk * 2) };
  } else {
    const rawStop = Math.min(dayHigh * 1.01, price * 1.05);
    const risk = Math.max(rawStop - price, price * 0.01);
    return { stopDist: r(risk), tpDist: r(risk * 2) };
  }
}

function trackedOpenSymbols(log: TradeLogEntry[], env: 'demo' | 'live'): Set<string> {
  const opens = log.filter(e => (e.action === 'OPEN_LONG' || e.action === 'OPEN_SHORT') && e.env === env && e.dealId);
  const closedIds = new Set(log.filter(e => e.action === 'CLOSE' && e.dealId).map(e => e.dealId!));
  return new Set(opens.filter(o => !closedIds.has(o.dealId!)).map(o => o.symbol));
}

function newId() { return `at_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`; }
function nowTs() { return new Date().toISOString(); }

// Module-level epic cache: ticker → epic string, or null if not on IG spread bets
const epicCache = new Map<string, string | null>();

async function resolveEpic(ticker: string, companyName: string, sess: IGSession, env: 'demo' | 'live', saved?: IGInstrument[]): Promise<string | null> {
  // 1. User-saved instruments list (highest priority — pre-verified by user)
  const savedMatch = saved?.find(i => i.ticker.toUpperCase() === ticker.toUpperCase());
  if (savedMatch) return savedMatch.epic;

  // 2. Static map
  const known = IG_STOCK_EPICS[ticker];
  if (known) return known.epic;

  // 3. In-memory cache
  if (epicCache.has(ticker)) return epicCache.get(ticker)!;

  // Helper: call the IG market search and return the first CS.D.* spread-bet epic.
  // IG's internal epic codes often don't match the stock ticker (e.g. WKHS → CS.D.WORKHR.TODAY.IP)
  // so we don't filter on the ticker appearing in the epic — just take the first spread-bet result.
  async function igSearch(query: string): Promise<string | null> {
    try {
      const res = await fetch(`/api/ig/markets?q=${encodeURIComponent(query)}`, { headers: igH(sess, env) });
      if (!res.ok) return null;
      const data = await res.json() as { ok: boolean; markets?: Array<{ epic: string; dealingEnabled?: boolean }> };
      const hit = (data.markets ?? []).find(m => m.epic.startsWith('CS.D.') && m.dealingEnabled !== false);
      return hit?.epic ?? null;
    } catch { return null; }
  }

  // 3. Search by ticker symbol
  let epic = await igSearch(ticker);

  // 4. Fallback: search by company name (strip legal suffixes so search is cleaner)
  if (!epic && companyName) {
    const cleanName = companyName.replace(/\s+(Inc\.?|Corp\.?|Ltd\.?|LLC|plc|Group|Holdings?)$/i, '').trim();
    epic = await igSearch(cleanName);
  }

  epicCache.set(ticker, epic);
  return epic;
}

// ── Core trading cycle ────────────────────────────────────────────────────────

type CycleParams = {
  env: 'demo' | 'live';
  stake: number;
  maxPositions: number;
  maxDailyLoss: number;
  minScore: number;
  useLongs: boolean;
  useShorts: boolean;
  dailyPnL: number;
  trackedSymbols: Set<string>;
  savedInstruments: IGInstrument[];
  onAction: (msg: string) => void;
};

type CycleResult = { entries: TradeLogEntry[]; error?: string };

async function runCycle(p: CycleParams): Promise<CycleResult> {
  const entries: TradeLogEntry[] = [];

  // Circuit breaker
  if (-p.dailyPnL >= p.maxDailyLoss) {
    entries.push({
      id: newId(), ts: nowTs(), action: 'CIRCUIT_BREAKER',
      symbol: '-', env: p.env,
      reason: `Daily loss limit £${p.maxDailyLoss} reached — trading halted for today`,
    });
    return { entries };
  }

  // IG session
  const sess = await getIGSession(p.env);
  if (!sess) return { entries, error: `No IG ${p.env} session — enter your credentials in the IG Connections panel below and click Connect` };

  // Current open positions
  p.onAction('Checking open positions…');
  let openCount = 0;
  const igOpenEpics: string[] = [];
  try {
    const r = await fetch('/api/ig/positions', { headers: igH(sess, p.env) });
    const d = await r.json() as { ok: boolean; positions?: { dealId: string; epic?: string }[] };
    if (d.ok) {
      openCount = d.positions?.length ?? 0;
      d.positions?.forEach(pos => { if (pos.epic) igOpenEpics.push(pos.epic.toUpperCase()); });
    }
  } catch (e) {
    return { entries, error: `Position check failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (openCount >= p.maxPositions) {
    entries.push({
      id: newId(), ts: nowTs(), action: 'SKIP',
      symbol: '-', env: p.env,
      reason: `Max positions (${p.maxPositions}) already open`,
    });
    return { entries };
  }

  // Gather signals
  const signals: SignalItem[] = [];

  if (p.useLongs) {
    p.onAction('Fetching long signals…');
    try {
      const r = await fetch('/api/market/predicted');
      const data = await r.json() as Array<{
        symbol: string; name: string; price: number; dayHigh?: number; dayLow?: number;
        signal: string; score: number; signalReasons?: string[];
      }>;
      if (Array.isArray(data)) {
        data
          .filter(m => (m.signal === 'STRONG_BUY' || m.signal === 'BUY') && m.score >= p.minScore)
          .forEach(m => signals.push({
            symbol: m.symbol, name: m.name, price: m.price,
            dayHigh: m.dayHigh ?? m.price * 1.02, dayLow: m.dayLow ?? m.price * 0.98,
            direction: 'BUY', signal: m.signal, score: m.score,
            reasons: m.signalReasons ?? [],
          }));
      }
    } catch { /* ignore — fallback to whatever signals we have */ }
  }

  if (p.useShorts) {
    p.onAction('Fetching short signals…');
    try {
      const r = await fetch('/api/market/shorts');
      const data = await r.json() as {
        conviction?: Array<{
          symbol: string; name: string; price: number; dayHigh?: number; dayLow?: number;
          shortSignal: string; shortScore: number; shortReasons?: string[];
        }>;
      };
      (data.conviction ?? [])
        .filter(c => c.shortSignal === 'STRONG_SHORT' && c.shortScore >= p.minScore)
        .forEach(c => signals.push({
          symbol: c.symbol, name: c.name, price: c.price,
          dayHigh: c.dayHigh ?? c.price * 1.02, dayLow: c.dayLow ?? c.price * 0.98,
          direction: 'SELL', signal: c.shortSignal, score: c.shortScore,
          reasons: c.shortReasons ?? [],
        }));
    } catch { /* ignore */ }
  }

  if (signals.length === 0) {
    entries.push({
      id: newId(), ts: nowTs(), action: 'SKIP',
      symbol: '-', env: p.env, reason: 'No qualifying signals this cycle',
    });
    return { entries };
  }

  // Sort by score descending
  signals.sort((a, b) => b.score - a.score);

  let slotsFilled = openCount;

  for (const sig of signals) {
    if (slotsFilled >= p.maxPositions) break;

    // Skip if we already tracked this symbol as open
    if (p.trackedSymbols.has(sig.symbol)) {
      entries.push({ id: newId(), ts: nowTs(), action: 'SKIP', symbol: sig.symbol, env: p.env, reason: 'Already tracking an open position for this symbol' });
      continue;
    }

    // Skip if IG already shows this epic open
    const cleanSym = sig.symbol.replace(/\.[A-Z]+$/, '');
    const alreadyOpen = igOpenEpics.some(e => {
      const parts = e.split('.');
      return parts[2] === cleanSym.toUpperCase();
    });
    if (alreadyOpen) {
      entries.push({ id: newId(), ts: nowTs(), action: 'SKIP', symbol: sig.symbol, env: p.env, reason: 'IG already shows an open position for this instrument' });
      continue;
    }

    p.onAction(`Resolving epic for ${sig.symbol}…`);
    const epic = await resolveEpic(cleanSym, sig.name, sess, p.env, p.savedInstruments);
    if (!epic) {
      entries.push({ id: newId(), ts: nowTs(), action: 'SKIP', symbol: sig.symbol, env: p.env, reason: 'Not available for spread betting on IG — skipped' });
      continue;
    }

    const levels = calcLevels(sig.price, sig.dayHigh, sig.dayLow, sig.direction);
    p.onAction(`Placing ${sig.direction === 'BUY' ? 'LONG' : 'SHORT'}: ${sig.symbol} @ ${sig.price.toFixed(2)}…`);

    try {
      const r = await fetch('/api/ig/order', {
        method: 'POST',
        headers: igH(sess, p.env),
        body: JSON.stringify({
          epic,
          direction: sig.direction,
          size: p.stake,
          stopDistance: levels.stopDist,
          profitDistance: levels.tpDist,
        }),
      });
      const d = await r.json() as { ok: boolean; dealId?: string; level?: number; error?: string };

      if (d.ok) {
        slotsFilled++;
        const entry: TradeLogEntry = {
          id: newId(), ts: nowTs(),
          action: sig.direction === 'BUY' ? 'OPEN_LONG' : 'OPEN_SHORT',
          symbol: sig.symbol,
          instrumentName: sig.name,
          direction: sig.direction,
          size: p.stake,
          entryPrice: d.level ?? sig.price,
          stopLevel: sig.direction === 'BUY'
            ? Math.round(((d.level ?? sig.price) - levels.stopDist) * 100) / 100
            : Math.round(((d.level ?? sig.price) + levels.stopDist) * 100) / 100,
          limitLevel: sig.direction === 'BUY'
            ? Math.round(((d.level ?? sig.price) + levels.tpDist) * 100) / 100
            : Math.round(((d.level ?? sig.price) - levels.tpDist) * 100) / 100,
          reason: sig.reasons.slice(0, 3).join(' · ') || sig.signal,
          signal: sig.signal,
          score: sig.score,
          env: p.env,
          dealId: d.dealId,
        };
        entries.push(entry);
      } else {
        entries.push({
          id: newId(), ts: nowTs(), action: 'ERROR', symbol: sig.symbol, env: p.env,
          reason: d.error ?? 'Order rejected',
          signal: sig.signal, score: sig.score,
        });
      }
    } catch (e) {
      entries.push({
        id: newId(), ts: nowTs(), action: 'ERROR', symbol: sig.symbol, env: p.env,
        reason: e instanceof Error ? e.message : 'Unknown error',
      });
    }
  }

  return { entries };
}

// ── NumInput: lets users clear and retype freely; commits to store on blur ────

function NumInput({
  value, onChange, min, max, step = 1, hint,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  hint?: string;
}) {
  const [raw, setRaw] = useState(String(value));
  const focused = useRef(false);

  // Keep display in sync when store changes externally (not while user is typing)
  useEffect(() => {
    if (!focused.current) setRaw(String(value));
  }, [value]);

  function commit(str: string) {
    const n = parseFloat(str);
    if (!isNaN(n) && n >= min && n <= max) {
      onChange(n);
      setRaw(String(n));
    } else {
      // Revert to last valid store value
      setRaw(String(value));
    }
  }

  return (
    <div>
      <input
        type="text"
        inputMode="decimal"
        value={raw}
        onFocus={() => { focused.current = true; }}
        onChange={e => setRaw(e.target.value)}
        onBlur={e => { focused.current = false; commit(e.target.value); }}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500"
      />
      {hint && <p className="text-[10px] text-gray-600 mt-1">{hint}</p>}
    </div>
  );
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function relTime(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function ActionBadge({ action }: { action: TradeLogEntry['action'] }) {
  const cfg: Record<string, string> = {
    OPEN_LONG:       'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    OPEN_SHORT:      'bg-red-500/20 text-red-400 border-red-500/30',
    CLOSE:           'bg-blue-500/20 text-blue-400 border-blue-500/30',
    SKIP:            'bg-gray-700/60 text-gray-400 border-gray-600',
    CIRCUIT_BREAKER: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    ERROR:           'bg-red-500/20 text-red-400 border-red-500/30',
    SESSION:         'bg-gray-700/60 text-gray-500 border-gray-600',
  };
  const labels: Record<string, string> = {
    OPEN_LONG: 'LONG', OPEN_SHORT: 'SHORT', CLOSE: 'CLOSE',
    SKIP: 'SKIP', CIRCUIT_BREAKER: 'CB', ERROR: 'ERR', SESSION: 'SYS',
  };
  return (
    <span className={clsx('text-[9px] font-bold px-1.5 py-0.5 rounded border', cfg[action] ?? cfg.SKIP)}>
      {labels[action] ?? action}
    </span>
  );
}

// ── Saved Instruments card ────────────────────────────────────────────────────

function IGInstrumentsCard({ instruments, onAdd, onRemove, env, engineRunning }: {
  instruments: IGInstrument[];
  onAdd: (inst: IGInstrument) => void;
  onRemove: (epic: string) => void;
  env: 'demo' | 'live';
  engineRunning: boolean;
}) {
  const [query, setQuery]     = useState('');
  const [results, setResults] = useState<IGInstrument[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchMsg, setSearchMsg] = useState('');

  async function handleSearch() {
    if (!query.trim()) return;
    setSearching(true); setResults([]); setSearchMsg('');
    try {
      const sess = await getIGSession(env);
      if (!sess) { setSearchMsg('No IG session — connect in Settings → Accounts first.'); setSearching(false); return; }
      const res = await fetch(`/api/ig/markets?q=${encodeURIComponent(query.trim())}`, { headers: igH(sess, env) });
      const data = await res.json() as { ok: boolean; markets?: Array<{ epic: string; instrumentName?: string; expiry?: string; dealingEnabled?: boolean }> };
      const hits = (data.markets ?? [])
        .filter(m => m.epic.startsWith('CS.D.') && m.dealingEnabled !== false)
        .map(m => ({
          ticker: query.trim().toUpperCase(),
          name: m.instrumentName ?? query.trim().toUpperCase(),
          epic: m.epic,
          expiry: m.expiry ?? '-',
          available24h: (m.expiry ?? '').toUpperCase().includes('CASH') || (m.instrumentName ?? '').toLowerCase().includes('24'),
          addedAt: new Date().toISOString(),
        } satisfies IGInstrument));
      setResults(hits);
      if (!hits.length) setSearchMsg(`No spread-bet instruments found for "${query.trim()}"`);
    } catch (e) {
      setSearchMsg(e instanceof Error ? e.message : 'Search failed');
    }
    setSearching(false);
  }

  const savedEpics = new Set(instruments.map(i => i.epic));

  return (
    <Card className="p-0">
      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-white">
          <Zap className="h-4 w-4 text-orange-400" /> Tradeable Instruments
        </div>
        <span className="text-[10px] text-gray-500">{instruments.length} saved — engine uses these first</span>
      </div>

      {/* Search */}
      <div className="px-4 py-3 border-b border-gray-800">
        <div className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void handleSearch(); }}
            placeholder="Search by ticker or company name (e.g. BYND, Beyond Meat)"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-orange-500"
          />
          <Button size="sm" loading={searching} onClick={() => void handleSearch()} icon={<Search className="h-3.5 w-3.5" />}>
            Search IG
          </Button>
        </div>
        {searchMsg && <p className="text-[11px] text-gray-500 mt-2">{searchMsg}</p>}

        {/* Search results */}
        {results.length > 0 && (
          <div className="mt-2 space-y-1">
            {results.map(r => (
              <div key={r.epic} className="flex items-center justify-between bg-gray-800/60 rounded-lg px-3 py-2">
                <div>
                  <span className="text-xs font-semibold text-white">{r.epic}</span>
                  <span className="text-[11px] text-gray-400 ml-2">{r.name}</span>
                  {r.available24h && <span className="ml-2 text-[9px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1 py-0.5 rounded">24h</span>}
                </div>
                {savedEpics.has(r.epic) ? (
                  <span className="text-[10px] text-gray-500">Saved</span>
                ) : (
                  <Button size="sm" onClick={() => { onAdd(r); setResults(rs => rs.filter(x => x.epic !== r.epic)); }}>
                    Add
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Saved list */}
      {instruments.length === 0 ? (
        <div className="py-8 text-center">
          <p className="text-xs text-gray-500">No instruments saved yet</p>
          <p className="text-[11px] text-gray-600 mt-1">Search above to find stocks and add them — the engine will use your saved list to place trades reliably without live API lookups</p>
        </div>
      ) : (
        <div className="divide-y divide-gray-800/60 max-h-64 overflow-y-auto">
          {instruments.map(inst => (
            <div key={inst.epic} className="flex items-center justify-between px-4 py-2.5 hover:bg-gray-800/20 transition-colors">
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-xs font-bold text-white w-14 flex-shrink-0">{inst.ticker}</span>
                <div className="min-w-0">
                  <p className="text-[11px] text-gray-400 truncate">{inst.name}</p>
                  <p className="text-[10px] text-gray-600 font-mono">{inst.epic}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                {inst.available24h && <span className="text-[9px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded">24h</span>}
                <button onClick={() => onRemove(inst.epic)} disabled={engineRunning}
                  className="text-gray-600 hover:text-red-400 transition-colors disabled:opacity-30">
                  <XCircle className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function AutoTrader() {
  const store = useClearGainsStore();
  const {
    autoTraderEnabled, autoTraderEnv, autoTraderStake, autoTraderMaxPositions,
    autoTraderMaxDailyLoss, autoTraderMinScore, autoTraderUseLongs, autoTraderUseShorts,
    autoTraderIntervalMin, autoTraderLog, autoTraderDailyPnL, autoTraderDailyDate,
    autoTraderTotalPnL, autoTraderWins, autoTraderLosses,
    igInstruments, addIGInstrument, removeIGInstrument,
    setAutoTraderEnabled, setAutoTraderEnv, setAutoTraderConfig,
    addAutoTradeLogEntry, resetAutoTraderDailyPnL,
  } = store;

  const [engineStatus, setEngineStatus] = useState<EngineStatus>('idle');
  const [currentAction, setCurrentAction] = useState('');
  const [lastRunAt, setLastRunAt] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(true);
  const [liveConfirm, setLiveConfirm] = useState(false);
  const [runNowLoading, setRunNowLoading] = useState(false);

  const storeRef = useRef(store);
  const cycleRunning = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { storeRef.current = store; });

  const executeCycle = useCallback(async () => {
    if (cycleRunning.current) return;
    cycleRunning.current = true;
    setEngineStatus('running');
    setCurrentAction('Starting cycle…');
    setLastError(null);

    try {
      const s = storeRef.current;

      // Daily reset
      const today = new Date().toISOString().slice(0, 10);
      if (s.autoTraderDailyDate !== today) {
        s.resetAutoTraderDailyPnL(today);
      }

      const result = await runCycle({
        env:          s.autoTraderEnv,
        stake:        s.autoTraderStake,
        maxPositions: s.autoTraderMaxPositions,
        maxDailyLoss: s.autoTraderMaxDailyLoss,
        minScore:     s.autoTraderMinScore,
        useLongs:     s.autoTraderUseLongs,
        useShorts:    s.autoTraderUseShorts,
        dailyPnL:     s.autoTraderDailyPnL,
        trackedSymbols: trackedOpenSymbols(s.autoTraderLog, s.autoTraderEnv),
        savedInstruments: s.igInstruments,
        onAction:     setCurrentAction,
      });

      if (result.error) {
        setEngineStatus('no_session');
        setLastError(result.error);
        s.addAutoTradeLogEntry({
          id: newId(), ts: nowTs(), action: 'ERROR',
          symbol: '-', env: s.autoTraderEnv, reason: result.error,
        });
      } else {
        const hasCB = result.entries.some(e => e.action === 'CIRCUIT_BREAKER');
        setEngineStatus(hasCB ? 'circuit_breaker' : 'idle');
        result.entries.forEach(e => s.addAutoTradeLogEntry(e));
        setLastRunAt(nowTs());
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setEngineStatus('error');
      setLastError(msg);
    } finally {
      cycleRunning.current = false;
      setCurrentAction('');
    }
  }, []);

  // Schedule interval when enabled
  useEffect(() => {
    if (!autoTraderEnabled) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
      if (engineStatus === 'running') setEngineStatus('idle');
      return;
    }

    void executeCycle();
    intervalRef.current = setInterval(() => void executeCycle(), autoTraderIntervalMin * 60_000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTraderEnabled, autoTraderIntervalMin]);

  function toggleEnabled() {
    if (!autoTraderEnabled && autoTraderEnv === 'live' && !liveConfirm) {
      setLiveConfirm(true);
      return;
    }
    setLiveConfirm(false);
    setAutoTraderEnabled(!autoTraderEnabled);
  }

  async function handleRunNow() {
    setRunNowLoading(true);
    await executeCycle();
    setRunNowLoading(false);
  }

  const totalTrades = autoTraderWins + autoTraderLosses;
  const winRate = totalTrades > 0 ? Math.round((autoTraderWins / totalTrades) * 100) : null;
  const recentLog = autoTraderLog.slice(0, 12);

  const statusConfig = {
    idle:            { color: 'text-gray-400',    bg: 'bg-gray-500/10 border-gray-700',   label: 'Idle' },
    running:         { color: 'text-blue-400',     bg: 'bg-blue-500/10 border-blue-500/20', label: 'Running' },
    error:           { color: 'text-red-400',      bg: 'bg-red-500/10 border-red-500/20',   label: 'Error' },
    circuit_breaker: { color: 'text-amber-400',    bg: 'bg-amber-500/10 border-amber-500/20', label: 'Circuit Breaker' },
    no_session:      { color: 'text-orange-400',   bg: 'bg-orange-500/10 border-orange-500/20', label: 'No IG Session' },
  };
  const sc = statusConfig[engineStatus];

  return (
    <div className="space-y-4">

      {/* Demo / Live tab bar */}
      <div className="flex border-b border-gray-800">
        {(['demo', 'live'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => { if (!autoTraderEnabled) setAutoTraderEnv(tab); }}
            disabled={autoTraderEnabled}
            className={clsx(
              'relative px-6 py-3 text-sm font-semibold transition-all disabled:cursor-not-allowed',
              autoTraderEnv === tab
                ? tab === 'live'
                  ? 'text-red-300 after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-red-400'
                  : 'text-orange-300 after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-orange-400'
                : 'text-gray-500 hover:text-gray-300'
            )}
          >
            {tab === 'live' ? (
              <span className="flex items-center gap-2">
                Live
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-500/30">
                  REAL MONEY
                </span>
              </span>
            ) : 'Demo'}
          </button>
        ))}
      </div>

      {/* Live mode confirmation */}
      {liveConfirm && (
        <div className="border border-red-500/40 bg-red-500/10 rounded-xl p-4 space-y-3">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-red-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-bold text-red-300">Enable on LIVE account?</p>
              <p className="text-xs text-red-400/80 mt-1">
                This will place real spread bets on your live IG account using real money.
                Losses are real. The system uses stop losses but cannot guarantee against gaps or slippage.
                Only enable if you fully understand the risks.
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => { setLiveConfirm(false); setAutoTraderEnabled(true); }}
              className="bg-red-600 hover:bg-red-500 text-white border-red-500">
              Yes, enable on LIVE
            </Button>
            <Button size="sm" variant="outline" onClick={() => setLiveConfirm(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {/* Circuit breaker warning */}
      {engineStatus === 'circuit_breaker' && (
        <div className="border border-amber-500/40 bg-amber-500/10 rounded-xl px-4 py-3 flex items-center gap-3">
          <ShieldAlert className="h-5 w-5 text-amber-400 flex-shrink-0" />
          <div>
            <p className="text-sm font-bold text-amber-300">Circuit Breaker Active</p>
            <p className="text-xs text-amber-400/80">
              Daily loss limit of £{autoTraderMaxDailyLoss} reached. Trading halted until tomorrow.
              Daily P&L resets at midnight.
            </p>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className={clsx('flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium', sc.bg, sc.color)}>
            {engineStatus === 'running' && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
            {engineStatus === 'idle' && <Activity className="h-3.5 w-3.5" />}
            {engineStatus === 'error' && <XCircle className="h-3.5 w-3.5" />}
            {engineStatus === 'circuit_breaker' && <ShieldAlert className="h-3.5 w-3.5" />}
            {engineStatus === 'no_session' && <AlertTriangle className="h-3.5 w-3.5" />}
            {sc.label}
            {currentAction && <span className="text-gray-400 font-normal">— {currentAction}</span>}
          </div>
          <span className={clsx('text-[10px] font-bold px-2 py-0.5 rounded border',
            autoTraderEnv === 'live'
              ? 'bg-red-500/20 text-red-400 border-red-500/30'
              : 'bg-orange-500/20 text-orange-400 border-orange-500/30'
          )}>
            {autoTraderEnv.toUpperCase()}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" loading={runNowLoading}
            onClick={handleRunNow} disabled={autoTraderEnabled}
            icon={<Zap className="h-3.5 w-3.5" />}>
            Run Now
          </Button>
          <button
            onClick={toggleEnabled}
            className={clsx(
              'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold border transition-all',
              autoTraderEnabled
                ? 'bg-red-500/20 border-red-500/40 text-red-300 hover:bg-red-500/30'
                : 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/30'
            )}
          >
            <Power className="h-4 w-4" />
            {autoTraderEnabled ? 'Stop Engine' : 'Start Engine'}
          </button>
        </div>
      </div>

      {/* Error / no session banner */}
      {(engineStatus === 'error' || engineStatus === 'no_session') && lastError && (
        <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-xs text-red-400">
          <XCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Engine error</p>
            <p className="text-red-400/80 mt-0.5">{lastError}</p>
            {engineStatus === 'no_session' && (
              <p className="mt-1 text-orange-400">
                Enter your IG {autoTraderEnv === 'demo' ? 'Demo' : 'Live'} credentials in the <strong>IG Connections</strong> panel on the left and click Connect.
              </p>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* Config panel */}
        <div className="lg:col-span-1 space-y-3">

          {/* IG Connection for active tab */}
          <IGConnectPanel env={autoTraderEnv} />

          <Card>
            <button
              onClick={() => setShowConfig(v => !v)}
              className="flex items-center justify-between w-full"
            >
              <div className="flex items-center gap-2 text-sm font-semibold text-white">
                <Settings className="h-4 w-4 text-gray-400" /> Configuration
              </div>
              {showConfig ? <ChevronUp className="h-4 w-4 text-gray-500" /> : <ChevronDown className="h-4 w-4 text-gray-500" />}
            </button>

            {showConfig && (
              <div className="mt-4 space-y-4">

                {/* Stake */}
                <div>
                  <label className="text-[10px] text-gray-500 font-medium uppercase tracking-wider mb-1.5 block">
                    Stake per trade (£/pt)
                  </label>
                  <NumInput
                    value={autoTraderStake} min={0.5} max={100} step={0.5}
                    onChange={v => setAutoTraderConfig({ stake: v })}
                    hint={`At £${autoTraderStake}/pt: 10pt move = £${autoTraderStake * 10}`}
                  />
                </div>

                {/* Max positions */}
                <div>
                  <label className="text-[10px] text-gray-500 font-medium uppercase tracking-wider mb-1.5 block">
                    Max open positions
                  </label>
                  <NumInput
                    value={autoTraderMaxPositions} min={1} max={10}
                    onChange={v => setAutoTraderConfig({ maxPositions: Math.round(v) })}
                  />
                </div>

                {/* Max daily loss */}
                <div>
                  <label className="text-[10px] text-gray-500 font-medium uppercase tracking-wider mb-1.5 block">
                    Daily loss limit (£)
                  </label>
                  <NumInput
                    value={autoTraderMaxDailyLoss} min={1} max={100000}
                    onChange={v => setAutoTraderConfig({ maxDailyLoss: v })}
                    hint="Circuit breaker fires at this loss level"
                  />
                </div>

                {/* Min score */}
                <div>
                  <label className="text-[10px] text-gray-500 font-medium uppercase tracking-wider mb-1.5 block">
                    Minimum signal score
                  </label>
                  <NumInput
                    value={autoTraderMinScore} min={1} max={15}
                    onChange={v => setAutoTraderConfig({ minScore: Math.round(v) })}
                    hint="Higher = fewer but stronger signals"
                  />
                </div>

                {/* Direction toggles */}
                <div>
                  <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wider mb-1.5">Trade directions</p>
                  <div className="space-y-2">
                    <button onClick={() => setAutoTraderConfig({ useLongs: !autoTraderUseLongs })}
                      className="flex items-center justify-between w-full px-3 py-2.5 bg-gray-800/60 border border-gray-700 rounded-lg hover:border-gray-600 transition-colors">
                      <div className="flex items-center gap-2">
                        <TrendingUp className="h-3.5 w-3.5 text-emerald-400" />
                        <span className="text-xs text-white">Long (BUY) signals</span>
                      </div>
                      {autoTraderUseLongs
                        ? <ToggleRight className="h-5 w-5 text-emerald-400" />
                        : <ToggleLeft className="h-5 w-5 text-gray-600" />
                      }
                    </button>
                    <button onClick={() => setAutoTraderConfig({ useShorts: !autoTraderUseShorts })}
                      className="flex items-center justify-between w-full px-3 py-2.5 bg-gray-800/60 border border-gray-700 rounded-lg hover:border-gray-600 transition-colors">
                      <div className="flex items-center gap-2">
                        <TrendingDown className="h-3.5 w-3.5 text-red-400" />
                        <span className="text-xs text-white">Short (SELL) signals</span>
                      </div>
                      {autoTraderUseShorts
                        ? <ToggleRight className="h-5 w-5 text-emerald-400" />
                        : <ToggleLeft className="h-5 w-5 text-gray-600" />
                      }
                    </button>
                  </div>
                </div>

                {/* Interval */}
                <div>
                  <label className="text-[10px] text-gray-500 font-medium uppercase tracking-wider mb-1.5 block">
                    Scan interval (minutes)
                  </label>
                  <NumInput
                    value={autoTraderIntervalMin} min={1} max={60}
                    onChange={v => setAutoTraderConfig({ intervalMin: Math.round(v) })}
                    hint="Restarts after config changes"
                  />
                </div>

              </div>
            )}
          </Card>
        </div>

        {/* Stats + recent log + instruments */}
        <div className="lg:col-span-2 space-y-3">

          {/* Saved Instruments */}
          <IGInstrumentsCard
            instruments={igInstruments}
            onAdd={addIGInstrument}
            onRemove={removeIGInstrument}
            env={autoTraderEnv}
            engineRunning={autoTraderEnabled}
          />

          {/* Stats grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {[
              {
                label: 'Daily P&L',
                value: `${autoTraderDailyPnL >= 0 ? '+' : ''}£${Math.abs(autoTraderDailyPnL).toFixed(2)}`,
                highlight: autoTraderDailyPnL > 0 ? 'pos' : autoTraderDailyPnL < 0 ? 'neg' : 'neutral',
                sub: `Limit: £${autoTraderMaxDailyLoss}`,
              },
              {
                label: 'Total P&L',
                value: `${autoTraderTotalPnL >= 0 ? '+' : ''}£${Math.abs(autoTraderTotalPnL).toFixed(2)}`,
                highlight: autoTraderTotalPnL > 0 ? 'pos' : autoTraderTotalPnL < 0 ? 'neg' : 'neutral',
                sub: 'All time',
              },
              {
                label: 'Win Rate',
                value: winRate !== null ? `${winRate}%` : '—',
                highlight: winRate !== null && winRate >= 50 ? 'pos' : winRate !== null ? 'neg' : 'neutral',
                sub: `${autoTraderWins}W / ${autoTraderLosses}L`,
              },
              {
                label: 'Last Run',
                value: lastRunAt ? relTime(lastRunAt) : 'Never',
                highlight: 'neutral',
                sub: autoTraderEnabled ? `Every ${autoTraderIntervalMin}m` : 'Engine stopped',
              },
              {
                label: 'Engine',
                value: sc.label,
                highlight: engineStatus === 'idle' || engineStatus === 'running' ? 'neutral' : 'neg',
                sub: autoTraderEnv.toUpperCase(),
              },
              {
                label: 'Log Entries',
                value: autoTraderLog.length.toString(),
                highlight: 'neutral',
                sub: 'Max 500 stored',
              },
            ].map(s => (
              <Card key={s.label} className="p-3">
                <p className="text-[10px] text-gray-500 uppercase tracking-wider font-medium mb-1">{s.label}</p>
                <p className={clsx('text-lg font-bold tabular-nums',
                  s.highlight === 'pos' ? 'text-emerald-400' : s.highlight === 'neg' ? 'text-red-400' : 'text-white'
                )}>{s.value}</p>
                {s.sub && <p className="text-[10px] text-gray-600 mt-0.5">{s.sub}</p>}
              </Card>
            ))}
          </div>

          {/* Recent activity */}
          <Card className="p-0">
            <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold text-white">
                <Activity className="h-4 w-4 text-gray-400" /> Recent Activity
              </div>
              <span className="text-[10px] text-gray-500">Last 12 events · <a href="/trade-log" className="text-orange-400 hover:underline">View full log</a></span>
            </div>
            {recentLog.length === 0 ? (
              <div className="py-10 text-center">
                <Clock className="h-7 w-7 text-gray-700 mx-auto mb-2" />
                <p className="text-xs text-gray-500">No activity yet — start the engine to begin</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-800/60">
                {recentLog.map(entry => (
                  <div key={entry.id} className="flex items-start gap-3 px-4 py-2.5 hover:bg-gray-800/20 transition-colors">
                    <ActionBadge action={entry.action} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-semibold text-white">{entry.symbol === '-' ? '—' : entry.symbol}</span>
                        {entry.entryPrice && (
                          <span className="text-[10px] text-gray-500">@ {entry.entryPrice.toFixed(2)}</span>
                        )}
                        {entry.signal && (
                          <span className="text-[9px] text-gray-600 font-mono">{entry.signal}</span>
                        )}
                        {entry.score !== undefined && (
                          <span className="text-[9px] text-gray-600">score: {entry.score}</span>
                        )}
                      </div>
                      <p className="text-[10px] text-gray-500 mt-0.5 truncate">{entry.reason}</p>
                    </div>
                    <span className="text-[9px] text-gray-600 flex-shrink-0 mt-0.5">{relTime(entry.ts)}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Info box */}
          <div className="flex items-start gap-3 px-4 py-3 bg-blue-500/5 border border-blue-500/15 rounded-xl text-xs text-blue-400/70">
            <Info className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
            <p>
              The engine runs in your browser tab — keep this page open while trading.
              It places spread bets on IG using your existing session.
              Stop losses and take profits are set automatically at 2:1 R:R.
              The circuit breaker halts trading if daily losses exceed your limit.
            </p>
          </div>

        </div>
      </div>
    </div>
  );
}

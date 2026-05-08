'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { Play, Square, RefreshCw, Zap, Activity, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { clsx } from 'clsx';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useIGStream, type CandleTick } from '@/lib/useIGStream';
import {
  initEpicState, processTick, recordFill,
  DEFAULT_CONFIG,
  type ScalperEpicState, type ScalperConfig, type ScalperDecision,
} from '@/lib/scalperStrategy';
import { DEFAULT_WATCHLIST } from '@/lib/igStrategyEngine';

type Session = { cst: string; securityToken: string; accountId: string; apiKey: string; lightstreamerEndpoint?: string };

type LogEntry = {
  id:      string;
  ts:      string;
  type:    'info' | 'enter' | 'exit' | 'hold' | 'wait' | 'error' | 'cooldown';
  epic:    string;
  msg:     string;
};

type EpicStatus = {
  state:       string;
  formingIsRed: boolean | null;
  entryPrice:  number;
  pnlPct:      number | null;
  lastPrice:   number;
  reds:        number;
};

function uid() { return Math.random().toString(36).slice(2, 9); }
function now() { return new Date().toLocaleTimeString('en-GB'); }

const AVAILABLE_INSTRUMENTS = DEFAULT_WATCHLIST.map(m => ({ epic: m.epic, name: m.name }));

interface Props {
  session: Session | null;
  /** Called to open a BUY position — resolves with fill price or throws */
  openPosition: (epic: string, size: number) => Promise<number>;
  /** Called to close a position by dealId */
  closePosition: (dealId: string, direction: 'BUY' | 'SELL', size: number) => Promise<void>;
  /** Current open positions so the bot knows which dealId to close */
  openPositions: Array<{ dealId: string; epic: string; direction: 'BUY' | 'SELL'; size: number; level: number }>;
}

export function IGScalperBot({ session, openPosition, closePosition, openPositions }: Props) {
  const [running, setRunning]           = useState(false);
  const [selectedEpics, setSelectedEpics] = useState<string[]>(['IX.D.FTSE.DAILY.IP']);
  const [tradeSize, setTradeSize]       = useState(0.5);
  const [config, setConfig]             = useState<ScalperConfig>(DEFAULT_CONFIG);
  const [log, setLog]                   = useState<LogEntry[]>([]);
  const [epicStatuses, setEpicStatuses] = useState<Record<string, EpicStatus>>({});

  const statesRef   = useRef<Record<string, ScalperEpicState>>({});
  const pendingRef  = useRef<Set<string>>(new Set());  // epics with order in-flight

  const addLog = useCallback((type: LogEntry['type'], epic: string, msg: string) => {
    setLog(prev => [{ id: uid(), ts: now(), type, epic, msg }, ...prev.slice(0, 99)]);
  }, []);

  // Sync epic states when selected instruments change
  useEffect(() => {
    for (const epic of selectedEpics) {
      if (!statesRef.current[epic]) {
        statesRef.current[epic] = initEpicState(epic);
      }
    }
  }, [selectedEpics]);

  const handleTick = useCallback(async (tick: CandleTick) => {
    if (!running) return;
    const st = statesRef.current[tick.epic];
    if (!st) return;
    if (pendingRef.current.has(tick.epic)) return;  // order in-flight, skip

    const decision: ScalperDecision = processTick(st, tick, config);

    // Update status display
    setEpicStatuses(prev => ({
      ...prev,
      [tick.epic]: {
        state:        st.state,
        formingIsRed: st.formingCandle ? st.formingCandle.close < st.formingCandle.open : null,
        entryPrice:   st.entryPrice,
        pnlPct:       st.entryPrice > 0 && tick.bidClose > 0
          ? (tick.bidClose - st.entryPrice) / st.entryPrice * 100
          : null,
        lastPrice:    tick.bidClose,
        reds:         st.consecutiveReds,
      },
    }));

    // Only log on candle close or significant intrabar decisions
    if (decision.action === 'HOLD' && !tick.candleClosed) return;
    if (decision.action === 'WAIT' && !tick.candleClosed) return;

    const name = AVAILABLE_INSTRUMENTS.find(i => i.epic === tick.epic)?.name ?? tick.epic;

    switch (decision.action) {
      case 'ENTER': {
        addLog('enter', name, `↑ ENTER — ${decision.reason}`);
        pendingRef.current.add(tick.epic);
        try {
          const fillPrice = await openPosition(tick.epic, tradeSize);
          recordFill(st, fillPrice);
          addLog('enter', name, `✓ Filled @ ${fillPrice.toFixed(4)}`);
        } catch (e) {
          // Revert state if order failed
          st.state = 'FLAT';
          addLog('error', name, `✗ Order failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          pendingRef.current.delete(tick.epic);
        }
        break;
      }
      case 'EXIT': {
        const urgencyTag = decision.urgency === 'immediate' ? ' [IMMEDIATE]' : '';
        addLog('exit', name, `↓ EXIT${urgencyTag} — ${decision.reason}`);
        // Find matching open position
        const pos = openPositions.find(p => p.epic === tick.epic && p.direction === 'BUY');
        if (pos) {
          pendingRef.current.add(tick.epic);
          try {
            await closePosition(pos.dealId, pos.direction, pos.size);
            addLog('exit', name, `✓ Closed deal ${pos.dealId}`);
          } catch (e) {
            addLog('error', name, `✗ Close failed: ${e instanceof Error ? e.message : String(e)}`);
          } finally {
            pendingRef.current.delete(tick.epic);
          }
        } else {
          addLog('info', name, `No open position found to close (may already be closed)`);
        }
        break;
      }
      case 'HOLD':
        if (tick.candleClosed) addLog('hold', name, `→ HOLD — ${decision.reason}`);
        break;
      case 'WAIT':
        if (tick.candleClosed) addLog('wait', name, `… WAIT — ${decision.reason}`);
        break;
      case 'COOLDOWN':
        // Only log once per minute to avoid spam
        break;
    }
  }, [running, config, tradeSize, openPosition, closePosition, openPositions, addLog]);

  const streamSession = running && session?.lightstreamerEndpoint ? {
    endpoint:      session.lightstreamerEndpoint,
    accountId:     session.accountId,
    cst:           session.cst,
    securityToken: session.securityToken,
  } : null;

  useIGStream({
    session:    streamSession,
    epics:      running ? selectedEpics : [],
    onTick:     handleTick,
    resolution: '1MINUTE',
  });

  function toggleEpic(epic: string) {
    setSelectedEpics(prev =>
      prev.includes(epic) ? prev.filter(e => e !== epic) : [...prev, epic]
    );
  }

  const logTypeStyle: Record<LogEntry['type'], string> = {
    enter:    'text-emerald-400',
    exit:     'text-red-400',
    hold:     'text-gray-400',
    wait:     'text-gray-500',
    error:    'text-red-500 font-semibold',
    cooldown: 'text-yellow-400',
    info:     'text-blue-400',
  };

  return (
    <Card className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-orange-400" />
          <span className="text-sm font-semibold text-white">1-Minute Scalper Bot</span>
          <span className={clsx(
            'text-[9px] px-1.5 py-0.5 rounded font-bold border',
            running
              ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30 animate-pulse'
              : 'bg-gray-700 text-gray-400 border-gray-600'
          )}>
            {running ? 'LIVE' : 'STOPPED'}
          </span>
          {!session?.lightstreamerEndpoint && (
            <span className="text-[9px] text-yellow-400 flex items-center gap-1">
              <AlertTriangle className="h-2.5 w-2.5" /> No stream endpoint — reconnect IG session
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={running ? 'danger' : 'primary'}
            icon={running ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
            onClick={() => {
              if (running) {
                setRunning(false);
                addLog('info', '—', 'Bot stopped');
              } else {
                // Reset all epic states when starting
                statesRef.current = {};
                for (const epic of selectedEpics) {
                  statesRef.current[epic] = initEpicState(epic);
                }
                setEpicStatuses({});
                setLog([]);
                setRunning(true);
                addLog('info', '—', `Bot started — watching ${selectedEpics.length} instrument(s)`);
              }
            }}
            disabled={!session?.lightstreamerEndpoint && !running}
          >
            {running ? 'Stop' : 'Start Bot'}
          </Button>
        </div>
      </div>

      {/* Strategy description */}
      <div className="text-[10px] text-gray-500 bg-gray-900/40 rounded p-2 space-y-0.5">
        <p><span className="text-emerald-400 font-medium">ENTER</span> — on green candle close (RSI &lt; {config.maxRsiEntry})</p>
        <p><span className="text-red-400 font-medium">EXIT</span> — intrabar loss ≥ {config.stopLossPct}%, single red close, or 2 consecutive reds (then {config.cooldownMs / 60_000} min cooldown)</p>
        <p><span className="text-gray-400 font-medium">HOLD</span> — tiny red candle (&lt;{config.tinyBodyPct}% body) with neutral RSI 35–60 (noise filter)</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Left: config + instruments */}
        <div className="space-y-3">
          {/* Size + config */}
          <div className="flex items-center gap-3 flex-wrap">
            <div>
              <label className="text-[10px] text-gray-500 block mb-1">£/pt per trade</label>
              <input
                type="number"
                value={tradeSize}
                onChange={e => setTradeSize(Math.max(0.1, Number(e.target.value)))}
                min={0.1} step={0.1}
                className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white outline-none"
                disabled={running}
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-500 block mb-1">Stop loss %</label>
              <input
                type="number"
                value={config.stopLossPct}
                onChange={e => setConfig(c => ({ ...c, stopLossPct: Math.max(0.1, Number(e.target.value)) }))}
                min={0.1} step={0.1}
                className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white outline-none"
                disabled={running}
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-500 block mb-1">Cooldown (min)</label>
              <input
                type="number"
                value={config.cooldownMs / 60_000}
                onChange={e => setConfig(c => ({ ...c, cooldownMs: Math.max(1, Number(e.target.value)) * 60_000 }))}
                min={1} step={1}
                className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white outline-none"
                disabled={running}
              />
            </div>
          </div>

          {/* Instrument selector */}
          <div>
            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1.5">Instruments to watch</p>
            <div className="flex flex-wrap gap-1.5">
              {AVAILABLE_INSTRUMENTS.map(ins => (
                <button
                  key={ins.epic}
                  onClick={() => !running && toggleEpic(ins.epic)}
                  disabled={running}
                  className={clsx(
                    'text-[10px] px-2 py-1 rounded border transition-all',
                    selectedEpics.includes(ins.epic)
                      ? 'bg-orange-500/20 text-orange-400 border-orange-500/40'
                      : 'bg-gray-800 text-gray-500 border-gray-700 hover:border-gray-500',
                    running && 'opacity-60 cursor-default'
                  )}
                >
                  {ins.name}
                </button>
              ))}
            </div>
          </div>

          {/* Live status per epic */}
          {Object.entries(epicStatuses).length > 0 && (
            <div className="space-y-1">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">Live status</p>
              {Object.entries(epicStatuses).map(([epic, s]) => {
                const name = AVAILABLE_INSTRUMENTS.find(i => i.epic === epic)?.name ?? epic;
                return (
                  <div key={epic} className="flex items-center justify-between bg-gray-900/60 rounded px-2 py-1">
                    <span className="text-[10px] text-gray-300">{name}</span>
                    <div className="flex items-center gap-2 text-[10px]">
                      {s.reds > 0 && <span className="text-red-400">{s.reds}🔴</span>}
                      <span className={clsx(
                        'font-medium',
                        s.state === 'IN_POSITION' ? 'text-emerald-400' :
                        s.state === 'COOLDOWN'    ? 'text-yellow-400' : 'text-gray-400'
                      )}>{s.state}</span>
                      {s.pnlPct !== null && (
                        <span className={s.pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                          {s.pnlPct >= 0 ? '+' : ''}{s.pnlPct.toFixed(3)}%
                        </span>
                      )}
                      {s.formingIsRed !== null && (
                        <span className={s.formingIsRed ? 'text-red-400' : 'text-emerald-400'}>
                          {s.formingIsRed ? '▼' : '▲'}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right: log */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider">Bot log</p>
            <button onClick={() => setLog([])} className="text-[9px] text-gray-600 hover:text-gray-400">Clear</button>
          </div>
          <div className="h-64 overflow-y-auto space-y-0.5 bg-gray-950/60 border border-gray-800 rounded p-2">
            {log.length === 0 && (
              <p className="text-[10px] text-gray-600 text-center mt-8">Start the bot to see activity here</p>
            )}
            {log.map(entry => (
              <div key={entry.id} className="flex gap-1.5 text-[10px] font-mono">
                <span className="text-gray-600 shrink-0">{entry.ts}</span>
                <span className="text-gray-500 shrink-0">[{entry.epic.slice(0, 8)}]</span>
                <span className={logTypeStyle[entry.type]}>{entry.msg}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <p className="text-[9px] text-gray-600">
        Uses IG Lightstreamer real-time 1-minute candles. Decisions are made on the client — no server polling.
        Spread bet only. Past performance does not guarantee future results.
      </p>
    </Card>
  );
}

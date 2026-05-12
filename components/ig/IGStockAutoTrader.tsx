'use client';

import { useState } from 'react';
import {
  Play, Square, Pause, Settings, TrendingUp, TrendingDown,
  Minus, Zap, AlertTriangle, ToggleLeft, ToggleRight, RefreshCw,
} from 'lucide-react';
import { clsx } from 'clsx';
import { IG_STOCK_EPICS, exchangeFlag } from '@/lib/ig-stock-epics';
import {
  useIGStockBot, DEFAULT_SETTINGS,
  type BotSettings, type StockSignal, type LogEntry,
} from '@/contexts/IGStockBotContext';

// ── Sub-components ────────────────────────────────────────────────────────────

function SignalBadge({ dir }: { dir: string }) {
  return (
    <span className={clsx('text-[10px] font-bold px-1.5 py-0.5 rounded',
      dir === 'BUY'  ? 'bg-emerald-500/20 text-emerald-400' :
      dir === 'SELL' ? 'bg-red-500/20 text-red-400'         :
                       'bg-gray-700/60 text-gray-500'
    )}>{dir}</span>
  );
}

function StrengthBar({ strength, dir }: { strength: number; dir: string }) {
  return (
    <div className="h-1 bg-gray-800 rounded-full overflow-hidden w-14 flex-shrink-0">
      <div className={clsx('h-full rounded-full',
        dir === 'BUY' ? 'bg-emerald-500' : dir === 'SELL' ? 'bg-red-500' : 'bg-gray-600'
      )} style={{ width: `${strength}%` }} />
    </div>
  );
}

function LogBadge({ type }: { type: LogEntry['type'] }) {
  const cls =
    type === 'buy'   ? 'text-emerald-400 bg-emerald-500/10' :
    type === 'sell'  ? 'text-red-400     bg-red-500/10'     :
    type === 'close' ? 'text-blue-400    bg-blue-500/10'    :
    type === 'error' ? 'text-red-400     bg-red-500/10'     :
    type === 'warn'  ? 'text-amber-400   bg-amber-500/10'   :
                       'text-gray-400    bg-gray-700/40';
  return <span className={clsx('text-[9px] font-bold px-1 py-0.5 rounded uppercase', cls)}>{type}</span>;
}

// ── Settings panel ────────────────────────────────────────────────────────────

function SettingsPanel({ settings, onChange }: { settings: BotSettings; onChange: (s: BotSettings) => void }) {
  function field(label: string, key: keyof BotSettings, opts: { min?: number; max?: number; step?: number; suffix?: string }) {
    const val = settings[key];
    if (typeof val === 'boolean') {
      return (
        <div key={key} className="flex items-center justify-between">
          <span className="text-xs text-gray-400">{label}</span>
          <button onClick={() => onChange({ ...settings, [key]: !val })} className="text-gray-400 hover:text-white">
            {val ? <ToggleRight className="h-5 w-5 text-emerald-400" /> : <ToggleLeft className="h-5 w-5" />}
          </button>
        </div>
      );
    }
    return (
      <div key={key} className="flex items-center justify-between gap-3">
        <span className="text-xs text-gray-400 shrink-0">{label}</span>
        <div className="flex items-center gap-1">
          <input
            type="number" min={opts.min} max={opts.max} step={opts.step ?? 1}
            value={val as number}
            onChange={e => onChange({ ...settings, [key]: Number(e.target.value) })}
            className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white font-mono text-right focus:outline-none focus:border-orange-500"
          />
          {opts.suffix && <span className="text-xs text-gray-500">{opts.suffix}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 space-y-3">
      <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Bot Settings</div>
      {field('Risk per trade',      'riskPerTrade',     { min: 10,  max: 1000, step: 10,  suffix: '£' })}
      {field('Max open positions',  'maxPositions',     { min: 1,   max: 10,   step: 1  })}
      {field('Stop loss (ATR ×)',   'stopAtrMult',      { min: 0.5, max: 5,    step: 0.5 })}
      {field('Target R:R',          'targetRR',         { min: 1,   max: 5,    step: 0.5, suffix: ':1' })}
      {field('Min signal strength', 'minStrength',      { min: 50,  max: 95,   step: 5,   suffix: '%' })}
      {field('Scan every',          'scanIntervalMins', { min: 5,   max: 60,   step: 5,   suffix: 'min' })}
      {field('Earnings blackout',   'earningsBlackout', {})}
      <p className="text-[10px] text-gray-600 pt-1">Earnings dates are hardcoded — update quarterly in IGStockBotContext.tsx.</p>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function IGStockAutoTrader() {
  const bot = useIGStockBot();
  const [showSettings, setShowSettings] = useState(false);

  const {
    status, env, session, positions, signals, logs, settings, enabled,
    available, balance, connecting, connErr, startingBalance,
  } = bot;

  const allTickers     = Object.keys(IG_STOCK_EPICS);
  const stockPositions = positions.filter(p => p.epic.startsWith('UC.D.'));
  const totalUPL       = stockPositions.reduce((s, p) => s + p.upl, 0);

  const statusColor =
    status === 'running' ? 'text-emerald-400' :
    status === 'paused'  ? 'text-amber-400'   : 'text-gray-500';

  return (
    <div className="space-y-4">

      {/* ── Header bar ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <div className={clsx('h-2 w-2 rounded-full',
              status === 'running' ? 'bg-emerald-400 animate-pulse' :
              status === 'paused'  ? 'bg-amber-400' : 'bg-gray-600'
            )} />
            <span className={clsx('text-xs font-semibold capitalize', statusColor)}>{status}</span>
            {status !== 'stopped' && (
              <span className="text-[10px] text-gray-600">· runs in background</span>
            )}
          </div>

          {status === 'stopped' && (
            <div className="flex bg-gray-800 rounded-lg p-0.5 text-xs">
              {(['demo', 'live'] as const).map(e => (
                <button key={e} onClick={() => bot.setEnv(e)}
                  className={clsx('px-3 py-1 rounded-md font-semibold capitalize transition-all',
                    env === e ? (e === 'live' ? 'bg-orange-600 text-white' : 'bg-emerald-700 text-white') : 'text-gray-400 hover:text-white'
                  )}>{e}</button>
              ))}
            </div>
          )}
          {status !== 'stopped' && (
            <span className={clsx('text-xs font-semibold px-2 py-0.5 rounded border capitalize',
              env === 'live' ? 'border-orange-600/40 text-orange-400' : 'border-emerald-700/40 text-emerald-400'
            )}>{env}</span>
          )}

          {session
            ? <span className="text-xs text-emerald-400">● Connected</span>
            : <span className="text-xs text-gray-500">○ Not connected</span>
          }
          {connErr && <span className="text-xs text-red-400">{connErr}</span>}
        </div>

        <div className="flex items-center gap-2">
          <button onClick={() => setShowSettings(v => !v)}
            className="p-2 rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:border-gray-600 transition-all">
            <Settings className="h-4 w-4" />
          </button>

          {status === 'stopped' && (
            <button onClick={() => void bot.start()} disabled={connecting}
              className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm font-semibold text-white transition-all">
              <Play className="h-3.5 w-3.5" /> Start
            </button>
          )}
          {status === 'running' && (
            <>
              <button onClick={bot.pause}
                className="flex items-center gap-1.5 px-3 py-2 bg-amber-600 hover:bg-amber-500 rounded-lg text-sm font-semibold text-white transition-all">
                <Pause className="h-3.5 w-3.5" /> Pause
              </button>
              <button onClick={bot.stop}
                className="flex items-center gap-1.5 px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm font-semibold text-white transition-all">
                <Square className="h-3.5 w-3.5" /> Stop
              </button>
            </>
          )}
          {status === 'paused' && (
            <>
              <button onClick={() => void bot.resume()}
                className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm font-semibold text-white transition-all">
                <Play className="h-3.5 w-3.5" /> Resume
              </button>
              <button onClick={bot.stop}
                className="flex items-center gap-1.5 px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm font-semibold text-white transition-all">
                <Square className="h-3.5 w-3.5" /> Stop
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Settings panel ─────────────────────────────────────────────────── */}
      {showSettings && (
        <SettingsPanel settings={settings} onChange={bot.setSettings} />
      )}

      {/* ── Stats row ──────────────────────────────────────────────────────── */}
      {session && (
        <div className="flex flex-wrap gap-4 items-center text-sm">
          {balance !== null && (
            <div><span className="text-gray-500 text-xs">Balance </span><span className="font-semibold text-white">£{balance.toFixed(2)}</span></div>
          )}
          {available !== null && (
            <div>
              <span className="text-gray-500 text-xs">Available </span>
              <span className={clsx('font-semibold',
                available < 100 ? 'text-red-400' : available < 500 ? 'text-amber-400' : 'text-emerald-400'
              )}>£{available.toFixed(2)}</span>
            </div>
          )}
          {startingBalance !== null && balance !== null && (
            <div>
              <span className="text-gray-500 text-xs">P&L </span>
              <span className={clsx('font-semibold', balance >= startingBalance ? 'text-emerald-400' : 'text-red-400')}>
                {balance >= startingBalance ? '+' : ''}£{(balance - startingBalance).toFixed(2)}
              </span>
            </div>
          )}
          {stockPositions.length > 0 && (
            <>
              <div><span className="text-gray-500 text-xs">Open </span><span className="font-semibold text-white">{stockPositions.length}</span></div>
              <div>
                <span className="text-gray-500 text-xs">UPL </span>
                <span className={clsx('font-semibold', totalUPL >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                  {totalUPL >= 0 ? '+' : ''}£{totalUPL.toFixed(2)}
                </span>
              </div>
            </>
          )}
          {available !== null && available < 100 && (
            <span className="text-xs text-red-400 flex items-center gap-1">
              <AlertTriangle className="h-3.5 w-3.5" /> Funds too low — bot will not trade
            </span>
          )}
          <button onClick={() => { void bot.fetchPositions(); void bot.fetchFunds(); }} className="text-gray-500 hover:text-white ml-auto">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* ── Stock watchlist grid ────────────────────────────────────────────── */}
      <div>
        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Watchlist — toggle to enable/disable
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 gap-2">
          {allTickers.map(ticker => {
            const info = IG_STOCK_EPICS[ticker];
            const sig  = signals[ticker];
            const on   = enabled.has(ticker);
            const pos  = stockPositions.find(p => p.epic === info.epic);
            return (
              <button key={ticker}
                onClick={() => bot.toggleTicker(ticker)}
                className={clsx(
                  'relative text-left p-3 rounded-xl border transition-all',
                  on ? 'border-gray-700 bg-gray-900 hover:border-gray-600' : 'border-gray-800 bg-gray-900/30 opacity-50'
                )}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px]">{exchangeFlag(info.exchange)}</span>
                  {sig?.scanning
                    ? <Zap className="h-3 w-3 text-amber-400 animate-pulse" />
                    : sig?.direction === 'BUY'  ? <TrendingUp  className="h-3 w-3 text-emerald-400" />
                    : sig?.direction === 'SELL' ? <TrendingDown className="h-3 w-3 text-red-400"     />
                    : <Minus className="h-3 w-3 text-gray-600" />
                  }
                </div>
                <div className="text-xs font-bold text-white">{ticker}</div>
                <div className="text-[10px] text-gray-500 truncate">{info.name}</div>

                {sig && !sig.scanning && (
                  <div className="mt-1.5 space-y-1">
                    {sig.price > 0 && (
                      <div className="text-[10px] font-mono text-gray-300">
                        {info.currency === 'GBP' ? '£' : '$'}{sig.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </div>
                    )}
                    <div className="flex items-center gap-1">
                      <SignalBadge dir={sig.direction} />
                      <StrengthBar strength={sig.strength} dir={sig.direction} />
                    </div>
                    {sig.rsi !== null && (
                      <div className={clsx('text-[9px] font-mono',
                        sig.rsi < 35 ? 'text-emerald-500' : sig.rsi > 65 ? 'text-red-500' : 'text-gray-600'
                      )}>RSI {sig.rsi.toFixed(0)}</div>
                    )}
                    {sig.blackout && (
                      <div className="text-[9px] text-amber-400 flex items-center gap-0.5">
                        <AlertTriangle className="h-2.5 w-2.5" /> Earnings soon
                      </div>
                    )}
                    {sig.error && <div className="text-[9px] text-red-500 truncate">{sig.error}</div>}
                  </div>
                )}

                {pos && (
                  <div className={clsx('absolute top-2 right-2 text-[8px] font-bold px-1 py-0.5 rounded',
                    pos.upl >= 0 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                  )}>
                    {pos.upl >= 0 ? '+' : ''}£{pos.upl.toFixed(0)}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Open positions ──────────────────────────────────────────────────── */}
      {stockPositions.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Open Stock Positions</div>
          <div className="space-y-2">
            {stockPositions.map(pos => {
              const isProfit = pos.upl >= 0;
              const info = Object.values(IG_STOCK_EPICS).find(i => i.epic === pos.epic);
              return (
                <div key={pos.dealId} className={clsx('bg-gray-900 border rounded-xl p-3 flex items-center justify-between gap-4',
                  isProfit ? 'border-emerald-600/25' : 'border-red-600/20'
                )}>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[10px]">{info ? exchangeFlag(info.exchange) : ''}</span>
                      <span className="text-sm font-bold text-white">{pos.instrumentName}</span>
                      <span className={clsx('text-[10px] font-bold px-1.5 py-0.5 rounded',
                        pos.direction === 'BUY' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                      )}>{pos.direction}</span>
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      £{pos.size}/pt · entry {pos.level.toFixed(2)}
                      {pos.stopLevel  && <span className="text-red-500"> · stop {pos.stopLevel.toFixed(2)}</span>}
                      {pos.limitLevel && <span className="text-emerald-500"> · target {pos.limitLevel.toFixed(2)}</span>}
                    </div>
                  </div>
                  <div className={clsx('text-lg font-bold shrink-0', isProfit ? 'text-emerald-400' : 'text-red-400')}>
                    {isProfit ? '+' : ''}£{pos.upl.toFixed(2)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Activity log ───────────────────────────────────────────────────── */}
      {logs.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Activity Log</div>
          <div className="bg-gray-950 border border-gray-800 rounded-xl divide-y divide-gray-800/50 max-h-56 overflow-y-auto">
            {logs.map(l => (
              <div key={l.id} className="flex items-start gap-2 px-3 py-2">
                <LogBadge type={l.type} />
                <span className="text-[10px] text-gray-600 shrink-0 font-mono">
                  {new Date(l.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                <span className="text-[11px] text-gray-300">{l.msg}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-[10px] text-gray-600">
        Stock spread bets via IG · signals from Yahoo Finance hourly candles · bot persists across page navigation · not financial advice · capital at risk
      </p>
    </div>
  );
}

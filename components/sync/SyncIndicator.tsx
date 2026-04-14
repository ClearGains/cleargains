'use client';

import { Cloud, CloudOff, RefreshCw, KeyRound, X } from 'lucide-react';
import { useState, useEffect } from 'react';
import { useSyncContext } from '@/lib/syncContext';
import Link from 'next/link';
import { clsx } from 'clsx';

export function SyncIndicator() {
  const { status, lastSynced, migrationMessage, reconnectNotice, setReconnectNotice } = useSyncContext();
  const [showTooltip, setShowTooltip] = useState(false);

  // Auto-show migration message as a banner
  useEffect(() => {
    if (migrationMessage) setShowTooltip(true);
    else setShowTooltip(false);
  }, [migrationMessage]);

  const label =
    status === 'syncing' ? 'Syncing to cloud…' :
    status === 'error'   ? 'Sync failed — data saved locally' :
    lastSynced           ? `Cloud synced · ${lastSynced.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` :
    'Data syncs across all devices';

  return (
    <>
      {/* ── Cloud sync icon (navbar) ──────────────────────────────────────────── */}
      <div className="relative hidden sm:block">
        <button
          onClick={() => setShowTooltip(v => !v)}
          title={label}
          className={clsx(
            'flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs transition-colors',
            status === 'syncing' ? 'text-blue-400 bg-blue-500/10' :
            status === 'error'   ? 'text-red-400 hover:bg-red-500/10' :
            'text-emerald-400 hover:bg-emerald-500/10'
          )}
        >
          {status === 'syncing' ? (
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          ) : status === 'error' ? (
            <CloudOff className="h-3.5 w-3.5" />
          ) : (
            <Cloud className="h-3.5 w-3.5" />
          )}
        </button>

        {showTooltip && (
          <div
            className="absolute right-0 top-full mt-1.5 z-[200] w-64 bg-gray-900 border border-gray-700 rounded-xl shadow-xl p-3"
            onClick={() => setShowTooltip(false)}
          >
            <div className="flex items-start gap-2">
              {status === 'error' ? (
                <CloudOff className="h-4 w-4 text-red-400 flex-shrink-0 mt-0.5" />
              ) : (
                <Cloud className="h-4 w-4 text-emerald-400 flex-shrink-0 mt-0.5" />
              )}
              <div>
                <p className={clsx('text-xs font-semibold',
                  status === 'error' ? 'text-red-300' : 'text-emerald-300'
                )}>
                  {status === 'error' ? 'Sync Error' : status === 'syncing' ? 'Syncing…' : 'Cloud Synced'}
                </p>
                <p className="text-[11px] text-gray-400 mt-0.5 leading-snug">
                  {migrationMessage ?? label}
                </p>
                {lastSynced && status !== 'error' && (
                  <p className="text-[10px] text-gray-600 mt-1">
                    Last synced {lastSynced.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Welcome-back reconnect banner ─────────────────────────────────────── */}
      {reconnectNotice && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[300] w-full max-w-md px-4">
          <div className="bg-gray-900 border border-amber-500/40 rounded-xl shadow-2xl p-4 flex items-start gap-3">
            <KeyRound className="h-5 w-5 text-amber-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-white">Welcome back — portfolios synced</p>
              {reconnectNotice === 'encrypted' ? (
                <p className="text-xs text-gray-400 mt-1 leading-snug">
                  Your encrypted T212 credentials are stored in the cloud.{' '}
                  <Link href="/settings" className="text-amber-400 hover:underline" onClick={() => setReconnectNotice(null)}>
                    Go to Settings
                  </Link>{' '}
                  to decrypt and reconnect on this device.
                </p>
              ) : (
                <p className="text-xs text-gray-400 mt-1 leading-snug">
                  Your portfolios and history have synced. Please{' '}
                  <Link href="/settings/accounts" className="text-amber-400 hover:underline" onClick={() => setReconnectNotice(null)}>
                    reconnect your Trading 212 accounts
                  </Link>{' '}
                  on this device.
                </p>
              )}
            </div>
            <button
              onClick={() => setReconnectNotice(null)}
              className="text-gray-600 hover:text-gray-400 flex-shrink-0"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}

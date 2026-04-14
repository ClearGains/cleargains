'use client';

import { createContext, useContext, useState, useCallback, ReactNode } from 'react';

export type SyncStatus = 'idle' | 'syncing' | 'error';

interface SyncContextValue {
  status: SyncStatus;
  lastSynced: Date | null;
  migrationMessage: string | null;
  setSyncing: () => void;
  setSynced: () => void;
  setError: () => void;
  setMigrationMessage: (msg: string | null) => void;
}

const SyncContext = createContext<SyncContextValue>({
  status: 'idle',
  lastSynced: null,
  migrationMessage: null,
  setSyncing: () => {},
  setSynced: () => {},
  setError: () => {},
  setMigrationMessage: () => {},
});

export function SyncProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SyncStatus>('idle');
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [migrationMessage, setMigrationMessage] = useState<string | null>(null);

  const setSyncing = useCallback(() => setStatus('syncing'), []);
  const setSynced  = useCallback(() => { setStatus('idle'); setLastSynced(new Date()); }, []);
  const setError   = useCallback(() => setStatus('error'), []);

  return (
    <SyncContext.Provider value={{ status, lastSynced, migrationMessage, setSyncing, setSynced, setError, setMigrationMessage }}>
      {children}
    </SyncContext.Provider>
  );
}

export function useSyncContext() {
  return useContext(SyncContext);
}

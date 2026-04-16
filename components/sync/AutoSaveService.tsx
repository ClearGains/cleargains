'use client';

import { useEffect, useRef } from 'react';
import { useClearGainsStore } from '@/lib/store';
import { exportData, recordBackup } from '@/lib/backup';
import { getStoredAccountId, getStoredSyncUrl, setStoredSyncUrl } from '@/lib/fingerprint';

const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Headless component — mounts once in the layout tree.
 * When auto-save is enabled it uploads the full backup to Vercel Blob every 10 minutes.
 */
export function AutoSaveService() {
  const { autoSaveEnabled, setSyncStatus, setSyncLastSaved } = useClearGainsStore();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!autoSaveEnabled) {
      setSyncStatus('idle');
      return;
    }

    async function performSave() {
      const accountId = getStoredAccountId();
      if (!accountId) return; // no key connected yet

      setSyncStatus('saving');
      try {
        const backup = exportData();
        const res = await fetch('/api/sync/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ backup, accountId }),
        });
        const data = await res.json() as { ok: boolean; syncUrl?: string };

        if (data.ok && data.syncUrl) {
          setStoredSyncUrl(accountId, data.syncUrl);
          recordBackup();
          setSyncLastSaved(new Date().toISOString());
          setSyncStatus('saved');
          // Fade back to idle after 8 s
          timerRef.current = setTimeout(() => setSyncStatus('idle'), 8000);
        } else {
          setSyncStatus('error');
        }
      } catch {
        setSyncStatus('error');
      }
    }

    const interval = setInterval(performSave, INTERVAL_MS);
    return () => {
      clearInterval(interval);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [autoSaveEnabled, setSyncStatus, setSyncLastSaved]);

  return null;
}

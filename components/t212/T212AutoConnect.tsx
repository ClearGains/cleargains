'use client';

import { useEffect, useRef } from 'react';
import { useClearGainsStore } from '@/lib/store';

/**
 * Mounts once in the root layout. On every page load, if credentials exist in
 * localStorage (via Zustand persist), silently re-verifies them against T212.
 * - Success → keeps t212Connected = true
 * - 401 / bad response → clears all credentials (forces reconnect)
 * - Network error → leaves credentials as-is (offline tolerance)
 */
export function T212AutoConnect() {
  const {
    t212ApiKey,
    t212ApiSecret,
    setT212Connected,
    setT212AccountInfo,
    clearT212Credentials,
  } = useClearGainsStore();

  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;

    if (!t212ApiKey || !t212ApiSecret) return;

    (async () => {
      try {
        const encoded = btoa(t212ApiKey + ':' + t212ApiSecret);
        const res = await fetch('/api/t212/connect', {
          method: 'POST',
          headers: { 'x-t212-auth': encoded },
        });
        const data = await res.json();

        if (data.ok) {
          setT212Connected(true);
          if (data.accountId) {
            setT212AccountInfo({ id: data.accountId, currency: data.currency });
          }
        } else {
          // Credentials revoked or expired — force reconnect
          clearT212Credentials();
        }
      } catch {
        // Network error — keep credentials, user may be offline
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

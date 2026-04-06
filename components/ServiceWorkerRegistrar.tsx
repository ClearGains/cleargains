'use client';

import { useEffect } from 'react';
import { registerServiceWorker } from '@/lib/pushNotifications';

export function ServiceWorkerRegistrar() {
  useEffect(() => {
    registerServiceWorker();
  }, []);
  return null;
}

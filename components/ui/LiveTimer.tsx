'use client';
import { useState, useEffect } from 'react';

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function LiveTimer({
  since,
  prefix = '',
  className = '',
}: {
  since: string | number | null | undefined;
  prefix?: string;
  className?: string;
}) {
  const [display, setDisplay] = useState('');

  useEffect(() => {
    if (!since) { setDisplay(''); return; }
    const startMs = typeof since === 'string' ? new Date(since).getTime() : since;
    if (isNaN(startMs)) { setDisplay(''); return; }
    const update = () => setDisplay(formatElapsed(Date.now() - startMs));
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [since]);

  if (!display) return null;
  return <span className={className}>{prefix}{display}</span>;
}

export function LiveCountdown({
  until,
  prefix = '',
  className = '',
}: {
  until: number | null | undefined;
  prefix?: string;
  className?: string;
}) {
  const [display, setDisplay] = useState('');

  useEffect(() => {
    if (!until) { setDisplay(''); return; }
    const update = () => {
      const remaining = Math.max(0, until - Date.now());
      const s = Math.ceil(remaining / 1000);
      const m = Math.floor(s / 60);
      const sec = s % 60;
      setDisplay(m > 0 ? `${m}:${String(sec).padStart(2, '0')}` : `${sec}s`);
    };
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [until]);

  if (!display) return null;
  return <span className={className}>{prefix}{display}</span>;
}

'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useClearGainsStore } from '@/lib/store';

export default function RootPage() {
  const router = useRouter();
  const { hasOnboarded } = useClearGainsStore();

  useEffect(() => {
    if (hasOnboarded) {
      router.replace('/dashboard');
    } else {
      router.replace('/onboarding');
    }
  }, [hasOnboarded, router]);

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-gray-500 text-sm">Loading ClearGains…</p>
      </div>
    </div>
  );
}

import { FutureLeaders } from '@/components/FutureLeaders';
import { Rocket } from 'lucide-react';

export const metadata = { title: 'Future Leaders | ClearGains' };

export default function FutureLeadersPage() {
  return (
    <main className="max-w-screen-2xl mx-auto px-4 py-6 space-y-2">
      <div className="flex items-baseline gap-3 mb-6">
        <div className="flex items-center gap-2">
          <Rocket className="h-5 w-5 text-purple-400" />
          <h1 className="text-xl font-bold text-white">Future Leaders</h1>
        </div>
        <span className="text-xs text-gray-500">
          Niche &amp; emerging stocks expected to dominate industries — sized for your timeframe
        </span>
      </div>
      <FutureLeaders />
    </main>
  );
}

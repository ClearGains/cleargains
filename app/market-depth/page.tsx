import { MarketDepth } from '@/components/MarketDepth';
import { Scale } from 'lucide-react';

export const metadata = { title: 'Market Depth | ClearGains' };

export default function MarketDepthPage() {
  return (
    <main className="max-w-screen-xl mx-auto px-4 py-6 space-y-2">
      <div className="flex items-baseline gap-3 mb-6">
        <div className="flex items-center gap-2">
          <Scale className="h-5 w-5 text-blue-400" />
          <h1 className="text-xl font-bold text-white">Market Depth</h1>
        </div>
        <span className="text-xs text-gray-500">
          Bid vs ask, options bets (calls vs puts), and key price levels where buyers and sellers appear
        </span>
      </div>
      <MarketDepth />
    </main>
  );
}

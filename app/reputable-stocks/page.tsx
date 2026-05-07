import { ReputableStocks } from '@/components/ReputableStocks';
import { Star } from 'lucide-react';

export const metadata = { title: 'Reputable Stocks | ClearGains' };

export default function ReputableStocksPage() {
  return (
    <main className="max-w-screen-2xl mx-auto px-4 py-6 space-y-2">
      <div className="flex items-baseline gap-3 mb-6">
        <div className="flex items-center gap-2">
          <Star className="h-5 w-5 text-yellow-400" />
          <h1 className="text-xl font-bold text-white">Reputable Stocks</h1>
        </div>
        <span className="text-xs text-gray-500">
          Established blue-chip companies — entry, stop and target levels sized for your chosen timeframe
        </span>
      </div>
      <ReputableStocks />
    </main>
  );
}

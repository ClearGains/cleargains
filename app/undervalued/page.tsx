import { UndervaluedStocks } from '@/components/UndervaluedStocks';
import { Gem } from 'lucide-react';

export const metadata = { title: 'Undervalued Stocks | ClearGains' };

export default function UndervaluedPage() {
  return (
    <main className="max-w-screen-2xl mx-auto px-4 py-6 space-y-2">
      <div className="flex items-baseline gap-3 mb-6">
        <div className="flex items-center gap-2">
          <Gem className="h-5 w-5 text-emerald-400" />
          <h1 className="text-xl font-bold text-white">Undervalued Stocks</h1>
        </div>
        <span className="text-xs text-gray-500">
          Stocks near 52-week lows, oversold dips, and BUY signals — potential value entries
        </span>
      </div>
      <UndervaluedStocks />
    </main>
  );
}

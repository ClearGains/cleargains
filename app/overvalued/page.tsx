import { OvervaluedStocks } from '@/components/OvervaluedStocks';
import { AlertTriangle } from 'lucide-react';

export const metadata = { title: 'Overvalued Stocks | ClearGains' };

export default function OvervaluedPage() {
  return (
    <main className="max-w-screen-2xl mx-auto px-4 py-6 space-y-2">
      <div className="flex items-baseline gap-3 mb-6">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-red-400" />
          <h1 className="text-xl font-bold text-white">Overvalued Stocks</h1>
        </div>
        <span className="text-xs text-gray-500">
          Stocks with large moves and elevated reversal risk — parabolic runs, near 52-week highs, SELL signals
        </span>
      </div>
      <OvervaluedStocks />
    </main>
  );
}

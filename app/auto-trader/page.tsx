import { AutoTrader } from '@/components/AutoTrader';
import { Bot } from 'lucide-react';

export const metadata = { title: 'Auto Trader | ClearGains' };

export default function AutoTraderPage() {
  return (
    <main className="max-w-screen-2xl mx-auto px-4 py-6 space-y-2">
      <div className="flex items-baseline gap-3 mb-6">
        <div className="flex items-center gap-2">
          <Bot className="h-5 w-5 text-orange-400" />
          <h1 className="text-xl font-bold text-white">Auto Trader</h1>
        </div>
        <span className="text-xs text-gray-500">
          Signal scanner — runs the strategy and shows manual entry levels for IG spread bets
        </span>
      </div>
      <AutoTrader />
    </main>
  );
}

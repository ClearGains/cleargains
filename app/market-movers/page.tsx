import { MarketMovers } from '@/components/MarketMovers';

export const metadata = { title: 'Market Movers | ClearGains' };

export default function MarketMoversPage() {
  return (
    <main className="max-w-screen-2xl mx-auto px-4 py-6 space-y-2">
      <div className="flex items-baseline gap-3 mb-6">
        <h1 className="text-xl font-bold text-white">Market Movers</h1>
        <span className="text-xs text-gray-500">Daily movers and predicted opportunities</span>
      </div>
      <MarketMovers />
    </main>
  );
}

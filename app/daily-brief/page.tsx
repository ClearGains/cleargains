import { DailyBrief } from '@/components/DailyBrief';

export const metadata = { title: 'Daily Brief | ClearGains' };

export default function DailyBriefPage() {
  return (
    <main className="max-w-screen-2xl mx-auto px-4 py-6 space-y-2">
      <div className="flex items-baseline gap-3 mb-6">
        <h1 className="text-xl font-bold text-white">Daily Trade Brief</h1>
        <span className="text-xs text-gray-500">IG spread bet ideas · entry levels · limits · live positions</span>
      </div>
      <DailyBrief />
    </main>
  );
}

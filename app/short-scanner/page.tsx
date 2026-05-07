import { ShortScanner } from '@/components/ShortScanner';

export const metadata = { title: 'Short Scanner | ClearGains' };

export default function ShortScannerPage() {
  return (
    <main className="max-w-screen-2xl mx-auto px-4 py-6 space-y-2">
      <div className="flex items-baseline gap-3 mb-6">
        <h1 className="text-xl font-bold text-white">Short Scanner</h1>
        <span className="text-xs text-gray-500">
          Bearish setups — death crosses, distribution tops, and downtrend momentum for spread bet short positions
        </span>
      </div>
      <ShortScanner />
    </main>
  );
}

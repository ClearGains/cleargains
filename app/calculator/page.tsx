import Calculator from '@/components/Calculator';

export const metadata = { title: 'Calculator | ClearGains' };

export default function CalculatorPage() {
  return (
    <main className="max-w-screen-2xl mx-auto px-4 py-6">
      <div className="flex items-baseline gap-3 mb-6">
        <h1 className="text-xl font-bold text-white">Calculator</h1>
        <span className="text-xs text-gray-500">Quick arithmetic</span>
      </div>
      <Calculator />
    </main>
  );
}

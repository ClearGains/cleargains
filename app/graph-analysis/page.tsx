import { GraphAnalysis } from '@/components/GraphAnalysis';

export const metadata = { title: 'Graph Analysis | ClearGains' };

export default function GraphAnalysisPage() {
  return (
    <main className="max-w-screen-2xl mx-auto px-4 py-6 space-y-2">
      <div className="flex items-baseline gap-3 mb-6">
        <h1 className="text-xl font-bold text-white">Graph Analysis</h1>
        <span className="text-xs text-gray-500">Professional-grade chart analysis with AI trade setups</span>
      </div>
      <GraphAnalysis />
    </main>
  );
}

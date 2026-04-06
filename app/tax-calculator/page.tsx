'use client';

import { Receipt } from 'lucide-react';
import UKTaxCalculator from '@/components/UKTaxCalculator';

export default function TaxCalculatorPage() {
  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Receipt className="h-6 w-6 text-emerald-400" />
          UK Tax Calculator
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          2025/26 · Income Tax · NI · CGT · IHT · SDLT · Council Tax · all rates confirmed from HMRC
        </p>
      </div>
      <UKTaxCalculator />
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { TrendingUp, ArrowRight, RefreshCw } from 'lucide-react';
import { COUNTRIES } from '@/lib/countries';
import { useClearGainsStore } from '@/lib/store';
import { Country } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { clsx } from 'clsx';

export default function OnboardingPage() {
  const router = useRouter();
  const { setCountry, setHasOnboarded, setFxRates } = useClearGainsStore();
  const [selected, setSelected] = useState<Country>(COUNTRIES[0]);
  const [fxRates, setLocalFxRates] = useState<Record<string, number>>({});
  const [loadingFx, setLoadingFx] = useState(false);

  useEffect(() => {
    fetchFxRates();
  }, []);

  async function fetchFxRates() {
    setLoadingFx(true);
    try {
      const res = await fetch('/api/fx-rates?base=GBP');
      const data = await res.json();
      if (data.rates) {
        setLocalFxRates(data.rates);
        setFxRates(data.rates);
      }
    } catch {
      // silent
    } finally {
      setLoadingFx(false);
    }
  }

  function getFxRate(currency: string): string {
    if (currency === 'GBP') return '1.0000';
    const rate = fxRates[currency];
    return rate ? rate.toFixed(4) : '—';
  }

  function handleContinue() {
    setCountry(selected);
    setHasOnboarded(true);
    router.push('/dashboard');
  }

  return (
    <div className="min-h-[calc(100vh-8rem)] bg-gray-950 px-4 py-10">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 bg-emerald-600/10 border border-emerald-600/20 rounded-full px-4 py-1.5 text-emerald-400 text-sm font-medium mb-4">
            <TrendingUp className="h-4 w-4" />
            Welcome to ClearGains
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-3">
            Select Your Country
          </h1>
          <p className="text-gray-400 max-w-xl mx-auto text-base">
            Choose your country to customise tax rates, CGT calculations, and filing deadlines.
            Live FX rates are shown relative to GBP.
          </p>
        </div>

        {/* FX refresh */}
        <div className="flex justify-end mb-4">
          <button
            onClick={fetchFxRates}
            disabled={loadingFx}
            className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            <RefreshCw className={clsx('h-3 w-3', loadingFx && 'animate-spin')} />
            {loadingFx ? 'Fetching rates…' : 'Refresh FX rates'}
          </button>
        </div>

        {/* Country grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 mb-8">
          {COUNTRIES.map((country) => {
            const isSelected = selected.code === country.code;
            return (
              <button
                key={country.code}
                onClick={() => setSelected(country)}
                className={clsx(
                  'text-left p-4 rounded-xl border transition-all duration-150',
                  isSelected
                    ? 'bg-emerald-600/15 border-emerald-500 shadow-lg shadow-emerald-900/20'
                    : 'bg-gray-900 border-gray-800 hover:border-gray-600 hover:bg-gray-800/50'
                )}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-3xl">{country.flag}</span>
                  {isSelected && (
                    <div className="w-5 h-5 bg-emerald-500 rounded-full flex items-center justify-center">
                      <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                  )}
                </div>
                <div className="font-semibold text-white text-sm mb-0.5">{country.name}</div>
                <div className="text-xs text-gray-400 mb-2">
                  {country.currencySymbol} {country.currency}
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-600">CGT Rate</span>
                    <span className="text-xs font-medium text-gray-300">
                      {country.cgRates.flat !== undefined
                        ? `${country.cgRates.flat}%`
                        : `${country.cgRates.basic}%/${country.cgRates.higher}%`}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-600">AEA</span>
                    <span className="text-xs font-medium text-gray-300">
                      {country.aea > 0
                        ? `${country.currencySymbol}${country.aea.toLocaleString()}`
                        : 'None'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-600">1 GBP =</span>
                    <span className={clsx('text-xs font-mono font-medium', loadingFx ? 'text-gray-600' : 'text-emerald-400')}>
                      {getFxRate(country.currency)} {country.currency}
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Selected summary */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-2xl">{selected.flag}</span>
                <h3 className="text-lg font-semibold text-white">{selected.name}</h3>
              </div>
              <p className="text-sm text-gray-400 mb-3">{selected.taxSystem}</p>
              <p className="text-xs text-gray-500 max-w-lg">{selected.notes}</p>
            </div>
            <div className="text-right space-y-1 flex-shrink-0 ml-4">
              <div className="text-xs text-gray-500">Tax Year</div>
              <div className="text-sm text-gray-300">{selected.taxYear}</div>
              <div className="text-xs text-gray-500 mt-2">Filing Deadline</div>
              <div className="text-sm text-emerald-400 font-medium">{selected.filingDeadline}</div>
            </div>
          </div>
        </div>

        {/* Continue button */}
        <div className="flex justify-center">
          <Button
            onClick={handleContinue}
            size="lg"
            icon={<ArrowRight className="h-5 w-5" />}
            className="px-8"
          >
            Continue to Dashboard
          </Button>
        </div>

        <p className="text-center text-xs text-gray-600 mt-4">
          You can change your country at any time by clicking the flag in the top navigation bar.
        </p>
      </div>
    </div>
  );
}

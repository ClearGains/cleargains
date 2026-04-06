'use client';

import { useState } from 'react';
import { Globe, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import { COUNTRIES } from '@/lib/countries';
import { useClearGainsStore } from '@/lib/store';
import { Card, CardHeader } from '@/components/ui/Card';
import { clsx } from 'clsx';

export default function TaxGuidesPage() {
  const { selectedCountry, setCountry } = useClearGainsStore();
  const [expanded, setExpanded] = useState<string>(selectedCountry.code);

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Globe className="h-6 w-6 text-emerald-400" />
          Tax Guides
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Country-specific capital gains tax rules and filing information
        </p>
      </div>

      {/* Selected country highlight */}
      <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-4 py-3 mb-6 flex items-center gap-3">
        <span className="text-2xl">{selectedCountry.flag}</span>
        <div>
          <div className="text-sm font-semibold text-emerald-400">
            Currently selected: {selectedCountry.name}
          </div>
          <div className="text-xs text-gray-500">
            CGT calculations use {selectedCountry.name} rules · {selectedCountry.taxSystem}
          </div>
        </div>
      </div>

      {/* Country guides */}
      <div className="space-y-3">
        {COUNTRIES.map((country) => {
          const isSelected = selectedCountry.code === country.code;
          const isOpen = expanded === country.code;

          return (
            <div
              key={country.code}
              className={clsx(
                'bg-gray-900 border rounded-xl overflow-hidden transition-colors',
                isSelected ? 'border-emerald-500/40' : 'border-gray-800'
              )}
            >
              {/* Header row */}
              <button
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-800/40 transition-colors"
                onClick={() => setExpanded(isOpen ? '' : country.code)}
              >
                <div className="flex items-center gap-3">
                  <span className="text-2xl">{country.flag}</span>
                  <div className="text-left">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-white">{country.name}</span>
                      {isSelected && (
                        <span className="text-xs bg-emerald-600/20 text-emerald-400 border border-emerald-600/30 px-1.5 py-0.5 rounded">
                          Active
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500">
                      {country.taxSystem} · Deadline: {country.filingDeadline}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="hidden sm:block text-right">
                    <div className="text-xs text-gray-500">CGT Rate</div>
                    <div className="text-sm font-mono text-gray-200">
                      {country.cgRates.flat !== undefined
                        ? `${country.cgRates.flat}%`
                        : `${country.cgRates.basic}% / ${country.cgRates.higher}%`}
                    </div>
                  </div>
                  <div className="hidden sm:block text-right">
                    <div className="text-xs text-gray-500">Exemption</div>
                    <div className="text-sm font-mono text-gray-200">
                      {country.aea > 0
                        ? `${country.currencySymbol}${country.aea.toLocaleString()}`
                        : 'None'}
                    </div>
                  </div>
                  {isOpen ? (
                    <ChevronUp className="h-4 w-4 text-gray-500" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-gray-500" />
                  )}
                </div>
              </button>

              {/* Expanded content */}
              {isOpen && (
                <div className="px-4 pb-4 border-t border-gray-800">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
                    {/* Details */}
                    <div className="space-y-3">
                      {[
                        { label: 'Tax Year', value: country.taxYear },
                        { label: 'Filing Deadline', value: country.filingDeadline },
                        { label: 'Currency', value: `${country.currency} (${country.currencySymbol})` },
                        { label: 'Tax System', value: country.taxSystem },
                        {
                          label: country.aeaLabel,
                          value:
                            country.aea > 0
                              ? `${country.currencySymbol}${country.aea.toLocaleString()}`
                              : 'No exemption',
                        },
                      ].map(({ label, value }) => (
                        <div key={label} className="flex justify-between items-start gap-2">
                          <span className="text-xs text-gray-500 flex-shrink-0">{label}</span>
                          <span className="text-xs text-gray-200 text-right">{value}</span>
                        </div>
                      ))}
                    </div>

                    {/* CGT rates */}
                    <div>
                      <div className="text-xs text-gray-500 mb-2">CGT Rates</div>
                      <div className="space-y-2">
                        {country.cgRates.flat !== undefined ? (
                          <div className="bg-gray-800 rounded-lg px-3 py-2">
                            <div className="text-xs text-gray-400">Flat Rate</div>
                            <div className="text-2xl font-bold text-white font-mono">
                              {country.cgRates.flat}%
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="bg-gray-800 rounded-lg px-3 py-2">
                              <div className="text-xs text-gray-400">Basic Rate</div>
                              <div className="text-2xl font-bold text-emerald-400 font-mono">
                                {country.cgRates.basic}%
                              </div>
                            </div>
                            <div className="bg-gray-800 rounded-lg px-3 py-2">
                              <div className="text-xs text-gray-400">Higher Rate</div>
                              <div className="text-2xl font-bold text-yellow-400 font-mono">
                                {country.cgRates.higher}%
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Notes */}
                  <div className="mt-4 bg-gray-800/50 rounded-lg px-3 py-3">
                    <div className="text-xs text-gray-500 mb-1">Important Notes</div>
                    <p className="text-xs text-gray-400 leading-relaxed">{country.notes}</p>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-3 mt-4">
                    {!isSelected && (
                      <button
                        onClick={() => setCountry(country)}
                        className="text-xs bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-600/30 text-emerald-400 px-3 py-1.5 rounded-lg transition-colors"
                      >
                        Switch to {country.name}
                      </button>
                    )}
                    {country.code === 'GB' && (
                      <a
                        href="https://www.gov.uk/capital-gains-tax"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                      >
                        HMRC CGT Guide <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-xs text-gray-600 text-center mt-6">
        Tax rules change frequently. Always verify with official government sources or a qualified tax adviser.
        Information accurate as of 2024/25 tax year.
      </p>
    </div>
  );
}

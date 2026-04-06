'use client';

import { useState } from 'react';
import {
  Calendar,
  Bell,
  BellOff,
  AlertTriangle,
  Clock,
  CheckCircle,
} from 'lucide-react';
import { COUNTRIES } from '@/lib/countries';
import { useClearGainsStore } from '@/lib/store';
import { Card, CardHeader } from '@/components/ui/Card';
import { clsx } from 'clsx';

function getDaysUntil(month: number, day: number): number {
  const now = new Date();
  const thisYear = now.getFullYear();
  let target = new Date(thisYear, month - 1, day);
  if (target < now) {
    target = new Date(thisYear + 1, month - 1, day);
  }
  const diff = target.getTime() - now.getTime();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function urgencyColor(days: number): string {
  if (days <= 30) return 'text-red-400';
  if (days <= 90) return 'text-yellow-400';
  return 'text-emerald-400';
}

function urgencyBg(days: number): string {
  if (days <= 30) return 'border-red-500/30 bg-red-500/5';
  if (days <= 90) return 'border-yellow-500/30 bg-yellow-500/5';
  return 'border-gray-700 bg-gray-800/30';
}

export default function DeadlinesPage() {
  const { selectedCountry, deadlineReminders, toggleDeadlineReminder } = useClearGainsStore();

  const deadlines = COUNTRIES.map((c) => ({
    ...c,
    daysUntil: getDaysUntil(c.filingDeadlineMonth, c.filingDeadlineDay),
  })).sort((a, b) => a.daysUntil - b.daysUntil);

  // Upcoming for selected country
  const myDeadline = deadlines.find((d) => d.code === selectedCountry.code);

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Calendar className="h-6 w-6 text-emerald-400" />
          Tax Deadlines
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Filing deadlines and self-assessment dates for all supported countries
        </p>
      </div>

      {/* My deadline highlight */}
      {myDeadline && (
        <div
          className={clsx(
            'border rounded-xl px-5 py-4 mb-6',
            urgencyBg(myDeadline.daysUntil)
          )}
        >
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <span className="text-3xl">{myDeadline.flag}</span>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-white">{myDeadline.name}</span>
                  <span className="text-xs bg-emerald-600/20 text-emerald-400 border border-emerald-600/30 px-1.5 py-0.5 rounded">
                    Your country
                  </span>
                </div>
                <div className="text-sm text-gray-400 mt-0.5">
                  Filing deadline: <span className="font-medium text-white">{myDeadline.filingDeadline}</span>
                </div>
              </div>
            </div>
            <div className="text-right">
              <div
                className={clsx('text-3xl font-bold font-mono', urgencyColor(myDeadline.daysUntil))}
              >
                {myDeadline.daysUntil}
              </div>
              <div className="text-xs text-gray-500">days remaining</div>
            </div>
          </div>

          {myDeadline.daysUntil <= 30 && (
            <div className="mt-3 flex items-center gap-2 text-xs text-red-400">
              <AlertTriangle className="h-3.5 w-3.5" />
              Deadline is approaching! File your return as soon as possible.
            </div>
          )}
          {myDeadline.daysUntil > 30 && myDeadline.daysUntil <= 90 && (
            <div className="mt-3 flex items-center gap-2 text-xs text-yellow-400">
              <Clock className="h-3.5 w-3.5" />
              Start gathering your records now — deadline is within 90 days.
            </div>
          )}
          {myDeadline.daysUntil > 90 && (
            <div className="mt-3 flex items-center gap-2 text-xs text-emerald-400">
              <CheckCircle className="h-3.5 w-3.5" />
              You have plenty of time — but keep your records up to date throughout the year.
            </div>
          )}
        </div>
      )}

      {/* All deadlines */}
      <Card className="mb-6">
        <CardHeader
          title="All Filing Deadlines"
          subtitle="Sorted by nearest deadline first"
          icon={<Calendar className="h-4 w-4" />}
        />
        <div className="space-y-2">
          {deadlines.map((country) => {
            const hasReminder = deadlineReminders.includes(country.code);
            return (
              <div
                key={country.code}
                className={clsx(
                  'flex items-center justify-between py-3 px-3 rounded-lg border transition-colors',
                  country.code === selectedCountry.code
                    ? 'border-emerald-500/30 bg-emerald-500/5'
                    : urgencyBg(country.daysUntil)
                )}
              >
                <div className="flex items-center gap-3">
                  <span className="text-xl">{country.flag}</span>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-white">{country.name}</span>
                      {country.code === selectedCountry.code && (
                        <span className="text-xs text-emerald-400">(you)</span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500">{country.filingDeadline}</div>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <div
                      className={clsx(
                        'text-lg font-bold font-mono',
                        urgencyColor(country.daysUntil)
                      )}
                    >
                      {country.daysUntil}d
                    </div>
                    <div className="text-xs text-gray-600">remaining</div>
                  </div>

                  <button
                    onClick={() => toggleDeadlineReminder(country.code)}
                    className={clsx(
                      'p-2 rounded-lg transition-colors',
                      hasReminder
                        ? 'text-yellow-400 bg-yellow-500/10 hover:bg-yellow-500/20'
                        : 'text-gray-600 hover:text-gray-400 hover:bg-gray-700'
                    )}
                    title={hasReminder ? 'Remove reminder' : 'Set reminder'}
                  >
                    {hasReminder ? (
                      <Bell className="h-4 w-4" />
                    ) : (
                      <BellOff className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* UK self-assessment checklist */}
      {selectedCountry.code === 'GB' && (
        <Card>
          <CardHeader
            title="UK Self Assessment Checklist"
            subtitle="What you need to file your SA108"
            icon={<CheckCircle className="h-4 w-4" />}
          />
          <div className="space-y-3">
            {[
              {
                item: 'All disposal records (date sold, proceeds, acquisition date)',
                note: 'Available in Trade Ledger',
              },
              {
                item: 'Section 104 pool calculations for each share',
                note: 'Computed in CGT Calculator',
              },
              {
                item: 'Same-day and 30-day matching computations',
                note: 'Computed in CGT Calculator',
              },
              {
                item: 'Total allowable costs including stamp duty and broker fees',
                note: 'Include in each trade',
              },
              {
                item: 'ISA records (these are CGT-free and excluded from SA108)',
                note: 'Mark ISA trades in ledger',
              },
              {
                item: 'Losses from previous years (can carry forward indefinitely)',
                note: 'HMRC form SA108 Box 23',
              },
              {
                item: 'Foreign income declarations if shares held in non-GBP currency',
                note: 'Use FX rate on transaction date',
              },
            ].map(({ item, note }) => (
              <div key={item} className="flex items-start gap-3 py-2 border-b border-gray-800/50 last:border-0">
                <div className="w-4 h-4 rounded border border-gray-600 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm text-gray-300">{item}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{note}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2">
            <p className="text-xs text-blue-400">
              <span className="font-semibold">Filing deadline:</span> 31 January (online) or
              31 October (paper) following the end of the tax year (5 April). Late filing
              incurs a £100 penalty.
            </p>
          </div>
        </Card>
      )}
    </div>
  );
}

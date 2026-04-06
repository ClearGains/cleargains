'use client';

import { useState, useMemo } from 'react';
import { Receipt, Info, ChevronDown, ChevronUp } from 'lucide-react';
import { Card, CardHeader } from '@/components/ui/Card';
import { clsx } from 'clsx';

// ─── 2025/26 HMRC RATES ───────────────────────────────────────────────────────

const PERSONAL_ALLOWANCE = 12_570;
const PA_TAPER_START = 100_000; // PA reduced by £1 for every £2 above this
const BASIC_RATE_LIMIT = 50_270; // top of basic rate band
const HIGHER_RATE_LIMIT = 125_140; // top of higher rate band

// England / Wales / NI income tax
const EW_BANDS = [
  { label: 'Personal Allowance', rate: 0, from: 0, to: PERSONAL_ALLOWANCE },
  { label: 'Basic Rate (20%)', rate: 0.20, from: PERSONAL_ALLOWANCE, to: BASIC_RATE_LIMIT },
  { label: 'Higher Rate (40%)', rate: 0.40, from: BASIC_RATE_LIMIT, to: HIGHER_RATE_LIMIT },
  { label: 'Additional Rate (45%)', rate: 0.45, from: HIGHER_RATE_LIMIT, to: Infinity },
];

// Scottish income tax 2025/26
const SCOT_BANDS = [
  { label: 'Personal Allowance', rate: 0, from: 0, to: PERSONAL_ALLOWANCE },
  { label: 'Starter Rate (19%)', rate: 0.19, from: PERSONAL_ALLOWANCE, to: 14_876 },
  { label: 'Scottish Basic Rate (20%)', rate: 0.20, from: 14_876, to: 26_561 },
  { label: 'Intermediate Rate (21%)', rate: 0.21, from: 26_561, to: 43_662 },
  { label: 'Higher Rate (42%)', rate: 0.42, from: 43_662, to: 75_000 },
  { label: 'Advanced Rate (45%)', rate: 0.45, from: 75_000, to: HIGHER_RATE_LIMIT },
  { label: 'Top Rate (48%)', rate: 0.48, from: HIGHER_RATE_LIMIT, to: Infinity },
];

// Class 1 Employee NI 2025/26
const NI_PRIMARY_THRESHOLD = 12_570;
const NI_UPPER_EARNINGS_LIMIT = 50_270;
const NI_MAIN_RATE = 0.08;   // 8% between PT and UEL
const NI_UPPER_RATE = 0.02;  // 2% above UEL

// Class 4 Self-employed NI 2025/26
const NI_C4_LOWER = 12_570;
const NI_C4_UPPER = 50_270;
const NI_C4_MAIN = 0.06;  // 6%
const NI_C4_UPPER_RATE = 0.02; // 2%
// Class 2 abolished April 2024

// Employer NI (for Ltd company calc) 2025/26 Budget changes
const EMPLOYER_NI_THRESHOLD = 5_000;  // Secondary threshold £5,000 from Apr 2025
const EMPLOYER_NI_RATE = 0.15;        // 15% from Apr 2025

// Corporation Tax 2025/26
const CORP_TAX_SMALL = 0.19;    // Small profits rate ≤£50k
const CORP_TAX_MAIN = 0.25;     // Main rate ≥£250k
const CORP_SMALL_LIMIT = 50_000;
const CORP_MAIN_LIMIT = 250_000;

// Dividend Tax 2025/26
const DIVIDEND_ALLOWANCE = 500;
const DIV_BASIC_RATE = 0.0875;
const DIV_HIGHER_RATE = 0.3375;
const DIV_ADDITIONAL_RATE = 0.3935;

// CGT 2025/26 (post Oct 2024 Budget)
const CGT_ANNUAL_EXEMPT = 3_000;
const CGT_BASIC_RATE = 0.18;   // Non-residential property basic rate
const CGT_HIGHER_RATE = 0.24;  // Non-residential property higher rate
const CGT_RESI_BASIC = 0.18;   // Residential property basic rate
const CGT_RESI_HIGHER = 0.24;  // Residential property higher rate

// Student Loan thresholds 2025/26
const STUDENT_LOAN_PLANS: Record<string, { threshold: number; rate: number; label: string }> = {
  none:  { threshold: 0,      rate: 0,    label: 'No student loan' },
  plan1: { threshold: 24_990, rate: 0.09, label: 'Plan 1 (pre-2012 England/Wales)' },
  plan2: { threshold: 27_295, rate: 0.09, label: 'Plan 2 (post-2012 England/Wales)' },
  plan4: { threshold: 31_395, rate: 0.09, label: 'Plan 4 (Scotland)' },
  plan5: { threshold: 25_000, rate: 0.09, label: 'Plan 5 (from 2023)' },
  pg:    { threshold: 21_000, rate: 0.06, label: 'Postgraduate Loan' },
};

// ─── CALCULATION HELPERS ──────────────────────────────────────────────────────

function effectivePersonalAllowance(totalIncome: number): number {
  if (totalIncome <= PA_TAPER_START) return PERSONAL_ALLOWANCE;
  const reduction = Math.floor((totalIncome - PA_TAPER_START) / 2);
  return Math.max(0, PERSONAL_ALLOWANCE - reduction);
}

type BandResult = { label: string; rate: number; taxable: number; tax: number };

function calcIncomeTaxBands(taxableIncome: number, scottish: boolean): BandResult[] {
  const bands = scottish ? SCOT_BANDS : EW_BANDS;
  const results: BandResult[] = [];
  let remaining = Math.max(0, taxableIncome);

  for (const band of bands) {
    if (remaining <= 0) break;
    const width = band.to === Infinity ? remaining : Math.max(0, band.to - band.from);
    const taxable = Math.min(remaining, width);
    const tax = taxable * band.rate;
    if (taxable > 0 || band.from === 0) {
      results.push({ label: band.label, rate: band.rate, taxable, tax });
    }
    remaining -= taxable;
  }
  return results;
}

function calcEmployeeNI(salary: number): number {
  if (salary <= NI_PRIMARY_THRESHOLD) return 0;
  const main = Math.min(salary, NI_UPPER_EARNINGS_LIMIT) - NI_PRIMARY_THRESHOLD;
  const upper = Math.max(0, salary - NI_UPPER_EARNINGS_LIMIT);
  return main * NI_MAIN_RATE + upper * NI_UPPER_RATE;
}

function calcSelfEmployedNI(profit: number): number {
  if (profit <= NI_C4_LOWER) return 0;
  const main = Math.min(profit, NI_C4_UPPER) - NI_C4_LOWER;
  const upper = Math.max(0, profit - NI_C4_UPPER);
  return main * NI_C4_MAIN + upper * NI_C4_UPPER_RATE;
}

function calcEmployerNI(salary: number): number {
  if (salary <= EMPLOYER_NI_THRESHOLD) return 0;
  return (salary - EMPLOYER_NI_THRESHOLD) * EMPLOYER_NI_RATE;
}

function calcCorpTax(profit: number): number {
  if (profit <= 0) return 0;
  if (profit <= CORP_SMALL_LIMIT) return profit * CORP_TAX_SMALL;
  if (profit >= CORP_MAIN_LIMIT) return profit * CORP_TAX_MAIN;
  // Marginal relief
  const mainTax = profit * CORP_TAX_MAIN;
  const marginalRelief = ((CORP_MAIN_LIMIT - profit) / CORP_MAIN_LIMIT) * profit * (CORP_TAX_MAIN - CORP_TAX_SMALL);
  return mainTax - marginalRelief;
}

function calcDividendTax(dividends: number, remainingBasicBand: number): number {
  const taxable = Math.max(0, dividends - DIVIDEND_ALLOWANCE);
  if (taxable <= 0) return 0;
  const inBasic = Math.min(taxable, remainingBasicBand);
  const inHigher = Math.min(Math.max(0, taxable - remainingBasicBand), HIGHER_RATE_LIMIT - BASIC_RATE_LIMIT);
  const inAdditional = Math.max(0, taxable - remainingBasicBand - (HIGHER_RATE_LIMIT - BASIC_RATE_LIMIT));
  return inBasic * DIV_BASIC_RATE + inHigher * DIV_HIGHER_RATE + inAdditional * DIV_ADDITIONAL_RATE;
}

function calcCGT(gains: number, residentialGains: number, taxableIncome: number): number {
  const totalGains = gains + residentialGains;
  const net = Math.max(0, totalGains - CGT_ANNUAL_EXEMPT);
  if (net <= 0) return 0;
  // Amount of basic rate band remaining after income tax
  const basicBandUsed = Math.max(0, Math.min(taxableIncome, BASIC_RATE_LIMIT) - PERSONAL_ALLOWANCE);
  const basicBandRemaining = Math.max(0, (BASIC_RATE_LIMIT - PERSONAL_ALLOWANCE) - basicBandUsed);

  // Allocate between basic/higher using residential vs other
  // Simplified: non-residential first in basic band, residential goes on top
  const nonResi = Math.max(0, gains - CGT_ANNUAL_EXEMPT);
  const resi = residentialGains;

  const nonResiBasic = Math.min(nonResi, basicBandRemaining);
  const nonResiHigher = Math.max(0, nonResi - nonResiBasic);
  const resiRemaining = Math.max(0, basicBandRemaining - nonResiBasic);
  const resiBasic = Math.min(resi, resiRemaining);
  const resiHigher = Math.max(0, resi - resiBasic);

  return nonResiBasic * CGT_BASIC_RATE + nonResiHigher * CGT_HIGHER_RATE
    + resiBasic * CGT_RESI_BASIC + resiHigher * CGT_RESI_HIGHER;
}

function calcStudentLoan(income: number, plan: string): number {
  const p = STUDENT_LOAN_PLANS[plan];
  if (!p || p.rate === 0 || income <= p.threshold) return 0;
  return (income - p.threshold) * p.rate;
}

// ─── TYPES ────────────────────────────────────────────────────────────────────

type TaxLine = {
  label: string;
  sublabel?: string;
  amount: number;
  rate?: string;
  highlight?: boolean;
  dimmed?: boolean;
};

// ─── INPUT COMPONENTS ─────────────────────────────────────────────────────────

function InputField({
  label, sublabel, value, onChange, prefix = '£', min = 0, max = 9_999_999,
}: {
  label: string; sublabel?: string; value: number;
  onChange: (v: number) => void; prefix?: string; min?: number; max?: number;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-400 mb-1">{label}</label>
      {sublabel && <p className="text-[11px] text-gray-600 mb-1">{sublabel}</p>}
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">{prefix}</span>
        <input
          type="number"
          min={min}
          max={max}
          value={value || ''}
          onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || 0)))}
          className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-7 pr-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500"
          placeholder="0"
        />
      </div>
    </div>
  );
}

function SelectField<T extends string>({
  label, value, onChange, options,
}: {
  label: string; value: T; onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-400 mb-1">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-3 cursor-pointer">
      <div
        className={clsx(
          'relative w-9 h-5 rounded-full transition-colors',
          checked ? 'bg-emerald-500' : 'bg-gray-700'
        )}
        onClick={() => onChange(!checked)}
      >
        <span
          className={clsx(
            'absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform',
            checked ? 'translate-x-4' : 'translate-x-0'
          )}
        />
      </div>
      <span className="text-sm text-gray-300">{label}</span>
    </label>
  );
}

// ─── RESULTS PANEL ────────────────────────────────────────────────────────────

function fmt(n: number) {
  return n.toLocaleString('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });
}

function ResultsPanel({ lines, grossIncome }: { lines: TaxLine[]; grossIncome: number }) {
  const [expandBands, setExpandBands] = useState(false);
  const totalTax = lines.filter(l => !l.highlight).reduce((s, l) => s + l.amount, 0);
  const takeHome = grossIncome - totalTax;
  const effectiveRate = grossIncome > 0 ? (totalTax / grossIncome) * 100 : 0;

  const bandLines = lines.filter(l => l.sublabel);
  const topLines = lines.filter(l => !l.sublabel);

  return (
    <div className="space-y-1">
      {/* Income tax bands (expandable) */}
      {bandLines.length > 0 && (
        <div className="border border-gray-800 rounded-lg overflow-hidden mb-2">
          <button
            onClick={() => setExpandBands(!expandBands)}
            className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-800/40 hover:bg-gray-800/60 transition-colors"
          >
            <span className="text-xs font-semibold text-gray-300 uppercase tracking-wide">Income Tax Bands</span>
            {expandBands
              ? <ChevronUp className="h-3.5 w-3.5 text-gray-500" />
              : <ChevronDown className="h-3.5 w-3.5 text-gray-500" />}
          </button>
          {expandBands && (
            <div className="divide-y divide-gray-800/60">
              {bandLines.map((line, i) => (
                <div key={i} className="flex items-center justify-between px-4 py-2">
                  <div>
                    <p className="text-xs text-gray-300">{line.label}</p>
                    <p className="text-[11px] text-gray-600">{line.sublabel}</p>
                  </div>
                  <div className="text-right">
                    {line.rate && <p className="text-[11px] text-gray-500">{line.rate}</p>}
                    <p className={clsx('text-sm font-medium tabular-nums', line.amount === 0 ? 'text-gray-600' : 'text-white')}>
                      {fmt(line.amount)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Top-level lines */}
      <div className="divide-y divide-gray-800/40 border border-gray-800 rounded-lg overflow-hidden">
        {topLines.map((line, i) => (
          <div
            key={i}
            className={clsx(
              'flex items-center justify-between px-4 py-2.5',
              line.highlight ? 'bg-emerald-500/10' : '',
              line.dimmed ? 'opacity-40' : ''
            )}
          >
            <div>
              <p className={clsx('text-sm', line.highlight ? 'text-emerald-300 font-semibold' : 'text-gray-300')}>
                {line.label}
              </p>
              {line.sublabel && <p className="text-[11px] text-gray-500">{line.sublabel}</p>}
            </div>
            <div className="text-right">
              {line.rate && <p className="text-[11px] text-gray-500">{line.rate}</p>}
              <p className={clsx(
                'text-sm font-semibold tabular-nums',
                line.highlight ? 'text-emerald-300' : line.amount === 0 ? 'text-gray-600' : 'text-white'
              )}>
                {fmt(line.amount)}
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* Totals */}
      <div className="mt-3 border border-red-500/20 rounded-lg bg-red-500/5 px-4 py-3 flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-red-300">Total Tax &amp; Deductions</p>
          <p className="text-[11px] text-gray-500">Effective rate: {effectiveRate.toFixed(1)}%</p>
        </div>
        <p className="text-lg font-bold text-red-300 tabular-nums">{fmt(totalTax)}</p>
      </div>
      <div className="border border-emerald-500/20 rounded-lg bg-emerald-500/5 px-4 py-3 flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-emerald-300">Estimated Take-Home</p>
          <p className="text-[11px] text-gray-500">Annual net income</p>
        </div>
        <div className="text-right">
          <p className="text-lg font-bold text-emerald-300 tabular-nums">{fmt(takeHome)}</p>
          <p className="text-[11px] text-gray-500">{fmt(Math.round(takeHome / 12))}/mo · {fmt(Math.round(takeHome / 52))}/wk</p>
        </div>
      </div>
    </div>
  );
}

// ─── TAB: EMPLOYED ────────────────────────────────────────────────────────────

function EmployedTab({ scottish }: { scottish: boolean }) {
  const [salary, setSalary] = useState(40_000);
  const [pension, setPension] = useState(5);
  const [studentLoan, setStudentLoan] = useState<string>('none');
  const [dividends, setDividends] = useState(0);
  const [capitalGains, setCapitalGains] = useState(0);
  const [residentialGains, setResidentialGains] = useState(0);

  const results = useMemo(() => {
    const pensionAmount = Math.round(salary * (pension / 100));
    const adjustedSalary = salary - pensionAmount;
    const pa = effectivePersonalAllowance(adjustedSalary + dividends);
    const taxableIncome = Math.max(0, adjustedSalary - pa);

    const bands = calcIncomeTaxBands(taxableIncome, scottish);
    const incomeTax = bands.reduce((s, b) => s + b.tax, 0);
    const employeeNI = calcEmployeeNI(adjustedSalary);

    const basicBandRemaining = Math.max(0, BASIC_RATE_LIMIT - Math.min(adjustedSalary, BASIC_RATE_LIMIT));
    const dividendTax = calcDividendTax(dividends, basicBandRemaining);
    const cgt = calcCGT(capitalGains, residentialGains, adjustedSalary);
    const sl = calcStudentLoan(adjustedSalary, studentLoan);

    const gross = salary + dividends + capitalGains + residentialGains;

    const bandLines: TaxLine[] = bands
      .filter(b => b.taxable > 0)
      .map(b => ({
        label: b.label,
        sublabel: `${fmt(b.taxable)} taxable`,
        rate: b.rate === 0 ? '0%' : `${(b.rate * 100).toFixed(0)}%`,
        amount: Math.round(b.tax),
      }));

    const topLines: TaxLine[] = [
      { label: 'Income Tax (total)', rate: '', amount: Math.round(incomeTax) },
      { label: 'Employee NI (Class 1)', rate: '8% / 2%', amount: Math.round(employeeNI), sublabel: `On earnings above ${fmt(NI_PRIMARY_THRESHOLD)}` },
      { label: 'Pension Contribution', rate: `${pension}%`, amount: pensionAmount, sublabel: 'Gross (pre-tax, reduces taxable income)' },
      ...(dividends > 0 ? [{ label: 'Dividend Tax', rate: '8.75% / 33.75%', amount: Math.round(dividendTax), sublabel: `${fmt(DIVIDEND_ALLOWANCE)} allowance deducted` }] : []),
      ...((capitalGains > 0 || residentialGains > 0) ? [{ label: 'Capital Gains Tax', rate: '18% / 24%', amount: Math.round(cgt), sublabel: `${fmt(CGT_ANNUAL_EXEMPT)} annual exempt amount` }] : []),
      ...(studentLoan !== 'none' ? [{ label: 'Student Loan Repayment', rate: STUDENT_LOAN_PLANS[studentLoan]?.rate === 0.06 ? '6%' : '9%', amount: Math.round(sl) }] : []),
    ];

    return { bandLines, topLines, gross };
  }, [salary, pension, studentLoan, dividends, capitalGains, residentialGains, scottish]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Card>
        <CardHeader title="Your Details" subtitle="2025/26 tax year" icon={<Receipt className="h-4 w-4" />} />
        <div className="space-y-4">
          <InputField label="Annual Gross Salary" value={salary} onChange={setSalary} />
          <InputField label="Pension Contribution" value={pension} onChange={setPension} prefix="%" min={0} max={100} sublabel="% of salary, contributed gross (relief at source)" />
          <SelectField
            label="Student Loan"
            value={studentLoan}
            onChange={setStudentLoan}
            options={Object.entries(STUDENT_LOAN_PLANS).map(([k, v]) => ({ value: k, label: v.label }))}
          />
          <InputField label="Dividend Income" value={dividends} onChange={setDividends} sublabel="Dividends received from investments" />
          <InputField label="Capital Gains (other assets)" value={capitalGains} onChange={setCapitalGains} sublabel="e.g. shares, funds — net of costs" />
          <InputField label="Capital Gains (residential property)" value={residentialGains} onChange={setResidentialGains} sublabel="Buy-to-let or second home gains" />
        </div>
      </Card>
      <Card>
        <CardHeader title="Tax Breakdown" subtitle="Estimated liability" icon={<Receipt className="h-4 w-4" />} />
        <ResultsPanel lines={[...results.bandLines, ...results.topLines]} grossIncome={results.gross} />
      </Card>
    </div>
  );
}

// ─── TAB: SELF-EMPLOYED ───────────────────────────────────────────────────────

function SelfEmployedTab({ scottish }: { scottish: boolean }) {
  const [profit, setProfit] = useState(40_000);
  const [pension, setPension] = useState(0);
  const [studentLoan, setStudentLoan] = useState<string>('none');
  const [dividends, setDividends] = useState(0);
  const [capitalGains, setCapitalGains] = useState(0);
  const [residentialGains, setResidentialGains] = useState(0);

  const results = useMemo(() => {
    const pensionAmount = Math.min(pension, profit);
    const adjustedProfit = Math.max(0, profit - pensionAmount);
    const pa = effectivePersonalAllowance(adjustedProfit + dividends);
    const taxableIncome = Math.max(0, adjustedProfit - pa);

    const bands = calcIncomeTaxBands(taxableIncome, scottish);
    const incomeTax = bands.reduce((s, b) => s + b.tax, 0);
    const class4NI = calcSelfEmployedNI(adjustedProfit);

    const basicBandRemaining = Math.max(0, BASIC_RATE_LIMIT - Math.min(adjustedProfit, BASIC_RATE_LIMIT));
    const dividendTax = calcDividendTax(dividends, basicBandRemaining);
    const cgt = calcCGT(capitalGains, residentialGains, adjustedProfit);
    const sl = calcStudentLoan(adjustedProfit, studentLoan);

    const gross = profit + dividends + capitalGains + residentialGains;

    const bandLines: TaxLine[] = bands
      .filter(b => b.taxable > 0)
      .map(b => ({
        label: b.label,
        sublabel: `${fmt(b.taxable)} taxable`,
        rate: b.rate === 0 ? '0%' : `${(b.rate * 100).toFixed(0)}%`,
        amount: Math.round(b.tax),
      }));

    const topLines: TaxLine[] = [
      { label: 'Income Tax (total)', rate: '', amount: Math.round(incomeTax) },
      { label: 'Class 4 NI (Self-employed)', rate: '6% / 2%', amount: Math.round(class4NI), sublabel: `On profits above ${fmt(NI_C4_LOWER)} · Class 2 abolished Apr 2024` },
      ...(pensionAmount > 0 ? [{ label: 'Pension Contribution', rate: '', amount: pensionAmount, sublabel: 'Reduces taxable profit' }] : []),
      ...(dividends > 0 ? [{ label: 'Dividend Tax', rate: '8.75% / 33.75%', amount: Math.round(dividendTax) }] : []),
      ...((capitalGains > 0 || residentialGains > 0) ? [{ label: 'Capital Gains Tax', rate: '18% / 24%', amount: Math.round(cgt) }] : []),
      ...(studentLoan !== 'none' ? [{ label: 'Student Loan Repayment', rate: '9%', amount: Math.round(sl) }] : []),
    ];

    return { bandLines, topLines, gross };
  }, [profit, pension, studentLoan, dividends, capitalGains, residentialGains, scottish]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Card>
        <CardHeader title="Your Details" subtitle="2025/26 tax year" icon={<Receipt className="h-4 w-4" />} />
        <div className="space-y-4">
          <InputField label="Net Trading Profit" value={profit} onChange={setProfit} sublabel="Income after allowable business expenses" />
          <InputField label="Pension Contribution (£)" value={pension} onChange={setPension} sublabel="Annual pension contribution (reduces taxable profit)" />
          <SelectField
            label="Student Loan"
            value={studentLoan}
            onChange={setStudentLoan}
            options={Object.entries(STUDENT_LOAN_PLANS).map(([k, v]) => ({ value: k, label: v.label }))}
          />
          <InputField label="Dividend Income" value={dividends} onChange={setDividends} />
          <InputField label="Capital Gains (other assets)" value={capitalGains} onChange={setCapitalGains} />
          <InputField label="Capital Gains (residential property)" value={residentialGains} onChange={setResidentialGains} />
        </div>
      </Card>
      <Card>
        <CardHeader title="Tax Breakdown" subtitle="Estimated liability" icon={<Receipt className="h-4 w-4" />} />
        <ResultsPanel lines={[...results.bandLines, ...results.topLines]} grossIncome={results.gross} />
      </Card>
    </div>
  );
}

// ─── TAB: LIMITED COMPANY ─────────────────────────────────────────────────────

function LimitedCompanyTab({ scottish }: { scottish: boolean }) {
  const [companyProfit, setCompanyProfit] = useState(80_000);
  const [salary, setSalary] = useState(12_570);
  const [dividendsTaken, setDividendsTaken] = useState(40_000);
  const [pension, setPension] = useState(0);
  const [studentLoan, setStudentLoan] = useState<string>('none');

  const results = useMemo(() => {
    // Company level
    const employerNI = calcEmployerNI(salary);
    const pensionContrib = Math.min(pension, companyProfit); // employer pension
    const deductibles = salary + employerNI + pensionContrib;
    const taxableProfit = Math.max(0, companyProfit - deductibles);
    const corpTax = calcCorpTax(taxableProfit);
    const postTaxProfit = taxableProfit - corpTax;
    const actualDividends = Math.min(dividendsTaken, postTaxProfit);

    // Personal level
    const totalPersonalIncome = salary + actualDividends;
    const pa = effectivePersonalAllowance(totalPersonalIncome);
    const taxableSalary = Math.max(0, salary - pa);

    const bands = calcIncomeTaxBands(taxableSalary, scottish);
    const incomeTax = bands.reduce((s, b) => s + b.tax, 0);
    const employeeNI = calcEmployeeNI(salary);

    const basicBandRemaining = Math.max(0, BASIC_RATE_LIMIT - Math.min(salary, BASIC_RATE_LIMIT));
    const dividendTax = calcDividendTax(actualDividends, basicBandRemaining);
    const sl = calcStudentLoan(salary + actualDividends, studentLoan);

    const bandLines: TaxLine[] = bands
      .filter(b => b.taxable > 0)
      .map(b => ({
        label: b.label,
        sublabel: `${fmt(b.taxable)} taxable`,
        rate: b.rate === 0 ? '0%' : `${(b.rate * 100).toFixed(0)}%`,
        amount: Math.round(b.tax),
      }));

    const topLines: TaxLine[] = [
      { label: 'Corporation Tax', rate: taxableProfit <= CORP_SMALL_LIMIT ? '19%' : taxableProfit >= CORP_MAIN_LIMIT ? '25%' : '19–25% (marginal)', amount: Math.round(corpTax), sublabel: `On ${fmt(taxableProfit)} taxable profit` },
      { label: 'Employer NI (Class 1)', rate: '15%', amount: Math.round(employerNI), sublabel: `Company cost on salary above ${fmt(EMPLOYER_NI_THRESHOLD)}` },
      { label: 'Income Tax on Salary (total)', rate: '', amount: Math.round(incomeTax) },
      { label: 'Employee NI (Class 1)', rate: '8% / 2%', amount: Math.round(employeeNI) },
      { label: 'Dividend Tax', rate: '8.75% / 33.75%', amount: Math.round(dividendTax), sublabel: `${fmt(DIVIDEND_ALLOWANCE)} allowance · on ${fmt(Math.round(actualDividends))} dividends` },
      ...(sl > 0 ? [{ label: 'Student Loan Repayment', rate: '9%', amount: Math.round(sl) }] : []),
    ];

    const gross = salary + actualDividends;

    return { bandLines, topLines, gross, corpTax: Math.round(corpTax), employerNI: Math.round(employerNI), postTaxProfit: Math.round(postTaxProfit) };
  }, [companyProfit, salary, dividendsTaken, pension, studentLoan, scottish]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Card>
        <CardHeader title="Company &amp; Director Details" subtitle="2025/26 tax year" icon={<Receipt className="h-4 w-4" />} />
        <div className="space-y-4">
          <InputField label="Company Pre-tax Profit" value={companyProfit} onChange={setCompanyProfit} sublabel="Before director salary and NI" />
          <InputField label="Director Salary" value={salary} onChange={setSalary} sublabel="Typically set at NI threshold (£12,570) to minimise NI" />
          <InputField label="Dividends Taken" value={dividendsTaken} onChange={setDividendsTaken} sublabel="From post-corporation-tax profit" />
          <InputField label="Employer Pension Contribution (£)" value={pension} onChange={setPension} sublabel="Company pension contribution (deductible from profit)" />
          <SelectField
            label="Student Loan"
            value={studentLoan}
            onChange={setStudentLoan}
            options={Object.entries(STUDENT_LOAN_PLANS).map(([k, v]) => ({ value: k, label: v.label }))}
          />
          <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2 text-xs text-blue-300">
            Post-corporation-tax profit available for dividends: <strong>{fmt(results.postTaxProfit)}</strong>
          </div>
        </div>
      </Card>
      <Card>
        <CardHeader title="Tax Breakdown" subtitle="Company + personal combined" icon={<Receipt className="h-4 w-4" />} />
        <ResultsPanel lines={[...results.bandLines, ...results.topLines]} grossIncome={results.gross} />
      </Card>
    </div>
  );
}

// ─── TAB: ALL INCOME SOURCES ──────────────────────────────────────────────────

function AllIncomeTab({ scottish }: { scottish: boolean }) {
  const [salary, setSalary] = useState(30_000);
  const [selfEmployed, setSelfEmployed] = useState(0);
  const [rental, setRental] = useState(0);
  const [savings, setSavings] = useState(0);
  const [dividends, setDividends] = useState(0);
  const [capitalGains, setCapitalGains] = useState(0);
  const [residentialGains, setResidentialGains] = useState(0);
  const [pension, setPension] = useState(0);
  const [studentLoan, setStudentLoan] = useState<string>('none');

  const results = useMemo(() => {
    const totalEarned = salary + selfEmployed + rental + savings;
    const pensionRelief = Math.min(pension, totalEarned);
    const adjustedEarned = Math.max(0, totalEarned - pensionRelief);

    const pa = effectivePersonalAllowance(adjustedEarned + dividends);

    // Savings allowance
    const savingsAllowance = adjustedEarned <= BASIC_RATE_LIMIT ? 1_000
      : adjustedEarned <= HIGHER_RATE_LIMIT ? 500 : 0;

    const taxableIncome = Math.max(0, adjustedEarned - pa);
    const taxableSavings = Math.max(0, Math.min(savings, taxableIncome) - savingsAllowance);

    const bands = calcIncomeTaxBands(taxableIncome, scottish);
    const incomeTax = bands.reduce((s, b) => s + b.tax, 0);

    const employeeNI = calcEmployeeNI(salary);
    const class4NI = calcSelfEmployedNI(selfEmployed);

    const basicBandRemaining = Math.max(0, BASIC_RATE_LIMIT - Math.min(adjustedEarned, BASIC_RATE_LIMIT));
    const dividendTax = calcDividendTax(dividends, basicBandRemaining);
    const cgt = calcCGT(capitalGains, residentialGains, adjustedEarned);
    const sl = calcStudentLoan(adjustedEarned, studentLoan);

    const gross = adjustedEarned + dividends + capitalGains + residentialGains;

    const bandLines: TaxLine[] = bands
      .filter(b => b.taxable > 0)
      .map(b => ({
        label: b.label,
        sublabel: `${fmt(b.taxable)} taxable`,
        rate: b.rate === 0 ? '0%' : `${(b.rate * 100).toFixed(0)}%`,
        amount: Math.round(b.tax),
      }));

    const topLines: TaxLine[] = [
      { label: 'Income Tax (total)', rate: '', amount: Math.round(incomeTax) },
      ...(salary > 0 ? [{ label: 'Employee NI (Class 1)', rate: '8% / 2%', amount: Math.round(employeeNI) }] : []),
      ...(selfEmployed > 0 ? [{ label: 'Class 4 NI (Self-employed)', rate: '6% / 2%', amount: Math.round(class4NI) }] : []),
      ...(pensionRelief > 0 ? [{ label: 'Pension Contribution', rate: '', amount: pensionRelief, sublabel: 'Gross pension contribution (reduces taxable income)' }] : []),
      ...(dividends > 0 ? [{ label: 'Dividend Tax', rate: '8.75% / 33.75%', amount: Math.round(dividendTax), sublabel: `${fmt(DIVIDEND_ALLOWANCE)} allowance` }] : []),
      ...((capitalGains > 0 || residentialGains > 0) ? [{ label: 'Capital Gains Tax', rate: '18% / 24%', amount: Math.round(cgt), sublabel: `${fmt(CGT_ANNUAL_EXEMPT)} annual exempt amount` }] : []),
      ...(savings > 0 ? [{ label: 'Savings Interest', rate: '', amount: 0, sublabel: `${fmt(savingsAllowance)} PSA — included in income tax bands above`, dimmed: true }] : []),
      ...(studentLoan !== 'none' ? [{ label: 'Student Loan Repayment', rate: STUDENT_LOAN_PLANS[studentLoan]?.rate === 0.06 ? '6%' : '9%', amount: Math.round(sl) }] : []),
    ];

    return { bandLines, topLines, gross };
  }, [salary, selfEmployed, rental, savings, dividends, capitalGains, residentialGains, pension, studentLoan, scottish]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Card>
        <CardHeader title="All Income Sources" subtitle="2025/26 tax year" icon={<Receipt className="h-4 w-4" />} />
        <div className="space-y-4">
          <InputField label="Employment Income (salary)" value={salary} onChange={setSalary} />
          <InputField label="Self-employment Profit" value={selfEmployed} onChange={setSelfEmployed} sublabel="Net profit after expenses" />
          <InputField label="Rental Income (net)" value={rental} onChange={setRental} sublabel="After allowable expenses" />
          <InputField label="Savings Interest" value={savings} onChange={setSavings} sublabel="Bank/building society interest" />
          <InputField label="Dividend Income" value={dividends} onChange={setDividends} />
          <InputField label="Capital Gains (other assets)" value={capitalGains} onChange={setCapitalGains} />
          <InputField label="Capital Gains (residential property)" value={residentialGains} onChange={setResidentialGains} />
          <InputField label="Pension Contribution (£)" value={pension} onChange={setPension} sublabel="Gross contribution reduces taxable income" />
          <SelectField
            label="Student Loan"
            value={studentLoan}
            onChange={setStudentLoan}
            options={Object.entries(STUDENT_LOAN_PLANS).map(([k, v]) => ({ value: k, label: v.label }))}
          />
        </div>
      </Card>
      <Card>
        <CardHeader title="Tax Breakdown" subtitle="Estimated liability" icon={<Receipt className="h-4 w-4" />} />
        <ResultsPanel lines={[...results.bandLines, ...results.topLines]} grossIncome={results.gross} />
      </Card>
    </div>
  );
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

type Tab = 'employed' | 'self-employed' | 'limited-company' | 'all-income';

const TABS: { id: Tab; label: string }[] = [
  { id: 'employed', label: 'Employed' },
  { id: 'self-employed', label: 'Self-employed' },
  { id: 'limited-company', label: 'Limited Company' },
  { id: 'all-income', label: 'All Income Sources' },
];

export default function TaxCalculatorPage() {
  const [tab, setTab] = useState<Tab>('employed');
  const [scottish, setScottish] = useState(false);

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-6 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Receipt className="h-6 w-6 text-emerald-400" />
            UK Tax Calculator
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            2025/26 HMRC rates · Income Tax · NI · CGT · Dividend Tax · Student Loan
          </p>
        </div>
        <Toggle label="Scottish taxpayer" checked={scottish} onChange={setScottish} />
      </div>

      {/* Disclaimer */}
      <div className="mb-6 flex items-start gap-2 bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3">
        <Info className="h-4 w-4 text-amber-400 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-amber-200/80 leading-relaxed">
          <strong className="text-amber-300">Educational tool only.</strong> Calculations are estimates based on 2025/26 HMRC rates and do not constitute financial or tax advice. They do not account for all allowances, reliefs, or individual circumstances. Always consult a qualified tax adviser or use HMRC's official tools before making financial decisions or filing your Self Assessment.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 mb-6 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={clsx(
              'flex-1 min-w-max px-4 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap',
              tab === t.id
                ? 'bg-emerald-600 text-white shadow'
                : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'employed' && <EmployedTab scottish={scottish} />}
      {tab === 'self-employed' && <SelfEmployedTab scottish={scottish} />}
      {tab === 'limited-company' && <LimitedCompanyTab scottish={scottish} />}
      {tab === 'all-income' && <AllIncomeTab scottish={scottish} />}

      {/* Rate reference */}
      <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <Card>
          <CardHeader title="Income Tax Bands" subtitle="England / Wales / NI 2025/26" />
          <div className="space-y-1 text-xs">
            {[
              { band: 'Personal Allowance', range: 'Up to £12,570', rate: '0%' },
              { band: 'Basic Rate', range: '£12,571 – £50,270', rate: '20%' },
              { band: 'Higher Rate', range: '£50,271 – £125,140', rate: '40%' },
              { band: 'Additional Rate', range: 'Over £125,140', rate: '45%' },
              { band: 'PA Taper', range: 'Over £100,000', rate: '−£1 per £2' },
            ].map(r => (
              <div key={r.band} className="flex justify-between text-gray-400">
                <span>{r.band} <span className="text-gray-600">{r.range}</span></span>
                <span className="font-mono text-white">{r.rate}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <CardHeader title="Scottish Income Tax" subtitle="2025/26" />
          <div className="space-y-1 text-xs">
            {[
              { band: 'Starter', range: '£12,571–£14,876', rate: '19%' },
              { band: 'Basic', range: '£14,877–£26,561', rate: '20%' },
              { band: 'Intermediate', range: '£26,562–£43,662', rate: '21%' },
              { band: 'Higher', range: '£43,663–£75,000', rate: '42%' },
              { band: 'Advanced', range: '£75,001–£125,140', rate: '45%' },
              { band: 'Top', range: 'Over £125,140', rate: '48%' },
            ].map(r => (
              <div key={r.band} className="flex justify-between text-gray-400">
                <span>{r.band} <span className="text-gray-600">{r.range}</span></span>
                <span className="font-mono text-white">{r.rate}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <CardHeader title="Other Rates" subtitle="NI · CGT · Dividends 2025/26" />
          <div className="space-y-1 text-xs text-gray-400">
            <p className="font-semibold text-gray-300 mt-1">National Insurance</p>
            <div className="flex justify-between"><span>Employee Class 1 (main)</span><span className="font-mono text-white">8%</span></div>
            <div className="flex justify-between"><span>Employee Class 1 (upper)</span><span className="font-mono text-white">2%</span></div>
            <div className="flex justify-between"><span>Employer Class 1</span><span className="font-mono text-white">15%</span></div>
            <div className="flex justify-between"><span>Class 4 SE (main)</span><span className="font-mono text-white">6%</span></div>
            <p className="font-semibold text-gray-300 mt-2">CGT (post Oct 2024 Budget)</p>
            <div className="flex justify-between"><span>Basic / Higher rate</span><span className="font-mono text-white">18% / 24%</span></div>
            <div className="flex justify-between"><span>Annual exempt amount</span><span className="font-mono text-white">£3,000</span></div>
            <p className="font-semibold text-gray-300 mt-2">Dividend Tax</p>
            <div className="flex justify-between"><span>Allowance</span><span className="font-mono text-white">£500</span></div>
            <div className="flex justify-between"><span>Basic / Higher / Additional</span><span className="font-mono text-white">8.75% / 33.75% / 39.35%</span></div>
          </div>
        </Card>
      </div>
    </div>
  );
}

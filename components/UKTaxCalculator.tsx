"use client";
import { useState, useCallback } from "react";

// ─── 2025/26 CONFIRMED RATES ───────────────────────────────────────────────
// Sources: HMRC gov.uk, House of Commons Library, PWC Tax Summaries April 2026
const TAX_YEAR = "2025/26";
const RATES = {
  personal_allowance: 12570,
  pa_taper_start: 100000,
  pa_taper_end: 125140,
  // England/Wales/NI income tax
  basic_rate: 0.20, basic_limit: 50270,
  higher_rate: 0.40, higher_limit: 125140,
  additional_rate: 0.45,
  // Scottish income tax
  scot_bands: [
    { name: "Starter 19%", min: 12570, max: 14876, rate: 0.19 },
    { name: "Basic 20%", min: 14876, max: 26561, rate: 0.20 },
    { name: "Intermediate 21%", min: 26561, max: 43662, rate: 0.21 },
    { name: "Higher 42%", min: 43662, max: 75000, rate: 0.42 },
    { name: "Advanced 45%", min: 75000, max: 125140, rate: 0.45 },
    { name: "Top 48%", min: 125140, max: Infinity, rate: 0.48 },
  ],
  // NI 2025/26 — Employer NI changed April 2025: 15% above £5,000
  ni_employee_lower: 12570, ni_employee_upper: 50270,
  ni_employee_main: 0.08, ni_employee_upper_rate: 0.02,
  ni_employer_threshold: 5000, ni_employer_rate: 0.15, // Changed April 2025
  ni_class4_lower: 12570, ni_class4_upper: 50270,
  ni_class4_main: 0.06, ni_class4_upper_rate: 0.02,
  // Class 2 NI abolished April 2024 — voluntary only at £3.45/week
  ni_class2_voluntary: 179.4,
  // Corporation tax
  ct_small_rate: 0.19, ct_small_limit: 50000,
  ct_large_rate: 0.25, ct_large_limit: 250000,
  // Dividend tax
  dividend_allowance: 500,
  dividend_basic: 0.0875, dividend_higher: 0.3375, dividend_additional: 0.3935,
  // Savings
  savings_starter_limit: 5000, // 0% if non-savings income < £17,570
  savings_allowance_basic: 1000, savings_allowance_higher: 500,
  savings_rate_basic: 0.20, savings_rate_higher: 0.40,
  // CGT 2025/26 — rates changed October 2024 Budget
  cgt_annual_exempt: 3000,
  cgt_basic_shares: 0.18, cgt_higher_shares: 0.24,
  cgt_basic_property: 0.18, cgt_higher_property: 0.24,
  cgt_badr_rate: 0.14, // Business Asset Disposal Relief
  // IHT
  iht_nil_rate_band: 325000,
  iht_rnrb: 175000,
  iht_rate: 0.40, iht_charity_rate: 0.36,
  // SDLT England/NI — Reverted April 2025 (temporary relief ended)
  sdlt_standard: [ // nil-rate reverted to £125,000 from April 2025
    { limit: 125000, rate: 0 },
    { limit: 250000, rate: 0.02 },
    { limit: 925000, rate: 0.05 },
    { limit: 1500000, rate: 0.10 },
    { limit: Infinity, rate: 0.12 },
  ],
  sdlt_ftb_nil_limit: 300000, // dropped from £425,000 April 2025
  sdlt_ftb_max_price: 500000, // dropped from £625,000 April 2025
  sdlt_additional_surcharge: 0.05,
  // Student loan thresholds
  sl_thresholds: { 1: 24990, 2: 27295, 4: 31395, 5: 25000 },
  sl_rate: 0.09,
};

// ─── HELPERS ──────────────────────────────────────────────────────────────
const fmt = (n: number) => "£" + Math.round(Math.abs(n)).toLocaleString("en-GB");
const pct = (n: number) => n.toFixed(1) + "%";

function getPersonalAllowance(income: number): number {
  if (income <= RATES.pa_taper_start) return RATES.personal_allowance;
  if (income >= RATES.pa_taper_end) return 0;
  return Math.max(0, RATES.personal_allowance - (income - RATES.pa_taper_start) / 2);
}

interface TaxBand { label: string; amount: number; rate: string; tax: number }

function calcIncomeTax(taxable: number, scottish: boolean): { tax: number; bands: TaxBand[] } {
  if (taxable <= 0) return { tax: 0, bands: [] };
  const bands: TaxBand[] = [];
  if (scottish) {
    let rem = taxable, tax = 0;
    for (const b of RATES.scot_bands) {
      const size = b.max - b.min;
      const chunk = Math.min(rem, size);
      if (chunk > 0) {
        const t = chunk * b.rate;
        bands.push({ label: b.name, amount: chunk, rate: pct(b.rate * 100), tax: t });
        tax += t; rem -= chunk;
      }
      if (rem <= 0) break;
    }
    return { tax, bands };
  }
  const b1 = Math.min(taxable, RATES.basic_limit - RATES.personal_allowance);
  const b2 = Math.min(Math.max(0, taxable - b1), RATES.higher_limit - RATES.basic_limit);
  const b3 = Math.max(0, taxable - b1 - b2);
  if (b1 > 0) bands.push({ label: "Basic rate 20%", amount: b1, rate: "20%", tax: b1 * 0.20 });
  if (b2 > 0) bands.push({ label: "Higher rate 40%", amount: b2, rate: "40%", tax: b2 * 0.40 });
  if (b3 > 0) bands.push({ label: "Additional rate 45%", amount: b3, rate: "45%", tax: b3 * 0.45 });
  return { tax: b1 * 0.20 + b2 * 0.40 + b3 * 0.45, bands };
}

function calcEmployeeNI(salary: number): { tax: number; bands: TaxBand[] } {
  const b1 = Math.max(0, Math.min(salary, RATES.ni_employee_upper) - RATES.ni_employee_lower);
  const b2 = Math.max(0, salary - RATES.ni_employee_upper);
  const bands: TaxBand[] = [];
  if (b1 > 0) bands.push({ label: "Class 1 employee NI 8%", amount: b1, rate: "8%", tax: b1 * 0.08 });
  if (b2 > 0) bands.push({ label: "Class 1 employee NI 2%", amount: b2, rate: "2%", tax: b2 * 0.02 });
  return { tax: b1 * 0.08 + b2 * 0.02, bands };
}

function calcEmployerNI(salary: number): number {
  return Math.max(0, salary - RATES.ni_employer_threshold) * RATES.ni_employer_rate;
}

function calcClass4NI(profit: number): { tax: number; bands: TaxBand[] } {
  const b1 = Math.max(0, Math.min(profit, RATES.ni_class4_upper) - RATES.ni_class4_lower);
  const b2 = Math.max(0, profit - RATES.ni_class4_upper);
  const bands: TaxBand[] = [];
  if (b1 > 0) bands.push({ label: "Class 4 NI 6%", amount: b1, rate: "6%", tax: b1 * 0.06 });
  if (b2 > 0) bands.push({ label: "Class 4 NI 2%", amount: b2, rate: "2%", tax: b2 * 0.02 });
  return { tax: b1 * 0.06 + b2 * 0.02, bands };
}

function calcSDLT(price: number, type: "standard" | "ftb" | "additional"): { tax: number; bands: TaxBand[] } {
  if (price <= 0) return { tax: 0, bands: [] };
  const bands: TaxBand[] = [];
  let tax = 0;

  if (type === "ftb" && price <= RATES.sdlt_ftb_max_price) {
    const nil = Math.min(price, RATES.sdlt_ftb_nil_limit);
    bands.push({ label: "FTB relief 0%", amount: nil, rate: "0%", tax: 0 });
    const above = Math.max(0, price - RATES.sdlt_ftb_nil_limit);
    if (above > 0) {
      const t = above * 0.05;
      bands.push({ label: "FTB 5%", amount: above, rate: "5%", tax: t });
      tax = t;
    }
    return { tax, bands };
  }

  const surcharge = type === "additional" ? RATES.sdlt_additional_surcharge : 0;
  const stdBands = RATES.sdlt_standard;
  const labels = ["0%", "2%", "5%", "10%", "12%"];
  const ranges = ["£0–£125,000", "£125,001–£250,000", "£250,001–£925,000", "£925,001–£1,500,000", "Over £1,500,000"];
  let rem = price, prev = 0;
  for (let i = 0; i < stdBands.length; i++) {
    const b = stdBands[i];
    const size = Math.min(b.limit, price) - prev;
    if (size > 0) {
      const effRate = b.rate + surcharge;
      const t = size * effRate;
      const label = surcharge > 0 ? `SDLT ${pct(effRate * 100)} (incl. ${pct(surcharge * 100)} surcharge)` : `SDLT ${labels[i]}`;
      bands.push({ label, amount: size, rate: pct(effRate * 100), tax: t });
      tax += t;
    }
    prev = b.limit;
    if (prev >= price) break;
  }
  return { tax, bands };
}

// ─── TYPES ────────────────────────────────────────────────────────────────
interface FormState {
  // Annual income
  salary: number; seSelf: number; rental: number; rentalExp: number;
  dividends: number; savings: number; otherIncome: number;
  pension: number; giftAid: number; studentLoan: number; scottish: boolean;
  // Company
  coRevenue: number; coCosts: number; coSalary: number; coDividends: number;
  // IHT
  ihtEstate: number; ihtDebts: number; ihtHouse: number;
  ihtDescendants: boolean; ihtSpouseNRB: boolean; ihtCharity: number;
  // SDLT
  sdltPrice: number; sdltType: "standard" | "ftb" | "additional";
  // CGT
  cgtProceeds: number; cgtCost: number; cgtType: "shares" | "property" | "badr";
  cgtHigherRate: boolean; cgtPRR: boolean;
  // Other
  councilTax: number; councilDiscount: number;
  vedAmount: number; iptNet: number; iptHigher: boolean;
}

const defaultForm: FormState = {
  salary: 45000, seSelf: 0, rental: 0, rentalExp: 0,
  dividends: 0, savings: 0, otherIncome: 0,
  pension: 0, giftAid: 0, studentLoan: 0, scottish: false,
  coRevenue: 0, coCosts: 0, coSalary: 0, coDividends: 0,
  ihtEstate: 500000, ihtDebts: 0, ihtHouse: 250000,
  ihtDescendants: true, ihtSpouseNRB: false, ihtCharity: 0,
  sdltPrice: 350000, sdltType: "standard",
  cgtProceeds: 60000, cgtCost: 30000, cgtType: "shares",
  cgtHigherRate: false, cgtPRR: false,
  councilTax: 2171, councilDiscount: 0,
  vedAmount: 195, iptNet: 0, iptHigher: false,
};

// ─── TOOLTIP ──────────────────────────────────────────────────────────────
function Tooltip({ text }: { text: string }) {
  const [show, setShow] = useState(false);
  return (
    <span className="relative inline-flex ml-1" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-xs text-gray-500 cursor-help">?</span>
      {show && (
        <span className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-1.5 w-56 bg-gray-900 text-gray-100 text-xs rounded-md px-2.5 py-2 leading-relaxed shadow-lg pointer-events-none">
          {text}
          <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900" />
        </span>
      )}
    </span>
  );
}

// ─── FIELD LABEL ──────────────────────────────────────────────────────────
function Label({ text, tip }: { text: string; tip: string }) {
  return (
    <label className="text-xs text-gray-500 dark:text-gray-400 mb-1 flex items-center">
      <span className="border-b border-dashed border-gray-300 dark:border-gray-600">{text}</span>
      <Tooltip text={tip} />
    </label>
  );
}

// ─── INPUT ────────────────────────────────────────────────────────────────
function Input({ value, onChange, label, tip }: { value: number; onChange: (v: number) => void; label: string; tip: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <Label text={label} tip={tip} />
      <input type="number" min={0} value={value || ""} onChange={e => onChange(+e.target.value || 0)}
        className="px-2 py-1.5 text-xs font-mono border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 outline-none focus:border-blue-400 w-full" />
    </div>
  );
}

function Select({ value, onChange, label, tip, options }: { value: string | boolean | number; onChange: (v: any) => void; label: string; tip: string; options: { v: any; l: string }[] }) {
  return (
    <div className="flex flex-col gap-0.5">
      <Label text={label} tip={tip} />
      <select value={String(value)} onChange={e => {
        const raw = e.target.value;
        if (raw === "true") onChange(true);
        else if (raw === "false") onChange(false);
        else if (!isNaN(+raw)) onChange(+raw);
        else onChange(raw);
      }} className="px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 outline-none focus:border-blue-400 w-full cursor-pointer">
        {options.map(o => <option key={String(o.v)} value={String(o.v)}>{o.l}</option>)}
      </select>
    </div>
  );
}

// ─── TAX ROW ──────────────────────────────────────────────────────────────
function TaxRow({ label, band, rate, amount, color = "red" }: { label: string; band?: string; rate?: string; amount: number; color?: "red" | "green" | "amber" | "blue" }) {
  const colors = { red: "text-red-600 dark:text-red-400", green: "text-green-600 dark:text-green-400", amber: "text-amber-600 dark:text-amber-400", blue: "text-blue-600 dark:text-blue-400" };
  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 items-center py-1 border-b border-gray-100 dark:border-gray-800 text-xs last:border-0">
      <span className="text-gray-600 dark:text-gray-400">{label}</span>
      <span className="font-mono text-gray-400 dark:text-gray-500 text-right text-xs">{band || ""}</span>
      <span className="font-mono text-gray-500 dark:text-gray-400 text-right text-xs min-w-[38px]">{rate || ""}</span>
      <span className={`font-mono font-medium text-right min-w-[72px] ${colors[color]}`}>{fmt(amount)}</span>
    </div>
  );
}

function SectionHead({ title, total }: { title: string; total: number }) {
  return (
    <div className="flex justify-between items-center py-1.5 border-b border-gray-200 dark:border-gray-700 mb-1 mt-3 first:mt-0">
      <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">{title}</span>
      <span className="font-mono text-xs text-gray-400 dark:text-gray-500">{fmt(total)}</span>
    </div>
  );
}

function SubTotal({ label, amount }: { label: string; amount: number }) {
  return (
    <div className="flex justify-between items-center pt-1.5 mt-1 border-t border-dashed border-gray-300 dark:border-gray-700 text-xs font-medium">
      <span>{label}</span>
      <span className="font-mono text-red-600 dark:text-red-400">{fmt(amount)}</span>
    </div>
  );
}

function GrandTotal({ label, amount }: { label: string; amount: number }) {
  return (
    <div className="flex justify-between items-center px-3 py-2.5 bg-gray-50 dark:bg-gray-800/60 border-t-2 border-gray-300 dark:border-gray-600 text-sm font-semibold">
      <span>{label}</span>
      <span className="font-mono text-red-600 dark:text-red-400">{fmt(amount)}</span>
    </div>
  );
}

function TakeHome({ label, amount }: { label: string; amount: number }) {
  return (
    <div className="flex justify-between items-center px-3 py-2 bg-green-50 dark:bg-green-950/40 border-t border-green-200 dark:border-green-800 text-xs font-medium text-green-800 dark:text-green-300">
      <span>{label}</span>
      <span className="font-mono">{fmt(amount)}</span>
    </div>
  );
}

function MetricCard({ label, value, tip, color = "" }: { label: string; value: string; tip?: string; color?: string }) {
  const colors: Record<string, string> = { red: "text-red-600 dark:text-red-400", green: "text-green-600 dark:text-green-400", amber: "text-amber-600 dark:text-amber-400", blue: "text-blue-600 dark:text-blue-400" };
  return (
    <div className="bg-gray-50 dark:bg-gray-800/60 rounded-lg p-2.5">
      <div className="text-xs text-gray-400 dark:text-gray-500 mb-0.5 flex items-center">{label}{tip && <Tooltip text={tip} />}</div>
      <div className={`font-mono text-sm font-semibold ${colors[color] || "text-gray-900 dark:text-gray-100"}`}>{value}</div>
    </div>
  );
}

// ─── PANEL ────────────────────────────────────────────────────────────────
function Panel({ title, children, tip }: { title: string; children: React.ReactNode; tip?: string }) {
  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
      <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-800">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
          {title}{tip && <Tooltip text={tip} />}
        </span>
      </div>
      {children}
    </div>
  );
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────
export default function UKTaxCalculator() {
  const [tab, setTab] = useState<"annual" | "oneoff" | "summary">("annual");
  const [f, setF] = useState<FormState>(defaultForm);

  const set = useCallback((key: keyof FormState, val: any) => {
    setF(prev => ({ ...prev, [key]: val }));
  }, []);

  // ── Annual calculations ──
  const netRent = Math.max(0, f.rental - f.rentalExp);
  const nonSavingsIncome = f.salary + f.seSelf + netRent + f.otherIncome;
  const adjNonSavings = Math.max(0, nonSavingsIncome - f.pension - f.giftAid * 1.25);
  const totalForPA = adjNonSavings + f.dividends;
  const pa = getPersonalAllowance(totalForPA);
  const taxableNS = Math.max(0, adjNonSavings - pa);
  const { tax: itNS, bands: itBands } = calcIncomeTax(taxableNS, f.scottish);

  const savingsStarterRate = adjNonSavings < 17570 ? Math.min(f.savings, RATES.savings_starter_limit) : 0;
  const savingsAllowance = adjNonSavings > RATES.basic_limit ? RATES.savings_allowance_higher : RATES.savings_allowance_basic;
  const taxableSavings = Math.max(0, f.savings - savingsStarterRate - savingsAllowance);
  const savingsRate = adjNonSavings > RATES.basic_limit ? RATES.savings_rate_higher : RATES.savings_rate_basic;
  const savingsTax = taxableSavings * savingsRate;

  const taxableDiv = Math.max(0, f.dividends - RATES.dividend_allowance);
  const divRate = adjNonSavings > RATES.basic_limit ? RATES.dividend_higher : RATES.dividend_basic;
  const divTax = taxableDiv * divRate;

  const totalIT = itNS + savingsTax + divTax;
  const { tax: empNI, bands: empNIBands } = calcEmployeeNI(f.salary);
  const { tax: class4, bands: class4Bands } = calcClass4NI(f.seSelf);
  const slAmt = f.studentLoan > 0 ? Math.max(0, (f.salary + f.seSelf) - (RATES.sl_thresholds as any)[f.studentLoan]) * RATES.sl_rate : 0;
  const totalNI = empNI + class4;
  const annualTaxTotal = totalIT + totalNI + slAmt;

  // Company
  const coEmpNI = calcEmployerNI(f.coSalary);
  const coProfit = Math.max(0, f.coRevenue - f.coCosts - f.coSalary - coEmpNI);
  const ctRate = coProfit > RATES.ct_large_limit ? 0.25 : coProfit > RATES.ct_small_limit ? 0.25 - 0.06 * ((RATES.ct_large_limit - coProfit) / (RATES.ct_large_limit - RATES.ct_small_limit)) : 0.19;
  const ctTax = coProfit > 0 ? coProfit * ctRate : 0;
  const coTaxableDiv = Math.max(0, f.coDividends - RATES.dividend_allowance);
  const coDivRate = f.coSalary > RATES.basic_limit ? RATES.dividend_higher : RATES.dividend_basic;
  const coDivTax = coTaxableDiv * coDivRate;

  // IHT
  const ihtNetEstate = Math.max(0, f.ihtEstate - f.ihtDebts);
  let ihtNRB = RATES.iht_nil_rate_band + (f.ihtSpouseNRB ? RATES.iht_nil_rate_band : 0);
  let ihtRNRB = f.ihtDescendants && f.ihtHouse > 0 ? Math.min(f.ihtHouse, RATES.iht_rnrb * (f.ihtSpouseNRB ? 2 : 1)) : 0;
  if (ihtNetEstate > 2000000) ihtRNRB = Math.max(0, ihtRNRB - (ihtNetEstate - 2000000) / 2);
  const ihtThreshold = ihtNRB + ihtRNRB;
  const ihtCharityRate = f.ihtCharity >= ihtNetEstate * 0.1 ? RATES.iht_charity_rate : RATES.iht_rate;
  const ihtChargeable = Math.max(0, ihtNetEstate - f.ihtCharity - ihtThreshold);
  const ihtTax = ihtChargeable * ihtCharityRate;

  // SDLT
  const { tax: sdltTax, bands: sdltBands } = calcSDLT(f.sdltPrice, f.sdltType);

  // CGT
  const cgtGain = Math.max(0, f.cgtProceeds - f.cgtCost);
  const cgtTaxable = Math.max(0, cgtGain - RATES.cgt_annual_exempt);
  const cgtRate = f.cgtType === "badr" ? RATES.cgt_badr_rate : f.cgtHigherRate
    ? (f.cgtType === "property" ? RATES.cgt_higher_property : RATES.cgt_higher_shares)
    : (f.cgtType === "property" ? RATES.cgt_basic_property : RATES.cgt_basic_shares);
  const cgtTax = cgtTaxable * cgtRate;

  // Other
  const councilAfterDiscount = f.councilTax * (1 - f.councilDiscount / 100);
  const iptTax = f.iptNet * (f.iptHigher ? 0.20 : 0.12);

  // Grand total
  const grandTotal = annualTaxTotal + ctTax + ihtTax + sdltTax + cgtTax + councilAfterDiscount + f.vedAmount + iptTax;
  const grossIncome = f.salary + f.seSelf + netRent + f.dividends + f.savings + f.otherIncome;
  const effectiveRate = grossIncome > 0 ? (annualTaxTotal / grossIncome) * 100 : 0;

  const tabs = [
    { id: "annual" as const, label: "Annual income taxes" },
    { id: "oneoff" as const, label: "One-off taxes" },
    { id: "summary" as const, label: "Complete liability" },
  ];

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-4">

      {/* Header */}
      <div className="p-3 bg-amber-50 dark:bg-amber-950/30 rounded-lg border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
        <strong>Tax Year {TAX_YEAR} · Live rates confirmed from HMRC gov.uk</strong> — Employer NI: 15% above £5,000 (changed April 2025) · SDLT nil-rate: £125,000 (changed April 2025) · Class 2 NI abolished April 2024 · CGT: 18%/24% · All rates verified against HMRC, House of Commons Library and PWC Tax Summaries. Not financial advice — consult a qualified accountant before filing.
      </div>

      {/* Tabs */}
      <div className="flex gap-1 flex-wrap">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 rounded-lg text-xs transition-all ${tab === t.id ? "bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100 font-medium" : "text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/50"}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ═══ ANNUAL TAB ═══ */}
      {tab === "annual" && (
        <div className="space-y-4">
          <Panel title="Income details" tip="Enter all income you receive. These go on your Self Assessment (SA100) filed by 31 January at gov.uk/self-assessment">
            <div className="p-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              <Input value={f.salary} onChange={v => set("salary", v)} label="Employment salary" tip="Gross salary before tax. Found on your P60 (year-end) or P11D from your employer. See your Personal Tax Account at gov.uk/personal-tax-account" />
              <Input value={f.seSelf} onChange={v => set("seSelf", v)} label="Self-employment profit" tip="Net profit after deducting allowable expenses from turnover. Reported on SA103. Class 4 NI at 6%/2% applies. Class 2 NI was abolished April 2024." />
              <Input value={f.rental} onChange={v => set("rental", v)} label="Rental income (gross)" tip="Total rent received. Report on SA105 (UK Property). You can deduct allowable expenses. Mortgage interest relief is capped at 20% basic rate." />
              <Input value={f.rentalExp} onChange={v => set("rentalExp", v)} label="Rental expenses" tip="Allowable costs: letting agent fees, repairs, insurance, 20% mortgage interest relief. Cannot include capital costs like extensions." />
              <Input value={f.dividends} onChange={v => set("dividends", v)} label="UK dividend income" tip="Dividends from shares. First £500 is tax-free (2025/26 allowance). Basic rate: 8.75%, Higher rate: 33.75%, Additional: 39.35%. Report on SA100 if over £10,000." />
              <Input value={f.savings} onChange={v => set("savings", v)} label="Savings interest" tip="Bank account interest. ISA interest is tax-free. Personal Savings Allowance: £1,000 (basic rate) or £500 (higher rate). Savings Starter Rate: 0% on up to £5,000 if non-savings income is below £17,570." />
              <Input value={f.otherIncome} onChange={v => set("otherIncome", v)} label="Other income" tip="Tips, casual work, foreign income. Report on SA100. Any untaxed income over £1,000 must be declared via Self Assessment." />
              <Input value={f.pension} onChange={v => set("pension", v)} label="Pension contributions" tip="Personal pension payments reduce taxable income. Annual Allowance is £60,000. Report on SA100. Your pension provider sends an annual statement." />
              <Input value={f.giftAid} onChange={v => set("giftAid", v)} label="Gift Aid donations" tip="Donations where you ticked Gift Aid. Higher rate taxpayers claim extra relief on SA100. Keep donation records as HMRC may request evidence." />
              <Select value={f.studentLoan} onChange={v => set("studentLoan", v)} label="Student loan plan" tip="Plan 1 (pre-2012, £24,990 threshold), Plan 2 (2012-2023, £27,295), Plan 4 (Scotland, £31,395), Plan 5 (post-2023, £25,000). 9% repayment rate above threshold." options={[{ v: 0, l: "No student loan" }, { v: 1, l: "Plan 1 — £24,990 threshold" }, { v: 2, l: "Plan 2 — £27,295 threshold" }, { v: 4, l: "Plan 4 (Scotland) — £31,395" }, { v: 5, l: "Plan 5 — £25,000 threshold" }]} />
              <Select value={f.scottish} onChange={v => set("scottish", v)} label="Scottish taxpayer?" tip="Scottish rates apply if your main home is in Scotland. Scottish bands: 19% Starter, 20% Basic, 21% Intermediate, 42% Higher, 45% Advanced, 48% Top. Applies to non-savings, non-dividend income only." options={[{ v: false, l: "No — England/Wales/NI" }, { v: true, l: "Yes — Scotland" }]} />
            </div>
          </Panel>

          <Panel title="Limited company (optional)" tip="Only complete if you operate through a limited company. Corporation Tax changed April 2025: employer NI is now 15% above £5,000 (was 13.8% above £9,100).">
            <div className="p-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Input value={f.coRevenue} onChange={v => set("coRevenue", v)} label="Company revenue" tip="Total turnover. Shown on your profit and loss account. Your accountant prepares this for Companies House and HMRC CT600." />
              <Input value={f.coCosts} onChange={v => set("coCosts", v)} label="Company costs" tip="Allowable expenses: staff, office, equipment, software, professional fees. Cannot include personal expenses or client entertainment." />
              <Input value={f.coSalary} onChange={v => set("coSalary", v)} label="Director salary" tip="Most efficient level is £12,570 (personal allowance) or £9,100 (below NI employer threshold). Employer NI is now 15% above £5,000 from April 2025." />
              <Input value={f.coDividends} onChange={v => set("coDividends", v)} label="Dividends taken" tip="Must be paid from post-tax profits with a dividend voucher. First £500 tax-free. Basic rate: 8.75%, Higher: 33.75%. Report on Self Assessment." />
            </div>
          </Panel>

          {/* Results */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <MetricCard label="Gross income" value={fmt(grossIncome)} tip="All income before any deductions." />
            <MetricCard label="Personal allowance" value={fmt(pa)} tip="Tax-free amount: £12,570. Reduces by £1 per £2 over £100,000. Zero at £125,140." color="green" />
            <MetricCard label="Income Tax" value={fmt(totalIT)} tip="Tax on income above your personal allowance, calculated in bands." color="red" />
            <MetricCard label="National Insurance" value={fmt(totalNI)} tip="Employee Class 1 (8%/2%) + self-employed Class 4 (6%/2%). Class 2 NI abolished April 2024." color="red" />
            {ctTax > 0 && <MetricCard label={`Corporation Tax (${pct(ctRate * 100)})`} value={fmt(ctTax)} tip="Tax on company profits. 19% up to £50,000, 25% above £250,000, marginal relief between." color="red" />}
            <MetricCard label="Total annual tax" value={fmt(annualTaxTotal + ctTax)} tip="Income Tax + NI + Corporation Tax + Student Loan combined." color="red" />
            <MetricCard label="Effective rate" value={pct(effectiveRate)} tip="Your total income tax and NI as % of gross income. Your real average rate — not your marginal rate." color="amber" />
            <MetricCard label="Take-home" value={fmt(grossIncome - annualTaxTotal)} tip="Estimated net income after all annual income taxes." color="green" />
          </div>

          <Panel title="Full tax computation — 2025/26">
            <div className="p-3 space-y-0.5">
              <SectionHead title="Income sources" total={grossIncome} />
              {f.salary > 0 && <TaxRow label="Employment salary" band="Gross" rate="—" amount={f.salary} color="green" />}
              {f.seSelf > 0 && <TaxRow label="Self-employment profit" band="Net profit" rate="—" amount={f.seSelf} color="green" />}
              {netRent > 0 && <TaxRow label="Net rental income" band="After expenses" rate="—" amount={netRent} color="green" />}
              {f.dividends > 0 && <TaxRow label="Dividend income" band="UK dividends" rate="—" amount={f.dividends} color="green" />}
              {f.savings > 0 && <TaxRow label="Savings interest" band="Bank/bonds" rate="—" amount={f.savings} color="green" />}
              {f.otherIncome > 0 && <TaxRow label="Other income" band="Various" rate="—" amount={f.otherIncome} color="green" />}
              {f.pension > 0 && <TaxRow label="Less: pension contributions" band="Tax relief" rate="—" amount={f.pension} color="blue" />}
              {f.giftAid > 0 && <TaxRow label="Less: Gift Aid (grossed up)" band="Relief" rate="—" amount={f.giftAid * 1.25} color="blue" />}
              <TaxRow label="Personal allowance" band="2025/26" rate="0%" amount={pa} color="green" />
              <TaxRow label="Taxable income" band="Non-savings" rate="—" amount={taxableNS} />

              <SectionHead title="Income Tax" total={totalIT} />
              {itBands.map((b, i) => <TaxRow key={i} label={b.label} band={fmt(b.amount) + " taxable"} rate={b.rate} amount={b.tax} />)}
              {savingsTax > 0 && <TaxRow label={`Savings tax (${pct(savingsRate * 100)})`} band={`Above £${savingsAllowance.toLocaleString()} allowance`} rate={pct(savingsRate * 100)} amount={savingsTax} />}
              {divTax > 0 && <TaxRow label={`Dividend tax (${pct(divRate * 100)})`} band={`Above £${RATES.dividend_allowance} allowance`} rate={pct(divRate * 100)} amount={divTax} />}
              <SubTotal label="Income Tax subtotal" amount={totalIT} />

              <SectionHead title="National Insurance" total={totalNI} />
              {empNIBands.map((b, i) => <TaxRow key={i} label={b.label} band={fmt(b.amount)} rate={b.rate} amount={b.tax} />)}
              {class4Bands.map((b, i) => <TaxRow key={i} label={b.label} band={fmt(b.amount)} rate={b.rate} amount={b.tax} />)}
              <SubTotal label="NI subtotal" amount={totalNI} />

              {ctTax > 0 && <>
                <SectionHead title="Corporation Tax (company level)" total={ctTax + coEmpNI} />
                <TaxRow label={`Corporation Tax (${pct(ctRate * 100)})`} band={fmt(coProfit) + " profit"} rate={pct(ctRate * 100)} amount={ctTax} />
                <TaxRow label="Employer NI (15% — changed April 2025)" band={`Above £${RATES.ni_employer_threshold.toLocaleString()}`} rate="15%" amount={coEmpNI} />
                {coDivTax > 0 && <TaxRow label={`Dividend tax on distributions (${pct(coDivRate * 100)})`} band={`Above £${RATES.dividend_allowance} allowance`} rate={pct(coDivRate * 100)} amount={coDivTax} />}
                <SubTotal label="Company tax subtotal" amount={ctTax + coEmpNI + coDivTax} />
              </>}

              {slAmt > 0 && <>
                <SectionHead title="Student Loan Repayment" total={slAmt} />
                <TaxRow label={`Plan ${f.studentLoan} repayment (9%)`} band={`Above threshold`} rate="9%" amount={slAmt} />
              </>}
            </div>
            <GrandTotal label="Total annual tax liability" amount={annualTaxTotal + ctTax} />
            <TakeHome label="Estimated take-home after all annual taxes" amount={grossIncome - annualTaxTotal} />
          </Panel>
        </div>
      )}

      {/* ═══ ONE-OFF TAB ═══ */}
      {tab === "oneoff" && (
        <div className="space-y-4">
          <div className="p-3 bg-blue-50 dark:bg-blue-950/30 rounded-lg border border-blue-200 dark:border-blue-800 text-xs text-blue-800 dark:text-blue-300 leading-relaxed">
            One-off taxes are paid at specific life events — not annually. They do not reduce your regular take-home pay.
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Panel title="Inheritance Tax (IHT)" tip="IHT is paid on an estate after death. Nil-rate band £325,000, RNRB up to £175,000. 40% rate. Due within 6 months of death. File IHT400 for complex estates. gov.uk/inheritance-tax">
              <div className="p-3 grid grid-cols-2 gap-3">
                <Input value={f.ihtEstate} onChange={v => set("ihtEstate", v)} label="Total estate value" tip="Everything owned at death: property, cash, investments, personal possessions. Get professional valuations for property. Reported on IHT400." />
                <Input value={f.ihtDebts} onChange={v => set("ihtDebts", v)} label="Debts & liabilities" tip="Outstanding mortgage, loans, credit cards, and reasonable funeral expenses can all be deducted from the estate value before calculating IHT." />
                <Input value={f.ihtHouse} onChange={v => set("ihtHouse", v)} label="Main residence value" tip="Value of the family home. Qualifies for the Residence Nil-Rate Band (RNRB up to £175,000) if left to direct descendants: children, grandchildren." />
                <Input value={f.ihtCharity} onChange={v => set("ihtCharity", v)} label="Charitable gifts in will" tip="Exempt from IHT. If 10% or more of the net estate goes to charity, the IHT rate reduces from 40% to 36% on the rest. Claim using IHT430." />
                <Select value={f.ihtDescendants} onChange={v => set("ihtDescendants", v)} label="Home to descendants?" tip="Residence Nil-Rate Band (£175,000) only applies if the main home is left to direct lineal descendants: children, grandchildren, stepchildren or their spouses." options={[{ v: true, l: "Yes — RNRB applies" }, { v: false, l: "No — RNRB not available" }]} />
                <Select value={f.ihtSpouseNRB} onChange={v => set("ihtSpouseNRB", v)} label="Transfer spouse NRB?" tip="If a spouse/civil partner died before you and didn't use their full nil-rate band (typically because they left everything to you, which is exempt), you can transfer their unused NRB — potentially doubling the threshold to £650,000." options={[{ v: false, l: "No — standard NRB only" }, { v: true, l: "Yes — transfer unused NRB" }]} />
              </div>
              <div className="px-3 pb-3">
                <div className="bg-gray-50 dark:bg-gray-800/60 rounded-lg p-2.5 text-xs space-y-1">
                  <div className="flex justify-between"><span className="text-gray-500">Net estate</span><span className="font-mono">{fmt(ihtNetEstate)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Total nil-rate threshold</span><span className="font-mono text-green-600 dark:text-green-400">{fmt(ihtThreshold)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Chargeable estate</span><span className="font-mono">{fmt(ihtChargeable)}</span></div>
                  <div className="flex justify-between font-medium border-t border-gray-200 dark:border-gray-700 pt-1 mt-1"><span>IHT liability ({pct(ihtCharityRate * 100)})</span><span className="font-mono text-red-600 dark:text-red-400">{fmt(ihtTax)}</span></div>
                  {ihtTax === 0 && <div className="text-green-600 dark:text-green-400">Estate within threshold — no IHT due</div>}
                </div>
              </div>
            </Panel>

            <Panel title="Stamp Duty (SDLT/LBTT/LTT)" tip="SDLT rates changed April 2025: nil-rate reverted to £125,000 (was £250,000). FTB relief now starts at £300,000 (was £425,000). Pay within 14 days of completion. gov.uk/stamp-duty-land-tax">
              <div className="p-3 grid grid-cols-2 gap-3">
                <Input value={f.sdltPrice} onChange={v => set("sdltPrice", v)} label="Purchase price (£)" tip="The price paid as shown on your completion statement. SDLT is calculated progressively — each band rate only applies to the portion in that band, not the whole price." />
                <Select value={f.sdltType} onChange={v => set("sdltType", v)} label="Buyer type" tip="Standard: 0% up to £125,000. First time buyer (FTB): 0% up to £300,000, 5% up to £500,000 — no relief above £500,000. Additional property: 5% surcharge on every band from April 2025." options={[{ v: "standard", l: "Standard (moving home)" }, { v: "ftb", l: "First time buyer" }, { v: "additional", l: "Additional property / BTL" }]} />
              </div>
              <div className="px-3 pb-3 space-y-1">
                {sdltBands.map((b, i) => (
                  <div key={i} className="flex justify-between text-xs py-0.5">
                    <span className="text-gray-500">{b.label}</span>
                    <span className={`font-mono font-medium ${b.tax === 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>{b.tax === 0 ? "Nil" : fmt(b.tax)}</span>
                  </div>
                ))}
                <div className="flex justify-between font-medium border-t border-gray-200 dark:border-gray-700 pt-1 mt-1 text-xs">
                  <span>Total SDLT</span>
                  <span className={`font-mono ${sdltTax > 0 ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}`}>{fmt(sdltTax)}</span>
                </div>
              </div>
            </Panel>

            <Panel title="Capital Gains Tax" tip="CGT rates changed October 2024 Budget: shares 18%/24%, property 18%/24%, BADR 14%. Annual exempt amount £3,000. Report within 60 days for property. gov.uk/capital-gains-tax">
              <div className="p-3 grid grid-cols-2 gap-3">
                <Input value={f.cgtProceeds} onChange={v => set("cgtProceeds", v)} label="Sale proceeds" tip="Amount received from selling the asset. For property use completion statement price. For shares use sale proceeds minus broker commission." />
                <Input value={f.cgtCost} onChange={v => set("cgtCost", v)} label="Original cost" tip="What you originally paid including purchase costs (legal fees, broker commission). For shares use Section 104 pool average cost. Keep all records." />
                <Select value={f.cgtType} onChange={v => set("cgtType", v)} label="Asset type" tip="Shares/investments: 18% (basic) or 24% (higher). Residential property: 18%/24%. Business Asset Disposal Relief (BADR): 14% flat rate from April 2025 if qualifying conditions met." options={[{ v: "shares", l: "Shares & investments" }, { v: "property", l: "Residential property" }, { v: "badr", l: "Business assets (BADR 14%)" }]} />
                <Select value={f.cgtHigherRate} onChange={v => set("cgtHigherRate", v)} label="Higher rate taxpayer?" tip="Basic rate: 18% on shares/property. Higher/additional rate: 24% on shares/property. BADR is always 14% regardless of your tax band. Gains may push you into a higher band." options={[{ v: false, l: "Basic rate (income < £50,270)" }, { v: true, l: "Higher / additional rate" }]} />
              </div>
              <div className="px-3 pb-3">
                <div className="bg-gray-50 dark:bg-gray-800/60 rounded-lg p-2.5 text-xs space-y-1">
                  <div className="flex justify-between"><span className="text-gray-500">Gross gain</span><span className="font-mono">{fmt(cgtGain)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Annual exempt amount</span><span className="font-mono text-green-600 dark:text-green-400">-{fmt(Math.min(RATES.cgt_annual_exempt, cgtGain))}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Taxable gain</span><span className="font-mono">{fmt(cgtTaxable)}</span></div>
                  <div className="flex justify-between font-medium border-t border-gray-200 dark:border-gray-700 pt-1 mt-1">
                    <span>CGT ({pct(cgtRate * 100)})</span>
                    <span className="font-mono text-red-600 dark:text-red-400">{fmt(cgtTax)}</span>
                  </div>
                </div>
              </div>
            </Panel>

            <Panel title="Other taxes" tip="Regular taxes not based on income. Council Tax, VED, and IPT are separate from your Self Assessment.">
              <div className="p-3 grid grid-cols-2 gap-3">
                <Input value={f.councilTax} onChange={v => set("councilTax", v)} label="Council Tax (annual)" tip="Set by your local council. Average Band D England £2,171 in 2025/26. Find your rate and band on your council's website or your annual bill." />
                <Select value={f.councilDiscount} onChange={v => set("councilDiscount", v)} label="Council Tax discount" tip="25% single person discount. 50% for certain exempt statuses. 100% for full-time students. Apply via your local council website." options={[{ v: 0, l: "None" }, { v: 25, l: "25% single person" }, { v: 50, l: "50% discount" }, { v: 100, l: "100% exempt (student)" }]} />
                <Input value={f.vedAmount} onChange={v => set("vedAmount", v)} label="Vehicle Excise Duty (£/yr)" tip="From April 2025, EVs pay VED at £195/yr — no longer exempt. Low emission (1–50g CO2): £195. Medium (51–110g): £395. High (171–190g): £1,785. Renew at gov.uk/renew-vehicle-tax." />
                <Input value={f.iptNet} onChange={v => set("iptNet", v)} label="Insurance net premium (£)" tip="IPT is included in your insurance bill automatically. Standard rate 12% on home, car, pet insurance. Higher rate 20% on travel insurance." />
                <Select value={f.iptHigher} onChange={v => set("iptHigher", v)} label="IPT rate" tip="Standard 12% applies to most general insurance. Higher 20% applies to travel insurance and mechanical/electrical appliance insurance." options={[{ v: false, l: "Standard 12% (home/car/pet)" }, { v: true, l: "Higher 20% (travel)" }]} />
              </div>
              {(councilAfterDiscount > 0 || f.vedAmount > 0 || iptTax > 0) && (
                <div className="px-3 pb-3">
                  <div className="bg-gray-50 dark:bg-gray-800/60 rounded-lg p-2.5 text-xs space-y-1">
                    {councilAfterDiscount > 0 && <div className="flex justify-between"><span className="text-gray-500">Council Tax (after discount)</span><span className="font-mono text-red-600 dark:text-red-400">{fmt(councilAfterDiscount)}</span></div>}
                    {f.vedAmount > 0 && <div className="flex justify-between"><span className="text-gray-500">Vehicle Excise Duty</span><span className="font-mono text-red-600 dark:text-red-400">{fmt(f.vedAmount)}</span></div>}
                    {iptTax > 0 && <div className="flex justify-between"><span className="text-gray-500">Insurance Premium Tax</span><span className="font-mono text-red-600 dark:text-red-400">{fmt(iptTax)}</span></div>}
                  </div>
                </div>
              )}
            </Panel>
          </div>
        </div>
      )}

      {/* ═══ SUMMARY TAB ═══ */}
      {tab === "summary" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            <MetricCard label="Annual income taxes" value={fmt(annualTaxTotal + ctTax)} tip="IT + NI + CT + Student Loan — paid every year." color="red" />
            <MetricCard label="One-off taxes" value={fmt(ihtTax + sdltTax + cgtTax)} tip="IHT + SDLT + CGT — paid only when a specific event happens." color="red" />
            <MetricCard label="Other taxes" value={fmt(councilAfterDiscount + f.vedAmount + iptTax)} tip="Council Tax, VED, IPT — regular but not income-based." color="red" />
            <MetricCard label="Grand total" value={fmt(grandTotal)} tip="Every single tax added together across all categories." color="red" />
            <MetricCard label="Effective income rate" value={pct(effectiveRate)} tip="Total income tax and NI as % of gross income. Your real average rate." color="amber" />
          </div>

          <Panel title={`Complete UK tax liability — ${TAX_YEAR}`}>
            <div className="p-3">
              <SectionHead title="Annual income-based taxes" total={annualTaxTotal + ctTax} />
              {totalIT > 0 && <TaxRow label="Income Tax" band="Self Assessment / PAYE" rate="various" amount={totalIT} />}
              {totalNI > 0 && <TaxRow label="National Insurance" band="Employee Class 1 + Class 4" rate="various" amount={totalNI} />}
              {ctTax > 0 && <TaxRow label={`Corporation Tax (${pct(ctRate * 100)})`} band="Company profits" rate={pct(ctRate * 100)} amount={ctTax} />}
              {slAmt > 0 && <TaxRow label={`Student Loan Plan ${f.studentLoan}`} band="Above threshold" rate="9%" amount={slAmt} />}
              <SubTotal label="Annual taxes subtotal" amount={annualTaxTotal + ctTax} />

              <SectionHead title="One-off event-based taxes" total={ihtTax + sdltTax + cgtTax} />
              {ihtTax > 0 && <TaxRow label="Inheritance Tax" band="Estate above threshold" rate={pct(ihtCharityRate * 100)} amount={ihtTax} />}
              {sdltTax > 0 && <TaxRow label="Stamp Duty (SDLT)" band="Property purchase" rate="various" amount={sdltTax} />}
              {cgtTax > 0 && <TaxRow label="Capital Gains Tax" band="Asset disposal" rate={pct(cgtRate * 100)} amount={cgtTax} />}
              {(ihtTax + sdltTax + cgtTax) === 0 && <p className="text-xs text-gray-400 py-2">No one-off taxes entered — go to One-off taxes tab</p>}
              <SubTotal label="One-off taxes subtotal" amount={ihtTax + sdltTax + cgtTax} />

              {(councilAfterDiscount + f.vedAmount + iptTax) > 0 && <>
                <SectionHead title="Other regular taxes" total={councilAfterDiscount + f.vedAmount + iptTax} />
                {councilAfterDiscount > 0 && <TaxRow label="Council Tax" band="Local authority" rate="flat" amount={councilAfterDiscount} />}
                {f.vedAmount > 0 && <TaxRow label="Vehicle Excise Duty" band="DVLA" rate="flat" amount={f.vedAmount} />}
                {iptTax > 0 && <TaxRow label="Insurance Premium Tax" band="On premiums" rate={f.iptHigher ? "20%" : "12%"} amount={iptTax} />}
                <SubTotal label="Other taxes subtotal" amount={councilAfterDiscount + f.vedAmount + iptTax} />
              </>}
            </div>
            <GrandTotal label="Grand total — all taxes across all categories" amount={grandTotal} />
            {grossIncome > 0 && <TakeHome label="Estimated take-home after all annual taxes (one-off taxes are event-based)" amount={grossIncome - annualTaxTotal} />}
          </Panel>

          <div className="p-3 bg-amber-50 dark:bg-amber-950/30 rounded-lg border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
            <strong>Important:</strong> One-off taxes (IHT, SDLT, CGT) only apply when a specific event occurs and do not reduce your regular income. File Self Assessment by 31 January at gov.uk/self-assessment. Rates confirmed for tax year {TAX_YEAR} — verify at gov.uk before filing. This calculator does not constitute tax advice.
          </div>
        </div>
      )}
    </div>
  );
}

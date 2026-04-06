import UKTaxCalculator from "@/components/UKTaxCalculator";

export const metadata = {
  title: "UK Tax Calculator 2025/26 | ClearGains",
  description: "Calculate your complete UK tax liability for 2025/26 including Income Tax, National Insurance, Corporation Tax, IHT, Stamp Duty, CGT and more.",
};

export default function TaxCalculatorPage() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <div className="max-w-5xl mx-auto px-4 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
            UK Tax Calculator
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Tax year {" "}
            <span className="font-medium text-gray-700 dark:text-gray-300">2025/26</span>
            {" "} · All rates confirmed from HMRC gov.uk · Updated April 2025
          </p>
        </div>
        <UKTaxCalculator />
      </div>
    </div>
  );
}

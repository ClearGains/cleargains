import { ShieldAlert } from 'lucide-react';

export function Disclaimer() {
  return (
    <div className="border-t border-gray-800 bg-gray-950 px-4 py-3">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-start gap-2 text-xs text-gray-500">
          <ShieldAlert className="h-4 w-4 flex-shrink-0 mt-0.5 text-yellow-600" />
          <p className="leading-relaxed">
            <span className="font-semibold text-yellow-600">IMPORTANT DISCLAIMER: </span>
            ClearGains is an educational simulation tool only. It does not constitute financial advice
            and is not regulated by the Financial Conduct Authority (FCA). Past performance is not
            indicative of future results. Tax calculations are estimates only — consult a qualified
            tax advisor for your Self Assessment. Trading 212 is FCA regulated (FRN: 609146) and
            offers FSCS protection up to £85,000. Always verify calculations with{' '}
            <a
              href="https://www.gov.uk/capital-gains-tax"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-500 hover:text-blue-400 underline"
            >
              HMRC guidance
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  );
}

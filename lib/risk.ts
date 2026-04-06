// Risk engine — server-side safe, no direct DOM usage
import { T212Position, Section104Pool } from './types';

export interface RiskCheck {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail' | 'pending';
  assessment: string;
}

export interface ConcentrationMetrics {
  herfindahlIndex: number; // 0-1
  top1Pct: number;
  top3Pct: number;
  top5Pct: number;
  largestPosition: { ticker: string; pct: number };
}

export interface PortfolioRiskReport {
  totalValue: number;
  positionCount: number;
  concentration: ConcentrationMetrics;
  checks: RiskCheck[];
  riskScore: number; // 0-100
  riskLabel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  nonIsaValue: number;
  isaValue: number;
  estimatedVaR95: number; // 1-day 95% VaR (rough: 1.65 * 2% daily vol * portfolio)
  maxSingleExposure: number;
}

export function computePortfolioRisk(
  positions: T212Position[],
  pools: Record<string, Section104Pool>
): PortfolioRiskReport {
  const totalValue = positions.reduce(
    (s, p) => s + p.currentPrice * p.quantity,
    0
  );

  const nonIsaValue = positions
    .filter((p) => !p.isISA)
    .reduce((s, p) => s + p.currentPrice * p.quantity, 0);

  const isaValue = positions
    .filter((p) => p.isISA)
    .reduce((s, p) => s + p.currentPrice * p.quantity, 0);

  if (totalValue === 0 || positions.length === 0) {
    return emptyReport();
  }

  // Sort positions by value descending
  const sorted = [...positions].sort(
    (a, b) => b.currentPrice * b.quantity - a.currentPrice * a.quantity
  );

  const weights = sorted.map((p) => (p.currentPrice * p.quantity) / totalValue);

  // Herfindahl-Hirschman Index (HHI) — sum of squared weights
  const hhi = weights.reduce((s, w) => s + w * w, 0);

  const top1Pct = weights[0] * 100;
  const top3Pct = weights.slice(0, 3).reduce((s, w) => s + w, 0) * 100;
  const top5Pct = weights.slice(0, 5).reduce((s, w) => s + w, 0) * 100;

  const largestPosition = {
    ticker: sorted[0]?.ticker ?? '',
    pct: top1Pct,
  };

  const maxSingleExposure = top1Pct;

  // Very rough VaR: assume 2% avg daily volatility (market estimate), 1.65 sigma for 95%
  const estimatedVaR95 = totalValue * 0.02 * 1.65;

  // Build risk checks
  const checks: RiskCheck[] = [];

  checks.push({
    id: 'concentration-single',
    label: 'Single Position Limit',
    status: top1Pct > 40 ? 'fail' : top1Pct > 25 ? 'warn' : 'pass',
    assessment:
      top1Pct > 40
        ? `${largestPosition.ticker} is ${top1Pct.toFixed(1)}% of portfolio — critically concentrated`
        : top1Pct > 25
        ? `${largestPosition.ticker} is ${top1Pct.toFixed(1)}% of portfolio — moderately concentrated`
        : `Largest position (${largestPosition.ticker}) is ${top1Pct.toFixed(1)}% — within acceptable limits`,
  });

  checks.push({
    id: 'concentration-top3',
    label: 'Top 3 Concentration',
    status: top3Pct > 75 ? 'fail' : top3Pct > 60 ? 'warn' : 'pass',
    assessment:
      top3Pct > 75
        ? `Top 3 positions represent ${top3Pct.toFixed(1)}% — very high concentration risk`
        : top3Pct > 60
        ? `Top 3 positions represent ${top3Pct.toFixed(1)}% — consider diversifying`
        : `Top 3 at ${top3Pct.toFixed(1)}% — healthy spread`,
  });

  checks.push({
    id: 'diversification',
    label: 'Diversification',
    status:
      positions.length < 3
        ? 'fail'
        : positions.length < 8
        ? 'warn'
        : 'pass',
    assessment:
      positions.length < 3
        ? `Only ${positions.length} position(s) — extremely low diversification`
        : positions.length < 8
        ? `${positions.length} positions — moderate diversification, consider more holdings`
        : `${positions.length} positions — well diversified`,
  });

  checks.push({
    id: 'isa-wrapper',
    label: 'ISA Wrapper Usage',
    status: isaValue === 0 ? 'warn' : 'pass',
    assessment:
      isaValue === 0
        ? 'No ISA positions detected — consider using your £20,000 ISA allowance to shelter gains from CGT'
        : `${((isaValue / totalValue) * 100).toFixed(1)}% of portfolio (£${isaValue.toLocaleString('en-GB', { maximumFractionDigits: 0 })}) held in ISA wrapper — CGT-free`,
  });

  const pnlTotal = positions.reduce((s, p) => s + p.ppl, 0);
  const pnlPct = totalValue > 0 ? (pnlTotal / (totalValue - pnlTotal)) * 100 : 0;

  checks.push({
    id: 'unrealised-pnl',
    label: 'Unrealised P&L Exposure',
    status: pnlPct < -20 ? 'fail' : pnlPct < -10 ? 'warn' : 'pass',
    assessment:
      pnlPct < -20
        ? `Portfolio is down ${Math.abs(pnlPct).toFixed(1)}% overall — significant unrealised loss`
        : pnlPct < -10
        ? `Portfolio is down ${Math.abs(pnlPct).toFixed(1)}% — monitor closely`
        : pnlPct >= 0
        ? `Portfolio is up ${pnlPct.toFixed(1)}% — positive unrealised gains`
        : `Portfolio is down ${Math.abs(pnlPct).toFixed(1)}% — within acceptable range`,
  });

  // Section 104 pool check
  const poolCount = Object.keys(pools).length;
  checks.push({
    id: 'section104-pool',
    label: 'Section 104 Pools',
    status: poolCount === 0 ? 'warn' : 'pass',
    assessment:
      poolCount === 0
        ? 'No Section 104 pools computed — add your trade history in the Ledger to enable CGT calculations'
        : `${poolCount} share pools active — CGT computations are available`,
  });

  // Compute overall risk score (0=safest, 100=riskiest)
  const failCount = checks.filter((c) => c.status === 'fail').length;
  const warnCount = checks.filter((c) => c.status === 'warn').length;
  const rawScore = failCount * 25 + warnCount * 10 + (hhi * 100) * 0.3;
  const riskScore = Math.min(100, Math.round(rawScore));

  const riskLabel: PortfolioRiskReport['riskLabel'] =
    riskScore >= 70
      ? 'CRITICAL'
      : riskScore >= 45
      ? 'HIGH'
      : riskScore >= 20
      ? 'MEDIUM'
      : 'LOW';

  return {
    totalValue,
    positionCount: positions.length,
    concentration: { herfindahlIndex: hhi, top1Pct, top3Pct, top5Pct, largestPosition },
    checks,
    riskScore,
    riskLabel,
    nonIsaValue,
    isaValue,
    estimatedVaR95,
    maxSingleExposure,
  };
}

function emptyReport(): PortfolioRiskReport {
  return {
    totalValue: 0,
    positionCount: 0,
    concentration: {
      herfindahlIndex: 0,
      top1Pct: 0,
      top3Pct: 0,
      top5Pct: 0,
      largestPosition: { ticker: '—', pct: 0 },
    },
    checks: [],
    riskScore: 0,
    riskLabel: 'LOW',
    nonIsaValue: 0,
    isaValue: 0,
    estimatedVaR95: 0,
    maxSingleExposure: 0,
  };
}

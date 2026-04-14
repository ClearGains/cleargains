'use client';

import { useEffect, useRef } from 'react';
import { useClearGainsStore } from '@/lib/store';
import { useToast } from '@/components/ui/Toast';
import { calcDisposalCGT, computeTaxYearSummary } from '@/lib/taxMonitor';
import { T212Position, TaxTrade, CGTAlert } from '@/lib/types';

const CGT_AEA = 3_000;
const POLL_INTERVAL = 60_000;

// T212 order history item shape (simplified)
type T212HistoryOrder = {
  id: string;
  ticker: string;
  type: 'MARKET' | 'LIMIT' | 'STOP';
  filledQuantity: number;
  fillPrice?: number;
  fillResult?: number;      // total fill value
  status: 'FILLED' | 'CANCELLED' | 'REJECTED';
  dateCreated: string;
  dateModified: string;
};

type StateSnapshot = {
  t212ApiKey: string;
  t212ApiSecret: string;
  t212Connected: boolean;
  t212IsaApiKey: string;
  t212IsaApiSecret: string;
  t212IsaConnected: boolean;
  trades: ReturnType<typeof useClearGainsStore.getState>['trades'];
  taxTrades: TaxTrade[];
  carriedForwardLosses: number;
  taxMonitorLivePositions: T212Position[];
  addTaxTrade: (trade: TaxTrade) => void;
  addCGTAlert: (alert: CGTAlert) => void;
  setTaxMonitorLastPoll: (ts: string) => void;
  setTaxMonitorLivePositions: (positions: T212Position[]) => void;
  addToast: ReturnType<typeof useToast>['addToast'];
};

export function TaxMonitorService() {
  const {
    t212ApiKey, t212ApiSecret, t212Connected,
    t212IsaApiKey, t212IsaApiSecret, t212IsaConnected,
    trades, taxTrades, carriedForwardLosses,
    taxMonitorLivePositions,
    addTaxTrade, addCGTAlert, setTaxMonitorLastPoll, setTaxMonitorLivePositions,
  } = useClearGainsStore();

  const { addToast } = useToast();

  const stateRef = useRef<StateSnapshot>({
    t212ApiKey, t212ApiSecret, t212Connected,
    t212IsaApiKey, t212IsaApiSecret, t212IsaConnected,
    trades, taxTrades, carriedForwardLosses,
    taxMonitorLivePositions,
    addTaxTrade, addCGTAlert, setTaxMonitorLastPoll, setTaxMonitorLivePositions,
    addToast,
  });

  useEffect(() => {
    stateRef.current = {
      t212ApiKey, t212ApiSecret, t212Connected,
      t212IsaApiKey, t212IsaApiSecret, t212IsaConnected,
      trades, taxTrades, carriedForwardLosses,
      taxMonitorLivePositions,
      addTaxTrade, addCGTAlert, setTaxMonitorLastPoll, setTaxMonitorLivePositions,
      addToast,
    };
  });

  useEffect(() => {
    async function detectClosures(
      currentPositions: T212Position[],
      isISA: boolean,
      encoded: string,
      s: StateSnapshot,
    ) {
      const prevPositions = s.taxMonitorLivePositions.filter(p => p.isISA === isISA);
      const currentTickers = new Set(currentPositions.map(p => p.ticker));

      for (const prev of prevPositions) {
        if (currentTickers.has(prev.ticker)) continue;

        // Position closed — fetch order history to get sell price
        let proceedsGBP = prev.currentPrice * prev.quantity; // fallback
        let disposalDate = new Date().toISOString();

        try {
          const histRes = await fetch(`/api/t212/history?env=live&limit=20`, {
            headers: { 'x-t212-auth': encoded },
          });
          if (histRes.ok) {
            const histData = await histRes.json() as { items?: T212HistoryOrder[] } | T212HistoryOrder[];
            const orders: T212HistoryOrder[] = Array.isArray(histData) ? histData : (histData.items ?? []);
            const tickerBase = prev.ticker.replace(/_[A-Z]{2}_EQ$/, '');
            const sellOrder = orders.find(o =>
              o.status === 'FILLED' &&
              (o.ticker === prev.ticker || o.ticker.startsWith(tickerBase)) &&
              o.filledQuantity > 0
            );
            if (sellOrder) {
              const fillValue = sellOrder.fillResult ?? ((sellOrder.fillPrice ?? prev.currentPrice) * sellOrder.filledQuantity);
              proceedsGBP = fillValue;
              disposalDate = sellOrder.dateModified ?? sellOrder.dateCreated ?? disposalDate;
            }
          }
        } catch { /* use fallback */ }

        const ticker = prev.ticker.replace(/_[A-Z]{2}_EQ$/, '');

        const taxTrade = calcDisposalCGT({
          ticker,
          isISA,
          disposalDate,
          quantity: prev.quantity,
          proceedsGBP,
          trades: s.trades.filter(t => t.ticker === ticker || t.ticker === prev.ticker),
          existingTaxTrades: s.taxTrades,
          carriedForwardLosses: s.carriedForwardLosses,
          source: isISA ? 't212-isa' : 't212-live',
          accountType: isISA ? 'isa' : 'invest',
        });

        s.addTaxTrade(taxTrade);

        const summary = computeTaxYearSummary([...s.taxTrades, taxTrade], s.carriedForwardLosses);
        const aeaExceeded = summary.netGain > CGT_AEA;
        const aeaNearLimit = !aeaExceeded && summary.aeaRemaining < 500;

        if (isISA) {
          s.addToast({ type: 'success', title: `${ticker} — ISA Disposal`, message: 'Tax Free — ISA gains are exempt from CGT.' });
        } else if (taxTrade.gainGBP > 0) {
          const toastTitle = aeaExceeded
            ? `${ticker} closed — AEA exceeded`
            : `${ticker} closed — Gain: £${taxTrade.gainGBP.toFixed(2)}`;
          const toastMsg = taxTrade.taxDueGBP > 0
            ? `CGT est: £${taxTrade.taxDueGBP.toFixed(2)} | Rule: ${taxTrade.rule}`
            : `Within AEA — no CGT due yet`;
          s.addToast({ type: aeaExceeded ? 'error' : 'success', title: toastTitle, message: toastMsg, duration: 8000 });
        } else {
          s.addToast({
            type: 'info',
            title: `${ticker} closed — Loss: £${taxTrade.lossGBP.toFixed(2)}`,
            message: 'Loss banked — will offset future gains this tax year.',
            duration: 7000,
          });
        }

        if (taxTrade.bbWarning) {
          setTimeout(() => {
            s.addToast({ type: 'warning', title: `${ticker} — Bed & Breakfast Rule`, message: 'Repurchased within 30 days. This disposal uses repurchase price not pool price.', duration: 10000 });
          }, 1000);
          s.addCGTAlert({ id: Math.random().toString(36).slice(2), type: 'bb-rule', ticker, message: `${ticker} — B&B 30-day rule triggered`, ts: new Date().toISOString() });
        }

        if (aeaExceeded) {
          s.addCGTAlert({ id: Math.random().toString(36).slice(2), type: 'aea-exceeded', message: `CGT threshold exceeded — gains now fully taxable`, ts: new Date().toISOString() });
        } else if (aeaNearLimit) {
          s.addCGTAlert({ id: Math.random().toString(36).slice(2), type: 'aea-warning', message: `Only £${summary.aeaRemaining.toFixed(0)} of AEA remaining this tax year`, ts: new Date().toISOString() });
          setTimeout(() => {
            s.addToast({ type: 'warning', title: 'AEA Nearly Used', message: `Only £${summary.aeaRemaining.toFixed(0)} of your £3,000 CGT exemption remains.`, duration: 10000 });
          }, 500);
        }

        s.addCGTAlert({
          id: Math.random().toString(36).slice(2),
          type: taxTrade.gainGBP > 0 ? 'gain' : 'loss',
          ticker,
          message: taxTrade.gainGBP > 0
            ? `${ticker} sold — Gain: £${taxTrade.gainGBP.toFixed(2)} | Rule: ${taxTrade.rule} | Tax: £${taxTrade.taxDueGBP.toFixed(2)}`
            : `${ticker} sold — Loss: £${taxTrade.lossGBP.toFixed(2)} — carried forward for offset`,
          ts: disposalDate,
        });
      }
    }

    async function poll() {
      const s = stateRef.current;

      // Fetch live invest positions
      if (s.t212Connected && s.t212ApiKey) {
        const encoded = btoa(s.t212ApiKey + ':' + s.t212ApiSecret);
        try {
          const res = await fetch('/api/t212/positions?env=live', {
            headers: { 'x-t212-auth': encoded },
          });
          if (res.ok) {
            const data = await res.json() as { items?: Record<string, unknown>[] } | Record<string, unknown>[];
            const rawPositions: Record<string, unknown>[] = Array.isArray(data) ? data : ((data as { items?: Record<string, unknown>[] }).items ?? []);
            const mapped: T212Position[] = rawPositions.map(p => ({
              ticker: String(p['ticker'] ?? ''),
              quantity: Number(p['quantity'] ?? p['quantityPrecision'] ?? 0),
              averagePrice: Number(p['averagePrice'] ?? p['averagePriceConverted'] ?? 0),
              currentPrice: Number(p['currentPrice'] ?? 0),
              ppl: Number(p['ppl'] ?? 0),
              fxPpl: Number(p['fxPpl'] ?? 0),
              initialFillDate: String(p['initialFillDate'] ?? new Date().toISOString()),
              isISA: false,
            }));

            await detectClosures(mapped, false, encoded, s);
            s.setTaxMonitorLivePositions(mapped);
            s.setTaxMonitorLastPoll(new Date().toISOString());
          }
        } catch { /* network error, ignore */ }
      }

      // Fetch ISA positions
      if (s.t212IsaConnected && s.t212IsaApiKey) {
        const isaEncoded = btoa(s.t212IsaApiKey + ':' + s.t212IsaApiSecret);
        try {
          const res = await fetch('/api/t212/positions?env=live', {
            headers: { 'x-t212-auth': isaEncoded },
          });
          if (res.ok) {
            const data = await res.json() as { items?: Record<string, unknown>[] } | Record<string, unknown>[];
            const rawPositions: Record<string, unknown>[] = Array.isArray(data) ? data : ((data as { items?: Record<string, unknown>[] }).items ?? []);
            const mapped: T212Position[] = rawPositions.map(p => ({
              ticker: String(p['ticker'] ?? ''),
              quantity: Number(p['quantity'] ?? 0),
              averagePrice: Number(p['averagePrice'] ?? 0),
              currentPrice: Number(p['currentPrice'] ?? 0),
              ppl: Number(p['ppl'] ?? 0),
              fxPpl: Number(p['fxPpl'] ?? 0),
              initialFillDate: String(p['initialFillDate'] ?? new Date().toISOString()),
              isISA: true,
            }));

            const prevIsaPositions = s.taxMonitorLivePositions.filter(p => p.isISA);
            const currentTickers = new Set(mapped.map(p => p.ticker));
            for (const prev of prevIsaPositions) {
              if (!currentTickers.has(prev.ticker)) {
                s.addToast({
                  type: 'success',
                  title: `${prev.ticker} — ISA Position Closed`,
                  message: 'ISA disposal — no CGT due. This is completely tax free.',
                });
                s.addCGTAlert({
                  id: Math.random().toString(36).slice(2, 10),
                  type: 'isa',
                  ticker: prev.ticker,
                  message: `${prev.ticker} ISA disposal — Tax Free`,
                  ts: new Date().toISOString(),
                });
              }
            }
          }
        } catch { /* ignore */ }
      }
    }

    poll();
    const interval = setInterval(poll, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

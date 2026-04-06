'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  Country,
  Trade,
  Section104Pool,
  Signal,
  T212Position,
} from './types';
import { DEFAULT_COUNTRY } from './countries';

interface ClearGainsState {
  // Onboarding
  selectedCountry: Country;
  hasOnboarded: boolean;

  // Trades
  trades: Trade[];

  // Section 104 pools (derived, but cached)
  section104Pools: Record<string, Section104Pool>;

  // T212 integration
  t212AccountType: 'LIVE' | 'DEMO';
  t212LastSync: string | null;
  t212Positions: T212Position[];
  t212Connected: boolean;

  // Features
  autoReinvest: boolean;

  // AI signals
  signals: Signal[];

  // FX rates (base GBP)
  fxRates: Record<string, number>;
  fxRatesLastFetched: string | null;

  // Deadlines reminders
  deadlineReminders: string[]; // country codes with reminders set

  // Actions
  setCountry: (country: Country) => void;
  setHasOnboarded: (v: boolean) => void;
  addTrade: (trade: Trade) => void;
  removeTrade: (id: string) => void;
  setTrades: (trades: Trade[]) => void;
  updateSection104Pools: (pools: Record<string, Section104Pool>) => void;
  setT212AccountType: (type: 'LIVE' | 'DEMO') => void;
  setT212LastSync: (date: string) => void;
  setT212Positions: (positions: T212Position[]) => void;
  setT212Connected: (v: boolean) => void;
  setAutoReinvest: (v: boolean) => void;
  addSignal: (signal: Signal) => void;
  setFxRates: (rates: Record<string, number>) => void;
  toggleDeadlineReminder: (countryCode: string) => void;
  reset: () => void;
}

export const useClearGainsStore = create<ClearGainsState>()(
  persist(
    (set) => ({
      selectedCountry: DEFAULT_COUNTRY,
      hasOnboarded: false,
      trades: [],
      section104Pools: {},
      t212AccountType: 'DEMO',
      t212LastSync: null,
      t212Positions: [],
      t212Connected: false,
      autoReinvest: false,
      signals: [],
      fxRates: {},
      fxRatesLastFetched: null,
      deadlineReminders: [],

      setCountry: (country) => set({ selectedCountry: country }),
      setHasOnboarded: (v) => set({ hasOnboarded: v }),

      addTrade: (trade) =>
        set((state) => ({ trades: [...state.trades, trade] })),

      removeTrade: (id) =>
        set((state) => ({ trades: state.trades.filter((t) => t.id !== id) })),

      setTrades: (trades) => set({ trades }),

      updateSection104Pools: (pools) => set({ section104Pools: pools }),

      setT212AccountType: (type) => set({ t212AccountType: type }),

      setT212LastSync: (date) => set({ t212LastSync: date }),

      setT212Positions: (positions) => set({ t212Positions: positions }),

      setT212Connected: (v) => set({ t212Connected: v }),

      setAutoReinvest: (v) => set({ autoReinvest: v }),

      addSignal: (signal) =>
        set((state) => ({
          signals: [signal, ...state.signals].slice(0, 20),
        })),

      setFxRates: (rates) =>
        set({ fxRates: rates, fxRatesLastFetched: new Date().toISOString() }),

      toggleDeadlineReminder: (countryCode) =>
        set((state) => ({
          deadlineReminders: state.deadlineReminders.includes(countryCode)
            ? state.deadlineReminders.filter((c) => c !== countryCode)
            : [...state.deadlineReminders, countryCode],
        })),

      reset: () =>
        set({
          selectedCountry: DEFAULT_COUNTRY,
          hasOnboarded: false,
          trades: [],
          section104Pools: {},
          t212AccountType: 'DEMO',
          t212LastSync: null,
          t212Positions: [],
          t212Connected: false,
          autoReinvest: false,
          signals: [],
          fxRates: {},
          fxRatesLastFetched: null,
          deadlineReminders: [],
        }),
    }),
    {
      name: 'cleargains-storage',
      partialize: (state) => ({
        selectedCountry: state.selectedCountry,
        hasOnboarded: state.hasOnboarded,
        trades: state.trades,
        section104Pools: state.section104Pools,
        t212AccountType: state.t212AccountType,
        t212LastSync: state.t212LastSync,
        t212Positions: state.t212Positions,
        t212Connected: state.t212Connected,
        autoReinvest: state.autoReinvest,
        signals: state.signals,
        deadlineReminders: state.deadlineReminders,
      }),
    }
  )
);

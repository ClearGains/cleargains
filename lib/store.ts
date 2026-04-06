'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  Country,
  Trade,
  Section104Pool,
  Signal,
  ScanResult,
  T212Position,
  DemoPosition,
  DemoTrade,
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

  // T212 user-provided credentials (stored in localStorage, never sent to any server except T212)
  t212ApiKey: string;
  t212ApiSecret: string;
  t212AccountType: 'LIVE' | 'DEMO';
  t212AccountInfo: { id: string; currency: string } | null;
  t212LastSync: string | null;
  t212Positions: T212Position[];
  t212Connected: boolean;

  // Features
  autoReinvest: boolean;

  // AI signals
  signals: Signal[];

  // Scanner watchlist & history
  watchlist: string[];
  scanHistory: ScanResult[];

  // FX rates (base GBP)
  fxRates: Record<string, number>;
  fxRatesLastFetched: string | null;

  // Deadlines reminders
  deadlineReminders: string[];

  // Demo Auto-Trader
  t212DemoApiKey: string;
  t212DemoApiSecret: string;
  demoPositions: DemoPosition[];
  demoTrades: DemoTrade[];
  paperBudget: number;

  // Actions
  setCountry: (country: Country) => void;
  setHasOnboarded: (v: boolean) => void;
  addTrade: (trade: Trade) => void;
  removeTrade: (id: string) => void;
  setTrades: (trades: Trade[]) => void;
  updateSection104Pools: (pools: Record<string, Section104Pool>) => void;
  setT212Credentials: (key: string, secret: string) => void;
  clearT212Credentials: () => void;
  setT212AccountType: (type: 'LIVE' | 'DEMO') => void;
  setT212AccountInfo: (info: { id: string; currency: string } | null) => void;
  setT212LastSync: (date: string) => void;
  setT212Positions: (positions: T212Position[]) => void;
  setT212Connected: (v: boolean) => void;
  setAutoReinvest: (v: boolean) => void;
  addSignal: (signal: Signal) => void;
  addToWatchlist: (ticker: string) => void;
  removeFromWatchlist: (ticker: string) => void;
  addScanResult: (result: ScanResult) => void;
  setFxRates: (rates: Record<string, number>) => void;
  toggleDeadlineReminder: (countryCode: string) => void;
  setT212DemoCredentials: (key: string, secret: string) => void;
  clearT212DemoCredentials: () => void;
  addDemoPosition: (pos: DemoPosition) => void;
  removeDemoPosition: (id: string) => void;
  updateDemoPosition: (id: string, update: Partial<DemoPosition>) => void;
  addDemoTrade: (trade: DemoTrade) => void;
  setPaperBudget: (n: number) => void;
  resetPaperAccount: () => void;
  reset: () => void;
}

export const useClearGainsStore = create<ClearGainsState>()(
  persist(
    (set) => ({
      selectedCountry: DEFAULT_COUNTRY,
      hasOnboarded: false,
      trades: [],
      section104Pools: {},
      t212ApiKey: '',
      t212ApiSecret: '',
      t212AccountType: 'DEMO',
      t212AccountInfo: null,
      t212LastSync: null,
      t212Positions: [],
      t212Connected: false,
      autoReinvest: false,
      signals: [],
      watchlist: [],
      scanHistory: [],
      fxRates: {},
      fxRatesLastFetched: null,
      deadlineReminders: [],
      t212DemoApiKey: '',
      t212DemoApiSecret: '',
      demoPositions: [],
      demoTrades: [],
      paperBudget: 1000,

      setCountry: (country) => set({ selectedCountry: country }),
      setHasOnboarded: (v) => set({ hasOnboarded: v }),

      addTrade: (trade) =>
        set((state) => ({ trades: [...state.trades, trade] })),

      removeTrade: (id) =>
        set((state) => ({ trades: state.trades.filter((t) => t.id !== id) })),

      setTrades: (trades) => set({ trades }),

      updateSection104Pools: (pools) => set({ section104Pools: pools }),

      setT212Credentials: (key, secret) =>
        set({ t212ApiKey: key, t212ApiSecret: secret }),

      clearT212Credentials: () =>
        set({
          t212ApiKey: '',
          t212ApiSecret: '',
          t212Connected: false,
          t212AccountInfo: null,
          t212Positions: [],
          t212LastSync: null,
        }),

      setT212AccountType: (type) => set({ t212AccountType: type }),

      setT212AccountInfo: (info) => set({ t212AccountInfo: info }),

      setT212LastSync: (date) => set({ t212LastSync: date }),

      setT212Positions: (positions) => set({ t212Positions: positions }),

      setT212Connected: (v) => set({ t212Connected: v }),

      setAutoReinvest: (v) => set({ autoReinvest: v }),

      addSignal: (signal) =>
        set((state) => ({
          signals: [signal, ...state.signals].slice(0, 20),
        })),

      addToWatchlist: (ticker) =>
        set((state) => ({
          watchlist: state.watchlist.includes(ticker)
            ? state.watchlist
            : [...state.watchlist, ticker],
        })),

      removeFromWatchlist: (ticker) =>
        set((state) => ({
          watchlist: state.watchlist.filter((t) => t !== ticker),
        })),

      addScanResult: (result) =>
        set((state) => ({
          scanHistory: [result, ...state.scanHistory].slice(0, 30),
        })),

      setFxRates: (rates) =>
        set({ fxRates: rates, fxRatesLastFetched: new Date().toISOString() }),

      toggleDeadlineReminder: (countryCode) =>
        set((state) => ({
          deadlineReminders: state.deadlineReminders.includes(countryCode)
            ? state.deadlineReminders.filter((c) => c !== countryCode)
            : [...state.deadlineReminders, countryCode],
        })),

      setT212DemoCredentials: (key, secret) =>
        set({ t212DemoApiKey: key, t212DemoApiSecret: secret }),

      clearT212DemoCredentials: () =>
        set({ t212DemoApiKey: '', t212DemoApiSecret: '', demoPositions: [], demoTrades: [] }),

      addDemoPosition: (pos) =>
        set((state) => ({ demoPositions: [...state.demoPositions, pos] })),

      removeDemoPosition: (id) =>
        set((state) => ({ demoPositions: state.demoPositions.filter((p) => p.id !== id) })),

      updateDemoPosition: (id, update) =>
        set((state) => ({
          demoPositions: state.demoPositions.map((p) => p.id === id ? { ...p, ...update } : p),
        })),

      addDemoTrade: (trade) =>
        set((state) => ({ demoTrades: [trade, ...state.demoTrades].slice(0, 100) })),

      setPaperBudget: (n) => set({ paperBudget: n }),

      resetPaperAccount: () => set({ demoPositions: [], demoTrades: [] }),

      reset: () =>
        set({
          selectedCountry: DEFAULT_COUNTRY,
          hasOnboarded: false,
          trades: [],
          section104Pools: {},
          t212ApiKey: '',
          t212ApiSecret: '',
          t212AccountType: 'DEMO',
          t212AccountInfo: null,
          t212LastSync: null,
          t212Positions: [],
          t212Connected: false,
          autoReinvest: false,
          signals: [],
          watchlist: [],
          scanHistory: [],
          fxRates: {},
          fxRatesLastFetched: null,
          deadlineReminders: [],
          t212DemoApiKey: '',
          t212DemoApiSecret: '',
          demoPositions: [],
          demoTrades: [],
          paperBudget: 1000,
        }),
    }),
    {
      name: 'cleargains-storage',
      partialize: (state) => ({
        selectedCountry: state.selectedCountry,
        hasOnboarded: state.hasOnboarded,
        trades: state.trades,
        section104Pools: state.section104Pools,
        t212ApiKey: state.t212ApiKey,
        t212ApiSecret: state.t212ApiSecret,
        t212AccountType: state.t212AccountType,
        t212AccountInfo: state.t212AccountInfo,
        t212LastSync: state.t212LastSync,
        t212Positions: state.t212Positions,
        t212Connected: state.t212Connected,
        autoReinvest: state.autoReinvest,
        signals: state.signals,
        watchlist: state.watchlist,
        scanHistory: state.scanHistory,
        deadlineReminders: state.deadlineReminders,
        t212DemoApiKey: state.t212DemoApiKey,
        t212DemoApiSecret: state.t212DemoApiSecret,
        demoPositions: state.demoPositions,
        demoTrades: state.demoTrades,
        paperBudget: state.paperBudget,
      }),
    }
  )
);

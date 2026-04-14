'use client';

import { useState, FormEvent, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  TrendingUp, Lock, AlertCircle, Eye, EyeOff,
  ChevronRight, CheckCircle2, Loader2, X,
} from 'lucide-react';
import { useClearGainsStore } from '@/lib/store';
import { clsx } from 'clsx';

// ── Account type definitions ──────────────────────────────────────────────────
type T212AccountType = 'demo' | 'live' | 'isa';

const ACCOUNTS: {
  type: T212AccountType;
  label: string;
  sublabel: string;
  icon: string;
  color: string;
  border: string;
  activeBg: string;
  activeBorder: string;
  btnClass: string;
}[] = [
  {
    type: 'demo',
    label: 'Practice / Demo',
    sublabel: 'Virtual money · no risk',
    icon: '🎮',
    color: 'text-blue-400',
    border: 'border-gray-800',
    activeBg: 'bg-blue-500/10',
    activeBorder: 'border-blue-500/50',
    btnClass: 'bg-blue-600 hover:bg-blue-500',
  },
  {
    type: 'live',
    label: 'Invest Account',
    sublabel: 'Live trading · taxable gains',
    icon: '📊',
    color: 'text-emerald-400',
    border: 'border-gray-800',
    activeBg: 'bg-emerald-500/10',
    activeBorder: 'border-emerald-500/50',
    btnClass: 'bg-emerald-600 hover:bg-emerald-500',
  },
  {
    type: 'isa',
    label: 'Stocks ISA',
    sublabel: 'Tax-free wrapper · live trading',
    icon: '📈',
    color: 'text-indigo-400',
    border: 'border-gray-800',
    activeBg: 'bg-indigo-500/10',
    activeBorder: 'border-indigo-500/50',
    btnClass: 'bg-indigo-600 hover:bg-indigo-500',
  },
];

// ── T212 login form ───────────────────────────────────────────────────────────
function T212LoginForm({
  accountType,
  onSuccess,
}: {
  accountType: T212AccountType;
  onSuccess: () => void;
}) {
  const acc = ACCOUNTS.find(a => a.type === accountType)!;
  const store = useClearGainsStore();

  const [key, setKey]       = useState('');
  const [secret, setSecret] = useState('');
  const [showKey, setShowKey]       = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError]    = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const cleanKey    = key.replace(/[\s\n\r\t]/g, '');
    const cleanSecret = secret.replace(/[\s\n\r\t]/g, '');
    if (!cleanKey || !cleanSecret) {
      setError('Both API key and secret are required.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/login-with-t212', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: cleanKey, apiSecret: cleanSecret, accountType }),
      });
      const data = await res.json() as {
        ok: boolean; error?: string;
        accountId?: string; currency?: string; cash?: number; keyHashPrefix?: string;
      };

      if (!data.ok) {
        setError(data.error ?? 'Connection failed.');
        return;
      }

      // Persist credentials + connection state in localStorage via Zustand
      const info = { id: data.accountId ?? '', currency: data.currency ?? 'GBP' };
      if (accountType === 'demo') {
        store.setT212DemoCredentials(cleanKey, cleanSecret);
        store.setT212DemoAccountInfo(info);
        store.setT212DemoConnected(true);
      } else if (accountType === 'live') {
        store.setT212Credentials(cleanKey, cleanSecret);
        store.setT212AccountInfo(info);
        store.setT212Connected(true);
        store.setT212AccountType('LIVE');
      } else {
        store.setT212IsaCredentials(cleanKey, cleanSecret);
        store.setT212IsaAccountInfo(info);
        store.setT212IsaConnected(true);
      }
      if (data.keyHashPrefix) {
        store.setLinkedAccountId(accountType, data.keyHashPrefix);
      }

      onSuccess();
    } catch (err) {
      setError(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 space-y-3">
      {/* API Key */}
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1.5">API Key</label>
        <div className="relative">
          <input
            type={showKey ? 'text' : 'password'}
            value={key}
            onChange={e => setKey(e.target.value)}
            placeholder={`${acc.label} API key`}
            autoFocus
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 pr-10"
          />
          <button type="button" onClick={() => setShowKey(v => !v)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
            {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* API Secret */}
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1.5">API Secret</label>
        <div className="relative">
          <input
            type={showSecret ? 'text' : 'password'}
            value={secret}
            onChange={e => setSecret(e.target.value)}
            placeholder={`${acc.label} API secret`}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 pr-10"
          />
          <button type="button" onClick={() => setShowSecret(v => !v)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
            {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2.5 text-xs text-red-400">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className={clsx(
          'w-full text-white font-semibold rounded-lg py-2.5 text-sm transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed',
          acc.btnClass
        )}
      >
        {loading
          ? <><Loader2 className="h-4 w-4 animate-spin" /> Connecting…</>
          : <>Connect {acc.label} <ChevronRight className="h-4 w-4" /></>
        }
      </button>

      <p className="text-[11px] text-gray-600 text-center">
        Your credentials are validated against T212 and stored only in your browser.
      </p>
    </form>
  );
}

// ── Site-password form ────────────────────────────────────────────────────────
function SitePasswordForm({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!password) { setError('Please enter the site password.'); return; }
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (data.ok) { onSuccess(); }
      else { setError(data.error ?? 'Incorrect password.'); }
    } catch {
      setError('Request failed. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1.5">Site Password</label>
        <div className="relative">
          <input
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoFocus
            placeholder="Enter password"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 pr-10"
          />
          <button type="button" onClick={() => setShowPassword(v => !v)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2.5 text-xs text-red-400">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-lg py-2.5 text-sm transition-colors flex items-center justify-center gap-2"
      >
        {loading ? <><Loader2 className="h-4 w-4 animate-spin" /> Verifying…</> : 'Enter'}
      </button>
    </form>
  );
}

// ── Main login form ───────────────────────────────────────────────────────────
function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const from = searchParams.get('from') ?? '/dashboard';

  const [mode, setMode] = useState<'choose' | T212AccountType | 'password'>('choose');
  const [success, setSuccess] = useState(false);

  function handleSuccess() {
    setSuccess(true);
    setTimeout(() => router.replace(from), 600);
  }

  return (
    <div className="min-h-screen bg-gray-950 overflow-y-auto">
      {/* Close / skip button */}
      <button
        onClick={() => router.replace(from)}
        className="fixed top-4 right-4 z-50 flex items-center justify-center w-9 h-9 rounded-full bg-gray-800 border border-gray-700 text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
        title="Close"
      >
        <X className="h-4 w-4" />
      </button>

      <div className="flex flex-col items-center pt-20 pb-12 px-4">
        <div className="w-full max-w-md">

          {/* Logo */}
          <div className="flex items-center justify-center gap-2.5 mb-8">
            <div className="bg-emerald-600 rounded-xl p-2.5 shadow-lg shadow-emerald-900/40">
              <TrendingUp className="h-6 w-6 text-white" />
            </div>
            <span className="text-2xl font-bold text-white tracking-tight">
              Clear<span className="text-emerald-400">Gains</span>
            </span>
          </div>

          {/* Success state */}
          {success ? (
            <div className="bg-gray-900 border border-emerald-500/30 rounded-2xl p-8 shadow-2xl text-center">
              <CheckCircle2 className="h-12 w-12 text-emerald-400 mx-auto mb-3" />
              <p className="text-white font-semibold text-lg">Connected!</p>
              <p className="text-gray-500 text-sm mt-1">Redirecting to your dashboard…</p>
            </div>
          ) : mode === 'choose' ? (
            /* ── Account picker ─────────────────────────────────────────── */
            <div>
              <div className="text-center mb-6">
                <h1 className="text-xl font-bold text-white">Sign in to ClearGains</h1>
                <p className="text-sm text-gray-500 mt-1">Connect a Trading 212 account to get started</p>
              </div>

              <div className="space-y-3">
                {ACCOUNTS.map(acc => (
                  <button
                    key={acc.type}
                    onClick={() => setMode(acc.type)}
                    className={clsx(
                      'w-full flex items-center gap-4 bg-gray-900 border rounded-xl px-4 py-4 transition-all hover:border-gray-600 group text-left',
                      acc.border
                    )}
                  >
                    <span className="text-2xl flex-shrink-0">{acc.icon}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-white group-hover:text-white">{acc.label}</p>
                      <p className={clsx('text-xs mt-0.5', acc.color)}>{acc.sublabel}</p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-gray-600 group-hover:text-gray-400 flex-shrink-0 transition-colors" />
                  </button>
                ))}
              </div>

              {/* Divider */}
              <div className="flex items-center gap-3 my-5">
                <div className="flex-1 h-px bg-gray-800" />
                <span className="text-xs text-gray-600">or</span>
                <div className="flex-1 h-px bg-gray-800" />
              </div>

              <button
                onClick={() => setMode('password')}
                className="w-full flex items-center gap-3 bg-gray-900 border border-gray-800 rounded-xl px-4 py-3.5 hover:border-gray-600 transition-all group text-left"
              >
                <Lock className="h-5 w-5 text-gray-500 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-300 group-hover:text-white transition-colors">Site Password</p>
                  <p className="text-xs text-gray-600 mt-0.5">Admin access</p>
                </div>
                <ChevronRight className="h-4 w-4 text-gray-600 group-hover:text-gray-400 flex-shrink-0 transition-colors" />
              </button>

              <p className="text-center text-[11px] text-gray-700 mt-6">
                Don&apos;t have an API key? Generate one in Trading 212 → Settings → API.
              </p>
            </div>

          ) : mode === 'password' ? (
            /* ── Site password ──────────────────────────────────────────── */
            <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 shadow-2xl">
              <div className="flex items-center gap-2 mb-1">
                <Lock className="h-4 w-4 text-gray-400" />
                <h2 className="text-base font-semibold text-white">Site Password</h2>
              </div>
              <p className="text-xs text-gray-500 mb-5">Enter the admin password to access the site.</p>
              <SitePasswordForm onSuccess={handleSuccess} />
              <button
                onClick={() => setMode('choose')}
                className="mt-4 text-xs text-gray-600 hover:text-gray-400 transition-colors"
              >
                ← Back to account selection
              </button>
            </div>

          ) : (
            /* ── T212 credential form ───────────────────────────────────── */
            (() => {
              const acc = ACCOUNTS.find(a => a.type === mode)!;
              return (
                <div className={clsx('bg-gray-900 border rounded-2xl p-6 shadow-2xl', acc.activeBorder)}>
                  {/* Header */}
                  <div className="flex items-center gap-3 mb-1">
                    <span className="text-2xl">{acc.icon}</span>
                    <div>
                      <h2 className="text-base font-semibold text-white">{acc.label}</h2>
                      <p className={clsx('text-xs', acc.color)}>{acc.sublabel}</p>
                    </div>
                  </div>

                  <p className="text-xs text-gray-500 mt-2 mb-1">
                    Enter your Trading 212 API key and secret for this account.
                  </p>

                  {/* How to get key */}
                  <details className="mb-4 group">
                    <summary className={clsx('text-xs cursor-pointer select-none list-none flex items-center gap-1 mt-2', acc.color)}>
                      <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
                      How to get an API key
                    </summary>
                    <ol className="mt-2 space-y-1.5 pl-4">
                      {(mode === 'demo'
                        ? ['Open Trading 212 app', 'Tap your account name → switch to Practice', 'Settings → API (Beta)', 'Generate key with read + order permissions']
                        : mode === 'isa'
                        ? ['Open Trading 212 app', 'Tap your account name → switch to Stocks ISA', 'Settings → API (Beta)', 'Generate key with read + order permissions']
                        : ['Open Trading 212 app or web', 'Switch to your Invest account', 'Settings → API (Beta)', 'Generate key with read + order permissions']
                      ).map((step, i) => (
                        <li key={i} className="flex items-start gap-2 text-[11px] text-gray-400">
                          <span className={clsx('flex-shrink-0 w-4 h-4 rounded-full text-[10px] font-bold flex items-center justify-center mt-0.5', acc.activeBg, acc.color)}>
                            {i + 1}
                          </span>
                          {step}
                        </li>
                      ))}
                    </ol>
                  </details>

                  <T212LoginForm accountType={mode} onSuccess={handleSuccess} />

                  <button
                    onClick={() => setMode('choose')}
                    className="mt-4 text-xs text-gray-600 hover:text-gray-400 transition-colors"
                  >
                    ← Back to account selection
                  </button>
                </div>
              );
            })()
          )}
        </div>
      </div>
    </div>
  );
}

// ── Page export ─────────────────────────────────────────────────────────────
export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

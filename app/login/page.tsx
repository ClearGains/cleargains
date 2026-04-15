'use client';

import { useState, useEffect, FormEvent, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  TrendingUp, Lock, AlertCircle, Eye, EyeOff,
  ChevronRight, CheckCircle2, Loader2, X, ArrowLeft,
} from 'lucide-react';
import { useClearGainsStore } from '@/lib/store';
import { clsx } from 'clsx';

type T212AccountType = 'demo' | 'live' | 'isa';

const ACCOUNTS = [
  {
    type: 'demo' as T212AccountType,
    label: 'Practice / Demo',
    sublabel: 'Virtual money · zero risk',
    icon: '🎮',
    accent: 'border-blue-500/40 hover:border-blue-500/70',
    pill: 'bg-blue-500/15 text-blue-300',
    btn: 'bg-blue-600 hover:bg-blue-500',
    glow: 'shadow-blue-900/30',
  },
  {
    type: 'live' as T212AccountType,
    label: 'Invest Account',
    sublabel: 'Live trading · taxable gains',
    icon: '📊',
    accent: 'border-emerald-500/40 hover:border-emerald-500/70',
    pill: 'bg-emerald-500/15 text-emerald-300',
    btn: 'bg-emerald-600 hover:bg-emerald-500',
    glow: 'shadow-emerald-900/30',
  },
  {
    type: 'isa' as T212AccountType,
    label: 'Stocks ISA',
    sublabel: 'Tax-free wrapper · live trading',
    icon: '📈',
    accent: 'border-indigo-500/40 hover:border-indigo-500/70',
    pill: 'bg-indigo-500/15 text-indigo-300',
    btn: 'bg-indigo-600 hover:bg-indigo-500',
    glow: 'shadow-indigo-900/30',
  },
];

// ── API key form ──────────────────────────────────────────────────────────────
function T212LoginForm({
  accountType,
  onSuccess,
  onBack,
}: {
  accountType: T212AccountType;
  onSuccess: () => void;
  onBack: () => void;
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
      if (!data.ok) { setError(data.error ?? 'Connection failed.'); return; }

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
      if (data.keyHashPrefix) store.setLinkedAccountId(accountType, data.keyHashPrefix);
      onSuccess();
    } catch (err) {
      setError(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Back + header */}
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-300 transition-colors mb-2">
        <ArrowLeft className="h-3.5 w-3.5" /> Back
      </button>

      <div className="flex items-center gap-3 mb-1">
        <span className="text-3xl">{acc.icon}</span>
        <div>
          <h2 className="text-lg font-bold text-white">{acc.label}</h2>
          <p className="text-xs text-gray-500">{acc.sublabel}</p>
        </div>
      </div>

      {/* How to get key */}
      <details className="group bg-gray-800/50 rounded-xl border border-gray-700/50">
        <summary className="flex items-center justify-between px-4 py-3 cursor-pointer select-none list-none text-sm text-gray-400 hover:text-gray-200 transition-colors">
          <span>How to get your API key</span>
          <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" />
        </summary>
        <ol className="px-4 pb-4 space-y-2 border-t border-gray-700/50 pt-3">
          {(accountType === 'demo'
            ? ['Open the Trading 212 app', 'Tap your name → switch to Practice account', 'Settings → API (Beta)', 'Generate key — enable read + order permissions']
            : accountType === 'isa'
            ? ['Open the Trading 212 app', 'Tap your name → switch to Stocks ISA', 'Settings → API (Beta)', 'Generate key — enable read + order permissions']
            : ['Open Trading 212 app or website', 'Switch to your Invest account', 'Settings → API (Beta)', 'Generate key — enable read + order permissions']
          ).map((step, i) => (
            <li key={i} className="flex items-start gap-3 text-xs text-gray-400">
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-gray-700 text-gray-300 font-bold flex items-center justify-center text-[10px] mt-0.5">{i + 1}</span>
              {step}
            </li>
          ))}
        </ol>
      </details>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1.5">API Key</label>
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={key}
              onChange={e => setKey(e.target.value)}
              placeholder="Paste your API key"
              autoFocus
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/20 pr-11 transition-colors"
            />
            <button type="button" onClick={() => setShowKey(v => !v)}
              className="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
              {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1.5">API Secret</label>
          <div className="relative">
            <input
              type={showSecret ? 'text' : 'password'}
              value={secret}
              onChange={e => setSecret(e.target.value)}
              placeholder="Paste your API secret"
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/20 pr-11 transition-colors"
            />
            <button type="button" onClick={() => setShowSecret(v => !v)}
              className="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
              {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2.5 bg-red-500/10 border border-red-500/25 rounded-xl px-4 py-3 text-xs text-red-400">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className={clsx(
            'w-full text-white font-semibold rounded-xl py-3 text-sm transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg',
            acc.btn, acc.glow
          )}
        >
          {loading
            ? <><Loader2 className="h-4 w-4 animate-spin" /> Connecting…</>
            : <>Connect {acc.label} <ChevronRight className="h-4 w-4" /></>
          }
        </button>
      </form>

      <p className="text-center text-[11px] text-gray-600">
        Keys are validated with T212 and stored only in your browser — never on our servers.
      </p>
    </div>
  );
}

const LOCKOUT_ATTEMPTS_KEY = 'cg_login_attempts';
const LOCKOUT_UNTIL_KEY = 'cg_login_lockout_until';
const MAX_ATTEMPTS = 3;
const LOCKOUT_DURATION_MS = 5 * 60 * 1000; // 5 minutes

function getLockoutState(): { attempts: number; lockedUntil: number | null } {
  if (typeof window === 'undefined') return { attempts: 0, lockedUntil: null };
  const attempts = parseInt(localStorage.getItem(LOCKOUT_ATTEMPTS_KEY) ?? '0', 10);
  const lockedUntilStr = localStorage.getItem(LOCKOUT_UNTIL_KEY);
  const lockedUntil = lockedUntilStr ? parseInt(lockedUntilStr, 10) : null;
  return { attempts, lockedUntil };
}

// ── Site password form ────────────────────────────────────────────────────────
function SitePasswordForm({ onSuccess, onBack }: { onSuccess: () => void; onBack: () => void }) {
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [countdown, setCountdown] = useState('');

  // Initialize lockout state from localStorage
  useEffect(() => {
    const state = getLockoutState();
    setAttempts(state.attempts);
    if (state.lockedUntil && state.lockedUntil > Date.now()) {
      setLockedUntil(state.lockedUntil);
    } else if (state.lockedUntil) {
      // Lockout expired — clear it
      localStorage.removeItem(LOCKOUT_ATTEMPTS_KEY);
      localStorage.removeItem(LOCKOUT_UNTIL_KEY);
    }
  }, []);

  // Countdown timer
  useEffect(() => {
    const interval = setInterval(() => {
      const state = getLockoutState();
      if (state.lockedUntil && state.lockedUntil > Date.now()) {
        const remaining = Math.ceil((state.lockedUntil - Date.now()) / 1000);
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        setCountdown(`${mins}:${secs.toString().padStart(2, '0')}`);
        setLockedUntil(state.lockedUntil);
      } else {
        setLockedUntil(null);
        setCountdown('');
        setAttempts(0);
      }
    }, 500);
    return () => clearInterval(interval);
  }, []);

  const isLocked = lockedUntil !== null && lockedUntil > Date.now();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (isLocked) return;
    if (!password) { setError('Please enter the site password.'); return; }
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (data.ok) {
        localStorage.removeItem(LOCKOUT_ATTEMPTS_KEY);
        localStorage.removeItem(LOCKOUT_UNTIL_KEY);
        onSuccess();
      } else {
        const newAttempts = attempts + 1;
        localStorage.setItem(LOCKOUT_ATTEMPTS_KEY, String(newAttempts));
        setAttempts(newAttempts);
        if (newAttempts >= MAX_ATTEMPTS) {
          const until = Date.now() + LOCKOUT_DURATION_MS;
          localStorage.setItem(LOCKOUT_UNTIL_KEY, String(until));
          setLockedUntil(until);
          setError(null);
        } else {
          setError(`Incorrect password. ${MAX_ATTEMPTS - newAttempts} attempt${MAX_ATTEMPTS - newAttempts !== 1 ? 's' : ''} remaining.`);
        }
      }
    } catch {
      setError('Request failed. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-300 transition-colors">
        <ArrowLeft className="h-3.5 w-3.5" /> Back
      </button>
      <div className="flex items-center gap-3 mb-1">
        <div className="w-10 h-10 rounded-xl bg-gray-800 flex items-center justify-center">
          <Lock className="h-5 w-5 text-gray-400" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-white">Site Password</h2>
          <p className="text-xs text-gray-500">Admin access only</p>
        </div>
      </div>

      {isLocked ? (
        <div className="flex flex-col items-center gap-3 py-6">
          <div className="w-14 h-14 rounded-full bg-red-500/15 flex items-center justify-center">
            <Lock className="h-7 w-7 text-red-400" />
          </div>
          <p className="text-sm text-red-400 font-semibold">Too many attempts</p>
          <p className="text-xs text-gray-500 text-center">Try again in</p>
          <p className="text-3xl font-mono font-bold text-white">{countdown}</p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              placeholder="Enter site password"
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/20 pr-11 transition-colors"
            />
            <button type="button" onClick={() => setShowPassword(v => !v)}
              className="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          {error && (
            <div className="flex items-center gap-2.5 bg-red-500/10 border border-red-500/25 rounded-xl px-4 py-3 text-xs text-red-400">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" /> {error}
            </div>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl py-3 text-sm transition-colors flex items-center justify-center gap-2"
          >
            {loading ? <><Loader2 className="h-4 w-4 animate-spin" /> Verifying…</> : 'Enter'}
          </button>
        </form>
      )}
    </div>
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
    setTimeout(() => router.replace(from), 700);
  }

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col">

      {/* Skip / close button — top-right corner */}
      <button
        onClick={() => router.replace(from)}
        className="fixed top-5 right-5 z-50 flex items-center gap-1.5 px-3 py-2 rounded-xl bg-gray-800/80 border border-gray-700 text-xs text-gray-400 hover:text-white hover:bg-gray-700 backdrop-blur-sm transition-all"
        title="Skip for now"
      >
        <X className="h-3.5 w-3.5" />
        Skip
      </button>

      {/* Vertically centred content */}
      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-[440px]">

          {/* ── Logo ────────────────────────────────────────────────────── */}
          <div className="flex items-center justify-center gap-3 mb-10">
            <div className="bg-emerald-600 rounded-2xl p-3 shadow-xl shadow-emerald-900/50">
              <TrendingUp className="h-7 w-7 text-white" />
            </div>
            <span className="text-3xl font-bold text-white tracking-tight">
              Clear<span className="text-emerald-400">Gains</span>
            </span>
          </div>

          {/* ── Card ────────────────────────────────────────────────────── */}
          <div className="bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl p-7">

            {/* Success */}
            {success ? (
              <div className="py-8 text-center space-y-3">
                <div className="w-16 h-16 rounded-full bg-emerald-500/15 flex items-center justify-center mx-auto">
                  <CheckCircle2 className="h-8 w-8 text-emerald-400" />
                </div>
                <p className="text-white font-semibold text-lg">Connected!</p>
                <p className="text-gray-500 text-sm">Redirecting you now…</p>
              </div>

            ) : mode === 'choose' ? (
              /* ── Account picker ───────────────────────────────────────── */
              <div className="space-y-5">
                <div>
                  <h1 className="text-xl font-bold text-white">Sign in to ClearGains</h1>
                  <p className="text-sm text-gray-500 mt-1">Connect your Trading 212 account to get started</p>
                </div>

                <div className="space-y-2.5">
                  {ACCOUNTS.map(acc => (
                    <button
                      key={acc.type}
                      onClick={() => setMode(acc.type)}
                      className={clsx(
                        'w-full flex items-center gap-4 bg-gray-800/60 border rounded-xl px-4 py-4 transition-all text-left group',
                        acc.accent
                      )}
                    >
                      <span className="text-2xl flex-shrink-0">{acc.icon}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-white">{acc.label}</p>
                        <p className="text-xs text-gray-500 mt-0.5">{acc.sublabel}</p>
                      </div>
                      <ChevronRight className="h-4 w-4 text-gray-600 group-hover:text-gray-300 flex-shrink-0 transition-colors" />
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-3">
                  <div className="flex-1 h-px bg-gray-800" />
                  <span className="text-xs text-gray-600">or</span>
                  <div className="flex-1 h-px bg-gray-800" />
                </div>

                <button
                  onClick={() => setMode('password')}
                  className="w-full flex items-center gap-3 bg-gray-800/40 border border-gray-700/60 hover:border-gray-600 rounded-xl px-4 py-3.5 transition-all text-left group"
                >
                  <div className="w-8 h-8 rounded-lg bg-gray-700 flex items-center justify-center flex-shrink-0">
                    <Lock className="h-4 w-4 text-gray-400" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-medium text-gray-300 group-hover:text-white transition-colors">Site Password</p>
                    <p className="text-xs text-gray-600 mt-0.5">Admin / shared access</p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-gray-600 group-hover:text-gray-400 transition-colors" />
                </button>

                <p className="text-center text-xs text-gray-600">
                  No account? Generate an API key in Trading 212 → Settings → API
                </p>
              </div>

            ) : mode === 'password' ? (
              <SitePasswordForm onSuccess={handleSuccess} onBack={() => setMode('choose')} />
            ) : (
              <T212LoginForm accountType={mode} onSuccess={handleSuccess} onBack={() => setMode('choose')} />
            )}
          </div>

          {/* Reassurance footer */}
          {!success && mode === 'choose' && (
            <p className="text-center text-xs text-gray-700 mt-6">
              Your keys are stored locally in your browser and never sent to our servers.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

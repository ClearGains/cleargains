'use client';

import { useState, useEffect, FormEvent, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { TrendingUp, Lock, AlertCircle, Eye, EyeOff, Loader2, CheckCircle2 } from 'lucide-react';

// ── Lockout constants ─────────────────────────────────────────────────────────
const ATTEMPTS_KEY   = 'cg_login_attempts';
const LOCKOUT_KEY    = 'cg_login_lockout_until';
const MAX_ATTEMPTS   = 3;
const LOCKOUT_MS     = 5 * 60 * 1000; // 5 minutes

function getLockout() {
  if (typeof window === 'undefined') return { attempts: 0, until: null as number | null };
  return {
    attempts: parseInt(localStorage.getItem(ATTEMPTS_KEY) ?? '0', 10),
    until:    parseInt(localStorage.getItem(LOCKOUT_KEY)  ?? '0', 10) || null,
  };
}

// ── Login form ────────────────────────────────────────────────────────────────
function LoginForm() {
  const searchParams = useSearchParams();
  const dest         = searchParams.get('from') ?? '/dashboard';

  const [password,     setPassword]     = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState<string | null>(null);
  const [success,      setSuccess]      = useState(false);
  const [attempts,     setAttempts]     = useState(0);
  const [lockedUntil,  setLockedUntil]  = useState<number | null>(null);
  const [countdown,    setCountdown]    = useState('');

  // Initialise lockout from localStorage
  useEffect(() => {
    const s = getLockout();
    setAttempts(s.attempts);
    if (s.until && s.until > Date.now()) {
      setLockedUntil(s.until);
    } else {
      localStorage.removeItem(ATTEMPTS_KEY);
      localStorage.removeItem(LOCKOUT_KEY);
    }
  }, []);

  // Countdown ticker
  useEffect(() => {
    const t = setInterval(() => {
      const s = getLockout();
      if (s.until && s.until > Date.now()) {
        const rem  = Math.ceil((s.until - Date.now()) / 1000);
        const mins = Math.floor(rem / 60);
        const secs = rem % 60;
        setCountdown(`${mins}:${secs.toString().padStart(2, '0')}`);
        setLockedUntil(s.until);
      } else {
        setLockedUntil(null);
        setCountdown('');
        setAttempts(0);
        localStorage.removeItem(ATTEMPTS_KEY);
        localStorage.removeItem(LOCKOUT_KEY);
      }
    }, 500);
    return () => clearInterval(t);
  }, []);

  const isLocked = !!lockedUntil && lockedUntil > Date.now();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (isLocked || !password) { if (!password) setError('Enter the site password.'); return; }
    setLoading(true); setError(null);
    try {
      const res  = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json() as { ok: boolean; error?: string };

      if (data.ok) {
        localStorage.removeItem(ATTEMPTS_KEY);
        localStorage.removeItem(LOCKOUT_KEY);
        setSuccess(true);
        setTimeout(() => { window.location.replace(dest); }, 600);
      } else {
        const next = attempts + 1;
        localStorage.setItem(ATTEMPTS_KEY, String(next));
        setAttempts(next);
        if (next >= MAX_ATTEMPTS) {
          const until = Date.now() + LOCKOUT_MS;
          localStorage.setItem(LOCKOUT_KEY, String(until));
          setLockedUntil(until);
          setError(null);
        } else {
          setError(`Incorrect password — ${MAX_ATTEMPTS - next} attempt${MAX_ATTEMPTS - next !== 1 ? 's' : ''} left.`);
        }
      }
    } catch {
      setError('Request failed — check your connection.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">

        {/* Logo */}
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="bg-emerald-600 rounded-2xl p-3 shadow-xl shadow-emerald-900/40">
            <TrendingUp className="h-7 w-7 text-white" />
          </div>
          <span className="text-3xl font-bold text-white tracking-tight">
            Clear<span className="text-emerald-400">Gains</span>
          </span>
        </div>

        {/* Card */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl p-8">

          {success ? (
            /* Success state */
            <div className="py-6 text-center space-y-3">
              <div className="w-16 h-16 rounded-full bg-emerald-500/15 flex items-center justify-center mx-auto">
                <CheckCircle2 className="h-8 w-8 text-emerald-400" />
              </div>
              <p className="text-white font-semibold text-lg">Access granted</p>
              <p className="text-gray-500 text-sm">Redirecting…</p>
            </div>

          ) : isLocked ? (
            /* Locked out state */
            <div className="py-6 text-center space-y-4">
              <div className="w-16 h-16 rounded-full bg-red-500/15 flex items-center justify-center mx-auto">
                <Lock className="h-8 w-8 text-red-400" />
              </div>
              <div>
                <p className="text-white font-semibold">Too many attempts</p>
                <p className="text-gray-500 text-sm mt-1">Try again in</p>
              </div>
              <p className="text-4xl font-mono font-bold text-white tabular-nums">{countdown}</p>
            </div>

          ) : (
            /* Password form */
            <div className="space-y-5">
              <div className="text-center">
                <div className="w-12 h-12 rounded-xl bg-gray-800 flex items-center justify-center mx-auto mb-4">
                  <Lock className="h-6 w-6 text-gray-400" />
                </div>
                <h1 className="text-lg font-bold text-white">Private Access</h1>
                <p className="text-xs text-gray-500 mt-1">Enter the site password to continue</p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-3">
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    autoFocus
                    autoComplete="current-password"
                    autoCorrect="off"
                    autoCapitalize="none"
                    placeholder="Site password"
                    className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/20 pr-11 transition-colors"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(v => !v)}
                    className="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>

                {error && (
                  <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/25 rounded-xl px-4 py-3 text-xs text-red-400">
                    <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl py-3 text-sm transition-colors flex items-center justify-center gap-2"
                >
                  {loading
                    ? <><Loader2 className="h-4 w-4 animate-spin" /> Verifying…</>
                    : 'Enter'
                  }
                </button>
              </form>
            </div>
          )}
        </div>

        <p className="text-center text-xs text-gray-700 mt-6">
          Private personal tool · Not FCA regulated · Not financial advice
        </p>
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

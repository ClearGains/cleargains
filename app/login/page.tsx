'use client';

import { useState, FormEvent, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { TrendingUp, Lock, AlertCircle, Eye, EyeOff } from 'lucide-react';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const from = searchParams.get('from') ?? '/dashboard';

  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!password) { setError('Please enter the site password.'); return; }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();

      if (data.ok) {
        router.replace(from);
      } else {
        setError(data.error ?? 'Incorrect password.');
      }
    } catch {
      setError('Request failed. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mb-8">
          <div className="bg-emerald-600 rounded-xl p-2.5">
            <TrendingUp className="h-6 w-6 text-white" />
          </div>
          <span className="text-2xl font-bold text-white">
            Clear<span className="text-emerald-400">Gains</span>
          </span>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 shadow-2xl">
          <div className="flex items-center gap-2 mb-1">
            <Lock className="h-5 w-5 text-emerald-400" />
            <h1 className="text-lg font-semibold text-white">Private Access</h1>
          </div>
          <p className="text-sm text-gray-500 mb-6">Enter the site password to continue.</p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5">
                Site Password
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                  placeholder="Enter password"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                >
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
              className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-lg py-2.5 text-sm transition-colors"
            >
              {loading ? 'Verifying...' : 'Enter'}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-gray-700 mt-6">
          ClearGains · Private instance
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

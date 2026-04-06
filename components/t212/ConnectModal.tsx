'use client';

import { useState } from 'react';
import { X, Key, ShieldCheck, AlertCircle, ExternalLink, Eye, EyeOff, CheckCircle2 } from 'lucide-react';
import { useClearGainsStore } from '@/lib/store';
import { Button } from '@/components/ui/Button';
import { clsx } from 'clsx';

interface ConnectModalProps {
  onClose: () => void;
  onConnected: () => void;
}

export function ConnectModal({ onClose, onConnected }: ConnectModalProps) {
  const { t212AccountType, setT212AccountType, setT212Credentials, setT212Connected, setT212AccountInfo } =
    useClearGainsStore();

  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<'guide' | 'credentials'>('guide');

  async function handleConnect() {
    if (!apiKey.trim() || !apiSecret.trim()) {
      setError('Both API key and secret are required.');
      return;
    }
    setTesting(true);
    setError(null);
    try {
      const res = await fetch('/api/t212/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey.trim(), apiSecret: apiSecret.trim(), accountType: t212AccountType }),
      });
      const data = await res.json();
      if (data.ok) {
        setT212Credentials(apiKey.trim(), apiSecret.trim());
        setT212AccountInfo({ id: data.accountId, currency: data.currency });
        setT212Connected(true);
        onConnected();
      } else {
        const msg = data.error ?? 'Connection failed. Check your credentials and try again.';
        const raw = data.t212Raw ? ` (T212: ${data.t212Raw})` : '';
        setError(msg + raw);
      }
    } catch {
      setError('Network error — check your connection and try again.');
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <Key className="h-5 w-5 text-emerald-400" />
            <h2 className="text-lg font-semibold text-white">Connect Trading 212</h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {step === 'guide' ? (
          <div className="px-6 py-5">
            <p className="text-sm text-gray-400 mb-5">
              You&apos;ll need a Trading 212 API key. Follow these steps to generate one:
            </p>

            <div className="space-y-3 mb-5">
              {[
                { n: 1, text: 'Open the Trading 212 app or website' },
                { n: 2, text: 'Go to Settings → API (or Profile → API Keys)' },
                { n: 3, text: 'Click "Generate API key" and set the permissions to read-only' },
                { n: 4, text: 'Copy both the API key and secret — you\'ll only see the secret once' },
              ].map(({ n, text }) => (
                <div key={n} className="flex items-start gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-emerald-600/20 text-emerald-400 text-xs font-bold flex items-center justify-center mt-0.5">
                    {n}
                  </span>
                  <p className="text-sm text-gray-300">{text}</p>
                </div>
              ))}
            </div>

            <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-4 py-3 mb-5">
              <div className="flex items-start gap-2">
                <ShieldCheck className="h-4 w-4 text-blue-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs font-semibold text-blue-400 mb-1">Your credentials are private</p>
                  <p className="text-xs text-blue-400/80">
                    Your API key and secret are stored only in your browser (localStorage). They are sent directly to
                    Trading 212 servers and never stored or logged by ClearGains.
                  </p>
                </div>
              </div>
            </div>

            <a
              href="https://helpcentre.trading212.com/hc/en-us/articles/14584769028253"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 mb-5"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              T212 help: How to generate an API key
            </a>

            <Button onClick={() => setStep('credentials')} fullWidth icon={<Key className="h-4 w-4" />}>
              I have my API key →
            </Button>
          </div>
        ) : (
          <div className="px-6 py-5">
            {/* Account type */}
            <div className="flex bg-gray-800 rounded-lg p-1 mb-4">
              {(['DEMO', 'LIVE'] as const).map((type) => (
                <button
                  key={type}
                  onClick={() => setT212AccountType(type)}
                  className={clsx(
                    'flex-1 py-1.5 rounded-md text-xs font-semibold transition-colors',
                    t212AccountType === type
                      ? type === 'LIVE'
                        ? 'bg-emerald-600 text-white'
                        : 'bg-amber-600 text-white'
                      : 'text-gray-500 hover:text-gray-300'
                  )}
                >
                  {type === 'LIVE' ? '🟢 LIVE account' : '🟡 DEMO / Practice account'}
                </button>
              ))}
            </div>

            <div className="space-y-3 mb-4">
              {/* API Key */}
              <div>
                <label className="text-xs text-gray-400 font-medium mb-1.5 block">API Key</label>
                <div className="relative">
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="Paste your T212 API key"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey(!showKey)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                  >
                    {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {/* API Secret */}
              <div>
                <label className="text-xs text-gray-400 font-medium mb-1.5 block">API Secret</label>
                <div className="relative">
                  <input
                    type={showSecret ? 'text' : 'password'}
                    value={apiSecret}
                    onChange={(e) => setApiSecret(e.target.value)}
                    placeholder="Paste your T212 API secret"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecret(!showSecret)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                  >
                    {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2.5 text-xs text-red-400 mb-4">
                <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep('guide')} size="sm">
                ← Back
              </Button>
              <Button
                onClick={handleConnect}
                loading={testing}
                fullWidth
                icon={<CheckCircle2 className="h-4 w-4" />}
              >
                {testing ? 'Verifying...' : 'Connect & Verify'}
              </Button>
            </div>

            <p className="text-xs text-gray-600 text-center mt-3">
              Credentials are tested live against Trading 212 before saving.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

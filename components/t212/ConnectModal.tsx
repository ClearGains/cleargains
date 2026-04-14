'use client';

import { useState } from 'react';
import { X, Key, ShieldCheck, AlertCircle, ExternalLink, Eye, EyeOff, CheckCircle2, Wifi } from 'lucide-react';
import { useClearGainsStore } from '@/lib/store';
import { Button } from '@/components/ui/Button';
import { clsx } from 'clsx';

interface ConnectModalProps {
  onClose: () => void;
  onConnected: () => void;
}

type Tab = 'live' | 'isa' | 'demo';

export function ConnectModal({ onClose, onConnected }: ConnectModalProps) {
  const {
    t212Connected, t212AccountInfo,
    t212DemoConnected, t212DemoAccountInfo,
    t212IsaConnected, t212IsaAccountInfo,
    setT212Credentials, setT212Connected, setT212AccountInfo,
    setT212DemoCredentials, setT212DemoConnected, setT212DemoAccountInfo,
    setT212IsaCredentials, setT212IsaConnected, setT212IsaAccountInfo,
    clearT212Credentials, clearT212DemoCredentials, clearT212IsaCredentials,
  } = useClearGainsStore();

  const [tab, setTab] = useState<Tab>('live');

  // LIVE (Invest) form state
  const [liveKey, setLiveKey] = useState('');
  const [liveSecret, setLiveSecret] = useState('');
  const [showLiveKey, setShowLiveKey] = useState(false);
  const [showLiveSecret, setShowLiveSecret] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveTesting, setLiveTesting] = useState(false);

  // ISA form state
  const [isaKey, setIsaKey] = useState('');
  const [isaSecret, setIsaSecret] = useState('');
  const [showIsaKey, setShowIsaKey] = useState(false);
  const [showIsaSecret, setShowIsaSecret] = useState(false);
  const [isaError, setIsaError] = useState<string | null>(null);
  const [isaTesting, setIsaTesting] = useState(false);

  // DEMO form state
  const [demoKey, setDemoKey] = useState('');
  const [demoSecret, setDemoSecret] = useState('');
  const [showDemoKey, setShowDemoKey] = useState(false);
  const [showDemoSecret, setShowDemoSecret] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);
  const [demoTesting, setDemoTesting] = useState(false);

  async function handleConnectLive() {
    const cleanKey = liveKey.replace(/[\s\n\r\t]/g, '');
    const cleanSecret = liveSecret.replace(/[\s\n\r\t]/g, '');
    if (!cleanKey || !cleanSecret) { setLiveError('Both API key and secret are required.'); return; }

    setLiveTesting(true);
    setLiveError(null);
    try {
      const encoded = btoa(cleanKey + ':' + cleanSecret);
      const res = await fetch('/api/t212/connect', {
        method: 'POST',
        headers: { 'x-t212-auth': encoded, 'x-t212-account-type': 'LIVE' },
      });
      const data = await res.json();
      if (data.ok) {
        setT212Credentials(cleanKey, cleanSecret);
        setT212AccountInfo({ id: data.accountId, currency: data.currency });
        setT212Connected(true);
        onConnected();
      } else {
        setLiveError(data.error ?? 'Connection failed.');
      }
    } catch (err) {
      setLiveError(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLiveTesting(false);
    }
  }

  async function handleConnectIsa() {
    const cleanKey = isaKey.replace(/[\s\n\r\t]/g, '');
    const cleanSecret = isaSecret.replace(/[\s\n\r\t]/g, '');
    if (!cleanKey || !cleanSecret) { setIsaError('Both API key and secret are required.'); return; }

    setIsaTesting(true);
    setIsaError(null);
    try {
      const encoded = btoa(cleanKey + ':' + cleanSecret);
      const res = await fetch('/api/t212/connect', {
        method: 'POST',
        headers: { 'x-t212-auth': encoded, 'x-t212-account-type': 'LIVE' },
      });
      const data = await res.json();
      if (data.ok) {
        setT212IsaCredentials(cleanKey, cleanSecret);
        setT212IsaAccountInfo({ id: data.accountId, currency: data.currency });
        setT212IsaConnected(true);
        onConnected();
      } else {
        setIsaError(data.error ?? 'Connection failed.');
      }
    } catch (err) {
      setIsaError(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsaTesting(false);
    }
  }

  async function handleConnectDemo() {
    const cleanKey = demoKey.replace(/[\s\n\r\t]/g, '');
    const cleanSecret = demoSecret.replace(/[\s\n\r\t]/g, '');
    if (!cleanKey || !cleanSecret) { setDemoError('Both API key and secret are required.'); return; }

    setDemoTesting(true);
    setDemoError(null);
    try {
      const encoded = btoa(cleanKey + ':' + cleanSecret);
      const res = await fetch('/api/t212/connect', {
        method: 'POST',
        headers: { 'x-t212-auth': encoded, 'x-t212-account-type': 'DEMO' },
      });
      const data = await res.json();
      if (data.ok) {
        setT212DemoCredentials(cleanKey, cleanSecret);
        setT212DemoAccountInfo({ id: data.accountId, currency: data.currency });
        setT212DemoConnected(true);
        onConnected();
      } else {
        setDemoError(data.error ?? 'Connection failed.');
      }
    } catch (err) {
      setDemoError(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDemoTesting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden max-h-[90vh] overflow-y-auto">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 sticky top-0 bg-gray-900 z-10">
          <div className="flex items-center gap-2">
            <Key className="h-5 w-5 text-emerald-400" />
            <h2 className="text-lg font-semibold text-white">Connect Trading 212</h2>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tab switcher */}
        <div className="flex bg-gray-800 mx-6 mt-5 rounded-lg p-1 gap-0.5">
          <button
            onClick={() => setTab('live')}
            className={clsx('flex-1 py-1.5 rounded-md text-xs font-semibold transition-colors flex items-center justify-center gap-1',
              tab === 'live' ? 'bg-emerald-600 text-white' : 'text-gray-500 hover:text-gray-300'
            )}
          >
            <span className={clsx('w-1.5 h-1.5 rounded-full', t212Connected ? 'bg-emerald-300' : 'bg-gray-500')} />
            📊 Invest
            {t212Connected && <CheckCircle2 className="h-3 w-3" />}
          </button>
          <button
            onClick={() => setTab('isa')}
            className={clsx('flex-1 py-1.5 rounded-md text-xs font-semibold transition-colors flex items-center justify-center gap-1',
              tab === 'isa' ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:text-gray-300'
            )}
          >
            <span className={clsx('w-1.5 h-1.5 rounded-full', t212IsaConnected ? 'bg-indigo-300' : 'bg-gray-500')} />
            📈 ISA
            {t212IsaConnected && <CheckCircle2 className="h-3 w-3" />}
          </button>
          <button
            onClick={() => setTab('demo')}
            className={clsx('flex-1 py-1.5 rounded-md text-xs font-semibold transition-colors flex items-center justify-center gap-1',
              tab === 'demo' ? 'bg-blue-600 text-white' : 'text-gray-500 hover:text-gray-300'
            )}
          >
            <span className={clsx('w-1.5 h-1.5 rounded-full', t212DemoConnected ? 'bg-blue-300' : 'bg-gray-500')} />
            🎮 Practice
            {t212DemoConnected && <CheckCircle2 className="h-3 w-3" />}
          </button>
        </div>

        {/* ── LIVE TAB ─────────────────────────────────────────────── */}
        {tab === 'live' && (
          <div className="px-6 py-5 space-y-4">
            {t212Connected ? (
              <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4 flex items-start gap-3">
                <Wifi className="h-5 w-5 text-emerald-400 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-emerald-400">✓ Invest Account Connected</p>
                  {t212AccountInfo && (
                    <p className="text-xs text-emerald-400/70 mt-0.5">
                      Account ID: {t212AccountInfo.id} · {t212AccountInfo.currency}
                    </p>
                  )}
                </div>
                <button
                  onClick={clearT212Credentials}
                  className="text-xs text-red-400 hover:text-red-300 transition-colors"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <>
                <div>
                  <p className="text-sm text-gray-400 mb-3">
                    Connect your <span className="text-white font-medium">Invest account</span> (standard taxable account) to copy paper trades as real orders. Uses{' '}
                    <code className="text-xs bg-gray-800 px-1 rounded">live.trading212.com</code>
                  </p>
                  <div className="space-y-3 mb-3">
                    {[
                      'Open Trading 212 → Settings → API (Beta)',
                      'Generate a new key with read + order permissions',
                      "Copy both the key and secret — secret is shown only once",
                    ].map((text, i) => (
                      <div key={i} className="flex items-start gap-3">
                        <span className="flex-shrink-0 w-5 h-5 rounded-full bg-emerald-600/20 text-emerald-400 text-xs font-bold flex items-center justify-center mt-0.5">{i + 1}</span>
                        <p className="text-sm text-gray-300">{text}</p>
                      </div>
                    ))}
                  </div>
                  <a
                    href="https://helpcentre.trading212.com/hc/en-us/articles/14584769028253"
                    target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 mb-4"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    T212 help: How to generate an API key
                  </a>
                </div>

                <div className="space-y-3">
                  <PasswordField label="Live API Key" value={liveKey} onChange={setLiveKey} show={showLiveKey} onToggleShow={() => setShowLiveKey(v => !v)} placeholder="Paste your live API key" />
                  <PasswordField label="Live API Secret" value={liveSecret} onChange={setLiveSecret} show={showLiveSecret} onToggleShow={() => setShowLiveSecret(v => !v)} placeholder="Paste your live API secret" />
                </div>

                {liveError && <ErrorBox message={liveError} />}

                <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-3">
                  <p className="text-xs text-amber-400">
                    ⚠️ Live orders use real money. ClearGains will show a confirmation before any live order is placed.
                  </p>
                </div>

                <Button onClick={handleConnectLive} loading={liveTesting} fullWidth icon={<CheckCircle2 className="h-4 w-4" />}>
                  {liveTesting ? 'Verifying...' : 'Connect Invest Account'}
                </Button>
              </>
            )}

            <SecurityNote />
          </div>
        )}

        {/* ── ISA TAB ──────────────────────────────────────────────── */}
        {tab === 'isa' && (
          <div className="px-6 py-5 space-y-4">
            {t212IsaConnected ? (
              <div className="bg-indigo-500/10 border border-indigo-500/30 rounded-xl p-4 flex items-start gap-3">
                <Wifi className="h-5 w-5 text-indigo-400 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-indigo-400">✓ Stocks ISA Account Connected</p>
                  {t212IsaAccountInfo && (
                    <p className="text-xs text-indigo-400/70 mt-0.5">
                      Account ID: {t212IsaAccountInfo.id} · {t212IsaAccountInfo.currency}
                    </p>
                  )}
                  <p className="text-xs text-indigo-400/60 mt-1">
                    Strategies set to ISA will route orders through this account. Gains inside an ISA are free of CGT and income tax.
                  </p>
                </div>
                <button
                  onClick={clearT212IsaCredentials}
                  className="text-xs text-red-400 hover:text-red-300 transition-colors"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <>
                <div>
                  <p className="text-sm text-gray-400 mb-3">
                    Connect your <span className="text-white font-medium">Stocks ISA account</span> — a separate T212 API key generated while in the ISA view. Strategies routed here trade tax-free within your{' '}
                    <span className="text-indigo-400 font-medium">£20,000 annual allowance</span>. Uses{' '}
                    <code className="text-xs bg-gray-800 px-1 rounded">live.trading212.com</code>
                  </p>
                  <p className="text-xs font-medium text-indigo-400 mb-2">How to get your ISA API key:</p>
                  <div className="space-y-2 mb-4">
                    {[
                      'Open Trading 212 → tap your account name at the top',
                      'Switch to "Stocks ISA" account',
                      'Go to Settings → API (Beta)',
                      'Generate a new key with read + order permissions',
                      'Copy both key and secret — this is your ISA key',
                    ].map((text, i) => (
                      <div key={i} className="flex items-start gap-3">
                        <span className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-600/20 text-indigo-400 text-xs font-bold flex items-center justify-center mt-0.5">{i + 1}</span>
                        <p className="text-sm text-gray-300">{text}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-3">
                  <PasswordField label="ISA API Key" value={isaKey} onChange={setIsaKey} show={showIsaKey} onToggleShow={() => setShowIsaKey(v => !v)} placeholder="Paste your Stocks ISA API key" />
                  <PasswordField label="ISA API Secret" value={isaSecret} onChange={setIsaSecret} show={showIsaSecret} onToggleShow={() => setShowIsaSecret(v => !v)} placeholder="Paste your Stocks ISA API secret" />
                </div>

                {isaError && <ErrorBox message={isaError} />}

                <div className="bg-indigo-500/10 border border-indigo-500/20 rounded-lg px-4 py-3">
                  <p className="text-xs text-indigo-400">
                    💡 ISA trades are exempt from CGT and income tax. ClearGains will tag ISA trades separately and track your £20,000 annual allowance.
                  </p>
                </div>

                <Button
                  onClick={handleConnectIsa}
                  loading={isaTesting}
                  fullWidth
                  className="bg-indigo-600 hover:bg-indigo-500"
                  icon={<CheckCircle2 className="h-4 w-4" />}
                >
                  {isaTesting ? 'Verifying...' : 'Connect ISA Account'}
                </Button>
              </>
            )}

            <SecurityNote />
          </div>
        )}

        {/* ── DEMO TAB ─────────────────────────────────────────────── */}
        {tab === 'demo' && (
          <div className="px-6 py-5 space-y-4">
            {t212DemoConnected ? (
              <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-4 flex items-start gap-3">
                <Wifi className="h-5 w-5 text-blue-400 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-blue-400">✓ Demo Account Connected</p>
                  {t212DemoAccountInfo && (
                    <p className="text-xs text-blue-400/70 mt-0.5">
                      Account ID: {t212DemoAccountInfo.id} · {t212DemoAccountInfo.currency}
                    </p>
                  )}
                  <p className="text-xs text-blue-400/60 mt-1">
                    Auto-trade will place real orders on your T212 Practice account when the strategy runs.
                  </p>
                </div>
                <button
                  onClick={clearT212DemoCredentials}
                  className="text-xs text-red-400 hover:text-red-300 transition-colors"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <>
                <div>
                  <p className="text-sm text-gray-400 mb-3">
                    Connect your <span className="text-white font-medium">Practice / Demo account</span> so the
                    auto-trader places real orders on T212 Demo — risk-free with virtual money. Uses{' '}
                    <code className="text-xs bg-gray-800 px-1 rounded">demo.trading212.com</code>
                  </p>
                  <p className="text-xs font-medium text-blue-400 mb-2">How to get your Demo API key:</p>
                  <div className="space-y-2 mb-4">
                    {[
                      'Open the Trading 212 app',
                      'Tap your account name at the top',
                      'Switch to Practice account',
                      'Go to Settings → API (Beta)',
                      'Generate a new key — this is your DEMO key',
                      'Paste the key and secret below',
                    ].map((text, i) => (
                      <div key={i} className="flex items-start gap-3">
                        <span className="flex-shrink-0 w-5 h-5 rounded-full bg-blue-600/20 text-blue-400 text-xs font-bold flex items-center justify-center mt-0.5">{i + 1}</span>
                        <p className="text-sm text-gray-300">{text}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-3">
                  <PasswordField label="Demo API Key" value={demoKey} onChange={setDemoKey} show={showDemoKey} onToggleShow={() => setShowDemoKey(v => !v)} placeholder="Paste your Practice account API key" />
                  <PasswordField label="Demo API Secret" value={demoSecret} onChange={setDemoSecret} show={showDemoSecret} onToggleShow={() => setShowDemoSecret(v => !v)} placeholder="Paste your Practice account API secret" />
                </div>

                {demoError && <ErrorBox message={demoError} />}

                <Button
                  onClick={handleConnectDemo}
                  loading={demoTesting}
                  fullWidth
                  className="bg-blue-600 hover:bg-blue-500"
                  icon={<CheckCircle2 className="h-4 w-4" />}
                >
                  {demoTesting ? 'Verifying...' : 'Connect Demo Account'}
                </Button>
              </>
            )}

            <SecurityNote />
          </div>
        )}
      </div>
    </div>
  );
}

function PasswordField({
  label, value, onChange, show, onToggleShow, placeholder,
}: {
  label: string; value: string; onChange: (v: string) => void;
  show: boolean; onToggleShow: () => void; placeholder: string;
}) {
  return (
    <div>
      <label className="text-xs text-gray-400 font-medium mb-1.5 block">{label}</label>
      <div className="relative">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 pr-10"
        />
        <button type="button" onClick={onToggleShow} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2.5 text-xs text-red-400">
      <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
      <span className="break-all">{message}</span>
    </div>
  );
}

function SecurityNote() {
  return (
    <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-4 py-3">
      <div className="flex items-start gap-2">
        <ShieldCheck className="h-4 w-4 text-blue-400 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-blue-400/80">
          Credentials are stored only in your browser (localStorage) and sent directly to Trading 212. They are never logged or stored on our servers.
        </p>
      </div>
    </div>
  );
}

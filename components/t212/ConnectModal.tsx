'use client';

import { useState } from 'react';
import { Key, ShieldCheck, AlertCircle, ExternalLink, Eye, EyeOff, CheckCircle2, Wifi, Download, X } from 'lucide-react';
import { useClearGainsStore } from '@/lib/store';
import { generateAccountId, setStoredAccountId, getStoredSyncUrl } from '@/lib/fingerprint';
import { importData, getBackupSummary } from '@/lib/backup';
import Modal from '@/components/ui/Modal';
import type { BackupFile } from '@/lib/backup';
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

  // Post-connection restore flow
  const [postConnectAccountId, setPostConnectAccountId] = useState<string | null>(null);
  const [restoreUrl, setRestoreUrl] = useState('');
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState<string | null>(null);

  async function handleRestore() {
    const url = restoreUrl.trim();
    if (!url) return;
    setRestoreLoading(true);
    setRestoreMsg(null);
    try {
      const res = await fetch('/api/sync/load?url=' + encodeURIComponent(url));
      const data = await res.json() as { ok: boolean; backup?: BackupFile; error?: string };
      if (data.ok && data.backup) {
        importData(data.backup, 'replace');
        setRestoreMsg('✓ ' + getBackupSummary(data.backup) + ' — reloading…');
        setTimeout(() => { onConnected(); window.location.reload(); }, 1200);
      } else {
        setRestoreMsg('⚠ ' + (data.error ?? 'Load failed.'));
        setRestoreLoading(false);
      }
    } catch (err) {
      setRestoreMsg('⚠ ' + (err instanceof Error ? err.message : String(err)));
      setRestoreLoading(false);
    }
  }

  async function handleRestoreByAccountId(accountId: string) {
    setRestoreLoading(true);
    setRestoreMsg(null);
    try {
      const res = await fetch('/api/sync/load?accountId=' + accountId);
      const data = await res.json() as { ok: boolean; backup?: BackupFile; error?: string };
      if (data.ok && data.backup) {
        importData(data.backup, 'replace');
        setRestoreMsg('✓ ' + getBackupSummary(data.backup) + ' — reloading…');
        setTimeout(() => { onConnected(); window.location.reload(); }, 1200);
      } else {
        // No cloud data found — skip silently, user can still paste URL
        setRestoreMsg(null);
        setRestoreLoading(false);
      }
    } catch {
      setRestoreLoading(false);
    }
  }

  // LIVE form state
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
    setLiveTesting(true); setLiveError(null);
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
        const fp = await generateAccountId(cleanKey);
        setStoredAccountId(fp);
        setPostConnectAccountId(fp);
        const savedUrl = getStoredSyncUrl(fp);
        if (savedUrl) { setRestoreUrl(savedUrl); handleRestoreByAccountId(fp); }
      } else { setLiveError(data.error ?? 'Connection failed.'); }
    } catch (err) {
      setLiveError(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally { setLiveTesting(false); }
  }

  async function handleConnectIsa() {
    const cleanKey = isaKey.replace(/[\s\n\r\t]/g, '');
    const cleanSecret = isaSecret.replace(/[\s\n\r\t]/g, '');
    if (!cleanKey || !cleanSecret) { setIsaError('Both API key and secret are required.'); return; }
    setIsaTesting(true); setIsaError(null);
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
        const fp = await generateAccountId(cleanKey);
        setStoredAccountId(fp);
        setPostConnectAccountId(fp);
        const savedUrl = getStoredSyncUrl(fp);
        if (savedUrl) { setRestoreUrl(savedUrl); handleRestoreByAccountId(fp); }
      } else { setIsaError(data.error ?? 'Connection failed.'); }
    } catch (err) {
      setIsaError(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally { setIsaTesting(false); }
  }

  async function handleConnectDemo() {
    const cleanKey = demoKey.replace(/[\s\n\r\t]/g, '');
    const cleanSecret = demoSecret.replace(/[\s\n\r\t]/g, '');
    if (!cleanKey || !cleanSecret) { setDemoError('Both API key and secret are required.'); return; }
    setDemoTesting(true); setDemoError(null);
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
        const fp = await generateAccountId(cleanKey);
        setStoredAccountId(fp);
        setPostConnectAccountId(fp);
        const savedUrl = getStoredSyncUrl(fp);
        if (savedUrl) { setRestoreUrl(savedUrl); handleRestoreByAccountId(fp); }
      } else { setDemoError(data.error ?? 'Connection failed.'); }
    } catch (err) {
      setDemoError(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally { setDemoTesting(false); }
  }

  return (
    <Modal isOpen onClose={onClose}>
        {/* ── Header ────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-600/20 flex items-center justify-center">
              <Key className="h-4 w-4 text-emerald-400" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Connect Trading 212 Accounts</h2>
              <p className="text-xs text-gray-500">Link your accounts to enable live trading</p>
            </div>
          </div>
        </div>

        {/* ── Tab switcher ──────────────────────────────────────────── */}
        <div className="px-6 pt-5">
          <div className="flex bg-gray-800 rounded-xl p-1 gap-1">
            {([
              { id: 'live' as Tab, label: '📊 Invest', connected: t212Connected,    activeClass: 'bg-emerald-600' },
              { id: 'isa'  as Tab, label: '📈 ISA',    connected: t212IsaConnected,  activeClass: 'bg-indigo-600'  },
              { id: 'demo' as Tab, label: '🎮 Practice',connected: t212DemoConnected, activeClass: 'bg-blue-600'   },
            ] as const).map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={clsx(
                  'flex-1 py-2 rounded-lg text-xs font-semibold transition-colors flex items-center justify-center gap-1.5',
                  tab === t.id ? `${t.activeClass} text-white` : 'text-gray-500 hover:text-gray-300'
                )}
              >
                {t.label}
                {t.connected && <CheckCircle2 className="h-3 w-3 opacity-80" />}
              </button>
            ))}
          </div>
        </div>

        {/* ── Tab content ───────────────────────────────────────────── */}
        <div className="px-6 py-5 space-y-4 flex-1">

          {/* LIVE */}
          {tab === 'live' && (
            <>
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
                  <button onClick={clearT212Credentials} className="text-xs text-red-400 hover:text-red-300 transition-colors flex-shrink-0">
                    Disconnect
                  </button>
                </div>
              ) : (
                <>
                  <p className="text-sm text-gray-400">
                    Connect your <span className="text-white font-medium">Invest account</span> to copy paper trades as real orders.
                    Uses <code className="text-xs bg-gray-800 px-1 py-0.5 rounded">live.trading212.com</code>
                  </p>
                  <div className="space-y-2.5">
                    {[
                      'Open Trading 212 → Settings → API (Beta)',
                      'Generate a new key with read + order permissions',
                      'Copy both the key and secret — secret is shown only once',
                    ].map((text, i) => (
                      <div key={i} className="flex items-start gap-3">
                        <span className="flex-shrink-0 w-5 h-5 rounded-full bg-emerald-600/20 text-emerald-400 text-xs font-bold flex items-center justify-center mt-0.5">{i + 1}</span>
                        <p className="text-sm text-gray-300">{text}</p>
                      </div>
                    ))}
                  </div>
                  <a href="https://helpcentre.trading212.com/hc/en-us/articles/14584769028253" target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300">
                    <ExternalLink className="h-3.5 w-3.5" /> T212 help: How to generate an API key
                  </a>
                  <div className="space-y-3">
                    <PasswordField label="Live API Key" value={liveKey} onChange={setLiveKey} show={showLiveKey} onToggleShow={() => setShowLiveKey(v => !v)} placeholder="Paste your live API key" />
                    <PasswordField label="Live API Secret" value={liveSecret} onChange={setLiveSecret} show={showLiveSecret} onToggleShow={() => setShowLiveSecret(v => !v)} placeholder="Paste your live API secret" />
                  </div>
                  {liveError && <ErrorBox message={liveError} />}
                  <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3">
                    <p className="text-xs text-amber-400">⚠️ Live orders use real money. ClearGains shows a confirmation before any live order is placed.</p>
                  </div>
                  <Button onClick={handleConnectLive} loading={liveTesting} fullWidth icon={<CheckCircle2 className="h-4 w-4" />}>
                    {liveTesting ? 'Verifying…' : 'Connect Invest Account'}
                  </Button>
                </>
              )}
              <SecurityNote />
            </>
          )}

          {/* ISA */}
          {tab === 'isa' && (
            <>
              {t212IsaConnected ? (
                <div className="bg-indigo-500/10 border border-indigo-500/30 rounded-xl p-4 flex items-start gap-3">
                  <Wifi className="h-5 w-5 text-indigo-400 flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-indigo-400">✓ Stocks ISA Connected</p>
                    {t212IsaAccountInfo && (
                      <p className="text-xs text-indigo-400/70 mt-0.5">Account ID: {t212IsaAccountInfo.id} · {t212IsaAccountInfo.currency}</p>
                    )}
                    <p className="text-xs text-indigo-400/60 mt-1">ISA strategies trade tax-free within your annual allowance.</p>
                  </div>
                  <button onClick={clearT212IsaCredentials} className="text-xs text-red-400 hover:text-red-300 transition-colors flex-shrink-0">
                    Disconnect
                  </button>
                </div>
              ) : (
                <>
                  <p className="text-sm text-gray-400">
                    Connect your <span className="text-white font-medium">Stocks ISA account</span> — trades here are exempt from CGT within your{' '}
                    <span className="text-indigo-400 font-medium">£20,000 annual allowance</span>.
                    Uses <code className="text-xs bg-gray-800 px-1 py-0.5 rounded">live.trading212.com</code>
                  </p>
                  <p className="text-xs font-medium text-indigo-400">How to get your ISA API key:</p>
                  <div className="space-y-2">
                    {[
                      'Open Trading 212 → tap your account name at the top',
                      'Switch to "Stocks ISA" account',
                      'Go to Settings → API (Beta)',
                      'Generate a new key with read + order permissions',
                    ].map((text, i) => (
                      <div key={i} className="flex items-start gap-3">
                        <span className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-600/20 text-indigo-400 text-xs font-bold flex items-center justify-center mt-0.5">{i + 1}</span>
                        <p className="text-sm text-gray-300">{text}</p>
                      </div>
                    ))}
                  </div>
                  <div className="space-y-3">
                    <PasswordField label="ISA API Key" value={isaKey} onChange={setIsaKey} show={showIsaKey} onToggleShow={() => setShowIsaKey(v => !v)} placeholder="Paste your ISA API key" />
                    <PasswordField label="ISA API Secret" value={isaSecret} onChange={setIsaSecret} show={showIsaSecret} onToggleShow={() => setShowIsaSecret(v => !v)} placeholder="Paste your ISA API secret" />
                  </div>
                  {isaError && <ErrorBox message={isaError} />}
                  <div className="bg-indigo-500/10 border border-indigo-500/20 rounded-xl px-4 py-3">
                    <p className="text-xs text-indigo-400">💡 ISA trades are CGT and income tax free. ClearGains tracks your £20,000 allowance separately.</p>
                  </div>
                  <Button onClick={handleConnectIsa} loading={isaTesting} fullWidth className="bg-indigo-600 hover:bg-indigo-500" icon={<CheckCircle2 className="h-4 w-4" />}>
                    {isaTesting ? 'Verifying…' : 'Connect ISA Account'}
                  </Button>
                </>
              )}
              <SecurityNote />
            </>
          )}

          {/* DEMO */}
          {tab === 'demo' && (
            <>
              {t212DemoConnected ? (
                <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-4 flex items-start gap-3">
                  <Wifi className="h-5 w-5 text-blue-400 flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-blue-400">✓ Practice Account Connected</p>
                    {t212DemoAccountInfo && (
                      <p className="text-xs text-blue-400/70 mt-0.5">Account ID: {t212DemoAccountInfo.id} · {t212DemoAccountInfo.currency}</p>
                    )}
                    <p className="text-xs text-blue-400/60 mt-1">Auto-trade places real orders on your T212 Practice account — risk-free virtual money.</p>
                  </div>
                  <button onClick={clearT212DemoCredentials} className="text-xs text-red-400 hover:text-red-300 transition-colors flex-shrink-0">
                    Disconnect
                  </button>
                </div>
              ) : (
                <>
                  <p className="text-sm text-gray-400">
                    Connect your <span className="text-white font-medium">Practice / Demo account</span> so the auto-trader places real orders on T212 Demo — risk-free with virtual money.
                    Uses <code className="text-xs bg-gray-800 px-1 py-0.5 rounded">demo.trading212.com</code>
                  </p>
                  <p className="text-xs font-medium text-blue-400">How to get your Demo API key:</p>
                  <div className="space-y-2">
                    {[
                      'Open the Trading 212 app',
                      'Tap your account name → switch to Practice account',
                      'Go to Settings → API (Beta)',
                      'Generate a new key — paste both key and secret below',
                    ].map((text, i) => (
                      <div key={i} className="flex items-start gap-3">
                        <span className="flex-shrink-0 w-5 h-5 rounded-full bg-blue-600/20 text-blue-400 text-xs font-bold flex items-center justify-center mt-0.5">{i + 1}</span>
                        <p className="text-sm text-gray-300">{text}</p>
                      </div>
                    ))}
                  </div>
                  <div className="space-y-3">
                    <PasswordField label="Demo API Key" value={demoKey} onChange={setDemoKey} show={showDemoKey} onToggleShow={() => setShowDemoKey(v => !v)} placeholder="Paste your Practice API key" />
                    <PasswordField label="Demo API Secret" value={demoSecret} onChange={setDemoSecret} show={showDemoSecret} onToggleShow={() => setShowDemoSecret(v => !v)} placeholder="Paste your Practice API secret" />
                  </div>
                  {demoError && <ErrorBox message={demoError} />}
                  <Button onClick={handleConnectDemo} loading={demoTesting} fullWidth className="bg-blue-600 hover:bg-blue-500" icon={<CheckCircle2 className="h-4 w-4" />}>
                    {demoTesting ? 'Verifying…' : 'Connect Practice Account'}
                  </Button>
                </>
              )}
              <SecurityNote />
            </>
          )}
        </div>

        {/* ── Post-connect restore panel ─────────────────────────── */}
        {postConnectAccountId && (
          <div className="mx-6 mb-2 p-3 bg-blue-500/10 border border-blue-500/20 rounded-xl space-y-2.5">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-blue-300">
                Restore strategies from another device?
              </p>
              <button
                onClick={() => { setPostConnectAccountId(null); onConnected(); }}
                className="text-gray-600 hover:text-gray-400"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <p className="text-[11px] text-gray-500">
              Account ID: <code className="font-mono text-gray-400">{postConnectAccountId}</code>
              {' '}— paste your sync URL to load all portfolios and strategies.
            </p>
            {restoreMsg ? (
              <p className="text-xs text-emerald-400">{restoreMsg}</p>
            ) : (
              <>
                <input
                  type="text"
                  value={restoreUrl}
                  onChange={e => setRestoreUrl(e.target.value)}
                  placeholder="Paste your sync URL here…"
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
                />
                <div className="flex gap-2">
                  <button
                    onClick={handleRestore}
                    disabled={restoreLoading || !restoreUrl.trim()}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-xs font-semibold text-white transition-colors"
                  >
                    <Download className="h-3 w-3" />
                    {restoreLoading ? 'Loading…' : 'Load Strategies'}
                  </button>
                  <button
                    onClick={() => { setPostConnectAccountId(null); onConnected(); }}
                    className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-xs font-semibold text-gray-400 hover:text-white transition-colors"
                  >
                    Start Fresh
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Footer ────────────────────────────────────────────────── */}
        <div className="mt-4 pt-4 border-t border-gray-800">
          <button
            onClick={onClose}
            className="w-full py-2.5 rounded-xl bg-gray-800 hover:bg-gray-700 border border-gray-700 text-sm font-medium text-gray-300 hover:text-white transition-colors"
          >
            Done
          </button>
        </div>
    </Modal>
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
          className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/20 pr-11 transition-colors"
        />
        <button type="button" onClick={onToggleShow} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2.5 bg-red-500/10 border border-red-500/25 rounded-xl px-4 py-3 text-xs text-red-400">
      <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
      <span className="break-all">{message}</span>
    </div>
  );
}

function SecurityNote() {
  return (
    <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl px-4 py-3 space-y-1.5">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-3.5 w-3.5 text-emerald-400 flex-shrink-0" />
        <p className="text-xs font-semibold text-emerald-400">Your credentials never leave this browser</p>
      </div>
      <ul className="text-[11px] text-gray-500 space-y-1 ml-5 list-disc leading-snug">
        <li>Stored only in your browser&apos;s localStorage — never on our servers</li>
        <li>Sent directly to Trading 212&apos;s API — ClearGains never sees the raw keys</li>
        <li>Not included in cloud sync — you must re-enter on each device</li>
        <li>For cross-device strategies, see <span className="text-emerald-400">Settings → Strategy Accounts</span></li>
      </ul>
    </div>
  );
}

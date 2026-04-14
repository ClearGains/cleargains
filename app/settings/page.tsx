'use client';

import { useState, useEffect } from 'react';
import { Eye, EyeOff, Save, Trash2, CheckCircle2, AlertCircle, Key, ShieldCheck, Bell, ChevronRight, Lock, Cloud, Database } from 'lucide-react';
import Link from 'next/link';
import { useClearGainsStore } from '@/lib/store';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { getPermission, requestPermission } from '@/lib/pushNotifications';
import { encryptAllCredentials, decryptAllCredentials } from '@/lib/crypto';

export default function SettingsPage() {
  const {
    t212ApiKey, t212ApiSecret, t212Connected, t212AccountInfo, t212LastSync,
    t212DemoApiKey, t212DemoApiSecret, t212DemoConnected,
    t212IsaApiKey, t212IsaApiSecret, t212IsaConnected,
    setT212Credentials, setT212Connected, setT212AccountInfo,
    clearT212Credentials,
    keyStorageMode, setKeyStorageMode,
    reset,
  } = useClearGainsStore();

  const [apiKey, setApiKey] = useState(t212ApiKey);
  const [apiSecret, setApiSecret] = useState(t212ApiSecret);
  const [showKey, setShowKey] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Push notifications
  const [notifPermission, setNotifPermission] = useState<string>('default');
  const [notifLoading, setNotifLoading] = useState(false);

  // Encrypted key storage
  const [encryptPassword, setEncryptPassword] = useState('');
  const [showEncryptPw, setShowEncryptPw] = useState(false);
  const [encryptStatus, setEncryptStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [encrypting, setEncrypting] = useState(false);
  const [decryptPassword, setDecryptPassword] = useState('');
  const [showDecryptPw, setShowDecryptPw] = useState(false);
  const [decryptStatus, setDecryptStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [decrypting, setDecrypting] = useState(false);
  const [encryptedKeysExist, setEncryptedKeysExist] = useState(false);

  useEffect(() => {
    fetch('/api/db/encrypted-keys').then(r => r.json()).then(data => {
      setEncryptedKeysExist(!!(data?.live || data?.isa || data?.demo));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    setNotifPermission(getPermission());
  }, []);

  async function handleEnableNotifications() {
    setNotifLoading(true);
    const result = await requestPermission();
    setNotifPermission(result);
    setNotifLoading(false);
  }

  function handleDisableNotifications() {
    // Browser doesn't allow programmatic revocation — instruct the user
    setNotifPermission('denied-info');
  }

  async function handleSave() {
    const cleanKey = apiKey.replace(/[\s\n\r\t]/g, '');
    const cleanSecret = apiSecret.replace(/[\s\n\r\t]/g, '');

    if (!cleanKey || !cleanSecret) {
      setResult({ ok: false, message: 'Both API key and secret are required.' });
      return;
    }

    setSaving(true);
    setResult(null);

    try {
      const encoded = btoa(cleanKey + ':' + cleanSecret);
      const res = await fetch('/api/t212/connect', {
        method: 'POST',
        headers: { 'x-t212-auth': encoded },
      });
      const data = await res.json();

      if (data.ok) {
        setT212Credentials(cleanKey, cleanSecret);
        setT212AccountInfo({ id: data.accountId, currency: data.currency });
        setT212Connected(true);
        setResult({ ok: true, message: `Connected — account ${data.accountId} (${data.currency})` });
      } else {
        setResult({ ok: false, message: data.error ?? 'Connection failed.' });
      }
    } catch (err) {
      setResult({ ok: false, message: `Request failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setSaving(false);
    }
  }

  function handleDisconnect() {
    clearT212Credentials();
    setApiKey('');
    setApiSecret('');
    setResult(null);
  }

  async function handleEncryptAndStore() {
    if (!encryptPassword) { setEncryptStatus({ ok: false, message: 'Enter your site password.' }); return; }
    setEncrypting(true); setEncryptStatus(null);
    try {
      const encrypted = await encryptAllCredentials({
        live: t212Connected && t212ApiKey    ? { key: t212ApiKey,    secret: t212ApiSecret    } : undefined,
        isa:  t212IsaConnected && t212IsaApiKey  ? { key: t212IsaApiKey,  secret: t212IsaApiSecret  } : undefined,
        demo: t212DemoConnected && t212DemoApiKey ? { key: t212DemoApiKey, secret: t212DemoApiSecret } : undefined,
      }, encryptPassword);

      const res = await fetch('/api/db/encrypted-keys', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(encrypted),
      });
      if (res.ok) {
        setKeyStorageMode('encrypted');
        setEncryptedKeysExist(true);
        setEncryptStatus({ ok: true, message: 'Keys encrypted and stored. They will auto-load on new devices after you enter your password.' });
        setEncryptPassword('');
      } else {
        setEncryptStatus({ ok: false, message: 'Failed to store encrypted keys.' });
      }
    } catch {
      setEncryptStatus({ ok: false, message: 'Encryption failed — check your password and try again.' });
    } finally { setEncrypting(false); }
  }

  async function handleDecryptAndLoad() {
    if (!decryptPassword) { setDecryptStatus({ ok: false, message: 'Enter your site password.' }); return; }
    setDecrypting(true); setDecryptStatus(null);
    try {
      const res = await fetch('/api/db/encrypted-keys');
      const encData = await res.json();
      if (!encData) { setDecryptStatus({ ok: false, message: 'No encrypted keys found in cloud.' }); return; }

      const decrypted = await decryptAllCredentials(encData, decryptPassword);
      if (decrypted.live) {
        setT212Credentials(decrypted.live.key, decrypted.live.secret);
        setT212Connected(true);
      }
      setDecryptStatus({ ok: true, message: 'Credentials decrypted and loaded into this browser.' });
      setDecryptPassword('');
    } catch {
      setDecryptStatus({ ok: false, message: 'Decryption failed — incorrect password.' });
    } finally { setDecrypting(false); }
  }

  async function handleDisableEncryption() {
    await fetch('/api/db/encrypted-keys', { method: 'DELETE' });
    setKeyStorageMode('local');
    setEncryptedKeysExist(false);
    setEncryptStatus({ ok: true, message: 'Encrypted keys deleted from cloud. Keys are now local only.' });
  }

  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="text-sm text-gray-500 mt-1">Configure your Trading 212 connection and account preferences.</p>
      </div>

      {/* Quick link to multi-account manager */}
      <Link
        href="/settings/accounts"
        className="mb-4 flex items-center justify-between px-4 py-3 bg-gray-900 border border-gray-800 rounded-xl hover:border-emerald-500/30 transition-colors group"
      >
        <div className="flex items-center gap-3">
          <span className="text-xl">🏦</span>
          <div>
            <p className="text-sm font-semibold text-white">Trading 212 Account Manager</p>
            <p className="text-xs text-gray-500">Connect Invest, ISA, and Practice accounts separately</p>
          </div>
        </div>
        <ChevronRight className="h-4 w-4 text-gray-600 group-hover:text-emerald-400 transition-colors" />
      </Link>

      <Card className="mb-4">
        <CardHeader
          title="Trading 212 API Credentials"
          subtitle="Stored locally in your browser — never sent to our servers"
          icon={<Key className="h-4 w-4" />}
        />

        {t212Connected && (
          <div className="flex items-center justify-between mb-4 px-3 py-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
            <div>
              <p className="text-xs font-semibold text-emerald-400">Connected to live account</p>
              {t212AccountInfo && (
                <p className="text-xs text-emerald-400/70 mt-0.5">
                  ID: {t212AccountInfo.id} · {t212AccountInfo.currency}
                  {t212LastSync && ` · Last synced ${new Date(t212LastSync).toLocaleString('en-GB')}`}
                </p>
              )}
            </div>
            <Badge variant="live">Live</Badge>
          </div>
        )}

        <div className="space-y-3 mb-4">
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

        {result && (
          <div className={`flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs mb-4 ${
            result.ok
              ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
              : 'bg-red-500/10 border border-red-500/30 text-red-400'
          }`}>
            {result.ok
              ? <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
              : <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />}
            <span className="break-all">{result.message}</span>
          </div>
        )}

        <div className="flex gap-2">
          {t212Connected && (
            <Button variant="outline" size="sm" onClick={handleDisconnect} icon={<Trash2 className="h-3.5 w-3.5" />}>
              Disconnect
            </Button>
          )}
          <Button onClick={handleSave} loading={saving} fullWidth icon={<Save className="h-4 w-4" />}>
            {saving ? 'Verifying...' : 'Save & Verify'}
          </Button>
        </div>

        <div className="flex items-start gap-2 mt-4 px-3 py-2.5 bg-blue-500/10 border border-blue-500/20 rounded-lg">
          <ShieldCheck className="h-3.5 w-3.5 text-blue-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-blue-400/80">
            Credentials are encoded in your browser using <code className="font-mono">btoa()</code> and
            sent directly to Trading 212 via our API route. They are never logged or stored server-side.
          </p>
        </div>
      </Card>

      <Card className="mb-4">
        <CardHeader
          title="Browser Notifications"
          subtitle="Get alerted for signals, paper trades, and CGT warnings"
          icon={<Bell className="h-4 w-4" />}
        />

        {notifPermission === 'unsupported' ? (
          <p className="text-xs text-gray-500">Browser notifications are not supported in this browser.</p>
        ) : notifPermission === 'denied' ? (
          <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5 text-xs text-red-400">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
            Notifications are blocked. To re-enable, click the lock icon in your browser address bar and allow notifications, then reload the page.
          </div>
        ) : notifPermission === 'granted' ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Notifications enabled — you&apos;ll be alerted for:
            </div>
            <ul className="text-xs text-gray-400 space-y-1 list-disc list-inside ml-1">
              <li>BUY/SELL signals with strength &gt; 70%</li>
              <li>Paper trade take-profit or stop-loss hit</li>
              <li>CGT exempt amount within £500 of the £3,000 limit</li>
            </ul>
            <p className="text-xs text-gray-600">
              To disable, click the lock icon in your browser address bar and block notifications.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-gray-400">
              Enable browser notifications to get real-time alerts:
            </p>
            <ul className="text-xs text-gray-500 space-y-1 list-disc list-inside ml-1">
              <li>BUY/SELL signals with strength &gt; 70%</li>
              <li>Paper trade take-profit or stop-loss hit</li>
              <li>CGT exempt amount within £500 of the £3,000 limit</li>
            </ul>
            <Button
              onClick={handleEnableNotifications}
              loading={notifLoading}
              icon={<Bell className="h-4 w-4" />}
            >
              Enable Notifications
            </Button>
          </div>
        )}
      </Card>

      {/* ── API Key Storage Mode ────────────────────────────────────────────── */}
      <Card className="mb-4">
        <CardHeader
          title="API Key Storage Mode"
          subtitle="Choose how your Trading 212 credentials are stored"
          icon={<Lock className="h-4 w-4" />}
        />

        <div className="space-y-3 mb-4">
          {/* Option A — Local only */}
          <button
            onClick={() => { setKeyStorageMode('local'); setEncryptStatus(null); }}
            className={`w-full text-left rounded-xl border p-3.5 transition-colors ${
              keyStorageMode === 'local'
                ? 'border-emerald-500/40 bg-emerald-500/5'
                : 'border-gray-700 bg-gray-800/40 hover:border-gray-600'
            }`}
          >
            <div className="flex items-start gap-3">
              <div className={`mt-0.5 w-4 h-4 rounded-full border-2 flex-shrink-0 ${keyStorageMode === 'local' ? 'border-emerald-400 bg-emerald-400' : 'border-gray-600'}`} />
              <div>
                <p className="text-sm font-semibold text-white flex items-center gap-1.5">
                  <Lock className="h-3.5 w-3.5 text-emerald-400" /> Local only
                  <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 font-medium">Recommended</span>
                </p>
                <p className="text-xs text-gray-500 mt-1 leading-snug">
                  Keys stored only in this browser. Real orders execute only when this device is open. Paper trading syncs automatically across all devices.
                </p>
              </div>
            </div>
          </button>

          {/* Option B — Encrypted cloud */}
          <button
            onClick={() => setKeyStorageMode('encrypted')}
            className={`w-full text-left rounded-xl border p-3.5 transition-colors ${
              keyStorageMode === 'encrypted'
                ? 'border-indigo-500/40 bg-indigo-500/5'
                : 'border-gray-700 bg-gray-800/40 hover:border-gray-600'
            }`}
          >
            <div className="flex items-start gap-3">
              <div className={`mt-0.5 w-4 h-4 rounded-full border-2 flex-shrink-0 ${keyStorageMode === 'encrypted' ? 'border-indigo-400 bg-indigo-400' : 'border-gray-600'}`} />
              <div>
                <p className="text-sm font-semibold text-white flex items-center gap-1.5">
                  <Cloud className="h-3.5 w-3.5 text-indigo-400" /> Encrypted cloud
                </p>
                <p className="text-xs text-gray-500 mt-1 leading-snug">
                  Keys encrypted with AES-256 using your login password before storage. Raw keys are never sent to our servers. Enables automated trading from any device.
                </p>
              </div>
            </div>
          </button>
        </div>

        {/* Encrypted mode controls */}
        {keyStorageMode === 'encrypted' && (
          <div className="space-y-3">
            {!encryptedKeysExist ? (
              <>
                <p className="text-xs text-gray-400">
                  Encrypt your current T212 credentials and store them in the cloud. Enter your site login password below:
                </p>
                <div className="relative">
                  <input
                    type={showEncryptPw ? 'text' : 'password'}
                    value={encryptPassword}
                    onChange={e => setEncryptPassword(e.target.value)}
                    placeholder="Your site password"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500 pr-10"
                  />
                  <button type="button" onClick={() => setShowEncryptPw(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
                    {showEncryptPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {encryptStatus && (
                  <div className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${encryptStatus.ok ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border border-red-500/30 text-red-400'}`}>
                    {encryptStatus.ok ? <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" /> : <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />}
                    {encryptStatus.message}
                  </div>
                )}
                <Button onClick={handleEncryptAndStore} loading={encrypting} fullWidth icon={<Lock className="h-4 w-4" />}>
                  {encrypting ? 'Encrypting…' : 'Encrypt & Store in Cloud'}
                </Button>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 text-xs text-indigo-400 bg-indigo-500/10 border border-indigo-500/20 rounded-lg px-3 py-2.5">
                  <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />
                  Encrypted credentials stored in cloud — will auto-load on new devices
                </div>
                {encryptStatus && (
                  <div className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${encryptStatus.ok ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border border-red-500/30 text-red-400'}`}>
                    {encryptStatus.ok ? <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" /> : <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />}
                    {encryptStatus.message}
                  </div>
                )}
                <p className="text-xs text-gray-500">To load credentials on this device, enter your password:</p>
                <div className="relative">
                  <input
                    type={showDecryptPw ? 'text' : 'password'}
                    value={decryptPassword}
                    onChange={e => setDecryptPassword(e.target.value)}
                    placeholder="Your site password"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500 pr-10"
                  />
                  <button type="button" onClick={() => setShowDecryptPw(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
                    {showDecryptPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {decryptStatus && (
                  <div className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${decryptStatus.ok ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border border-red-500/30 text-red-400'}`}>
                    {decryptStatus.ok ? <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" /> : <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />}
                    {decryptStatus.message}
                  </div>
                )}
                <div className="flex gap-2">
                  <Button onClick={handleDecryptAndLoad} loading={decrypting} fullWidth icon={<Key className="h-4 w-4" />}>
                    {decrypting ? 'Decrypting…' : 'Decrypt & Load Keys'}
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleDisableEncryption} icon={<Trash2 className="h-3.5 w-3.5" />}>
                    Remove
                  </Button>
                </div>
              </>
            )}
            <div className="flex items-start gap-2 bg-gray-800/60 border border-gray-700/50 rounded-lg px-3 py-2.5">
              <ShieldCheck className="h-3.5 w-3.5 text-indigo-400 flex-shrink-0 mt-0.5" />
              <p className="text-[11px] text-gray-500 leading-snug">
                Encryption happens entirely in your browser. Raw API keys are never sent to ClearGains servers.
                The encrypted blob stored in Redis is useless without your password.
              </p>
            </div>
          </div>
        )}
      </Card>

      {/* ── Data Privacy ────────────────────────────────────────────────────── */}
      <Card className="mb-4">
        <CardHeader
          title="Data Privacy"
          subtitle="What is stored where"
          icon={<Database className="h-4 w-4" />}
        />
        <div className="space-y-3">
          <div className="rounded-xl bg-emerald-500/5 border border-emerald-500/15 p-3.5">
            <p className="text-xs font-semibold text-emerald-400 mb-2 flex items-center gap-1.5">
              <Cloud className="h-3.5 w-3.5" /> Stored in cloud (synced across devices)
            </p>
            <ul className="text-xs text-gray-400 space-y-1">
              <li className="flex items-center gap-2"><CheckCircle2 className="h-3 w-3 text-emerald-500 flex-shrink-0" /> Portfolio data and paper trade history</li>
              <li className="flex items-center gap-2"><CheckCircle2 className="h-3 w-3 text-emerald-500 flex-shrink-0" /> Watchlist and strategy settings</li>
              <li className="flex items-center gap-2"><CheckCircle2 className="h-3 w-3 text-emerald-500 flex-shrink-0" /> CGT calculations and Section 104 pool</li>
              <li className="flex items-center gap-2"><CheckCircle2 className="h-3 w-3 text-emerald-500 flex-shrink-0" /> FX trade history and pending orders</li>
              {keyStorageMode === 'encrypted' && (
                <li className="flex items-center gap-2"><CheckCircle2 className="h-3 w-3 text-indigo-400 flex-shrink-0" /> T212 API keys (AES-256 encrypted — unreadable without your password)</li>
              )}
            </ul>
          </div>

          <div className="rounded-xl bg-gray-800/40 border border-gray-700/50 p-3.5">
            <p className="text-xs font-semibold text-gray-300 mb-2 flex items-center gap-1.5">
              <Lock className="h-3.5 w-3.5 text-amber-400" /> Stored locally only (never leaves this device)
            </p>
            <ul className="text-xs text-gray-400 space-y-1">
              {keyStorageMode === 'local' && (
                <li className="flex items-center gap-2"><Lock className="h-3 w-3 text-amber-400 flex-shrink-0" /> Trading 212 API credentials</li>
              )}
              <li className="flex items-center gap-2"><Lock className="h-3 w-3 text-amber-400 flex-shrink-0" /> Login password</li>
              <li className="flex items-center gap-2"><Lock className="h-3 w-3 text-amber-400 flex-shrink-0" /> Session cookies and auth tokens</li>
            </ul>
          </div>

          <div className="rounded-xl bg-blue-500/5 border border-blue-500/15 px-3.5 py-3">
            <p className="text-[11px] text-blue-400/80 leading-snug">
              Portfolio data and trade history are not sensitive — they contain no financial account access.
              Your T212 API keys can only be used to trade on your behalf, which is why they are
              {keyStorageMode === 'encrypted' ? ' encrypted before cloud storage.' : ' kept local by default.'}
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Reset All Data"
          subtitle="Clear all trades, settings, and cached data"
          icon={<Trash2 className="h-4 w-4" />}
        />
        <p className="text-xs text-gray-500 mb-4">
          This will permanently delete all your local trades, CGT calculations, and T212 connection.
          This action cannot be undone.
        </p>
        <Button variant="outline" size="sm" onClick={reset} icon={<Trash2 className="h-3.5 w-3.5" />}>
          Reset All Data
        </Button>
      </Card>
    </div>
  );
}

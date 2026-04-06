'use client';

import { useState, useEffect } from 'react';
import { Eye, EyeOff, Save, Trash2, CheckCircle2, AlertCircle, Key, ShieldCheck, Bell, BellOff } from 'lucide-react';
import { useClearGainsStore } from '@/lib/store';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { getPermission, subscribeToPush, unsubscribeFromPush, registerServiceWorker } from '@/lib/pushNotifications';

export default function SettingsPage() {
  const {
    t212ApiKey,
    t212ApiSecret,
    t212Connected,
    t212AccountInfo,
    t212LastSync,
    setT212Credentials,
    setT212Connected,
    setT212AccountInfo,
    clearT212Credentials,
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

  useEffect(() => {
    registerServiceWorker();
    setNotifPermission(getPermission());
  }, []);

  async function handleEnableNotifications() {
    setNotifLoading(true);
    const sub = await subscribeToPush();
    setNotifPermission(getPermission());
    setNotifLoading(false);
    if (!sub) setNotifPermission(Notification.permission);
  }

  async function handleDisableNotifications() {
    setNotifLoading(true);
    await unsubscribeFromPush();
    setNotifPermission(getPermission());
    setNotifLoading(false);
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

  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="text-sm text-gray-500 mt-1">Configure your Trading 212 connection and account preferences.</p>
      </div>

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
          <p className="text-xs text-gray-500">Push notifications are not supported in this browser.</p>
        ) : notifPermission === 'denied' ? (
          <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5 text-xs text-red-400">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
            Notifications are blocked. Please allow them in your browser&apos;s site settings, then reload.
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
            <Button
              variant="outline"
              size="sm"
              onClick={handleDisableNotifications}
              loading={notifLoading}
              icon={<BellOff className="h-3.5 w-3.5" />}
            >
              Disable Notifications
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-gray-400">
              Enable browser push notifications to get real-time alerts:
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

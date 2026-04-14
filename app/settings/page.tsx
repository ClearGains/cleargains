'use client';

import { useState, useEffect, useRef } from 'react';
import {
  Eye, EyeOff, Save, Trash2, CheckCircle2, AlertCircle, Key, ShieldCheck,
  Bell, ChevronRight, Download, Upload, Database, X, FileText, Info,
} from 'lucide-react';
import Link from 'next/link';
import { useClearGainsStore } from '@/lib/store';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { getPermission, requestPermission } from '@/lib/pushNotifications';
import Modal from '@/components/ui/Modal';
import {
  exportData,
  importData,
  getBackupSummary,
  getLastBackupDate,
  getLastImportDate,
  recordBackup,
  recordImport,
  shouldShowBackupReminder,
  dismissBackupReminder,
  daysSinceBackup,
  formatBackupDate,
  type BackupFile,
} from '@/lib/backup';

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

  // Backup / restore state
  const [lastBackup, setLastBackup] = useState<string | null>(null);
  const [lastImport, setLastImport] = useState<string | null>(null);
  const [showBanner, setShowBanner] = useState(false);
  const [daysSince, setDaysSince] = useState<number | null>(null);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  // Import modal
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importPreview, setImportPreview] = useState<BackupFile | null>(null);
  const [importSummary, setImportSummary] = useState<string>('');
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setNotifPermission(getPermission());
    setLastBackup(getLastBackupDate());
    setLastImport(getLastImportDate());
    setShowBanner(shouldShowBackupReminder());
    setDaysSince(daysSinceBackup());
  }, []);

  async function handleEnableNotifications() {
    setNotifLoading(true);
    const r = await requestPermission();
    setNotifPermission(r);
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

  // ── Export ──────────────────────────────────────────────────────────────────

  function handleExport() {
    try {
      const backup = exportData();
      const json = JSON.stringify(backup, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const dateStr = new Date().toISOString().slice(0, 10);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cleargains-backup-${dateStr}.json`;
      a.click();
      URL.revokeObjectURL(url);

      recordBackup();
      const now = new Date().toISOString();
      setLastBackup(now);
      setShowBanner(false);
      setDaysSince(0);
      setExportMsg('Backup saved — transfer this file to your other device');
      setTimeout(() => setExportMsg(null), 6000);
    } catch (err) {
      setExportMsg(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Import ──────────────────────────────────────────────────────────────────

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError(null);
    setImportPreview(null);

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string) as BackupFile;
        if (!parsed.version || !parsed.data || !parsed.exportedAt) {
          setImportError('This does not appear to be a valid ClearGains backup file.');
          return;
        }
        setImportPreview(parsed);
        setImportSummary(getBackupSummary(parsed));
        setImportModalOpen(true);
      } catch {
        setImportError('Could not parse the file. Make sure it is a valid JSON backup.');
      }
    };
    reader.readAsText(file);
    // Reset input so the same file can be selected again if needed
    e.target.value = '';
  }

  function handleConfirmImport() {
    if (!importPreview) return;
    setImporting(true);
    try {
      importData(importPreview, importMode);
      recordImport();
      setImportModalOpen(false);
      // Reload to hydrate new data into Zustand
      setTimeout(() => window.location.reload(), 400);
    } catch (err) {
      setImportError(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
      setImporting(false);
    }
  }

  function handleDismissBanner() {
    dismissBackupReminder();
    setShowBanner(false);
  }

  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="text-sm text-gray-500 mt-1">Configure your Trading 212 connection and account preferences.</p>
      </div>

      {/* Auto-backup reminder banner */}
      {showBanner && (
        <div className="mb-4 flex items-center justify-between gap-3 px-4 py-3 bg-amber-500/10 border border-amber-500/30 rounded-xl">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="text-base flex-shrink-0">💾</span>
            <p className="text-xs text-amber-300">
              {daysSince === null
                ? "You haven't backed up your data yet — consider exporting it below."
                : `Last backup was ${daysSince} day${daysSince !== 1 ? 's' : ''} ago — consider exporting your data.`}
            </p>
          </div>
          <button
            onClick={handleDismissBanner}
            className="flex-shrink-0 text-gray-500 hover:text-gray-300 transition-colors"
            title="Dismiss for 7 days"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

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

      {/* ── Data & Backup ──────────────────────────────────────────────────────── */}
      <Card className="mb-4">
        <CardHeader
          title="Data &amp; Backup"
          subtitle="Export your data to transfer to another device or keep a local backup"
          icon={<Database className="h-4 w-4" />}
        />

        {/* Credentials note */}
        <div className="flex items-start gap-2 mb-4 px-3 py-2.5 bg-amber-500/10 border border-amber-500/20 rounded-lg">
          <Info className="h-3.5 w-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-amber-400/80">
            Your Trading 212 API keys are <strong>not</strong> included in the backup for security. You will need to re-enter them on any new device.
          </p>
        </div>

        {/* Backup history */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="px-3 py-2.5 bg-gray-800/60 border border-gray-700 rounded-lg">
            <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wide mb-1">Last exported</p>
            <p className="text-xs text-gray-300">
              {lastBackup ? formatBackupDate(lastBackup) : 'Never'}
            </p>
          </div>
          <div className="px-3 py-2.5 bg-gray-800/60 border border-gray-700 rounded-lg">
            <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wide mb-1">Last imported</p>
            <p className="text-xs text-gray-300">
              {lastImport ? formatBackupDate(lastImport) : 'Never'}
            </p>
          </div>
        </div>

        {/* Export success / error message */}
        {exportMsg && (
          <div className="flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs mb-4 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
            <span>{exportMsg}</span>
          </div>
        )}

        {/* Import error (file pick stage) */}
        {importError && !importModalOpen && (
          <div className="flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs mb-4 bg-red-500/10 border border-red-500/30 text-red-400">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
            <span>{importError}</span>
          </div>
        )}

        <div className="flex gap-2">
          <Button
            onClick={handleExport}
            fullWidth
            icon={<Download className="h-4 w-4" />}
          >
            Export All Data
          </Button>

          <Button
            variant="outline"
            fullWidth
            onClick={() => fileInputRef.current?.click()}
            icon={<Upload className="h-4 w-4" />}
          >
            Import Data
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleFileSelect}
          />
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

      {/* ── Import confirmation modal ─────────────────────────────────────────── */}
      <Modal
        isOpen={importModalOpen}
        onClose={() => { setImportModalOpen(false); setImportPreview(null); setImportError(null); }}
        title="Import Backup"
      >
        {importPreview && (
          <div className="space-y-4">
            {/* Summary */}
            <div className="flex items-start gap-2 px-3 py-2.5 bg-blue-500/10 border border-blue-500/20 rounded-lg">
              <FileText className="h-3.5 w-3.5 text-blue-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-semibold text-blue-300">{importSummary}</p>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  Exported {formatBackupDate(importPreview.exportedAt)}
                </p>
              </div>
            </div>

            {/* Credentials note */}
            <div className="flex items-start gap-2 px-3 py-2.5 bg-amber-500/10 border border-amber-500/20 rounded-lg">
              <Info className="h-3.5 w-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-400/80">
                API keys are not included in backups. You will need to reconnect your Trading 212 accounts after importing.
              </p>
            </div>

            {/* Mode selector */}
            <div className="space-y-2">
              <p className="text-xs font-medium text-gray-400">How would you like to import?</p>

              <button
                onClick={() => setImportMode('merge')}
                className={`w-full text-left px-3 py-3 rounded-lg border transition-colors ${
                  importMode === 'merge'
                    ? 'border-emerald-500/50 bg-emerald-500/10'
                    : 'border-gray-700 bg-gray-800/60 hover:border-gray-600'
                }`}
              >
                <p className={`text-xs font-semibold ${importMode === 'merge' ? 'text-emerald-400' : 'text-white'}`}>
                  Merge with existing data
                </p>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  Adds imported portfolios, trades, and watchlist items without deleting your current data. Duplicate entries are skipped.
                </p>
              </button>

              <button
                onClick={() => setImportMode('replace')}
                className={`w-full text-left px-3 py-3 rounded-lg border transition-colors ${
                  importMode === 'replace'
                    ? 'border-red-500/50 bg-red-500/10'
                    : 'border-gray-700 bg-gray-800/60 hover:border-gray-600'
                }`}
              >
                <p className={`text-xs font-semibold ${importMode === 'replace' ? 'text-red-400' : 'text-white'}`}>
                  Replace all data
                </p>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  Clears all existing portfolios, trades, and settings, then imports fresh from the backup. Cannot be undone.
                </p>
              </button>
            </div>

            {importError && (
              <div className="flex items-start gap-2 px-3 py-2.5 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-400">
                <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                <span>{importError}</span>
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <Button
                variant="outline"
                fullWidth
                onClick={() => { setImportModalOpen(false); setImportPreview(null); setImportError(null); }}
              >
                Cancel
              </Button>
              <Button
                fullWidth
                loading={importing}
                onClick={handleConfirmImport}
                icon={<Upload className="h-4 w-4" />}
              >
                {importing ? 'Importing…' : `Confirm ${importMode === 'replace' ? 'Replace' : 'Merge'}`}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

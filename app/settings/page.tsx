'use client';

import { useState, useEffect, useRef } from 'react';
import {
  Eye, EyeOff, Save, Trash2, CheckCircle2, AlertCircle, Key, ShieldCheck,
  Bell, ChevronRight, Download, Upload, Database, X, FileText, Info,
  Cloud, Link2, Copy, QrCode, Fingerprint, Zap, RefreshCw, ToggleLeft, ToggleRight,
} from 'lucide-react';
import Link from 'next/link';
import { useClearGainsStore } from '@/lib/store';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { getPermission, requestPermission } from '@/lib/pushNotifications';
import Modal from '@/components/ui/Modal';
import {
  exportData, importData, getBackupSummary,
  getLastBackupDate, getLastImportDate, recordBackup, recordImport,
  shouldShowBackupReminder, dismissBackupReminder, daysSinceBackup, formatBackupDate,
  getStrategyProfiles, deleteStrategyProfile,
  type BackupFile, type StrategyProfile,
} from '@/lib/backup';
import {
  generateAccountId, setStoredAccountId, getStoredAccountId,
  getStoredSyncUrl, setStoredSyncUrl,
} from '@/lib/fingerprint';

// ── Google Charts QR (no package needed) ─────────────────────────────────────
function QRImage({ value, size = 200 }: { value: string; size?: number }) {
  return (
    <img
      src={`https://chart.googleapis.com/chart?chs=${size}x${size}&cht=qr&chl=${encodeURIComponent(value)}&choe=UTF-8`}
      alt="QR code"
      width={size}
      height={size}
      className="rounded-lg"
    />
  );
}

// ── Relative time helper ──────────────────────────────────────────────────────
function relativeTime(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export default function SettingsPage() {
  const {
    t212ApiKey, t212ApiSecret, t212Connected, t212AccountInfo, t212LastSync,
    setT212Credentials, setT212Connected, setT212AccountInfo, clearT212Credentials,
    syncStatus, syncLastSaved, autoSaveEnabled,
    setSyncStatus, setSyncLastSaved, setAutoSaveEnabled,
    reset,
  } = useClearGainsStore();

  const [apiKey, setApiKey] = useState(t212ApiKey);
  const [apiSecret, setApiSecret] = useState(t212ApiSecret);
  const [showKey, setShowKey] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Notifications
  const [notifPermission, setNotifPermission] = useState<string>('default');
  const [notifLoading, setNotifLoading] = useState(false);

  // Account fingerprint
  const [accountId, setAccountId] = useState<string | null>(null);
  const [showWelcomeBanner, setShowWelcomeBanner] = useState(false);
  const [copiedId, setCopiedId] = useState(false);

  // Cloud sync
  const [syncUrl, setSyncUrl] = useState('');
  const [cloudSaving, setCloudSaving] = useState(false);
  const [cloudLoadInput, setCloudLoadInput] = useState('');
  const [cloudLoadLoading, setCloudLoadLoading] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [cloudMsg, setCloudMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [now, setNow] = useState(Date.now());

  // Local backup
  const [lastBackup, setLastBackup] = useState<string | null>(null);
  const [lastImport, setLastImport] = useState<string | null>(null);
  const [showBanner, setShowBanner] = useState(false);
  const [daysSince, setDaysSince] = useState<number | null>(null);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  // Strategy profiles
  const [profiles, setProfiles] = useState<StrategyProfile[]>([]);

  // Import modal
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importPreview, setImportPreview] = useState<BackupFile | null>(null);
  const [importSummary, setImportSummary] = useState<string>('');
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Tick every 30 s for "X minutes ago" display
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    setNotifPermission(getPermission());
    setLastBackup(getLastBackupDate());
    setLastImport(getLastImportDate());
    setShowBanner(shouldShowBackupReminder());
    setDaysSince(daysSinceBackup());
    setProfiles(getStrategyProfiles());

    const storedId = getStoredAccountId();
    setAccountId(storedId);
    if (storedId) {
      const url = getStoredSyncUrl(storedId);
      if (url) {
        setSyncUrl(url);
        if (!getLastImportDate()) setShowWelcomeBanner(true);
      }
    }
    void now; // suppress unused warning
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleEnableNotifications() {
    setNotifLoading(true);
    const r = await requestPermission();
    setNotifPermission(r);
    setNotifLoading(false);
  }

  // ── T212 connect ───────────────────────────────────────────────────────────
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
        localStorage.setItem('t212_invest_credentials', JSON.stringify({ key: cleanKey, secret: cleanSecret }));
        setResult({ ok: true, message: `Connected — account ${data.accountId} (${data.currency})` });
        const fp = await generateAccountId(cleanKey);
        setStoredAccountId(fp);
        setAccountId(fp);
        const savedUrl = getStoredSyncUrl(fp);
        if (savedUrl) { setSyncUrl(savedUrl); setShowWelcomeBanner(true); }
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
    localStorage.removeItem('t212_invest_credentials');
    setApiKey('');
    setApiSecret('');
    setResult(null);
  }

  // ── Cloud save ─────────────────────────────────────────────────────────────
  async function handleSaveToCloud() {
    setCloudSaving(true);
    setCloudMsg(null);
    setSyncStatus('saving');
    try {
      const backup = exportData();
      const res = await fetch('/api/sync/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backup, accountId: accountId ?? undefined }),
      });
      const data = await res.json() as { ok: boolean; syncUrl?: string; error?: string };
      if (data.ok && data.syncUrl) {
        const url = data.syncUrl;
        setSyncUrl(url);
        if (accountId) setStoredSyncUrl(accountId, url);
        recordBackup();
        const now = new Date().toISOString();
        setLastBackup(now);
        setSyncLastSaved(now);
        setSyncStatus('saved');
        setShowBanner(false);
        setDaysSince(0);
        setCloudMsg({ ok: true, text: 'Strategies saved to cloud!' });
        setShowQr(true);
        setTimeout(() => setSyncStatus('idle'), 8000);
      } else {
        setSyncStatus('error');
        setCloudMsg({ ok: false, text: data.error ?? 'Upload failed.' });
      }
    } catch (err) {
      setSyncStatus('error');
      setCloudMsg({ ok: false, text: `Upload failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setCloudSaving(false);
    }
  }

  // ── Cloud load ─────────────────────────────────────────────────────────────
  async function handleLoadFromCloud() {
    const url = cloudLoadInput.trim();
    if (!url) return;
    setCloudLoadLoading(true);
    setCloudMsg(null);
    try {
      const res = await fetch('/api/sync/download?url=' + encodeURIComponent(url));
      const data = await res.json() as { ok: boolean; backup?: BackupFile; error?: string };
      if (data.ok && data.backup) {
        setImportPreview(data.backup);
        setImportSummary(getBackupSummary(data.backup));
        setImportModalOpen(true);
      } else {
        setCloudMsg({ ok: false, text: data.error ?? 'Load failed.' });
      }
    } catch (err) {
      setCloudMsg({ ok: false, text: `Load failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setCloudLoadLoading(false);
    }
  }

  // ── Welcome-back restore ───────────────────────────────────────────────────
  async function handleWelcomeRestore() {
    if (!accountId) return;
    setCloudLoadLoading(true);
    try {
      const res = await fetch('/api/sync/download?accountId=' + accountId);
      const data = await res.json() as { ok: boolean; backup?: BackupFile; error?: string };
      if (data.ok && data.backup) {
        setImportPreview(data.backup);
        setImportSummary(getBackupSummary(data.backup));
        setImportModalOpen(true);
        setShowWelcomeBanner(false);
      } else if (syncUrl) {
        // Fall back to stored URL
        const res2 = await fetch('/api/sync/download?url=' + encodeURIComponent(syncUrl));
        const data2 = await res2.json() as { ok: boolean; backup?: BackupFile; error?: string };
        if (data2.ok && data2.backup) {
          setImportPreview(data2.backup);
          setImportSummary(getBackupSummary(data2.backup));
          setImportModalOpen(true);
          setShowWelcomeBanner(false);
        } else {
          setShowWelcomeBanner(false);
        }
      } else {
        setShowWelcomeBanner(false);
      }
    } catch {
      setShowWelcomeBanner(false);
    } finally {
      setCloudLoadLoading(false);
    }
  }

  // ── Local export / import ──────────────────────────────────────────────────
  function handleExport() {
    try {
      const backup = exportData();
      const json = JSON.stringify(backup, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const dateStr = new Date().toISOString().slice(0, 10);
      const filename = accountId
        ? `cleargains-account-${accountId}-${dateStr}.json`
        : `cleargains-backup-${dateStr}.json`;
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      recordBackup();
      setLastBackup(new Date().toISOString());
      setShowBanner(false);
      setDaysSince(0);
      setExportMsg('Backup saved — transfer this file to your other device');
      setTimeout(() => setExportMsg(null), 6000);
    } catch (err) {
      setExportMsg(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError(null);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string) as BackupFile;
        if (!parsed.version || !parsed.data || !parsed.exportedAt) {
          setImportError('Not a valid ClearGains backup file.');
          return;
        }
        setImportPreview(parsed);
        setImportSummary(getBackupSummary(parsed));
        setImportModalOpen(true);
      } catch {
        setImportError('Could not parse the file — ensure it is a valid JSON backup.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function handleConfirmImport() {
    if (!importPreview) return;
    setImporting(true);
    try {
      importData(importPreview, importMode);
      recordImport();
      setImportModalOpen(false);
      setShowWelcomeBanner(false);
      setTimeout(() => window.location.reload(), 400);
    } catch (err) {
      setImportError(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
      setImporting(false);
    }
  }

  async function handleCopy(text: string, setCopied: (v: boolean) => void) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }

  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="text-sm text-gray-500 mt-1">Configure your Trading 212 connection and account preferences.</p>
      </div>

      {/* Welcome-back banner */}
      {showWelcomeBanner && (
        <div className="mb-4 px-4 py-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <Zap className="h-4 w-4 text-emerald-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-semibold text-emerald-400">
                  Welcome back — account <code className="font-mono">{accountId}</code> recognised
                </p>
                <p className="text-xs text-emerald-400/70 mt-0.5">
                  Your strategy data was found. Restore it now?
                </p>
              </div>
            </div>
            <button onClick={() => setShowWelcomeBanner(false)} className="text-gray-600 hover:text-gray-400">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex gap-2 mt-3">
            <Button size="sm" loading={cloudLoadLoading} onClick={handleWelcomeRestore} icon={<Download className="h-3.5 w-3.5" />}>
              Restore Strategies
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowWelcomeBanner(false)}>Skip</Button>
          </div>
        </div>
      )}

      {/* Auto-backup reminder */}
      {showBanner && (
        <div className="mb-4 flex items-center justify-between gap-3 px-4 py-3 bg-amber-500/10 border border-amber-500/30 rounded-xl">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="text-base flex-shrink-0">💾</span>
            <p className="text-xs text-amber-300">
              {daysSince === null
                ? "You haven't backed up yet — save your strategies below."
                : `Last backup was ${daysSince} day${daysSince !== 1 ? 's' : ''} ago.`}
            </p>
          </div>
          <button onClick={() => { dismissBackupReminder(); setShowBanner(false); }} className="flex-shrink-0 text-gray-500 hover:text-gray-300">
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

      {/* ── T212 Credentials ──────────────────────────────────────────────────── */}
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
              <button type="button" onClick={() => setShowKey(!showKey)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
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
              <button type="button" onClick={() => setShowSecret(!showSecret)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
                {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>

        {result && (
          <div className={`flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs mb-4 ${result.ok ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border border-red-500/30 text-red-400'}`}>
            {result.ok ? <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" /> : <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />}
            <span className="break-all">{result.message}</span>
          </div>
        )}

        <div className="flex gap-2">
          {t212Connected && (
            <Button variant="outline" size="sm" onClick={handleDisconnect} icon={<Trash2 className="h-3.5 w-3.5" />}>Disconnect</Button>
          )}
          <Button onClick={handleSave} loading={saving} fullWidth icon={<Save className="h-4 w-4" />}>
            {saving ? 'Verifying...' : 'Save & Verify'}
          </Button>
        </div>

        <div className="flex items-start gap-2 mt-4 px-3 py-2.5 bg-blue-500/10 border border-blue-500/20 rounded-lg">
          <ShieldCheck className="h-3.5 w-3.5 text-blue-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-blue-400/80">
            Credentials are encoded in your browser using <code className="font-mono">btoa()</code> and sent directly to Trading 212. Never logged or stored server-side.
          </p>
        </div>
      </Card>

      {/* ── Strategy Accounts ─────────────────────────────────────────────────── */}
      <div id="strategy-accounts">
      <Card className="mb-4">
        <CardHeader
          title="Strategy Accounts"
          subtitle="Save and restore all your portfolios, strategies, and trade history across devices"
          icon={<Cloud className="h-4 w-4" />}
        />

        {/* Concept explanation */}
        <div className="mb-4 px-3 py-3 bg-gray-800/50 border border-gray-700 rounded-lg">
          <p className="text-xs text-gray-300 leading-relaxed">
            Your strategies are saved to your <span className="text-white font-medium">Account ID</span> — a unique code generated from your API key.
            Enter the same API key on any device to instantly load all your strategies and portfolios.
          </p>
        </div>

        {/* Account ID */}
        {accountId ? (
          <div className="mb-4 flex items-center gap-2 px-3 py-2.5 bg-gray-800/60 border border-gray-700 rounded-lg">
            <Fingerprint className="h-3.5 w-3.5 text-gray-500 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <span className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">Your Account ID </span>
              <code className="text-sm text-white font-mono">{accountId}</code>
            </div>
            <button
              onClick={() => handleCopy(accountId, setCopiedId)}
              className="flex-shrink-0 text-gray-500 hover:text-emerald-400 transition-colors"
              title="Copy Account ID"
            >
              {copiedId ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </div>
        ) : (
          <div className="mb-4 flex items-center gap-2 px-3 py-2.5 bg-gray-800/40 border border-gray-700/50 rounded-lg">
            <Fingerprint className="h-3.5 w-3.5 text-gray-600 flex-shrink-0" />
            <p className="text-xs text-gray-600">Connect your T212 API key above to generate your Account ID.</p>
          </div>
        )}

        {/* API keys note */}
        <div className="flex items-start gap-2 mb-4 px-3 py-2.5 bg-amber-500/10 border border-amber-500/20 rounded-lg">
          <Info className="h-3.5 w-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-amber-400/80">
            API keys are <strong>not</strong> included in any backup. You will need to re-enter them on each device.
          </p>
        </div>

        {/* Cloud status message */}
        {cloudMsg && (
          <div className={`flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs mb-4 ${cloudMsg.ok ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border border-red-500/30 text-red-400'}`}>
            {cloudMsg.ok ? <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" /> : <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />}
            <span>{cloudMsg.text}</span>
          </div>
        )}

        {/* Save to Cloud */}
        <div className="space-y-3 mb-4">
          <div className="flex gap-2">
            <Button
              onClick={handleSaveToCloud}
              loading={cloudSaving}
              fullWidth
              icon={
                syncStatus === 'saving' ? <RefreshCw className="h-4 w-4 animate-spin" /> :
                syncStatus === 'saved'  ? <CheckCircle2 className="h-4 w-4" /> :
                <Cloud className="h-4 w-4" />
              }
            >
              {cloudSaving ? 'Saving…' : syncStatus === 'saved' ? 'Saved!' : 'Save to Cloud'}
            </Button>
          </div>

          {/* Last saved time */}
          {syncLastSaved && (
            <p className="text-[11px] text-gray-500">
              Last saved: {relativeTime(syncLastSaved)} · {formatBackupDate(syncLastSaved)}
            </p>
          )}

          {/* Auto-save toggle */}
          <button
            onClick={() => setAutoSaveEnabled(!autoSaveEnabled)}
            className="flex items-center justify-between w-full px-3 py-2.5 bg-gray-800/60 border border-gray-700 rounded-lg hover:border-gray-600 transition-colors"
          >
            <div>
              <p className="text-xs font-semibold text-white text-left">Auto-save</p>
              <p className="text-[11px] text-gray-500 text-left">Automatically saves strategies every 10 minutes</p>
            </div>
            {autoSaveEnabled
              ? <ToggleRight className="h-5 w-5 text-emerald-400 flex-shrink-0" />
              : <ToggleLeft className="h-5 w-5 text-gray-600 flex-shrink-0" />
            }
          </button>
        </div>

        {/* Sync URL + QR */}
        {syncUrl && (
          <div className="mb-4 space-y-2">
            <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">Sync URL</p>
            <div className="flex items-center gap-2 px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg">
              <Link2 className="h-3.5 w-3.5 text-gray-500 flex-shrink-0" />
              <p className="text-[11px] text-gray-300 font-mono truncate flex-1">{syncUrl}</p>
              <button
                onClick={() => handleCopy(syncUrl, setCopiedUrl)}
                className="flex-shrink-0 text-gray-500 hover:text-emerald-400 transition-colors"
                title="Copy URL"
              >
                {copiedUrl ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
              <button
                onClick={() => setShowQr(v => !v)}
                className={`flex-shrink-0 transition-colors ${showQr ? 'text-blue-400' : 'text-gray-500 hover:text-blue-400'}`}
                title="Toggle QR code"
              >
                <QrCode className="h-3.5 w-3.5" />
              </button>
            </div>

            {showQr && (
              <div className="flex flex-col items-center gap-2 p-4 bg-white rounded-xl">
                <QRImage value={syncUrl} size={180} />
                <p className="text-[10px] text-gray-600 text-center">
                  Scan on your other device → open ClearGains → Strategy Accounts → Paste Sync URL
                </p>
              </div>
            )}
          </div>
        )}

        {/* Load from URL */}
        <div className="pt-3 border-t border-gray-700 space-y-2">
          <p className="text-xs font-medium text-gray-400">Load from sync URL</p>
          <p className="text-[11px] text-gray-500">Paste a sync URL from your other device to restore all strategies.</p>
          <div className="flex gap-2">
            <input
              type="text"
              value={cloudLoadInput}
              onChange={e => setCloudLoadInput(e.target.value)}
              placeholder="https://api.npoint.io/…"
              className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500"
            />
            <Button
              size="sm"
              loading={cloudLoadLoading}
              onClick={handleLoadFromCloud}
              disabled={!cloudLoadInput.trim()}
              icon={<Download className="h-3.5 w-3.5" />}
            >
              Load
            </Button>
          </div>
        </div>
      </Card>
      </div>

      {/* ── Notifications ─────────────────────────────────────────────────────── */}
      <Card className="mb-4">
        <CardHeader
          title="Browser Notifications"
          subtitle="Get alerted for signals, paper trades, and CGT warnings"
          icon={<Bell className="h-4 w-4" />}
        />
        {notifPermission === 'unsupported' ? (
          <p className="text-xs text-gray-500">Not supported in this browser.</p>
        ) : notifPermission === 'denied' ? (
          <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5 text-xs text-red-400">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
            Notifications are blocked. Click the lock icon in your browser address bar to re-enable, then reload.
          </div>
        ) : notifPermission === 'granted' ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Enabled — alerts for BUY/SELL signals, SL/TP hits, and CGT warnings.
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-gray-400">Enable browser notifications to get real-time alerts:</p>
            <ul className="text-xs text-gray-500 space-y-1 list-disc list-inside ml-1">
              <li>BUY/SELL signals with strength &gt; 70%</li>
              <li>Paper trade take-profit or stop-loss hit</li>
              <li>CGT exempt amount within £500 of the £3,000 limit</li>
            </ul>
            <Button onClick={handleEnableNotifications} loading={notifLoading} icon={<Bell className="h-4 w-4" />}>
              Enable Notifications
            </Button>
          </div>
        )}
      </Card>

      {/* ── Local Backup ──────────────────────────────────────────────────────── */}
      <Card className="mb-4">
        <CardHeader
          title="Local Backup"
          subtitle="Download a backup file to keep on your device"
          icon={<Database className="h-4 w-4" />}
        />

        {/* History */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="px-3 py-2.5 bg-gray-800/60 border border-gray-700 rounded-lg">
            <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wide mb-1">Last exported</p>
            <p className="text-xs text-gray-300">{lastBackup ? formatBackupDate(lastBackup) : 'Never'}</p>
          </div>
          <div className="px-3 py-2.5 bg-gray-800/60 border border-gray-700 rounded-lg">
            <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wide mb-1">Last imported</p>
            <p className="text-xs text-gray-300">{lastImport ? formatBackupDate(lastImport) : 'Never'}</p>
          </div>
        </div>

        {exportMsg && (
          <div className="flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs mb-4 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
            <span>{exportMsg}</span>
          </div>
        )}

        {importError && !importModalOpen && (
          <div className="flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs mb-4 bg-red-500/10 border border-red-500/30 text-red-400">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
            <span>{importError}</span>
          </div>
        )}

        <div className="flex gap-2">
          <Button onClick={handleExport} fullWidth icon={<Download className="h-4 w-4" />}>Export File</Button>
          <Button variant="outline" fullWidth onClick={() => fileInputRef.current?.click()} icon={<Upload className="h-4 w-4" />}>Import File</Button>
          <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleFileSelect} />
        </div>
      </Card>

      {/* ── Strategy Profiles ─────────────────────────────────────────────────── */}
      {profiles.length > 0 && (
        <Card className="mb-4">
          <CardHeader
            title="Strategy Profiles"
            subtitle="Saved portfolio templates restored from your backup"
            icon={<Zap className="h-4 w-4" />}
          />
          <div className="space-y-2">
            {profiles.map(profile => (
              <div key={profile.id} className="flex items-center justify-between px-3 py-2.5 bg-gray-800/60 border border-gray-700 rounded-lg">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-white truncate">{profile.name}</p>
                  <p className="text-[11px] text-gray-500 mt-0.5">
                    {profile.strategy} · {profile.riskMode} · {profile.sectorFocus} · £{profile.paperBudget.toLocaleString()}
                  </p>
                </div>
                <button onClick={() => { deleteStrategyProfile(profile.id); setProfiles(p => p.filter(x => x.id !== profile.id)); }}
                  className="ml-3 flex-shrink-0 text-gray-600 hover:text-red-400 transition-colors">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── Reset ─────────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Reset All Data"
          subtitle="Clear all trades, settings, and cached data"
          icon={<Trash2 className="h-4 w-4" />}
        />
        <p className="text-xs text-gray-500 mb-4">
          This will permanently delete all your local trades, CGT calculations, and T212 connection. Cannot be undone.
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
            {importPreview.accountId && accountId && importPreview.accountId === accountId && (
              <div className="flex items-center gap-2 px-3 py-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
                <Fingerprint className="h-3.5 w-3.5 text-emerald-400 flex-shrink-0" />
                <p className="text-xs text-emerald-400">
                  Account ID matches — this backup belongs to your account <code className="font-mono">{accountId}</code>
                </p>
              </div>
            )}

            <div className="flex items-start gap-2 px-3 py-2.5 bg-blue-500/10 border border-blue-500/20 rounded-lg">
              <FileText className="h-3.5 w-3.5 text-blue-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-semibold text-blue-300">{importSummary}</p>
                <p className="text-[11px] text-gray-500 mt-0.5">Exported {formatBackupDate(importPreview.exportedAt)}</p>
              </div>
            </div>

            <div className="flex items-start gap-2 px-3 py-2.5 bg-amber-500/10 border border-amber-500/20 rounded-lg">
              <Info className="h-3.5 w-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-400/80">API keys are not included. Reconnect your T212 accounts after importing.</p>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-gray-400">How would you like to import?</p>
              <button onClick={() => setImportMode('merge')}
                className={`w-full text-left px-3 py-3 rounded-lg border transition-colors ${importMode === 'merge' ? 'border-emerald-500/50 bg-emerald-500/10' : 'border-gray-700 bg-gray-800/60 hover:border-gray-600'}`}>
                <p className={`text-xs font-semibold ${importMode === 'merge' ? 'text-emerald-400' : 'text-white'}`}>Merge with existing data</p>
                <p className="text-[11px] text-gray-500 mt-0.5">Adds portfolios and trades without deleting current data. Duplicates skipped.</p>
              </button>
              <button onClick={() => setImportMode('replace')}
                className={`w-full text-left px-3 py-3 rounded-lg border transition-colors ${importMode === 'replace' ? 'border-red-500/50 bg-red-500/10' : 'border-gray-700 bg-gray-800/60 hover:border-gray-600'}`}>
                <p className={`text-xs font-semibold ${importMode === 'replace' ? 'text-red-400' : 'text-white'}`}>Replace all data</p>
                <p className="text-[11px] text-gray-500 mt-0.5">Clears everything and imports fresh. Cannot be undone.</p>
              </button>
            </div>

            {importError && (
              <div className="flex items-start gap-2 px-3 py-2.5 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-400">
                <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                <span>{importError}</span>
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <Button variant="outline" fullWidth onClick={() => { setImportModalOpen(false); setImportPreview(null); setImportError(null); }}>Cancel</Button>
              <Button fullWidth loading={importing} onClick={handleConfirmImport} icon={<Upload className="h-4 w-4" />}>
                {importing ? 'Importing…' : `Confirm ${importMode === 'replace' ? 'Replace' : 'Merge'}`}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

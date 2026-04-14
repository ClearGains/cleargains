'use client';

import { useState } from 'react';
import { Eye, EyeOff, CheckCircle2, AlertCircle, Wifi, WifiOff, LogOut, ExternalLink, ChevronDown, ChevronRight } from 'lucide-react';
import { useClearGainsStore } from '@/lib/store';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { clsx } from 'clsx';

function PasswordField({
  label, value, onChange, show, onToggleShow, placeholder, disabled,
}: {
  label: string; value: string; onChange: (v: string) => void;
  show: boolean; onToggleShow: () => void; placeholder: string; disabled?: boolean;
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
          disabled={disabled}
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 pr-10 disabled:opacity-50 disabled:cursor-not-allowed"
        />
        <button type="button" onClick={onToggleShow} disabled={disabled} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 disabled:opacity-50">
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

function StepList({ steps, color }: { steps: string[]; color: 'emerald' | 'indigo' | 'blue' }) {
  const [open, setOpen] = useState(false);
  const bg = color === 'emerald' ? 'bg-emerald-600/20 text-emerald-400' : color === 'indigo' ? 'bg-indigo-600/20 text-indigo-400' : 'bg-blue-600/20 text-blue-400';
  const chevronColor = color === 'emerald' ? 'text-emerald-400' : color === 'indigo' ? 'text-indigo-400' : 'text-blue-400';
  return (
    <div>
      <button onClick={() => setOpen(v => !v)} className={clsx('flex items-center gap-1.5 text-xs font-medium mb-2', chevronColor)}>
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        How to get the API key
      </button>
      {open && (
        <div className="space-y-2 mb-3">
          {steps.map((text, i) => (
            <div key={i} className="flex items-start gap-3">
              <span className={clsx('flex-shrink-0 w-5 h-5 rounded-full text-xs font-bold flex items-center justify-center mt-0.5', bg)}>{i + 1}</span>
              <p className="text-sm text-gray-300">{text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Invest Account Card ────────────────────────────────────────────────────────
function InvestAccountCard() {
  const {
    t212Connected, t212AccountInfo,
    setT212Credentials, setT212Connected, setT212AccountInfo, clearT212Credentials,
  } = useClearGainsStore();

  const [key, setKey] = useState('');
  const [secret, setSecret] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConnect() {
    const cleanKey = key.replace(/[\s\n\r\t]/g, '');
    const cleanSecret = secret.replace(/[\s\n\r\t]/g, '');
    if (!cleanKey || !cleanSecret) { setError('Both API key and secret are required.'); return; }
    setSaving(true); setError(null);
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
        setKey(''); setSecret('');
      } else {
        setError(data.error ?? 'Connection failed.');
      }
    } catch (err) {
      setError(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className={clsx('w-10 h-10 rounded-xl flex items-center justify-center text-xl', t212Connected ? 'bg-emerald-500/20' : 'bg-gray-800')}>
            📊
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white">Invest Account</h3>
            <p className="text-xs text-gray-500">live.trading212.com · taxable gains</p>
          </div>
        </div>
        <div className={clsx('flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full', t212Connected ? 'bg-emerald-500/20 text-emerald-400' : 'bg-gray-800 text-gray-500')}>
          {t212Connected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
          {t212Connected ? 'Connected' : 'Not connected'}
        </div>
      </div>

      {t212Connected ? (
        <div className="space-y-3">
          <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2.5 text-xs text-emerald-400">
            <div className="flex items-center gap-1.5 mb-0.5"><CheckCircle2 className="h-3.5 w-3.5" /> Account verified</div>
            {t212AccountInfo && <p className="text-emerald-400/70">ID: {t212AccountInfo.id} · {t212AccountInfo.currency}</p>}
          </div>
          <p className="text-xs text-gray-500">Strategies set to <span className="text-emerald-400">Invest</span> will route orders here. Gains are subject to CGT.</p>
          <button onClick={clearT212Credentials} className="flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 transition-colors">
            <LogOut className="h-3.5 w-3.5" /> Disconnect
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-gray-400">
            Standard taxable brokerage account. Gains here are subject to CGT after the annual exempt amount.
          </p>
          <StepList color="emerald" steps={[
            'Open Trading 212 → switch to your Invest account',
            'Settings → API (Beta)',
            'Generate a new key with read + order permissions',
            'Copy key and secret below',
          ]} />
          <PasswordField label="API Key" value={key} onChange={setKey} show={showKey} onToggleShow={() => setShowKey(v => !v)} placeholder="Invest account API key" />
          <PasswordField label="API Secret" value={secret} onChange={setSecret} show={showSecret} onToggleShow={() => setShowSecret(v => !v)} placeholder="Invest account API secret" />
          {error && (
            <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2.5 text-xs text-red-400">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" /><span>{error}</span>
            </div>
          )}
          <Button onClick={handleConnect} loading={saving} fullWidth icon={<CheckCircle2 className="h-4 w-4" />}>
            {saving ? 'Verifying…' : 'Connect Invest Account'}
          </Button>
        </div>
      )}
    </Card>
  );
}

// ── ISA Account Card ───────────────────────────────────────────────────────────
function IsaAccountCard() {
  const {
    t212IsaConnected, t212IsaAccountInfo,
    setT212IsaCredentials, setT212IsaConnected, setT212IsaAccountInfo, clearT212IsaCredentials,
  } = useClearGainsStore();

  const [key, setKey] = useState('');
  const [secret, setSecret] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConnect() {
    const cleanKey = key.replace(/[\s\n\r\t]/g, '');
    const cleanSecret = secret.replace(/[\s\n\r\t]/g, '');
    if (!cleanKey || !cleanSecret) { setError('Both API key and secret are required.'); return; }
    setSaving(true); setError(null);
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
        setKey(''); setSecret('');
      } else {
        setError(data.error ?? 'Connection failed.');
      }
    } catch (err) {
      setError(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className={clsx('w-10 h-10 rounded-xl flex items-center justify-center text-xl', t212IsaConnected ? 'bg-indigo-500/20' : 'bg-gray-800')}>
            📈
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white">Stocks ISA</h3>
            <p className="text-xs text-gray-500">live.trading212.com · tax-free wrapper</p>
          </div>
        </div>
        <div className={clsx('flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full', t212IsaConnected ? 'bg-indigo-500/20 text-indigo-400' : 'bg-gray-800 text-gray-500')}>
          {t212IsaConnected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
          {t212IsaConnected ? 'Connected' : 'Not connected'}
        </div>
      </div>

      {/* ISA allowance bar */}
      <div className="mb-3 bg-gray-800 rounded-lg px-3 py-2.5">
        <div className="flex justify-between text-xs mb-1.5">
          <span className="text-gray-400">2024/25 Annual Allowance</span>
          <span className="text-indigo-400 font-semibold">£20,000</span>
        </div>
        <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
          <div className="h-full bg-indigo-500/60 rounded-full w-0 transition-all" />
        </div>
        <p className="text-[10px] text-gray-600 mt-1">Allowance tracking from trade history — connect and place trades to start</p>
      </div>

      {t212IsaConnected ? (
        <div className="space-y-3">
          <div className="bg-indigo-500/10 border border-indigo-500/20 rounded-lg px-3 py-2.5 text-xs text-indigo-400">
            <div className="flex items-center gap-1.5 mb-0.5"><CheckCircle2 className="h-3.5 w-3.5" /> ISA account verified</div>
            {t212IsaAccountInfo && <p className="text-indigo-400/70">ID: {t212IsaAccountInfo.id} · {t212IsaAccountInfo.currency}</p>}
          </div>
          <p className="text-xs text-gray-500">
            Strategies set to <span className="text-indigo-400">ISA</span> will route orders here.
            Gains inside an ISA are <span className="text-indigo-400 font-medium">exempt from CGT and income tax</span>.
          </p>
          <button onClick={clearT212IsaCredentials} className="flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 transition-colors">
            <LogOut className="h-3.5 w-3.5" /> Disconnect
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-gray-400">
            The ISA uses a <span className="text-white font-medium">different API key</span> from your Invest account — generate it while viewing your ISA in T212.
          </p>
          <div className="bg-indigo-500/10 border border-indigo-500/20 rounded-lg px-3 py-2.5 text-xs text-indigo-400">
            💡 UK Stocks ISA: up to £20,000/year, gains and dividends are completely tax-free. No CGT, no income tax.
          </div>
          <StepList color="indigo" steps={[
            'Open the Trading 212 app',
            'Tap your account name at the top',
            'Switch to "Stocks ISA" account',
            'Settings → API (Beta)',
            'Generate a new key with read + order permissions',
            'Copy key and secret below',
          ]} />
          <PasswordField label="ISA API Key" value={key} onChange={setKey} show={showKey} onToggleShow={() => setShowKey(v => !v)} placeholder="Stocks ISA account API key" />
          <PasswordField label="ISA API Secret" value={secret} onChange={setSecret} show={showSecret} onToggleShow={() => setShowSecret(v => !v)} placeholder="Stocks ISA account API secret" />
          {error && (
            <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2.5 text-xs text-red-400">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" /><span>{error}</span>
            </div>
          )}
          <Button
            onClick={handleConnect}
            loading={saving}
            fullWidth
            className="bg-indigo-600 hover:bg-indigo-500"
            icon={<CheckCircle2 className="h-4 w-4" />}
          >
            {saving ? 'Verifying…' : 'Connect ISA Account'}
          </Button>
          <a
            href="https://helpcentre.trading212.com/hc/en-us/articles/14584769028253"
            target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300"
          >
            <ExternalLink className="h-3.5 w-3.5" /> T212 help: How to generate an API key
          </a>
        </div>
      )}
    </Card>
  );
}

// ── Practice Account Card ──────────────────────────────────────────────────────
function PracticeAccountCard() {
  const {
    t212DemoConnected, t212DemoAccountInfo,
    setT212DemoCredentials, setT212DemoConnected, setT212DemoAccountInfo, clearT212DemoCredentials,
  } = useClearGainsStore();

  const [key, setKey] = useState('');
  const [secret, setSecret] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConnect() {
    const cleanKey = key.replace(/[\s\n\r\t]/g, '');
    const cleanSecret = secret.replace(/[\s\n\r\t]/g, '');
    if (!cleanKey || !cleanSecret) { setError('Both API key and secret are required.'); return; }
    setSaving(true); setError(null);
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
        setKey(''); setSecret('');
      } else {
        setError(data.error ?? 'Connection failed.');
      }
    } catch (err) {
      setError(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className={clsx('w-10 h-10 rounded-xl flex items-center justify-center text-xl', t212DemoConnected ? 'bg-blue-500/20' : 'bg-gray-800')}>
            🎮
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white">Practice / Demo</h3>
            <p className="text-xs text-gray-500">demo.trading212.com · virtual money</p>
          </div>
        </div>
        <div className={clsx('flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full', t212DemoConnected ? 'bg-blue-500/20 text-blue-400' : 'bg-gray-800 text-gray-500')}>
          {t212DemoConnected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
          {t212DemoConnected ? 'Connected' : 'Not connected'}
        </div>
      </div>

      {t212DemoConnected ? (
        <div className="space-y-3">
          <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2.5 text-xs text-blue-400">
            <div className="flex items-center gap-1.5 mb-0.5"><CheckCircle2 className="h-3.5 w-3.5" /> Practice account verified</div>
            {t212DemoAccountInfo && <p className="text-blue-400/70">ID: {t212DemoAccountInfo.id} · {t212DemoAccountInfo.currency}</p>}
          </div>
          <p className="text-xs text-gray-500">
            Strategies set to <span className="text-blue-400">Practice</span> will place orders on this demo account — no real money involved.
          </p>
          <button onClick={clearT212DemoCredentials} className="flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 transition-colors">
            <LogOut className="h-3.5 w-3.5" /> Disconnect
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-gray-400">
            Test your strategies risk-free with T212 virtual money. Identical to real trading with no financial risk.
          </p>
          <StepList color="blue" steps={[
            'Open the Trading 212 app',
            'Tap your account name at the top',
            'Switch to "Practice" account',
            'Settings → API (Beta)',
            'Generate a new key — this is your Practice key',
            'Copy key and secret below',
          ]} />
          <PasswordField label="Practice API Key" value={key} onChange={setKey} show={showKey} onToggleShow={() => setShowKey(v => !v)} placeholder="Practice account API key" />
          <PasswordField label="Practice API Secret" value={secret} onChange={setSecret} show={showSecret} onToggleShow={() => setShowSecret(v => !v)} placeholder="Practice account API secret" />
          {error && (
            <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2.5 text-xs text-red-400">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" /><span>{error}</span>
            </div>
          )}
          <Button
            onClick={handleConnect}
            loading={saving}
            fullWidth
            className="bg-blue-600 hover:bg-blue-500"
            icon={<CheckCircle2 className="h-4 w-4" />}
          >
            {saving ? 'Verifying…' : 'Connect Practice Account'}
          </Button>
        </div>
      )}
    </Card>
  );
}

// ── CFD Coming Soon Card ───────────────────────────────────────────────────────
function CfdAccountCard() {
  return (
    <Card className="opacity-50 pointer-events-none">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl bg-gray-800">
            💹
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white">CFD Account</h3>
            <p className="text-xs text-gray-500">live.trading212.com · leveraged trading</p>
          </div>
        </div>
        <span className="text-xs px-2 py-1 rounded-full bg-gray-800 text-gray-500">Coming soon</span>
      </div>
      <p className="text-xs text-gray-500">
        CFD account support is planned for a future release. This will enable leveraged position trading and short selling through the T212 API.
      </p>
    </Card>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function AccountsPage() {
  const {
    t212Connected, t212IsaConnected, t212DemoConnected,
  } = useClearGainsStore();

  const connectedCount = [t212Connected, t212IsaConnected, t212DemoConnected].filter(Boolean).length;

  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto">
      <div className="mb-6">
        <div className="flex items-center gap-2 text-xs text-gray-500 mb-2">
          <a href="/settings" className="hover:text-gray-300 transition-colors">Settings</a>
          <span>/</span>
          <span className="text-gray-300">Accounts</span>
        </div>
        <h1 className="text-2xl font-bold text-white">Trading 212 Accounts</h1>
        <p className="text-sm text-gray-500 mt-1">
          Connect up to 3 accounts — each strategy can route orders to a different account.
        </p>

        {/* Summary bar */}
        <div className="mt-4 flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className={clsx('w-2.5 h-2.5 rounded-full', t212Connected ? 'bg-emerald-400' : 'bg-gray-700')} />
            <span className={clsx('text-xs', t212Connected ? 'text-emerald-400' : 'text-gray-600')}>📊 Invest</span>
          </div>
          <div className="flex items-center gap-2">
            <span className={clsx('w-2.5 h-2.5 rounded-full', t212IsaConnected ? 'bg-indigo-400' : 'bg-gray-700')} />
            <span className={clsx('text-xs', t212IsaConnected ? 'text-indigo-400' : 'text-gray-600')}>📈 ISA</span>
          </div>
          <div className="flex items-center gap-2">
            <span className={clsx('w-2.5 h-2.5 rounded-full', t212DemoConnected ? 'bg-blue-400' : 'bg-gray-700')} />
            <span className={clsx('text-xs', t212DemoConnected ? 'text-blue-400' : 'text-gray-600')}>🎮 Practice</span>
          </div>
          <span className="ml-auto text-xs text-gray-500">{connectedCount}/3 connected</span>
        </div>
      </div>

      <div className="space-y-4">
        <InvestAccountCard />
        <IsaAccountCard />
        <PracticeAccountCard />
        <CfdAccountCard />
      </div>

      <div className="mt-6 bg-blue-500/10 border border-blue-500/20 rounded-lg px-4 py-3">
        <p className="text-xs text-blue-400/80">
          🔒 Credentials are stored only in your browser (localStorage) and sent directly to Trading 212. They are never logged or stored on our servers.
        </p>
      </div>
    </div>
  );
}

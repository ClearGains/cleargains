'use client';

import { useState, useEffect } from 'react';
import { Zap, AlertTriangle } from 'lucide-react';
import PennyScanner from '@/components/PennyScanner';
import SharesTrading from '@/components/SharesTrading';

type IGSession = { cst: string; securityToken: string; apiKey: string };
type IGCredentials = { username: string; password: string; apiKey: string; connected?: boolean };

type Tab = 'scanner' | 'trade';

function useIGSession(env: 'demo' | 'live'): {
  session: IGSession | null;
  connecting: boolean;
  error: string | null;
  connect: () => void;
} {
  const [session, setSession]     = useState<IGSession | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError]         = useState<string | null>(null);

  const connect = async () => {
    const credKey = env === 'demo' ? 'ig_demo_credentials' : 'ig_live_credentials';
    const sessKey = `ig_session_${env}`;
    setConnecting(true); setError(null);
    try {
      // Try cached session first
      const sessRaw = localStorage.getItem(sessKey);
      if (sessRaw) {
        const cached = JSON.parse(sessRaw) as { cst: string; securityToken: string; accountId: string; apiKey: string; authenticatedAt: number };
        if (cached.cst && Date.now() - cached.authenticatedAt < 5 * 60 * 60 * 1000) {
          setSession({ cst: cached.cst, securityToken: cached.securityToken, apiKey: cached.apiKey });
          setConnecting(false);
          return;
        }
      }
      const raw = localStorage.getItem(credKey);
      if (!raw) throw new Error('No IG credentials found. Add them in Settings → Accounts.');
      const creds = JSON.parse(raw) as IGCredentials;
      if (!creds.connected) throw new Error('IG account not connected. Go to Settings → Accounts.');
      const res = await fetch('/api/ig/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: creds.username, password: creds.password, apiKey: creds.apiKey, env }),
      });
      const data = await res.json() as { ok: boolean; cst?: string; securityToken?: string; accountId?: string; error?: string };
      if (!data.ok || !data.cst || !data.securityToken) throw new Error(data.error ?? 'IG auth failed');
      const sess: IGSession = { cst: data.cst, securityToken: data.securityToken, apiKey: creds.apiKey };
      localStorage.setItem(sessKey, JSON.stringify({ ...sess, accountId: data.accountId, authenticatedAt: Date.now() }));
      setSession(sess);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed');
    } finally { setConnecting(false); }
  };

  // Auto-connect on mount if credentials exist
  useEffect(() => { connect(); }, []); // eslint-disable-line

  return { session, connecting, error, connect };
}

export default function PennyScannerPage() {
  const [env, setEnv] = useState<'demo' | 'live'>('demo');
  const [tab, setTab] = useState<Tab>('scanner');
  const { session, connecting, error, connect } = useIGSession(env);

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Zap className="h-6 w-6 text-purple-400" />
          Penny Stock Scanner
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Scan IG markets for low-price shares, analyse with technical indicators, and get AI-powered signals
        </p>
      </div>

      {/* Disclaimer */}
      <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-4 py-3 mb-5 flex items-start gap-3">
        <AlertTriangle className="h-4 w-4 text-yellow-500 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-yellow-400">
          <span className="font-semibold">High risk.</span> Penny stocks are highly volatile and illiquid.
          AI signals and technical analysis are for educational purposes only — not financial advice.
          Spread betting carries significant risk of loss. Only trade with money you can afford to lose.
        </p>
      </div>

      {/* Top bar: env toggle + tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div className="flex gap-1 bg-gray-800 rounded-lg p-1">
          {(['scanner', 'trade'] as Tab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={[
                'px-4 py-1.5 rounded-md text-sm font-medium transition-colors capitalize',
                tab === t ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300',
              ].join(' ')}
            >
              {t === 'scanner' ? 'Penny Scanner' : 'Shares Trading'}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3">
          {connecting && <span className="text-xs text-gray-500 animate-pulse">Connecting to IG…</span>}
          {session && <span className="text-xs text-emerald-400">IG Connected</span>}
          {error && <span className="text-xs text-red-400 max-w-xs truncate">{error}</span>}
          <div className="flex gap-1 bg-gray-800 rounded-lg p-1">
            {(['demo', 'live'] as const).map(e => (
              <button
                key={e}
                onClick={() => setEnv(e)}
                className={[
                  'px-3 py-1 rounded-md text-xs font-semibold transition-colors',
                  env === e
                    ? e === 'live' ? 'bg-red-600 text-white' : 'bg-blue-600 text-white'
                    : 'text-gray-500 hover:text-gray-300',
                ].join(' ')}
              >
                {e.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </div>

      {tab === 'scanner' ? (
        <PennyScanner session={session} env={env} onConnect={connect} />
      ) : (
        <SharesTrading session={session} env={env} onConnect={connect} />
      )}
    </div>
  );
}

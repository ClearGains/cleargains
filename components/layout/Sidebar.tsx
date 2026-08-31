'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  LayoutDashboard,
  Search,
  BookOpen,
  Calculator,
  Receipt,
  ShieldCheck,
  Globe,
  Calendar,
  HelpCircle,
  Settings,
  Wifi,
  WifiOff,
  FlaskConical,
  Bookmark,
  Newspaper,
  BarChart3,
  ScanLine,
  LineChart,
  TrendingUp,
  TrendingDown,
  Target,
  Hash,
  Bot,
  FileText,
  Star,
  Rocket,
  AlertTriangle,
  Gem,
  Scale,
  Pause,
  NotebookPen,
  Scissors,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useClearGainsStore } from '@/lib/store';

// ── Alpaca bot sidebar status ─────────────────────────────────────────────────

type AlpacaSidebarState = {
  paper: 'running' | 'paused' | 'stopped' | 'unknown';
  live:  'running' | 'paused' | 'stopped' | 'unknown';
};

async function fetchAlpacaMode(mode: 'paper' | 'live'): Promise<'running' | 'paused' | 'stopped' | 'unknown'> {
  try {
    const res  = await fetch(`/api/alpaca?mode=${mode}&action=status`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return 'unknown';
    const data = await res.json() as { running?: boolean; paused?: boolean };
    if (!data.running) return 'stopped';
    return data.paused ? 'paused' : 'running';
  } catch {
    return 'unknown';
  }
}

function useAlpacaSidebarStatus(): AlpacaSidebarState {
  const [state, setState] = useState<AlpacaSidebarState>({ paper: 'unknown', live: 'unknown' });

  useEffect(() => {
    async function check() {
      const [paper, live] = await Promise.all([fetchAlpacaMode('paper'), fetchAlpacaMode('live')]);
      setState({ paper, live });
    }
    void check();
    const t = setInterval(() => { void check(); }, 30_000);
    return () => clearInterval(t);
  }, []);

  return state;
}

const navLinks = [
  { href: '/dashboard',  label: 'Dashboard',      icon: LayoutDashboard },
  { href: '/positions',  label: 'Live Positions',  icon: BarChart3 },
  { href: '/scanner',       label: 'AI Scanner',      icon: Search },
  { href: '/penny-scanner',    label: 'Penny Scanner',    icon: ScanLine   },
  { href: '/graph-analysis',   label: 'Graph Analysis',   icon: LineChart  },
  { href: '/market-movers',    label: 'Market Movers',    icon: TrendingUp  },
  { href: '/market-depth',     label: 'Market Depth',     icon: Scale       },
  { href: '/overvalued',        label: 'Overvalued Stocks',  icon: AlertTriangle },
  { href: '/undervalued',       label: 'Undervalued Stocks', icon: Gem           },
  { href: '/short-scanner',    label: 'Short Scanner',    icon: TrendingDown },
  { href: '/auto-trader',      label: 'Auto Trader',      icon: Bot         },
  { href: '/alpaca-trader',    label: 'Alpaca Bot',        icon: Bot         },
  { href: '/t212-trader',      label: 'T212 ISA Bot',      icon: Bot         },
  { href: '/mean-reversion',   label: 'Mean Reversion',    icon: Bot         },
  { href: '/ig-options',       label: 'IG Options Bot',    icon: Bot         },
  { href: '/backtest',         label: 'Backtest Lab',      icon: FlaskConical },
  { href: '/bot-journal',      label: 'Bot Journal',       icon: NotebookPen },
  { href: '/performance',      label: 'Bot Performance',   icon: BarChart3   },
  { href: '/reputable-stocks', label: 'Reputable Stocks',  icon: Star        },
  { href: '/future-leaders',   label: 'Future Leaders',    icon: Rocket      },
  { href: '/trade-log',        label: 'Trade Log',        icon: FileText    },
  { href: '/daily-brief',      label: 'Daily Brief',      icon: Target      },
  { href: '/watchlist', label: 'Watchlist', icon: Bookmark },
  { href: '/world-affairs', label: 'World Affairs', icon: Newspaper },
  { href: '/trading-guide', label: 'Trading Guide', icon: BookOpen },
  { href: '/demo-trader', label: 'Demo Trader', icon: FlaskConical },
  { href: '/ledger', label: 'Trade Ledger', icon: BookOpen },
  { href: '/tax-monitor', label: 'Tax Monitor', icon: ShieldCheck },
  { href: '/harvest', label: 'Tax Harvesting', icon: Scissors },
  { href: '/calculator',     label: 'Calculator',       icon: Hash       },
  { href: '/cgt', label: 'CGT Calculator', icon: Calculator },
  { href: '/tax-calculator', label: 'Tax Calculator', icon: Receipt },
  { href: '/risk', label: 'Risk Engine', icon: ShieldCheck },
  { href: '/tax-guides', label: 'Tax Guides', icon: Globe },
  { href: '/deadlines', label: 'Deadlines', icon: Calendar },
  { href: '/help', label: 'Help Centre', icon: HelpCircle },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export function Sidebar() {
  const pathname    = usePathname();
  const alpaca      = useAlpacaSidebarStatus();
  const { t212Connected, t212AccountType, t212LastSync, pendingSignalCount } = useClearGainsStore();

  if (pathname === '/login') return null;

  return (
    <aside className="hidden xl:flex flex-col w-56 flex-shrink-0 bg-gray-950 border-r border-gray-800 min-h-screen sticky top-14 h-[calc(100vh-3.5rem)]">
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        {navLinks.map(({ href, label, icon: Icon }) => {
          const isActive      = pathname === href || pathname.startsWith(href + '/');
          const isDemoTrader  = href === '/demo-trader';
          const isAlpacaBot   = href === '/alpaca-trader';
          const showBadge     = isDemoTrader && pendingSignalCount > 0;
          const alpacaRunning = isAlpacaBot && (alpaca.paper === 'running' || alpaca.live === 'running');
          const alpacaPaused  = isAlpacaBot && !alpacaRunning && (alpaca.paper === 'paused' || alpaca.live === 'paused');
          return (
            <Link
              key={href}
              href={href}
              className={clsx(
                'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-150',
                isActive
                  ? 'bg-emerald-600/15 text-emerald-400 border border-emerald-600/20'
                  : 'text-gray-500 hover:text-gray-200 hover:bg-gray-800/60'
              )}
            >
              <Icon
                className={clsx(
                  'h-4 w-4 flex-shrink-0',
                  isActive ? 'text-emerald-400' : 'text-gray-600'
                )}
              />
              <span className="flex-1">{label}</span>
              {showBadge && (
                <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold leading-none">
                  {pendingSignalCount}
                </span>
              )}
              {alpacaRunning && (
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-400" />
                </span>
              )}
              {alpacaPaused && (
                <Pause className="h-3 w-3 text-yellow-400" />
              )}
            </Link>
          );
        })}
      </nav>

      {/* Alpaca bot status */}
      {(alpaca.paper !== 'unknown' || alpaca.live !== 'unknown') && (
        <div className="px-3 pt-3 border-t border-gray-800">
          <Link href="/alpaca-trader" className="block">
            <div className={clsx(
              'flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-colors',
              (alpaca.paper === 'running' || alpaca.live === 'running')
                ? 'bg-indigo-500/10 border border-indigo-500/20 hover:bg-indigo-500/15'
                : (alpaca.paper === 'paused' || alpaca.live === 'paused')
                ? 'bg-yellow-500/8 border border-yellow-500/15 hover:bg-yellow-500/12'
                : 'bg-gray-800/50 border border-gray-700 hover:bg-gray-800',
            )}>
              <Bot className={clsx(
                'h-3.5 w-3.5 flex-shrink-0',
                (alpaca.paper === 'running' || alpaca.live === 'running') ? 'text-indigo-400' :
                (alpaca.paper === 'paused'  || alpaca.live === 'paused')  ? 'text-yellow-400' :
                'text-gray-500',
              )} />
              <div className="flex-1 min-w-0">
                <div className={clsx(
                  'font-medium',
                  (alpaca.paper === 'running' || alpaca.live === 'running') ? 'text-indigo-300' :
                  (alpaca.paper === 'paused'  || alpaca.live === 'paused')  ? 'text-yellow-300' :
                  'text-gray-500',
                )}>
                  Alpaca Bot
                </div>
                <div className="text-gray-600 flex items-center gap-1.5 flex-wrap">
                  {(['paper', 'live'] as const).map(m => {
                    const s = alpaca[m];
                    if (s === 'unknown') return null;
                    return (
                      <span key={m} className="flex items-center gap-1">
                        <span className={clsx(
                          'inline-block w-1.5 h-1.5 rounded-full',
                          s === 'running' ? 'bg-green-400 animate-pulse' :
                          s === 'paused'  ? 'bg-yellow-400' :
                          'bg-gray-600',
                        )} />
                        <span className={clsx(
                          s === 'running' ? 'text-green-500' :
                          s === 'paused'  ? 'text-yellow-500' :
                          'text-gray-600',
                        )}>
                          {m}
                        </span>
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>
          </Link>
        </div>
      )}

      {/* T212 connection status */}
      <div className="p-3 border-t border-gray-800">
        <div
          className={clsx(
            'flex items-center gap-2 px-3 py-2 rounded-lg text-xs',
            t212Connected
              ? 'bg-emerald-500/10 border border-emerald-500/20'
              : 'bg-gray-800/50 border border-gray-700'
          )}
        >
          {t212Connected ? (
            <Wifi className="h-3.5 w-3.5 text-emerald-400 flex-shrink-0" />
          ) : (
            <WifiOff className="h-3.5 w-3.5 text-gray-500 flex-shrink-0" />
          )}
          <div>
            <div
              className={clsx(
                'font-medium',
                t212Connected ? 'text-emerald-400' : 'text-gray-500'
              )}
            >
              T212 {t212Connected ? 'Connected' : 'Disconnected'}
            </div>
            {t212Connected && (
              <div className="text-gray-600">
                {t212AccountType} •{' '}
                {t212LastSync
                  ? new Date(t212LastSync).toLocaleDateString('en-GB')
                  : 'Never synced'}
              </div>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
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
} from 'lucide-react';
import { clsx } from 'clsx';
import { useClearGainsStore } from '@/lib/store';

const navLinks = [
  { href: '/dashboard',  label: 'Dashboard',      icon: LayoutDashboard },
  { href: '/positions',  label: 'Live Positions',  icon: BarChart3 },
  { href: '/scanner',    label: 'AI Scanner',      icon: Search },
  { href: '/watchlist', label: 'Watchlist', icon: Bookmark },
  { href: '/world-affairs', label: 'World Affairs', icon: Newspaper },
  { href: '/trading-guide', label: 'Trading Guide', icon: BookOpen },
  { href: '/demo-trader', label: 'Demo Trader', icon: FlaskConical },
  { href: '/ledger', label: 'Trade Ledger', icon: BookOpen },
  { href: '/tax-monitor', label: 'Tax Monitor', icon: ShieldCheck },
  { href: '/cgt', label: 'CGT Calculator', icon: Calculator },
  { href: '/tax-calculator', label: 'Tax Calculator', icon: Receipt },
  { href: '/risk', label: 'Risk Engine', icon: ShieldCheck },
  { href: '/tax-guides', label: 'Tax Guides', icon: Globe },
  { href: '/deadlines', label: 'Deadlines', icon: Calendar },
  { href: '/help', label: 'Help Centre', icon: HelpCircle },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const { t212Connected, t212AccountType, t212LastSync, pendingSignalCount } = useClearGainsStore();

  if (pathname === '/login') return null;

  return (
    <aside className="hidden xl:flex flex-col w-56 flex-shrink-0 bg-gray-950 border-r border-gray-800 min-h-screen sticky top-14 h-[calc(100vh-3.5rem)]">
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        {navLinks.map(({ href, label, icon: Icon }) => {
          const isActive = pathname === href || pathname.startsWith(href + '/');
          const isDemoTrader = href === '/demo-trader';
          const showBadge = isDemoTrader && pendingSignalCount > 0;
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
            </Link>
          );
        })}
      </nav>

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

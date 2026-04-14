'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  TrendingUp,
  LayoutDashboard,
  Search,
  BookOpen,
  Calculator,
  Receipt,
  ShieldCheck,
  Globe,
  Calendar,
  HelpCircle,
  Menu,
  X,
  LogOut,
  FlaskConical,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useClearGainsStore } from '@/lib/store';
import { T212NavButton } from '@/components/t212/T212NavButton';
import { SyncIndicator } from '@/components/sync/SyncIndicator';

const navLinks = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/scanner', label: 'Scanner', icon: Search },
  { href: '/demo-trader', label: 'Demo Trader', icon: FlaskConical },
  { href: '/ledger', label: 'Ledger', icon: BookOpen },
  { href: '/cgt', label: 'CGT', icon: Calculator },
  { href: '/tax-calculator', label: 'Tax Calc', icon: Receipt },
  { href: '/risk', label: 'Risk', icon: ShieldCheck },
  { href: '/tax-guides', label: 'Tax Guides', icon: Globe },
  { href: '/deadlines', label: 'Deadlines', icon: Calendar },
  { href: '/help', label: 'Help', icon: HelpCircle },
];

export function Navbar() {
  const pathname = usePathname();
  const router = useRouter();
  const { selectedCountry } = useClearGainsStore();
  const [mobileOpen, setMobileOpen] = useState(false);

  if (pathname === '/login') return null;

  const handleLogout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
  }, [router]);

  return (
    <header className="sticky top-0 z-50 bg-gray-950/95 backdrop-blur border-b border-gray-800">
      <div className="flex items-center justify-between px-4 h-14">
        {/* Logo */}
        <Link
          href="/dashboard"
          className="flex items-center gap-2 font-bold text-lg text-white"
        >
          <div className="bg-emerald-600 rounded-lg p-1.5">
            <TrendingUp className="h-4 w-4 text-white" />
          </div>
          <span className="hidden sm:block">
            Clear<span className="text-emerald-400">Gains</span>
          </span>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden lg:flex items-center gap-1">
          {navLinks.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={clsx(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
                pathname === href || pathname.startsWith(href + '/')
                  ? 'bg-emerald-600/20 text-emerald-400'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </Link>
          ))}
        </nav>

        {/* Right-side actions */}
        <div className="flex items-center gap-2">
          <T212NavButton />
          <SyncIndicator />

          <Link
            href="/onboarding"
            className="hidden sm:flex items-center gap-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg px-3 py-1.5 text-sm transition-colors"
          >
            <span className="text-base">{selectedCountry.flag}</span>
            <span className="text-gray-300">{selectedCountry.currencySymbol}</span>
            <span className="text-gray-500 text-xs">{selectedCountry.currency}</span>
          </Link>

          {/* Logout */}
          <button
            onClick={handleLogout}
            title="Sign out"
            className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span className="hidden lg:inline">Sign out</span>
          </button>

          {/* Mobile menu button */}
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="lg:hidden p-2 rounded-lg text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <div className="lg:hidden border-t border-gray-800 bg-gray-950 px-4 py-2">
          {navLinks.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              onClick={() => setMobileOpen(false)}
              className={clsx(
                'flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors my-0.5',
                pathname === href || pathname.startsWith(href + '/')
                  ? 'bg-emerald-600/20 text-emerald-400'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          ))}
        </div>
      )}
    </header>
  );
}

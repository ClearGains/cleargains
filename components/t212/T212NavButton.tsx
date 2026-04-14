'use client';

import { useState, useRef, useEffect } from 'react';
import { Wifi, WifiOff, LogOut, ChevronDown, Settings } from 'lucide-react';
import Link from 'next/link';
import { useClearGainsStore } from '@/lib/store';
import { ConnectModal } from './ConnectModal';
import { clsx } from 'clsx';

export function T212NavButton() {
  const {
    t212Connected, t212AccountType, t212AccountInfo, clearT212Credentials,
    t212DemoConnected, t212DemoAccountInfo, clearT212DemoCredentials,
    t212IsaConnected, t212IsaAccountInfo, clearT212IsaCredentials,
  } = useClearGainsStore();

  const [showModal, setShowModal] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const connectedCount = [t212Connected, t212IsaConnected, t212DemoConnected].filter(Boolean).length;
  const eitherConnected = connectedCount > 0;

  if (eitherConnected) {
    return (
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setShowMenu(v => !v)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-gray-800 border border-gray-700 text-gray-300 hover:bg-gray-700 transition-colors"
        >
          {/* Invest indicator */}
          <span
            title={t212Connected ? `Invest · ${t212AccountInfo?.currency ?? ''}` : 'Invest not connected'}
            className={clsx('w-2 h-2 rounded-full flex-shrink-0', t212Connected ? 'bg-emerald-400 animate-pulse' : 'bg-gray-700')}
          />
          {/* ISA indicator */}
          <span
            title={t212IsaConnected ? `ISA · ${t212IsaAccountInfo?.currency ?? ''}` : 'ISA not connected'}
            className={clsx('w-2 h-2 rounded-full flex-shrink-0 -ml-1', t212IsaConnected ? 'bg-indigo-400 animate-pulse' : 'bg-gray-700')}
          />
          {/* Practice indicator */}
          <span
            title={t212DemoConnected ? `Practice · ${t212DemoAccountInfo?.currency ?? ''}` : 'Practice not connected'}
            className={clsx('w-2 h-2 rounded-full flex-shrink-0 -ml-1', t212DemoConnected ? 'bg-blue-400 animate-pulse' : 'bg-gray-700')}
          />
          <Wifi className="h-3 w-3" />
          <span className="hidden sm:inline">T212 <span className="text-gray-500">{connectedCount}/3</span></span>
          <ChevronDown className={clsx('h-3 w-3 transition-transform', showMenu && 'rotate-180')} />
        </button>

        {showMenu && (
          <div className="absolute right-0 top-full mt-1.5 w-56 bg-gray-900 border border-gray-700 rounded-xl shadow-xl z-50 overflow-hidden">
            <div className="px-3 py-2 border-b border-gray-800">
              <p className="text-xs font-semibold text-gray-300 mb-1.5">Trading 212 Accounts</p>
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className={clsx('w-1.5 h-1.5 rounded-full', t212Connected ? 'bg-emerald-400' : 'bg-gray-600')} />
                  <span className={t212Connected ? 'text-emerald-400' : 'text-gray-600'}>
                    📊 Invest {t212Connected ? `· ${t212AccountInfo?.currency ?? ''}` : '· not connected'}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className={clsx('w-1.5 h-1.5 rounded-full', t212IsaConnected ? 'bg-indigo-400' : 'bg-gray-600')} />
                  <span className={t212IsaConnected ? 'text-indigo-400' : 'text-gray-600'}>
                    📈 ISA {t212IsaConnected ? `· ${t212IsaAccountInfo?.currency ?? ''} · tax-free` : '· not connected'}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className={clsx('w-1.5 h-1.5 rounded-full', t212DemoConnected ? 'bg-blue-400' : 'bg-gray-600')} />
                  <span className={t212DemoConnected ? 'text-blue-400' : 'text-gray-600'}>
                    🎮 Practice {t212DemoConnected ? `· ${t212DemoAccountInfo?.currency ?? ''}` : '· not connected'}
                  </span>
                </div>
              </div>
            </div>

            <button
              onClick={() => { setShowMenu(false); setShowModal(true); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-400 hover:bg-gray-800 transition-colors"
            >
              <Wifi className="h-3.5 w-3.5" />
              Manage connections
            </button>
            <Link
              href="/settings/accounts"
              onClick={() => setShowMenu(false)}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-400 hover:bg-gray-800 transition-colors"
            >
              <Settings className="h-3.5 w-3.5" />
              Account settings
            </Link>

            {t212Connected && (
              <button
                onClick={() => { setShowMenu(false); clearT212Credentials(); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-400 hover:bg-red-500/10 transition-colors border-t border-gray-800"
              >
                <LogOut className="h-3.5 w-3.5" />
                Disconnect invest
              </button>
            )}
            {t212IsaConnected && (
              <button
                onClick={() => { setShowMenu(false); clearT212IsaCredentials(); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-400 hover:bg-red-500/10 transition-colors"
              >
                <LogOut className="h-3.5 w-3.5" />
                Disconnect ISA
              </button>
            )}
            {t212DemoConnected && (
              <button
                onClick={() => { setShowMenu(false); clearT212DemoCredentials(); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-400 hover:bg-red-500/10 transition-colors"
              >
                <LogOut className="h-3.5 w-3.5" />
                Disconnect practice
              </button>
            )}
          </div>
        )}

        {showModal && (
          <ConnectModal onClose={() => setShowModal(false)} onConnected={() => setShowModal(false)} />
        )}
      </div>
    );
  }

  return (
    <>
      <button
        onClick={() => setShowModal(true)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-gray-800 border border-gray-700 text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition-colors"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-gray-500" />
        <WifiOff className="h-3 w-3" />
        <span className="hidden sm:inline">Connect T212</span>
      </button>
      {showModal && (
        <ConnectModal onClose={() => setShowModal(false)} onConnected={() => setShowModal(false)} />
      )}
    </>
  );
}

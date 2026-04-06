'use client';

import { useState, useRef, useEffect } from 'react';
import { Wifi, WifiOff, LogOut, ChevronDown } from 'lucide-react';
import { useClearGainsStore } from '@/lib/store';
import { ConnectModal } from './ConnectModal';
import { clsx } from 'clsx';

export function T212NavButton() {
  const {
    t212Connected,
    t212AccountType,
    t212AccountInfo,
    clearT212Credentials,
  } = useClearGainsStore();

  const [showModal, setShowModal] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  if (t212Connected) {
    return (
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setShowMenu((v) => !v)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 transition-colors"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <Wifi className="h-3 w-3" />
          <span className="hidden sm:inline">
            {t212AccountType === 'LIVE' ? 'Live' : 'Demo'}
            {t212AccountInfo?.id ? ` · ${t212AccountInfo.id.slice(0, 6)}` : ''}
          </span>
          <ChevronDown className={clsx('h-3 w-3 transition-transform', showMenu && 'rotate-180')} />
        </button>

        {showMenu && (
          <div className="absolute right-0 top-full mt-1.5 w-48 bg-gray-900 border border-gray-700 rounded-xl shadow-xl z-50 overflow-hidden">
            <div className="px-3 py-2 border-b border-gray-800">
              <p className="text-xs font-semibold text-emerald-400">T212 Connected</p>
              {t212AccountInfo && (
                <p className="text-[11px] text-gray-500 mt-0.5">
                  {t212AccountType} · {t212AccountInfo.currency}
                </p>
              )}
            </div>
            <button
              onClick={() => {
                setShowMenu(false);
                clearT212Credentials();
              }}
              className="w-full flex items-center gap-2 px-3 py-2.5 text-xs text-red-400 hover:bg-red-500/10 transition-colors"
            >
              <LogOut className="h-3.5 w-3.5" />
              Disconnect
            </button>
          </div>
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
        <ConnectModal
          onClose={() => setShowModal(false)}
          onConnected={() => setShowModal(false)}
        />
      )}
    </>
  );
}

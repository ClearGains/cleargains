'use client';

import { useState, useRef, useEffect } from 'react';
import { Wifi, WifiOff, LogOut, ChevronDown } from 'lucide-react';
import { useClearGainsStore } from '@/lib/store';
import { ConnectModal } from './ConnectModal';
import { clsx } from 'clsx';

export function T212NavButton() {
  const {
    t212Connected, t212AccountType, t212AccountInfo, clearT212Credentials,
    t212DemoConnected, t212DemoAccountInfo, clearT212DemoCredentials,
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

  const eitherConnected = t212Connected || t212DemoConnected;

  if (eitherConnected) {
    return (
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setShowMenu(v => !v)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-gray-800 border border-gray-700 text-gray-300 hover:bg-gray-700 transition-colors"
        >
          {/* Live indicator */}
          <span
            title={t212Connected ? `Live connected · ${t212AccountInfo?.currency ?? ''}` : 'Live not connected'}
            className={clsx('w-2 h-2 rounded-full flex-shrink-0', t212Connected ? 'bg-emerald-400 animate-pulse' : 'bg-gray-600')}
          />
          {/* Demo indicator */}
          <span
            title={t212DemoConnected ? `Demo connected · ${t212DemoAccountInfo?.currency ?? ''}` : 'Demo not connected'}
            className={clsx('w-2 h-2 rounded-full flex-shrink-0 -ml-1', t212DemoConnected ? 'bg-blue-400 animate-pulse' : 'bg-gray-600')}
          />
          <Wifi className="h-3 w-3" />
          <span className="hidden sm:inline">T212</span>
          <ChevronDown className={clsx('h-3 w-3 transition-transform', showMenu && 'rotate-180')} />
        </button>

        {showMenu && (
          <div className="absolute right-0 top-full mt-1.5 w-56 bg-gray-900 border border-gray-700 rounded-xl shadow-xl z-50 overflow-hidden">
            <div className="px-3 py-2 border-b border-gray-800">
              <p className="text-xs font-semibold text-gray-300 mb-1">Trading 212 Connections</p>
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className={clsx('w-1.5 h-1.5 rounded-full', t212Connected ? 'bg-emerald-400' : 'bg-gray-600')} />
                  <span className={t212Connected ? 'text-emerald-400' : 'text-gray-600'}>
                    Live {t212Connected ? `· ${t212AccountInfo?.currency ?? ''} · ${t212AccountType}` : '· not connected'}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className={clsx('w-1.5 h-1.5 rounded-full', t212DemoConnected ? 'bg-blue-400' : 'bg-gray-600')} />
                  <span className={t212DemoConnected ? 'text-blue-400' : 'text-gray-600'}>
                    Demo {t212DemoConnected ? `· ${t212DemoAccountInfo?.currency ?? ''}` : '· not connected'}
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

            {t212Connected && (
              <button
                onClick={() => { setShowMenu(false); clearT212Credentials(); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-400 hover:bg-red-500/10 transition-colors border-t border-gray-800"
              >
                <LogOut className="h-3.5 w-3.5" />
                Disconnect live
              </button>
            )}
            {t212DemoConnected && (
              <button
                onClick={() => { setShowMenu(false); clearT212DemoCredentials(); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-400 hover:bg-red-500/10 transition-colors"
              >
                <LogOut className="h-3.5 w-3.5" />
                Disconnect demo
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

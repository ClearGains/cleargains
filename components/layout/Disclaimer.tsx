'use client';

import { useState, useEffect } from 'react';
import { ShieldAlert } from 'lucide-react';

const DISCLAIMER_KEY = 'disclaimer_accepted';

export function Disclaimer() {
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    try {
      const accepted = localStorage.getItem(DISCLAIMER_KEY);
      if (!accepted) setShowModal(true);
    } catch {
      // localStorage unavailable
    }
  }, []);

  function handleAccept() {
    try {
      localStorage.setItem(DISCLAIMER_KEY, 'true');
    } catch {}
    setShowModal(false);
  }

  return (
    <>
      {/* First-login legal disclaimer modal */}
      {showModal && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl max-w-lg w-full p-7 space-y-5">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center flex-shrink-0">
                <ShieldAlert className="h-5 w-5 text-amber-400" />
              </div>
              <h2 className="text-lg font-bold text-white">Private Use Only</h2>
            </div>
            <p className="text-sm text-gray-300 leading-relaxed">
              <span className="font-semibold text-white">PRIVATE USE ONLY</span> — This tool is a private personal trading assistant for sole use by the account owner. It is not a financial service, investment platform, or advice service. It is not authorised or regulated by the FCA. All trading decisions are made solely by the account owner. By continuing you confirm you are the sole authorised user.
            </p>
            <button
              onClick={handleAccept}
              className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-xl py-3 text-sm transition-colors"
            >
              I confirm — Enter
            </button>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="border-t border-gray-800 bg-gray-950 px-4 py-3">
        <div className="max-w-7xl mx-auto text-center">
          <p className="text-xs text-gray-600">
            Private personal tool · Not FCA regulated · Not financial advice
          </p>
        </div>
      </div>
    </>
  );
}

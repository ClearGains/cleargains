'use client';

import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, AlertTriangle, AlertCircle, Info, X } from 'lucide-react';
import { clsx } from 'clsx';

type ToastType = 'success' | 'error' | 'warning' | 'info';

type ToastItem = {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration?: number; // ms, default 6000
};

type ToastContextValue = {
  addToast: (toast: Omit<ToastItem, 'id'>) => void;
};

const ToastContext = createContext<ToastContextValue>({ addToast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

function ToastEntry({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: string) => void }) {
  useEffect(() => {
    const t = setTimeout(() => onDismiss(toast.id), toast.duration ?? 6000);
    return () => clearTimeout(t);
  }, [toast.id, toast.duration, onDismiss]);

  const icons = {
    success: <CheckCircle2 className="h-4 w-4 text-emerald-400 flex-shrink-0" />,
    error: <AlertCircle className="h-4 w-4 text-red-400 flex-shrink-0" />,
    warning: <AlertTriangle className="h-4 w-4 text-amber-400 flex-shrink-0" />,
    info: <Info className="h-4 w-4 text-blue-400 flex-shrink-0" />,
  };
  const borders: Record<ToastType, string> = {
    success: 'border-emerald-500/30 bg-emerald-500/10',
    error: 'border-red-500/30 bg-red-500/10',
    warning: 'border-amber-500/30 bg-amber-500/10',
    info: 'border-blue-500/30 bg-blue-500/10',
  };
  const titleColors: Record<ToastType, string> = {
    success: 'text-emerald-300',
    error: 'text-red-300',
    warning: 'text-amber-300',
    info: 'text-blue-300',
  };

  return (
    <div className={clsx(
      'flex items-start gap-3 rounded-xl border px-4 py-3 shadow-xl backdrop-blur-sm max-w-sm w-full',
      'bg-gray-900', borders[toast.type],
    )}>
      <div className="mt-0.5">{icons[toast.type]}</div>
      <div className="flex-1 min-w-0">
        <p className={clsx('text-sm font-semibold', titleColors[toast.type])}>{toast.title}</p>
        {toast.message && <p className="text-xs text-gray-400 mt-0.5 break-words">{toast.message}</p>}
      </div>
      <button onClick={() => onDismiss(toast.id)} className="text-gray-600 hover:text-gray-400 flex-shrink-0">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  const addToast = useCallback((toast: Omit<ToastItem, 'id'>) => {
    const id = Math.random().toString(36).slice(2, 10);
    setToasts(prev => [...prev, { ...toast, id }].slice(-5));
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      {mounted && createPortal(
        <div className="fixed top-4 right-4 z-[99999] flex flex-col gap-2 pointer-events-none">
          {toasts.map(t => (
            <div key={t.id} className="pointer-events-auto">
              <ToastEntry toast={t} onDismiss={dismiss} />
            </div>
          ))}
        </div>,
        document.body
      )}
    </ToastContext.Provider>
  );
}

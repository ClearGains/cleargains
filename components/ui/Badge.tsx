import { clsx } from 'clsx';
import { ReactNode } from 'react';

type BadgeVariant =
  | 'buy'
  | 'sell'
  | 'hold'
  | 'pass'
  | 'warn'
  | 'fail'
  | 'isa'
  | 'manual'
  | 't212'
  | 'live'
  | 'demo'
  | 'default'
  | 'success'
  | 'danger'
  | 'info';

interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  className?: string;
}

const variantClasses: Record<BadgeVariant, string> = {
  buy: 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30',
  sell: 'bg-red-500/20 text-red-400 border border-red-500/30',
  hold: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
  pass: 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30',
  warn: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
  fail: 'bg-red-500/20 text-red-400 border border-red-500/30',
  isa: 'bg-blue-500/20 text-blue-400 border border-blue-500/30',
  manual: 'bg-gray-700/50 text-gray-400 border border-gray-600',
  t212: 'bg-purple-500/20 text-purple-400 border border-purple-500/30',
  live: 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30',
  demo: 'bg-orange-500/20 text-orange-400 border border-orange-500/30',
  default: 'bg-gray-700/50 text-gray-300 border border-gray-600',
  success: 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30',
  danger: 'bg-red-500/20 text-red-400 border border-red-500/30',
  info: 'bg-blue-500/20 text-blue-400 border border-blue-500/30',
};

export function Badge({ children, variant = 'default', className }: BadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium',
        variantClasses[variant],
        className
      )}
    >
      {children}
    </span>
  );
}

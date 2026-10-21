'use client';

// Slide-out menu for phones and narrower windows (below the xl breakpoint,
// where the desktop sidebar is hidden). It lists every page, grouped, so
// nothing disappears on a small screen.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { X, LogOut } from 'lucide-react';
import { clsx } from 'clsx';
import { NAV_GROUPS, NAV_LINKS, isActivePath } from './navLinks';

export function MobileMenu({ open, onClose, onLogout }: { open: boolean; onClose: () => void; onLogout: () => void }) {
  const pathname = usePathname();

  // Close after navigating, and stop the page behind from scrolling while open.
  useEffect(() => { onClose(); }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', onKey); };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="xl:hidden fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="Menu">
      <button aria-label="Close menu" onClick={onClose} className="absolute inset-0 bg-black/60" />
      <nav className="absolute left-0 top-0 h-full w-72 max-w-[85vw] bg-gray-950 border-r border-gray-800 flex flex-col
                      pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
        <div className="flex items-center justify-between px-4 h-14 border-b border-gray-800 flex-shrink-0">
          <span className="font-bold text-white">Clear<span className="text-emerald-400">Gains</span></span>
          <button onClick={onClose} aria-label="Close menu" className="p-2 -mr-2 rounded-lg text-gray-400 hover:text-gray-200 hover:bg-gray-800">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain px-3 py-3">
          {NAV_GROUPS.map(group => (
            <div key={group} className="mb-4">
              <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-600">{group}</div>
              {NAV_LINKS.filter(l => l.group === group).map(({ href, label, icon: Icon }) => {
                const active = isActivePath(pathname, href);
                return (
                  <Link
                    key={href}
                    href={href}
                    className={clsx(
                      'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium',
                      active ? 'bg-emerald-600/15 text-emerald-400' : 'text-gray-300 hover:bg-gray-800/60',
                    )}
                  >
                    <Icon className={clsx('h-4 w-4 flex-shrink-0', active ? 'text-emerald-400' : 'text-gray-500')} />
                    {label}
                  </Link>
                );
              })}
            </div>
          ))}
        </div>
        <button
          onClick={onLogout}
          className="flex items-center gap-2 mx-3 mb-3 px-3 py-2.5 rounded-lg text-sm text-gray-400 hover:text-red-400 hover:bg-red-500/10 border-t border-gray-800 flex-shrink-0"
        >
          <LogOut className="h-4 w-4" /> Sign out
        </button>
      </nav>
    </div>
  );
}

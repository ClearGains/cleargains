import type { Metadata } from 'next';
import { Geist } from 'next/font/google';
import './globals.css';
import { Navbar } from '@/components/layout/Navbar';
import { Sidebar } from '@/components/layout/Sidebar';
import { Disclaimer } from '@/components/layout/Disclaimer';
import { T212AutoConnect } from '@/components/t212/T212AutoConnect';
import { ToastProvider } from '@/components/ui/Toast';
import { TaxMonitorService } from '@/components/tax/TaxMonitorService';
import { SyncProvider } from '@/lib/syncContext';
import { SyncService } from '@/components/sync/SyncService';

const geist = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'ClearGains – Smart Portfolio & CGT Tracker',
  description:
    'ClearGains — educational trading portfolio tracker with CGT calculator, AI scanner, and tax guides for UK investors.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${geist.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-gray-950 text-gray-100">
        <SyncProvider>
        <ToastProvider>
          <T212AutoConnect />
          <TaxMonitorService />
          <SyncService />
          <Navbar />
          <div className="flex flex-1 min-h-0">
            <Sidebar />
            <main className="flex-1 min-w-0 flex flex-col">
              <div className="flex-1">{children}</div>
              <Disclaimer />
            </main>
          </div>
        </ToastProvider>
        </SyncProvider>
      </body>
    </html>
  );
}

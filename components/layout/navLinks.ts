// Every page in the app, in one place, so the desktop sidebar and the mobile
// menu can't drift apart. Before this, the mobile menu had its own 10-link
// list and none of the bot pages were reachable on a phone.
// `group` sets the section headings in the mobile menu. The desktop sidebar
// keeps this flat order.
import {
  LayoutDashboard, Search, BookOpen, Calculator, Receipt, ShieldCheck, Globe, Calendar, HelpCircle, Settings,
  FlaskConical, Bookmark, Newspaper, BarChart3, ScanLine, LineChart, TrendingUp, TrendingDown, Target, Hash,
  Bot, FileText, Star, Rocket, AlertTriangle, Gem, Scale, NotebookPen, Scissors, Flame, Brain,
  type LucideIcon,
} from 'lucide-react';

export type NavGroup = 'Bots & AI trading' | 'Portfolio' | 'Research & scanners' | 'Tax & tools' | 'Help';
export type NavLink = { href: string; label: string; icon: LucideIcon; group: NavGroup };

export const NAV_GROUPS: NavGroup[] = ['Bots & AI trading', 'Portfolio', 'Research & scanners', 'Tax & tools', 'Help'];

export const NAV_LINKS: NavLink[] = [
  { href: '/dashboard',        label: 'Dashboard',          icon: LayoutDashboard, group: 'Portfolio' },
  { href: '/positions',        label: 'Live Positions',     icon: BarChart3,       group: 'Portfolio' },
  { href: '/scanner',          label: 'AI Scanner',         icon: Search,          group: 'Research & scanners' },
  { href: '/penny-scanner',    label: 'Penny Scanner',      icon: ScanLine,        group: 'Research & scanners' },
  { href: '/graph-analysis',   label: 'Graph Analysis',     icon: LineChart,       group: 'Research & scanners' },
  { href: '/market-movers',    label: 'Market Movers',      icon: TrendingUp,      group: 'Research & scanners' },
  { href: '/market-depth',     label: 'Market Depth',       icon: Scale,           group: 'Research & scanners' },
  { href: '/overvalued',       label: 'Overvalued Stocks',  icon: AlertTriangle,   group: 'Research & scanners' },
  { href: '/undervalued',      label: 'Undervalued Stocks', icon: Gem,             group: 'Research & scanners' },
  { href: '/short-scanner',    label: 'Short Scanner',      icon: TrendingDown,    group: 'Research & scanners' },
  { href: '/auto-trader',      label: 'Auto Trader',        icon: Bot,             group: 'Bots & AI trading' },
  { href: '/alpaca-trader',    label: 'Alpaca Bot',         icon: Bot,             group: 'Bots & AI trading' },
  { href: '/t212-trader',      label: 'T212 ISA Bot',       icon: Bot,             group: 'Bots & AI trading' },
  { href: '/mean-reversion',   label: 'Mean Reversion',     icon: Bot,             group: 'Bots & AI trading' },
  { href: '/ig-options',       label: 'IG Options Bot',     icon: Bot,             group: 'Bots & AI trading' },
  { href: '/meme-coin-bot',    label: 'Meme Coin Bot',      icon: Flame,           group: 'Bots & AI trading' },
  { href: '/opus-trader',      label: 'Opus Trader',        icon: Brain,           group: 'Bots & AI trading' },
  { href: '/strategy-lab',     label: 'Strategy Lab',       icon: FlaskConical,    group: 'Bots & AI trading' },
  { href: '/backtest',         label: 'Backtest Lab',       icon: FlaskConical,    group: 'Bots & AI trading' },
  { href: '/bot-journal',      label: 'Bot Journal',        icon: NotebookPen,     group: 'Bots & AI trading' },
  { href: '/performance',      label: 'Bot Performance',    icon: BarChart3,       group: 'Bots & AI trading' },
  { href: '/reputable-stocks', label: 'Reputable Stocks',   icon: Star,            group: 'Research & scanners' },
  { href: '/future-leaders',   label: 'Future Leaders',     icon: Rocket,          group: 'Research & scanners' },
  { href: '/trade-log',        label: 'Trade Log',          icon: FileText,        group: 'Bots & AI trading' },
  { href: '/daily-brief',      label: 'Daily Brief',        icon: Target,          group: 'Portfolio' },
  { href: '/watchlist',        label: 'Watchlist',          icon: Bookmark,        group: 'Portfolio' },
  { href: '/world-affairs',    label: 'World Affairs',      icon: Newspaper,       group: 'Research & scanners' },
  { href: '/trading-guide',    label: 'Trading Guide',      icon: BookOpen,        group: 'Research & scanners' },
  { href: '/demo-trader',      label: 'Demo Trader',        icon: FlaskConical,    group: 'Bots & AI trading' },
  { href: '/ledger',           label: 'Trade Ledger',       icon: BookOpen,        group: 'Tax & tools' },
  { href: '/tax-monitor',      label: 'Tax Monitor',        icon: ShieldCheck,     group: 'Tax & tools' },
  { href: '/harvest',          label: 'Tax Harvesting',     icon: Scissors,        group: 'Tax & tools' },
  { href: '/calculator',       label: 'Calculator',         icon: Hash,            group: 'Tax & tools' },
  { href: '/cgt',              label: 'CGT Calculator',     icon: Calculator,      group: 'Tax & tools' },
  { href: '/tax-calculator',   label: 'Tax Calculator',     icon: Receipt,         group: 'Tax & tools' },
  { href: '/risk',             label: 'Risk Engine',        icon: ShieldCheck,     group: 'Tax & tools' },
  { href: '/tax-guides',       label: 'Tax Guides',         icon: Globe,           group: 'Tax & tools' },
  { href: '/deadlines',        label: 'Deadlines',          icon: Calendar,        group: 'Tax & tools' },
  { href: '/help',             label: 'Help Centre',        icon: HelpCircle,      group: 'Help' },
  { href: '/settings',         label: 'Settings',           icon: Settings,        group: 'Help' },
];

export const isActivePath = (pathname: string, href: string) => pathname === href || pathname.startsWith(href + '/');

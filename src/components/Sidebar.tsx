'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

interface NavItem {
  label: string;
  href: string;
  children?: { label: string; href: string }[];
}

const NAV: NavItem[] = [
  { label: 'Dashboard', href: '/' },
  {
    label: 'Sales',
    href: '/sales/invoices',
    children: [
      { label: 'Invoices', href: '/sales/invoices' },
      { label: 'Customers', href: '/sales/customers' },
      { label: 'Products & services', href: '/sales/items' },
    ],
  },
  {
    label: 'Expenses',
    href: '/expenses/bills',
    children: [
      { label: 'Bills', href: '/expenses/bills' },
      { label: 'Expenses', href: '/expenses/list' },
      { label: 'Vendors', href: '/expenses/vendors' },
    ],
  },
  {
    label: 'Accounting',
    href: '/accounting/chart-of-accounts',
    children: [
      { label: 'Chart of accounts', href: '/accounting/chart-of-accounts' },
      { label: 'Journal entries', href: '/accounting/journal' },
      { label: 'New journal entry', href: '/accounting/journal/new' },
    ],
  },
  {
    label: 'Reports',
    href: '/reports',
    children: [
      { label: 'All reports', href: '/reports' },
      { label: 'Profit & loss', href: '/reports/profit-loss' },
      { label: 'Balance sheet', href: '/reports/balance-sheet' },
      { label: 'Trial balance', href: '/reports/trial-balance' },
      { label: 'A/R & A/P ageing', href: '/reports/ageing' },
    ],
  },
  { label: 'On-chain', href: '/onchain' },
  {
    label: 'Planning',
    href: '/planning',
    children: [
      { label: 'Plans', href: '/planning' },
      { label: 'Close & roll-forward', href: '/planning/close' },
    ],
  },
  { label: 'Standards', href: '/standards' },
  { label: 'Consolidation', href: '/consolidation' },
  { label: 'Assistant', href: '/assistant' },
];

export default function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState<string | null>(() => {
    const match = NAV.find((n) => n.children?.some((c) => pathname.startsWith(c.href)));
    return match?.label ?? null;
  });

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  return (
    <nav className="flex h-full w-56 shrink-0 flex-col bg-nav text-white/90">
      <div className="flex items-center gap-2 px-5 py-5">
        <div className="flex h-8 w-8 items-center justify-center rounded bg-brand text-sm font-black text-white">L</div>
        <div>
          <div className="text-sm font-bold leading-tight text-white">Ledgerly</div>
          <div className="text-xxs leading-tight text-white/50">AI-assisted accounting</div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-6">
        {NAV.map((item) => {
          const active = isActive(item.href);
          const expanded = open === item.label;
          return (
            <div key={item.label}>
              {item.children ? (
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : item.label)}
                  className={`flex w-full items-center justify-between px-5 py-2.5 text-left text-sm transition-colors hover:bg-nav-hover ${
                    active ? 'border-l-4 border-brand bg-nav-hover pl-4 font-semibold text-white' : ''
                  }`}
                >
                  {item.label}
                  <span className={`text-xxs transition-transform ${expanded ? 'rotate-90' : ''}`}>›</span>
                </button>
              ) : (
                <Link
                  href={item.href}
                  className={`block px-5 py-2.5 text-sm transition-colors hover:bg-nav-hover ${
                    active ? 'border-l-4 border-brand bg-nav-hover pl-4 font-semibold text-white' : ''
                  }`}
                >
                  {item.label}
                </Link>
              )}

              {item.children && expanded && (
                <div className="bg-black/15 py-1">
                  {item.children.map((child) => (
                    <Link
                      key={child.href}
                      href={child.href}
                      className={`block py-1.5 pl-9 pr-5 text-xs transition-colors hover:text-white ${
                        pathname === child.href ? 'font-semibold text-brand' : 'text-white/70'
                      }`}
                    >
                      {child.label}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="border-t border-white/10 px-5 py-3 text-xxs leading-relaxed text-white/40">
        The AI proposes.
        <br />
        The ledger validates.
        <br />
        A human posts.
      </div>
    </nav>
  );
}

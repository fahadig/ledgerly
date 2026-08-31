import Link from 'next/link';
import { PageHeader } from '@/components/ui';

const REPORTS = [
  { href: '/reports/profit-loss', title: 'Profit and loss', desc: 'Income, cost of sales, operating expenses and the result for the period.' },
  { href: '/reports/balance-sheet', title: 'Balance sheet', desc: 'Assets, liabilities and equity at a point in time. Must balance to the penny.' },
  { href: '/reports/trial-balance', title: 'Trial balance', desc: 'Every account, its net side, and proof the ledger is square.' },
  { href: '/reports/ageing', title: 'A/R and A/P ageing', desc: 'Who owes you, who you owe, and how late everything is.' },
  { href: '/consolidation', title: 'Group consolidation', desc: 'Aggregate, translate, eliminate intercompany, allocate non-controlling interests.' },
  { href: '/standards', title: 'Standards rule-set', desc: 'The IFRS and US GAAP rules the assistant reasons from, and where they diverge.' },
];

export default function ReportsPage() {
  return (
    <>
      <PageHeader title="Reports" subtitle="Every figure below is read from the general ledger, never from a cached total." />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {REPORTS.map((r) => (
          <Link key={r.href} href={r.href} className="card p-5 transition-shadow hover:shadow-md">
            <h3 className="text-base font-semibold text-brand-dark">{r.title}</h3>
            <p className="mt-1.5 text-sm text-ink-muted">{r.desc}</p>
          </Link>
        ))}
      </div>
    </>
  );
}

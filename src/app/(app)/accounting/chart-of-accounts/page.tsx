import { getCompany } from '@/lib/company';
import { accountMovements } from '@/lib/reports';
import { fmt } from '@/lib/format';
import { Card, PageHeader } from '@/components/ui';
import type { AccountType } from '@/db/schema';

const GROUPS: { type: AccountType; label: string }[] = [
  { type: 'ASSET', label: 'Assets' },
  { type: 'LIABILITY', label: 'Liabilities' },
  { type: 'EQUITY', label: 'Equity' },
  { type: 'INCOME', label: 'Income' },
  { type: 'EXPENSE', label: 'Expenses' },
];

export default async function ChartOfAccountsPage() {
  const company = await getCompany();
  const rows = await accountMovements(company.id, { to: new Date(), includeZero: true });

  return (
    <>
      <PageHeader
        title="Chart of accounts"
        subtitle="Balances are read straight from the general ledger — nothing here is cached or derived from a sub-ledger."
      />

      <div className="space-y-5">
        {GROUPS.map((g) => {
          const list = rows.filter((r) => r.type === g.type);
          if (!list.length) return null;
          const total = list.reduce((s, r) => s + r.balance, 0);

          return (
            <Card
              key={g.type}
              title={g.label}
              action={<span className="tabular text-sm font-semibold">{fmt(total, company.currency)}</span>}
            >
              <table className="table">
                <thead>
                  <tr>
                    <th className="w-24">Code</th>
                    <th>Name</th>
                    <th>Detail type</th>
                    <th className="num">Debits</th>
                    <th className="num">Credits</th>
                    <th className="num">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((a) => (
                    <tr key={a.accountId}>
                      <td className="tabular text-ink-muted">{a.code}</td>
                      <td className="font-medium">{a.name}</td>
                      <td className="text-xs text-ink-muted">{a.subtype.replaceAll('_', ' ').toLowerCase()}</td>
                      <td className="num text-ink-muted">{a.debit ? fmt(a.debit, company.currency) : '—'}</td>
                      <td className="num text-ink-muted">{a.credit ? fmt(a.credit, company.currency) : '—'}</td>
                      <td className="num font-semibold">{fmt(a.balance, company.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          );
        })}
      </div>
    </>
  );
}

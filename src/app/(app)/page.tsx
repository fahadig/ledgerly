import Link from 'next/link';
import { getCompany } from '@/lib/company';
import { dashboard } from '@/lib/reports';
import { recurringPatterns } from '@/lib/ai/patterns';
import { fmt, monthLabel, shortDate } from '@/lib/format';
import { BarSeries, Card, EmptyState, PageHeader, StatTile } from '@/components/ui';

export default async function DashboardPage() {
  const company = await getCompany();
  const cur = company.currency;
  const [data, recurring] = await Promise.all([
    dashboard(company.id, new Date(), company.fiscalYearStartMonth),
    recurringPatterns(company.id),
  ]);

  const dueSoon = recurring.filter((r) => r.overdueDays > 0).slice(0, 5);

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`Year to date, prepared under ${company.framework === 'US_GAAP' ? 'US GAAP' : 'IFRS'} in ${company.functionalCurrency}.`}
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Bank balance" value={fmt(data.bankBalance, cur)} tone={data.bankBalance >= 0 ? 'neutral' : 'bad'} />
        <StatTile
          label="Owed to you"
          value={fmt(data.arOutstanding, cur)}
          hint={data.arOverdue > 0 ? `${fmt(data.arOverdue, cur)} overdue` : 'nothing overdue'}
          tone={data.arOverdue > 0 ? 'warn' : 'neutral'}
          href="/reports/ageing"
        />
        <StatTile
          label="You owe"
          value={fmt(data.apOutstanding, cur)}
          hint={data.apOverdue > 0 ? `${fmt(data.apOverdue, cur)} overdue` : 'nothing overdue'}
          tone={data.apOverdue > 0 ? 'warn' : 'neutral'}
          href="/reports/ageing"
        />
        <StatTile
          label="Profit year to date"
          value={fmt(data.netIncomeYTD, cur)}
          hint={`${fmt(data.incomeYTD, cur)} income · ${fmt(data.expensesYTD, cur)} costs`}
          tone={data.netIncomeYTD >= 0 ? 'good' : 'bad'}
          href="/reports/profit-loss"
        />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-3">
        <Card
          title="Income and expenses"
          className="xl:col-span-2"
          action={
            <Link href="/reports/profit-loss" className="text-xs font-semibold text-brand-dark hover:underline">
              Profit &amp; loss →
            </Link>
          }
        >
          <BarSeries
            currency={cur}
            data={data.monthly.map((m) => ({ label: monthLabel(m.month), income: m.income, expenses: m.expenses }))}
          />
        </Card>

        <Card title="Where the money goes">
          {data.expenseMix.length === 0 ? (
            <EmptyState title="No expenses yet" />
          ) : (
            <div className="px-5 py-4">
              {data.expenseMix.map((e) => {
                const max = data.expenseMix[0].amount || 1;
                return (
                  <div key={e.name} className="mb-3 last:mb-0">
                    <div className="flex justify-between text-xs">
                      <span className="truncate pr-2 text-ink">{e.name}</span>
                      <span className="tabular font-semibold text-ink">{fmt(e.amount, cur)}</span>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full bg-surface">
                      <div className="h-1.5 rounded-full bg-brand" style={{ width: `${(e.amount / max) * 100}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      <div className="mt-5">
        <Card
          title="Recurring costs the assistant expects"
          action={<span className="text-xxs text-ink-muted">Detected from the ledger — no model involved</span>}
        >
          {dueSoon.length === 0 ? (
            <EmptyState
              title="Nothing overdue"
              hint="Every recurring cost the ledger knows about has been entered for the expected period."
            />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th>Usually booked to</th>
                  <th>Cadence</th>
                  <th className="num">Typical amount</th>
                  <th>Last seen</th>
                  <th>Expected</th>
                  <th className="num">Days late</th>
                </tr>
              </thead>
              <tbody>
                {dueSoon.map((r) => (
                  <tr key={`${r.contactId}-${r.accountId}`}>
                    <td className="font-medium">{r.contactName}</td>
                    <td className="text-ink-muted">{r.accountName}</td>
                    <td className="text-ink-muted">{r.cadence}</td>
                    <td className="num">{fmt(r.medianAmountCents, cur)}</td>
                    <td className="text-ink-muted">{shortDate(r.lastDate)}</td>
                    <td className="text-ink-muted">{shortDate(r.expectedNext)}</td>
                    <td className="num font-semibold text-amber-700">{r.overdueDays}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}

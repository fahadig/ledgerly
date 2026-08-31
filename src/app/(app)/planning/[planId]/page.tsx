import Link from 'next/link';
import { getAccess } from '@/lib/company';
import { budgetVsActual, companyDimensions, monthKey } from '@/lib/fpa';
import { fiscalYearStart } from '@/lib/reports';
import { fmt, monthLabel } from '@/lib/format';
import { Card, PageHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function BudgetVsActualPage({
  params,
  searchParams,
}: {
  params: Promise<{ planId: string }>;
  searchParams: Promise<{ dept?: string }>;
}) {
  const { planId } = await params;
  const { dept } = await searchParams;
  const { company } = await getAccess();
  const cur = company.currency;

  const to = new Date();
  const from = fiscalYearStart(to, company.fiscalYearStartMonth);

  const [dims, report] = await Promise.all([
    companyDimensions(company.id),
    budgetVsActual({ companyId: company.id, planId, from, to, dimensionValueId: dept ?? null }),
  ]);

  const deptDim = dims.find((d) => d.code === 'DEPT');
  const income = report.rows.filter((r) => r.type === 'INCOME');
  const expense = report.rows.filter((r) => r.type === 'EXPENSE');

  const varianceCell = (favourable: number) => {
    if (favourable === 0) return 'text-ink-muted';
    return favourable > 0 ? 'text-brand-dark' : 'text-red-700';
  };

  const Section = ({ title, rows }: { title: string; rows: typeof report.rows }) => (
    <>
      <tr className="bg-surface">
        <td colSpan={report.months.length + 5} className="text-xs font-bold uppercase tracking-wide text-ink-muted">
          {title}
        </td>
      </tr>
      {rows.map((r) => (
        <tr key={r.accountId}>
          <td className="whitespace-nowrap">
            <span className="tabular text-ink-muted">{r.code}</span> {r.name}
          </td>
          {report.months.map((m) => (
            <td key={m} className="num text-ink-muted">
              {r.months[m]?.actual ? fmt(r.months[m].actual, cur) : '—'}
            </td>
          ))}
          <td className="num">{fmt(r.budget, cur)}</td>
          <td className="num font-medium">{fmt(r.actual, cur)}</td>
          <td className={`num font-semibold ${varianceCell(r.favourable)}`}>{fmt(r.variance, cur)}</td>
          <td className={`num text-xs ${varianceCell(r.favourable)}`}>
            {r.variancePct === null ? '—' : `${r.variancePct > 0 ? '+' : ''}${r.variancePct.toFixed(0)}%`}
          </td>
        </tr>
      ))}
    </>
  );

  return (
    <>
      <PageHeader
        title={report.planName}
        subtitle={
          <>
            Budget versus actual, {monthKey(from)} to {monthKey(to)}. Months read across (horizontal); accounts and
            departments read down (vertical). Green is better than plan, red is worse — for income and expenses alike.
          </>
        }
        action={
          <Link href="/planning" className="btn-secondary">
            All plans
          </Link>
        }
      />

      {deptDim && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-xxs font-bold uppercase tracking-wide text-ink-muted">Department</span>
          <Link
            href={`/planning/${planId}`}
            className={`rounded-full border px-3 py-1 text-xs ${!dept ? 'border-brand bg-brand text-white' : 'border-line text-ink-muted hover:border-brand'}`}
          >
            All
          </Link>
          {deptDim.values.map((v) => (
            <Link
              key={v.id}
              href={`/planning/${planId}?dept=${v.id}`}
              className={`rounded-full border px-3 py-1 text-xs ${dept === v.id ? 'border-brand bg-brand text-white' : 'border-line text-ink-muted hover:border-brand'}`}
            >
              {v.name}
            </Link>
          ))}
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="card px-5 py-4">
          <div className="text-xxs font-bold uppercase tracking-wide text-ink-muted">Income vs budget</div>
          <div className="mt-1 tabular text-xl font-semibold">{fmt(report.totals.incomeActual, cur)}</div>
          <div className="text-xs text-ink-muted">budget {fmt(report.totals.incomeBudget, cur)}</div>
        </div>
        <div className="card px-5 py-4">
          <div className="text-xxs font-bold uppercase tracking-wide text-ink-muted">Costs vs budget</div>
          <div className="mt-1 tabular text-xl font-semibold">{fmt(report.totals.expenseActual, cur)}</div>
          <div className="text-xs text-ink-muted">budget {fmt(report.totals.expenseBudget, cur)}</div>
        </div>
        <div className="card px-5 py-4">
          <div className="text-xxs font-bold uppercase tracking-wide text-ink-muted">Profit — plan</div>
          <div className="mt-1 tabular text-xl font-semibold">{fmt(report.totals.profitBudget, cur)}</div>
        </div>
        <div className="card px-5 py-4">
          <div className="text-xxs font-bold uppercase tracking-wide text-ink-muted">Profit — actual</div>
          <div
            className={`mt-1 tabular text-xl font-semibold ${
              report.totals.profitActual >= report.totals.profitBudget ? 'text-brand-dark' : 'text-red-700'
            }`}
          >
            {fmt(report.totals.profitActual, cur)}
          </div>
        </div>
      </div>

      <Card>
        <div className="table-scroll overflow-x-auto">
          <table className="table" style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <th className="whitespace-nowrap">Account</th>
                {report.months.map((m) => (
                  <th key={m} className="num">
                    {monthLabel(m)}
                  </th>
                ))}
                <th className="num">Budget</th>
                <th className="num">Actual</th>
                <th className="num">Variance</th>
                <th className="num">%</th>
              </tr>
            </thead>
            <tbody>
              <Section title="Income" rows={income} />
              <Section title="Costs" rows={expense} />
              <tr className="bg-brand/10 font-bold">
                <td>Profit</td>
                {report.months.map((m) => {
                  const inc = income.reduce((s, r) => s + (r.months[m]?.actual ?? 0), 0);
                  const exp = expense.reduce((s, r) => s + (r.months[m]?.actual ?? 0), 0);
                  return (
                    <td key={m} className="num">
                      {fmt(inc - exp, cur)}
                    </td>
                  );
                })}
                <td className="num">{fmt(report.totals.profitBudget, cur)}</td>
                <td className="num">{fmt(report.totals.profitActual, cur)}</td>
                <td className="num">{fmt(report.totals.profitActual - report.totals.profitBudget, cur)}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

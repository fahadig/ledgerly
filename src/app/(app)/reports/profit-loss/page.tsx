import Link from 'next/link';
import { getCompany } from '@/lib/company';
import { fiscalYearStart, profitAndLoss, type PLSection } from '@/lib/reports';
import { companyDimensions } from '@/lib/fpa';
import { fmt, shortDate } from '@/lib/format';
import { Card, PageHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

function Section({ section, currency }: { section: PLSection; currency: string }) {
  if (!section.rows.length) return null;
  return (
    <>
      <tr className="bg-surface">
        <td colSpan={2} className="text-xs font-bold uppercase tracking-wide text-ink-muted">
          {section.title}
        </td>
      </tr>
      {section.rows.map((r) => (
        <tr key={r.accountId}>
          <td className="pl-8">
            <span className="tabular text-ink-muted">{r.code}</span> {r.name}
          </td>
          <td className="num">{fmt(r.balance, currency)}</td>
        </tr>
      ))}
      <tr>
        <td className="pl-8 font-semibold">Total {section.title.toLowerCase()}</td>
        <td className="num border-t border-ink-light font-semibold">{fmt(section.total, currency)}</td>
      </tr>
    </>
  );
}

export default async function ProfitLossPage({
  searchParams,
}: {
  searchParams: Promise<{ dept?: string }>;
}) {
  const { dept } = await searchParams;
  const company = await getCompany();
  const to = new Date();
  const from = fiscalYearStart(to, company.fiscalYearStartMonth);
  const cur = company.currency;

  const [dims, pl] = await Promise.all([
    companyDimensions(company.id),
    profitAndLoss(company.id, from, to, dept ?? null),
  ]);

  const deptDim = dims.find((d) => d.code === 'DEPT');
  const activeName = deptDim?.values.find((v) => v.id === dept)?.name;

  return (
    <>
      <PageHeader
        title="Profit and loss"
        subtitle={`${company.name}${activeName ? ` · ${activeName}` : ''} · ${shortDate(from)} to ${shortDate(to)} · ${
          company.framework === 'US_GAAP' ? 'US GAAP' : 'IFRS'
        } · ${cur}`}
      />

      {deptDim && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-xxs font-bold uppercase tracking-wide text-ink-muted">{deptDim.name}</span>
          <Link
            href="/reports/profit-loss"
            className={`rounded-full border px-3 py-1 text-xs ${
              !dept ? 'border-brand bg-brand text-white' : 'border-line text-ink-muted hover:border-brand'
            }`}
          >
            All
          </Link>
          {deptDim.values.map((v) => (
            <Link
              key={v.id}
              href={`/reports/profit-loss?dept=${v.id}`}
              className={`rounded-full border px-3 py-1 text-xs ${
                dept === v.id ? 'border-brand bg-brand text-white' : 'border-line text-ink-muted hover:border-brand'
              }`}
            >
              {v.name}
            </Link>
          ))}
        </div>
      )}

      {dept && (
        <p className="mb-4 max-w-3xl text-xs text-ink-muted">
          Showing only lines tagged to this department. Untagged lines — interest, tax, anything posted without a
          department — are excluded, so departmental figures will not add up to the company total.
        </p>
      )}

      <Card>
        <table className="table">
          <thead>
            <tr>
              <th>Account</th>
              <th className="num w-48">{to.getUTCFullYear()} year to date</th>
            </tr>
          </thead>
          <tbody>
            <Section section={pl.income} currency={cur} />
            <Section section={pl.cogs} currency={cur} />
            <tr className="bg-surface">
              <td className="font-bold">Gross profit</td>
              <td className="num font-bold">{fmt(pl.grossProfit, cur)}</td>
            </tr>
            <Section section={pl.expenses} currency={cur} />
            <tr className="bg-surface">
              <td className="font-bold">Operating profit</td>
              <td className="num font-bold">{fmt(pl.operatingIncome, cur)}</td>
            </tr>
            <Section section={pl.otherIncome} currency={cur} />
            <Section section={pl.otherExpense} currency={cur} />
            <tr className="bg-brand/10">
              <td className="text-base font-bold">Profit for the period</td>
              <td className={`num text-base font-bold ${pl.netIncome >= 0 ? 'text-brand-dark' : 'text-red-700'}`}>
                {fmt(pl.netIncome, cur)}
              </td>
            </tr>
          </tbody>
        </table>
      </Card>
    </>
  );
}

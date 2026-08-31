import { getCompany } from '@/lib/company';
import { balanceSheet, type PLSection } from '@/lib/reports';
import { fmt, shortDate } from '@/lib/format';
import { Card, PageHeader } from '@/components/ui';

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

export default async function BalanceSheetPage() {
  const company = await getCompany();
  const asOf = new Date();
  const bs = await balanceSheet(company.id, asOf, company.fiscalYearStartMonth);
  const cur = company.currency;

  return (
    <>
      <PageHeader
        title="Balance sheet"
        subtitle={`${company.name} as at ${shortDate(asOf)} · ${company.framework === 'US_GAAP' ? 'US GAAP' : 'IFRS'} · ${cur}`}
      />

      <div
        className={`mb-4 rounded border px-4 py-3 text-sm ${
          bs.difference === 0 ? 'border-brand bg-green-50 text-brand-dark' : 'border-red-400 bg-red-50 text-red-800'
        }`}
      >
        {bs.difference === 0
          ? 'Assets equal liabilities plus equity.'
          : `Does not balance — out by ${fmt(bs.difference, cur)}.`}
      </div>

      <Card>
        <table className="table">
          <thead>
            <tr>
              <th>Account</th>
              <th className="num w-48">As at {shortDate(asOf)}</th>
            </tr>
          </thead>
          <tbody>
            <Section section={bs.currentAssets} currency={cur} />
            <Section section={bs.fixedAssets} currency={cur} />
            <Section section={bs.otherAssets} currency={cur} />
            <tr className="bg-brand/10">
              <td className="font-bold">Total assets</td>
              <td className="num font-bold">{fmt(bs.totalAssets, cur)}</td>
            </tr>

            <Section section={bs.currentLiabilities} currency={cur} />
            <Section section={bs.longTermLiabilities} currency={cur} />
            <tr className="bg-surface">
              <td className="font-bold">Total liabilities</td>
              <td className="num font-bold">{fmt(bs.totalLiabilities, cur)}</td>
            </tr>

            <Section section={bs.equity} currency={cur} />
            <tr>
              <td className="pl-8">Retained earnings brought forward</td>
              <td className="num">{fmt(bs.retainedEarningsBrought, cur)}</td>
            </tr>
            <tr>
              <td className="pl-8">Profit for the period</td>
              <td className="num">{fmt(bs.netIncome, cur)}</td>
            </tr>
            <tr className="bg-surface">
              <td className="font-bold">Total equity</td>
              <td className="num font-bold">{fmt(bs.totalEquity, cur)}</td>
            </tr>

            <tr className="bg-brand/10">
              <td className="text-base font-bold">Total liabilities and equity</td>
              <td className="num text-base font-bold">{fmt(bs.totalLiabilitiesAndEquity, cur)}</td>
            </tr>
          </tbody>
        </table>
      </Card>
    </>
  );
}

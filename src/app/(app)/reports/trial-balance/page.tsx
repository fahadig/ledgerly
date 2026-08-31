import { getCompany } from '@/lib/company';
import { trialBalance } from '@/lib/reports';
import { fmt, shortDate } from '@/lib/format';
import { Card, PageHeader } from '@/components/ui';

export default async function TrialBalancePage() {
  const company = await getCompany();
  const asOf = new Date();
  const tb = await trialBalance(company.id, asOf);
  const cur = company.currency;

  return (
    <>
      <PageHeader
        title="Trial balance"
        subtitle={`${company.name} as at ${shortDate(asOf)} · ${company.framework === 'US_GAAP' ? 'US GAAP' : 'IFRS'} · ${cur}`}
      />

      <div
        className={`mb-4 rounded border px-4 py-3 text-sm ${
          tb.outOfBalance === 0 ? 'border-brand bg-green-50 text-brand-dark' : 'border-red-400 bg-red-50 text-red-800'
        }`}
      >
        {tb.outOfBalance === 0
          ? 'Debits equal credits. The ledger is square.'
          : `Out of balance by ${fmt(tb.outOfBalance, cur)} — something bypassed the posting engine.`}
      </div>

      <Card>
        <table className="table">
          <thead>
            <tr>
              <th className="w-24">Code</th>
              <th>Account</th>
              <th className="num">Debit</th>
              <th className="num">Credit</th>
            </tr>
          </thead>
          <tbody>
            {tb.rows.map((r) => (
              <tr key={r.accountId}>
                <td className="tabular text-ink-muted">{r.code}</td>
                <td>{r.name}</td>
                <td className="num">{r.debit ? fmt(r.debit, cur) : ''}</td>
                <td className="num">{r.credit ? fmt(r.credit, cur) : ''}</td>
              </tr>
            ))}
            <tr className="bg-surface font-bold">
              <td colSpan={2} className="text-right uppercase tracking-wide text-xs text-ink-muted">
                Total
              </td>
              <td className="num">{fmt(tb.totalDebit, cur)}</td>
              <td className="num">{fmt(tb.totalCredit, cur)}</td>
            </tr>
          </tbody>
        </table>
      </Card>
    </>
  );
}

import { getCompany } from '@/lib/company';
import { aging, type AgingRow } from '@/lib/reports';
import { fmt } from '@/lib/format';
import { Card, EmptyState, PageHeader } from '@/components/ui';

function AgeingTable({ rows, currency, label }: { rows: AgingRow[]; currency: string; label: string }) {
  if (!rows.length) return <EmptyState title={`Nothing outstanding in ${label.toLowerCase()}`} />;
  const total = (fn: (r: AgingRow) => number) => rows.reduce((s, r) => s + fn(r), 0);

  return (
    <table className="table">
      <thead>
        <tr>
          <th>{label}</th>
          <th className="num">Current</th>
          <th className="num">1–30 days</th>
          <th className="num">31–60</th>
          <th className="num">61–90</th>
          <th className="num">90+</th>
          <th className="num">Total</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.contactId}>
            <td className="font-medium">{r.contactName}</td>
            <td className="num">{r.current ? fmt(r.current, currency) : '—'}</td>
            <td className="num">{r.d1_30 ? fmt(r.d1_30, currency) : '—'}</td>
            <td className="num">{r.d31_60 ? fmt(r.d31_60, currency) : '—'}</td>
            <td className="num text-amber-800">{r.d61_90 ? fmt(r.d61_90, currency) : '—'}</td>
            <td className="num text-red-700">{r.d90plus ? fmt(r.d90plus, currency) : '—'}</td>
            <td className="num font-semibold">{fmt(r.total, currency)}</td>
          </tr>
        ))}
        <tr className="bg-surface font-bold">
          <td>Total</td>
          <td className="num">{fmt(total((r) => r.current), currency)}</td>
          <td className="num">{fmt(total((r) => r.d1_30), currency)}</td>
          <td className="num">{fmt(total((r) => r.d31_60), currency)}</td>
          <td className="num">{fmt(total((r) => r.d61_90), currency)}</td>
          <td className="num">{fmt(total((r) => r.d90plus), currency)}</td>
          <td className="num">{fmt(total((r) => r.total), currency)}</td>
        </tr>
      </tbody>
    </table>
  );
}

export default async function AgeingPage() {
  const company = await getCompany();
  const [ar, ap] = await Promise.all([aging(company.id, 'AR'), aging(company.id, 'AP')]);

  return (
    <>
      <PageHeader
        title="Ageing"
        subtitle="Buckets are measured from the due date, not the invoice date — which is what a credit controller actually needs."
      />
      <div className="space-y-5">
        <Card title="Accounts receivable — who owes you">
          <AgeingTable rows={ar} currency={company.currency} label="Customer" />
        </Card>
        <Card title="Accounts payable — who you owe">
          <AgeingTable rows={ap} currency={company.currency} label="Vendor" />
        </Card>
      </div>
    </>
  );
}

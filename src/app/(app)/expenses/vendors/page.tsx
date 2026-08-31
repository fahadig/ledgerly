import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { getCompany } from '@/lib/company';
import { fmt } from '@/lib/format';
import { Card, EmptyState, PageHeader } from '@/components/ui';

export default async function VendorsPage() {
  const company = await getCompany();

  const rows = await db.execute(sql`
    SELECT c.id, c.display_name, c.email, c.terms_days, c.related_company_id,
           COUNT(b.id)::int                                AS bill_count,
           COALESCE(SUM(b.total_cents), 0)                 AS billed,
           COALESCE(SUM(b.total_cents - b.paid_cents), 0)  AS outstanding
    FROM contacts c
    LEFT JOIN bills b ON b.vendor_id = c.id
    WHERE c.company_id = ${company.id} AND c.kind IN ('VENDOR','BOTH')
    GROUP BY c.id
    ORDER BY billed DESC
  `);

  const list = rows.rows as unknown as {
    id: string;
    display_name: string;
    email: string | null;
    terms_days: number;
    related_company_id: string | null;
    bill_count: number;
    billed: number;
    outstanding: number;
  }[];

  return (
    <>
      <PageHeader title="Vendors" subtitle={`${list.length} vendors.`} />
      <Card>
        {list.length === 0 ? (
          <EmptyState title="No vendors yet" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Vendor</th>
                <th>Email</th>
                <th className="num">Terms</th>
                <th className="num">Bills</th>
                <th className="num">Spend</th>
                <th className="num">Unpaid</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id}>
                  <td className="font-medium">
                    {c.display_name}
                    {c.related_company_id && <span className="badge-neutral ml-2">Intercompany</span>}
                  </td>
                  <td className="text-ink-muted">{c.email ?? '—'}</td>
                  <td className="num text-ink-muted">{c.terms_days} days</td>
                  <td className="num">{c.bill_count}</td>
                  <td className="num">{fmt(Number(c.billed), company.currency)}</td>
                  <td className="num font-semibold">{fmt(Number(c.outstanding), company.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

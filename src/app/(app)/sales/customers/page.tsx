import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { contacts } from '@/db/schema';
import { getCompany } from '@/lib/company';
import { fmt } from '@/lib/format';
import { Card, EmptyState, PageHeader } from '@/components/ui';

export default async function CustomersPage() {
  const company = await getCompany();

  const rows = await db.execute(sql`
    SELECT c.id, c.display_name, c.email, c.terms_days, c.related_company_id,
           COUNT(i.id)::int                                   AS invoice_count,
           COALESCE(SUM(i.total_cents), 0)                    AS billed,
           COALESCE(SUM(i.total_cents - i.paid_cents), 0)     AS outstanding
    FROM contacts c
    LEFT JOIN invoices i ON i.customer_id = c.id
    WHERE c.company_id = ${company.id} AND c.kind IN ('CUSTOMER','BOTH')
    GROUP BY c.id
    ORDER BY outstanding DESC, billed DESC
  `);

  const list = rows.rows as unknown as {
    id: string;
    display_name: string;
    email: string | null;
    terms_days: number;
    related_company_id: string | null;
    invoice_count: number;
    billed: number;
    outstanding: number;
  }[];

  return (
    <>
      <PageHeader title="Customers" subtitle={`${list.length} customers.`} />
      <Card>
        {list.length === 0 ? (
          <EmptyState title="No customers yet" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Email</th>
                <th className="num">Terms</th>
                <th className="num">Invoices</th>
                <th className="num">Billed</th>
                <th className="num">Outstanding</th>
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
                  <td className="num">{c.invoice_count}</td>
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

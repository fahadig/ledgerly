import { desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { contacts, invoices } from '@/db/schema';
import { getCompany } from '@/lib/company';
import { fmt, shortDate, statusClass } from '@/lib/format';
import { Card, EmptyState, PageHeader } from '@/components/ui';

export default async function InvoicesPage() {
  const company = await getCompany();
  const rows = await db
    .select({
      id: invoices.id,
      number: invoices.number,
      date: invoices.date,
      dueDate: invoices.dueDate,
      status: invoices.status,
      totalCents: invoices.totalCents,
      paidCents: invoices.paidCents,
      aiAssisted: invoices.aiAssisted,
      customer: contacts.displayName,
    })
    .from(invoices)
    .innerJoin(contacts, eq(contacts.id, invoices.customerId))
    .where(eq(invoices.companyId, company.id))
    .orderBy(desc(invoices.date), desc(invoices.number))
    .limit(200);

  const outstanding = rows.reduce((s, r) => s + (r.totalCents - r.paidCents), 0);

  return (
    <>
      <PageHeader
        title="Invoices"
        subtitle={`${rows.length} invoices · ${fmt(outstanding, company.currency)} still outstanding.`}
      />
      <Card>
        {rows.length === 0 ? (
          <EmptyState title="No invoices yet" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Customer</th>
                <th>Date</th>
                <th>Due</th>
                <th className="num">Total</th>
                <th className="num">Balance</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="font-semibold text-brand-dark">{r.number}</td>
                  <td>
                    {r.customer}
                    {r.aiAssisted && <span className="badge-ai ml-2">AI drafted</span>}
                  </td>
                  <td className="text-ink-muted">{shortDate(r.date)}</td>
                  <td className="text-ink-muted">{shortDate(r.dueDate)}</td>
                  <td className="num">{fmt(r.totalCents, company.currency)}</td>
                  <td className="num font-medium">{fmt(r.totalCents - r.paidCents, company.currency)}</td>
                  <td>
                    <span className={statusClass(r.status)}>{r.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

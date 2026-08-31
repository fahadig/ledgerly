import { desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { bills, contacts } from '@/db/schema';
import { getCompany } from '@/lib/company';
import { fmt, shortDate, statusClass } from '@/lib/format';
import { Card, EmptyState, PageHeader } from '@/components/ui';

export default async function BillsPage() {
  const company = await getCompany();
  const rows = await db
    .select({
      id: bills.id,
      number: bills.number,
      date: bills.date,
      dueDate: bills.dueDate,
      status: bills.status,
      totalCents: bills.totalCents,
      paidCents: bills.paidCents,
      aiAssisted: bills.aiAssisted,
      vendor: contacts.displayName,
      relatedCompanyId: contacts.relatedCompanyId,
    })
    .from(bills)
    .innerJoin(contacts, eq(contacts.id, bills.vendorId))
    .where(eq(bills.companyId, company.id))
    .orderBy(desc(bills.date), desc(bills.number))
    .limit(200);

  const outstanding = rows.reduce((s, r) => s + (r.totalCents - r.paidCents), 0);

  return (
    <>
      <PageHeader title="Bills" subtitle={`${rows.length} bills · ${fmt(outstanding, company.currency)} unpaid.`} />
      <Card>
        {rows.length === 0 ? (
          <EmptyState title="No bills yet" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Vendor</th>
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
                    {r.vendor}
                    {r.relatedCompanyId && <span className="badge-neutral ml-2">Intercompany</span>}
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

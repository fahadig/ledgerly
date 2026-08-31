import { asc, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { accounts, items, taxRates } from '@/db/schema';
import { getCompany } from '@/lib/company';
import { fmt } from '@/lib/format';
import { Card, EmptyState, PageHeader } from '@/components/ui';

export default async function ItemsPage() {
  const company = await getCompany();
  const rows = await db
    .select({
      id: items.id,
      name: items.name,
      type: items.type,
      unitPriceCents: items.unitPriceCents,
      accountCode: accounts.code,
      accountName: accounts.name,
      taxName: taxRates.name,
      taxBps: taxRates.rateBps,
    })
    .from(items)
    .leftJoin(accounts, eq(accounts.id, items.incomeAccountId))
    .leftJoin(taxRates, eq(taxRates.id, items.taxRateId))
    .where(eq(items.companyId, company.id))
    .orderBy(asc(items.name));

  return (
    <>
      <PageHeader
        title="Products and services"
        subtitle="Each item carries the income account it posts to, so invoices land in the right place without anyone thinking about it."
      />
      <Card>
        {rows.length === 0 ? (
          <EmptyState title="No items yet" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th className="num">Price</th>
                <th>Posts to</th>
                <th>Tax</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id}>
                  <td className="font-medium">{i.name}</td>
                  <td className="text-ink-muted">{i.type}</td>
                  <td className="num">{fmt(i.unitPriceCents, company.currency)}</td>
                  <td className="text-ink-muted">
                    {i.accountCode ? `${i.accountCode} · ${i.accountName}` : '—'}
                  </td>
                  <td className="text-ink-muted">{i.taxName ? `${i.taxName} (${(i.taxBps! / 100).toFixed(2)}%)` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

import { desc, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { getCompany } from '@/lib/company';
import { fmt, shortDate } from '@/lib/format';
import { Card, EmptyState, PageHeader } from '@/components/ui';

export default async function ExpensesPage() {
  const company = await getCompany();

  const result = await db.execute(sql`
    SELECT e.id, e.reference, e.date, e.memo, e.method, e.total_cents, e.ai_assisted,
           v.display_name AS vendor,
           pa.name        AS paid_from,
           string_agg(a.name, ', ' ORDER BY el.line_no) AS categories
    FROM expenses e
    LEFT JOIN contacts v ON v.id = e.vendor_id
    JOIN accounts pa ON pa.id = e.payment_account_id
    JOIN expense_lines el ON el.expense_id = e.id
    JOIN accounts a ON a.id = el.account_id
    WHERE e.company_id = ${company.id}
    GROUP BY e.id, v.display_name, pa.name
    ORDER BY e.date DESC
    LIMIT 200
  `);

  const rows = result.rows as unknown as {
    id: string;
    reference: string;
    date: string;
    memo: string | null;
    method: string | null;
    total_cents: number;
    ai_assisted: boolean;
    vendor: string | null;
    paid_from: string;
    categories: string;
  }[];

  const total = rows.reduce((s, r) => s + Number(r.total_cents), 0);

  return (
    <>
      <PageHeader title="Expenses" subtitle={`${rows.length} cash and card expenses · ${fmt(total, company.currency)}.`} />
      <Card>
        {rows.length === 0 ? (
          <EmptyState title="No expenses yet" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Date</th>
                <th>Payee</th>
                <th>Category</th>
                <th>Paid from</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="font-semibold text-brand-dark">{r.reference}</td>
                  <td className="text-ink-muted">{shortDate(r.date)}</td>
                  <td>
                    {r.vendor ?? r.memo ?? '—'}
                    {r.ai_assisted && <span className="badge-ai ml-2">AI drafted</span>}
                  </td>
                  <td className="text-ink-muted">{r.categories}</td>
                  <td className="text-ink-muted">{r.paid_from}</td>
                  <td className="num font-medium">{fmt(Number(r.total_cents), company.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { getAccess, assertCan } from '@/lib/company';
import { listPlans, seedBudgetFromActuals } from '@/lib/fpa';
import { fmt, shortDate } from '@/lib/format';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { db } from '@/lib/db';
import { planLines } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export default async function PlanningPage() {
  const { company, role } = await getAccess();
  const plans = await listPlans(company.id);

  const counts = plans.length
    ? await db
        .select({ planId: planLines.planId, n: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${planLines.amountCents}),0)::bigint` })
        .from(planLines)
        .where(sql`${planLines.planId} in ${sql.raw(`(${plans.map((p) => `'${p.id}'`).join(',')})`)}`)
        .groupBy(planLines.planId)
    : [];
  const countById = new Map(counts.map((c) => [c.planId, c]));

  const thisYear = new Date().getUTCFullYear();

  async function createBudget(): Promise<void> {
    'use server';
    const access = await assertCan('close');
    await seedBudgetFromActuals({
      companyId: access.company.id,
      fiscalYear: thisYear,
      fiscalStartMonth: access.company.fiscalYearStartMonth,
      currency: access.company.currency,
      upliftBps: 800,
      name: `Budget ${thisYear}`,
      createdBy: access.user.name,
    });
    revalidatePath('/planning');
  }

  return (
    <>
      <PageHeader
        title="Planning"
        subtitle="Budgets and forecasts read the same ledger the statements come from — there is no sync step, so actuals and plan can never drift apart."
        action={
          plans.some((p) => p.fiscalYear === thisYear) ? undefined : (
            <form action={createBudget}>
              <button className="btn-primary" disabled={role === 'VIEWER' || role === 'BOOKKEEPER'}>
                Build {thisYear} budget from last year
              </button>
            </form>
          )
        }
      />

      {plans.length === 0 ? (
        <Card>
          <EmptyState
            title="No plans yet"
            hint="Start a budget from the last twelve months of actuals — every line records that that is where it came from."
          />
        </Card>
      ) : (
        <div className="space-y-4">
          <Card title="Plans">
            <table className="table">
              <thead>
                <tr>
                  <th>Plan</th>
                  <th>Year</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th className="num">Lines</th>
                  <th>Basis</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {plans.map((p) => (
                  <tr key={p.id}>
                    <td className="font-semibold text-brand-dark">{p.name}</td>
                    <td className="tabular">{p.fiscalYear}</td>
                    <td className="text-ink-muted">{p.kind.toLowerCase()}</td>
                    <td>
                      <span className={p.status === 'APPROVED' ? 'badge-paid' : 'badge-neutral'}>{p.status}</span>
                    </td>
                    <td className="num">{countById.get(p.id)?.n ?? 0}</td>
                    <td className="max-w-md text-xs text-ink-muted">{p.note ?? '—'}</td>
                    <td>
                      <Link href={`/planning/${p.id}`} className="text-xs font-semibold text-brand-dark hover:underline">
                        Budget vs actual →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="Month-end">
            <div className="px-5 py-4">
              <p className="max-w-2xl text-sm text-ink-muted">
                Closing a month locks it, snapshots what the plan said at that moment, and proposes next month&rsquo;s
                forecast from commitments already in the system, recurrences the ledger has detected, and the trailing
                trend. It proposes — it never overwrites a figure someone typed.
              </p>
              <Link href="/planning/close" className="btn-secondary mt-3 inline-flex">
                Go to close and roll-forward
              </Link>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}

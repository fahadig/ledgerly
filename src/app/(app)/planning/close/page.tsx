import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { assertCan, getAccess } from '@/lib/company';
import {
  addMonths,
  applyRollForward,
  closeMonth,
  listClosePeriods,
  listPlans,
  monthKey,
  monthStart,
  proposeRollForward,
  reopenMonth,
} from '@/lib/fpa';
import { profitAndLoss } from '@/lib/reports';
import { fmt } from '@/lib/format';
import { Card, EmptyState, PageHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function ClosePage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const { period: periodParam } = await searchParams;
  const { company, role } = await getAccess();
  const cur = company.currency;
  const mayClose = role === 'OWNER' || role === 'ADMIN' || role === 'ACCOUNTANT';

  // Default to the previous whole month — the one you would actually close.
  const today = new Date();
  const target = periodParam
    ? monthStart(new Date(`${periodParam}-01T00:00:00Z`))
    : monthStart(addMonths(monthStart(today), -1));

  const [plans, closed] = await Promise.all([listPlans(company.id), listClosePeriods(company.id)]);
  const plan = plans.find((p) => p.status === 'APPROVED') ?? plans[0] ?? null;

  const monthEnd = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0));
  const pl = await profitAndLoss(company.id, target, monthEnd);

  const proposal = plan
    ? await proposeRollForward({ companyId: company.id, planId: plan.id, closingPeriod: target })
    : null;

  const isClosed = closed.find((c) => monthKey(new Date(c.period)) === monthKey(target))?.status === 'CLOSED';

  async function doClose() {
    'use server';
    const access = await assertCan('close');
    await closeMonth({
      companyId: access.company.id,
      period: target,
      planId: plan?.id ?? null,
      userId: access.user.id,
      userName: access.user.name,
    });
    revalidatePath('/planning/close');
  }

  async function doReopen() {
    'use server';
    const access = await assertCan('close');
    await reopenMonth(access.company.id, target, access.user.name);
    revalidatePath('/planning/close');
  }

  async function doApply() {
    'use server';
    const access = await assertCan('close');
    if (!plan || !proposal) return;
    await applyRollForward({
      planId: plan.id,
      forecastPeriod: addMonths(target, 1),
      lines: proposal.lines
        .filter((l) => !l.protectedByHuman)
        .map((l) => ({
          accountId: l.accountId,
          dimensionValueIds: l.dimensionValueIds,
          amountCents: l.amountCents,
          source: l.source,
          basis: l.basis,
        })),
    });
    revalidatePath('/planning/close');
  }

  return (
    <>
      <PageHeader
        title={`Close ${monthKey(target)}`}
        subtitle="Closing a month locks it, records what the plan said at that moment, and proposes next month's forecast. Nothing is applied until you approve it, and figures someone typed by hand are never overwritten."
        action={
          <Link href="/planning" className="btn-secondary">
            All plans
          </Link>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {Array.from({ length: 6 }, (_, i) => addMonths(monthStart(today), -1 - i)).map((m) => (
          <Link
            key={monthKey(m)}
            href={`/planning/close?period=${monthKey(m)}`}
            className={`rounded-full border px-3 py-1 text-xs ${
              monthKey(m) === monthKey(target)
                ? 'border-brand bg-brand text-white'
                : 'border-line text-ink-muted hover:border-brand'
            }`}
          >
            {monthKey(m)}
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title={`Result for ${monthKey(target)}`}>
          <div className="px-5 py-4">
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-ink-muted">Income</dt>
                <dd className="tabular font-medium">{fmt(pl.income.total + pl.otherIncome.total, cur)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-muted">Costs</dt>
                <dd className="tabular font-medium">
                  {fmt(pl.cogs.total + pl.expenses.total + pl.otherExpense.total, cur)}
                </dd>
              </div>
              <div className="flex justify-between border-t border-line pt-2">
                <dt className="font-semibold">Profit</dt>
                <dd className={`tabular font-semibold ${pl.netIncome >= 0 ? 'text-brand-dark' : 'text-red-700'}`}>
                  {fmt(pl.netIncome, cur)}
                </dd>
              </div>
            </dl>
          </div>
        </Card>

        <Card title="Period status" className="lg:col-span-2">
          <div className="px-5 py-4">
            {isClosed ? (
              <>
                <p className="text-sm">
                  <span className="badge-paid mr-2">Closed</span>
                  Nothing can be posted into {monthKey(target)}. The posting engine refuses it, not just this screen.
                </p>
                <form action={doReopen} className="mt-3">
                  <button className="btn-secondary" disabled={!mayClose}>
                    Reopen {monthKey(target)}
                  </button>
                </form>
              </>
            ) : (
              <>
                <p className="max-w-2xl text-sm text-ink-muted">
                  {monthKey(target)} is still open. Closing it locks the period, takes a snapshot of the plan — the
                  record of what you believed at the time — and prepares the roll-forward below.
                </p>
                <form action={doClose} className="mt-3">
                  <button className="btn-primary" disabled={!mayClose}>
                    Close {monthKey(target)}
                  </button>
                </form>
                {!mayClose && (
                  <p className="mt-2 text-xs text-ink-muted">
                    Your role cannot close periods. An accountant, admin or owner can.
                  </p>
                )}
              </>
            )}
          </div>
        </Card>
      </div>

      <div className="mt-5">
        {!plan ? (
          <Card>
            <EmptyState
              title="No plan to roll forward"
              hint="Create a budget on the Planning page first — the roll-forward writes into it."
            />
          </Card>
        ) : (
          <Card
            title={`Proposed forecast for ${proposal!.forecastPeriod}`}
            action={
              <span className="text-xxs text-ink-muted">
                Every line states where the number came from — nothing is shown without a basis
              </span>
            }
          >
            {proposal!.notes.length > 0 && (
              <div className="border-b border-line bg-surface px-5 py-3">
                {proposal!.notes.map((n, i) => (
                  <p key={i} className="text-sm text-ink-muted">
                    {n}
                  </p>
                ))}
              </div>
            )}

            <div className="grid grid-cols-3 gap-4 border-b border-line px-5 py-4">
              <div>
                <div className="text-xxs font-bold uppercase tracking-wide text-ink-muted">Forecast income</div>
                <div className="tabular text-lg font-semibold">{fmt(proposal!.totals.income, cur)}</div>
              </div>
              <div>
                <div className="text-xxs font-bold uppercase tracking-wide text-ink-muted">Forecast costs</div>
                <div className="tabular text-lg font-semibold">{fmt(proposal!.totals.expense, cur)}</div>
              </div>
              <div>
                <div className="text-xxs font-bold uppercase tracking-wide text-ink-muted">Forecast profit</div>
                <div
                  className={`tabular text-lg font-semibold ${
                    proposal!.totals.profit >= 0 ? 'text-brand-dark' : 'text-red-700'
                  }`}
                >
                  {fmt(proposal!.totals.profit, cur)}
                </div>
              </div>
            </div>

            {proposal!.lines.length === 0 ? (
              <EmptyState title="Nothing to propose" hint="No commitments, recurrences or trend for this period." />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Basis</th>
                    <th>Source</th>
                    <th className="num">Currently in plan</th>
                    <th className="num">Proposed</th>
                  </tr>
                </thead>
                <tbody>
                  {proposal!.lines.map((l, i) => (
                    <tr key={i} className={l.protectedByHuman ? 'opacity-60' : ''}>
                      <td className="whitespace-nowrap">
                        <span className="tabular text-ink-muted">{l.code}</span> {l.name}
                        {l.dimensionLabel && (
                          <span className="ml-2 text-xxs text-ink-light">{l.dimensionLabel}</span>
                        )}
                      </td>
                      <td className="text-xs text-ink-muted">{l.basis}</td>
                      <td>
                        <span
                          className={
                            l.source === 'COMMITMENT'
                              ? 'badge-open'
                              : l.source === 'RECURRENCE'
                                ? 'badge-paid'
                                : 'badge-neutral'
                          }
                        >
                          {l.source.toLowerCase()}
                        </span>
                      </td>
                      <td className="num text-ink-muted">{l.existingCents !== null ? fmt(l.existingCents, cur) : '—'}</td>
                      <td className="num font-medium">
                        {l.protectedByHuman ? (
                          <span className="text-xs text-ink-muted">kept — set by hand</span>
                        ) : (
                          fmt(l.amountCents, cur)
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="flex items-center gap-3 border-t border-line px-5 py-4">
              <p className="text-xs text-ink-muted">
                Applying writes these figures into <strong>{plan.name}</strong> for {proposal!.forecastPeriod}.
              </p>
              <form action={doApply} className="ml-auto">
                <button className="btn-primary" disabled={!mayClose || proposal!.lines.length === 0}>
                  Apply to the plan
                </button>
              </form>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}

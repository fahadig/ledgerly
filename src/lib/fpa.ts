/**
 * FP&A — budgeting, variance, and the close → forecast roll-forward.
 *
 * The point of the whole module: **closing a month should produce next month's
 * forecast, not trigger a separate exercise.** Everything here reads the same
 * `journal_lines` the statements are built from, so there is no sync step and
 * no drift between "actuals in accounting" and "actuals in planning".
 *
 * Two rules that are not negotiable:
 *   1. A forecast line always states its basis. A figure we cannot explain is
 *      not shown.
 *   2. The roll-forward PROPOSES. It never silently overwrites a number a
 *      human typed — same contract as the accounting assistant.
 */

import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { db } from './db';
import {
  accounts,
  bills,
  closePeriods,
  dimensionValues,
  dimensions,
  forecastSnapshots,
  planLines,
  plans,
  varianceNotes,
  type AccountType,
  type Plan,
} from '@/db/schema';
import type { Cents } from './money';
import { recurringPatterns } from './ai/patterns';

export const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
export const addMonths = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
export const monthKey = (d: Date) => d.toISOString().slice(0, 7);
const iso = (d: Date) => d.toISOString().slice(0, 10);

// ─────────────────────────── Dimensions ──────────────────────────────

export interface DimensionWithValues {
  id: string;
  code: string;
  name: string;
  isRequiredOnPL: boolean;
  values: { id: string; code: string; name: string }[];
}

export async function companyDimensions(companyId: string): Promise<DimensionWithValues[]> {
  const dims = await db
    .select()
    .from(dimensions)
    .where(and(eq(dimensions.companyId, companyId), eq(dimensions.isActive, true)))
    .orderBy(asc(dimensions.sortOrder), asc(dimensions.name));

  if (!dims.length) return [];

  const values = await db
    .select()
    .from(dimensionValues)
    .where(
      and(
        inArray(dimensionValues.dimensionId, dims.map((d) => d.id)),
        eq(dimensionValues.isActive, true),
      ),
    )
    .orderBy(asc(dimensionValues.code));

  return dims.map((d) => ({
    id: d.id,
    code: d.code,
    name: d.name,
    isRequiredOnPL: d.isRequiredOnPL,
    values: values.filter((v) => v.dimensionId === d.id).map((v) => ({ id: v.id, code: v.code, name: v.name })),
  }));
}

// ─────────────────────────── Plans ───────────────────────────────────

export async function listPlans(companyId: string): Promise<Plan[]> {
  return db
    .select()
    .from(plans)
    .where(eq(plans.companyId, companyId))
    .orderBy(desc(plans.fiscalYear), asc(plans.name));
}

export async function getPlan(planId: string): Promise<Plan | null> {
  const [p] = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
  return p ?? null;
}

/**
 * Build a budget from the trailing twelve months of actuals, uplifted and
 * spread evenly across the target year.
 *
 * This is the honest version of "last year plus a bit" — the starting point
 * almost every real budget actually uses — except every line records that
 * this is what it is, so nobody mistakes it for considered planning. It
 * carries no seasonality; a line that is genuinely seasonal should be edited
 * by hand, and once edited it is never overwritten by the roll-forward.
 */
export async function seedBudgetFromActuals(opts: {
  companyId: string;
  fiscalYear: number;
  fiscalStartMonth: number;
  currency: string;
  upliftBps?: number;
  name?: string;
  createdBy?: string;
}): Promise<{ plan: Plan; lineCount: number }> {
  const uplift = 1 + (opts.upliftBps ?? 800) / 10_000;
  const yearStart = new Date(Date.UTC(opts.fiscalYear, opts.fiscalStartMonth - 1, 1));
  // Trailing twelve months ending with the last complete month — not the
  // prior calendar year, which a company less than two years old does not have.
  const lastComplete = addMonths(monthStart(new Date()), -1);
  const windowEnd = new Date(Date.UTC(lastComplete.getUTCFullYear(), lastComplete.getUTCMonth() + 1, 0));
  const windowStart = addMonths(lastComplete, -11);

  const [plan] = await db
    .insert(plans)
    .values({
      companyId: opts.companyId,
      name: opts.name ?? `Budget ${opts.fiscalYear}`,
      fiscalYear: opts.fiscalYear,
      kind: 'BUDGET',
      status: 'APPROVED',
      currency: opts.currency,
      note: `Run-rate from the twelve months to ${monthKey(lastComplete)}, uplifted ${(((uplift - 1) * 100)).toFixed(1)}% and spread evenly across ${opts.fiscalYear}.`,
      createdBy: opts.createdBy ?? 'system',
      approvedBy: opts.createdBy ?? 'system',
      approvedAt: new Date(),
    })
    .returning();

  // Monthly run-rate per account and dimension combination over the window.
  const result = await db.execute(sql`
    SELECT jl.account_id,
           jl.dimension_value_ids,
           SUM(CASE WHEN a.type = 'INCOME'
                    THEN jl.credit_cents - jl.debit_cents
                    ELSE jl.debit_cents - jl.credit_cents END) AS total,
           COUNT(DISTINCT date_trunc('month', je.date)) AS months
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id AND je.is_void = false AND je.is_elimination = false
    JOIN accounts a ON a.id = jl.account_id
    WHERE a.company_id = ${opts.companyId}
      AND a.type IN ('INCOME','EXPENSE')
      AND je.date >= ${iso(windowStart)}
      AND je.date <= ${iso(windowEnd)}
    GROUP BY 1, 2
    HAVING SUM(CASE WHEN a.type = 'INCOME'
                    THEN jl.credit_cents - jl.debit_cents
                    ELSE jl.debit_cents - jl.credit_cents END) <> 0
  `);

  const rows = result.rows as unknown as {
    account_id: string;
    dimension_value_ids: string[] | null;
    total: number | string;
    months: number | string;
  }[];

  if (!rows.length) return { plan, lineCount: 0 };

  const values = rows.flatMap((r) => {
    const observed = Math.max(1, Number(r.months));
    const runRate = Math.round((Number(r.total) / observed) * uplift);
    if (runRate === 0) return [];

    // One line per month of the target fiscal year.
    return Array.from({ length: 12 }, (_, i) => ({
      planId: plan.id,
      accountId: r.account_id,
      dimensionValueIds: r.dimension_value_ids,
      period: addMonths(yearStart, i),
      amountCents: runRate,
      source: 'TREND',
      basis: `${observed}-month run-rate to ${monthKey(lastComplete)} of ${(Number(r.total) / observed / 100).toFixed(2)}, uplifted ${(((uplift - 1) * 100)).toFixed(1)}%`,
    }));
  });

  // Insert in chunks — a year of departmental lines runs to thousands of rows.
  for (let i = 0; i < values.length; i += 500) {
    await db.insert(planLines).values(values.slice(i, i + 500));
  }

  return { plan, lineCount: values.length };
}

// ─────────────────────── Budget vs actual ────────────────────────────

export interface VarianceRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  /** Month key → figures. The horizontal view. */
  months: Record<string, { budget: Cents; actual: Cents }>;
  budget: Cents;
  actual: Cents;
  variance: Cents;
  /** Positive = better than plan, for both income and expense. */
  favourable: Cents;
  variancePct: number | null;
}

export interface BudgetVsActual {
  planName: string;
  months: string[];
  rows: VarianceRow[];
  totals: {
    incomeBudget: Cents;
    incomeActual: Cents;
    expenseBudget: Cents;
    expenseActual: Cents;
    profitBudget: Cents;
    profitActual: Cents;
  };
}

export async function budgetVsActual(opts: {
  companyId: string;
  planId: string;
  from: Date;
  to: Date;
  dimensionValueId?: string | null;
}): Promise<BudgetVsActual> {
  const plan = await getPlan(opts.planId);
  if (!plan) throw new Error('Plan not found.');

  const dimActual = opts.dimensionValueId
    ? sql`AND jl.dimension_value_ids @> ${JSON.stringify([opts.dimensionValueId])}::jsonb`
    : sql``;

  const actualResult = await db.execute(sql`
    SELECT a.id AS account_id, a.code, a.name, a.type::text AS type,
           to_char(date_trunc('month', je.date), 'YYYY-MM') AS month,
           SUM(CASE WHEN a.type = 'INCOME'
                    THEN jl.credit_cents - jl.debit_cents
                    ELSE jl.debit_cents - jl.credit_cents END) AS amount
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id AND je.is_void = false AND je.is_elimination = false
    JOIN accounts a ON a.id = jl.account_id
    WHERE a.company_id = ${opts.companyId}
      AND a.type IN ('INCOME','EXPENSE')
      AND je.date >= ${iso(opts.from)} AND je.date <= ${iso(opts.to)}
      ${dimActual}
    GROUP BY 1,2,3,4,5
  `);

  const dimPlan = opts.dimensionValueId
    ? sql`AND pl.dimension_value_ids @> ${JSON.stringify([opts.dimensionValueId])}::jsonb`
    : sql``;

  const planResult = await db.execute(sql`
    SELECT a.id AS account_id, a.code, a.name, a.type::text AS type,
           to_char(pl.period, 'YYYY-MM') AS month,
           SUM(pl.amount_cents) AS amount
    FROM plan_lines pl
    JOIN accounts a ON a.id = pl.account_id
    WHERE pl.plan_id = ${opts.planId}
      AND pl.period >= ${iso(opts.from)} AND pl.period <= ${iso(opts.to)}
      ${dimPlan}
    GROUP BY 1,2,3,4,5
  `);

  type Row = { account_id: string; code: string; name: string; type: AccountType; month: string; amount: number | string };

  const months: string[] = [];
  for (let d = monthStart(opts.from); d <= opts.to; d = addMonths(d, 1)) months.push(monthKey(d));

  const byAccount = new Map<string, VarianceRow>();
  const ensure = (r: Row): VarianceRow => {
    let row = byAccount.get(r.account_id);
    if (!row) {
      row = {
        accountId: r.account_id,
        code: r.code,
        name: r.name,
        type: r.type,
        months: Object.fromEntries(months.map((m) => [m, { budget: 0, actual: 0 }])),
        budget: 0,
        actual: 0,
        variance: 0,
        favourable: 0,
        variancePct: null,
      };
      byAccount.set(r.account_id, row);
    }
    return row;
  };

  for (const r of planResult.rows as unknown as Row[]) {
    const row = ensure(r);
    if (!row.months[r.month]) continue;
    row.months[r.month].budget += Number(r.amount);
    row.budget += Number(r.amount);
  }
  for (const r of actualResult.rows as unknown as Row[]) {
    const row = ensure(r);
    if (!row.months[r.month]) continue;
    row.months[r.month].actual += Number(r.amount);
    row.actual += Number(r.amount);
  }

  const rows = Array.from(byAccount.values())
    .map((r) => {
      r.variance = r.actual - r.budget;
      // Over-spending is unfavourable; over-earning is favourable.
      r.favourable = r.type === 'INCOME' ? r.variance : -r.variance;
      r.variancePct = r.budget !== 0 ? (100 * r.variance) / Math.abs(r.budget) : null;
      return r;
    })
    .filter((r) => r.budget !== 0 || r.actual !== 0)
    .sort((a, b) => a.code.localeCompare(b.code));

  const sum = (fn: (r: VarianceRow) => number, type: AccountType) =>
    rows.filter((r) => r.type === type).reduce((s, r) => s + fn(r), 0);

  const incomeBudget = sum((r) => r.budget, 'INCOME');
  const incomeActual = sum((r) => r.actual, 'INCOME');
  const expenseBudget = sum((r) => r.budget, 'EXPENSE');
  const expenseActual = sum((r) => r.actual, 'EXPENSE');

  return {
    planName: plan.name,
    months,
    rows,
    totals: {
      incomeBudget,
      incomeActual,
      expenseBudget,
      expenseActual,
      profitBudget: incomeBudget - expenseBudget,
      profitActual: incomeActual - expenseActual,
    },
  };
}

// ─────────────────────── Close → forecast ────────────────────────────

export interface ProposedLine {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  dimensionValueIds: string[] | null;
  /** Human-readable department/project, so repeated account rows are legible. */
  dimensionLabel: string | null;
  amountCents: Cents;
  source: 'COMMITMENT' | 'RECURRENCE' | 'TREND' | 'MANUAL';
  basis: string;
  /** What the plan currently says for that month, if anything. */
  existingCents: Cents | null;
  /** True when a human already typed a figure here — we never overwrite it. */
  protectedByHuman: boolean;
}

export interface RollForwardProposal {
  companyId: string;
  closingPeriod: string;
  forecastPeriod: string;
  lines: ProposedLine[];
  totals: { income: Cents; expense: Cents; profit: Cents };
  notes: string[];
}

/**
 * Derive next month's forecast. Priority order, highest first:
 *   1. a human's own figure — kept, never overwritten
 *   2. a commitment already in the system (unpaid bills falling due)
 *   3. a recurrence the ledger has detected
 *   4. the trailing three-month trend
 */
export async function proposeRollForward(opts: {
  companyId: string;
  planId: string;
  closingPeriod: Date;
}): Promise<RollForwardProposal> {
  const closing = monthStart(opts.closingPeriod);
  const forecast = addMonths(closing, 1);
  const notes: string[] = [];

  const chart = await db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type })
    .from(accounts)
    .where(and(eq(accounts.companyId, opts.companyId), eq(accounts.isActive, true)));
  const byId = new Map(chart.map((a) => [a.id, a]));

  // What the plan already holds for the forecast month.
  const existing = await db
    .select()
    .from(planLines)
    .where(and(eq(planLines.planId, opts.planId), eq(planLines.period, forecast)));
  const existingByKey = new Map(
    existing.map((l) => [`${l.accountId}|${(l.dimensionValueIds ?? []).join(',')}`, l]),
  );

  // 3-month trailing average per account and dimension combination.
  const trendResult = await db.execute(sql`
    SELECT jl.account_id,
           jl.dimension_value_ids,
           SUM(CASE WHEN a.type = 'INCOME'
                    THEN jl.credit_cents - jl.debit_cents
                    ELSE jl.debit_cents - jl.credit_cents END) AS total,
           COUNT(DISTINCT date_trunc('month', je.date)) AS months
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id AND je.is_void = false AND je.is_elimination = false
    JOIN accounts a ON a.id = jl.account_id
    WHERE a.company_id = ${opts.companyId}
      AND a.type IN ('INCOME','EXPENSE')
      AND je.date >= ${iso(addMonths(closing, -2))}
      AND je.date <= ${iso(new Date(Date.UTC(closing.getUTCFullYear(), closing.getUTCMonth() + 1, 0)))}
    GROUP BY 1, 2
  `);

  const dimValues = await db
    .select({ id: dimensionValues.id, name: dimensionValues.name })
    .from(dimensionValues)
    .innerJoin(dimensions, eq(dimensions.id, dimensionValues.dimensionId))
    .where(eq(dimensions.companyId, opts.companyId));
  const dimName = new Map(dimValues.map((v) => [v.id, v.name]));
  const labelFor = (ids: string[] | null) =>
    ids?.length ? ids.map((i) => dimName.get(i) ?? '—').join(' · ') : null;

  const proposals = new Map<string, ProposedLine>();
  const put = (line: ProposedLine) => {
    const key = `${line.accountId}|${(line.dimensionValueIds ?? []).join(',')}`;
    const prior = proposals.get(key);
    // Later sources never displace earlier, higher-priority ones.
    if (!prior) proposals.set(key, line);
  };

  // ── 1. Commitments: unpaid bills whose due date lands in the month ──
  const dueBills = await db
    .select({
      id: bills.id,
      number: bills.number,
      dueDate: bills.dueDate,
      totalCents: bills.totalCents,
      paidCents: bills.paidCents,
    })
    .from(bills)
    .where(
      and(
        eq(bills.companyId, opts.companyId),
        inArray(bills.status, ['OPEN', 'PARTIAL', 'OVERDUE']),
        gte(bills.dueDate, forecast),
        lte(bills.dueDate, new Date(Date.UTC(forecast.getUTCFullYear(), forecast.getUTCMonth() + 1, 0))),
      ),
    );

  if (dueBills.length) {
    const owed = dueBills.reduce((s, b) => s + (b.totalCents - b.paidCents), 0);
    notes.push(
      `${dueBills.length} unpaid bill(s) totalling ${(owed / 100).toFixed(2)} fall due in ${monthKey(forecast)}. ` +
        `These are deliberately NOT added to the forecast: under accrual accounting the cost was already recognised ` +
        `when each bill was posted, so counting them again would double-count. They are a cash commitment, not a P&L one.`,
    );
  }

  // ── 2. Recurrences the ledger has detected ──────────────────────────
  const recurrences = await recurringPatterns(opts.companyId, 3);
  for (const r of recurrences.filter((x) => x.cadence === 'monthly')) {
    const acc = byId.get(r.accountId);
    if (!acc) continue;
    put({
      accountId: r.accountId,
      code: acc.code,
      name: acc.name,
      type: acc.type,
      dimensionValueIds: null,
      dimensionLabel: null,
      amountCents: r.medianAmountCents,
      source: 'RECURRENCE',
      basis: `${r.contactName} has billed monthly ${r.occurrences} times, median ${(r.medianAmountCents / 100).toFixed(2)}`,
      existingCents: null,
      protectedByHuman: false,
    });
  }

  // ── 3. Trend for everything else ────────────────────────────────────
  for (const r of trendResult.rows as unknown as {
    account_id: string;
    dimension_value_ids: string[] | null;
    total: number | string;
    months: number | string;
  }[]) {
    const acc = byId.get(r.account_id);
    if (!acc) continue;
    const months = Math.max(1, Number(r.months));
    const avg = Math.round(Number(r.total) / months);
    if (avg === 0) continue;

    put({
      accountId: r.account_id,
      code: acc.code,
      name: acc.name,
      type: acc.type,
      dimensionValueIds: r.dimension_value_ids,
      dimensionLabel: labelFor(r.dimension_value_ids),
      amountCents: avg,
      source: 'TREND',
      basis: `${months}-month average to ${monthKey(closing)}`,
      existingCents: null,
      protectedByHuman: false,
    });
  }

  // Mark anything a human already set — shown, but never replaced.
  const lines = Array.from(proposals.values()).map((l) => {
    const key = `${l.accountId}|${(l.dimensionValueIds ?? []).join(',')}`;
    const current = existingByKey.get(key);
    if (current && current.source === 'MANUAL') {
      return { ...l, existingCents: current.amountCents, protectedByHuman: true };
    }
    return { ...l, existingCents: current?.amountCents ?? null };
  });

  const applied = lines.filter((l) => !l.protectedByHuman);
  const income = applied.filter((l) => l.type === 'INCOME').reduce((s, l) => s + l.amountCents, 0);
  const expense = applied.filter((l) => l.type === 'EXPENSE').reduce((s, l) => s + l.amountCents, 0);

  const held = lines.filter((l) => l.protectedByHuman).length;
  if (held) notes.push(`${held} line(s) already carry a figure someone typed. Those are left exactly as they are.`);

  return {
    companyId: opts.companyId,
    closingPeriod: monthKey(closing),
    forecastPeriod: monthKey(forecast),
    lines: lines.sort((a, b) => a.code.localeCompare(b.code)),
    totals: { income, expense, profit: income - expense },
    notes,
  };
}

/** Write an approved proposal into the plan. Human-set lines are untouched. */
export async function applyRollForward(opts: {
  planId: string;
  forecastPeriod: Date;
  lines: { accountId: string; dimensionValueIds: string[] | null; amountCents: Cents; source: string; basis: string }[];
}): Promise<number> {
  const period = monthStart(opts.forecastPeriod);
  let written = 0;

  await db.transaction(async (tx) => {
    for (const l of opts.lines) {
      const existing = await tx
        .select()
        .from(planLines)
        .where(
          and(
            eq(planLines.planId, opts.planId),
            eq(planLines.accountId, l.accountId),
            eq(planLines.period, period),
          ),
        );

      const match = existing.find(
        (e) => (e.dimensionValueIds ?? []).join(',') === (l.dimensionValueIds ?? []).join(','),
      );

      if (match?.source === 'MANUAL') continue; // sacred

      if (match) {
        await tx
          .update(planLines)
          .set({ amountCents: l.amountCents, source: l.source, basis: l.basis, updatedAt: new Date() })
          .where(eq(planLines.id, match.id));
      } else {
        await tx.insert(planLines).values({
          planId: opts.planId,
          accountId: l.accountId,
          dimensionValueIds: l.dimensionValueIds,
          period,
          amountCents: l.amountCents,
          source: l.source,
          basis: l.basis,
        });
      }
      written++;
    }
  });

  return written;
}

// ─────────────────────────── Closing ─────────────────────────────────

export async function periodStatus(companyId: string, period: Date) {
  const [row] = await db
    .select()
    .from(closePeriods)
    .where(and(eq(closePeriods.companyId, companyId), eq(closePeriods.period, monthStart(period))))
    .limit(1);
  return row ?? null;
}

export async function listClosePeriods(companyId: string, limit = 18) {
  return db
    .select()
    .from(closePeriods)
    .where(eq(closePeriods.companyId, companyId))
    .orderBy(desc(closePeriods.period))
    .limit(limit);
}

/**
 * Close a month: lock it, snapshot what the plan said (the vintage record),
 * and hand back the variance so the roll-forward has something to explain.
 */
export async function closeMonth(opts: {
  companyId: string;
  period: Date;
  planId?: string | null;
  userId: string;
  userName: string;
}) {
  const period = monthStart(opts.period);

  const snapshot = opts.planId
    ? await db
        .select({ accountId: planLines.accountId, period: planLines.period, amountCents: planLines.amountCents })
        .from(planLines)
        .where(and(eq(planLines.planId, opts.planId), gte(planLines.period, period)))
    : [];

  await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(closePeriods)
      .where(and(eq(closePeriods.companyId, opts.companyId), eq(closePeriods.period, period)))
      .limit(1);

    if (existing.length) {
      await tx
        .update(closePeriods)
        .set({ status: 'CLOSED', closedBy: opts.userName, closedAt: new Date() })
        .where(eq(closePeriods.id, existing[0].id));
    } else {
      await tx.insert(closePeriods).values({
        companyId: opts.companyId,
        period,
        status: 'CLOSED',
        closedBy: opts.userName,
        closedAt: new Date(),
      });
    }

    if (opts.planId) {
      await tx.insert(forecastSnapshots).values({
        companyId: opts.companyId,
        planId: opts.planId,
        asOfPeriod: period,
        takenBy: opts.userName,
        payload: snapshot.map((s) => ({
          period: iso(new Date(s.period)),
          accountId: s.accountId,
          amountCents: s.amountCents,
        })),
      });
    }
  });

  return { period: monthKey(period), snapshotLines: snapshot.length };
}

export async function reopenMonth(companyId: string, period: Date, userName: string) {
  await db
    .update(closePeriods)
    .set({ status: 'OPEN', closedBy: null, closedAt: null, note: `Reopened by ${userName}` })
    .where(and(eq(closePeriods.companyId, companyId), eq(closePeriods.period, monthStart(period))));
}

export async function saveVarianceNote(opts: {
  companyId: string;
  period: Date;
  accountId: string;
  amountCents: Cents;
  cause: string;
  ownerUserId?: string;
  carryForward?: boolean;
}) {
  await db.insert(varianceNotes).values({
    companyId: opts.companyId,
    period: monthStart(opts.period),
    accountId: opts.accountId,
    amountCents: opts.amountCents,
    cause: opts.cause,
    ownerUserId: opts.ownerUserId ?? null,
    carryForward: opts.carryForward ?? false,
  });
}

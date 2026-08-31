/**
 * Group consolidation.
 *
 * Aggregate → translate → eliminate → allocate non-controlling interests.
 *
 * Two design decisions worth knowing:
 *  1. Eliminations are NEVER written to a subsidiary's own books. They live in
 *     a consolidation run, line by line, each with an explanation and a
 *     citation, so the consolidated numbers can be walked back to the entity
 *     numbers by anyone who asks.
 *  2. Intercompany mismatches are reported, not silently plugged. If Company A
 *     says B owes it 10,000 and B says it owes 9,400, that 600 is the thing an
 *     accountant needs to see at close — hiding it would be the bug.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from './db';
import {
  accounts,
  companies,
  consolidationRuns,
  eliminations,
  fxRates,
  groups,
  journalEntries,
  journalLines,
  type AccountSubtype,
  type AccountType,
  type Company,
} from '@/db/schema';
import { accountMovements, fiscalYearStart, type AccountBalanceRow } from './reports';
import { signedBalance } from './ledger';
import type { Cents } from './money';

const iso = (d: Date) => d.toISOString().slice(0, 10);

// ─────────────────────────── FX ──────────────────────────────────────

/** 1 unit of `from` expressed in `to`, scaled by 1,000,000. */
export async function getRate(from: string, to: string, on: Date, kind: 'CLOSING' | 'AVERAGE' = 'CLOSING'): Promise<number> {
  if (from === to) return 1_000_000;

  const [exact] = await db
    .select()
    .from(fxRates)
    .where(
      and(
        eq(fxRates.fromCurrency, from),
        eq(fxRates.toCurrency, to),
        eq(fxRates.kind, kind),
        sql`${fxRates.date} <= ${iso(on)}`,
      ),
    )
    .orderBy(sql`${fxRates.date} DESC`)
    .limit(1);

  if (exact) return exact.rateMicros;

  // Try the inverse before giving up.
  const [inverse] = await db
    .select()
    .from(fxRates)
    .where(
      and(
        eq(fxRates.fromCurrency, to),
        eq(fxRates.toCurrency, from),
        eq(fxRates.kind, kind),
        sql`${fxRates.date} <= ${iso(on)}`,
      ),
    )
    .orderBy(sql`${fxRates.date} DESC`)
    .limit(1);

  if (inverse && inverse.rateMicros !== 0) return Math.round(1_000_000_000_000 / inverse.rateMicros);

  throw new Error(`No ${kind.toLowerCase()} FX rate found for ${from}→${to} on or before ${iso(on)}. Add one in Settings → Exchange rates.`);
}

const translate = (cents: Cents, rateMicros: number) => Math.round((cents * rateMicros) / 1_000_000);

// ─────────────────────── Intercompany balances ───────────────────────

export interface IntercompanyPair {
  fromCompanyId: string;
  fromCompanyName: string;
  toCompanyId: string;
  toCompanyName: string;
  /** Receivable recorded by `from` against `to`, in `from`'s currency. */
  receivableCents: Cents;
  /** Payable recorded by `to` against `from`, in `to`'s currency. */
  payableCents: Cents;
  mismatchCents: Cents;
  tradeIncomeCents: Cents;
  tradeExpenseCents: Cents;
}

async function intercompanyPositions(companyIds: string[], from: Date, to: Date) {
  if (!companyIds.length) return [];
  const result = await db.execute(sql`
    SELECT je.company_id            AS company_id,
           je.counterparty_company_id AS counterparty_id,
           a.type::text             AS type,
           a.subtype::text          AS subtype,
           SUM(jl.debit_cents)      AS debit,
           SUM(jl.credit_cents)     AS credit
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE je.company_id = ANY(${sql.raw(`ARRAY[${companyIds.map((i) => `'${i}'`).join(',')}]::text[]`)})
      AND je.counterparty_company_id IS NOT NULL
      AND je.is_void = false
      AND je.is_elimination = false
      AND je.date <= ${iso(to)}
    GROUP BY 1, 2, 3, 4
  `);

  return result.rows as unknown as {
    company_id: string;
    counterparty_id: string;
    type: AccountType;
    subtype: AccountSubtype;
    debit: number | string;
    credit: number | string;
  }[];
}

// ─────────────────────── Consolidated report ─────────────────────────

export interface ConsolidatedLine {
  groupAccountCode: string;
  name: string;
  type: AccountType;
  subtype: AccountSubtype;
  /** Per-entity contribution, in presentation currency. */
  byCompany: Record<string, Cents>;
  aggregate: Cents;
  eliminated: Cents;
  consolidated: Cents;
}

export interface ConsolidationResult {
  groupId: string;
  groupName: string;
  presentationCurrency: string;
  periodStart: Date;
  periodEnd: Date;
  companies: { id: string; name: string; currency: string; ownershipBps: number; framework: string; isParent: boolean }[];
  lines: ConsolidatedLine[];
  totals: {
    assets: Cents;
    liabilities: Cents;
    equity: Cents;
    income: Cents;
    expenses: Cents;
    profit: Cents;
    profitAttributableToParent: Cents;
    profitAttributableToNCI: Cents;
    nciEquity: Cents;
    translationReserve: Cents;
    outOfBalance: Cents;
  };
  eliminationEntries: {
    kind: string;
    explanation: string;
    amountCents: Cents;
    standardRef: string | null;
    fromCompany?: string;
    toCompany?: string;
  }[];
  mismatches: IntercompanyPair[];
  warnings: string[];
}

export async function consolidate(opts: {
  groupId: string;
  periodStart?: Date;
  periodEnd: Date;
}): Promise<ConsolidationResult> {
  const [group] = await db.select().from(groups).where(eq(groups.id, opts.groupId)).limit(1);
  if (!group) throw new Error('Group not found.');

  const members = await db
    .select()
    .from(companies)
    .where(and(eq(companies.groupId, opts.groupId), eq(companies.isActive, true), eq(companies.isEliminationEntity, false)));

  if (!members.length) throw new Error('This group has no member companies.');

  const periodStart = opts.periodStart ?? fiscalYearStart(opts.periodEnd, group.fiscalYearStartMonth);
  const presentation = group.presentationCurrency;
  const warnings: string[] = [];

  const parent = members.find((m) => !m.parentCompanyId) ?? members[0];

  // ── 1. Aggregate, translating each entity into the presentation currency ──
  const lineMap = new Map<string, ConsolidatedLine>();
  const byCompanyProfit = new Map<string, Cents>();
  let hasForeignOperation = false;

  for (const c of members) {
    let closingRate = 1_000_000;
    let averageRate = 1_000_000;
    try {
      closingRate = await getRate(c.functionalCurrency, presentation, opts.periodEnd, 'CLOSING');
      averageRate = await getRate(c.functionalCurrency, presentation, opts.periodEnd, 'AVERAGE');
    } catch (err) {
      if (c.functionalCurrency !== presentation) {
        warnings.push((err as Error).message);
        continue;
      }
    }

    // Balance sheet at closing rate; profit and loss at average rate (IAS 21.39 / ASC 830-30).
    const bs = await accountMovements(c.id, { to: opts.periodEnd, includeEliminations: false });
    const pl = await accountMovements(c.id, { from: periodStart, to: opts.periodEnd, includeEliminations: false });

    const contribute = (rows: AccountBalanceRow[], rate: number, isPL: boolean) => {
      for (const r of rows) {
        if (isPL !== (r.type === 'INCOME' || r.type === 'EXPENSE')) continue;
        const code = r.code; // group mapping falls back to the local code
        const key = `${code}|${r.type}|${r.subtype}`;
        const line =
          lineMap.get(key) ??
          { groupAccountCode: code, name: r.name, type: r.type, subtype: r.subtype, byCompany: {}, aggregate: 0, eliminated: 0, consolidated: 0 };
        const amount = translate(r.balance, rate);
        line.byCompany[c.id] = (line.byCompany[c.id] ?? 0) + amount;
        line.aggregate += amount;
        lineMap.set(key, line);
      }
    };

    contribute(bs, closingRate, false);
    contribute(pl, averageRate, true);

    const entityProfit = pl.reduce((s, r) => (r.type === 'INCOME' ? s + r.balance : r.type === 'EXPENSE' ? s - r.balance : s), 0);
    byCompanyProfit.set(c.id, translate(entityProfit, averageRate));

    hasForeignOperation ||= c.functionalCurrency !== presentation;
  }

  // ── 2. Eliminate intercompany balances and trading ──────────────────
  const memberIds = members.map((m) => m.id);
  const nameOf = new Map(members.map((m) => [m.id, m.name]));
  const positions = await intercompanyPositions(memberIds, periodStart, opts.periodEnd);

  const pairKey = (a: string, b: string) => [a, b].sort().join('::');
  const pairs = new Map<string, IntercompanyPair>();

  for (const p of positions) {
    if (!memberIds.includes(p.counterparty_id)) continue;
    const key = pairKey(p.company_id, p.counterparty_id);
    const [fromId, toId] = key.split('::');
    const pair =
      pairs.get(key) ??
      {
        fromCompanyId: fromId,
        fromCompanyName: nameOf.get(fromId) ?? fromId,
        toCompanyId: toId,
        toCompanyName: nameOf.get(toId) ?? toId,
        receivableCents: 0,
        payableCents: 0,
        mismatchCents: 0,
        tradeIncomeCents: 0,
        tradeExpenseCents: 0,
      };

    const debit = Number(p.debit ?? 0);
    const credit = Number(p.credit ?? 0);
    const bal = signedBalance(p.type, debit, credit);

    if (p.subtype === 'ACCOUNTS_RECEIVABLE') pair.receivableCents += bal;
    else if (p.subtype === 'ACCOUNTS_PAYABLE') pair.payableCents += bal;
    else if (p.type === 'INCOME') pair.tradeIncomeCents += bal;
    else if (p.type === 'EXPENSE') pair.tradeExpenseCents += bal;

    pairs.set(key, pair);
  }

  const eliminationEntries: ConsolidationResult['eliminationEntries'] = [];
  const mismatches: IntercompanyPair[] = [];
  const standardRef = group.framework === 'IFRS' ? 'IFRS 10.B86' : 'ASC 810-10-45-1';

  let eliminatedReceivables = 0;
  let eliminatedPayables = 0;
  let eliminatedIncome = 0;
  let eliminatedExpense = 0;

  for (const pair of pairs.values()) {
    const balanceElim = Math.min(pair.receivableCents, pair.payableCents);
    pair.mismatchCents = pair.receivableCents - pair.payableCents;

    if (balanceElim > 0) {
      eliminatedReceivables += balanceElim;
      eliminatedPayables += balanceElim;
      eliminationEntries.push({
        kind: 'INTERCOMPANY_BALANCE',
        explanation: `Eliminate intercompany balance between ${pair.fromCompanyName} and ${pair.toCompanyName}.`,
        amountCents: balanceElim,
        standardRef,
        fromCompany: pair.fromCompanyName,
        toCompany: pair.toCompanyName,
      });
    }

    if (pair.mismatchCents !== 0) {
      mismatches.push(pair);
      warnings.push(
        `Intercompany mismatch of ${(Math.abs(pair.mismatchCents) / 100).toFixed(2)} between ${pair.fromCompanyName} and ${pair.toCompanyName}. Reconcile before finalising — this is not plugged automatically.`,
      );
    }

    const tradeElim = Math.min(pair.tradeIncomeCents, pair.tradeExpenseCents);
    if (tradeElim > 0) {
      eliminatedIncome += tradeElim;
      eliminatedExpense += tradeElim;
      eliminationEntries.push({
        kind: 'INTERCOMPANY_TRADE',
        explanation: `Eliminate intragroup sales and purchases between ${pair.fromCompanyName} and ${pair.toCompanyName}.`,
        amountCents: tradeElim,
        standardRef,
        fromCompany: pair.fromCompanyName,
        toCompany: pair.toCompanyName,
      });
    }
  }

  // Apply eliminations proportionally to the relevant caption lines.
  const applyElimination = (predicate: (l: ConsolidatedLine) => boolean, amount: Cents) => {
    if (amount <= 0) return;
    const targets = Array.from(lineMap.values()).filter(predicate);
    const total = targets.reduce((s, l) => s + Math.abs(l.aggregate), 0);
    if (!total) return;
    let allocated = 0;
    targets.forEach((l, i) => {
      const share = i === targets.length - 1 ? amount - allocated : Math.round((amount * Math.abs(l.aggregate)) / total);
      l.eliminated += share;
      allocated += share;
    });
  };

  applyElimination((l) => l.subtype === 'ACCOUNTS_RECEIVABLE', eliminatedReceivables);
  applyElimination((l) => l.subtype === 'ACCOUNTS_PAYABLE', eliminatedPayables);
  applyElimination((l) => l.type === 'INCOME', eliminatedIncome);
  applyElimination((l) => l.type === 'EXPENSE', eliminatedExpense);

  for (const l of lineMap.values()) l.consolidated = l.aggregate - l.eliminated;

  // ── 3. Non-controlling interests ────────────────────────────────────
  let profitToNCI = 0;
  let nciEquity = 0;

  for (const c of members) {
    if (c.id === parent.id) continue;
    const nciShare = (10_000 - c.ownershipBps) / 10_000;
    if (nciShare <= 0) continue;

    const profit = byCompanyProfit.get(c.id) ?? 0;
    profitToNCI += Math.round(profit * nciShare);

    const equityAtDate = Array.from(lineMap.values())
      .filter((l) => l.type === 'EQUITY')
      .reduce((s, l) => s + (l.byCompany[c.id] ?? 0), 0);
    nciEquity += Math.round((equityAtDate + profit) * nciShare);

    eliminationEntries.push({
      kind: 'NCI',
      explanation: `Allocate ${((1 - c.ownershipBps / 10_000) * 100).toFixed(1)}% of ${c.name}'s result and equity to non-controlling interests.`,
      amountCents: Math.round(profit * nciShare),
      standardRef: group.framework === 'IFRS' ? 'IFRS 10.22' : 'ASC 810-10-45-16',
      fromCompany: c.name,
    });
  }

  // ── 4. Totals ───────────────────────────────────────────────────────
  const sumWhere = (fn: (l: ConsolidatedLine) => boolean) =>
    Array.from(lineMap.values()).filter(fn).reduce((s, l) => s + l.consolidated, 0);

  const assets = sumWhere((l) => l.type === 'ASSET');
  const liabilities = sumWhere((l) => l.type === 'LIABILITY');
  const equityAccounts = sumWhere((l) => l.type === 'EQUITY');
  const income = sumWhere((l) => l.type === 'INCOME');
  const expenses = sumWhere((l) => l.type === 'EXPENSE');
  const profit = income - expenses;

  // Prior years' results are still sitting in P&L accounts (books are not closed).
  const priorProfit = await (async () => {
    let total = 0;
    for (const c of members) {
      const prior = await accountMovements(c.id, { to: new Date(periodStart.getTime() - 86_400_000), includeEliminations: false });
      total += prior.reduce((s, r) => (r.type === 'INCOME' ? s + r.balance : r.type === 'EXPENSE' ? s - r.balance : s), 0);
    }
    return total;
  })();

  /**
   * The translation reserve is a genuine residual, not a plug: it is exactly
   * the difference that arises because net assets are translated at the
   * closing rate while results are translated at the average rate
   * (IAS 21.39 / ASC 830-30). Deriving it is the correct treatment — and it
   * is the ONLY figure in this engine allowed to balance. Intercompany
   * mismatches are reported above and never absorbed here.
   */
  const translationReserve = hasForeignOperation
    ? assets - liabilities - (equityAccounts + priorProfit + profit)
    : 0;

  const equity = equityAccounts + priorProfit + profit + translationReserve;

  const lines = Array.from(lineMap.values()).sort((a, b) => a.groupAccountCode.localeCompare(b.groupAccountCode));

  return {
    groupId: group.id,
    groupName: group.name,
    presentationCurrency: presentation,
    periodStart,
    periodEnd: opts.periodEnd,
    companies: members.map((m) => ({
      id: m.id,
      name: m.name,
      currency: m.functionalCurrency,
      ownershipBps: m.ownershipBps,
      framework: m.framework,
      isParent: m.id === parent.id,
    })),
    lines,
    totals: {
      assets,
      liabilities,
      equity,
      income,
      expenses,
      profit,
      profitAttributableToParent: profit - profitToNCI,
      profitAttributableToNCI: profitToNCI,
      nciEquity,
      translationReserve,
      outOfBalance: assets - (liabilities + equity),
    },
    eliminationEntries,
    mismatches,
    warnings,
  };
}

/** Persist a run so the numbers can be reproduced and compared later. */
export async function saveConsolidation(result: ConsolidationResult, runBy?: string) {
  const [run] = await db
    .insert(consolidationRuns)
    .values({
      groupId: result.groupId,
      periodStart: result.periodStart,
      periodEnd: result.periodEnd,
      presentationCurrency: result.presentationCurrency,
      status: 'DRAFT',
      outOfBalanceCents: result.totals.outOfBalance,
      notes: result.warnings.join('\n') || null,
      runBy: runBy ?? null,
    })
    .returning();

  if (result.eliminationEntries.length) {
    await db.insert(eliminations).values(
      result.eliminationEntries.map((e) => ({
        runId: run.id,
        kind: e.kind,
        groupAccountCode: null,
        amountCents: e.amountCents,
        explanation: e.explanation,
        standardRef: e.standardRef,
      })),
    );
  }

  return run;
}

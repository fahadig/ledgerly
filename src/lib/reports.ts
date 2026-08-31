/**
 * Reporting queries. These read the general ledger only — never the
 * sub-ledgers — so if a report is wrong, the ledger is wrong, and that is the
 * one thing the posting engine guarantees cannot happen.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from './db';
import { bills, contacts, invoices, journalEntries, journalLines, accounts } from '@/db/schema';
import type { AccountSubtype, AccountType } from '@/db/schema';
import { signedBalance } from './ledger';
import type { Cents } from './money';

export interface AccountBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: AccountSubtype;
  debit: Cents;
  credit: Cents;
  /** Positive in the account's natural direction. */
  balance: Cents;
}

/**
 * Ledger movement per account between two dates (inclusive).
 * Omit `from` for balance-sheet accounts (inception to date).
 */
export async function accountMovements(
  companyId: string,
  opts: {
    from?: Date;
    to: Date;
    includeZero?: boolean;
    includeEliminations?: boolean;
    /** Restrict to lines tagged with this dimension value (a department, say). */
    dimensionValueId?: string | null;
  },
): Promise<AccountBalanceRow[]> {
  const from = opts.from ? sql`AND je.date >= ${opts.from.toISOString().slice(0, 10)}` : sql``;
  const elim = opts.includeEliminations === false ? sql`AND je.is_elimination = false` : sql``;
  const dim = opts.dimensionValueId
    ? sql`AND jl.dimension_value_ids @> ${JSON.stringify([opts.dimensionValueId])}::jsonb`
    : sql``;

  // The movement subquery is filtered BEFORE the join to accounts. Putting the
  // date predicate in a LEFT JOIN ... ON clause instead would keep unmatched
  // lines in the result and still add them to SUM(), which silently turns
  // every period report into an all-time report.
  const result = await db.execute(sql`
    SELECT a.id,
           a.code,
           a.name,
           a.type::text     AS type,
           a.subtype::text  AS subtype,
           COALESCE(m.debit, 0)  AS debit,
           COALESCE(m.credit, 0) AS credit
    FROM accounts a
    LEFT JOIN (
      SELECT jl.account_id,
             SUM(jl.debit_cents)  AS debit,
             SUM(jl.credit_cents) AS credit
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      WHERE je.company_id = ${companyId}
        AND je.is_void = false
        AND je.date <= ${opts.to.toISOString().slice(0, 10)}
        ${from}
        ${elim}
        ${dim}
      GROUP BY jl.account_id
    ) m ON m.account_id = a.id
    WHERE a.company_id = ${companyId}
    ORDER BY a.code ASC
  `);

  const rows = result.rows as unknown as {
    id: string;
    code: string;
    name: string;
    type: AccountType;
    subtype: AccountSubtype;
    debit: number | string;
    credit: number | string;
  }[];

  return rows
    .map((r) => {
      const debit = Number(r.debit ?? 0);
      const credit = Number(r.credit ?? 0);
      return {
        accountId: r.id,
        code: r.code,
        name: r.name,
        type: r.type,
        subtype: r.subtype,
        debit,
        credit,
        balance: signedBalance(r.type, debit, credit),
      };
    })
    .filter((r) => (opts.includeZero ? true : r.debit !== 0 || r.credit !== 0));
}

// ─────────────────────────── Trial balance ───────────────────────────

export interface TrialBalance {
  asOf: Date;
  rows: AccountBalanceRow[];
  totalDebit: Cents;
  totalCredit: Cents;
  /** Always 0 in a sound ledger. Anything else means the engine was bypassed. */
  outOfBalance: Cents;
}

export async function trialBalance(companyId: string, asOf: Date): Promise<TrialBalance> {
  const all = await accountMovements(companyId, { to: asOf });
  const rows = all.map((r) => {
    const net = r.debit - r.credit;
    return { ...r, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 };
  });
  const totalDebit = rows.reduce((s, r) => s + r.debit, 0);
  const totalCredit = rows.reduce((s, r) => s + r.credit, 0);
  return { asOf, rows, totalDebit, totalCredit, outOfBalance: totalDebit - totalCredit };
}

// ─────────────────────────── Profit & loss ───────────────────────────

export interface PLSection {
  title: string;
  rows: AccountBalanceRow[];
  total: Cents;
}

export interface ProfitAndLoss {
  from: Date;
  to: Date;
  income: PLSection;
  cogs: PLSection;
  grossProfit: Cents;
  expenses: PLSection;
  otherIncome: PLSection;
  otherExpense: PLSection;
  operatingIncome: Cents;
  netIncome: Cents;
}

export async function profitAndLoss(
  companyId: string,
  from: Date,
  to: Date,
  dimensionValueId?: string | null,
): Promise<ProfitAndLoss> {
  const rows = await accountMovements(companyId, { from, to, dimensionValueId });
  const pick = (subtypes: AccountSubtype[]) => rows.filter((r) => subtypes.includes(r.subtype));
  const sum = (rs: AccountBalanceRow[]) => rs.reduce((s, r) => s + r.balance, 0);

  const income = { title: 'Income', rows: pick(['INCOME']), total: 0 };
  income.total = sum(income.rows);
  const cogs = { title: 'Cost of sales', rows: pick(['COST_OF_GOODS_SOLD']), total: 0 };
  cogs.total = sum(cogs.rows);
  const expenses = { title: 'Operating expenses', rows: pick(['EXPENSE']), total: 0 };
  expenses.total = sum(expenses.rows);
  const otherIncome = { title: 'Other income', rows: pick(['OTHER_INCOME']), total: 0 };
  otherIncome.total = sum(otherIncome.rows);
  const otherExpense = { title: 'Other expenses', rows: pick(['OTHER_EXPENSE']), total: 0 };
  otherExpense.total = sum(otherExpense.rows);

  const grossProfit = income.total - cogs.total;
  const operatingIncome = grossProfit - expenses.total;
  const netIncome = operatingIncome + otherIncome.total - otherExpense.total;

  return { from, to, income, cogs, grossProfit, expenses, otherIncome, otherExpense, operatingIncome, netIncome };
}

// ─────────────────────────── Balance sheet ───────────────────────────

export interface BalanceSheet {
  asOf: Date;
  currentAssets: PLSection;
  fixedAssets: PLSection;
  otherAssets: PLSection;
  totalAssets: Cents;
  currentLiabilities: PLSection;
  longTermLiabilities: PLSection;
  totalLiabilities: Cents;
  equity: PLSection;
  retainedEarningsBrought: Cents;
  netIncome: Cents;
  totalEquity: Cents;
  totalLiabilitiesAndEquity: Cents;
  /** Assets − (liabilities + equity). Always 0 in a sound ledger. */
  difference: Cents;
}

/** Start of the fiscal year containing `date`. */
export function fiscalYearStart(date: Date, startMonth = 1): Date {
  const y = date.getUTCFullYear();
  const start = new Date(Date.UTC(y, startMonth - 1, 1));
  return date < start ? new Date(Date.UTC(y - 1, startMonth - 1, 1)) : start;
}

export async function balanceSheet(companyId: string, asOf: Date, fiscalStartMonth = 1): Promise<BalanceSheet> {
  const rows = await accountMovements(companyId, { to: asOf });
  const pick = (subtypes: AccountSubtype[]) => rows.filter((r) => subtypes.includes(r.subtype));
  const sum = (rs: AccountBalanceRow[]) => rs.reduce((s, r) => s + r.balance, 0);

  const mk = (title: string, subtypes: AccountSubtype[]) => {
    const rs = pick(subtypes);
    return { title, rows: rs, total: sum(rs) };
  };

  const currentAssets = mk('Current assets', ['BANK', 'ACCOUNTS_RECEIVABLE', 'OTHER_CURRENT_ASSET']);
  const fixedAssets = mk('Non-current assets', ['FIXED_ASSET']);
  const otherAssets = mk('Other assets', ['OTHER_ASSET']);
  const currentLiabilities = mk('Current liabilities', ['ACCOUNTS_PAYABLE', 'CREDIT_CARD', 'OTHER_CURRENT_LIABILITY']);
  const longTermLiabilities = mk('Non-current liabilities', ['LONG_TERM_LIABILITY']);
  const equity = mk('Equity', ['EQUITY']);

  // Income and expense accounts are not closed out, so this year's result is
  // shown as "Profit for the period" and prior years as retained earnings.
  const fyStart = fiscalYearStart(asOf, fiscalStartMonth);
  const pl = await profitAndLoss(companyId, fyStart, asOf);

  const priorRows = await accountMovements(companyId, { to: new Date(fyStart.getTime() - 86_400_000) });
  const retainedEarningsBrought = priorRows
    .filter((r) => r.type === 'INCOME' || r.type === 'EXPENSE')
    .reduce((s, r) => (r.type === 'INCOME' ? s + r.balance : s - r.balance), 0);

  const totalAssets = currentAssets.total + fixedAssets.total + otherAssets.total;
  const totalLiabilities = currentLiabilities.total + longTermLiabilities.total;
  const totalEquity = equity.total + retainedEarningsBrought + pl.netIncome;

  return {
    asOf,
    currentAssets,
    fixedAssets,
    otherAssets,
    totalAssets,
    currentLiabilities,
    longTermLiabilities,
    totalLiabilities,
    equity,
    retainedEarningsBrought,
    netIncome: pl.netIncome,
    totalEquity,
    totalLiabilitiesAndEquity: totalLiabilities + totalEquity,
    difference: totalAssets - (totalLiabilities + totalEquity),
  };
}

// ─────────────────────────── Aging ───────────────────────────────────

export interface AgingRow {
  contactId: string;
  contactName: string;
  current: Cents;
  d1_30: Cents;
  d31_60: Cents;
  d61_90: Cents;
  d90plus: Cents;
  total: Cents;
}

export async function aging(companyId: string, kind: 'AR' | 'AP', asOf = new Date()): Promise<AgingRow[]> {
  const open = ['OPEN', 'PARTIAL', 'OVERDUE'] as const;

  const docs =
    kind === 'AR'
      ? await db
          .select({
            dueDate: invoices.dueDate,
            totalCents: invoices.totalCents,
            paidCents: invoices.paidCents,
            contactId: contacts.id,
            contactName: contacts.displayName,
          })
          .from(invoices)
          .innerJoin(contacts, eq(contacts.id, invoices.customerId))
          .where(and(eq(invoices.companyId, companyId), inArray(invoices.status, [...open])))
      : await db
          .select({
            dueDate: bills.dueDate,
            totalCents: bills.totalCents,
            paidCents: bills.paidCents,
            contactId: contacts.id,
            contactName: contacts.displayName,
          })
          .from(bills)
          .innerJoin(contacts, eq(contacts.id, bills.vendorId))
          .where(and(eq(bills.companyId, companyId), inArray(bills.status, [...open])));

  const byContact = new Map<string, AgingRow>();
  for (const d of docs) {
    const outstanding = d.totalCents - d.paidCents;
    if (outstanding <= 0) continue;
    const daysLate = Math.floor((asOf.getTime() - new Date(d.dueDate).getTime()) / 86_400_000);

    const row =
      byContact.get(d.contactId) ??
      { contactId: d.contactId, contactName: d.contactName, current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0, total: 0 };

    if (daysLate <= 0) row.current += outstanding;
    else if (daysLate <= 30) row.d1_30 += outstanding;
    else if (daysLate <= 60) row.d31_60 += outstanding;
    else if (daysLate <= 90) row.d61_90 += outstanding;
    else row.d90plus += outstanding;

    row.total += outstanding;
    byContact.set(d.contactId, row);
  }

  return Array.from(byContact.values()).sort((a, b) => b.total - a.total);
}

// ─────────────────────────── Dashboard ───────────────────────────────

export interface DashboardData {
  bankBalance: Cents;
  arOutstanding: Cents;
  arOverdue: Cents;
  apOutstanding: Cents;
  apOverdue: Cents;
  netIncomeYTD: Cents;
  incomeYTD: Cents;
  expensesYTD: Cents;
  monthly: { month: string; income: Cents; expenses: Cents; net: Cents }[];
  expenseMix: { name: string; amount: Cents }[];
}

export async function dashboard(companyId: string, asOf = new Date(), fiscalStartMonth = 1): Promise<DashboardData> {
  const fyStart = fiscalYearStart(asOf, fiscalStartMonth);
  const [balances, pl, ar, ap] = await Promise.all([
    accountMovements(companyId, { to: asOf }),
    profitAndLoss(companyId, fyStart, asOf),
    aging(companyId, 'AR', asOf),
    aging(companyId, 'AP', asOf),
  ]);

  const bankBalance = balances.filter((r) => r.subtype === 'BANK').reduce((s, r) => s + r.balance, 0);
  const sumAging = (rows: AgingRow[]) => ({
    total: rows.reduce((s, r) => s + r.total, 0),
    overdue: rows.reduce((s, r) => s + r.d1_30 + r.d31_60 + r.d61_90 + r.d90plus, 0),
  });
  const arSum = sumAging(ar);
  const apSum = sumAging(ap);

  const start = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - 11, 1));
  const trend = await db.execute(sql`
    SELECT to_char(date_trunc('month', je.date), 'YYYY-MM') AS month,
           a.type::text AS type,
           SUM(CASE WHEN a.type = 'INCOME'
                    THEN jl.credit_cents - jl.debit_cents
                    ELSE jl.debit_cents - jl.credit_cents END) AS amount
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id AND je.is_void = false
    JOIN accounts a ON a.id = jl.account_id
    WHERE a.company_id = ${companyId}
      AND a.type IN ('INCOME', 'EXPENSE')
      AND je.date >= ${start.toISOString().slice(0, 10)}
      AND je.date <= ${asOf.toISOString().slice(0, 10)}
    GROUP BY 1, 2
    ORDER BY 1 ASC
  `);

  const monthMap = new Map<string, { month: string; income: Cents; expenses: Cents; net: Cents }>();
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - 11 + i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    monthMap.set(key, { month: key, income: 0, expenses: 0, net: 0 });
  }
  for (const r of trend.rows as unknown as { month: string; type: AccountType; amount: number | string }[]) {
    const entry = monthMap.get(r.month);
    if (!entry) continue;
    if (r.type === 'INCOME') entry.income += Number(r.amount);
    else entry.expenses += Number(r.amount);
    entry.net = entry.income - entry.expenses;
  }

  const expenseMix = balances
    .filter((r) => r.type === 'EXPENSE' && r.balance > 0)
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 6)
    .map((r) => ({ name: r.name, amount: r.balance }));

  return {
    bankBalance,
    arOutstanding: arSum.total,
    arOverdue: arSum.overdue,
    apOutstanding: apSum.total,
    apOverdue: apSum.overdue,
    netIncomeYTD: pl.netIncome,
    incomeYTD: pl.income.total + pl.otherIncome.total,
    expensesYTD: pl.cogs.total + pl.expenses.total + pl.otherExpense.total,
    monthly: Array.from(monthMap.values()),
    expenseMix,
  };
}

// ─────────────────────── General ledger detail ───────────────────────

export interface GLEntry {
  id: string;
  entryNo: string;
  date: Date;
  memo: string | null;
  source: string;
  aiAssisted: boolean;
  standardRefs: string[] | null;
  settlementRail: string | null;
  settlementRef: { reference?: string; chainId?: string; txHash?: string; address?: string } | null;
  lines: {
    accountCode: string;
    accountName: string;
    debitCents: Cents;
    creditCents: Cents;
    description: string | null;
    contactName: string | null;
  }[];
}

export async function generalLedger(
  companyId: string,
  opts: { from: Date; to: Date; accountId?: string; limit?: number },
): Promise<GLEntry[]> {
  const accountFilter = opts.accountId
    ? sql`AND EXISTS (SELECT 1 FROM journal_lines x WHERE x.entry_id = je.id AND x.account_id = ${opts.accountId})`
    : sql``;

  const result = await db.execute(sql`
    SELECT je.id, je.entry_no, je.date, je.memo, je.source::text AS source,
           je.ai_assisted, je.standard_refs,
           je.settlement_rail::text AS settlement_rail, je.settlement_ref,
           json_agg(json_build_object(
             'accountCode', a.code,
             'accountName', a.name,
             'debitCents', jl.debit_cents,
             'creditCents', jl.credit_cents,
             'description', jl.description,
             'contactName', c.display_name
           ) ORDER BY jl.line_no) AS lines
    FROM journal_entries je
    JOIN journal_lines jl ON jl.entry_id = je.id
    JOIN accounts a ON a.id = jl.account_id
    LEFT JOIN contacts c ON c.id = jl.contact_id
    WHERE je.company_id = ${companyId}
      AND je.is_void = false
      AND je.date >= ${opts.from.toISOString().slice(0, 10)}
      AND je.date <= ${opts.to.toISOString().slice(0, 10)}
      ${accountFilter}
    GROUP BY je.id
    ORDER BY je.date DESC, je.entry_no DESC
    LIMIT ${opts.limit ?? 200}
  `);

  return (result.rows as unknown as (Omit<GLEntry, 'date' | 'lines'> & { entry_no: string; ai_assisted: boolean; standard_refs: string[] | null; date: string; lines: GLEntry['lines'] })[]).map((r) => ({
    id: r.id,
    entryNo: r.entry_no,
    date: new Date(r.date),
    memo: r.memo,
    source: r.source,
    aiAssisted: r.ai_assisted,
    standardRefs: r.standard_refs,
    settlementRail: (r as unknown as { settlement_rail: string | null }).settlement_rail,
    settlementRef: (r as unknown as { settlement_ref: GLEntry['settlementRef'] }).settlement_ref,
    lines: (r.lines ?? []).map((l) => ({
      ...l,
      debitCents: Number(l.debitCents),
      creditCents: Number(l.creditCents),
    })),
  }));
}

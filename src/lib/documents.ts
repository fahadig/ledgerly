/**
 * Document layer — invoices, bills, expenses, payments.
 * Each document writes its own rows AND its general-ledger entry inside one
 * database transaction, so the sub-ledger can never drift from the GL.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from './db';
import {
  accounts,
  billLines,
  bills,
  contacts,
  expenseLines,
  expenses,
  invoiceLines,
  invoices,
  paymentAllocations,
  payments,
  taxRates,
} from '@/db/schema';
import { LedgerError, postJournal, systemAccount, type PostLine } from './ledger';
import { applyBps, lineAmount, type Cents } from './money';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function nextRef(tx: Tx, table: 'invoices' | 'bills' | 'payments' | 'expenses', companyId: string, prefix: string) {
  const map = {
    invoices: { t: invoices, col: invoices.number, company: invoices.companyId },
    bills: { t: bills, col: bills.number, company: bills.companyId },
    payments: { t: payments, col: payments.reference, company: payments.companyId },
    expenses: { t: expenses, col: expenses.reference, company: expenses.companyId },
  }[table];

  const [last] = await tx
    .select({ v: map.col })
    .from(map.t)
    .where(and(eq(map.company, companyId), sql`${map.col} LIKE ${prefix + '%'}`))
    .orderBy(desc(map.col))
    .limit(1);

  const n = last?.v ? Number(String(last.v).slice(prefix.length)) + 1 : 1;
  return prefix + String(n).padStart(4, '0');
}

export interface DocLineInput {
  itemId?: string | null;
  description: string;
  /** Thousandths — 1.5 units is 1500. Defaults to 1. */
  quantity?: number;
  unitPriceCents: Cents;
  accountId: string;
  taxRateId?: string | null;
  /** Department / project tags, written onto the GL line with the entry. */
  dimensionValueIds?: string[] | null;
}

interface ComputedLine extends DocLineInput {
  quantity: number;
  amountCents: Cents;
  taxCents: Cents;
}

async function computeLines(tx: Tx, lines: DocLineInput[]) {
  if (!lines.length) throw new LedgerError('Document needs at least one line.');

  const taxIds = Array.from(new Set(lines.map((l) => l.taxRateId).filter(Boolean))) as string[];
  const rates = taxIds.length ? await tx.select().from(taxRates).where(inArray(taxRates.id, taxIds)) : [];
  const rateMap = new Map(rates.map((r) => [r.id, r.rateBps]));

  let subtotal = 0;
  let tax = 0;
  const computed: ComputedLine[] = lines.map((l) => {
    const qty = l.quantity ?? 1000;
    const amount = lineAmount(qty, l.unitPriceCents);
    const bps = l.taxRateId ? rateMap.get(l.taxRateId) ?? 0 : 0;
    const lineTax = applyBps(amount, bps);
    subtotal += amount;
    tax += lineTax;
    return { ...l, quantity: qty, amountCents: amount, taxCents: lineTax };
  });

  return { lines: computed, subtotal, tax, total: subtotal + tax };
}

// ─────────────────────────── Invoice ─────────────────────────────────

export interface CreateInvoiceInput {
  companyId: string;
  customerId: string;
  date: Date;
  dueDate?: Date;
  memo?: string | null;
  number?: string;
  aiAssisted?: boolean;
  standardRefs?: string[];
  createdBy?: string;
  lines: DocLineInput[];
}

export async function createInvoice(input: CreateInvoiceInput) {
  return db.transaction(async (tx) => {
    const [customer] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, input.customerId), eq(contacts.companyId, input.companyId)))
      .limit(1);
    if (!customer) throw new LedgerError('Customer not found.');

    const { lines, subtotal, tax, total } = await computeLines(tx, input.lines);
    if (total <= 0) throw new LedgerError('Invoice total must be greater than zero.');

    const ar = await systemAccount(input.companyId, 'ACCOUNTS_RECEIVABLE', tx);

    let taxAccountId: string | null = null;
    if (tax > 0) {
      const [taxAcc] = await tx
        .select()
        .from(accounts)
        .where(
          and(
            eq(accounts.companyId, input.companyId),
            sql`${accounts.subtype}::text = 'OTHER_CURRENT_LIABILITY'`,
            sql`${accounts.name} ILIKE '%tax%'`,
          ),
        )
        .limit(1);
      if (!taxAcc) throw new LedgerError('No sales-tax liability account configured.');
      taxAccountId = taxAcc.id;
    }

    const dueDate = input.dueDate ?? new Date(input.date.getTime() + customer.termsDays * 86_400_000);
    const number = input.number ?? (await nextRef(tx, 'invoices', input.companyId, 'INV-'));

    const [invoice] = await tx
      .insert(invoices)
      .values({
        companyId: input.companyId,
        number,
        customerId: input.customerId,
        date: input.date,
        dueDate,
        memo: input.memo ?? null,
        status: 'OPEN',
        subtotalCents: subtotal,
        taxCents: tax,
        totalCents: total,
        aiAssisted: input.aiAssisted ?? false,
      })
      .returning();

    await tx.insert(invoiceLines).values(
      lines.map((l, i) => ({
        invoiceId: invoice.id,
        lineNo: i + 1,
        itemId: l.itemId ?? null,
        description: l.description,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        amountCents: l.amountCents,
        accountId: l.accountId,
        taxRateId: l.taxRateId ?? null,
        taxCents: l.taxCents,
      })),
    );

    // Dr Accounts Receivable / Cr Income (+ Cr Tax Payable)
    const gl: PostLine[] = [
      { accountId: ar.id, debit: total, description: `Invoice ${number}`, contactId: input.customerId },
      ...lines.map((l) => ({
        accountId: l.accountId,
        credit: l.amountCents,
        description: l.description,
        contactId: input.customerId,
        dimensionValueIds: l.dimensionValueIds ?? null,
      })),
    ];
    if (tax > 0 && taxAccountId) {
      gl.push({ accountId: taxAccountId, credit: tax, description: `Sales tax on ${number}`, contactId: input.customerId });
    }

    await postJournal(
      {
        companyId: input.companyId,
        date: input.date,
        memo: `Invoice ${number} — ${customer.displayName}`,
        source: 'INVOICE',
        sourceId: invoice.id,
        aiAssisted: input.aiAssisted ?? false,
        standardRefs: input.standardRefs ?? null,
        counterpartyCompanyId: customer.relatedCompanyId ?? null,
        createdBy: input.createdBy,
        lines: gl,
      },
      tx,
    );

    return invoice;
  });
}

// ─────────────────────────── Bill ────────────────────────────────────

export interface CreateBillInput {
  companyId: string;
  vendorId: string;
  date: Date;
  dueDate?: Date;
  memo?: string | null;
  number?: string;
  aiAssisted?: boolean;
  standardRefs?: string[];
  createdBy?: string;
  lines: DocLineInput[];
}

export async function createBill(input: CreateBillInput) {
  return db.transaction(async (tx) => {
    const [vendor] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, input.vendorId), eq(contacts.companyId, input.companyId)))
      .limit(1);
    if (!vendor) throw new LedgerError('Vendor not found.');

    const { lines, subtotal, tax, total } = await computeLines(tx, input.lines);
    if (total <= 0) throw new LedgerError('Bill total must be greater than zero.');

    const ap = await systemAccount(input.companyId, 'ACCOUNTS_PAYABLE', tx);
    const dueDate = input.dueDate ?? new Date(input.date.getTime() + vendor.termsDays * 86_400_000);
    const number = input.number ?? (await nextRef(tx, 'bills', input.companyId, 'BILL-'));

    const [bill] = await tx
      .insert(bills)
      .values({
        companyId: input.companyId,
        number,
        vendorId: input.vendorId,
        date: input.date,
        dueDate,
        memo: input.memo ?? null,
        status: 'OPEN',
        subtotalCents: subtotal,
        taxCents: tax,
        totalCents: total,
        aiAssisted: input.aiAssisted ?? false,
      })
      .returning();

    await tx.insert(billLines).values(
      lines.map((l, i) => ({
        billId: bill.id,
        lineNo: i + 1,
        itemId: l.itemId ?? null,
        description: l.description,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        amountCents: l.amountCents,
        accountId: l.accountId,
        taxRateId: l.taxRateId ?? null,
        taxCents: l.taxCents,
      })),
    );

    // Dr Expense/Asset / Cr Accounts Payable
    await postJournal(
      {
        companyId: input.companyId,
        date: input.date,
        memo: `Bill ${number} — ${vendor.displayName}`,
        source: 'BILL',
        sourceId: bill.id,
        aiAssisted: input.aiAssisted ?? false,
        standardRefs: input.standardRefs ?? null,
        counterpartyCompanyId: vendor.relatedCompanyId ?? null,
        createdBy: input.createdBy,
        lines: [
          ...lines.map((l) => ({
            accountId: l.accountId,
            debit: l.amountCents + l.taxCents,
            description: l.description,
            contactId: input.vendorId,
            dimensionValueIds: l.dimensionValueIds ?? null,
          })),
          { accountId: ap.id, credit: total, description: `Bill ${number}`, contactId: input.vendorId },
        ],
      },
      tx,
    );

    return bill;
  });
}

// ─────────────────────────── Expense ─────────────────────────────────

export interface CreateExpenseInput {
  companyId: string;
  date: Date;
  vendorId?: string | null;
  paymentAccountId: string;
  method?: string;
  memo?: string | null;
  aiAssisted?: boolean;
  standardRefs?: string[];
  createdBy?: string;
  lines: { accountId: string; description: string; amountCents: Cents; dimensionValueIds?: string[] | null }[];
}

export async function createExpense(input: CreateExpenseInput) {
  return db.transaction(async (tx) => {
    const total = input.lines.reduce((s, l) => s + l.amountCents, 0);
    if (total <= 0) throw new LedgerError('Expense total must be greater than zero.');

    const [payAcc] = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, input.paymentAccountId), eq(accounts.companyId, input.companyId)))
      .limit(1);
    if (!payAcc) throw new LedgerError('Payment account not found.');
    if (!['BANK', 'CREDIT_CARD', 'OTHER_CURRENT_ASSET'].includes(payAcc.subtype)) {
      throw new LedgerError('Expenses must be paid from a bank, cash or credit-card account.');
    }

    const reference = await nextRef(tx, 'expenses', input.companyId, 'EXP-');

    const [expense] = await tx
      .insert(expenses)
      .values({
        companyId: input.companyId,
        reference,
        date: input.date,
        vendorId: input.vendorId ?? null,
        paymentAccountId: input.paymentAccountId,
        method: input.method ?? 'CARD',
        memo: input.memo ?? null,
        totalCents: total,
        aiAssisted: input.aiAssisted ?? false,
      })
      .returning();

    await tx.insert(expenseLines).values(
      input.lines.map((l, i) => ({
        expenseId: expense.id,
        lineNo: i + 1,
        accountId: l.accountId,
        description: l.description,
        amountCents: l.amountCents,
      })),
    );

    await postJournal(
      {
        companyId: input.companyId,
        date: input.date,
        memo: `Expense ${reference}${input.memo ? ` — ${input.memo}` : ''}`,
        source: 'EXPENSE',
        sourceId: expense.id,
        aiAssisted: input.aiAssisted ?? false,
        standardRefs: input.standardRefs ?? null,
        createdBy: input.createdBy,
        lines: [
          ...input.lines.map((l) => ({
            accountId: l.accountId,
            debit: l.amountCents,
            description: l.description,
            contactId: input.vendorId ?? null,
            dimensionValueIds: l.dimensionValueIds ?? null,
          })),
          {
            accountId: input.paymentAccountId,
            credit: total,
            description: `Paid via ${payAcc.name}`,
            contactId: input.vendorId ?? null,
          },
        ],
      },
      tx,
    );

    return expense;
  });
}

// ─────────────────────────── Payments ────────────────────────────────

export interface CreatePaymentInput {
  companyId: string;
  kind: 'RECEIVED' | 'MADE';
  contactId: string;
  date: Date;
  bankAccountId: string;
  method?: string;
  memo?: string | null;
  aiAssisted?: boolean;
  createdBy?: string;
  allocations: { invoiceId?: string; billId?: string; amountCents: Cents }[];
}

export async function createPayment(input: CreatePaymentInput) {
  return db.transaction(async (tx) => {
    const amount = input.allocations.reduce((s, a) => s + a.amountCents, 0);
    if (amount <= 0) throw new LedgerError('Payment amount must be greater than zero.');

    const [bank] = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, input.bankAccountId), eq(accounts.companyId, input.companyId)))
      .limit(1);
    if (!bank) throw new LedgerError('Bank account not found.');

    const [contact] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, input.contactId), eq(contacts.companyId, input.companyId)))
      .limit(1);
    if (!contact) throw new LedgerError('Contact not found.');

    const control = await systemAccount(
      input.companyId,
      input.kind === 'RECEIVED' ? 'ACCOUNTS_RECEIVABLE' : 'ACCOUNTS_PAYABLE',
      tx,
    );

    const reference = await nextRef(tx, 'payments', input.companyId, input.kind === 'RECEIVED' ? 'RCPT-' : 'PMT-');

    const [payment] = await tx
      .insert(payments)
      .values({
        companyId: input.companyId,
        reference,
        kind: input.kind,
        contactId: input.contactId,
        date: input.date,
        amountCents: amount,
        bankAccountId: input.bankAccountId,
        method: input.method ?? 'BANK_TRANSFER',
        memo: input.memo ?? null,
        aiAssisted: input.aiAssisted ?? false,
      })
      .returning();

    await tx.insert(paymentAllocations).values(
      input.allocations.map((a) => ({
        paymentId: payment.id,
        invoiceId: a.invoiceId ?? null,
        billId: a.billId ?? null,
        amountCents: a.amountCents,
      })),
    );

    // Roll the settled documents forward.
    for (const a of input.allocations) {
      if (a.invoiceId) {
        const [inv] = await tx.select().from(invoices).where(eq(invoices.id, a.invoiceId)).limit(1);
        if (!inv) throw new LedgerError('Invoice not found.');
        const paid = inv.paidCents + a.amountCents;
        if (paid > inv.totalCents) throw new LedgerError(`Payment exceeds the balance of invoice ${inv.number}.`);
        await tx
          .update(invoices)
          .set({ paidCents: paid, status: paid >= inv.totalCents ? 'PAID' : 'PARTIAL' })
          .where(eq(invoices.id, a.invoiceId));
      }
      if (a.billId) {
        const [bill] = await tx.select().from(bills).where(eq(bills.id, a.billId)).limit(1);
        if (!bill) throw new LedgerError('Bill not found.');
        const paid = bill.paidCents + a.amountCents;
        if (paid > bill.totalCents) throw new LedgerError(`Payment exceeds the balance of bill ${bill.number}.`);
        await tx
          .update(bills)
          .set({ paidCents: paid, status: paid >= bill.totalCents ? 'PAID' : 'PARTIAL' })
          .where(eq(bills.id, a.billId));
      }
    }

    const gl =
      input.kind === 'RECEIVED'
        ? [
            { accountId: input.bankAccountId, debit: amount, description: `Receipt ${reference}`, contactId: input.contactId },
            { accountId: control.id, credit: amount, description: `Settles A/R — ${contact.displayName}`, contactId: input.contactId },
          ]
        : [
            { accountId: control.id, debit: amount, description: `Settles A/P — ${contact.displayName}`, contactId: input.contactId },
            { accountId: input.bankAccountId, credit: amount, description: `Payment ${reference}`, contactId: input.contactId },
          ];

    await postJournal(
      {
        companyId: input.companyId,
        date: input.date,
        memo: `${input.kind === 'RECEIVED' ? 'Payment received' : 'Payment made'} ${reference} — ${contact.displayName}`,
        source: input.kind === 'RECEIVED' ? 'PAYMENT_RECEIVED' : 'PAYMENT_MADE',
        sourceId: payment.id,
        aiAssisted: input.aiAssisted ?? false,
        counterpartyCompanyId: contact.relatedCompanyId ?? null,
        createdBy: input.createdBy,
        lines: gl,
      },
      tx,
    );

    return payment;
  });
}

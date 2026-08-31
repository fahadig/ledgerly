/**
 * Ledgerly database schema (Drizzle / PostgreSQL).
 *
 * Money rule for the whole codebase: every monetary column is a BIGINT of
 * minor units (cents) read as a JS number. A JS number holds every integer up
 * to 2^53 exactly — about $90 trillion in cents — so arithmetic is exact and
 * no floating point ever touches a balance.
 *
 * Quantities are integers in thousandths (1.5 units → 1500).
 * Tax rates are integers in basis points (17.00% → 1700).
 */

import { randomUUID } from 'node:crypto';
import { relations } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const id = () => text('id').primaryKey().$defaultFn(() => randomUUID());
const money = (name: string) => bigint(name, { mode: 'number' }).notNull().default(0);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

// ─────────────────────────── Enums ───────────────────────────────────

export const accountTypeEnum = pgEnum('account_type', [
  'ASSET',
  'LIABILITY',
  'EQUITY',
  'INCOME',
  'EXPENSE',
]);

export const accountSubtypeEnum = pgEnum('account_subtype', [
  'BANK',
  'ACCOUNTS_RECEIVABLE',
  'OTHER_CURRENT_ASSET',
  'FIXED_ASSET',
  'OTHER_ASSET',
  'ACCOUNTS_PAYABLE',
  'CREDIT_CARD',
  'OTHER_CURRENT_LIABILITY',
  'LONG_TERM_LIABILITY',
  'EQUITY',
  'INCOME',
  'OTHER_INCOME',
  'COST_OF_GOODS_SOLD',
  'EXPENSE',
  'OTHER_EXPENSE',
]);

export const contactKindEnum = pgEnum('contact_kind', ['CUSTOMER', 'VENDOR', 'BOTH']);

export const journalSourceEnum = pgEnum('journal_source', [
  'MANUAL',
  'INVOICE',
  'BILL',
  'PAYMENT_RECEIVED',
  'PAYMENT_MADE',
  'EXPENSE',
  'OPENING_BALANCE',
  'ADJUSTMENT',
]);

export const docStatusEnum = pgEnum('doc_status', [
  'DRAFT',
  'OPEN',
  'PARTIAL',
  'PAID',
  'VOID',
  'OVERDUE',
]);

export const paymentKindEnum = pgEnum('payment_kind', ['RECEIVED', 'MADE']);

/** The reporting framework a company's books are kept under. */
export const frameworkEnum = pgEnum('accounting_framework', ['IFRS', 'US_GAAP']);

export const roleEnum = pgEnum('member_role', [
  'OWNER', // full control including deleting companies
  'ADMIN', // manage users, settings, close periods
  'ACCOUNTANT', // post, adjust, close, run consolidation
  'BOOKKEEPER', // enter documents, cannot close or adjust
  'VIEWER', // read-only
]);

/** Where an encoded standard applies. Keeps the rule-set searchable. */
export const standardTopicEnum = pgEnum('standard_topic', [
  'REVENUE',
  'LEASES',
  'INVENTORY',
  'PPE',
  'INTANGIBLES',
  'IMPAIRMENT',
  'FINANCIAL_INSTRUMENTS',
  'PROVISIONS',
  'EMPLOYEE_BENEFITS',
  'INCOME_TAX',
  'FOREIGN_CURRENCY',
  'BORROWING_COSTS',
  'CONSOLIDATION',
  'RELATED_PARTIES',
  'CRYPTO_ASSETS',
  'GOVERNMENT_GRANTS',
  'PRESENTATION',
]);

/**
 * How money actually moved. The point of this enum is that a bank transfer, a
 * card charge, a Stripe payout and an on-chain transfer are the same kind of
 * thing to the ledger — they differ only in which reference proves them.
 */
export const settlementRailEnum = pgEnum('settlement_rail', [
  'BANK',
  'CARD',
  'CASH',
  'CHEQUE',
  'PROCESSOR', // Stripe, PayPal, a merchant of record
  'ONCHAIN',
]);

export const walletCustodyEnum = pgEnum('wallet_custody', [
  'SELF', // we hold the keys
  'EXCHANGE', // held on a venue
  'CUSTODIAN', // a qualified custodian holds them
  'SMART_CONTRACT', // a multisig, safe or protocol position
]);

export const onchainTxnStatusEnum = pgEnum('onchain_txn_status', [
  'UNMATCHED',
  'SUGGESTED',
  'INTERNAL_TRANSFER',
  'RECONCILED',
  'EXCLUDED',
]);

export const bankTxnStatusEnum = pgEnum('bank_txn_status', [
  'UNMATCHED',
  'SUGGESTED',
  'CATEGORISED',
  'RECONCILED',
  'EXCLUDED',
]);

// ─────────────────────── Group & users ───────────────────────────────

/**
 * A reporting group. Consolidated statements are produced at this level;
 * each member company keeps its own complete books underneath.
 */
export const groups = pgTable('groups', {
  id: id(),
  name: text('name').notNull(),
  /** Currency the consolidated statements are presented in. */
  presentationCurrency: text('presentation_currency').notNull().default('USD'),
  /** Framework the consolidated statements are prepared under. */
  framework: frameworkEnum('framework').notNull().default('IFRS'),
  fiscalYearStartMonth: integer('fiscal_year_start_month').notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash'),
    isActive: boolean('is_active').notNull().default(true),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({ emailUnique: uniqueIndex('users_email_idx').on(t.email) }),
);

/**
 * Signed-in sessions. The row id is the SHA-256 of the cookie token, never the
 * token itself — so a stolen database dump cannot be replayed as a login.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => ({ userIdx: index('sessions_user_idx').on(t.userId) }),
);

/**
 * A user's access. Granting at group level cascades to every company in the
 * group; granting at company level is scoped to that company alone.
 */
export const memberships = pgTable(
  'memberships',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    groupId: text('group_id').references(() => groups.id, { onDelete: 'cascade' }),
    companyId: text('company_id').references(() => companies.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull().default('VIEWER'),
    createdAt: createdAt(),
  },
  (t) => ({
    userIdx: index('memberships_user_idx').on(t.userId),
    companyIdx: index('memberships_company_idx').on(t.companyId),
    groupIdx: index('memberships_group_idx').on(t.groupId),
  }),
);

// ─────────────────────────── Company ─────────────────────────────────

export const companies = pgTable(
  'companies',
  {
    id: id(),
    groupId: text('group_id').references(() => groups.id, { onDelete: 'set null' }),
    /** Immediate parent in the group tree. Null for the ultimate parent. */
    parentCompanyId: text('parent_company_id'),
    /** Parent's holding in basis points: 10000 = 100 %, 7500 = 75 %. */
    ownershipBps: integer('ownership_bps').notNull().default(10000),
    /** Set on the synthetic entity that carries consolidation eliminations. */
    isEliminationEntity: boolean('is_elimination_entity').notNull().default(false),

    name: text('name').notNull(),
    legalName: text('legal_name'),
    email: text('email'),
    phone: text('phone'),
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    state: text('state'),
    postalCode: text('postal_code'),
    country: text('country').notNull().default('PK'),

    /** Framework these books are kept under. Drives every rule suggestion. */
    framework: frameworkEnum('framework').notNull().default('IFRS'),
    /** Currency of the primary economic environment (IAS 21 / ASC 830). */
    functionalCurrency: text('functional_currency').notNull().default('USD'),
    currency: text('currency').notNull().default('USD'),

    /** Month number the fiscal year starts in (1 = January). */
    fiscalYearStartMonth: integer('fiscal_year_start_month').notNull().default(1),
    /** Entries dated on or before this are locked. Null = nothing closed. */
    booksClosedThrough: date('books_closed_through', { mode: 'date' }),
    taxNumber: text('tax_number'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    groupIdx: index('companies_group_idx').on(t.groupId),
    parentIdx: index('companies_parent_idx').on(t.parentCompanyId),
  }),
);

/**
 * The accounting-policy choices a company has made where the framework
 * permits alternatives. The assistant reads these before suggesting a
 * treatment, so it proposes *your* policy rather than a generic one.
 */
export const accountingPolicies = pgTable(
  'accounting_policies',
  {
    id: id(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    /** e.g. "inventory_cost_formula", "ppe_measurement", "development_costs" */
    key: text('key').notNull(),
    /** e.g. "FIFO", "COST_MODEL", "CAPITALISE_WHEN_CRITERIA_MET" */
    value: text('value').notNull(),
    /** The standard paragraph that permits this choice. */
    basis: text('basis'),
    note: text('note'),
    updatedAt: updatedAt(),
  },
  (t) => ({ keyUnique: uniqueIndex('accounting_policies_company_key_idx').on(t.companyId, t.key) }),
);

/** FX rates for IAS 21 / ASC 830 translation during consolidation. */
export const fxRates = pgTable(
  'fx_rates',
  {
    id: id(),
    fromCurrency: text('from_currency').notNull(),
    toCurrency: text('to_currency').notNull(),
    date: date('date', { mode: 'date' }).notNull(),
    /** Rate × 1,000,000, so 1.08542 is stored as 1085420. */
    rateMicros: bigint('rate_micros', { mode: 'number' }).notNull(),
    kind: text('kind').notNull().default('CLOSING'), // CLOSING | AVERAGE | HISTORICAL
  },
  (t) => ({
    rateUnique: uniqueIndex('fx_rates_unique_idx').on(t.fromCurrency, t.toCurrency, t.date, t.kind),
  }),
);

// ─────────────────────────── Chart of accounts ───────────────────────

export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    type: accountTypeEnum('type').notNull(),
    subtype: accountSubtypeEnum('subtype').notNull(),
    description: text('description'),
    parentId: text('parent_id'),
    isActive: boolean('is_active').notNull().default(true),
    /** Control accounts the system relies on; cannot be deleted. */
    isSystem: boolean('is_system').notNull().default(false),
    /**
     * Maps this local account onto the group's consolidation chart. Two
     * subsidiaries can call the same thing different names and still roll up.
     */
    groupAccountCode: text('group_account_code'),
    /** Balances here are with other group companies and get eliminated. */
    isIntercompany: boolean('is_intercompany').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    codeUnique: uniqueIndex('accounts_company_code_idx').on(t.companyId, t.code),
    typeIdx: index('accounts_company_type_idx').on(t.companyId, t.type),
  }),
);

// ─────────────────── Dimensions (departments, projects) ──────────────

/**
 * Analysis dimensions — departments, cost centres, projects, funds.
 *
 * These have to exist before real transactions do. A dimension tag belongs on
 * a journal line at the moment it is written; bolting one on a year later
 * leaves every historical line untagged and the departmental P&L starting a
 * year late.
 */
export const dimensions = pgTable(
  'dimensions',
  {
    id: id(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    code: text('code').notNull(), // "DEPT", "PROJECT"
    name: text('name').notNull(), // "Department"
    /** Warn when a P&L line is posted without a value for this dimension. */
    isRequiredOnPL: boolean('is_required_on_pl').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => ({ codeUnique: uniqueIndex('dimensions_company_code_idx').on(t.companyId, t.code) }),
);

export const dimensionValues = pgTable(
  'dimension_values',
  {
    id: id(),
    dimensionId: text('dimension_id')
      .notNull()
      .references(() => dimensions.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    parentId: text('parent_id'),
    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => ({ valueUnique: uniqueIndex('dimension_values_dim_code_idx').on(t.dimensionId, t.code) }),
);

// ─────────────────────────── Contacts ────────────────────────────────

export const contacts = pgTable(
  'contacts',
  {
    id: id(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    kind: contactKindEnum('kind').notNull(),
    displayName: text('display_name').notNull(),
    companyName: text('company_name'),
    email: text('email'),
    phone: text('phone'),
    addressLine1: text('address_line1'),
    city: text('city'),
    state: text('state'),
    postalCode: text('postal_code'),
    country: text('country'),
    taxNumber: text('tax_number'),
    termsDays: integer('terms_days').notNull().default(30),
    notes: text('notes'),
    /** This customer/vendor IS another company in the group. */
    relatedCompanyId: text('related_company_id'),
    /**
     * Known wallet addresses for this counterparty, lower-cased. An inbound
     * transfer from one of these is as identifying as a bank reference.
     */
    walletAddresses: jsonb('wallet_addresses').$type<string[]>(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    nameUnique: uniqueIndex('contacts_company_name_idx').on(t.companyId, t.displayName),
    kindIdx: index('contacts_company_kind_idx').on(t.companyId, t.kind),
  }),
);

// ─────────────────────────── Tax & items ─────────────────────────────

export const taxRates = pgTable(
  'tax_rates',
  {
    id: id(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Basis points: 1700 = 17.00 % */
    rateBps: integer('rate_bps').notNull(),
    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => ({ nameUnique: uniqueIndex('tax_rates_company_name_idx').on(t.companyId, t.name) }),
);

export const items = pgTable(
  'items',
  {
    id: id(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sku: text('sku'),
    description: text('description'),
    type: text('type').notNull().default('SERVICE'),
    unitPriceCents: money('unit_price_cents'),
    costCents: money('cost_cents'),
    incomeAccountId: text('income_account_id').references(() => accounts.id),
    expenseAccountId: text('expense_account_id').references(() => accounts.id),
    taxRateId: text('tax_rate_id').references(() => taxRates.id),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ nameUnique: uniqueIndex('items_company_name_idx').on(t.companyId, t.name) }),
);

// ─────────────────────────── General ledger ──────────────────────────

export const journalEntries = pgTable(
  'journal_entries',
  {
    id: id(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    entryNo: text('entry_no').notNull(),
    date: date('date', { mode: 'date' }).notNull(),
    memo: text('memo'),
    source: journalSourceEnum('source').notNull().default('MANUAL'),
    /** Id of the document that produced this entry. */
    sourceId: text('source_id'),
    /** Proposed by the assistant and approved by a human. */
    aiAssisted: boolean('ai_assisted').notNull().default(false),
    /**
     * Standards the treatment rests on, e.g. ["IFRS 15.31", "IAS 21.21"].
     * Stored on the entry so an auditor can see the basis years later.
     */
    standardRefs: jsonb('standard_refs').$type<string[]>(),
    /** The other group company, when this is an intercompany transaction. */
    counterpartyCompanyId: text('counterparty_company_id'),
    /**
     * How this entry was settled and the reference that proves it — a bank
     * reference, a Stripe charge id, or a chain id and transaction hash.
     * Putting it on the entry rather than in a crypto sub-ledger is the whole
     * point: an on-chain settlement is evidence like any other, not a
     * separate system that has to be reconciled back to the books.
     */
    settlementRail: settlementRailEnum('settlement_rail'),
    settlementRef: jsonb('settlement_ref').$type<{
      reference?: string;
      chainId?: string;
      txHash?: string;
      address?: string;
      blockNumber?: number;
      processor?: string;
    }>(),
    /** True for entries generated by the consolidation engine. */
    isElimination: boolean('is_elimination').notNull().default(false),
    isVoid: boolean('is_void').notNull().default(false),
    createdBy: text('created_by').notNull().default('system'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    entryNoUnique: uniqueIndex('journal_entries_company_no_idx').on(t.companyId, t.entryNo),
    dateIdx: index('journal_entries_company_date_idx').on(t.companyId, t.date),
    sourceIdx: index('journal_entries_source_idx').on(t.companyId, t.source, t.sourceId),
  }),
);

export const journalLines = pgTable(
  'journal_lines',
  {
    id: id(),
    entryId: text('entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    /** Exactly one of these is non-zero — enforced by the posting engine. */
    debitCents: money('debit_cents'),
    creditCents: money('credit_cents'),
    description: text('description'),
    contactId: text('contact_id').references(() => contacts.id),
    /**
     * Dimension values tagged on this line, e.g. ["<dept-eng-id>"].
     * Queried with the jsonb containment operator, which the GIN index serves.
     */
    dimensionValueIds: jsonb('dimension_value_ids').$type<string[]>(),
  },
  (t) => ({
    entryIdx: index('journal_lines_entry_idx').on(t.entryId),
    accountIdx: index('journal_lines_account_idx').on(t.accountId),
    dimIdx: index('journal_lines_dim_idx').using('gin', t.dimensionValueIds),
  }),
);

// ─────────────────────────── Sales ───────────────────────────────────

export const invoices = pgTable(
  'invoices',
  {
    id: id(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    number: text('number').notNull(),
    customerId: text('customer_id')
      .notNull()
      .references(() => contacts.id),
    date: date('date', { mode: 'date' }).notNull(),
    dueDate: date('due_date', { mode: 'date' }).notNull(),
    status: docStatusEnum('status').notNull().default('OPEN'),
    memo: text('memo'),
    subtotalCents: money('subtotal_cents'),
    taxCents: money('tax_cents'),
    totalCents: money('total_cents'),
    paidCents: money('paid_cents'),
    aiAssisted: boolean('ai_assisted').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    numberUnique: uniqueIndex('invoices_company_number_idx').on(t.companyId, t.number),
    customerIdx: index('invoices_company_customer_idx').on(t.companyId, t.customerId),
    statusIdx: index('invoices_company_status_idx').on(t.companyId, t.status),
  }),
);

export const invoiceLines = pgTable(
  'invoice_lines',
  {
    id: id(),
    invoiceId: text('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    itemId: text('item_id').references(() => items.id),
    description: text('description').notNull(),
    /** Thousandths: 1.5 → 1500 */
    quantity: integer('quantity').notNull().default(1000),
    unitPriceCents: money('unit_price_cents'),
    amountCents: money('amount_cents'),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    taxRateId: text('tax_rate_id').references(() => taxRates.id),
    taxCents: money('tax_cents'),
  },
  (t) => ({ invoiceIdx: index('invoice_lines_invoice_idx').on(t.invoiceId) }),
);

// ─────────────────────────── Purchases ───────────────────────────────

export const bills = pgTable(
  'bills',
  {
    id: id(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    number: text('number').notNull(),
    vendorId: text('vendor_id')
      .notNull()
      .references(() => contacts.id),
    date: date('date', { mode: 'date' }).notNull(),
    dueDate: date('due_date', { mode: 'date' }).notNull(),
    status: docStatusEnum('status').notNull().default('OPEN'),
    memo: text('memo'),
    subtotalCents: money('subtotal_cents'),
    taxCents: money('tax_cents'),
    totalCents: money('total_cents'),
    paidCents: money('paid_cents'),
    aiAssisted: boolean('ai_assisted').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    numberUnique: uniqueIndex('bills_company_number_idx').on(t.companyId, t.number),
    vendorIdx: index('bills_company_vendor_idx').on(t.companyId, t.vendorId),
    statusIdx: index('bills_company_status_idx').on(t.companyId, t.status),
  }),
);

export const billLines = pgTable(
  'bill_lines',
  {
    id: id(),
    billId: text('bill_id')
      .notNull()
      .references(() => bills.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    itemId: text('item_id').references(() => items.id),
    description: text('description').notNull(),
    quantity: integer('quantity').notNull().default(1000),
    unitPriceCents: money('unit_price_cents'),
    amountCents: money('amount_cents'),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    taxRateId: text('tax_rate_id').references(() => taxRates.id),
    taxCents: money('tax_cents'),
  },
  (t) => ({ billIdx: index('bill_lines_bill_idx').on(t.billId) }),
);

// ─────────────────────────── Money movement ──────────────────────────

export const payments = pgTable(
  'payments',
  {
    id: id(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    reference: text('reference').notNull(),
    kind: paymentKindEnum('kind').notNull(),
    contactId: text('contact_id')
      .notNull()
      .references(() => contacts.id),
    date: date('date', { mode: 'date' }).notNull(),
    amountCents: money('amount_cents'),
    bankAccountId: text('bank_account_id')
      .notNull()
      .references(() => accounts.id),
    method: text('method').default('BANK_TRANSFER'),
    memo: text('memo'),
    /** Which rail the money actually came down. */
    rail: settlementRailEnum('rail').notNull().default('BANK'),
    /**
     * The processor's or chain's own identifier — a Stripe charge id, a PayPal
     * capture id, a transaction hash. Stored so every payment can be traced
     * back to its source without leaving the ledger.
     */
    externalRef: text('external_ref'),
    /** Whatever the processor sent us, kept verbatim for audit. */
    externalPayload: jsonb('external_payload'),
    /** Processor fees, booked as their own expense and never netted off. */
    feeCents: bigint('fee_cents', { mode: 'number' }).notNull().default(0),
    aiAssisted: boolean('ai_assisted').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => ({
    refUnique: uniqueIndex('payments_company_ref_idx').on(t.companyId, t.reference),
    externalIdx: index('payments_external_ref_idx').on(t.companyId, t.externalRef),
    dateIdx: index('payments_company_date_idx').on(t.companyId, t.date),
  }),
);

export const paymentAllocations = pgTable(
  'payment_allocations',
  {
    id: id(),
    paymentId: text('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'cascade' }),
    invoiceId: text('invoice_id').references(() => invoices.id),
    billId: text('bill_id').references(() => bills.id),
    amountCents: money('amount_cents'),
  },
  (t) => ({ paymentIdx: index('payment_allocations_payment_idx').on(t.paymentId) }),
);

/** A cash / card expense paid immediately — no vendor bill involved. */
export const expenses = pgTable(
  'expenses',
  {
    id: id(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    reference: text('reference').notNull(),
    date: date('date', { mode: 'date' }).notNull(),
    vendorId: text('vendor_id').references(() => contacts.id),
    paymentAccountId: text('payment_account_id')
      .notNull()
      .references(() => accounts.id),
    method: text('method').default('CARD'),
    memo: text('memo'),
    totalCents: money('total_cents'),
    aiAssisted: boolean('ai_assisted').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => ({
    refUnique: uniqueIndex('expenses_company_ref_idx').on(t.companyId, t.reference),
    dateIdx: index('expenses_company_date_idx').on(t.companyId, t.date),
  }),
);

export const expenseLines = pgTable(
  'expense_lines',
  {
    id: id(),
    expenseId: text('expense_id')
      .notNull()
      .references(() => expenses.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    description: text('description').notNull(),
    amountCents: money('amount_cents'),
  },
  (t) => ({ expenseIdx: index('expense_lines_expense_idx').on(t.expenseId) }),
);

// ─────────────────────── Banking (import + match) ────────────────────

export const bankTransactions = pgTable(
  'bank_transactions',
  {
    id: id(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    bankAccountId: text('bank_account_id')
      .notNull()
      .references(() => accounts.id),
    date: date('date', { mode: 'date' }).notNull(),
    description: text('description').notNull(),
    counterparty: text('counterparty'),
    /** Positive = money in, negative = money out. */
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    externalId: text('external_id'),
    status: bankTxnStatusEnum('status').notNull().default('UNMATCHED'),
    suggestedAccountId: text('suggested_account_id').references(() => accounts.id),
    suggestionConfidence: integer('suggestion_confidence'),
    suggestionReason: text('suggestion_reason'),
    journalEntryId: text('journal_entry_id').references(() => journalEntries.id),
    createdAt: createdAt(),
  },
  (t) => ({
    statusIdx: index('bank_txns_company_status_idx').on(t.companyId, t.status),
    dateIdx: index('bank_txns_company_date_idx').on(t.companyId, t.date),
  }),
);

// ─────────────────────── Digital assets and wallets ──────────────────

/**
 * A wallet, exchange account or custody position the group controls.
 *
 * Registering these is what makes an on-chain transfer *ours* rather than a
 * stranger's. A transfer between two registered wallets is an internal
 * movement, not income — the same logic as a bank-to-bank transfer, and the
 * same reason it must never be counted twice.
 */
export const wallets = pgTable(
  'wallets',
  {
    id: id(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    /** Free text so a non-EVM chain is not a schema change: 'ethereum', 'zigchain', 'bitcoin'. */
    chainId: text('chain_id').notNull(),
    address: text('address').notNull(),
    custody: walletCustodyEnum('custody').notNull().default('SELF'),
    /**
     * The GL account this wallet's holdings sit in. Usually Digital Assets,
     * but an exchange balance held for trading may sit elsewhere.
     */
    accountId: text('account_id').references(() => accounts.id),
    notes: text('notes'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => ({
    walletUnique: uniqueIndex('wallets_company_chain_address_idx').on(t.companyId, t.chainId, t.address),
    companyIdx: index('wallets_company_idx').on(t.companyId),
  }),
);

/**
 * Raw on-chain movements, landed before they mean anything in accounting
 * terms — deliberately the same shape as `bank_transactions`, because the
 * reconciliation problem is the same problem.
 *
 * Token amounts are stored as a decimal STRING plus their decimals, because a
 * 256-bit integer does not fit in any numeric type we would want to do
 * accounting arithmetic in. The fiat value, which the ledger actually posts,
 * is an ordinary integer of minor units.
 */
export const onchainTransactions = pgTable(
  'onchain_transactions',
  {
    id: id(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    walletId: text('wallet_id')
      .notNull()
      .references(() => wallets.id, { onDelete: 'cascade' }),
    chainId: text('chain_id').notNull(),
    txHash: text('tx_hash').notNull(),
    /** One transaction can carry several transfers; this separates them. */
    logIndex: integer('log_index').notNull().default(0),
    blockNumber: bigint('block_number', { mode: 'number' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),

    direction: text('direction').notNull(), // IN | OUT
    counterpartyAddress: text('counterparty_address'),

    assetSymbol: text('asset_symbol').notNull(),
    assetDecimals: integer('asset_decimals').notNull().default(18),
    /** Exact on-chain amount, as a decimal string in the asset's base units. */
    assetAmountRaw: text('asset_amount_raw').notNull(),

    /** Fiat value at the time of the transfer, in the company's currency. */
    valueCents: bigint('value_cents', { mode: 'number' }).notNull().default(0),
    /** Price used, × 1,000,000. Kept so the valuation can be re-derived. */
    priceMicros: bigint('price_micros', { mode: 'number' }),
    priceSource: text('price_source'),

    feeRaw: text('fee_raw'),
    feeAssetSymbol: text('fee_asset_symbol'),
    feeCents: bigint('fee_cents', { mode: 'number' }).notNull().default(0),

    memo: text('memo'),
    status: onchainTxnStatusEnum('status').notNull().default('UNMATCHED'),

    /** What the matcher proposes, and why — never applied without approval. */
    suggestedAccountId: text('suggested_account_id').references(() => accounts.id),
    suggestedContactId: text('suggested_contact_id').references(() => contacts.id),
    suggestionConfidence: integer('suggestion_confidence'),
    suggestionReason: text('suggestion_reason'),

    /** Set once posted. The link from chain to ledger. */
    journalEntryId: text('journal_entry_id').references(() => journalEntries.id),
    /** The matching wallet when this is a movement between our own wallets. */
    internalCounterpartWalletId: text('internal_counterpart_wallet_id'),

    /**
     * Idempotency: `${chainId}:${txHash}:${logIndex}`. Re-importing the same
     * file is a no-op, which is requirement "no double posting" enforced at
     * the point of ingestion rather than hoped for downstream.
     */
    externalId: text('external_id').notNull(),
    importedAt: createdAt(),
  },
  (t) => ({
    idempotency: uniqueIndex('onchain_txns_company_external_idx').on(t.companyId, t.externalId),
    statusIdx: index('onchain_txns_company_status_idx').on(t.companyId, t.status),
    walletIdx: index('onchain_txns_wallet_idx').on(t.walletId, t.occurredAt),
    hashIdx: index('onchain_txns_hash_idx').on(t.chainId, t.txHash),
  }),
);

/** Prices used to value on-chain movements, kept so a valuation is reproducible. */
export const assetPrices = pgTable(
  'asset_prices',
  {
    id: id(),
    assetSymbol: text('asset_symbol').notNull(),
    quoteCurrency: text('quote_currency').notNull().default('USD'),
    asOf: timestamp('as_of', { withTimezone: true }).notNull(),
    priceMicros: bigint('price_micros', { mode: 'number' }).notNull(),
    source: text('source').notNull().default('manual'),
  },
  (t) => ({ priceIdx: index('asset_prices_symbol_idx').on(t.assetSymbol, t.quoteCurrency, t.asOf) }),
);

// ─────────────────────── Standards rule-set ──────────────────────────

/**
 * The codified accounting rule-set the assistant reasons from.
 *
 * This is DATA, not code — an accountant can add or amend a rule without a
 * developer, and every row carries the citation it rests on. It is a curated
 * decision aid covering the transaction types a mid-market group actually
 * meets; it is deliberately NOT a reproduction of the standards themselves.
 */
export const standards = pgTable(
  'standards',
  {
    id: id(),
    framework: frameworkEnum('framework').notNull(),
    /** Citation, e.g. "IFRS 15.31" or "ASC 606-10-25-30". */
    reference: text('reference').notNull(),
    topic: standardTopicEnum('topic').notNull(),
    title: text('title').notNull(),
    /** One-line statement of the requirement, in plain English. */
    requirement: text('requirement').notNull(),
    /** How it is actually booked — the part the assistant turns into lines. */
    treatment: text('treatment').notNull(),
    /**
     * Skeleton entry: [{ side: 'DEBIT', subtype: 'EXPENSE', note: '…' }, …].
     * Subtypes, not account ids, so it maps onto any chart of accounts.
     */
    entryTemplate: jsonb('entry_template').$type<
      { side: 'DEBIT' | 'CREDIT'; subtype: string; note: string }[]
    >(),
    /** Words that make this rule a candidate for a given transaction. */
    keywords: jsonb('keywords').$type<string[]>().notNull(),
    /** The policy key this rule depends on, when the framework permits a choice. */
    policyKey: text('policy_key'),
    /** Where the two frameworks diverge — surfaced in the UI side by side. */
    divergenceNote: text('divergence_note'),
    /** Disclosure the treatment triggers, for the notes to the accounts. */
    disclosure: text('disclosure'),
    isActive: boolean('is_active').notNull().default(true),
    /** False for rules an accountant added locally. */
    isBuiltIn: boolean('is_built_in').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    refUnique: uniqueIndex('standards_framework_ref_idx').on(t.framework, t.reference),
    topicIdx: index('standards_topic_idx').on(t.framework, t.topic),
  }),
);

// ─────────────────────── Consolidation ───────────────────────────────

export const consolidationRuns = pgTable(
  'consolidation_runs',
  {
    id: id(),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    periodStart: date('period_start', { mode: 'date' }).notNull(),
    periodEnd: date('period_end', { mode: 'date' }).notNull(),
    presentationCurrency: text('presentation_currency').notNull(),
    status: text('status').notNull().default('DRAFT'), // DRAFT | FINAL
    /** Assets − (liabilities + equity) on the consolidated trial balance. */
    outOfBalanceCents: bigint('out_of_balance_cents', { mode: 'number' }).notNull().default(0),
    notes: text('notes'),
    runBy: text('run_by'),
    createdAt: createdAt(),
  },
  (t) => ({ groupIdx: index('consolidation_runs_group_idx').on(t.groupId, t.periodEnd) }),
);

/**
 * One eliminated pair, kept line by line so the consolidation is auditable
 * rather than a black box.
 */
export const eliminations = pgTable(
  'eliminations',
  {
    id: id(),
    runId: text('run_id')
      .notNull()
      .references(() => consolidationRuns.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // INTERCOMPANY_BALANCE | INTERCOMPANY_TRADE | INVESTMENT_IN_SUB | UNREALISED_PROFIT | NCI
    fromCompanyId: text('from_company_id'),
    toCompanyId: text('to_company_id'),
    groupAccountCode: text('group_account_code'),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    explanation: text('explanation').notNull(),
    standardRef: text('standard_ref'),
  },
  (t) => ({ runIdx: index('eliminations_run_idx').on(t.runId) }),
);

// ─────────────────────── FP&A: plans and the close ───────────────────

/**
 * A budget or forecast version. Multiple plans can coexist for a year — the
 * approved budget, and the live re-forecast that the close keeps rolling.
 */
export const plans = pgTable(
  'plans',
  {
    id: id(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    fiscalYear: integer('fiscal_year').notNull(),
    kind: text('kind').notNull().default('BUDGET'), // BUDGET | FORECAST
    status: text('status').notNull().default('DRAFT'), // DRAFT | APPROVED | ARCHIVED
    currency: text('currency').notNull().default('USD'),
    note: text('note'),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdBy: text('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ planUnique: uniqueIndex('plans_company_name_year_idx').on(t.companyId, t.name, t.fiscalYear) }),
);

/**
 * One account × one dimension combination × one month.
 * `source` records WHERE the number came from, which is what makes a forecast
 * defensible: a figure with no stated basis is not shown.
 */
export const planLines = pgTable(
  'plan_lines',
  {
    id: id(),
    planId: text('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    dimensionValueIds: jsonb('dimension_value_ids').$type<string[]>(),
    /** First day of the month this line budgets for. */
    period: date('period', { mode: 'date' }).notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull().default(0),
    /** MANUAL | COMMITMENT | RECURRENCE | TREND | ROLLED_FORWARD */
    source: text('source').notNull().default('MANUAL'),
    /** Plain-English basis shown next to the figure. */
    basis: text('basis'),
    note: text('note'),
    updatedAt: updatedAt(),
  },
  (t) => ({
    planIdx: index('plan_lines_plan_idx').on(t.planId),
    periodIdx: index('plan_lines_period_idx').on(t.planId, t.period),
  }),
);

/** Per-period close status. Supersedes the single watermark on companies. */
export const closePeriods = pgTable(
  'close_periods',
  {
    id: id(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    period: date('period', { mode: 'date' }).notNull(),
    status: text('status').notNull().default('OPEN'), // OPEN | CLOSED
    closedBy: text('closed_by'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    note: text('note'),
  },
  (t) => ({ periodUnique: uniqueIndex('close_periods_company_period_idx').on(t.companyId, t.period) }),
);

/**
 * What we thought a period would be, and when we thought it. Taken at every
 * close — this is the vintage view that makes a forecast trustworthy.
 */
export const forecastSnapshots = pgTable(
  'forecast_snapshots',
  {
    id: id(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    planId: text('plan_id').references(() => plans.id, { onDelete: 'cascade' }),
    asOfPeriod: date('as_of_period', { mode: 'date' }).notNull(),
    takenAt: createdAt(),
    takenBy: text('taken_by'),
    payload: jsonb('payload').$type<{ period: string; accountId: string; amountCents: number }[]>(),
  },
  (t) => ({ snapIdx: index('forecast_snapshots_company_idx').on(t.companyId, t.asOfPeriod) }),
);

/** Why a line missed plan. Carried forward so it isn't retyped every month. */
export const varianceNotes = pgTable(
  'variance_notes',
  {
    id: id(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    period: date('period', { mode: 'date' }).notNull(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull().default(0),
    cause: text('cause').notNull(),
    ownerUserId: text('owner_user_id'),
    carryForward: boolean('carry_forward').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => ({ varianceIdx: index('variance_notes_company_period_idx').on(t.companyId, t.period) }),
);

// ─────────────────────── Assistant audit trail ───────────────────────

export const assistantLogs = pgTable(
  'assistant_logs',
  {
    id: id(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    prompt: text('prompt').notNull(),
    response: text('response').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    confidence: integer('confidence'),
    /** Standards cited in the suggestion — the audit trail for the basis. */
    standardRefs: jsonb('standard_refs').$type<string[]>(),
    /** Whether a human accepted the proposal. Null = not acted on yet. */
    accepted: boolean('accepted'),
    /** Set when the human changed the accounts before posting — training signal. */
    correctedByHuman: boolean('corrected_by_human'),
    journalEntryId: text('journal_entry_id'),
    userId: text('user_id'),
    latencyMs: integer('latency_ms'),
    createdAt: createdAt(),
  },
  (t) => ({ createdIdx: index('assistant_logs_company_created_idx').on(t.companyId, t.createdAt) }),
);

// ─────────────────────────── Relations ───────────────────────────────

export const accountRelations = relations(accounts, ({ one, many }) => ({
  company: one(companies, { fields: [accounts.companyId], references: [companies.id] }),
  lines: many(journalLines),
}));

export const journalEntryRelations = relations(journalEntries, ({ one, many }) => ({
  company: one(companies, { fields: [journalEntries.companyId], references: [companies.id] }),
  lines: many(journalLines),
}));

export const journalLineRelations = relations(journalLines, ({ one }) => ({
  entry: one(journalEntries, { fields: [journalLines.entryId], references: [journalEntries.id] }),
  account: one(accounts, { fields: [journalLines.accountId], references: [accounts.id] }),
  contact: one(contacts, { fields: [journalLines.contactId], references: [contacts.id] }),
}));

export const invoiceRelations = relations(invoices, ({ one, many }) => ({
  customer: one(contacts, { fields: [invoices.customerId], references: [contacts.id] }),
  lines: many(invoiceLines),
}));

export const invoiceLineRelations = relations(invoiceLines, ({ one }) => ({
  invoice: one(invoices, { fields: [invoiceLines.invoiceId], references: [invoices.id] }),
  account: one(accounts, { fields: [invoiceLines.accountId], references: [accounts.id] }),
  item: one(items, { fields: [invoiceLines.itemId], references: [items.id] }),
}));

export const billRelations = relations(bills, ({ one, many }) => ({
  vendor: one(contacts, { fields: [bills.vendorId], references: [contacts.id] }),
  lines: many(billLines),
}));

export const billLineRelations = relations(billLines, ({ one }) => ({
  bill: one(bills, { fields: [billLines.billId], references: [bills.id] }),
  account: one(accounts, { fields: [billLines.accountId], references: [accounts.id] }),
}));

export const paymentRelations = relations(payments, ({ one, many }) => ({
  contact: one(contacts, { fields: [payments.contactId], references: [contacts.id] }),
  bankAccount: one(accounts, { fields: [payments.bankAccountId], references: [accounts.id] }),
  allocations: many(paymentAllocations),
}));

export const paymentAllocationRelations = relations(paymentAllocations, ({ one }) => ({
  payment: one(payments, { fields: [paymentAllocations.paymentId], references: [payments.id] }),
  invoice: one(invoices, { fields: [paymentAllocations.invoiceId], references: [invoices.id] }),
  bill: one(bills, { fields: [paymentAllocations.billId], references: [bills.id] }),
}));

export const expenseRelations = relations(expenses, ({ one, many }) => ({
  vendor: one(contacts, { fields: [expenses.vendorId], references: [contacts.id] }),
  paymentAccount: one(accounts, { fields: [expenses.paymentAccountId], references: [accounts.id] }),
  lines: many(expenseLines),
}));

export const expenseLineRelations = relations(expenseLines, ({ one }) => ({
  expense: one(expenses, { fields: [expenseLines.expenseId], references: [expenses.id] }),
  account: one(accounts, { fields: [expenseLines.accountId], references: [accounts.id] }),
}));

// ─────────────────────────── Inferred types ──────────────────────────

export type Group = typeof groups.$inferSelect;
export type User = typeof users.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type Company = typeof companies.$inferSelect;
export type Standard = typeof standards.$inferSelect;
export type AccountingPolicy = typeof accountingPolicies.$inferSelect;
export type ConsolidationRun = typeof consolidationRuns.$inferSelect;
export type Elimination = typeof eliminations.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Dimension = typeof dimensions.$inferSelect;
export type DimensionValue = typeof dimensionValues.$inferSelect;
export type Plan = typeof plans.$inferSelect;
export type PlanLine = typeof planLines.$inferSelect;
export type ClosePeriod = typeof closePeriods.$inferSelect;
export type VarianceNote = typeof varianceNotes.$inferSelect;
export type Wallet = typeof wallets.$inferSelect;
export type OnchainTransaction = typeof onchainTransactions.$inferSelect;
export type AssetPrice = typeof assetPrices.$inferSelect;
export type SettlementRail = (typeof settlementRailEnum.enumValues)[number];
export type WalletCustody = (typeof walletCustodyEnum.enumValues)[number];
export type OnchainTxnStatus = (typeof onchainTxnStatusEnum.enumValues)[number];
export type Framework = (typeof frameworkEnum.enumValues)[number];
export type Role = (typeof roleEnum.enumValues)[number];
export type StandardTopic = (typeof standardTopicEnum.enumValues)[number];
export type Account = typeof accounts.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type Item = typeof items.$inferSelect;
export type TaxRate = typeof taxRates.$inferSelect;
export type JournalEntry = typeof journalEntries.$inferSelect;
export type JournalLine = typeof journalLines.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
export type InvoiceLine = typeof invoiceLines.$inferSelect;
export type Bill = typeof bills.$inferSelect;
export type BillLine = typeof billLines.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type Expense = typeof expenses.$inferSelect;
export type BankTransaction = typeof bankTransactions.$inferSelect;
export type AccountType = (typeof accountTypeEnum.enumValues)[number];
export type AccountSubtype = (typeof accountSubtypeEnum.enumValues)[number];
export type JournalSource = (typeof journalSourceEnum.enumValues)[number];
export type DocStatus = (typeof docStatusEnum.enumValues)[number];

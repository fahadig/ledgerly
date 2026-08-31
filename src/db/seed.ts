/**
 * Seed: a two-company group with real trading history.
 *
 * The history matters as much as the chart. The assistant's history layer
 * learns from it, the consolidation engine needs intercompany traffic to
 * eliminate, and the replay accuracy harness needs something to replay.
 * Everything is generated from a fixed pseudo-random seed, so re-seeding
 * produces byte-identical books.
 */

import 'dotenv/config';
import { and, eq, sql } from 'drizzle-orm';
import { db, pool } from '../lib/db';
import {
  accountingPolicies,
  accounts,
  dimensionValues,
  dimensions,
  bills,
  companies,
  contacts,
  fxRates,
  groups,
  invoices,
  items,
  journalEntries,
  memberships,
  taxRates,
  users,
  type AccountSubtype,
  type AccountType,
  type Framework,
} from './schema';
import { createBill, createExpense, createInvoice, createPayment } from '../lib/documents';
import { postJournal } from '../lib/ledger';
import { DEFAULT_POLICIES, STANDARD_CATALOG } from '../lib/standards/catalog';
import { syncCatalog } from '../lib/standards/engine';
import { hashPassword } from '../lib/auth';
import { seedBudgetFromActuals } from '../lib/fpa';
import { assetPrices, onchainTransactions, wallets } from './schema';
import { importTransfers, runMatcher } from '../lib/onchain/reconcile';
import type { RawTransfer } from '../lib/onchain/provider';

// Deterministic RNG so the demo books are reproducible.
let _seed = 20260825;
const rnd = () => ((_seed = (_seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
const between = (a: number, b: number) => Math.round(a + rnd() * (b - a));
const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m, day));

interface AccountSpec {
  code: string;
  name: string;
  type: AccountType;
  subtype: AccountSubtype;
  isSystem?: boolean;
  isIntercompany?: boolean;
}

const CHART: AccountSpec[] = [
  { code: '1000', name: 'Operating Bank Account', type: 'ASSET', subtype: 'BANK', isSystem: true },
  { code: '1010', name: 'Savings Account', type: 'ASSET', subtype: 'BANK' },
  { code: '1020', name: 'Petty Cash', type: 'ASSET', subtype: 'BANK' },
  { code: '1100', name: 'Accounts Receivable (A/R)', type: 'ASSET', subtype: 'ACCOUNTS_RECEIVABLE', isSystem: true },
  { code: '1110', name: 'Intercompany Receivable', type: 'ASSET', subtype: 'ACCOUNTS_RECEIVABLE', isIntercompany: true },
  { code: '1200', name: 'Prepaid Expenses', type: 'ASSET', subtype: 'OTHER_CURRENT_ASSET' },
  { code: '1210', name: 'Inventory', type: 'ASSET', subtype: 'OTHER_CURRENT_ASSET' },
  { code: '1300', name: 'Undeposited Funds', type: 'ASSET', subtype: 'OTHER_CURRENT_ASSET', isSystem: true },
  { code: '1400', name: 'Capitalised Development Costs', type: 'ASSET', subtype: 'OTHER_ASSET' },
  { code: '1450', name: 'Digital Assets', type: 'ASSET', subtype: 'OTHER_ASSET' },
  { code: '1500', name: 'Computer Equipment', type: 'ASSET', subtype: 'FIXED_ASSET' },
  { code: '1510', name: 'Office Furniture', type: 'ASSET', subtype: 'FIXED_ASSET' },
  { code: '1550', name: 'Right-of-Use Assets', type: 'ASSET', subtype: 'FIXED_ASSET' },
  { code: '1590', name: 'Accumulated Depreciation', type: 'ASSET', subtype: 'FIXED_ASSET' },

  { code: '2000', name: 'Accounts Payable (A/P)', type: 'LIABILITY', subtype: 'ACCOUNTS_PAYABLE', isSystem: true },
  { code: '2010', name: 'Intercompany Payable', type: 'LIABILITY', subtype: 'ACCOUNTS_PAYABLE', isIntercompany: true },
  { code: '2100', name: 'Company Credit Card', type: 'LIABILITY', subtype: 'CREDIT_CARD' },
  { code: '2200', name: 'Sales Tax Payable', type: 'LIABILITY', subtype: 'OTHER_CURRENT_LIABILITY', isSystem: true },
  { code: '2300', name: 'Payroll Liabilities', type: 'LIABILITY', subtype: 'OTHER_CURRENT_LIABILITY' },
  { code: '2400', name: 'Accrued Expenses', type: 'LIABILITY', subtype: 'OTHER_CURRENT_LIABILITY' },
  { code: '2450', name: 'Contract Liabilities (Deferred Revenue)', type: 'LIABILITY', subtype: 'OTHER_CURRENT_LIABILITY' },
  { code: '2600', name: 'Lease Liability', type: 'LIABILITY', subtype: 'LONG_TERM_LIABILITY' },
  { code: '2700', name: 'Long-term Loan', type: 'LIABILITY', subtype: 'LONG_TERM_LIABILITY' },

  { code: '3000', name: 'Share Capital', type: 'EQUITY', subtype: 'EQUITY', isSystem: true },
  { code: '3100', name: 'Owner’s Drawings', type: 'EQUITY', subtype: 'EQUITY' },
  { code: '3900', name: 'Retained Earnings', type: 'EQUITY', subtype: 'EQUITY', isSystem: true },

  { code: '4000', name: 'Consulting Income', type: 'INCOME', subtype: 'INCOME' },
  { code: '4010', name: 'Software Subscription Income', type: 'INCOME', subtype: 'INCOME' },
  { code: '4020', name: 'Support & Maintenance Income', type: 'INCOME', subtype: 'INCOME' },
  { code: '4100', name: 'Intercompany Service Income', type: 'INCOME', subtype: 'INCOME', isIntercompany: true },
  { code: '4900', name: 'Interest Income', type: 'INCOME', subtype: 'OTHER_INCOME' },
  { code: '4910', name: 'Foreign Exchange Gain', type: 'INCOME', subtype: 'OTHER_INCOME' },
  { code: '4930', name: 'Realised Gain on Digital Assets', type: 'INCOME', subtype: 'OTHER_INCOME' },

  { code: '5000', name: 'Subcontractor Costs', type: 'EXPENSE', subtype: 'COST_OF_GOODS_SOLD' },
  { code: '5010', name: 'Hosting & Infrastructure', type: 'EXPENSE', subtype: 'COST_OF_GOODS_SOLD' },
  { code: '5100', name: 'Intercompany Service Costs', type: 'EXPENSE', subtype: 'COST_OF_GOODS_SOLD', isIntercompany: true },

  { code: '6000', name: 'Salaries & Wages', type: 'EXPENSE', subtype: 'EXPENSE' },
  { code: '6010', name: 'Office Rent', type: 'EXPENSE', subtype: 'EXPENSE' },
  { code: '6020', name: 'Utilities', type: 'EXPENSE', subtype: 'EXPENSE' },
  { code: '6030', name: 'Internet & Telephone', type: 'EXPENSE', subtype: 'EXPENSE' },
  { code: '6040', name: 'Software Subscriptions', type: 'EXPENSE', subtype: 'EXPENSE' },
  { code: '6050', name: 'Travel & Accommodation', type: 'EXPENSE', subtype: 'EXPENSE' },
  { code: '6060', name: 'Meals & Entertainment', type: 'EXPENSE', subtype: 'EXPENSE' },
  { code: '6070', name: 'Freight & Postage', type: 'EXPENSE', subtype: 'EXPENSE' },
  { code: '6080', name: 'Office Supplies', type: 'EXPENSE', subtype: 'EXPENSE' },
  { code: '6090', name: 'Professional Fees', type: 'EXPENSE', subtype: 'EXPENSE' },
  { code: '6100', name: 'Marketing & Advertising', type: 'EXPENSE', subtype: 'EXPENSE' },
  { code: '6110', name: 'Insurance', type: 'EXPENSE', subtype: 'EXPENSE' },
  { code: '6120', name: 'Repairs & Maintenance', type: 'EXPENSE', subtype: 'EXPENSE' },
  { code: '6130', name: 'Bank Charges', type: 'EXPENSE', subtype: 'EXPENSE' },
  { code: '6140', name: 'Depreciation Expense', type: 'EXPENSE', subtype: 'EXPENSE' },
  { code: '6150', name: 'Research Expense', type: 'EXPENSE', subtype: 'EXPENSE' },
  { code: '6170', name: 'Network & Gas Fees', type: 'EXPENSE', subtype: 'EXPENSE' },
  { code: '6160', name: 'Impairment Loss', type: 'EXPENSE', subtype: 'EXPENSE' },
  { code: '6900', name: 'Interest Expense', type: 'EXPENSE', subtype: 'OTHER_EXPENSE' },
  { code: '6910', name: 'Foreign Exchange Loss', type: 'EXPENSE', subtype: 'OTHER_EXPENSE' },
  { code: '6930', name: 'Realised Loss on Digital Assets', type: 'EXPENSE', subtype: 'OTHER_EXPENSE' },
];

const VENDOR_SPECS = [
  { displayName: 'Skyline Properties', terms: 5, account: '6010', amount: [180000, 180000], desc: 'Monthly office rent' },
  { displayName: 'Metro Power Co', terms: 15, account: '6020', amount: [22000, 46000], desc: 'Electricity and water' },
  { displayName: 'FiberLink Telecom', terms: 15, account: '6030', amount: [9500, 12500], desc: 'Internet and phone lines' },
  { displayName: 'CloudScale Hosting', terms: 30, account: '5010', amount: [64000, 98000], desc: 'Cloud hosting and bandwidth' },
  { displayName: 'Atlas Software Ltd', terms: 30, account: '6040', amount: [18000, 24000], desc: 'Software licences' },
  { displayName: 'Quill & Co Accountants', terms: 30, account: '6090', amount: [75000, 75000], desc: 'Accountancy and audit fees' },
  { displayName: 'SwiftShip Courier', terms: 15, account: '6070', amount: [1800, 7200], desc: 'Courier charges' },
  { displayName: 'Bright Media Agency', terms: 30, account: '6100', amount: [40000, 130000], desc: 'Campaign management' },
  { displayName: 'Harbourside Insurance', terms: 30, account: '6110', amount: [31000, 31000], desc: 'Annual business insurance' },
  { displayName: 'Devlin Contractors', terms: 30, account: '5000', amount: [120000, 320000], desc: 'Subcontracted development work' },
];

const CARD_EXPENSES = [
  { vendor: 'Atlas Software Ltd', account: '6040', desc: 'Design tool subscription', amount: [1200, 4800] },
  { vendor: 'SwiftShip Courier', account: '6070', desc: 'Courier — client documents', amount: [900, 3600] },
  { vendor: null, account: '6060', desc: 'Client lunch meeting', amount: [2500, 9500] },
  { vendor: null, account: '6080', desc: 'Stationery and printer paper', amount: [1500, 6000] },
  { vendor: null, account: '6050', desc: 'Taxi to client site', amount: [1200, 5500] },
  { vendor: null, account: '6130', desc: 'Bank service charge', amount: [500, 1500] },
];

/**
 * Departments exist from day one on purpose. A dimension tag has to be written
 * onto the journal line at the moment the entry is posted — adding one later
 * leaves every historical line untagged.
 */
const DEPARTMENTS = [
  { code: 'ENG', name: 'Engineering' },
  { code: 'SALES', name: 'Sales & Marketing' },
  { code: 'PS', name: 'Professional Services' },
  { code: 'OPS', name: 'Operations' },
  { code: 'GA', name: 'Finance & Admin' },
];

/** Which department normally carries each account's cost or revenue. */
const ACCOUNT_DEPARTMENT: Record<string, string> = {
  '4000': 'PS', '4010': 'ENG', '4020': 'PS', '4100': 'GA',
  '5000': 'ENG', '5010': 'ENG', '5100': 'GA',
  '6010': 'OPS', '6020': 'OPS', '6030': 'OPS', '6040': 'ENG',
  '6050': 'SALES', '6060': 'SALES', '6070': 'OPS', '6080': 'GA',
  '6090': 'GA', '6100': 'SALES', '6110': 'GA', '6120': 'OPS',
  '6130': 'GA', '6140': 'OPS', '6150': 'ENG', '6160': 'GA', '6170': 'ENG',
};

const SERVICES = [
  { name: 'Implementation Consulting', account: '4000', price: 15000 },
  { name: 'Platform Subscription — Monthly', account: '4010', price: 45000 },
  { name: 'Priority Support Retainer', account: '4020', price: 60000 },
  { name: 'Data Migration', account: '4000', price: 22000 },
  { name: 'Training Workshop (per day)', account: '4000', price: 90000 },
];

async function buildCompany(opts: {
  groupId: string;
  name: string;
  legalName: string;
  framework: Framework;
  currency: string;
  country: string;
  city: string;
  parentCompanyId?: string;
  ownershipBps?: number;
  customers: string[];
  openingCapital: number;
}) {
  const [company] = await db
    .insert(companies)
    .values({
      groupId: opts.groupId,
      parentCompanyId: opts.parentCompanyId ?? null,
      ownershipBps: opts.ownershipBps ?? 10000,
      name: opts.name,
      legalName: opts.legalName,
      framework: opts.framework,
      functionalCurrency: opts.currency,
      currency: opts.currency,
      country: opts.country,
      city: opts.city,
      email: `accounts@${opts.name.toLowerCase().replace(/[^a-z]/g, '')}.example`,
    })
    .returning();

  await db.insert(accounts).values(
    CHART.map((a) => ({
      companyId: company.id,
      code: a.code,
      name: a.name,
      type: a.type,
      subtype: a.subtype,
      isSystem: a.isSystem ?? false,
      isIntercompany: a.isIntercompany ?? false,
      groupAccountCode: a.code,
    })),
  );

  await db.insert(accountingPolicies).values(
    DEFAULT_POLICIES[opts.framework].map((p) => ({
      companyId: company.id,
      key: p.key,
      value: p.value,
      basis: p.basis,
      note: p.note,
    })),
  );

  const accRows = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
  const acc = (code: string) => {
    const a = accRows.find((x) => x.code === code);
    if (!a) throw new Error(`Missing account ${code} in ${company.name}`);
    return a;
  };

  const [deptDimension] = await db
    .insert(dimensions)
    .values({ companyId: company.id, code: 'DEPT', name: 'Department', isRequiredOnPL: true, sortOrder: 1 })
    .returning();

  const deptRows = await db
    .insert(dimensionValues)
    .values(DEPARTMENTS.map((d) => ({ dimensionId: deptDimension.id, code: d.code, name: d.name })))
    .returning();

  const deptByCode = new Map(deptRows.map((d) => [d.code, d.id]));
  /** Department tag for an account code, as a jsonb-ready array. */
  const dept = (accountCode: string): string[] | null => {
    const id = deptByCode.get(ACCOUNT_DEPARTMENT[accountCode] ?? '');
    return id ? [id] : null;
  };

  const [tax] = await db
    .insert(taxRates)
    .values({ companyId: company.id, name: 'Sales Tax 5%', rateBps: 500 })
    .returning();

  const customerRows = [];
  for (const name of opts.customers) {
    const [c] = await db
      .insert(contacts)
      .values({
        companyId: company.id,
        kind: 'CUSTOMER',
        displayName: name,
        email: `ap@${name.toLowerCase().replace(/[^a-z]/g, '')}.example`,
        termsDays: pick([15, 30, 30, 45]),
        city: opts.city,
        country: opts.country,
      })
      .returning();
    customerRows.push(c);
  }

  const vendorRows = new Map<string, { id: string }>();
  for (const v of VENDOR_SPECS) {
    const [c] = await db
      .insert(contacts)
      .values({
        companyId: company.id,
        kind: 'VENDOR',
        displayName: v.displayName,
        email: `billing@${v.displayName.toLowerCase().replace(/[^a-z]/g, '')}.example`,
        termsDays: v.terms,
        city: opts.city,
        country: opts.country,
      })
      .returning();
    vendorRows.set(v.displayName, c);
  }

  const itemRows = [];
  for (const s of SERVICES) {
    const [i] = await db
      .insert(items)
      .values({
        companyId: company.id,
        name: s.name,
        type: 'SERVICE',
        unitPriceCents: s.price,
        incomeAccountId: acc(s.account).id,
        taxRateId: tax.id,
      })
      .returning();
    itemRows.push(i);
  }

  return { company, acc, tax, dept, deptByCode, customers: customerRows, vendors: vendorRows, items: itemRows };
}

async function generateHistory(ctx: Awaited<ReturnType<typeof buildCompany>>, months: number) {
  const { company, acc, tax, dept, deptByCode, customers, vendors, items: itemRows } = ctx;
  const today = new Date();
  const startYear = today.getUTCFullYear() - (months > 12 ? 1 : 0);
  const startMonth = months > 12 ? today.getUTCMonth() : today.getUTCMonth() - months + 1;
  const openingDate = new Date(Date.UTC(startYear, startMonth, 1));

  const capital = 5_870_000;
  await postJournal({
    companyId: company.id,
    date: openingDate,
    memo: 'Opening balances',
    source: 'OPENING_BALANCE',
    lines: [
      { accountId: acc('1000').id, debit: 4_250_000, description: 'Opening bank balance' },
      { accountId: acc('1010').id, debit: 1_500_000, description: 'Opening savings balance' },
      { accountId: acc('1020').id, debit: 50_000, description: 'Opening petty cash' },
      { accountId: acc('1500').id, debit: 1_850_000, description: 'Computer equipment at cost' },
      { accountId: acc('1510').id, debit: 620_000, description: 'Office furniture at cost' },
      { accountId: acc('2700').id, credit: 2_400_000, description: 'Long-term loan' },
      { accountId: acc('3000').id, credit: capital, description: 'Share capital issued' },
    ],
  });

  let invoiceCount = 0;
  let billCount = 0;
  let expenseCount = 0;
  let paymentCount = 0;

  for (let m = 0; m < months; m++) {
    const monthDate = new Date(Date.UTC(startYear, startMonth + m, 1));
    const y = monthDate.getUTCFullYear();
    const mo = monthDate.getUTCMonth();
    if (monthDate > today) break;

    // Sales
    for (let i = 0; i < between(5, 8); i++) {
      const customer = pick(customers);
      const date = d(y, mo, between(2, 26));
      if (date > today) continue;

      const lines = [];
      for (let l = 0; l < between(1, 3); l++) {
        const svc = pick(SERVICES);
        const growth = 1 + m * 0.012;
        lines.push({
          itemId: itemRows.find((it) => it.name === svc.name)?.id ?? null,
          description: svc.name,
          quantity: svc.name.includes('Monthly') ? 1000 : between(1, 6) * 1000,
          unitPriceCents: Math.round(svc.price * growth),
          accountId: acc(svc.account).id,
          taxRateId: tax.id,
          dimensionValueIds: dept(svc.account),
        });
      }

      const invoice = await createInvoice({
        companyId: company.id,
        customerId: customer.id,
        date,
        memo: `Services for ${date.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`,
        standardRefs: [ctx.company.framework === 'IFRS' ? 'IFRS 15.31' : 'ASC 606-10-25-30'],
        lines,
      });
      invoiceCount++;

      const payDate = new Date(date.getTime() + between(5, customer.termsDays + 20) * 86_400_000);
      if (payDate <= today && rnd() > 0.18) {
        await createPayment({
          companyId: company.id,
          kind: 'RECEIVED',
          contactId: customer.id,
          date: payDate,
          bankAccountId: acc('1000').id,
          memo: `Payment for ${invoice.number}`,
          allocations: [{ invoiceId: invoice.id, amountCents: invoice.totalCents }],
        });
        paymentCount++;
      }
    }

    // Recurring vendor bills — what the history layer learns from
    for (const v of VENDOR_SPECS) {
      if (['Bright Media Agency', 'Devlin Contractors'].includes(v.displayName) && rnd() > 0.55) continue;
      if (v.displayName === 'Quill & Co Accountants' && mo % 3 !== 0) continue;
      if (v.displayName === 'Harbourside Insurance' && mo !== 0) continue;

      const date = d(y, mo, v.displayName === 'Skyline Properties' ? 1 : between(3, 24));
      if (date > today) continue;

      const vendor = vendors.get(v.displayName)!;
      const bill = await createBill({
        companyId: company.id,
        vendorId: vendor.id,
        date,
        memo: `${v.displayName} — ${date.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`,
        lines: [
          {
            description: v.desc,
            quantity: 1000,
            unitPriceCents: between(v.amount[0], v.amount[1]),
            accountId: acc(v.account).id,
            dimensionValueIds: dept(v.account),
          },
        ],
      });
      billCount++;

      const payDate = new Date(date.getTime() + between(3, v.terms) * 86_400_000);
      if (payDate <= today && rnd() > 0.12) {
        await createPayment({
          companyId: company.id,
          kind: 'MADE',
          contactId: vendor.id,
          date: payDate,
          bankAccountId: acc('1000').id,
          memo: `Payment for ${bill.number}`,
          allocations: [{ billId: bill.id, amountCents: bill.totalCents }],
        });
        paymentCount++;
      }
    }

    // Payroll
    const payrollDate = d(y, mo, 28);
    if (payrollDate <= today) {
      const gross = between(620_000, 780_000);
      const withheld = Math.round(gross * 0.11);

      // Payroll is split across departments — the largest cost in the business
      // is useless on the P&L as a single line.
      const split: [string, number][] = [['ENG', 0.45], ['SALES', 0.2], ['PS', 0.2], ['OPS', 0.08], ['GA', 0.07]];
      let allocated = 0;
      const payrollLines = split.map(([code, share], i) => {
        const amount = i === split.length - 1 ? gross - allocated : Math.round(gross * share);
        allocated += amount;
        const valueId = deptByCode.get(code);
        return {
          accountId: acc('6000').id,
          debit: amount,
          description: `Monthly salaries — ${DEPARTMENTS.find((d) => d.code === code)!.name}`,
          dimensionValueIds: valueId ? [valueId] : null,
        };
      });

      await postJournal({
        companyId: company.id,
        date: payrollDate,
        memo: `Payroll — ${payrollDate.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`,
        standardRefs: [company.framework === 'IFRS' ? 'IAS 19.11' : 'ASC 710-10-25-1'],
        lines: [
          ...payrollLines,
          { accountId: acc('2300').id, credit: withheld, description: 'Tax withheld from staff' },
          { accountId: acc('1000').id, credit: gross - withheld, description: 'Net pay transferred' },
        ],
      });
    }

    // Card expenses
    for (let e = 0; e < between(3, 6); e++) {
      const spec = pick(CARD_EXPENSES);
      const date = d(y, mo, between(2, 27));
      if (date > today) continue;
      await createExpense({
        companyId: company.id,
        date,
        vendorId: spec.vendor ? vendors.get(spec.vendor)!.id : null,
        paymentAccountId: rnd() > 0.35 ? acc('2100').id : acc('1000').id,
        method: 'CARD',
        memo: spec.desc,
        lines: [
          {
            accountId: acc(spec.account).id,
            description: spec.desc,
            amountCents: between(spec.amount[0], spec.amount[1]),
            dimensionValueIds: dept(spec.account),
          },
        ],
      });
      expenseCount++;
    }

    // Month-end adjustments
    const monthEnd = new Date(Date.UTC(y, mo + 1, 0));
    if (monthEnd <= today) {
      await postJournal({
        companyId: company.id,
        date: monthEnd,
        memo: 'Monthly depreciation',
        source: 'ADJUSTMENT',
        standardRefs: [company.framework === 'IFRS' ? 'IAS 16.50' : 'ASC 360-10-35-4'],
        lines: [
          { accountId: acc('6140').id, debit: 41_000, description: 'Depreciation — equipment and furniture', dimensionValueIds: dept('6140') },
          { accountId: acc('1590').id, credit: 41_000, description: 'Accumulated depreciation' },
        ],
      });
      await postJournal({
        companyId: company.id,
        date: monthEnd,
        memo: 'Loan interest',
        source: 'ADJUSTMENT',
        lines: [
          { accountId: acc('6900').id, debit: 20_000, description: 'Interest on long-term loan' },
          { accountId: acc('1000').id, credit: 20_000, description: 'Interest debited by bank' },
        ],
      });
    }
  }

  return { invoiceCount, billCount, expenseCount, paymentCount };
}

async function main() {
  const existing = await db.select().from(companies).limit(1);
  if (existing.length) {
    console.log(`↷ Books already exist — seed skipped.`);
    return;
  }

  console.log('→ Loading the IFRS / US GAAP rule-set…');
  const cat = await syncCatalog(STANDARD_CATALOG);
  console.log(`  ${cat.inserted} rules loaded (${STANDARD_CATALOG.filter((s) => s.framework === 'IFRS').length} IFRS, ${STANDARD_CATALOG.filter((s) => s.framework === 'US_GAAP').length} US GAAP)`);

  console.log('→ Creating the group…');
  const [group] = await db
    .insert(groups)
    .values({ name: 'Zignaly Group', presentationCurrency: 'USD', framework: 'IFRS' })
    .returning();

  console.log('→ Creating users…');
  // One shared demo password, printed at the end. Override with SEED_PASSWORD.
  const demoPassword = process.env.SEED_PASSWORD || 'Ledgerly2026!';
  const pw = await hashPassword(demoPassword);

  const userRows = await db
    .insert(users)
    .values([
      { email: 'fahad@zignaly.com', name: 'Fahad', passwordHash: pw },
      { email: 'controller@zignaly.example', name: 'Group Controller', passwordHash: pw },
      { email: 'bookkeeper@zignaly.example', name: 'Bookkeeper', passwordHash: pw },
    ])
    .returning();

  // Group-level grants cascade to every company in the group.
  await db.insert(memberships).values([
    { userId: userRows[0].id, groupId: group.id, role: 'OWNER' },
    { userId: userRows[1].id, groupId: group.id, role: 'ACCOUNTANT' },
  ]);

  console.log('→ Exchange rates…');
  const today = new Date();
  await db.insert(fxRates).values([
    { fromCurrency: 'EUR', toCurrency: 'USD', date: new Date(Date.UTC(today.getUTCFullYear() - 1, 0, 1)), rateMicros: 1_080_000, kind: 'CLOSING' },
    { fromCurrency: 'EUR', toCurrency: 'USD', date: new Date(Date.UTC(today.getUTCFullYear() - 1, 0, 1)), rateMicros: 1_075_000, kind: 'AVERAGE' },
    { fromCurrency: 'EUR', toCurrency: 'USD', date: today, rateMicros: 1_092_000, kind: 'CLOSING' },
    { fromCurrency: 'EUR', toCurrency: 'USD', date: today, rateMicros: 1_086_000, kind: 'AVERAGE' },
  ]);

  console.log('→ Parent company (IFRS, USD)…');
  const parent = await buildCompany({
    groupId: group.id,
    name: 'Zignaly Holdings',
    legalName: 'Zignaly Holdings Ltd',
    framework: 'IFRS',
    currency: 'USD',
    country: 'PK',
    city: 'Karachi',
    customers: ['Northwind Trading', 'Blue Harbour Logistics', 'Cedar Analytics', 'Meridian Health', 'Fahad Enterprises'],
    openingCapital: 5_870_000,
  });

  console.log('→ Subsidiary (US GAAP, EUR, 75 % owned)…');
  const sub = await buildCompany({
    groupId: group.id,
    name: 'Zignaly Europe',
    legalName: 'Zignaly Europe BV',
    framework: 'US_GAAP',
    currency: 'EUR',
    country: 'NL',
    city: 'Amsterdam',
    parentCompanyId: parent.company.id,
    ownershipBps: 7500,
    customers: ['Rhine Digital', 'Amstel Retail Group', 'Nordic Freight BV'],
    openingCapital: 2_100_000,
  });

  // Company-level grant: the bookkeeper sees the parent only, which is what
  // makes the access scoping visible when you sign in as them.
  await db.insert(memberships).values({
    userId: userRows[2].id,
    companyId: parent.company.id,
    role: 'BOOKKEEPER',
  });

  console.log('→ Generating trading history (this takes a minute)…');
  const parentStats = await generateHistory(parent, 14);
  const subStats = await generateHistory(sub, 9);

  // ── Intercompany traffic, so consolidation has something to eliminate ──
  console.log('→ Intercompany transactions…');
  const [subAsCustomer] = await db
    .insert(contacts)
    .values({
      companyId: parent.company.id,
      kind: 'CUSTOMER',
      displayName: 'Zignaly Europe (intercompany)',
      relatedCompanyId: sub.company.id,
      termsDays: 30,
      country: 'NL',
    })
    .returning();

  const [parentAsVendor] = await db
    .insert(contacts)
    .values({
      companyId: sub.company.id,
      kind: 'VENDOR',
      displayName: 'Zignaly Holdings (intercompany)',
      relatedCompanyId: parent.company.id,
      termsDays: 30,
      country: 'PK',
    })
    .returning();

  for (let m = 6; m >= 1; m--) {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - m, 15));
    const amount = between(250_000, 420_000);

    await createInvoice({
      companyId: parent.company.id,
      customerId: subAsCustomer.id,
      date,
      memo: `Management and platform services — ${date.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`,
      standardRefs: ['IFRS 15.31', 'IAS 24.18'],
      lines: [
        {
          description: 'Intragroup management and platform services',
          quantity: 1000,
          unitPriceCents: amount,
          accountId: parent.acc('4100').id,
        },
      ],
    });

    await createBill({
      companyId: sub.company.id,
      vendorId: parentAsVendor.id,
      date,
      memo: `Management and platform services — ${date.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`,
      standardRefs: ['ASC 850-10-50-1'],
      lines: [
        {
          description: 'Intragroup management and platform services',
          quantity: 1000,
          unitPriceCents: amount,
          accountId: sub.acc('5100').id,
        },
      ],
    });
  }

  // A budget for the current year, built from the prior twelve months so
  // budget-vs-actual has something real to compare against on first run.
  console.log('→ Building this year\u2019s budget from last year\u2019s actuals…');
  const thisYear = today.getUTCFullYear();
  let budgetLines = 0;
  for (const ctx of [parent, sub]) {
    const built = await seedBudgetFromActuals({
      companyId: ctx.company.id,
      fiscalYear: thisYear,
      fiscalStartMonth: ctx.company.fiscalYearStartMonth,
      currency: ctx.company.currency,
      upliftBps: 800,
      name: `Budget ${thisYear}`,
      createdBy: 'seed',
    });
    budgetLines += built.lineCount;
  }

  // ── On-chain treasury ───────────────────────────────────────────────
  // Registering our own wallets is what lets the matcher tell an internal
  // movement from income. Without it, moving our own money between our own
  // wallets looks like revenue twice over.
  console.log('→ On-chain wallets and transfers…');

  const priceAt = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 2, 1));
  await db.insert(assetPrices).values([
    { assetSymbol: 'USDC', quoteCurrency: 'USD', asOf: priceAt, priceMicros: 1_000_000, source: 'stablecoin peg' },
    { assetSymbol: 'ETH', quoteCurrency: 'USD', asOf: priceAt, priceMicros: 3_120_450_000, source: 'demo close price' },
    { assetSymbol: 'ZIG', quoteCurrency: 'USD', asOf: priceAt, priceMicros: 82_500, source: 'demo close price' },
  ]);

  const digitalAssetAccount = parent.acc('1450').id;
  const walletRows = await db
    .insert(wallets)
    .values([
      {
        companyId: parent.company.id,
        label: 'Treasury — Ethereum',
        chainId: 'ethereum',
        address: '0x0000000000000000000000000000000000treasury'.toLowerCase(),
        custody: 'SELF',
        accountId: digitalAssetAccount,
        notes: 'Cold wallet holding the operating float.',
      },
      {
        companyId: parent.company.id,
        label: 'Operations — Ethereum',
        chainId: 'ethereum',
        address: '0x00000000000000000000000000000000000000ops'.toLowerCase(),
        custody: 'SELF',
        accountId: digitalAssetAccount,
        notes: 'Hot wallet used to settle vendor invoices.',
      },
    ])
    .returning();

  const treasury = walletRows[0];
  const ops = walletRows[1];

  // A customer and a vendor that settle on chain. Registering their addresses
  // is what turns an anonymous transfer into a recognised counterparty.
  const CUSTOMER_WALLET = '0x000000000000000000000000000000000000cedar';
  const VENDOR_WALLET = '0x00000000000000000000000000000000000cloud';

  await db
    .update(contacts)
    .set({ walletAddresses: [CUSTOMER_WALLET] })
    .where(and(eq(contacts.companyId, parent.company.id), eq(contacts.displayName, 'Cedar Analytics')));
  await db
    .update(contacts)
    .set({ walletAddresses: [VENDOR_WALLET] })
    .where(and(eq(contacts.companyId, parent.company.id), eq(contacts.displayName, 'CloudScale Hosting')));

  // An invoice that is genuinely still open, so the memo match is real.
  const [openInvoice] = await db
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.companyId, parent.company.id),
        sql`${invoices.status} IN ('OPEN','OVERDUE','PARTIAL')`,
      ),
    )
    .orderBy(sql`${invoices.date} DESC`)
    .limit(1);

  const day = (back: number) =>
    new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - back, 11, 0, 0));

  const transfers: RawTransfer[] = [
    // 1 · A customer settles an invoice in stablecoin, quoting its number.
    {
      chainId: 'ethereum',
      txHash: '0xa1c4f7e2b93d5188cc4a77e6f0d1b2a3c4d5e6f708192a3b4c5d6e7f80912a3b4',
      logIndex: 0,
      blockNumber: 20481233,
      occurredAt: day(9),
      direction: 'IN',
      walletAddress: treasury.address,
      counterpartyAddress: CUSTOMER_WALLET,
      assetSymbol: 'USDC',
      assetDecimals: 6,
      amountRaw: openInvoice ? `${Math.max(1, openInvoice.totalCents - openInvoice.paidCents) * 10_000}` : '4250000000',
      memo: openInvoice ? `Settlement of ${openInvoice.number}` : 'Customer settlement',
      priceMicros: 1_000_000,
      priceSource: 'stablecoin peg',
    },
    // 2 · Paying a vendor we know, with gas — the fee is its own expense.
    {
      chainId: 'ethereum',
      txHash: '0xb2d5a8f3ca4e6299dd5b88f7a1e2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5',
      logIndex: 0,
      blockNumber: 20492874,
      occurredAt: day(6),
      direction: 'OUT',
      walletAddress: ops.address,
      counterpartyAddress: VENDOR_WALLET,
      assetSymbol: 'USDC',
      assetDecimals: 6,
      amountRaw: '78500000',
      feeRaw: '4100000',
      feeAssetSymbol: 'USDC',
      memo: 'CloudScale Hosting — infrastructure',
      priceMicros: 1_000_000,
      priceSource: 'stablecoin peg',
    },
    // 3 · Our own treasury topping up our own hot wallet. Not income.
    {
      chainId: 'ethereum',
      txHash: '0xc3e6b9a4db5f73aaee6c99a8b2f3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6',
      logIndex: 0,
      blockNumber: 20501002,
      occurredAt: day(4),
      direction: 'OUT',
      walletAddress: treasury.address,
      counterpartyAddress: ops.address,
      assetSymbol: 'USDC',
      assetDecimals: 6,
      amountRaw: '150000000',
      memo: 'Top up operations wallet',
      priceMicros: 1_000_000,
      priceSource: 'stablecoin peg',
    },
    // 4 · An inbound transfer from an address nobody has registered. The
    //     matcher should refuse to guess at this one.
    {
      chainId: 'ethereum',
      txHash: '0xd4f7cab5ec6084bbff7daab9c3f4e5061728394a5b6c7d8e9f0a1b2c3d4e5f607',
      logIndex: 0,
      blockNumber: 20510555,
      occurredAt: day(2),
      direction: 'IN',
      walletAddress: treasury.address,
      counterpartyAddress: '0x000000000000000000000000000000000unknown1',
      assetSymbol: 'ETH',
      assetDecimals: 18,
      amountRaw: '250000000000000000',
      memo: null,
      priceMicros: 3_120_450_000,
      priceSource: 'demo close price',
    },
  ];

  const onchainImport = await importTransfers({
    companyId: parent.company.id,
    walletId: treasury.id,
    transfers: transfers.filter((t) => t.walletAddress === treasury.address),
  });
  const opsImport = await importTransfers({
    companyId: parent.company.id,
    walletId: ops.id,
    transfers: transfers.filter((t) => t.walletAddress === ops.address),
  });
  const matched = await runMatcher(parent.company.id);

  const counted = await db.execute(sql`SELECT COUNT(*)::int AS count FROM journal_entries`);
  const count = (counted.rows as unknown as { count: number }[])[0]?.count ?? 0;

  console.log('\n✔ Seed complete');
  console.log(`  group            ${group.name} (presentation ${group.presentationCurrency}, ${group.framework})`);
  console.log(`  companies        ${parent.company.name} (IFRS/USD) · ${sub.company.name} (US GAAP/EUR, 75 %)`);
  console.log(`  users            ${userRows.length}`);
  console.log(`  standards        ${cat.inserted}`);
  console.log(`  parent documents ${parentStats.invoiceCount} invoices · ${parentStats.billCount} bills · ${parentStats.expenseCount} expenses · ${parentStats.paymentCount} payments`);
  console.log(`  sub documents    ${subStats.invoiceCount} invoices · ${subStats.billCount} bills · ${subStats.expenseCount} expenses · ${subStats.paymentCount} payments`);
  console.log(`  journal entries  ${count}`);
  console.log(`  departments      ${DEPARTMENTS.length} per company`);
  console.log(`  budget lines     ${budgetLines}`);
  console.log(`  wallets          ${walletRows.length}`);
  console.log(`  on-chain         ${onchainImport.inserted + opsImport.inserted} transfers · ${matched.resolved}/${matched.examined} matched automatically\n`);
  console.log('  Sign in with:');
  console.log(`    fahad@zignaly.com                 owner       (both companies)`);
  console.log(`    controller@zignaly.example        accountant  (both companies)`);
  console.log(`    bookkeeper@zignaly.example        bookkeeper  (parent only, cannot post)`);
  console.log(`    password for all three:           ${demoPassword}\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });

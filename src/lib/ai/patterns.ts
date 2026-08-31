/**
 * The history layer.
 *
 * It answers one question: "how has this company booked things like this
 * before?" — purely from the ledger, with no model and no randomness.
 *
 * Since the standards engine was added this layer is deliberately SECOND in
 * authority. It decides *which account* implements a treatment the standard
 * has already determined, and it raises a flag when past practice contradicts
 * the standard rather than quietly repeating the error.
 */

import { and, desc, eq, gt, inArray, isNotNull, lt, ne, sql } from 'drizzle-orm';
import { db } from '../db';
import { accounts, bills, contacts, expenses, invoices, journalEntries, journalLines } from '@/db/schema';
import type { AccountSubtype, AccountType } from '@/db/schema';
import type { Cents } from '../money';
import { tokenize } from './tokens';

export { tokenize };

export interface Evidence {
  date: string;
  description: string;
  accountName: string;
  amountCents: Cents;
  contactName?: string | null;
  source: string;
}

export interface AccountSuggestion {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: AccountSubtype;
  /** 0–100, from match count, share of history and recency. */
  confidence: number;
  reason: string;
  timesUsed: number;
  lastUsed: string | null;
  typicalAmountCents: Cents | null;
  evidence: Evidence[];
}

interface HistoryRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: AccountSubtype;
  description: string | null;
  contactId: string | null;
  contactName: string | null;
  date: Date;
  amountCents: number;
  source: string;
}

/**
 * `before` exists so the replay harness can evaluate the matcher honestly —
 * scoring a transaction against history that already contains it would be
 * marking its own homework.
 */
async function loadHistory(
  companyId: string,
  side: 'DEBIT' | 'CREDIT' | 'ANY',
  limit = 4000,
  before?: Date,
): Promise<HistoryRow[]> {
  const conditions = [
    eq(journalEntries.companyId, companyId),
    eq(journalEntries.isVoid, false),
    // Control accounts are mechanical; suggesting them is never useful.
    sql`${accounts.subtype}::text NOT IN ('ACCOUNTS_RECEIVABLE','ACCOUNTS_PAYABLE')`,
  ];
  if (before) conditions.push(lt(journalEntries.date, before));
  if (side === 'DEBIT') conditions.push(gt(journalLines.debitCents, 0));
  if (side === 'CREDIT') conditions.push(gt(journalLines.creditCents, 0));

  const rows = await db
    .select({
      accountId: journalLines.accountId,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
      lineDescription: journalLines.description,
      memo: journalEntries.memo,
      contactId: journalLines.contactId,
      contactName: contacts.displayName,
      date: journalEntries.date,
      debitCents: journalLines.debitCents,
      creditCents: journalLines.creditCents,
      source: journalEntries.source,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .leftJoin(contacts, eq(contacts.id, journalLines.contactId))
    .where(and(...conditions))
    .orderBy(desc(journalEntries.date))
    .limit(limit);

  return rows.map((r) => ({
    accountId: r.accountId,
    code: r.code,
    name: r.name,
    type: r.type,
    subtype: r.subtype,
    description: r.lineDescription ?? r.memo,
    contactId: r.contactId,
    contactName: r.contactName,
    date: new Date(r.date),
    amountCents: r.debitCents + r.creditCents,
    source: r.source,
  }));
}

const daysAgo = (d: Date) => Math.max(0, (Date.now() - d.getTime()) / 86_400_000);
/** Recent history counts for more, but old history never counts for nothing. */
const recencyWeight = (d: Date) => 0.35 + 0.65 * Math.exp(-daysAgo(d) / 365);

export const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

export interface SuggestInput {
  companyId: string;
  text: string;
  contactId?: string | null;
  direction: 'MONEY_OUT' | 'MONEY_IN';
  amountCents?: Cents;
  limit?: number;
  /** Only consider history strictly before this date (replay harness). */
  before?: Date;
  /** Restrict to accounts of these subtypes — used to honour a standard's template. */
  restrictToSubtypes?: string[];
}

export async function suggestAccounts(input: SuggestInput): Promise<AccountSuggestion[]> {
  const side = input.direction === 'MONEY_OUT' ? 'DEBIT' : 'CREDIT';
  const history = await loadHistory(input.companyId, side, 4000, input.before);
  if (!history.length) return [];

  const tokenSet = new Set(tokenize(input.text));

  interface Bucket {
    row: HistoryRow;
    score: number;
    contactHit: boolean;
    tokenHits: number;
    amounts: number[];
    matches: HistoryRow[];
  }

  const buckets = new Map<string, Bucket>();

  for (const h of history) {
    if (input.restrictToSubtypes?.length && !input.restrictToSubtypes.includes(h.subtype)) continue;

    const hTokens = tokenize([h.description ?? '', h.contactName ?? ''].join(' '));
    let tokenHits = 0;
    for (const t of hTokens) if (tokenSet.has(t)) tokenHits++;

    const contactHit = Boolean(input.contactId && h.contactId === input.contactId);
    if (!contactHit && tokenHits === 0) continue;

    // A matching counterparty outweighs fuzzy word overlap.
    const score = ((contactHit ? 6 : 0) + tokenHits * 2) * recencyWeight(h.date);

    const b = buckets.get(h.accountId) ?? {
      row: h,
      score: 0,
      contactHit: false,
      tokenHits: 0,
      amounts: [],
      matches: [],
    };
    b.score += score;
    b.contactHit ||= contactHit;
    b.tokenHits += tokenHits;
    b.amounts.push(h.amountCents);
    if (b.matches.length < 3) b.matches.push(h);
    if (h.date > b.row.date) b.row = h;
    buckets.set(h.accountId, b);
  }

  if (!buckets.size) return [];

  const ranked = Array.from(buckets.values()).sort((a, b) => b.score - a.score);
  const totalScore = ranked.reduce((s, b) => s + b.score, 0) || 1;

  return ranked.slice(0, input.limit ?? 4).map((b) => {
    const share = b.score / totalScore;
    // Confidence blends dominance with how much evidence exists at all —
    // three matches at 100 % share is not the same as thirty.
    const volumeFactor = Math.min(1, b.amounts.length / 8);
    const confidence = Math.round(Math.min(97, 100 * share * (0.55 + 0.45 * volumeFactor)));

    const parts: string[] = [];
    if (b.contactHit) parts.push(`this counterparty has been booked here ${b.amounts.length}×`);
    if (b.tokenHits > 0) parts.push(`description matches ${b.tokenHits} past line${b.tokenHits > 1 ? 's' : ''}`);
    const typical = median(b.amounts);
    if (typical) parts.push(`typical amount ${(typical / 100).toFixed(2)}`);

    return {
      accountId: b.row.accountId,
      code: b.row.code,
      name: b.row.name,
      type: b.row.type,
      subtype: b.row.subtype,
      confidence,
      reason: parts.join('; ') || 'similar past entries',
      timesUsed: b.amounts.length,
      lastUsed: b.row.date.toISOString().slice(0, 10),
      typicalAmountCents: typical || null,
      evidence: b.matches.map((m) => ({
        date: m.date.toISOString().slice(0, 10),
        description: m.description ?? '(no description)',
        accountName: m.name,
        amountCents: m.amountCents,
        contactName: m.contactName,
        source: m.source,
      })),
    };
  });
}

// ─────────────────────────── Counterparty profile ────────────────────

export interface ContactProfile {
  contactId: string;
  displayName: string;
  kind: string;
  termsDays: number;
  transactionCount: number;
  lastTransaction: string | null;
  medianAmountCents: Cents;
  favouriteAccounts: { accountId: string; name: string; code: string; count: number }[];
  cadence: string | null;
  averageDaysToPay: number | null;
  isIntercompany: boolean;
}

export async function contactProfile(companyId: string, contactId: string): Promise<ContactProfile | null> {
  const [contact] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.companyId, companyId)))
    .limit(1);
  if (!contact) return null;

  const lines = await db
    .select({
      accountId: journalLines.accountId,
      name: accounts.name,
      code: accounts.code,
      debitCents: journalLines.debitCents,
      creditCents: journalLines.creditCents,
      date: journalEntries.date,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(
      and(
        eq(journalLines.contactId, contactId),
        eq(journalEntries.companyId, companyId),
        eq(journalEntries.isVoid, false),
        sql`${accounts.subtype}::text NOT IN ('ACCOUNTS_RECEIVABLE','ACCOUNTS_PAYABLE')`,
      ),
    )
    .orderBy(desc(journalEntries.date))
    .limit(500);

  const counts = new Map<string, { accountId: string; name: string; code: string; count: number }>();
  const amounts: number[] = [];
  for (const l of lines) {
    const c = counts.get(l.accountId) ?? { accountId: l.accountId, name: l.name, code: l.code, count: 0 };
    c.count++;
    counts.set(l.accountId, c);
    amounts.push(l.debitCents + l.creditCents);
  }

  const dates = Array.from(new Set(lines.map((l) => new Date(l.date).toISOString().slice(0, 10))))
    .sort()
    .map((d) => new Date(d).getTime());
  let cadence: string | null = null;
  if (dates.length >= 3) {
    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i++) gaps.push((dates[i] - dates[i - 1]) / 86_400_000);
    const g = median(gaps);
    if (g >= 25 && g <= 35) cadence = 'monthly';
    else if (g >= 6 && g <= 8) cadence = 'weekly';
    else if (g >= 85 && g <= 95) cadence = 'quarterly';
    else if (g >= 13 && g <= 16) cadence = 'fortnightly';
  }

  let averageDaysToPay: number | null = null;
  if (contact.kind !== 'VENDOR') {
    const paid = await db.execute(sql`
      SELECT i.date AS invoice_date, MAX(p.date) AS last_payment
      FROM invoices i
      JOIN payment_allocations pa ON pa.invoice_id = i.id
      JOIN payments p ON p.id = pa.payment_id
      WHERE i.company_id = ${companyId} AND i.customer_id = ${contactId} AND i.status = 'PAID'
      GROUP BY i.id, i.date
      ORDER BY i.date DESC
      LIMIT 50
    `);
    const spans = (paid.rows as unknown as { invoice_date: string; last_payment: string }[])
      .map((r) => (new Date(r.last_payment).getTime() - new Date(r.invoice_date).getTime()) / 86_400_000)
      .filter((n) => Number.isFinite(n));
    if (spans.length) averageDaysToPay = Math.round(spans.reduce((a, b) => a + b, 0) / spans.length);
  }

  return {
    contactId,
    displayName: contact.displayName,
    kind: contact.kind,
    termsDays: contact.termsDays,
    transactionCount: lines.length,
    lastTransaction: lines[0] ? new Date(lines[0].date).toISOString().slice(0, 10) : null,
    medianAmountCents: median(amounts),
    favouriteAccounts: Array.from(counts.values()).sort((a, b) => b.count - a.count).slice(0, 5),
    cadence,
    averageDaysToPay,
    isIntercompany: Boolean(contact.relatedCompanyId),
  };
}

// ─────────────────────────── Duplicate guard ─────────────────────────

export interface DuplicateWarning {
  kind: 'BILL' | 'INVOICE' | 'EXPENSE';
  id: string;
  reference: string;
  date: string;
  amountCents: Cents;
  message: string;
}

/** Catch the same bill being entered twice — the most common data-entry error. */
export async function findPossibleDuplicates(opts: {
  companyId: string;
  kind: 'BILL' | 'INVOICE' | 'EXPENSE';
  contactId?: string | null;
  amountCents: Cents;
  date: Date;
  windowDays?: number;
}): Promise<DuplicateWarning[]> {
  const w = opts.windowDays ?? 45;
  const from = new Date(opts.date.getTime() - w * 86_400_000);
  const to = new Date(opts.date.getTime() + w * 86_400_000);
  const tolerance = Math.max(100, Math.round(opts.amountCents * 0.005)); // ±0.5 % or $1
  const near = (v: number) => Math.abs(v - opts.amountCents) <= tolerance;
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  if (opts.kind === 'BILL') {
    const rows = await db
      .select()
      .from(bills)
      .where(
        and(
          eq(bills.companyId, opts.companyId),
          sql`${bills.date} BETWEEN ${iso(from)} AND ${iso(to)}`,
          ...(opts.contactId ? [eq(bills.vendorId, opts.contactId)] : []),
        ),
      )
      .limit(50);
    return rows.filter((b) => near(b.totalCents)).map((b) => ({
      kind: 'BILL' as const,
      id: b.id,
      reference: b.number,
      date: iso(new Date(b.date)),
      amountCents: b.totalCents,
      message: `Bill ${b.number} dated ${iso(new Date(b.date))} is for a near-identical amount.`,
    }));
  }

  if (opts.kind === 'INVOICE') {
    const rows = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.companyId, opts.companyId),
          sql`${invoices.date} BETWEEN ${iso(from)} AND ${iso(to)}`,
          ...(opts.contactId ? [eq(invoices.customerId, opts.contactId)] : []),
        ),
      )
      .limit(50);
    return rows.filter((i) => near(i.totalCents)).map((i) => ({
      kind: 'INVOICE' as const,
      id: i.id,
      reference: i.number,
      date: iso(new Date(i.date)),
      amountCents: i.totalCents,
      message: `Invoice ${i.number} dated ${iso(new Date(i.date))} is for a near-identical amount.`,
    }));
  }

  const rows = await db
    .select()
    .from(expenses)
    .where(
      and(
        eq(expenses.companyId, opts.companyId),
        sql`${expenses.date} BETWEEN ${iso(from)} AND ${iso(to)}`,
        ...(opts.contactId ? [eq(expenses.vendorId, opts.contactId)] : []),
      ),
    )
    .limit(50);
  return rows.filter((e) => near(e.totalCents)).map((e) => ({
    kind: 'EXPENSE' as const,
    id: e.id,
    reference: e.reference,
    date: iso(new Date(e.date)),
    amountCents: e.totalCents,
    message: `Expense ${e.reference} dated ${iso(new Date(e.date))} is for a near-identical amount.`,
  }));
}

// ─────────────────────────── Recurring transactions ──────────────────

export interface RecurringPattern {
  contactId: string;
  contactName: string;
  accountId: string;
  accountName: string;
  cadence: string;
  medianAmountCents: Cents;
  occurrences: number;
  lastDate: string;
  expectedNext: string;
  overdueDays: number;
}

export async function recurringPatterns(companyId: string, minOccurrences = 3): Promise<RecurringPattern[]> {
  const lines = await db
    .select({
      contactId: journalLines.contactId,
      contactName: contacts.displayName,
      accountId: journalLines.accountId,
      accountName: accounts.name,
      date: journalEntries.date,
      debitCents: journalLines.debitCents,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .innerJoin(contacts, eq(contacts.id, journalLines.contactId))
    .where(
      and(
        eq(journalEntries.companyId, companyId),
        eq(journalEntries.isVoid, false),
        inArray(journalEntries.source, ['BILL', 'EXPENSE']),
        isNotNull(journalLines.contactId),
        gt(journalLines.debitCents, 0),
        eq(accounts.type, 'EXPENSE'),
      ),
    )
    .orderBy(journalEntries.date)
    .limit(3000);

  const groups = new Map<
    string,
    { contactId: string; contactName: string; accountId: string; accountName: string; dates: number[]; amounts: number[] }
  >();

  for (const l of lines) {
    if (!l.contactId) continue;
    const key = `${l.contactId}:${l.accountId}`;
    const g =
      groups.get(key) ??
      { contactId: l.contactId, contactName: l.contactName, accountId: l.accountId, accountName: l.accountName, dates: [], amounts: [] };
    g.dates.push(new Date(l.date).getTime());
    g.amounts.push(l.debitCents);
    groups.set(key, g);
  }

  const out: RecurringPattern[] = [];
  for (const g of groups.values()) {
    if (g.dates.length < minOccurrences) continue;
    const gaps: number[] = [];
    for (let i = 1; i < g.dates.length; i++) gaps.push((g.dates[i] - g.dates[i - 1]) / 86_400_000);
    const gap = median(gaps);
    let cadence: string | null = null;
    if (gap >= 25 && gap <= 35) cadence = 'monthly';
    else if (gap >= 85 && gap <= 95) cadence = 'quarterly';
    else if (gap >= 6 && gap <= 8) cadence = 'weekly';
    if (!cadence) continue;

    const last = g.dates[g.dates.length - 1];
    const expected = last + gap * 86_400_000;
    out.push({
      contactId: g.contactId,
      contactName: g.contactName,
      accountId: g.accountId,
      accountName: g.accountName,
      cadence,
      medianAmountCents: median(g.amounts),
      occurrences: g.dates.length,
      lastDate: new Date(last).toISOString().slice(0, 10),
      expectedNext: new Date(expected).toISOString().slice(0, 10),
      overdueDays: Math.max(0, Math.floor((Date.now() - expected) / 86_400_000)),
    });
  }

  return out.sort((a, b) => b.overdueDays - a.overdueDays || b.occurrences - a.occurrences);
}

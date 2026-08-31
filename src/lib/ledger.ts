/**
 * The posting engine.
 *
 * Everything that touches the general ledger goes through `postJournal`. It is
 * the single choke point where "debits must equal credits" is enforced, so no
 * code path — human, imported, or AI-proposed — can write an unbalanced entry.
 * If you add a new document type, post it here; never INSERT into
 * journal_lines directly.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from './db';
import {
  accounts,
  closePeriods,
  companies,
  journalEntries,
  journalLines,
  type AccountType,
  type JournalSource,
} from '@/db/schema';
import type { Cents } from './money';

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

export interface PostLine {
  accountId: string;
  /** Use one or the other. Both zero is rejected; both non-zero is rejected. */
  debit?: Cents;
  credit?: Cents;
  description?: string | null;
  contactId?: string | null;
  /** Department / project / cost-centre tags. Written with the line, never after. */
  dimensionValueIds?: string[] | null;
}

export interface PostJournalInput {
  companyId: string;
  date: Date;
  memo?: string | null;
  source?: JournalSource;
  sourceId?: string | null;
  aiAssisted?: boolean;
  standardRefs?: string[] | null;
  counterpartyCompanyId?: string | null;
  /** How the money moved, and the reference that proves it. */
  settlementRail?: 'BANK' | 'CARD' | 'CASH' | 'CHEQUE' | 'PROCESSOR' | 'ONCHAIN' | null;
  settlementRef?: {
    reference?: string;
    chainId?: string;
    txHash?: string;
    address?: string;
    blockNumber?: number;
    processor?: string;
  } | null;
  isElimination?: boolean;
  createdBy?: string;
  lines: PostLine[];
  /** Consolidation entries are allowed into closed periods; nothing else is. */
  allowClosedPeriod?: boolean;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Client = typeof db | Tx;

/** Normal balance side of each account type. */
export const NORMAL_SIDE: Record<AccountType, 'DEBIT' | 'CREDIT'> = {
  ASSET: 'DEBIT',
  EXPENSE: 'DEBIT',
  LIABILITY: 'CREDIT',
  EQUITY: 'CREDIT',
  INCOME: 'CREDIT',
};

/** Signed balance in the account's own natural direction. */
export const signedBalance = (type: AccountType, debits: Cents, credits: Cents): Cents =>
  NORMAL_SIDE[type] === 'DEBIT' ? debits - credits : credits - debits;

export function validateLines(lines: PostLine[]): { debit: Cents; credit: Cents } {
  if (!lines || lines.length < 2) {
    throw new LedgerError('A journal entry needs at least two lines.');
  }

  let debit = 0;
  let credit = 0;

  lines.forEach((l, i) => {
    const d = Math.round(l.debit ?? 0);
    const c = Math.round(l.credit ?? 0);
    if (!l.accountId) throw new LedgerError(`Line ${i + 1} has no account.`);
    if (d < 0 || c < 0) throw new LedgerError(`Line ${i + 1} has a negative amount. Move it to the other side instead.`);
    if (d === 0 && c === 0) throw new LedgerError(`Line ${i + 1} has no amount.`);
    if (d !== 0 && c !== 0) throw new LedgerError(`Line ${i + 1} has both a debit and a credit.`);
    debit += d;
    credit += c;
  });

  if (debit !== credit) {
    const diff = Math.abs(debit - credit) / 100;
    throw new LedgerError(
      `Entry does not balance: debits ${(debit / 100).toFixed(2)} vs credits ${(credit / 100).toFixed(2)} (out by ${diff.toFixed(2)}).`,
    );
  }
  if (debit === 0) throw new LedgerError('Entry total is zero.');

  return { debit, credit };
}

async function nextEntryNo(client: Client, companyId: string, date: Date): Promise<string> {
  const prefix = `JE-${date.getUTCFullYear()}-`;
  const [last] = await client
    .select({ entryNo: journalEntries.entryNo })
    .from(journalEntries)
    .where(and(eq(journalEntries.companyId, companyId), sql`${journalEntries.entryNo} LIKE ${prefix + '%'}`))
    .orderBy(desc(journalEntries.entryNo))
    .limit(1);

  const n = last ? Number(last.entryNo.slice(prefix.length)) + 1 : 1;
  return prefix + String(n).padStart(5, '0');
}

/**
 * Post a balanced journal entry. Pass an existing transaction to make a
 * document and its GL entry commit or fail together.
 */
export async function postJournal(input: PostJournalInput, client?: Client) {
  const run = async (tx: Client) => {
    validateLines(input.lines);

    const [company] = await tx.select().from(companies).where(eq(companies.id, input.companyId)).limit(1);
    if (!company) throw new LedgerError('Company not found.');

    if (!input.allowClosedPeriod) {
      // Two locks: the legacy watermark, and the per-period close register that
      // the month-end process writes to.
      if (company.booksClosedThrough && input.date <= new Date(company.booksClosedThrough)) {
        throw new LedgerError(
          `The books are closed through ${new Date(company.booksClosedThrough).toISOString().slice(0, 10)}. Post this to an open period, or reopen the period first.`,
        );
      }

      const monthStart = new Date(Date.UTC(input.date.getUTCFullYear(), input.date.getUTCMonth(), 1));
      const [closed] = await tx
        .select({ status: closePeriods.status })
        .from(closePeriods)
        .where(and(eq(closePeriods.companyId, input.companyId), eq(closePeriods.period, monthStart)))
        .limit(1);

      if (closed?.status === 'CLOSED') {
        throw new LedgerError(
          `${monthStart.toISOString().slice(0, 7)} is closed. Reopen the period, or post the correction to an open month.`,
        );
      }
    }

    const accountIds = Array.from(new Set(input.lines.map((l) => l.accountId)));
    const found = await tx
      .select({ id: accounts.id, isActive: accounts.isActive, name: accounts.name })
      .from(accounts)
      .where(and(eq(accounts.companyId, input.companyId), inArray(accounts.id, accountIds)));

    if (found.length !== accountIds.length) {
      throw new LedgerError('One or more accounts do not exist in this company.');
    }
    const inactive = found.find((a) => !a.isActive);
    if (inactive) throw new LedgerError(`Account "${inactive.name}" is inactive.`);

    const entryNo = await nextEntryNo(tx, input.companyId, input.date);

    const [entry] = await tx
      .insert(journalEntries)
      .values({
        companyId: input.companyId,
        entryNo,
        date: input.date,
        memo: input.memo ?? null,
        source: input.source ?? 'MANUAL',
        sourceId: input.sourceId ?? null,
        aiAssisted: input.aiAssisted ?? false,
        standardRefs: input.standardRefs ?? null,
        counterpartyCompanyId: input.counterpartyCompanyId ?? null,
        settlementRail: input.settlementRail ?? null,
        settlementRef: input.settlementRef ?? null,
        isElimination: input.isElimination ?? false,
        createdBy: input.createdBy ?? 'system',
      })
      .returning();

    const lineRows = await tx
      .insert(journalLines)
      .values(
        input.lines.map((l, i) => ({
          entryId: entry.id,
          lineNo: i + 1,
          accountId: l.accountId,
          debitCents: Math.round(l.debit ?? 0),
          creditCents: Math.round(l.credit ?? 0),
          description: l.description ?? null,
          contactId: l.contactId ?? null,
          dimensionValueIds: l.dimensionValueIds?.length ? l.dimensionValueIds : null,
        })),
      )
      .returning();

    return { ...entry, lines: lineRows };
  };

  return client ? run(client) : db.transaction((tx) => run(tx));
}

/**
 * Reverse an entry by posting its mirror image, then flagging the original.
 * Accounting never deletes — it reverses, so the audit trail survives.
 */
export async function reverseJournal(entryId: string, opts: { date?: Date; memo?: string; createdBy?: string } = {}) {
  return db.transaction(async (tx) => {
    const [original] = await tx.select().from(journalEntries).where(eq(journalEntries.id, entryId)).limit(1);
    if (!original) throw new LedgerError('Entry not found.');
    if (original.isVoid) throw new LedgerError('Entry has already been reversed.');

    const lines = await tx.select().from(journalLines).where(eq(journalLines.entryId, entryId));

    const reversal = await postJournal(
      {
        companyId: original.companyId,
        date: opts.date ?? new Date(),
        memo: opts.memo ?? `Reversal of ${original.entryNo}`,
        source: 'ADJUSTMENT',
        sourceId: original.id,
        createdBy: opts.createdBy ?? 'system',
        lines: lines.map((l) => ({
          accountId: l.accountId,
          debit: l.creditCents,
          credit: l.debitCents,
          description: l.description,
          contactId: l.contactId,
        })),
      },
      tx,
    );

    await tx.update(journalEntries).set({ isVoid: true }).where(eq(journalEntries.id, entryId));
    return reversal;
  });
}

/** Resolve a well-known control account (A/R, A/P, retained earnings…). */
export async function systemAccount(companyId: string, subtype: string, client?: Client) {
  const c = client ?? db;
  const [acc] = await c
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.companyId, companyId),
        sql`${accounts.subtype}::text = ${subtype}`,
        eq(accounts.isSystem, true),
        eq(accounts.isActive, true),
      ),
    )
    .orderBy(accounts.code)
    .limit(1);

  if (!acc) throw new LedgerError(`No system account configured for ${subtype}.`);
  return acc;
}

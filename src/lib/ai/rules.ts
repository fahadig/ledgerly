/**
 * The entry checker.
 *
 * Deliberately NOT a model. Every draft entry — typed by a human, produced by
 * a bank import, or proposed by the assistant — runs through these checks
 * before the Post button becomes clickable. If the assistant is ever wrong in
 * a way a bookkeeper would catch, one of these should catch it first.
 *
 * Add a rule here rather than a caveat in a prompt. Rules are testable;
 * prompts are not.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { accounts, companies, journalEntries } from '@/db/schema';
import type { AccountSubtype, AccountType } from '@/db/schema';
import type { Cents } from '../money';

export type Severity = 'BLOCK' | 'WARN' | 'INFO';

export interface RuleFinding {
  rule: string;
  severity: Severity;
  message: string;
  lineIndex?: number;
  /** Standard the finding rests on, where there is one. */
  standardRef?: string;
}

export interface CheckableLine {
  accountId: string;
  debitCents: Cents;
  creditCents: Cents;
  description?: string;
  contactId?: string | null;
}

export interface CheckableEntry {
  companyId: string;
  date: string | Date;
  memo?: string;
  lines: CheckableLine[];
}

interface AccountInfo {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: AccountSubtype;
  isActive: boolean;
  isSystem: boolean;
}

/** Above this, an expense line described like an asset gets challenged. */
const CAPITALISATION_THRESHOLD_CENTS = 100_000; // $1,000

export interface RuleCheckResult {
  findings: RuleFinding[];
  /** True when nothing with severity BLOCK fired. */
  postable: boolean;
}

export async function checkEntry(entry: CheckableEntry): Promise<RuleCheckResult> {
  const findings: RuleFinding[] = [];
  const push = (f: RuleFinding) => findings.push(f);
  const lines = entry.lines ?? [];
  const date = new Date(entry.date);

  // ── Structural ─────────────────────────────────────────────────────
  if (lines.length < 2) {
    push({ rule: 'MIN_LINES', severity: 'BLOCK', message: 'A journal entry needs at least two lines.' });
  }

  let totalDebit = 0;
  let totalCredit = 0;
  lines.forEach((l, i) => {
    const d = Math.round(l.debitCents || 0);
    const c = Math.round(l.creditCents || 0);
    totalDebit += d;
    totalCredit += c;
    if (d < 0 || c < 0) push({ rule: 'NEGATIVE_AMOUNT', severity: 'BLOCK', lineIndex: i, message: `Line ${i + 1} has a negative amount. Move it to the other side instead.` });
    if (d === 0 && c === 0) push({ rule: 'ZERO_LINE', severity: 'BLOCK', lineIndex: i, message: `Line ${i + 1} has no amount.` });
    if (d !== 0 && c !== 0) push({ rule: 'BOTH_SIDES', severity: 'BLOCK', lineIndex: i, message: `Line ${i + 1} has both a debit and a credit.` });
  });

  if (lines.length >= 2 && totalDebit !== totalCredit) {
    push({
      rule: 'UNBALANCED',
      severity: 'BLOCK',
      message: `Entry is out of balance by ${(Math.abs(totalDebit - totalCredit) / 100).toFixed(2)} — debits ${(totalDebit / 100).toFixed(2)}, credits ${(totalCredit / 100).toFixed(2)}.`,
    });
  }
  if (lines.length >= 2 && totalDebit === 0 && totalCredit === 0) {
    push({ rule: 'ZERO_ENTRY', severity: 'BLOCK', message: 'Entry total is zero.' });
  }

  if (!lines.length) return { findings, postable: false };

  // ── Company context ────────────────────────────────────────────────
  const [company] = await db.select().from(companies).where(eq(companies.id, entry.companyId)).limit(1);
  if (!company) {
    push({ rule: 'NO_COMPANY', severity: 'BLOCK', message: 'Company not found.' });
    return { findings, postable: false };
  }

  if (company.booksClosedThrough && date <= new Date(company.booksClosedThrough)) {
    push({
      rule: 'PERIOD_CLOSED',
      severity: 'BLOCK',
      message: `The books are closed through ${new Date(company.booksClosedThrough).toISOString().slice(0, 10)}. Post to an open period or reopen the period first.`,
    });
  }

  // ── Account-aware ──────────────────────────────────────────────────
  const ids = Array.from(new Set(lines.map((l) => l.accountId).filter(Boolean)));
  const rows = ids.length
    ? await db
        .select({
          id: accounts.id,
          code: accounts.code,
          name: accounts.name,
          type: accounts.type,
          subtype: accounts.subtype,
          isActive: accounts.isActive,
          isSystem: accounts.isSystem,
        })
        .from(accounts)
        .where(and(eq(accounts.companyId, entry.companyId), inArray(accounts.id, ids)))
    : [];
  const byId = new Map<string, AccountInfo>(rows.map((a) => [a.id, a]));

  lines.forEach((l, i) => {
    if (!l.accountId) {
      push({ rule: 'NO_ACCOUNT', severity: 'BLOCK', lineIndex: i, message: `Line ${i + 1} has no account selected.` });
      return;
    }
    const a = byId.get(l.accountId);
    if (!a) {
      push({ rule: 'UNKNOWN_ACCOUNT', severity: 'BLOCK', lineIndex: i, message: `Line ${i + 1} refers to an account that does not exist in this company.` });
      return;
    }
    if (!a.isActive) {
      push({ rule: 'INACTIVE_ACCOUNT', severity: 'BLOCK', lineIndex: i, message: `“${a.name}” is inactive and cannot be posted to.` });
    }

    // Control accounts must carry a counterparty or the aging reports lie.
    if ((a.subtype === 'ACCOUNTS_RECEIVABLE' || a.subtype === 'ACCOUNTS_PAYABLE') && !l.contactId) {
      push({
        rule: 'CONTROL_ACCOUNT_NEEDS_CONTACT',
        severity: 'WARN',
        lineIndex: i,
        message: `${a.name} is a control account — without a customer or vendor on this line the aging report will not tie back to it.`,
      });
    }

    if (a.name.toLowerCase().includes('retained earnings')) {
      push({
        rule: 'RETAINED_EARNINGS_MANUAL',
        severity: 'WARN',
        lineIndex: i,
        message: 'Posting directly to Retained Earnings is almost always a mistake — use an adjusting entry to the correct profit-or-loss account instead.',
      });
    }

    // Something expensed that reads like a capital item.
    if (a.type === 'EXPENSE' && a.subtype === 'EXPENSE' && l.debitCents >= CAPITALISATION_THRESHOLD_CENTS) {
      const desc = (l.description ?? '').toLowerCase();
      if (/\b(laptop|computer|server|machine|machinery|equipment|furniture|vehicle|hardware|fit-?out|renovation)\b/.test(desc)) {
        push({
          rule: 'POSSIBLE_CAPITALISATION',
          severity: 'WARN',
          lineIndex: i,
          standardRef: company.framework === 'IFRS' ? 'IAS 16.16' : 'ASC 360-10-30-1',
          message: `${(l.debitCents / 100).toFixed(2)} on “${l.description}” reads like a capital item. ${
            company.framework === 'IFRS' ? 'IAS 16.16' : 'ASC 360-10-30-1'
          } requires items meeting the asset definition to be capitalised and depreciated, not expensed.`,
        });
      }
    }

    // Development costs — the sharpest IFRS / US GAAP divergence.
    const desc = (l.description ?? '').toLowerCase();
    if (a.type === 'EXPENSE' && /\b(development|r&d|research and development|product build)\b/.test(desc)) {
      if (company.framework === 'IFRS') {
        push({
          rule: 'DEVELOPMENT_COST_IFRS',
          severity: 'WARN',
          lineIndex: i,
          standardRef: 'IAS 38.57',
          message: 'Under IAS 38.57 development costs must be capitalised once all six criteria are met. Confirm this is research phase (expensed) rather than development phase.',
        });
      }
    }
    if (a.subtype === 'OTHER_ASSET' && /\b(research|r&d)\b/.test(desc) && company.framework === 'US_GAAP') {
      push({
        rule: 'RD_CAPITALISED_US_GAAP',
        severity: 'BLOCK',
        lineIndex: i,
        standardRef: 'ASC 730-10-25-1',
        message: 'ASC 730 requires research and development to be expensed as incurred. Capitalising it is not permitted under US GAAP (the narrow exception is internal-use software under ASC 350-40).',
      });
    }
  });

  // ── Direction sanity ───────────────────────────────────────────────
  const info = (l: CheckableLine) => byId.get(l.accountId);

  if (lines.some((l) => info(l)?.type === 'INCOME' && l.debitCents > 0)) {
    push({
      rule: 'INCOME_DEBITED',
      severity: 'WARN',
      message: 'An income account is being debited, which reduces revenue. Correct for a credit note or refund; wrong for a sale.',
    });
  }
  if (lines.some((l) => info(l)?.type === 'EXPENSE' && l.creditCents > 0)) {
    push({
      rule: 'EXPENSE_CREDITED',
      severity: 'WARN',
      message: 'An expense account is being credited, which reduces the expense. Correct for a supplier refund; wrong for a purchase.',
    });
  }

  const cashLines = lines.filter((l) => ['BANK', 'CREDIT_CARD'].includes(info(l)?.subtype ?? ''));
  if (cashLines.length > 1 && cashLines.some((l) => l.debitCents > 0) && cashLines.some((l) => l.creditCents > 0)) {
    push({ rule: 'CASH_BOTH_SIDES', severity: 'INFO', message: 'This entry moves money between two cash accounts — a transfer. Confirm that is intended.' });
  }

  // ── Period sanity ──────────────────────────────────────────────────
  const now = new Date();
  if (date.getTime() > now.getTime() + 86_400_000) {
    push({ rule: 'FUTURE_DATE', severity: 'WARN', message: 'This entry is dated in the future and will land in a period that has not happened yet.' });
  }
  if (date < new Date(now.getFullYear() - 2, now.getMonth(), now.getDate())) {
    push({ rule: 'VERY_OLD_DATE', severity: 'WARN', message: 'This entry is dated more than two years ago. Check the date before posting.' });
  }

  // ── Duplicate guard against the GL itself ──────────────────────────
  if (totalDebit > 0 && ids.length) {
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const near = await db.execute(sql`
      SELECT je.entry_no, je.date, je.memo
      FROM journal_entries je
      WHERE je.company_id = ${entry.companyId}
        AND je.is_void = false
        AND je.date BETWEEN ${iso(new Date(date.getTime() - 7 * 86_400_000))} AND ${iso(new Date(date.getTime() + 7 * 86_400_000))}
        AND EXISTS (
          SELECT 1 FROM journal_lines jl
          WHERE jl.entry_id = je.id
            AND jl.account_id = ANY(${sql.raw(`ARRAY[${ids.map((i) => `'${i}'`).join(',')}]::text[]`)})
            AND jl.debit_cents = ${Math.round(totalDebit)}
        )
      LIMIT 3
    `);

    for (const n of near.rows as unknown as { entry_no: string; date: string; memo: string | null }[]) {
      push({
        rule: 'POSSIBLE_DUPLICATE',
        severity: 'WARN',
        message: `${n.entry_no} on ${new Date(n.date).toISOString().slice(0, 10)} posts the same amount to the same account${n.memo ? ` (“${n.memo}”)` : ''}. Check this is not a duplicate.`,
      });
    }
  }

  return { findings, postable: !findings.some((f) => f.severity === 'BLOCK') };
}

// ─────────────────────────── Confidence policy ───────────────────────

export type AutofillMode = 'READY' | 'REVIEW' | 'MANUAL';

export interface ConfidencePolicy {
  mode: AutofillMode;
  headline: string;
  detail: string;
  /** True when the human must explicitly confirm before posting. */
  requiresAcknowledgement: boolean;
}

/**
 * How much the assistant is allowed to do, given how much it actually knows.
 *
 * A standard on point is stronger evidence than any amount of history, so a
 * cited rule raises the ceiling. Below the floor the assistant deliberately
 * REFUSES to pre-fill — a tool that guesses when it does not know is what
 * destroys trust.
 */
export function confidencePolicy(
  confidence: number,
  precedents: number,
  opts: { standardCited?: boolean; conflictsWithStandard?: boolean; standardTemplateUsed?: boolean } = {},
): ConfidencePolicy {
  if (opts.conflictsWithStandard) {
    return {
      mode: 'MANUAL',
      headline: 'Past practice conflicts with the standard',
      detail:
        'This company has booked this differently in the past from what the framework requires. The assistant will not choose between them — decide, and the entry will record which basis you applied.',
      requiresAcknowledgement: true,
    };
  }

  if (opts.standardCited && confidence >= 70 && precedents >= 3) {
    return {
      mode: 'READY',
      headline: 'Ready to post',
      detail: `Treatment follows the cited standard and matches ${precedents} comparable entries. Review the basis and post.`,
      requiresAcknowledgement: false,
    };
  }

  if (confidence >= 85 && precedents >= 5) {
    return {
      mode: 'READY',
      headline: 'Ready to post',
      detail: `Booked this way ${precedents} times before. Review the evidence and post.`,
      requiresAcknowledgement: false,
    };
  }

  if (confidence >= 50 && precedents >= 3) {
    return {
      mode: 'REVIEW',
      headline: 'Needs your confirmation',
      detail: `Only ${precedents} comparable entries found. Confirm the accounts before posting.`,
      requiresAcknowledgement: true,
    };
  }

  // No usable history, but a standard is on point. Drafting from the rule is
  // exactly what this tool is for — it just cannot lean on precedent, so the
  // account choice is explicitly the human's to confirm.
  if (opts.standardCited && opts.standardTemplateUsed) {
    return {
      mode: 'REVIEW',
      headline: 'Drafted from the standard, not from your history',
      detail:
        precedents > 0
          ? `Only ${precedents} comparable ${precedents === 1 ? 'entry' : 'entries'} in the ledger, so the accounts come from the cited standard's required treatment. Confirm they are the right accounts in your chart.`
          : 'Nothing comparable in this company’s history, so the accounts come from the cited standard’s required treatment. Confirm they are the right accounts in your chart.',
      requiresAcknowledgement: true,
    };
  }

  return {
    mode: 'MANUAL',
    headline: 'Not enough evidence',
    detail:
      precedents > 0
        ? `Only ${precedents} similar ${precedents === 1 ? 'entry' : 'entries'} in the ledger — not enough to pre-fill with confidence. Candidates are listed; you decide.`
        : opts.standardCited
          ? 'A standard is cited below, but there is nothing comparable in this company’s history and no entry skeleton to work from. Choose the accounts yourself; the assistant will learn from it.'
          : 'Nothing comparable in this company’s history and no standard clearly on point. Choose the accounts yourself; the assistant will learn from it.',
    requiresAcknowledgement: true,
  };
}

export const severityRank: Record<Severity, number> = { BLOCK: 0, WARN: 1, INFO: 2 };

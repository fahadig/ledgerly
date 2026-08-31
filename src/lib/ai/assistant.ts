/**
 * The assistant.
 *
 * Order of authority, and it matters:
 *   1. What the framework REQUIRES  (standards engine — IFRS or US GAAP)
 *   2. Which account IMPLEMENTS it  (this company's chart of accounts)
 *   3. What this company has DONE   (history — a tie-breaker, and a flag when
 *                                    past practice contradicts the standard)
 *
 * The language model's only job is to turn a sentence into a draft that obeys
 * (1)–(3). It never decides treatment on its own, it can only choose from real
 * account ids, and everything it returns is validated and balanced before a
 * human is shown a Post button.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { accounts, assistantLogs, companies, contacts, journalEntries, journalLines } from '@/db/schema';
import type { Framework } from '@/db/schema';
import { parseAmount, type Cents } from '../money';
import { validateLines } from '../ledger';
import { applicableStandards, counterpartStandard, resolveTemplate, type ApplicableStandard } from '../standards/engine';
import { tokenize } from './tokens';
import { extractJson, getProvider, type ChatMessage } from './provider';
import { contactProfile, findPossibleDuplicates, suggestAccounts, type AccountSuggestion } from './patterns';
import { checkEntry, confidencePolicy, type ConfidencePolicy, type RuleFinding } from './rules';

export interface DraftLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  debitCents: Cents;
  creditCents: Cents;
  description: string;
  /** Which standard put this line here, when one did. */
  standardRef?: string | null;
}

export interface DraftEntry {
  date: string;
  memo: string;
  lines: DraftLine[];
  totalDebitCents: Cents;
  totalCreditCents: Cents;
  balanced: boolean;
  confidence: number;
  policy: ConfidencePolicy;
  /** The basis for the treatment, in the assistant's words. */
  rationale: string;
  /** Standards the treatment rests on. */
  standards: ApplicableStandard[];
  /** How the same transaction would be treated under the other framework. */
  divergence: { framework: Framework; reference: string; title: string; treatment: string; divergenceNote: string | null } | null;
  /** Where past practice and the standard disagree. */
  conflicts: string[];
  warnings: string[];
  findings: RuleFinding[];
  suggestions: AccountSuggestion[];
  framework: Framework;
  /** True when the accounts came from the standard's entry skeleton rather than history. */
  templateApplied: boolean;
  source: 'standards' | 'history' | 'hybrid';
  provider: string;
  model: string;
  latencyMs: number;
  logId?: string;
}

const SYSTEM_PROMPT = `You are the drafting engine inside a double-entry accounting system. A qualified human reviews everything you produce before it is posted, so being right matters more than sounding confident.

You will be given, in order of authority:
  A. APPLICABLE STANDARDS — what the company's reporting framework requires.
  B. CHART OF ACCOUNTS — the only account ids that exist.
  C. HISTORY — how this company has booked comparable transactions.

Absolute rules:
1. Follow the APPLICABLE STANDARDS. They outrank history. If history points somewhere the standard does not support, follow the standard and say so in "conflicts".
2. Use ONLY account ids from the CHART OF ACCOUNTS. Never invent an id, code or name.
3. Total debits must exactly equal total credits. Amounts are integers in cents.
4. Every line carries either a debit or a credit — never both, never zero.
5. Cite the standard that drives each line in "standardRef" where one applies.
6. If the text is too vague to book — no amount, no discernible event — return an empty "lines" array and say what is missing in "rationale". Refusing is a correct answer.

Respond with JSON only, exactly this shape:
{
  "date": "YYYY-MM-DD",
  "memo": "short description",
  "lines": [
    {"accountId": "<id from the chart>", "debitCents": 0, "creditCents": 0, "description": "line narrative", "standardRef": "IFRS 15.31 or null"}
  ],
  "confidence": 0,
  "rationale": "one or two sentences a qualified accountant can check",
  "conflicts": ["any place history and the standard disagree"]
}`;

interface LLMDraft {
  date?: string;
  memo?: string;
  lines?: { accountId?: string; debitCents?: number | string; creditCents?: number | string; description?: string; standardRef?: string | null }[];
  confidence?: number;
  rationale?: string;
  conflicts?: string[];
}

const todayISO = () => new Date().toISOString().slice(0, 10);

/** Pull an amount out of free text so we can pre-fill and sanity-check. */
export function extractAmount(text: string): Cents | null {
  const m = text.match(/(?:[$£€₨]|rs\.?|pkr|usd|eur|gbp)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(k|m)?\b/i);
  if (!m) return null;
  let cents = parseAmount(m[1]);
  const suffix = m[2]?.toLowerCase();
  if (suffix === 'k') cents *= 1000;
  if (suffix === 'm') cents *= 1_000_000;
  return cents || null;
}

function inferDirection(text: string): 'MONEY_OUT' | 'MONEY_IN' {
  const t = text.toLowerCase();
  const inWords = /\b(received|receipt|deposit|sold|sale|customer paid|income|revenue|refund from|invoiced)\b/;
  const outWords = /\b(paid|pay|purchase|bought|buy|expense|bill|salary|salaries|rent|subscription|fee|charged)\b/;
  if (inWords.test(t) && !outWords.test(t)) return 'MONEY_IN';
  return 'MONEY_OUT';
}

async function findContact(companyId: string, text: string) {
  const rows = await db
    .select({ id: contacts.id, displayName: contacts.displayName, kind: contacts.kind, relatedCompanyId: contacts.relatedCompanyId })
    .from(contacts)
    .where(and(eq(contacts.companyId, companyId), eq(contacts.isActive, true)));

  const lower = text.toLowerCase();
  // Longest name present in the text wins, so "Acme Logistics" beats "Acme".
  return (
    rows
      .filter((c) => lower.includes(c.displayName.toLowerCase()))
      .sort((a, b) => b.displayName.length - a.displayName.length)[0] ?? null
  );
}

/**
 * Turn a sentence into a reviewable draft entry.
 * Works with no language model at all — the standards engine and history
 * still produce a draft, which is the point of keeping the LLM last.
 */
export async function draftEntryFromText(opts: {
  companyId: string;
  text: string;
  date?: string;
  userId?: string;
}): Promise<DraftEntry> {
  const { companyId, text } = opts;
  const warnings: string[] = [];
  const conflicts: string[] = [];

  const [company] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!company) throw new Error('Company not found.');
  const framework = company.framework;

  // ── 1. What does the framework require? ────────────────────────────
  const standards = await applicableStandards({ companyId, framework, text, limit: 3 });
  const divergence = standards[0] ? await counterpartStandard(standards[0].topic, framework, text) : null;
  const template = standards[0]?.entryTemplate ? await resolveTemplate(companyId, standards[0].entryTemplate) : null;

  // ── 2. Which accounts exist? ───────────────────────────────────────
  const chart = await db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type, subtype: accounts.subtype })
    .from(accounts)
    .where(and(eq(accounts.companyId, companyId), eq(accounts.isActive, true)))
    .orderBy(accounts.code);
  const accountById = new Map(chart.map((a) => [a.id, a]));

  // ── 3. What has this company done before? ──────────────────────────
  const contact = await findContact(companyId, text);
  const direction = inferDirection(text);
  const amount = extractAmount(text);

  // If a standard names the subtypes involved, only consider those accounts.
  const templateSubtypes = standards[0]?.entryTemplate?.map((l) => l.subtype) ?? [];

  const suggestions = await suggestAccounts({
    companyId,
    text,
    contactId: contact?.id ?? null,
    direction,
    amountCents: amount ?? undefined,
    limit: 4,
  });

  // Does past practice sit outside what the standard's template allows?
  if (templateSubtypes.length && suggestions.length) {
    const top = suggestions[0];
    const expenseSideSubtypes = templateSubtypes.filter((s) => s !== 'BANK' && s !== 'ACCOUNTS_PAYABLE' && s !== 'ACCOUNTS_RECEIVABLE');
    if (expenseSideSubtypes.length && !expenseSideSubtypes.includes(top.subtype) && top.timesUsed >= 3) {
      conflicts.push(
        `History books this to ${top.name} (${top.subtype}) ${top.timesUsed}×, but ${standards[0].reference} points to ${expenseSideSubtypes.join(' / ')}. ${standards[0].requirement}`,
      );
    }
  }

  const profile = contact ? await contactProfile(companyId, contact.id) : null;

  // Default settlement account: the bank/card most recently used.
  const [recentCash] = await db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(
      and(
        eq(journalEntries.companyId, companyId),
        eq(journalEntries.isVoid, false),
        sql`${accounts.subtype}::text IN ('BANK','CREDIT_CARD')`,
      ),
    )
    .orderBy(desc(journalEntries.date))
    .limit(1);

  // If the narration names the method, honour it; otherwise fall back to the
  // account this company actually uses most recently.
  const wantsCard = /\b(credit card|card|amex|visa|mastercard)\b/i.test(text);
  const wantsCash = /\b(petty cash|cash)\b/i.test(text);
  const settlementAccount =
    (wantsCard ? chart.find((a) => a.subtype === 'CREDIT_CARD') : null) ??
    (wantsCash ? chart.find((a) => a.subtype === 'BANK' && /cash/i.test(a.name)) : null) ??
    recentCash ??
    chart.find((a) => a.subtype === 'BANK') ??
    null;

  const provider = getProvider();
  const llmAvailable = await provider.available().catch(() => false);

  const finish = async (draft: Omit<DraftEntry, 'findings' | 'policy'>): Promise<DraftEntry> => {
    // Deterministic checks run on every draft, whoever produced it.
    const check = draft.lines.length
      ? await checkEntry({
          companyId,
          date: draft.date,
          memo: draft.memo,
          lines: draft.lines.map((l) => ({
            accountId: l.accountId,
            debitCents: l.debitCents,
            creditCents: l.creditCents,
            description: l.description,
            contactId: contact?.id ?? null,
          })),
        })
      : { findings: [], postable: false };

    const policy = confidencePolicy(draft.confidence, suggestions[0]?.timesUsed ?? 0, {
      standardCited: draft.standards.length > 0,
      conflictsWithStandard: draft.conflicts.length > 0,
      standardTemplateUsed: draft.templateApplied,
    });

    // Duplicate guard against the sub-ledgers.
    if (amount) {
      const dupes = await findPossibleDuplicates({
        companyId,
        kind: direction === 'MONEY_OUT' ? 'EXPENSE' : 'INVOICE',
        contactId: contact?.id ?? null,
        amountCents: amount,
        date: new Date(draft.date),
      });
      for (const d of dupes.slice(0, 2)) draft.warnings.push(`Possible duplicate: ${d.message}`);
    }

    const [log] = await db
      .insert(assistantLogs)
      .values({
        companyId,
        kind: 'suggestion',
        prompt: text,
        response: JSON.stringify({ lines: draft.lines, rationale: draft.rationale }).slice(0, 8000),
        provider: draft.provider,
        model: draft.model,
        confidence: draft.confidence,
        standardRefs: draft.standards.map((s) => s.reference),
        latencyMs: draft.latencyMs,
        userId: opts.userId ?? null,
      })
      .returning({ id: assistantLogs.id })
      .catch(() => [{ id: undefined }] as { id: string | undefined }[]);

    return { ...draft, findings: check.findings, policy, logId: log?.id };
  };

  // ── No model reachable: standards + history still produce a draft ──
  if (!llmAvailable) {
    warnings.push(
      `No language model reachable (${provider.name}). Drafted from the ${framework} rule-set and this company's history — check the accounts and amount before posting.`,
    );
    return finish(
      deterministicDraft({
        text,
        date: opts.date ?? todayISO(),
        amount,
        direction,
        standards,
        divergence,
        conflicts,
        suggestions,
        settlementAccount,
        template,
        intercompany: Boolean(contact?.relatedCompanyId),
        warnings,
        framework,
        provider: provider.name,
        model: provider.model,
      }),
    );
  }

  // ── Model draft, grounded in standards → chart → history ───────────
  const standardsBlock = standards.length
    ? standards
        .map(
          (s) =>
            `[${s.reference}] ${s.title}\n  Requirement: ${s.requirement}\n  Treatment: ${s.treatment}` +
            (s.entryTemplate ? `\n  Skeleton: ${s.entryTemplate.map((t) => `${t.side} ${t.subtype} (${t.note})`).join(' | ')}` : '') +
            (s.policyValue ? `\n  This company's policy: ${s.policyKey} = ${s.policyValue}` : ''),
        )
        .join('\n\n')
    : `(no specific recognition rule matched — this looks like routine bookkeeping under ${framework})`;

  const chartBlock = chart.map((a) => `${a.id} | ${a.code} | ${a.name} | ${a.type}/${a.subtype}`).join('\n');

  const historyBlock = suggestions.length
    ? suggestions
        .map((s) => `- ${s.name} (id ${s.accountId}, code ${s.code}) — used ${s.timesUsed}×, last ${s.lastUsed}, ${s.confidence}% match. ${s.reason}`)
        .join('\n')
    : '(no close historical match)';

  const contextBlock = [
    `Reporting framework: ${framework}`,
    `Functional currency: ${company.functionalCurrency}`,
    `Today: ${opts.date ?? todayISO()}`,
    `Direction inferred from wording: ${direction === 'MONEY_OUT' ? 'money leaving the business' : 'money coming in'}`,
    amount ? `Amount detected: ${(amount / 100).toFixed(2)}` : 'No amount detected in the text.',
    contact ? `Counterparty matched: ${contact.displayName}${contact.relatedCompanyId ? ' (INTERCOMPANY — will be eliminated on consolidation)' : ''}` : 'No known counterparty matched.',
    profile?.cadence ? `This counterparty transacts ${profile.cadence}, median ${(profile.medianAmountCents / 100).toFixed(2)}.` : '',
    settlementAccount ? `Default settlement account: ${settlementAccount.name} (id ${settlementAccount.id})` : '',
    conflicts.length ? `KNOWN CONFLICT: ${conflicts.join(' ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `A. APPLICABLE STANDARDS (${framework}) — highest authority
${standardsBlock}

B. CHART OF ACCOUNTS (id | code | name | type/subtype)
${chartBlock}

C. HISTORY — how this company has booked comparable transactions
${historyBlock}

CONTEXT
${contextBlock}

TRANSACTION TO BOOK
"${text}"

Return the JSON draft now.`,
    },
  ];

  let raw = '';
  let latencyMs = 0;
  try {
    const res = await provider.complete(messages, { json: true, temperature: 0.1, maxTokens: 1200 });
    raw = res.text;
    latencyMs = res.latencyMs;
  } catch (err) {
    warnings.push(`Language model failed (${(err as Error).message}). Fell back to the rule-set and history.`);
    return finish(
      deterministicDraft({
        text, date: opts.date ?? todayISO(), amount, direction, standards, divergence, conflicts,
        suggestions, settlementAccount, template, intercompany: Boolean(contact?.relatedCompanyId), warnings, framework, provider: provider.name, model: provider.model,
      }),
    );
  }

  const parsed = extractJson<LLMDraft>(raw);
  if (!parsed || !Array.isArray(parsed.lines) || parsed.lines.length === 0) {
    warnings.push('The model did not return a usable entry. Showing the rule-based draft instead.');
    return finish(
      deterministicDraft({
        text, date: opts.date ?? todayISO(), amount, direction, standards, divergence, conflicts,
        suggestions, settlementAccount, template, intercompany: Boolean(contact?.relatedCompanyId), warnings, framework, provider: provider.name, model: provider.model,
      }),
    );
  }

  // Validate every line against real accounts. Anything hallucinated is dropped.
  const lines: DraftLine[] = [];
  for (const l of parsed.lines) {
    const acc = l.accountId ? accountById.get(l.accountId) : undefined;
    if (!acc) {
      warnings.push(`Dropped a line referencing an account that does not exist (${l.accountId ?? 'blank'}).`);
      continue;
    }
    const d = Math.round(Number(l.debitCents ?? 0));
    const c = Math.round(Number(l.creditCents ?? 0));
    if (!Number.isFinite(d) || !Number.isFinite(c) || (d === 0 && c === 0) || (d !== 0 && c !== 0) || d < 0 || c < 0) {
      warnings.push(`Dropped a malformed line on ${acc.name}.`);
      continue;
    }
    lines.push({
      accountId: acc.id,
      accountCode: acc.code,
      accountName: acc.name,
      debitCents: d,
      creditCents: c,
      description: l.description || parsed.memo || text.slice(0, 120),
      standardRef: l.standardRef ?? null,
    });
  }

  const totalDebit = lines.reduce((s, l) => s + l.debitCents, 0);
  const totalCredit = lines.reduce((s, l) => s + l.creditCents, 0);
  const balanced = lines.length >= 2 && totalDebit === totalCredit && totalDebit > 0;

  if (!balanced && lines.length) {
    warnings.push(`The drafted entry is out of balance by ${(Math.abs(totalDebit - totalCredit) / 100).toFixed(2)}. Fix it before posting.`);
  }
  if (amount && balanced && totalDebit !== amount) {
    warnings.push(`The text mentions ${(amount / 100).toFixed(2)} but the draft totals ${(totalDebit / 100).toFixed(2)}.`);
  }

  for (const c of parsed.conflicts ?? []) if (c && !conflicts.includes(c)) conflicts.push(c);

  const modelConfidence = Math.max(0, Math.min(100, Math.round(Number(parsed.confidence ?? 0))));
  const historyConfidence = suggestions[0]?.confidence ?? 0;
  const standardsBoost = standards.length ? Math.min(100, standards[0].relevance) : 0;
  const confidence = balanced
    ? Math.round(standardsBoost * 0.45 + historyConfidence * 0.35 + modelConfidence * 0.2)
    : Math.min(35, modelConfidence);

  return finish({
    date: parsed.date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : opts.date ?? todayISO(),
    memo: parsed.memo || text.slice(0, 140),
    lines,
    totalDebitCents: totalDebit,
    totalCreditCents: totalCredit,
    balanced,
    confidence,
    rationale:
      parsed.rationale ||
      (standards[0]
        ? `Treatment follows ${standards[0].reference}: ${standards[0].requirement}`
        : 'Drafted from the chart of accounts and this company’s history.'),
    standards,
    divergence,
    conflicts,
    warnings,
    suggestions,
    framework,
    templateApplied: false,
    source: standards.length ? 'hybrid' : 'history',
    provider: provider.name,
    model: provider.model,
    latencyMs,
  });
}

export type ResolvedTemplate = Awaited<ReturnType<typeof resolveTemplate>>;

const CONTROL_SUBTYPES = new Set(['ACCOUNTS_RECEIVABLE', 'ACCOUNTS_PAYABLE']);

/**
 * Pick the account in the chart that best implements one line of a standard's
 * skeleton. Deterministic in every case:
 *   • intercompany accounts are excluded unless the counterparty is a group company
 *   • for control accounts (A/R, A/P) the designated system account wins
 *   • otherwise the name that best echoes the transaction and the standard wins
 *   • ties break on the lowest account code
 */
function chooseCandidate(
  candidates: { id: string; code: string; name: string; subtype: string; isSystem: boolean; isIntercompany: boolean }[],
  text: string,
  opts: { intercompany?: boolean } = {},
): { id: string; code: string; name: string } | null {
  const pool = candidates.filter((c) => (opts.intercompany ? true : !c.isIntercompany));
  const usable = pool.length ? pool : candidates;
  if (!usable.length) return null;

  const tokens = new Set(tokenize(text));
  const scored = usable
    .map((c) => {
      let score = tokenize(c.name).reduce((s, t) => s + (tokens.has(t) ? 3 : 0), 0);
      if (CONTROL_SUBTYPES.has(c.subtype) && c.isSystem) score += 5;
      if (c.isIntercompany && opts.intercompany) score += 5;
      return { c, score };
    })
    .sort((a, b) => b.score - a.score || a.c.code.localeCompare(b.c.code));

  return scored[0].c;
}

/** A usable draft with no model at all — the standard's skeleton plus history. */
function deterministicDraft(o: {
  text: string;
  date: string;
  amount: Cents | null;
  direction: 'MONEY_OUT' | 'MONEY_IN';
  standards: ApplicableStandard[];
  divergence: DraftEntry['divergence'];
  conflicts: string[];
  suggestions: AccountSuggestion[];
  settlementAccount: { id: string; code: string; name: string } | null;
  template: ResolvedTemplate | null;
  intercompany: boolean;
  warnings: string[];
  framework: Framework;
  provider: string;
  model: string;
}): Omit<DraftEntry, 'findings' | 'policy'> {
  const top = o.suggestions[0];
  const amount = o.amount ?? top?.typicalAmountCents ?? 0;
  const lines: DraftLine[] = [];
  const standardRef = o.standards[0]?.reference ?? null;
  let templateApplied = false;

  // Rules first: when history has nothing useful but a standard supplies a
  // two-sided skeleton, draft from the standard. This is the whole point of
  // encoding the rule-set — the tool should know the treatment even the first
  // time a company meets a transaction.
  const usableTemplate = o.template && o.template.length === 2 ? o.template : null;

  // Use the skeleton when history is silent, and ALSO when history contradicts
  // the standard — repeating a past mistake is the failure mode this whole
  // rule-set exists to prevent.
  const useTemplate = Boolean(usableTemplate && amount > 0 && (!top || o.conflicts.length > 0));

  if (usableTemplate && useTemplate) {
    // Keywords from the cited rule sharpen the account match: "crypto",
    // "digital", "token" steer to Digital Assets rather than the first
    // other-asset account in the chart.
    const hint = `${o.text} ${o.standards[0]?.title ?? ''} ${o.standards[0]?.topic?.replaceAll('_', ' ') ?? ''}`;

    const built = usableTemplate.map((t) => {
      const chosen = chooseCandidate(t.candidates, `${hint} ${t.note}`, { intercompany: o.intercompany });
      return chosen ? { t, chosen } : null;
    });

    if (built.every(Boolean)) {
      templateApplied = true;
      for (const b of built as { t: ResolvedTemplate[number]; chosen: { id: string; code: string; name: string } }[]) {
        // A cash side always means *this company's* operating account (or the
        // card, when the narration says so) — never whichever bank account
        // happens to share a word with the template's note.
        const isCashSide = b.t.subtype === 'BANK' || b.t.subtype === 'CREDIT_CARD';
        // A payable side collapses to the cash side only when the narration
        // says it was settled on the spot.
        const settledNow =
          b.t.subtype === 'ACCOUNTS_PAYABLE' && /\b(paid|pay|card|cash|transfer)\b/i.test(o.text);

        const settle = o.settlementAccount && (isCashSide || settledNow) ? o.settlementAccount : null;

        const account = settle ?? b.chosen;
        lines.push({
          accountId: account.id,
          accountCode: account.code,
          accountName: account.name,
          debitCents: b.t.side === 'DEBIT' ? amount : 0,
          creditCents: b.t.side === 'CREDIT' ? amount : 0,
          description: settle ? `Settled through ${account.name}` : b.t.note,
          standardRef,
        });
      }
    }
  }

  if (!lines.length && top && o.settlementAccount && amount > 0) {
    if (o.direction === 'MONEY_OUT') {
      lines.push(
        { accountId: top.accountId, accountCode: top.code, accountName: top.name, debitCents: amount, creditCents: 0, description: o.text.slice(0, 120), standardRef },
        { accountId: o.settlementAccount.id, accountCode: o.settlementAccount.code, accountName: o.settlementAccount.name, debitCents: 0, creditCents: amount, description: `Paid from ${o.settlementAccount.name}`, standardRef: null },
      );
    } else {
      lines.push(
        { accountId: o.settlementAccount.id, accountCode: o.settlementAccount.code, accountName: o.settlementAccount.name, debitCents: amount, creditCents: 0, description: `Received into ${o.settlementAccount.name}`, standardRef: null },
        { accountId: top.accountId, accountCode: top.code, accountName: top.name, debitCents: 0, creditCents: amount, description: o.text.slice(0, 120), standardRef },
      );
    }
  } else {
    o.warnings.push('Not enough information to draft an entry — no amount, or nothing comparable in the ledger. Fill it in manually.');
  }

  const totalDebit = lines.reduce((s, l) => s + l.debitCents, 0);
  const totalCredit = lines.reduce((s, l) => s + l.creditCents, 0);

  return {
    date: o.date,
    memo: o.text.slice(0, 140),
    lines,
    totalDebitCents: totalDebit,
    totalCreditCents: totalCredit,
    balanced: lines.length >= 2 && totalDebit === totalCredit && totalDebit > 0,
    confidence: top
      ? Math.min(top.confidence, o.standards.length ? 85 : 75)
      : templateApplied
        ? Math.min(70, o.standards[0]?.relevance ?? 60)
        : 0,
    rationale: templateApplied
      ? `${o.standards[0].reference}: ${o.standards[0].requirement} Accounts taken from the required treatment, since this company has no comparable entry to learn from.`
      : o.standards[0]
        ? `${o.standards[0].reference}: ${o.standards[0].requirement} Account chosen from history — ${top ? top.reason : 'no precedent found'}.`
        : top
          ? `Booked to ${top.name} because ${top.reason}.`
          : 'No comparable transaction found and no standard clearly on point.',
    templateApplied,
    standards: o.standards,
    divergence: o.divergence,
    conflicts: o.conflicts,
    warnings: o.warnings,
    suggestions: o.suggestions,
    framework: o.framework,
    source: o.standards.length ? 'standards' : 'history',
    provider: o.provider,
    model: o.model,
    latencyMs: 0,
  };
}

/** Server-side guard used by the post endpoint — never trust the client. */
export function assertPostable(lines: { accountId: string; debitCents: number; creditCents: number }[]) {
  validateLines(lines.map((l) => ({ accountId: l.accountId, debit: l.debitCents, credit: l.creditCents })));
}

/** Record whether the human accepted the draft — the signal that drives the accuracy report. */
export async function recordOutcome(logId: string, opts: { accepted: boolean; correctedByHuman?: boolean; journalEntryId?: string }) {
  await db
    .update(assistantLogs)
    .set({
      accepted: opts.accepted,
      correctedByHuman: opts.correctedByHuman ?? null,
      journalEntryId: opts.journalEntryId ?? null,
    })
    .where(eq(assistantLogs.id, logId));
}

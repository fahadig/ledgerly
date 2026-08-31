/**
 * Standards retrieval.
 *
 * Given a described transaction and the company's framework, find the rules
 * that govern it and resolve their chart-agnostic entry templates onto this
 * company's actual accounts.
 *
 * This runs BEFORE the language model and before any history lookup. The
 * order of authority is: what the standard requires → which account
 * implements it → what this company has done before.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { accountingPolicies, accounts, standards, type Framework, type Standard } from '@/db/schema';
import { tokenize } from '../ai/tokens';

export interface ApplicableStandard {
  reference: string;
  topic: string;
  title: string;
  requirement: string;
  treatment: string;
  divergenceNote: string | null;
  disclosure: string | null;
  policyKey: string | null;
  /** Company's chosen policy where the framework permits a choice. */
  policyValue?: string | null;
  entryTemplate: { side: 'DEBIT' | 'CREDIT'; subtype: string; note: string }[] | null;
  /** 0–100, how strongly the transaction text matches this rule. */
  relevance: number;
  matchedTerms: string[];
}

/** Multi-word keywords are worth more than single tokens — they are specific. */
function scoreKeywords(text: string, keywords: string[]): { score: number; matched: string[] } {
  const lower = ` ${text.toLowerCase()} `;
  const tokens = new Set(tokenize(text));
  let score = 0;
  const matched: string[] = [];

  for (const kw of keywords) {
    const k = kw.toLowerCase();
    if (k.includes(' ')) {
      if (lower.includes(` ${k} `) || lower.includes(k)) {
        score += 6;
        matched.push(kw);
      }
    } else if (tokens.has(k) || lower.includes(` ${k} `)) {
      score += 3;
      matched.push(kw);
    }
  }
  return { score, matched };
}

/**
 * Rules that govern this transaction, most relevant first.
 * Always returns something for a framework — an empty result means the
 * transaction is routine bookkeeping with no special recognition question.
 */
export async function applicableStandards(opts: {
  companyId: string;
  framework: Framework;
  text: string;
  limit?: number;
  minRelevance?: number;
}): Promise<ApplicableStandard[]> {
  const rows = await db
    .select()
    .from(standards)
    .where(and(eq(standards.framework, opts.framework), eq(standards.isActive, true)));

  const policies = await db
    .select()
    .from(accountingPolicies)
    .where(eq(accountingPolicies.companyId, opts.companyId));
  const policyMap = new Map(policies.map((p) => [p.key, p.value]));

  const scored = rows
    .map((s: Standard) => {
      const { score, matched } = scoreKeywords(opts.text, (s.keywords as string[]) ?? []);
      // Title words count a little, so "impairment of the machine" finds the
      // impairment rule even when no keyword is an exact hit.
      const titleHit = scoreKeywords(opts.text, s.title.toLowerCase().split(/\s+/).filter((w) => w.length > 4));
      const total = score + titleHit.score * 0.5;
      return { s, total, matched: Array.from(new Set([...matched, ...titleHit.matched])) };
    })
    .filter((x) => x.total > 0)
    .sort((a, b) => b.total - a.total);

  const max = scored[0]?.total ?? 1;
  const minRelevance = opts.minRelevance ?? 20;

  return scored
    .map(({ s, total, matched }) => ({
      reference: s.reference,
      topic: s.topic as string,
      title: s.title,
      requirement: s.requirement,
      treatment: s.treatment,
      divergenceNote: s.divergenceNote,
      disclosure: s.disclosure,
      policyKey: s.policyKey,
      policyValue: s.policyKey ? policyMap.get(s.policyKey) ?? null : null,
      entryTemplate: s.entryTemplate ?? null,
      relevance: Math.round((100 * total) / max),
      matchedTerms: matched,
    }))
    .filter((x) => x.relevance >= minRelevance)
    .slice(0, opts.limit ?? 4);
}

/**
 * The same rule under the other framework — so a dual-reporting group can see
 * the divergence side by side rather than discovering it at audit.
 */
export async function counterpartStandard(topic: string, framework: Framework, text: string) {
  const other: Framework = framework === 'IFRS' ? 'US_GAAP' : 'IFRS';
  const rows = await db
    .select()
    .from(standards)
    .where(and(eq(standards.framework, other), sql`${standards.topic}::text = ${topic}`, eq(standards.isActive, true)));

  if (!rows.length) return null;
  const best = rows
    .map((s) => ({ s, score: scoreKeywords(text, (s.keywords as string[]) ?? []).score }))
    .sort((a, b) => b.score - a.score)[0];

  return {
    framework: other,
    reference: best.s.reference,
    title: best.s.title,
    treatment: best.s.treatment,
    divergenceNote: best.s.divergenceNote,
  };
}

/**
 * Turn a rule's chart-agnostic template into real account choices for this
 * company. Returns the candidates per template line; the assistant picks
 * among them using history, and the human confirms.
 */
export async function resolveTemplate(
  companyId: string,
  template: { side: 'DEBIT' | 'CREDIT'; subtype: string; note: string }[],
) {
  const subtypes = Array.from(new Set(template.map((t) => t.subtype)));
  const rows = await db
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      subtype: accounts.subtype,
      isSystem: accounts.isSystem,
      isIntercompany: accounts.isIntercompany,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.companyId, companyId),
        eq(accounts.isActive, true),
        sql`${accounts.subtype}::text = ANY(${sql.raw(`ARRAY[${subtypes.map((s) => `'${s}'`).join(',')}]::text[]`)})`,
      ),
    )
    .orderBy(accounts.code);

  return template.map((t) => ({
    ...t,
    candidates: rows.filter((r) => r.subtype === t.subtype),
  }));
}

/** Load the rule-set into the database. Idempotent — safe to re-run. */
export async function syncCatalog(catalog: import('./catalog').StandardRule[]) {
  let inserted = 0;
  let updated = 0;

  for (const rule of catalog) {
    const existing = await db
      .select({ id: standards.id })
      .from(standards)
      .where(and(eq(standards.framework, rule.framework), eq(standards.reference, rule.reference)))
      .limit(1);

    const values = {
      framework: rule.framework,
      reference: rule.reference,
      topic: rule.topic,
      title: rule.title,
      requirement: rule.requirement,
      treatment: rule.treatment,
      entryTemplate: rule.entryTemplate ?? null,
      keywords: rule.keywords,
      policyKey: rule.policyKey ?? null,
      divergenceNote: rule.divergenceNote ?? null,
      disclosure: rule.disclosure ?? null,
      isBuiltIn: true,
      isActive: true,
    };

    if (existing.length) {
      await db.update(standards).set({ ...values, updatedAt: new Date() }).where(eq(standards.id, existing[0].id));
      updated++;
    } else {
      await db.insert(standards).values(values);
      inserted++;
    }
  }

  return { inserted, updated };
}

export async function standardsByTopic(framework: Framework, topics?: string[]) {
  const where = topics?.length
    ? and(eq(standards.framework, framework), inArray(sql`${standards.topic}::text`, topics))
    : eq(standards.framework, framework);
  return db.select().from(standards).where(where).orderBy(standards.topic, standards.reference);
}

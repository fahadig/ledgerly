/**
 * Replay accuracy harness — `npm run test:accuracy [n]`.
 *
 * Takes the most recent N real transactions, hides them (and everything after
 * them) from the assistant, asks it to pick an account from the narration
 * alone, and compares against what was actually booked.
 *
 * This turns "the assistant feels smart" into a number we can defend, and it
 * is the number that should govern the confidence thresholds in
 * src/lib/ai/rules.ts. If accuracy falls, tighten the thresholds — never ship
 * a tool that guesses.
 *
 * The metric that matters is CONFIDENT AND WRONG. Abstaining is not failure;
 * it is the assistant refusing to guess, which is the behaviour we want.
 */

import 'dotenv/config';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { db, pool } from '../src/lib/db';
import { accounts, companies, contacts, journalEntries, journalLines } from '../src/db/schema';
import { suggestAccounts } from '../src/lib/ai/patterns';
import { applicableStandards } from '../src/lib/standards/engine';
import { confidencePolicy } from '../src/lib/ai/rules';

const N = Number(process.argv[2] ?? 60);

async function main() {
  const all = await db.select().from(companies).where(eq(companies.isEliminationEntity, false));
  if (!all.length) throw new Error('No companies. Run `npm run db:seed`.');

  let grandAnswered = 0;
  let grandTotal = 0;
  let grandTop1 = 0;
  let grandConfidentWrong = 0;

  for (const company of all) {
    const lines = await db
      .select({
        accountId: journalLines.accountId,
        accountName: accounts.name,
        description: journalLines.description,
        contactId: journalLines.contactId,
        contactName: contacts.displayName,
        debitCents: journalLines.debitCents,
        date: journalEntries.date,
        memo: journalEntries.memo,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .leftJoin(contacts, eq(contacts.id, journalLines.contactId))
      .where(
        and(
          eq(journalEntries.companyId, company.id),
          eq(journalEntries.isVoid, false),
          inArray(journalEntries.source, ['BILL', 'EXPENSE']),
          gt(journalLines.debitCents, 0),
          eq(accounts.type, 'EXPENSE'),
        ),
      )
      .orderBy(desc(journalEntries.date))
      .limit(N);

    if (!lines.length) continue;

    let top1 = 0;
    let top3 = 0;
    let abstained = 0;
    let confidentAndWrong = 0;
    let standardCitedCount = 0;
    const misses: string[] = [];

    for (const l of lines) {
      // The assistant sees only the narration and counterparty — never the
      // account that was actually chosen.
      const text = [l.description, l.contactName, l.memo].filter(Boolean).join(' ');

      const [suggestions, standards] = await Promise.all([
        suggestAccounts({
          companyId: company.id,
          text,
          contactId: l.contactId,
          direction: 'MONEY_OUT',
          amountCents: l.debitCents,
          limit: 3,
          before: new Date(l.date), // strictly prior history only
        }),
        applicableStandards({ companyId: company.id, framework: company.framework, text, limit: 1 }),
      ]);

      if (standards.length) standardCitedCount++;

      const best = suggestions[0];
      const policy = confidencePolicy(best?.confidence ?? 0, best?.timesUsed ?? 0, {
        standardCited: standards.length > 0,
      });

      if (policy.mode === 'MANUAL') {
        abstained++;
        continue;
      }

      const hit1 = best?.accountId === l.accountId;
      if (hit1) top1++;
      if (suggestions.some((s) => s.accountId === l.accountId)) top3++;

      if (!hit1 && policy.mode === 'READY') {
        confidentAndWrong++;
        misses.push(
          `    ${new Date(l.date).toISOString().slice(0, 10)}  "${l.description}"\n` +
            `        actual: ${l.accountName}\n` +
            `        guess : ${best?.name} (${best?.confidence}%, ${best?.timesUsed} precedents)`,
        );
      }
    }

    const answered = lines.length - abstained;
    const pct = (n: number, den: number) => (den ? ((100 * n) / den).toFixed(1) : '0.0');

    console.log(`\n${company.name}  [${company.framework}]  — last ${lines.length} expense lines`);
    console.log('─'.repeat(58));
    console.log(`  Pre-filled by the assistant    ${String(answered).padStart(4)}  (${pct(answered, lines.length)}%)`);
    console.log(`  Abstained, asked the human     ${String(abstained).padStart(4)}  (${pct(abstained, lines.length)}%)`);
    console.log(`  Top-1 accuracy when answered         ${pct(top1, answered)}%`);
    console.log(`  Top-3 accuracy when answered         ${pct(top3, answered)}%`);
    console.log(`  A standard was on point        ${String(standardCitedCount).padStart(4)}  (${pct(standardCitedCount, lines.length)}%)`);
    console.log(`  CONFIDENT AND WRONG            ${String(confidentAndWrong).padStart(4)}   ← the number that matters`);
    if (misses.length) console.log(`\n  Confident misses:\n${misses.slice(0, 5).join('\n')}`);

    grandTotal += lines.length;
    grandAnswered += answered;
    grandTop1 += top1;
    grandConfidentWrong += confidentAndWrong;
  }

  const pct = (n: number, den: number) => (den ? ((100 * n) / den).toFixed(1) : '0.0');
  console.log(`\n${'═'.repeat(58)}`);
  console.log(`Across all companies: ${grandTotal} lines, ${pct(grandAnswered, grandTotal)}% pre-filled, ${pct(grandTop1, grandAnswered)}% top-1, ${grandConfidentWrong} confident misses.`);
  console.log('Target: top-1 ≥ 80 % when answered, confident-and-wrong ≈ 0.\n');

  if (grandConfidentWrong > Math.ceil(grandAnswered * 0.05)) {
    console.log('✘ Too many confident misses — tighten confidencePolicy() before shipping.\n');
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

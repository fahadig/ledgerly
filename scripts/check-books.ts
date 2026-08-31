/**
 * Integrity check — `npm run check:books`.
 * Fails loudly if anything ever bypassed the posting engine.
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/lib/db';
import { companies } from '../src/db/schema';
import { balanceSheet, trialBalance } from '../src/lib/reports';
import { fmt } from '../src/lib/money';

async function main() {
  const all = await db.select().from(companies);
  if (!all.length) throw new Error('No companies. Run `npm run db:seed`.');

  const asOf = new Date();
  let ok = true;

  const unbalanced = await db.execute(sql`
    SELECT je.entry_no, je.company_id, SUM(jl.debit_cents) AS d, SUM(jl.credit_cents) AS c
    FROM journal_entries je
    JOIN journal_lines jl ON jl.entry_id = je.id
    GROUP BY je.entry_no, je.company_id
    HAVING SUM(jl.debit_cents) <> SUM(jl.credit_cents)
  `);
  const badEntries = unbalanced.rows as unknown as { entry_no: string }[];

  for (const company of all) {
    const tb = await trialBalance(company.id, asOf);
    const bs = await balanceSheet(company.id, asOf, company.fiscalYearStartMonth);
    const cur = company.currency;

    console.log(`\n${company.name}  [${company.framework} · ${company.functionalCurrency}]`);
    console.log('─'.repeat(56));
    console.log(`  Trial balance debits    ${fmt(tb.totalDebit, cur).padStart(16)}`);
    console.log(`  Trial balance credits   ${fmt(tb.totalCredit, cur).padStart(16)}`);
    console.log(`  Out of balance          ${fmt(tb.outOfBalance, cur).padStart(16)}`);
    console.log(`  Total assets            ${fmt(bs.totalAssets, cur).padStart(16)}`);
    console.log(`  Liabilities + equity    ${fmt(bs.totalLiabilitiesAndEquity, cur).padStart(16)}`);
    console.log(`  Balance sheet diff      ${fmt(bs.difference, cur).padStart(16)}`);
    console.log(`  Profit for the year     ${fmt(bs.netIncome, cur).padStart(16)}`);

    if (tb.outOfBalance !== 0 || bs.difference !== 0) ok = false;
  }

  console.log(`\nUnbalanced journal entries across all companies: ${badEntries.length}`);
  if (badEntries.length) ok = false;

  console.log(ok ? '\n✔ Books are sound.\n' : '\n✘ Books are NOT sound.\n');
  if (!ok) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

/** Run a group consolidation from the command line — `npm run consolidate`. */
import 'dotenv/config';
import { db, pool } from '../src/lib/db';
import { groups } from '../src/db/schema';
import { consolidate } from '../src/lib/consolidation';
import { fmt } from '../src/lib/money';

async function main() {
  const [group] = await db.select().from(groups).limit(1);
  if (!group) throw new Error('No group. Run `npm run db:seed`.');

  const result = await consolidate({ groupId: group.id, periodEnd: new Date() });
  const c = result.presentationCurrency;
  const money = (n: number) => fmt(n, c).padStart(16);

  console.log(`\n${result.groupName} — consolidated`);
  console.log(`Period ${result.periodStart.toISOString().slice(0, 10)} → ${result.periodEnd.toISOString().slice(0, 10)}   presented in ${c}`);
  console.log('─'.repeat(64));
  for (const m of result.companies) {
    console.log(`  ${m.isParent ? 'Parent' : 'Sub   '}  ${m.name.padEnd(22)} ${m.framework.padEnd(8)} ${m.currency}  ${(m.ownershipBps / 100).toFixed(0)}%`);
  }

  console.log('\nConsolidated position');
  console.log(`  Assets                  ${money(result.totals.assets)}`);
  console.log(`  Liabilities             ${money(result.totals.liabilities)}`);
  console.log(`  Equity                  ${money(result.totals.equity)}`);
  console.log(`  Out of balance          ${money(result.totals.outOfBalance)}`);

  console.log('\nConsolidated result');
  console.log(`  Income                  ${money(result.totals.income)}`);
  console.log(`  Expenses                ${money(result.totals.expenses)}`);
  console.log(`  Profit                  ${money(result.totals.profit)}`);
  console.log(`    to owners of parent   ${money(result.totals.profitAttributableToParent)}`);
  console.log(`    to NCI                ${money(result.totals.profitAttributableToNCI)}`);
  console.log(`  Translation reserve     ${money(result.totals.translationReserve)}`);

  console.log(`\nEliminations (${result.eliminationEntries.length})`);
  for (const e of result.eliminationEntries) {
    console.log(`  ${e.kind.padEnd(22)} ${fmt(e.amountCents, c).padStart(14)}  ${e.standardRef ?? ''}`);
    console.log(`      ${e.explanation}`);
  }

  if (result.warnings.length) {
    console.log('\nWarnings — these are reported, never plugged:');
    for (const w of result.warnings) console.log(`  • ${w}`);
  }
  console.log();
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

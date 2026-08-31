/** Drop every row and start over — `npm run db:reset`. */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/lib/db';

const TABLES = [
  'onchain_transactions',
  'wallets',
  'asset_prices',
  'eliminations',
  'consolidation_runs',
  'assistant_logs',
  'forecast_snapshots',
  'variance_notes',
  'plan_lines',
  'plans',
  'close_periods',
  'sessions',
  'bank_transactions',
  'expense_lines',
  'expenses',
  'payment_allocations',
  'payments',
  'bill_lines',
  'bills',
  'invoice_lines',
  'invoices',
  'journal_lines',
  'journal_entries',
  'items',
  'tax_rates',
  'contacts',
  'accounting_policies',
  'dimension_values',
  'dimensions',
  'accounts',
  'memberships',
  'companies',
  'groups',
  'users',
  'fx_rates',
  'standards',
];

async function main() {
  await db.execute(sql.raw(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`));
  console.log('✔ All data cleared. Run `npm run db:seed` to rebuild.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

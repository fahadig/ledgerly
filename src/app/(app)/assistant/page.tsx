import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { accounts } from '@/db/schema';
import { getCompany } from '@/lib/company';
import { PageHeader } from '@/components/ui';
import AssistantWorkbench from '@/components/AssistantWorkbench';

export default async function AssistantPage() {
  const company = await getCompany();
  const rows = await db
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
    })
    .from(accounts)
    .where(and(eq(accounts.companyId, company.id), eq(accounts.isActive, true)))
    .orderBy(asc(accounts.code));

  return (
    <>
      <PageHeader
        title="Assistant"
        subtitle={
          <>
            Describe a transaction and the assistant drafts the entry — from the {company.framework === 'US_GAAP' ? 'US GAAP' : 'IFRS'} rule-set
            first, this company&rsquo;s chart of accounts second, and its history third. It proposes; you post. Nothing
            reaches the ledger until you click.
          </>
        }
      />
      <AssistantWorkbench accounts={rows} currency={company.currency} framework={company.framework} />
    </>
  );
}

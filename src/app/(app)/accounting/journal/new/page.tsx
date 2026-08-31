import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { accounts, contacts } from '@/db/schema';
import { getCompany } from '@/lib/company';
import { PageHeader } from '@/components/ui';
import JournalEditor from '@/components/JournalEditor';

export default async function NewJournalEntryPage() {
  const company = await getCompany();

  const [accountRows, contactRows] = await Promise.all([
    db
      .select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type, subtype: accounts.subtype })
      .from(accounts)
      .where(and(eq(accounts.companyId, company.id), eq(accounts.isActive, true)))
      .orderBy(asc(accounts.code)),
    db
      .select({ id: contacts.id, displayName: contacts.displayName })
      .from(contacts)
      .where(and(eq(contacts.companyId, company.id), eq(contacts.isActive, true)))
      .orderBy(asc(contacts.displayName)),
  ]);

  return (
    <>
      <PageHeader
        title="New journal entry"
        subtitle="The same checks run here as on anything the assistant drafts. Debits must equal credits before the Post button turns on."
      />
      <JournalEditor accounts={accountRows} contacts={contactRows} currency={company.currency} />
    </>
  );
}

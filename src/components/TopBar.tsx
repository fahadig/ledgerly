import Link from 'next/link';
import { redirect } from 'next/navigation';
import CompanySwitcher from './CompanySwitcher';
import { getAccess, getGroup, roleLabel } from '@/lib/company';
import { destroySession } from '@/lib/auth';

export default async function TopBar() {
  const { user, company, companies, role } = await getAccess();
  const group = await getGroup();

  async function signOut() {
    'use server';
    await destroySession();
    redirect('/login');
  }

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-white px-6">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-semibold text-ink">{company.name}</h1>
        {company.booksClosedThrough && (
          <span className="badge-neutral">
            Closed through {new Date(company.booksClosedThrough).toISOString().slice(0, 10)}
          </span>
        )}
      </div>

      <div className="flex items-center gap-5">
        <Link href="/assistant" className="btn-primary py-1.5 text-xs">
          Ask the assistant
        </Link>

        <CompanySwitcher
          companies={companies.map((c) => ({
            id: c.id,
            name: c.name,
            framework: c.framework,
            functionalCurrency: c.functionalCurrency,
          }))}
          activeId={company.id}
          groupName={group?.name ?? null}
        />

        <div className="flex items-center gap-2.5 border-l border-line pl-4">
          <div className="text-right leading-tight">
            <div className="text-xs font-semibold text-ink">{user.name}</div>
            <div className="text-xxs text-ink-muted">{roleLabel[role]}</div>
          </div>
          <div
            className="flex h-8 w-8 items-center justify-center rounded-full bg-nav text-xs font-bold text-white"
            title={user.email}
          >
            {user.name.slice(0, 2).toUpperCase()}
          </div>
          <form action={signOut}>
            <button type="submit" className="text-xxs font-semibold text-ink-muted hover:text-brand-dark">
              Sign out
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}

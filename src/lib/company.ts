import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from './db';
import { companies, groups, memberships, type Company, type Role, type User } from '@/db/schema';
import { currentUser } from './auth';

export const ACTIVE_COMPANY_COOKIE = 'ledgerly.company';

const RANK: Record<Role, number> = { VIEWER: 0, BOOKKEEPER: 1, ACCOUNTANT: 2, ADMIN: 3, OWNER: 4 };

/** Everything a page needs to know about who is asking and what they may see. */
export interface Access {
  user: User;
  company: Company;
  role: Role;
  companies: Company[];
}

/**
 * The signed-in user, or a redirect to the login page.
 * Every page and every API route goes through this — company scoping is not
 * something individual pages are trusted to remember.
 */
export const requireUser = cache(async (): Promise<User> => {
  const user = await currentUser();
  if (!user) redirect('/login');
  return user;
});

/** Companies this user may see. Group grants cascade to every member company. */
export const accessibleCompanies = cache(async (userId: string): Promise<Company[]> => {
  const grants = await db
    .select({ companyId: memberships.companyId, groupId: memberships.groupId })
    .from(memberships)
    .where(eq(memberships.userId, userId));

  if (!grants.length) return [];

  const companyIds = grants.map((g) => g.companyId).filter(Boolean) as string[];
  const groupIds = grants.map((g) => g.groupId).filter(Boolean) as string[];

  const clauses = [];
  if (companyIds.length) clauses.push(inArray(companies.id, companyIds));
  if (groupIds.length) clauses.push(inArray(companies.groupId, groupIds));
  if (!clauses.length) return [];

  return db
    .select()
    .from(companies)
    .where(and(eq(companies.isActive, true), eq(companies.isEliminationEntity, false), or(...clauses)))
    // Parent first, so signing in lands you on the top company rather than
    // whichever subsidiary happens to sort first alphabetically.
    .orderBy(sql`${companies.parentCompanyId} ASC NULLS FIRST`, asc(companies.name));
});

/** The user's effective role for a company — the highest grant that applies. */
export const effectiveRole = cache(async (userId: string, companyId: string): Promise<Role | null> => {
  const [company] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!company) return null;

  const rows = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, userId),
        or(
          eq(memberships.companyId, companyId),
          company.groupId ? eq(memberships.groupId, company.groupId) : isNull(memberships.groupId),
        ),
      ),
    );

  if (!rows.length) return null;
  return rows.reduce<Role>((best, r) => (RANK[r.role] > RANK[best] ? r.role : best), 'VIEWER');
});

/**
 * Who is asking, which company they are looking at, and what they may do.
 * The active company comes from a cookie but is always intersected with the
 * user's grants, so switching to a company you cannot see is not possible.
 */
export const getAccess = cache(async (): Promise<Access> => {
  const user = await requireUser();
  const list = await accessibleCompanies(user.id);

  if (!list.length) {
    throw new Error(
      `${user.name} has no company access. An owner or admin needs to grant it before this account can be used.`,
    );
  }

  const jar = await cookies();
  const wanted = jar.get(ACTIVE_COMPANY_COOKIE)?.value;
  const company = list.find((c) => c.id === wanted) ?? list[0];

  const role = (await effectiveRole(user.id, company.id)) ?? 'VIEWER';
  return { user, company, role, companies: list };
});

export const getCompany = cache(async (): Promise<Company> => (await getAccess()).company);
export const getCompanyId = cache(async (): Promise<string> => (await getAccess()).company.id);
export const getCurrentUser = cache(async (): Promise<User> => (await getAccess()).user);
export const listCompanies = cache(async (): Promise<Company[]> => (await getAccess()).companies);

export const getGroup = cache(async () => {
  const company = await getCompany();
  if (!company.groupId) return null;
  const [g] = await db.select().from(groups).where(eq(groups.id, company.groupId)).limit(1);
  return g ?? null;
});

/** Companies in the same group that this user may see. */
export const getGroupCompanies = cache(async (): Promise<Company[]> => {
  const { company, companies: list } = await getAccess();
  if (!company.groupId) return [company];
  return list.filter((c) => c.groupId === company.groupId);
});

export type Action = 'view' | 'enter' | 'post' | 'close' | 'manage';

export function can(role: Role | null, action: Action): boolean {
  if (!role) return false;
  const need: Record<Action, number> = { view: 0, enter: 1, post: 2, close: 2, manage: 3 };
  return RANK[role] >= need[action];
}

/** Throws with a readable message. Used by API routes before they mutate. */
export async function assertCan(action: Action): Promise<Access> {
  const access = await getAccess();
  if (!can(access.role, action)) {
    throw new Error(
      `Your role (${access.role.toLowerCase()}) does not allow you to ${action} in ${access.company.name}.`,
    );
  }
  return access;
}

export const roleLabel: Record<Role, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  ACCOUNTANT: 'Accountant',
  BOOKKEEPER: 'Bookkeeper',
  VIEWER: 'Viewer',
};

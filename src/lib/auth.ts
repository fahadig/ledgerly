/**
 * Authentication.
 *
 * Deliberately dependency-free: scrypt from node:crypto for password hashing,
 * a random 256-bit token in an httpOnly cookie for the session, and the
 * SHA-256 of that token as the primary key of the session row. A stolen
 * database dump therefore contains no replayable session tokens and no
 * reversible passwords.
 *
 * Why this had to be built before real books go in: every journal entry
 * records who posted it. Entries written before authentication existed are
 * stamped "system" and cannot be attributed retroactively — a permanent hole
 * in the audit trail. Attribution has to be right from the first entry.
 */

import { createHash, randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { cookies } from 'next/headers';
import { and, eq, gt, lt } from 'drizzle-orm';
import { db } from './db';
import { sessions, users, type User } from '@/db/schema';

const scrypt = promisify(_scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const SESSION_COOKIE = 'ledgerly.session';
const SESSION_DAYS = 30;
const KEYLEN = 64;

// ─────────────────────────── Passwords ───────────────────────────────

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEYLEN);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;

  const expected = Buffer.from(hashHex, 'hex');
  const derived = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  // Constant-time: never leak how much of the hash matched.
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

/** Basic strength rule. Enforced on set, not merely suggested. */
export function passwordProblem(password: string): string | null {
  if (password.length < 10) return 'Use at least 10 characters.';
  if (!/[a-z]/i.test(password)) return 'Include at least one letter.';
  if (!/[0-9]/.test(password)) return 'Include at least one number.';
  return null;
}

// ─────────────────────────── Sessions ────────────────────────────────

const tokenToId = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createSession(userId: string, userAgent?: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);

  await db.insert(sessions).values({
    id: tokenToId(token),
    userId,
    expiresAt,
    userAgent: userAgent?.slice(0, 300) ?? null,
  });

  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production' && process.env.ALLOW_INSECURE_COOKIES !== 'true',
    maxAge: SESSION_DAYS * 86_400,
  });

  return token;
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db.delete(sessions).where(eq(sessions.id, tokenToId(token))).catch(() => undefined);
  jar.delete(SESSION_COOKIE);
}

/** The signed-in user, or null. Never throws — callers decide what to do. */
export async function currentUser(): Promise<User | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const [row] = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, tokenToId(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);

  if (!row || !row.user.isActive) return null;
  return row.user;
}

/** Remove expired rows. Called opportunistically on login. */
export async function pruneSessions(): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date())).catch(() => undefined);
}

// ─────────────────────────── Login ───────────────────────────────────

export interface LoginResult {
  ok: boolean;
  error?: string;
  userId?: string;
}

export async function attemptLogin(email: string, password: string, userAgent?: string): Promise<LoginResult> {
  const normalised = email.trim().toLowerCase();

  const [user] = await db.select().from(users).where(eq(users.email, normalised)).limit(1);

  // Always run a verification, even with no user, so the response time does
  // not reveal whether an address is registered.
  const ok = await verifyPassword(password, user?.passwordHash ?? 'scrypt$00$00');

  if (!user || !ok || !user.isActive) {
    return { ok: false, error: 'That email and password combination is not recognised.' };
  }

  await createSession(user.id, userAgent);
  await db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, user.id));
  return { ok: true, userId: user.id };
}

export async function setPassword(userId: string, password: string): Promise<void> {
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  await db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, userId));
}

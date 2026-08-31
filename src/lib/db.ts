import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '@/db/schema';

// BIGINT columns arrive from node-postgres as strings by default. Every
// bigint in this schema is a cents amount or a scaled rate, all far inside
// Number.MAX_SAFE_INTEGER, so parse them to numbers once, here.
// 20 = int8 OID.
import pgTypes from 'pg';
pgTypes.types.setTypeParser(20, (v: string) => Number(v));
// 1700 = numeric. Nothing in the schema uses it, but a stray SUM() cast can.
pgTypes.types.setTypeParser(1700, (v: string) => Number(v));

const globalForDb = globalThis as unknown as { pool?: Pool };

/**
 * Serverless (Vercel) runs many short-lived instances, each with its own pool.
 * Ten connections per instance exhausts Postgres long before traffic does, so
 * default to one there and rely on the provider's pooler (Neon/Supabase: use
 * the *pooled* connection string, the one with `-pooler` in the host).
 * A long-lived container (Docker) keeps a real pool.
 */
const SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const DEFAULT_MAX = SERVERLESS ? 1 : 10;

export const pool =
  globalForDb.pool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DB_POOL_MAX ?? DEFAULT_MAX),
    // Managed Postgres terminates idle connections; don't hand out a dead one.
    idleTimeoutMillis: SERVERLESS ? 10_000 : 30_000,
    connectionTimeoutMillis: 10_000,
    ...(process.env.DATABASE_SSL === 'require' ? { ssl: { rejectUnauthorized: false } } : {}),
  });

// Reuse across hot reloads in dev, and across warm invocations in serverless.
if (process.env.NODE_ENV !== 'production' || SERVERLESS) globalForDb.pool = pool;

export const db = drizzle(pool, { schema });
export type DB = typeof db;
export { schema };

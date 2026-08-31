import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://ledgerly:ledgerly@localhost:5433/ledgerly',
  },
  verbose: true,
  strict: false,
} satisfies Config;

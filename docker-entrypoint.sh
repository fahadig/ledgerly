#!/bin/sh
set -e

echo "→ Waiting for PostgreSQL…"
i=0
until node -e "
const {Client}=require('pg');
const c=new Client({connectionString:process.env.DATABASE_URL});
c.connect().then(()=>c.end()).then(()=>process.exit(0)).catch(()=>process.exit(1));
" 2>/dev/null; do
  i=$((i+1))
  if [ "$i" -gt 60 ]; then
    echo "  PostgreSQL did not become available. Check the 'db' container's logs."
    exit 1
  fi
  sleep 2
done
echo "  database reachable"

echo "→ Applying the database schema…"
./node_modules/.bin/drizzle-kit push --force

if [ "${SEED_ON_START:-true}" = "true" ]; then
  echo "→ Loading the IFRS / US GAAP rule-set and demo books…"
  echo "  (idempotent — skipped automatically if books already exist)"
  ./node_modules/.bin/tsx src/db/seed.ts || echo "  seed step skipped — continuing"
fi

echo "→ Ledgerly is starting on port ${PORT:-3000}"
exec "$@"

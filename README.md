# Ledgerly — AI-assisted accounting

Double-entry accounting for a group of companies, with an assistant that reasons from
**IFRS and US GAAP first**, your chart of accounts second, and your transaction history
third. QuickBooks-style interface, self-hosted, runs on one machine with `docker compose up`.

The rule that runs through the whole design:

> **The AI proposes. The ledger validates. A human posts.**

---

## Two deployment targets

There are two ways to run this, and they exist for different reasons. Both are supported and
both must keep working.

| | **Docker (self-hosted)** | **Vercel (shared test)** |
|---|---|---|
| What it's for | The product. What a customer installs. | A URL testers can click. No installs. |
| Database | Postgres in a container | Managed Postgres — Neon or Supabase, **pooled** connection string |
| AI | Local model (Ollama), no network needed | **No local model possible.** `AI_PROVIDER=none`, or a cloud key |
| HTTPS | You must arrange it | Automatic |
| Air-gap / privacy claim | Yes | No — books sit on Vercel and the DB provider |

**The catch worth knowing:** Vercel is serverless, so it cannot run a 4.7GB local model. The
local-first architecture — the thing that makes the books work with no model reachable — can only
be exercised on the Docker target. On Vercel the assistant runs on the deterministic tiers
(standards → chart → history) with `AI_PROVIDER=none`, which still drafts entries and still
cites its basis. It just cannot demonstrate the local-model tier.

## Quick start — Docker

```bash
cp .env.example .env
docker compose up --build
```

Then open **http://localhost:3000** and sign in:

| Email | Role | Sees |
|---|---|---|
| `fahad@zignaly.com` | Owner | Both companies, can do everything |
| `controller@zignaly.example` | Accountant | Both companies, can post and close |
| `bookkeeper@zignaly.example` | Bookkeeper | Parent company only, **cannot post** |

Password for all three: `Ledgerly2026!` (override with `SEED_PASSWORD` before the first run).
Sign in as the bookkeeper to see the access scoping working — the company switcher shows one
company, and the posting API returns 403.

On first start the container applies the schema, loads the IFRS / US GAAP rule-set, and
seeds a two-company demo group with about fourteen months of trading history. The
`ollama-pull` service downloads the local model in the background — the assistant works
without it (see *The assistant* below), so you don't have to wait.

Set `SEED_ON_START=false` in `.env` once you want to start entering your own books.

### Running without Docker

You need Node 20+ and PostgreSQL 14+.

```bash
npm install
# point DATABASE_URL at your database, then:
npm run db:push      # create the schema
npm run db:seed      # rule-set + demo group (optional)
npm run dev          # http://localhost:3000
```

## Quick start — Vercel

Serverless, so the schema and seed cannot run "on start". You run them once from your own
machine against the remote database, then deploy.

**1 — Create a Postgres database.** Neon or Supabase. Copy the **pooled** connection string —
the one with `-pooler` in the hostname. The direct string will exhaust connections under load.

**2 — Load the schema and demo data**, from any machine with Node 20+ (no Docker needed):

```bash
npm install
export DATABASE_URL="postgres://...-pooler.../db?sslmode=require"
npm run setup          # drizzle-kit push + seed
npm run check:books    # prove it landed correctly
```

**3 — Deploy.** Import the repo in Vercel and set these environment variables:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the **pooled** connection string |
| `DATABASE_SSL` | `require` |
| `AI_PROVIDER` | `none` (deterministic tiers only) or `openai` / `anthropic` with a key |
| `SEED_ON_START` | `false` |

`vercel.json` raises the API route timeout to 120s for consolidation and matcher runs.
`src/lib/db.ts` detects `VERCEL` and drops the pool to one connection per instance.

**Do not put a real company's books on this.** The ledger would sit on Vercel's and the database
provider's infrastructure with no data processing agreement in your name. Demo and seed data only,
until that paperwork exists.

### Commands worth knowing

| Command | What it does |
|---|---|
| `npm run check:books` | Proves every company's trial balance nets to zero and the balance sheet balances. Exits non-zero if not. |
| `npm run test:accuracy` | Replays the last 60 real transactions blind and reports the assistant's top-1 accuracy and — the number that matters — how often it was **confident and wrong**. |
| `npm run consolidate` | Runs a group consolidation on the command line. |
| `npm run db:reset` | Clears every table. `npm run db:seed` rebuilds. |
| `npm run db:studio` | Drizzle Studio, for looking at the tables directly. |

---

## How the assistant actually works

"AI accounting" usually means a model guessing an account. That is not what this does.
There are three layers, in a fixed order of authority:

| Priority | Layer | What it decides | Model involved? |
|---|---|---|---|
| 1 | **Standards engine** (`src/lib/standards/`) | The *correct treatment* — recognition, measurement, classification, under the company's framework | No |
| 2 | **Chart of accounts** | *Which account* implements that treatment | No |
| 3 | **History** (`src/lib/ai/patterns.ts`) | Tie-breaker between candidate accounts — and a **flag** when past practice contradicts the standard | No |
| — | **Language model** (`src/lib/ai/provider.ts`) | Turns a sentence into a draft that obeys 1–3. Nothing else. | Yes |

Because layers 1–3 need no model, **the assistant still drafts entries with no LLM installed
at all**. The model makes it better at reading messy language; it is not what makes it correct.

### What stops it being wrong

1. **It cannot invent anything.** The model is handed real account ids and told to pick from
   them. Any line referencing an account that does not exist is dropped before you see it.
2. **The ledger refuses bad entries whatever wrote them.** Debits must equal credits, no line
   can be both sides, no line can be zero, no posting to an inactive account or a closed
   period — enforced in `postJournal()`, which is the only path to the database.
3. **A deterministic checker runs on every draft** (`src/lib/ai/rules.ts`) — human-typed,
   imported or AI-proposed alike. Control accounts need a counterparty; capital items
   described as expenses get challenged; R&D capitalised under US GAAP is *blocked* with the
   ASC 730 citation; duplicates within a 7-day window are surfaced. If a `BLOCK` fires, the
   Post button is disabled and the reason is shown.
4. **Confidence decides how much the assistant is allowed to do:**

   | Evidence | Behaviour |
   |---|---|
   | Standard cited + 3 or more precedents | Fully pre-filled, one click to post |
   | 85 % + and 5 or more precedents | Fully pre-filled, one click to post |
   | Standard cited, no usable history | Pre-filled **from the standard's entry skeleton**, account confirmation required |
   | 50–85 % with 3+ precedents | Pre-filled, confirmation required |
   | History contradicts the standard | **Refuses to choose.** Shows both, you decide, and the entry records which basis you applied |
   | Below the floor | **Refuses to pre-fill.** Lists candidates with counts and says it does not know |

   Those last two rows are the important ones. A tool that guesses when it does not know is
   what destroys trust.
5. **Every draft shows its evidence.** Not "this is correct" but "Freight & Postage, because
   SwiftShip Courier has been booked here 14 of 14 times, most recently 12 Aug" — verifiable
   in two seconds. Corrections are reversals, never deletions, and every AI entry is stored
   with its prompt, model, confidence, cited standards and who approved it.

### Measuring it instead of trusting it

`npm run test:accuracy` hides the most recent transactions from the matcher (including
everything dated after them, so it cannot mark its own homework), asks it to pick an account
from the narration alone, and compares against what was really booked. It reports the share
it pre-filled, the share it abstained on, top-1 and top-3 accuracy, and how often it was
confident and wrong.

Note honestly: on the **seeded demo data** accuracy comes out at 100 %, because generated
history is far more regular than a real company's. Treat that number as a smoke test of the
harness, not as a claim about production. The number to watch on your own books is
*confident-and-wrong*; if it rises, tighten `confidencePolicy()` rather than shipping guesses.

---

## The standards rule-set

`src/lib/standards/catalog.ts` holds ~50 encoded rules across IFRS and US GAAP: revenue,
leases, inventory, PPE, intangibles, impairment, provisions, employee benefits, income tax,
foreign currency, borrowing costs, financial instruments, consolidation, related parties,
government grants and crypto assets. Each rule carries a citation, the requirement in plain
English, the booking treatment, a chart-agnostic entry skeleton, and — where it exists — the
divergence between the two frameworks.

**What this is:** a curated, citable decision aid covering the transaction types a mid-market
group actually meets.

**What this is not:** a reproduction of IFRS or the FASB Codification. Those run to tens of
thousands of copyrighted pages. Nothing here replaces reading the standard or the judgement of
a qualified accountant, and the UI says so wherever a rule is surfaced. The rule-set is stored
as data — your accountants can amend or extend it from the Standards screen without a
developer.

Divergences the engine will show you side by side include:

| Topic | IFRS | US GAAP |
|---|---|---|
| Development costs | IAS 38.57 — capitalise once six criteria are met | ASC 730 — expense R&D as incurred |
| Inventory cost | IAS 2.25 — LIFO prohibited | ASC 330 — LIFO permitted |
| Impairment reversal | IAS 36.114 — required when indicators reverse | ASC 360-10-35-20 — prohibited |
| Leases (lessee) | IFRS 16 — single model | ASC 842 — finance vs operating split |
| PPE measurement | IAS 16.31 — revaluation model available | ASC 360 — cost model only |
| Crypto assets | IAS 38 — cost or revaluation model | ASC 350-60 — fair value through net income |
| Provisions | IAS 37 — "probable" is >50 %, range midpoint | ASC 450 — higher threshold, range low end |

---

## Multi-company, users and consolidation

- **Groups** hold companies in a parent/subsidiary tree with ownership in basis points.
  Each company keeps complete books of its own and may use a different framework and
  functional currency from its parent.
- **Users and memberships** carry roles — `OWNER`, `ADMIN`, `ACCOUNTANT`, `BOOKKEEPER`,
  `VIEWER`. A grant at group level cascades to every company in the group; a grant at company
  level is scoped to that company.
- **Consolidation** (`src/lib/consolidation.ts`) aggregates, translates each foreign operation
  (closing rate for the balance sheet, average for results — IAS 21.39 / ASC 830-30),
  eliminates intercompany balances and intragroup trading, and allocates profit and equity to
  non-controlling interests. Every elimination is listed line by line with its explanation and
  citation.

Two deliberate decisions there:

- Eliminations are **never** written to a subsidiary's own books. They live in a consolidation
  run, so consolidated figures can always be walked back to entity figures.
- **Intercompany mismatches are reported, not plugged.** If A says B owes it 10,000 and B says
  9,400, that 600 is exactly what an accountant needs to see at close. The only balancing
  figure the engine derives is the translation reserve, which genuinely *is* a residual under
  IAS 21.

---

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL connection string |
| `AI_PROVIDER` | `ollama` | `ollama` \| `anthropic` \| `openai` \| `none` |
| `OLLAMA_URL` | `http://ollama:11434` | `http://localhost:11434` outside Docker |
| `OLLAMA_MODEL` | `qwen2.5:7b-instruct` | Better at strict JSON than llama3.1:8b, ~5 GB RAM. Use `qwen2.5:3b-instruct` on a thin machine. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | — | Set `AI_PROVIDER=anthropic` to use |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | — | Set `AI_PROVIDER=openai` to use |
| `SEED_ON_START` | `true` | Idempotent; skips if books already exist |

Moving from local to cloud is a one-variable change: `AI_PROVIDER=anthropic` and no code
moves. That is the point of `src/lib/ai/provider.ts`.

---

## Layout

```
src/
  db/schema.ts            Drizzle schema — groups, companies, users, ledger, standards
  db/seed.ts              Rule-set + two-company demo group with 14 months of trading
  lib/
    money.ts              Integer minor units. No floats touch a balance, ever.
    ledger.ts             postJournal() — the ONLY path to the general ledger
    documents.ts          Invoices, bills, expenses, payments (document + GL in one txn)
    reports.ts            Trial balance, P&L, balance sheet, ageing, dashboard
    consolidation.ts      Aggregate → translate → eliminate → NCI
    company.ts            Active company, group, roles
    standards/catalog.ts  The encoded IFRS / US GAAP rule-set (data, not code)
    standards/engine.ts   Retrieval, entry-skeleton resolution, catalog sync
    ai/patterns.ts        History matcher, counterparty profiles, duplicates, recurrences
    ai/rules.ts           Deterministic entry checker + confidence policy
    ai/assistant.ts       Standards → chart → history → (optional) model
    ai/provider.ts        Swappable LLM provider
    onchain/provider.ts   Transfer sources — CSV and block explorer, one interface
    onchain/reconcile.ts  Import, deterministic matcher, proposal, posting with the hash
  app/                    Next.js App Router pages and API routes
  components/             Sidebar, top bar, assistant workbench, journal editor
scripts/
  check-books.ts          Ledger integrity proof
  replay-accuracy.ts      Blind accuracy replay
  consolidate.ts          CLI consolidation
```

### Conventions

- **Money is integer cents** in a `bigint` column, read as a JS `number` (exact to about
  $90 trillion). Quantities are thousandths; tax rates are basis points.
- **Never `INSERT` into `journal_lines` directly.** Add a document type in `documents.ts` and
  post it through `postJournal()`.
- **Add a rule, not a caveat.** If the assistant can be wrong in a new way, encode it in
  `ai/rules.ts` (a check) or `standards/catalog.ts` (a treatment). Rules are testable;
  prompt wording is not.

---

## Roadmap

| Phase | Goal | Status |
|---|---|---|
| **P0** Foundation — ledger that can't be wrong | Trial balance nets to zero; unbalanced entries rejected at the engine | **Done** |
| **P1** Core books — invoices, bills, expenses, payments, reports | A month can be entered and the three statements tie | **Done** |
| **P2** Standards engine — IFRS/US GAAP rule-set, framework per company | Assistant cites a standard on every suggestion | **Done** |
| **P3** Assistant — rules → chart → history → model, human approval | Nothing posts unapproved; every entry traceable to a rule and a prompt | **Done** |
| **P4** Multi-company & users — groups, roles, isolation | Schema and role model done; **real auth still to do** | Partial |
| **P5** Consolidation — eliminate, NCI, FX translation | Consolidated TB balances; eliminations auditable | **Done** |
| **P4a** Authentication | Sign-in, sessions, roles enforced on every page and API route | **Done** |
| **P6** Banking & close — CSV/OFX import, reconciliation, period lock, tax | Table exists (`bank_transactions`); import UI to build. Period lock enforced in the engine. | Next |
| **P6a** Departments / dimensions | `dimensions` + `dimension_values`, tags on journal lines, department P&L | **Done** |
| **P6b** Transactional multi-currency | Currency and rate on documents and journal lines, realised FX on settlement, period-end retranslation. Rules already encoded (IAS 21.21/23, ASC 830-20-35-1). | Planned |
| **P7** FP&A — budgeting and forecasting | Budgets, budget-vs-actual (horizontal × vertical), period close, forecast roll-forward with stated basis | **v1 done** — scenarios, drivers, headcount planning still to come |
| **P8a** On-chain reconciliation | Wallet register, transfer import, deterministic matcher, posting with the hash on the entry | **v1 done** — cost-basis lots, revaluation and DeFi still to come |
| **P8** Integrations — bank feeds, e-invoicing | Bank feed, reconciliation queue, payment files | Planned |

## Authentication and roles

Real sign-in, built before any real books go in — because every journal entry records who
posted it, and entries written before authentication existed are stamped `system` and
**cannot be attributed retroactively**. That hole in the audit trail is not repairable later,
which is why this came before FP&A.

- Passwords hashed with scrypt (`node:crypto`); no third-party auth dependency.
- Sessions are a random 256-bit token in an httpOnly cookie; the database stores only the
  SHA-256 of that token, so a stolen dump contains nothing replayable.
- Every page hangs off one authenticated layout, so the sign-in check is not something each
  new page has to remember. Every API route checks independently.
- The active company comes from a cookie but is always intersected with the user's grants —
  switching to a company you cannot see is not possible.

| Role | Can |
|---|---|
| `OWNER` | Everything, including company settings |
| `ADMIN` | Manage users and settings, close periods |
| `ACCOUNTANT` | Post, adjust, close periods, run consolidation and roll-forward |
| `BOOKKEEPER` | Enter documents; **cannot post journals or close** |
| `VIEWER` | Read only |

A grant at group level cascades to every company in the group; a grant at company level is
scoped to that company alone.

## Departments and dimensions

Analysis dimensions — departments, cost centres, projects — are tagged onto the journal line
**at the moment the entry is written**. This also had to come before real data: bolt a
dimension on a year later and every historical line is untagged, so the departmental P&L
starts a year late.

The seed creates five departments per company (Engineering, Sales & Marketing, Professional
Services, Operations, Finance & Admin), splits payroll across them, and tags every expense and
revenue line. The P&L takes a `?dept=` filter and shows department chips.

## FP&A — budgeting and forecasting

> **Closing a month should produce next month's forecast, not trigger a separate exercise.**

- **Budgets** (`/planning`) — build one from the trailing twelve months' run-rate, uplifted.
  Every line records that that is what it is; nothing pretends to be considered planning that
  isn't.
- **Budget vs actual** (`/planning/[planId]`) — months read across (horizontal), accounts and
  departments read down (vertical). Green is better than plan, red worse, for income and costs
  alike.
- **Close and roll-forward** (`/planning/close`) — closing a month locks it (the posting engine
  refuses entries into a closed period, not just the UI), snapshots what the plan said at that
  moment — the vintage record — and proposes next month's forecast from, in priority order:
  a figure a human typed (kept, never overwritten) → a recurrence the ledger has detected →
  the trailing trend. Every proposed line states its basis, and nothing is applied until
  someone approves it.

One accounting subtlety the engine gets right and most spreadsheets get wrong: **unpaid bills
falling due next month are not added to the forecast.** Under accrual accounting the cost was
recognised when the bill was posted; counting it again in the month it is paid would
double-count. They are reported as a cash commitment instead, with that reasoning stated on
screen.

Full design spec, including the formula language and the remaining build order, is in
[`docs/fpa-design.md`](docs/fpa-design.md).

## On-chain reconciliation

> **A transaction hash is a settlement reference, exactly like a bank reference.**

Every other product in this category — Bitwave, Cryptio, Cryptoworth, Ledgible, Tres, Gilded — is
a *sub-ledger* that computes crypto activity separately and then syncs journal entries into
someone else's general ledger (QuickBooks, NetSuite, Xero). That means two systems, a mapping
layer between them, and a reconciliation of the reconciliation.

Here there is one ledger. An on-chain transfer lands in the same review queue as a bank line,
posts through the same `postJournal()` engine, is checked by the same rules, and carries its
chain and hash on the journal entry itself — so an auditor walks from a reported figure to a
block without leaving the books.

**What is built:**

- **Wallet register** (`wallets`) — self-custody, exchange, custodian or contract. Registering a
  wallet is what makes a transfer *ours*.
- **Import** — a CSV of transfers, or an Etherscan-compatible indexer behind the same interface
  (`ONCHAIN_EXPLORER_URL` / `_KEY`). The CSV path needs no network, which matters: a finance team
  must be able to close the books when an indexer is down.
- **Idempotency** — every transfer is keyed `chain:hash:logIndex`. Re-importing the same file
  inserts nothing.
- **A deterministic matcher**, no model, answering three questions in order:
  1. Is the counterparty one of our own wallets? → an internal movement, not income
  2. Does the memo name an open invoice? → settle it, and say whether the amount agrees
  3. Is the counterparty address registered to a customer or vendor? → their usual treatment
  If none resolve, it says so rather than guessing.
- **Network fees as their own expense**, never netted off the transfer — the same principle as a
  payment processor's fee.
- **Exact amounts.** Token amounts are stored as decimal strings in base units with their
  decimals, and valued in BigInt end to end. A 256-bit transfer does not lose its last digits on
  the way to the ledger.
- **The measurement basis is stated**, because this is where the frameworks genuinely part
  company:

  | | IFRS | US GAAP |
  |---|---|---|
  | Digital assets | IAS 38 — intangible at cost. Gains **not** in profit or loss | ASC 350-60 — fair value through net income |

  The same token is carried at two different amounts in a dual-framework group, and the
  consolidation has to know which. The on-chain screen shows the basis and its citation.

**Not yet:** cost-basis lots and realised gain/loss on disposal (the accounts exist), period-end
revaluation, and DeFi position tracking — wrapped tokens, LP positions, staking rewards.

### Where this is heading: an advanced QuickBooks, then a light ERP

The intent is explicit: with FP&A, multi-department, multi-user and multi-currency in place,
this stops being "accounting software" and becomes the operating system for the group's
finances — QuickBooks' interface with the things QuickBooks makes you leave the product for.

Honest status on the three "multi-" pillars, because two of them are further along than the
third:

| Pillar | Status | What's actually missing |
|---|---|---|
| **Multi-company / group** | Done | — |
| **Multi-user** | **Done** — sign-in, sessions, roles, per-user company scoping, real user stamped on every entry | Password reset and user-management screens (users are created by the seed today). |
| **Multi-department** | **Done** — dimensions, tagging on journal lines, departmental P&L, departmental budgets | More dimensions than Department (project, fund) work in the schema but have no UI yet. |
| **Multi-currency** | Partially done — and the part that's missing is the harder part | See below. |

Multi-currency is really three separate features and it is worth not conflating them:

1. **Presentation currency** — translating a group into one reporting currency. **Done**
   (`fx_rates`, closing vs average rate, translation reserve, IAS 21.39 / ASC 830-30).
2. **Functional currency per entity** — each company keeps its own books in its own currency.
   **Done** (`companies.functional_currency`).
3. **Transactional currency** — a EUR invoice inside a USD-functional company. **Not done.**
   This needs a currency and rate on every document and journal line, the functional-currency
   amount stored alongside the transaction amount, realised FX gain or loss when a receipt
   settles at a different rate, and period-end retranslation of monetary balances for the
   unrealised movement. The accounting rules for it are already encoded (IAS 21.21, IAS 21.23,
   ASC 830-20-35-1) — the schema work is what remains.

Point 3 is the one that surprises people, so it is called out here rather than buried: the
group consolidation translates correctly today, but a single company cannot yet invoice a
customer in a currency other than its own.

### On P7 (FP&A), for when we get there

The design goal is that closing a month *produces* next month's forecast rather than
triggering a separate exercise. That means: budget versions per company and per group;
driver-based lines (headcount, volume, rate) as well as account lines; commitments already
in the system (open POs, recurring vendor patterns the ledger has already detected, lease
schedules) feeding the forward view automatically; and a rolling re-forecast at close that
carries variance explanations forward. The recurring-pattern detector on the dashboard today
is the first piece of that machinery — it already knows what is going to recur and roughly
how much for.

Full design spec — schema, formula language, the close → forecast loop, build order — is in
[`docs/fpa-design.md`](docs/fpa-design.md). It borrows model patterns from
[cfo.ai](https://cfo.ai/) and Runway (now folded into cfo.ai): human-readable formulas,
scenarios as overlays rather than copies, `last close` usable inside a formula, headcount as a
first-class object, vendor-level variance, lineage on every figure.

One structural advantage over both of those, worth protecting in every design decision: they
are read-only integrations into someone else's accounting system and must sync actuals.
**We are the ledger.** The forecast reads the same `journal_lines` the statements are built
from — no sync, no mapping layer, no drift between "actuals in accounting" and "actuals in
planning."

---

## Licence

Private. Anthropic-generated scaffolding; the accounting logic and rule-set are yours to
extend.

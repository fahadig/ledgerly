# P7 — FP&A: budgeting and forecasting

Design spec. Not built yet; this is the plan so that when we build it we build the right thing.

## The goal, in one sentence

**Closing a month should produce next month's forecast, not trigger a separate exercise.**

Today, in most companies, the annual budget is built in a spreadsheet in November, is stale by
March, and next year the same work is done again from scratch. What we want instead: at each
month-end close, the forecast rolls forward automatically from actuals, detected recurrences
and committed spend — and the finance person's job becomes *reviewing and explaining the
difference*, not rebuilding the model.

## Reference products, and what we take from them

Fahad pointed at [cfo.ai](https://cfo.ai/) and [runway.cfo.ai](https://runway.cfo.ai/) —
`runway.cfo.ai` now redirects to `cfo.ai`, so Runway looks to have been folded into it. Their
public product pages describe a model worth borrowing from. What is worth taking:

| Pattern | Where it comes from | Why we want it |
|---|---|---|
| **Human-readable formulas** that a colleague can read and maintain | Runway | A plan nobody but its author can read is a spreadsheet with extra steps |
| **Scenarios as overlays, not copies** — "tweak assumptions without duplicating the model" | Runway | Duplicating a model is how you get five models that disagree |
| **Tagged dimensions** — department, category, headcount — reused across plans | Runway | Vertical slicing (the "vertical" in Fahad's brief) |
| **`Last close` usable inside a formula** | Runway | This is the exact mechanism that makes "forecast at close" work |
| **One-click close that folds actuals in and updates projections** | Runway | The core of the brief |
| **Headcount as a first-class object** — role, start date, total comp, plan variance | Runway | Payroll is the largest line in most of these businesses and behaves nothing like a GL account |
| **Vendor-level variance detection**, not just account-level | Runway | "Cloud spend is over plan" is useful; "expenses are over plan" is not |
| **Lineage on every figure** | cfo.ai | Same principle as our standards rule-set: every number must be walkable back to its source |
| **Proactive variance flagging** in units that matter ("1.1 pts of gross margin over plan") | cfo.ai | Turns a report into a prompt to act |
| **Scenario questions in plain language** ("what if we hire 30 salespeople") | cfo.ai | Our assistant already does natural language → structured proposal; this is the same machinery pointed at a plan |

### The one structural advantage we have over both

Both products are **read-only integrations into someone else's accounting system**. cfo.ai says
so explicitly: "it never writes back to your systems." They must sync actuals, reconcile
mappings, and live with whatever the source ledger gives them.

**We are the ledger.** Our forecast sits on the same `journal_lines` the statements are built
from. There is no sync, no mapping layer, no drift between "actuals in the accounting system"
and "actuals in the planning tool" — because there is only one set of actuals. Every design
decision below should protect that advantage rather than reintroduce a copy.

## Horizontal and vertical

Fahad's brief: *"works both horizontally and vertically."*

- **Vertical** = down the structure of the business at a point in time: account → statement
  caption; and department / cost centre / project / entity. This needs a real dimension model,
  which the ledger does not have yet (we have company, account and contact).
- **Horizontal** = across time: period over period, year over year, rolling 12 and 18 months,
  budget vs actual vs re-forecast for the same month, and the *vintage* view — what we thought
  March would be, in January, in February, and what it turned out to be.

The vintage view is the one that builds trust in a forecast, and almost nothing has it. It
comes free if we snapshot the forecast at every close.

## Schema additions

```
dimensions              id, company_id, name ("Department", "Project"), is_required
dimension_values        id, dimension_id, code, name, parent_id
  → journal_lines gains dimension_value_ids jsonb  (tagging actuals; nullable, so nothing breaks)

plans                   id, company_id | group_id, name, fiscal_year, status
                        (DRAFT | APPROVED | ARCHIVED), currency, approved_by, approved_at
plan_lines              id, plan_id, account_id, dimension_value_ids, period (month),
                        amount_cents, formula, formula_source (MANUAL | DRIVER | RECURRENCE |
                        COMMITMENT | TREND), owner_user_id, note
scenarios               id, plan_id, name, parent_scenario_id, is_base
scenario_overrides      id, scenario_id, plan_line_id | driver_id, period, amount_cents |
                        formula
                        ← overlays, NOT copies. A scenario stores only what it changes.

drivers                 id, company_id, key ("headcount_eng", "arr", "seats"), name, unit,
                        formula, note
driver_values           id, driver_id, period, amount, source (PLAN | ACTUAL)

headcount_plan          id, company_id, role, department_dimension_value_id, start_date,
                        end_date, annual_comp_cents, on_cost_bps, status (PLANNED | OFFER |
                        FILLED | BACKFILL), person_name
commitments             id, company_id, kind (OPEN_BILL | LEASE | SUBSCRIPTION | PO |
                        RECURRENCE), source_id, account_id, dimension_value_ids,
                        period_start, period_end, amount_cents, confidence_bps, note

close_periods           id, company_id, period, status (OPEN | CLOSED), closed_by, closed_at
forecast_snapshots      id, company_id | group_id, plan_id, scenario_id, taken_at,
                        as_of_period, payload jsonb
                        ← the vintage view. Taken automatically at every close.
variance_notes          id, company_id, period, account_id, dimension_value_ids,
                        amount_cents, cause, owner_user_id, carry_forward boolean
```

Note `close_periods` supersedes the single `companies.books_closed_through` column we have now
— we need per-period status, not a watermark, once a close does work beyond locking.

## The formula language

Same philosophy as `standards/catalog.ts`: **data, not code**, readable by an accountant,
auditable afterwards. A small, deliberately boring expression language:

```
actual(6000, -1)                     last month's Salaries & Wages, actual
lastClose(6000)                      most recently closed month, actual
avg(actual(5010, -3..-1))            3-month average of hosting cost
plan(6010, 0)                        this month's plan for Office Rent
driver("headcount_eng") * 8500_00    driver × rate
recurrence(vendor: "Skyline Properties")   what the ledger says recurs, and for how much
commitments(6010, 0)                 committed spend already in the system for this period
growth(actual(4000, -12..-1), 0.03)  trailing 12 months grown 3 %
```

Rules:
- No arbitrary code. A fixed function set, parsed and evaluated server-side.
- Every evaluated figure returns its **lineage** — which journal lines, commitments or driver
  values produced it. This is what makes "lineage on every figure" real rather than a slogan.
- Circular references rejected at save time, not at evaluation time.

## The close → forecast loop

This is the heart of the feature. When a period is closed:

1. **Lock the period.** `close_periods` row → `CLOSED`. The posting engine already refuses to
   post into a closed period; that check moves from the watermark column to this table.
2. **Snapshot the forecast** into `forecast_snapshots` — this becomes the vintage record and
   the basis of "what did we think, and when."
3. **Compute variance** at account *and* vendor *and* dimension level. Rank by absolute and by
   materiality (share of the caption, points of gross margin — cfo.ai's framing is right:
   express the variance in a unit a manager acts on).
4. **Ask for explanations only where they matter.** A threshold, not every line. Explanations
   land in `variance_notes` with an owner. Notes flagged `carry_forward` roll into the next
   period's assumptions rather than being retyped.
5. **Roll the forecast forward one month**, re-deriving each forward line from, in priority
   order:
   1. an explicit manual override (never overwritten silently)
   2. a driver formula
   3. a **commitment** already in the system — open payables, lease schedules, subscriptions
   4. a **detected recurrence** — the pattern detector we already ship
   5. a trend from actuals
6. **Show the diff, don't apply it silently.** The re-forecast is proposed as a reviewable
   change set — the same "propose, human approves" contract as the accounting assistant. A
   forecast that changes itself without telling anyone is worse than a stale one.

Step 6 is the rule that keeps this consistent with the rest of the product: **the AI proposes,
the ledger validates, a human posts.** A forecast is not a posting, but the discipline is the
same.

## What already exists that this builds on

| Already shipped | How FP&A uses it |
|---|---|
| `recurringPatterns()` — cadence, median amount, expected next date, days overdue | Directly becomes `recurrence()` in the formula language and a `RECURRENCE` source for forward lines |
| Open payables and bill due dates | The first and easiest `commitments` source |
| `accountMovements(companyId, {from, to})` | The actuals engine for every `actual()` call — already correct and period-scoped |
| Period lock in `postJournal()` | Step 1 of the close loop |
| Consolidation engine | Group-level planning: consolidate plans the same way we consolidate actuals, eliminating intercompany plan lines |
| Assistant provider abstraction | "What if we hire 6 engineers in Q3" → structured scenario overrides, reviewed before applying |

## Build order

| Step | Deliverable | Why this order |
|---|---|---|
| 1 | `dimensions` + `dimension_values` + tagging on journal lines; department view on P&L | Vertical slicing is a prerequisite for everything else, and it improves reports on its own |
| 2 | `plans` + `plan_lines`, manual entry, budget-vs-actual report | Smallest thing that is useful. A finance person can enter a budget and see variance. |
| 3 | Formula engine + `drivers`, with lineage | Turns a budget into a model |
| 4 | `commitments` from open payables and the recurrence detector | Where the "don't redo the exercise" promise starts paying |
| 5 | `close_periods` + the close → forecast loop + `forecast_snapshots` | The core of the brief |
| 6 | `scenarios` as overlays + comparison view | Now that a base model exists and is trusted |
| 7 | `headcount_plan` | Largest and least GL-like line; deserves its own object |
| 8 | Natural-language scenario questions through the assistant | Last, because it is only as good as steps 1–7 |

Steps 1 and 2 alone are worth shipping. Do not build the formula engine before someone has
entered a real budget and looked at a real variance report.

## Things to get right, and things to refuse

**Get right**
- Actuals are never copied. Every `actual()` reads the ledger.
- Manual overrides are sacred. The roll-forward proposes; it never silently overwrites a number
  a human typed.
- Every figure carries lineage.
- Variance is expressed in a unit a manager acts on, not just in currency.

**Refuse**
- A free-form spreadsheet formula language. It becomes unauditable within a quarter.
- Copy-on-write scenarios. Overlays or nothing.
- Letting the model write to the ledger. Plans are plans; the GL is the GL. Accruals and
  provisions are journal entries with a standard behind them, and go through `postJournal()`
  like everything else.
- Forecast lines with no stated basis. If we cannot say where a number came from, we do not
  show it.

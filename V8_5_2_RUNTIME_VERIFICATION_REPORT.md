# Newtrition V8.5.2 — Runtime Verification & Repair Report

**Date:** 2026-08-17
**Method:** The application was actually executed. PostgreSQL 16 was installed, the
database was built from scratch (1,966 food items), the Express server was started, and
the full clinical workflow was driven through the real HTTP API by an automated harness.

**Result:** 26 PASS / 15 FAIL initially → **68 PASS / 0 FAIL**, with zero HTTP 500 responses.

---

## 1. Why static review was not enough

The V8.5.1 package passed `node --check` on every file, passed its own smoke test, and
was documented as verified. It was nonetheless **unable to save a meal plan, release a
plan to a client, serve the client portal, or return a single food substitute.**

Every defect below lived inside a SQL string or a database object. No syntax checker,
linter, or static review can see them. They only appear when the process runs against a
real database.

> The lesson from the V8→V11 history document — that dead code is invisible without
> runtime testing — applies equally to schema drift. Code and schema drifted apart, and
> only execution revealed it.

---

## 2. Defects found at runtime

Every item was reproduced as a live HTTP failure and re-tested after the fix.

### 2.1 Substitution engine did not exist — `42883`

`server.js` calls `find_substitutes($1,$2)`. The only function ever created was
`find_substitutes_v31()`. **Every click on the "بديل" button returned HTTP 500.**

The substitution engine is a headline feature of the product. It had never worked
through the API.

### 2.2 Saving a plan was impossible — `42703`

`INSERT INTO plan (..., notes, ...)` — the `notes` column exists in no migration.
**The primary clinician workflow, "حفظ الخطة كمسودة", failed on every attempt.**

### 2.3 Releasing a plan was impossible — `42703`

The release transaction sets `plan.superseded_by` to retire the previous plan. That
column exists in no migration. **No plan could ever reach a client.**

### 2.4 The entire client portal was non-functional — `42P01`

Four database objects referenced by the code were never created:

| Object | Type | Endpoints it breaks |
|---|---|---|
| `daily_log` | table | `GET/POST /api/client/logs`, `GET /api/clients/:id/logs` |
| `meal_checkin` | table | `POST /api/client/checkin`, `GET /api/client/checkins` |
| `v_client_visible_plan` | view | `GET /api/client/plan`, check-in ownership guard |
| `v_adherence` | view | `GET /api/clients/:id/logs` |

`client.html` is shipped as an installable PWA. Every data call it makes returned 500.

### 2.5 Client accounts could not be created — `42703`

`client_account.must_change_password` is referenced in six places in `server.js` and
exists in no migration. Both account creation and client login failed.

### 2.6 Suggestions failed on the default path — `42P18`

In `/api/suggest`, when no role filter was supplied the `$2` placeholder was removed
from the SQL but still passed in the parameter array. PostgreSQL cannot infer a type for
an unreferenced parameter.

**Suggestions worked only when a food-role filter was selected** — never on the default
path the UI uses.

### 2.7 The plan lifecycle was broken by a column that does not exist — `42703`

The `evidence` table is keyed on `food_item_id` and has no `id` column, but the quality
evaluator ordered by `ev.id DESC`. Because `evaluateSavedPlan()` runs on **save, submit,
approve and release**, this single tie-breaker broke the entire lifecycle.

### 2.8 Clinical safety: the quality gate inspected only one item per meal

**This is the most serious defect in the package.**

In `evaluateSavedPlan()`:

```js
d.items[it.slot] = row;     // overwrite
```

Since V8.5.1 a meal slot holds several items. Assigning instead of appending meant the
quality gate received **only the last item in each slot**. Any item earlier in the same
meal was never validated.

Consequence: a breakfast of *[verified eggs, a food with missing protein data]* could be
scored `PASS` with `blockers: []`, be approved, and be **released to a client**.

This was proven by reverting the fix and re-running the regression test:

```
### With the OLD (last-item-only) behaviour restored ###
  FAIL  INCOMPLETE item FIRST in a meal is still caught
        blockers=[] status=PASS          <-- released to a client
```

The V8.5.1 multi-item meal fix was applied to the UI and the persistence layer, but
never propagated to the clinical quality gate.

### 2.9 Malformed input returned 500 with driver error codes

`limit=-1` → `2201W`; `/api/clients/notanumber` → `22P02`; `height_cm:"abc"` → `22P02`.
Client mistakes were reported as server faults, leaking PostgreSQL error codes.

### 2.10 `/index.html` returned 404

Only `/` was routed. A browser refresh or bookmark on `/index.html` broke the app.

### 2.11 All 4xx responses were logged as server errors

`wrap()` called `console.error` for every rejection, so genuine 500s would be buried in
production log noise.

---

## 3. Repairs

### `database/migrate_v8_5_2_runtime_repair.sql` (new)

- `plan.notes`, `plan.superseded_by` (+ partial index on the active released plan)
- `client_account.must_change_password`
- `daily_log` table, with the `(client_id, log_date)` unique constraint the upsert needs
- `meal_checkin` table, cascading from `plan_item`
- `v_client_visible_plan` — released **and** approved **and** not superseded
- `v_adherence` — per-day eaten/logged/adherence aggregation
- `find_substitutes()` as a thin delegating wrapper over `find_substitutes_v31()`, so
  there remains exactly one implementation of the scoring logic

Registered in **both** `migrate.js` and `database/setup.sh`. Verified idempotent
(second run: `applied=0 skipped=22`).

### `server.js`

- `/api/suggest` parameter list rebuilt to match the SQL actually emitted
- `evidence` ordering no longer references a nonexistent column
- **Quality gate now receives every item in a slot, not just the last**
- Central `app.param` validation for `:id` / `:constraintId` → 404, never 500
- `optionalNumber()` validation for client numeric fields → 400 with a named error
- `limit` / `offset` clamped before reaching SQL
- `/index.html` routed
- `wrap()` logs 5xx as errors and 4xx as warnings

### `weekly-quality-gate.js`

- `summarizeDays()` normalises each slot to a list and validates **every** item
- Backward compatible with the legacy single-object slot shape
- An empty slot array now correctly counts as a missing slot

### Tests

- `test_v8_5_2_safety.js` (new) — 8 assertions covering the multi-item safety defect,
  backward compatibility, and false-blocking. **Verified to fail against the old code.**
- `test_v8_5_smoke.js` — extended with structural guards: migration-runner parity
  between `migrate.js` and `setup.sh`, package/lock version parity, and direct
  regression guards against defects 2.7 and 2.8.
- `e2e.js` (new) — 68-assertion HTTP workflow harness.

---

## 4. Verification performed

| Check | Result |
|---|---|
| Clean DB build via `migrate.js` (22 migrations) | PASS |
| Clean DB build via `database/setup.sh` (22 migrations) | PASS — identical schema |
| Migration idempotency (second run) | PASS — `applied=0 skipped=22` |
| Schema drift audit (code refs vs live DB) | PASS — 0 missing relations/functions/columns |
| Full clinical workflow E2E, 68 assertions | **68 PASS / 0 FAIL** |
| Plan lifecycle DRAFT → IN_REVIEW → APPROVED → RELEASED | PASS (quality score 77.8) |
| Multi-item meal round-trip, fractional quantity `0.5` | PASS |
| Allergen safety: egg-allergic client receives no egg suggestions | PASS |
| Auth guards on protected routes when logged out | PASS |
| Source-code leak checks (`/server.js`, `/database/schema.sql`, …) | PASS — all 404 |
| Malformed input never returns 500 | PASS |
| Unexpected 500s in server log across the full run | **0** |
| `npm run check`, `npm test` | PASS |

---

## 5. Not claimed

- **No production certification.** This was one Linux container with a local PostgreSQL
  16 instance. Browser rendering, mobile layout, PWA install, concurrent multi-user
  behaviour, and Railway/Docker deployment were not exercised.
- **No browser-level UI testing.** The API contracts the UI depends on were verified
  (`full.serving.kcal`, `{substitutes:[]}`, `r.version`, the `/api/clients/:id/plans`
  save-draft shape), but `index.html` was not driven through a real browser.
- **The optimizer's mathematical quality was not assessed** — only that it does not fail.

---

## 6. Data gap — action needed before real clinical use

This is a data problem, not a code problem, and it blocks safe use with real clients:

```
total_foods:            1966
allergen_verified:         0
allergen_unknown:       1966
foods_with_portions:       0
foods_with_ingredients:    0
foods_with_diet_tags:      0
```

**Not one food item has verified allergen data.** The allergen eligibility layer is
working correctly — it is conservative with unknown data — but it is filtering against
an empty verification set. `populate-allergens.js` and `populate-portions.js` must be
run, and their output reviewed, before the platform is used with real clients.

Portion data is likewise empty, which matters because Egyptian household measures
(رغيف، كوب، ملعقة) are core to the product's positioning.

---

## 7. Recommended next priority

1. **Populate and verify allergen data** — the single largest clinical safety gap.
2. **Populate portion data** — required for practical meal prescription.
3. Run this E2E harness in CI on every change, so schema drift cannot recur silently.
4. Only then continue with the V11 workflow consolidation described in the
   V8→V11 history document.

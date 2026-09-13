# Newtrition V8.5.2 — Changes

Runtime-verified repair release. All defects below were reproduced as live HTTP
failures against a real PostgreSQL 16 instance and re-tested after fixing.
See `V8_5_2_RUNTIME_VERIFICATION_REPORT.md` for full detail and evidence.

## Fixed — features that did not work at all in V8.5.1

- **Substitution engine**: server called `find_substitutes()`; only
  `find_substitutes_v31()` existed. Every substitute request returned 500.
- **Save plan as draft**: `plan.notes` column did not exist.
- **Release plan to client**: `plan.superseded_by` column did not exist.
- **Client portal (entire)**: `daily_log`, `meal_checkin`, `v_client_visible_plan`
  and `v_adherence` did not exist.
- **Client account creation**: `client_account.must_change_password` did not exist.
- **Slot suggestions**: unreferenced `$2` parameter made the default (no role
  filter) path fail with 42P18.
- **Plan lifecycle**: `ORDER BY ev.id` on a table with no `id` column broke
  `evaluateSavedPlan()`, which runs on save, submit, approve and release.

## Fixed — clinical safety

- **The quality gate only inspected the last item in each meal slot.** Since
  V8.5.1 a slot holds several items; the evaluator overwrote instead of
  appending. An INCOMPLETE or low-evidence food earlier in the same meal was
  never validated and could be approved and released to a client.
  Covered by `test_v8_5_2_safety.js`, verified to fail against the old code.

## Fixed — robustness

- Malformed ids, negative `limit`, and non-numeric client fields returned 500
  with PostgreSQL error codes. Now 400/404 with named errors.
- `/index.html` returned 404; only `/` was routed.
- `wrap()` logged 4xx client rejections as server errors.

## Added

- `database/migrate_v8_5_2_runtime_repair.sql`, registered in **both**
  `migrate.js` and `database/setup.sh` (22 migrations, idempotent).
- `test_v8_5_2_safety.js` — 8 clinical-safety regression assertions.
- `e2e.js` — 68-assertion HTTP workflow harness.
- `test_v8_5_smoke.js` extended with migration-runner parity, version/lock
  parity, and direct guards against the two most serious regressions.

## Known data gap (not a code defect)

0 of 1,966 foods have verified allergen data; portion and ingredient data are
empty. `populate-allergens.js` and `populate-portions.js` must be run and
reviewed before real clinical use.

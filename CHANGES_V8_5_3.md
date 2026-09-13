# Newtrition V8.5.3 — Changes

Follows V8.5.2 (runtime repair). This release fixes two workflow defects reported
after V8.5.2 was deployed: registering a client landed on an empty allergy page
instead of anything computed, and the food catalog page gave no way to build a
diet. Both were reproduced, root-caused, fixed, and covered by new tests.

## Fixed — client registration landed on the wrong page with nothing computed

**Root cause:** `openNewClient()` was a bare `prompt()` for a name only. It then
navigated to "مساحة العميلة" (workspace), whose first and only prominent card is
the allergy/constraint list — there was no target calculation anywhere in that
view. Nothing was ever computed because age, height, and weight were never
collected at intake.

A second, identical-looking `openNewClient()` was also defined later in the same
file. It silently overrode the first — a change to the first definition would
have had no effect at runtime. This is now guarded against in the smoke test.

**Also found while fixing this:** the `client` table had no column for weight,
activity level, or protein target at all. Reopening an *existing* client could
not restore her real weight — the plan builder's form silently fell back to a
hardcoded default (80 kg) with no indication that it was not her real weight.

**Fix:**
- New client intake is now a proper form (age, gender, height, weight, activity
  level, goal, protein g/kg), not a single prompt.
- On save, the client is created with full data and the app navigates straight
  to "مخطط الخطة" (plan builder) with her BMR/TDEE/macro targets already
  calculated and visible — not the constraints page.
- `database/migrate_v8_5_3_client_profile.sql` adds `weight_kg`,
  `activity_level`, and `protein_g_per_kg` to `client`, plus a
  `computed_targets` / `computed_at` snapshot so reopening any client — new or
  years old — shows her last real numbers immediately.
- The client workspace now leads with a computed-targets summary card, above
  the constraints card, for every client (not just new ones).
- The duplicate stale `openNewClient()` was removed.

## Fixed — the food catalog page had no visible way to build a plan

**Root cause:** the "+ للخطة" (add to plan) button existed and worked, but
required a client to already be selected and targets already calculated in the
separate "مخطط الخطة" tab. If that hadn't happened, clicking it produced a bare
`alert()` with no path forward from the search page itself.

**Fix:** the catalog/search page now has its own "العميلة النشطة" (active
client) bar: pick a client there, her targets are calculated automatically, and
"+ للخطة" adds directly to her plan without leaving the page. If nothing is
selected yet, the button scrolls to and focuses that selector instead of a
dead-end alert.

## API changes

- `GET /api/clients` and `GET /api/clients/:id` now return `weight_kg`,
  `activity_level`, `protein_g_per_kg`, `computed_targets`, `computed_at`.
- `POST /api/clients` accepts `weight_kg`, `activity_level`, `protein_g_per_kg`.
- New `POST /api/clients/:id/profile` — partial update of any client field.
- New `POST /api/clients/:id/targets` — saves a calcTargets() snapshot for
  display without requiring a plan to exist yet.

## Migration

`database/migrate_v8_5_3_client_profile.sql`, registered in both `migrate.js`
and `database/setup.sh` (23 migrations total). Verified idempotent and
identical between both runners on a clean build.

## Verification performed

| Check | Result |
|---|---|
| Clean DB build via `migrate.js` (23 migrations) | PASS |
| Clean DB build via `database/setup.sh` (23 migrations) | PASS — identical schema |
| Migration idempotency (second run) | PASS — `applied=0 skipped=23` |
| Full clinical workflow E2E, 74 assertions | **74 PASS / 0 FAIL** |
| New client → weight/activity/protein persisted, targets snapshot round-trips | PASS |
| Client created with name only → `weight_kg` is `null`, not a silent default | PASS |
| Quality-gate multi-item safety regression suite | 8 PASS / 0 FAIL |
| `npm run check`, `npm test` | PASS |
| Unexpected 500s in server log across the full run | **0** |

## Not claimed

Same scope limits as V8.5.2: no browser-level UI testing, no production
deployment, no concurrent multi-user testing. The new intake form and search
client-bar were verified through their API contracts and by reading the
rendered HTML/JS, not by driving an actual browser.

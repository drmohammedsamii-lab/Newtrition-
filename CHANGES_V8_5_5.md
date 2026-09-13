# Newtrition V8.5.5 — Changes

Merges the content-library integration from a second uploaded candidate
(`..._CONTENT_INTEGRATED.zip`) into the runtime-verified V8.5.4 base.

## What was verified before merging

The uploaded candidate's `server.js` was diffed against the previously-analyzed
candidate: the only change was five new static routes serving a `/content`
folder. Everything else — the 21-migration schema, the `find_substitutes`
bug, the `evidence.id` bug, the quality-gate overwrite bug, the bare-`prompt()`
client intake — was identical and still broken, exactly as catalogued in
`COMPARISON_REPORT_V8_5_4.md`. None of that was merged.

The four content files themselves were byte-compared against the original
project source files and are **identical, not rewritten**:

- `content/recipes.html` == `كتاب-الوصفات-Dr-Sami_3.html`
- `content/exercise.html` == `دليل_التمارين.html`
- `content/exchange.html` == `قائمة-البدائل-Dr-Sami__1_.html`
- `content/faq.html` == `03FAQ.html`

The candidate was run against a real database; all five routes returned 200
with real content before anything was merged.

## Added

- `content/` — recipes, exercise guide, exchange list, FAQ, and a hub page,
  copied from the verified candidate.
- Five routes in `server.js`: `/resources`, `/content/recipes.html`,
  `/content/exercise.html`, `/content/exchange.html`, `/content/faq.html`.
  Registered **before** the auth middleware, matching the other static pages
  — this is educational content, not clinical data, so it doesn't require a
  session.
- A "📚 مكتبة الموارد" link in the clinician nav (`index.html`), matching the
  candidate.
- The same link added to `client.html` (the client portal) — the candidate
  only wired this into the clinician view; the content is arguably more
  useful to the client herself, so it was added here too.

## Known gap, not fixed

The project's own vision describes the client journey as **Welcome → Road
Map → FAQ → Nutrition Plan → Exchange List → Recipes**. `04-INSTRUCTIONS.html`
(47KB, present in the project files) corresponds to the "Welcome / Road Map"
step and was not wired into `/resources` by either candidate or by this
merge. Flagging it rather than silently completing it, since it wasn't
requested.

## Verified

- `node --check` on `server.js` and the inline JS in both `index.html` and
  `client.html`.
- All five content routes: 200, unauthenticated, real content (length +
  keyword check), confirmed with a clean database and a live server.
- Smoke test extended to assert the content routes exist and are registered
  before the auth middleware (a regression here would silently make them
  require login).
- Full E2E suite: **79 PASS / 0 FAIL** (74 from V8.5.3/4 + 5 new content
  checks).
- Clinical-safety regression suite: **8 PASS / 0 FAIL**.
- Clean rebuild via `migrate.js`, idempotent.
- `npm run check`: PASS.
- Zero HTTP 500s in the server log across the full verification run.

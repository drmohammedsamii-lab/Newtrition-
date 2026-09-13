# Newtrition V8.6.0 — Changes

Consolidated release: everything from V8.5.1 through V8.5.6, plus four new
defects found and fixed via real browser testing (Playwright) this session,
plus a missing UI feature, plus a new static-analysis test class. Full
narrative in `V8_6_0_FINAL_COMPREHENSIVE_REPORT.md`.

## Why browser testing found what API testing couldn't

Every prior fix was verified via direct HTTP calls (curl / fetch in E2E
scripts). That proves the server is correct but cannot catch front-end-only
defects — a button wired to the wrong handler, or JS expecting a different
response shape than the server actually sends. Three new Playwright suites
now drive a real Chromium browser through the full product:
`tests/browser_full_workflow.js` (31 checks), `tests/browser_plan_lifecycle.js`
(5 checks), `tests/browser_client_journey.js` (8 checks).

## Fixed

- **`api()` read the wrong error field.** The client read `.message`; the
  server returns `.error`. Every failure anywhere in the app displayed the
  useless string "request_failed". Now reads the real field, translated via
  a 15+ entry Arabic error dictionary (`ERROR_AR`).
- **Quality-gate rejection was unexplained.** `submitPlan()` now shows exactly
  which items blocked the plan and why, via a new `explainBlockers()`
  helper, and the server's `/plans/:id/submit` returns the blockers with the
  409 response. The slot picker also ranks well-evidenced candidates first
  and marks weak ones with ⚠, so the problem is visible before it blocks
  submission, not after.
- **The client portal's login button did nothing.** `id="login"` collided
  with `const login = async () => {...}`; `login.onclick = login` bound the
  click handler to the function, not the button, so the button was inert
  since the file was written. Renamed to `doLogin`, wired via
  `addEventListener`. Could not be caught by any API-level test — only a
  real click in a real browser exposes it.
- **A released plan silently failed to display in the client portal.** The
  server returns `{plan, days, items}` as three sibling fields; the renderer
  expected `day.items` nested inside each day. Every render threw and was
  swallowed by a generic catch, showing "no plan published" even when one
  existed and was released — indistinguishable from the correct empty state,
  which is what made it dangerous. Fixed to group items by `plan_day_id`.
  Also added error handling to `loadFups()` for the same robustness.

## Added

- **Client portal account creation UI.** The backend endpoint
  (`POST /api/clients/:id/account`) existed with no way to reach it from the
  interface — the entire client portal was functionally unreachable for a
  real client. Added a full card in the workspace: email input, create
  button, one-time temporary-password display (it's never stored in
  plaintext and never shown again), and existing-account status.
- **`test_frontend_audit.js`** — static analyzer for `index.html` and
  `client.html` catching: duplicate function declarations, `onclick`
  handlers calling undefined functions, JS referencing nonexistent element
  ids, and id/local-variable name collisions (the exact class of bug that
  broke the login button). Verified against the historically-broken V8.5.1
  files to confirm it actually detects real bugs, not just passes trivially.
- **`GET /api/clients/:id`** now also returns `portal_email` and
  `portal_must_change_password` via a left join, so the workspace can show
  whether a client already has a portal account without a second request.

## Verification

| Suite | Result |
|---|---|
| API E2E (`e2e.js`) | 79 PASS / 0 FAIL |
| Clinical-safety regression (`test_v8_5_2_safety.js`) | 8 PASS / 0 FAIL |
| Static frontend audit (`test_frontend_audit.js`) | Clean |
| Browser: full workflow | 31 PASS / 0 FAIL |
| Browser: plan lifecycle (DRAFT→IN_REVIEW→APPROVED→RELEASED) | 5 PASS / 0 FAIL |
| Browser: client journey (clinician→release→account→client login→sees plan) | 8 PASS / 0 FAIL |
| **Total** | **131 PASS / 0 FAIL** |
| Server 500s across every run | 0 |
| Clean-database migration, idempotent | `applied=23 skipped=0` on rerun |
| `npm run check` | PASS |

## Not tested (stated plainly)

Production deployment (Railway/Docker/reverse proxy), concurrent multi-user
load, and clinical judgment quality of recommendations (a nutritionist's
review, not an automated check). The known data gap — 0/1966 foods with
verified allergen data, empty portion data — is unchanged and remains the
top priority documented in prior sessions.

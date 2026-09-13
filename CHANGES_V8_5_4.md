# Newtrition V8.5.4 — Changes

Merges genuine security hardening found in a separately-uploaded release
candidate into the runtime-verified V8.5.3 base. See
`COMPARISON_REPORT_V8_5_4.md` for the full analysis of that candidate,
including the runtime failures reproduced when it was actually executed
against a real database.

## Added — merged from the uploaded candidate, verified independently

- **Security headers:** `X-DNS-Prefetch-Control`, `Permissions-Policy`, and
  conditional `Strict-Transport-Security` (HSTS) when the request is over
  HTTPS.
- **`isSecureRequest()` helper** in `auth.js` and `client-auth.js`: the
  session cookie's `Secure` flag previously depended only on
  `NODE_ENV==='production'`. Behind a reverse proxy that terminates TLS
  (Railway, nginx, etc.), a misconfigured `NODE_ENV` could send the session
  cookie without `Secure` over an actually-HTTPS connection. The helper also
  checks `x-forwarded-proto`.
- **Authorization guard on `GET /api/review-queue`:** every other
  review-queue endpoint already required `owner`/`clinician`; the GET was
  missing the same guard, so any authenticated account — including the
  `assistant` role, which exists in the schema — could read it.

## Verified

- `node --check` on all changed files.
- Security headers confirmed present in a live response.
- `/api/review-queue` confirmed 401 unauthenticated, 403 for a
  non-owner/clinician session (via `requireRole`'s existing behavior).
- Full 74-assertion E2E suite: **74 PASS / 0 FAIL**.
- Clinical-safety regression suite: **8 PASS / 0 FAIL**.
- Clean rebuild via `migrate.js`, idempotent (`applied=0 skipped=23`).
- `npm run check`: PASS.
- Zero HTTP 500s in the server log across the full verification run.

## Not merged from the candidate

- Its `test_authorization_regression.js` requires a deployed environment
  (`NT_BASE_URL` and live credentials) and was never actually executed by
  its own authors — it is a reasonable test *design*, not a verified result.
  It was not merged as-is; running it against this build is a natural next
  step if useful.
- Its 21-migration schema, its `weekly-quality-gate.js` (single-item-only,
  fails on the multi-item shape this app actually produces), and its
  `openNewClient()` (bare `prompt()`, no anthropometric intake) were not
  merged — they are regressions relative to V8.5.2/V8.5.3, not improvements.

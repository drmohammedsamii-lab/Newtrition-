# Newtrition V8.5.1 — Runtime & UX Repair Report

## Scope
This repair intentionally targets V8.5.1 only. V12 is not modified.

## User-visible problems found
1. The main navigation had no Plan Builder tab even though `view-plan` existed.
2. The Plan Builder explicitly declared itself unavailable for clinical planning.
3. The Plan Builder referenced `cClient`, but the element did not exist; dashboard loading therefore threw a browser `ReferenceError` after fetching clients.
4. The search page could only search the catalog and offer substitutions; it had no direct "add to plan" action.
5. Search did not expose entity type (FOOD / PRODUCT / MEAL / RECIPE / INGREDIENT).
6. The plan builder had no save-draft action wired to the existing plan persistence API.
7. The server served `/client` from a non-existent `public/` directory while the actual files were at repository root.
8. PWA manifest/service-worker paths were therefore inconsistent with the archive layout.
9. `package.json` claimed V8.5.0 while V8.5.1 migration/documentation existed.
10. `database/setup.sh` omitted `migrate_v8_5_1_allergen_source_ref.sql` and incorrectly reported 20 migrations.
11. `migrate.js` could silently skip a partial food seed whenever any food rows existed.
12. `npm test` and `npm check` referenced test/client files not included in the archive.
13. Duplicate `approvePlan` browser function existed; the second definition silently overwrote the first.

## Repairs
- Added a visible **مخطط الخطة** navigation tab.
- Re-enabled the clinical Plan Builder and removed the "old experimental" blocker.
- Added saved-client selector `cClient`.
- Connected client selection to the clinical suggestion API.
- Added **+ للخطة** directly from catalog search results.
- Added entity-type filtering.
- Added `food_role` API filtering so the existing role filter is functional.
- Added **حفظ الخطة كمسودة** using the existing `/api/clients/:id/plans` persistence contract.
- Added explicit safe routes for `/`, `/client`, `/client.html`, `/client-manifest.json`, and `/client-sw.js` without exposing the repository directory.
- Unified package version to **8.5.1** and synchronized `package-lock.json`.
- Updated database setup to include the V8.5.1 allergen migration and report 21 migrations.
- Hardened seed migration: partial seed counts now fail loudly instead of being silently skipped.
- Replaced broken external test references with a self-contained V8.5.1 smoke test.
- Removed duplicate `approvePlan` definition.

## Verification
- Package JSON: PASS
- Package-lock version parity: PASS
- Node syntax: PASS for project JS modules
- Inline browser JavaScript syntax: PASS
- V8.5.1 smoke test: PASS
- Migration order contains V8.5.1 allergen migration: PASS

## Not falsely claimed
A real PostgreSQL server and installed npm dependencies are not available in this execution environment, so live database migrations, browser E2E against a running server, and production deployment were not marked PASS.

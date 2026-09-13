# Newtrition V8.5.6 — Changes

Reproduces and fixes the exact session the person described, using real
browser automation (Playwright) against the precise V8.5.3_FIXED package
they downloaded — not just API calls, actual clicks in a rendered page.

## Root cause found: one real bug explains most of the symptoms

**`cClient`'s selection was wiped every time the dashboard tab reloaded.**

`loadDashboard()` rebuilds the `<select id="cClient">` options from scratch
every time "لوحة المتابعة" is opened — which happens automatically on login,
and which a clinician naturally clicks right after registering a client to
see the new client's card. Rebuilding the options resets the selection to
blank, even though the in-memory `wsClientId` still pointed at the right
client.

Reproduced exactly:
```
[after registration]        cClient.value = 1
[after visiting dashboard]  cClient.value =        <- wiped
[click "تحميل بيانات العميلة"]  ALERT: "اختاري عميلة محفوظة أولاً"
```

This one bug plausibly explains three of the five reported symptoms:
- "تحميل بيانات العميلة متحملتش" — confirmed, exact reproduction above.
- "قاعدة الأصناف مش شغالة" — the search itself works, but adding a result to
  the plan requires a selected client; with the selection silently cleared,
  the add action fails without an obvious reason.
- The general sense that context kept disappearing between tabs.

## Fixed

- `loadDashboard()` now preserves `cClient`'s selection the same way it
  already preserved `sqClient`'s — this asymmetry was the actual defect.
- Opening the plan tab now double-checks `cClient.value` against the
  in-memory `wsClientId` and silently restores it if they've drifted apart,
  as a second safety net independent of the first fix.
- `openWorkspace()` (the "فتح" button on a dashboard client card) now also
  sets `cClient`, so opening an existing client from the dashboard keeps the
  plan builder in sync too.

## Not a bug — clarified for the two remaining symptoms

**"مساعد الـ AI مش شغال، المفروض يفهم من غير ما اوضحله"**
The AI box requires a typed request; it cannot infer one from nothing — this
is inherent to how it works, not a defect. It was also a real UX gap though:
clicking "افهم الطلب" with the box empty did nothing at all, silently. Fixed:
it now shows a clear message telling the person to type a request first, and
the card has an explanatory line under its title.

**"مراجعة البيانات... لقيت العميلة متسجلش"**
"مراجعة البيانات" (Data Review) is entirely about food-catalog data-quality
issues (auto-corrected items, allergen conflicts needing sign-off) — it has
no client list and was never meant to show clients. The client's data was
never at risk: confirmed via direct API calls and a full browser session that
the client persists correctly and still appears on the dashboard afterward.
This is a naming/navigation misunderstanding, not data loss. No code change;
documented here so it's clear rather than silently assumed.

## Verification

- Reproduced the exact reported failure with Playwright driving a real
  Chromium browser against the unmodified V8.5.3_FIXED package (proof, not
  guesswork).
- Re-ran the same script against the fixed build: selection now survives a
  dashboard visit, the load-client button works with zero clicks needed to
  "fix" anything, and the AI box gives a clear message on empty input.
- Full 79-assertion E2E suite: **79 PASS / 0 FAIL**.
- Clinical-safety regression suite: **8 PASS / 0 FAIL**.
- Zero HTTP 500s in the server log across the full run.

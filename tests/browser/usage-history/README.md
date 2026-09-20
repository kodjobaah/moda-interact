# Usage history browser fixture

Run `npx vite --config tests/browser/usage-history/vite.config.ts` and open
`http://127.0.0.1:4179/app/usage?fixture=ACTIVE`.

This fixture renders production MerchantNavigation and UsageEvents with synthetic
loader data and local Shopify link stand-ins. Destination routes are placeholders;
it does not prove authenticated App Bridge, PostgreSQL execution, or live billing.
Production loader bounds, tenant predicates, cursor encoding and access denial are
covered by the focused unit suites.

Verified 2026-09-20 using the in-app browser:

- All eight experience states: ACTIVE has the six required ordered destinations;
  NO_CONTRACT/FROZEN/BILLING_ATTENTION retain Overview, Recoveries, Billing, Support;
  ONBOARDING has Home and Support; SUPPORT_ONLY/REINSTALLING only Support;
  SIGNED_OUT has none. Support preserves unread count 3.
- Current/past usage links; period selector has 25 entries and next-page navigation.
- Usage Next shows 11–20 of 22 and preserves billId, view, cursor and embed context.
- Unknown billId displays explicit unavailable text with no usage table.
- Recovery source link reaches the owned-recovery destination with embed parameters;
  unresolved sources are unlinked. Billing breadcrumb targets Billing options.
- Desktop 1024px and mobile 320/390px: no document horizontal overflow; the table
  scrolls inside its own container. Screenshots are in evidence/.

Final focused validation: 104 tests passed across six suites, including navigation,
usage-route, home-route, merchant i18n and billing-period compatibility. Production
build passed. Typecheck reports 78 pre-existing diagnostics in 20 unchanged files;
lint reports 20 errors and 2 warnings in unchanged files. No task-owned diagnostics.

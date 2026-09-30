# Recovery overview local browser fixture

Run with the workspace Node runtime:

```sh
npx vite --config tests/browser/recovery-overview/vite.config.ts
```

Open `http://127.0.0.1:4179/app?fixture=ACTIVE`. The scenario toolbar controls synthetic, local-only data. The production overview, onboarding, billing notices, pending component, and recovery list are rendered directly. No fixture data is imported by production code. Billing/detail destination placeholders verify link destinations only; production authentication, tenant validation, and legacy redirect ordering are covered by `home-route.test.ts`. This fixture does not claim live Shopify, database, or App Bridge validation. Shopify custom elements are displayed as simple blocks without the authenticated Shopify shell.

## Agent-executed evidence — 20 September 2026

- ACTIVE: cohort counts 10 / 3 / 30%, ongoing 2; GBP 25.10 and EUR 40.20 remain separate; one missing value excluded. Exactly five preview rows, including unknown-value and RTL-customer rows.
- ONBOARDING: original plan selection/onboarding surface; no performance overview.
- NO_CONTRACT: recovery history visible, preserved-balance restriction, plan catalogue and selection; no manage-capacity action.
- FROZEN: recovery history visible, Shopify billing restriction and manage-capacity link; pending unavailable.
- BILLING_ATTENTION: existing subscription-confirmed setup notice, readable recovery history, no premature plan-selection or manage action.
- EMPTY: zero counts, em dash rate/value, empty range message. Empty pending queue separately explained, without a health claim.
- UNAVAILABLE: capacity says Unavailable, without invented zero balances or a claim of failed subscription mapping; historical metrics/rows remain visible.
- ERROR: performance-section error and Refresh; current capacity remains visible.
- LOADING: structural placeholders and busy performance section; no stale historical metrics displayed.
- Custom date form submitted 5–12 September; resulting URL, View all list and direct basket-1 detail link retained dates plus shop, host, embedded context.
- Legacy billing toolbar entry landed at `/app/usage?bill=past&billId=fixture-period&shop=fixture.myshopify.com`. Server tests separately verify authorized/owned, foreign, malformed and onboarding cases.
- Layout: document scroll widths 1009 at viewport 1024, 305 at viewport 320, and 375 at viewport 390 (scrollbar excluded). No horizontal overflow. French and RTL at 390 also measured 375. RTL uses Arabic locale formatting/direction with the supported English fallback catalogue; this is not an Arabic translation claim.
- Screenshots inspected: [desktop](evidence/desktop-1024.png), [320px mobile](evidence/mobile-320.png), [RTL](evidence/rtl-390.png), [French](evidence/french-390.png).

The current billing capacity DTO exposes paid-period end but no promotional expiry timestamp. The overview preserves the known paid period end and explicitly labels promotional expiry unavailable; it does not infer an expiry or sum balances from distinct sources.

## Attempt 2 — explicit unavailable billing period

A direct missing-period bookmark (`/app?view=detail&bill=past&billId=missing-period`) now displays the production `LegacyBillingUnavailable` component. Browser replay verified the requested URL stays in place, the page explicitly states that no other period was selected, and its only link returns to Overview with trusted embed context. At 390px viewport width the document is 390px wide without overflow. The Overview link and subsequent valid legacy-period link work. [Unavailable-period screenshot](evidence/unavailable-period-390.png).

The synthetic fixture checks presentation/navigation, while the production loader tests cover absent ID (default allowed), owned ID, missing/deleted/foreign ID, malformed/empty/repeated ID (unavailable without substitution), tenant constraints, onboarding precedence, and no performance/capacity/pending reads on the compatibility path. Expanded required suites: 56 tests passed. Typecheck remains 131 baseline diagnostics; lint remains 20 errors and two warnings, with no rework-owned diagnostics.

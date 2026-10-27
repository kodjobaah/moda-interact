# ARCH-049-SHOPIFY-001 — Shopify brand-read permission and rollout

## Scope of this change

This change **only** enables installation permission and reports the brand scope observed in authenticated Shopify `app/scopes_update` notifications. It makes no `shop.brand` GraphQL request, persists no ShopBrand sources and enqueues no ShopBrand synchronisation. `ARCH-049-BACKGROUND-003` owns brand acquisition and must check the **actual offline installation grant** independently before issuing a request.

Shopify's `BrandingBrand` resource requires the `read_brand` access scope:
https://shopify.dev/docs/api/admin-graphql/2026-07/objects/BrandingBrand

## Configurations and deployment identity

The 2026-10-27 source snapshot contains **two different Shopify app client IDs**:

| File | API version | Previously declared scopes | Change |
| --- | --- | --- | --- |
| `shopify.app.toml` | `2026-10` | `write_products,write_metaobjects,write_metaobject_definitions` | Append required `read_brand`; preserve existing `app/scopes_update` subscription. |
| `shopify.app.moda-interact.toml` | `2026-07` | `read_customers,read_discounts,read_locales,read_markets,read_orders,read_products` | Append required `read_brand`; subscribe the already implemented `/webhooks/app/scopes_update` route. |

The source snapshot's `.shopify/project.json` references the **named** app ID for a development store, and the existing ARCH-045 Shopify configuration notes identify the named file as intended for the 2026-07 consent integration. This is **not proof of which app version is deployed**, or of granted scopes on any installed merchant store. Do **not** deploy the template/default config to the named app, or assume modifying one app grants access to the other. `shopify.app.moda-interact.toml.good` and `.test` are preserved as snapshot artefacts, not treated as an authoritative deployment target.

`app/shopify.server.js` obtains its API credentials from the existing platform configuration and its requested scopes from the external `SCOPES` environment variable. This change does not silently modify either. **Before rollout**, ensure the deployed API key matches the selected Shopify app client and `SCOPES` includes `read_brand` while retaining all other scopes configured for that app. Otherwise fail the rollout gate rather than relying on a TOML change alone.

## Existing installations / re-authorisation

Shopify's documented required-scope flow is:
https://shopify.dev/docs/apps/build/authentication-authorization/manage-access-scopes

1. In the **canonical dedicated task worktree**, identify the selected app configuration with the locally installed Shopify CLI (`shopify app config use` / `shopify app info`), then confirm its client ID, URL, required scopes and webhook subscriptions against the Partner Dashboard. Select only the matching intended app; do not assume the default TOML is the deployed configuration. Confirm the runtime `SCOPES` variable separately. For the named app, the Shopify CLI supports explicit configuration selection:

   ```bash
   npx shopify app config validate --config moda-interact
   ```

2. Deploy the updated **selected configuration** with the Shopify CLI (for the named app: `npx shopify app deploy --config moda-interact`). Ensure the deployed version includes the required `read_brand` scope and the `app/scopes_update` subscription (the named app previously lacked it). This patch does **not** perform a Shopify deployment.
3. For an already-installed merchant, request that the merchant **open the embedded app and approve the new required access** when Shopify presents the scope-change prompt. Do not implement a custom optional-scope request: `read_brand` is a **required** scope in the TOML. The existing authenticated `/auth/*` path continues to handle normal app authentication. Shopify manages required-scope approval after deploying the updated app version.
4. Confirm the merchant's **actual granted scope** using the installation's authorised Admin GraphQL client (not a different store/token), with the read-only query below. Inspect the returned `handle` values and any GraphQL `errors`, even when HTTP returns 200:

   ```graphql
   query GrantedShopifyScopes {
     currentAppInstallation {
       accessScopes { handle }
     }
   }
   ```

5. Expect a signed `APP_SCOPES_UPDATE` webhook after approval. The existing route authenticates the webhook, persists the Shopify-reported current scope to its session when present, and retains the existing discount-sync behaviour. Its structured `shopify.webhook.outcome` log now adds the bounded `brandReadScopeGrantFromWebhook: GRANTED | MISSING` field **for this event only**. The value reflects the authenticated **webhook report**, not independent verification that a persisted offline token is usable. No tokens, source URLs or raw webhook bodies are logged.
6. Check the persisted offline session's scope (and verify it with `currentAppInstallation` using the actual offline grant where applicable). If `read_brand` is absent, the shop is not ready for BG003; obtain Shopify approval/refresh rather than attempting the brand query. Re-open the app and repeat approval/verification, or investigate why a scope-change webhook/token refresh was not received. Do not attempt blind retries on access-denied brand queries.
7. Verify the configured API version and `shop.brand` field permission in the intended Shopify shop, **only after the offline grant has been verified**, as part of the downstream BG003 integration smoke. A missing or denied grant must become an explicit per-shop `MISSING_SCOPE`/permission outcome in Background, not an attempted source sync.

Shopify's official access-scope guide distinguishes declared scopes from grants and documents when the `app/scopes_update` webhook fires. Scope grant approval, application deployment and installed-token proof require live access and cannot be established from this snapshot.

## Local focused validation

From the `moda-interact/` implementation worktree with the project dependencies installed:

```bash
npx vitest run \
  tests/unit/webhooks/shopify-brand-scope-config.test.ts \
  tests/unit/services/shopify-brand-read-scope.test.ts \
  tests/unit/routes/scopes-update.test.jsx \
  tests/unit/routes/auth-catchall.test.ts \
  tests/unit/webhooks/shopify-whatsapp-consent-config.test.js

npm run typecheck
```

Also parse both TOMLs with Python 3.11+ `tomllib` (or another actual TOML parser), check that `read_brand` appears **exactly once** in each required scope list, and run `git diff --check` after patch application. Do not mark live deployment, scope approval or BG003 readiness as verified on the basis of these local tests.

## Release/acceptance evidence to capture in the developer environment

- Which app configuration and client ID were selected, with separate release/version evidence for the actual installed app; do not copy access tokens or private keys into the Completion Report.
- CLI deployment result, deployed app scopes and subscriptions, and current external runtime `SCOPES` configuration.
- Installed-shop approval/reauthorisation evidence and `currentAppInstallation.accessScopes` response showing `read_brand`, or a clear `MISSING` result with the shop blocked for brand reads.
- Authenticated `app/scopes_update` receipt and its bounded grant-status log if emitted; absence is not sufficient proof of grant.
- Focused tests, config parse, typecheck and whitespace checks; any environmental/toolchain limitations recorded as not run.

# ARCH-043-SHOPIFY-002 — Shopify runtime cutover

## Source of truth

- `shopify.oauth`: `apiKey`, `apiSecret` are loaded together through `SHOPIFY-001` before `shopifyApp` construction; there is **no** runtime `SHOPIFY_API_KEY` or `SHOPIFY_API_SECRET` fallback. The `apiKey` exported to embedded-app routes and webhook deduplication is the same SDK key, and only this non-secret value may reach the browser.
- `shopify.partner`: both Partner GraphQL operations call `requireShopifyPartnerCredentials()` independently, using one `organizationId`, `accessToken`, `appId`, and optional `apiVersion` from the same configuration revision. Optional version defaults to the previously used `2026-07`. Revocation or database failure stops the operation before a Partner HTTP request.
- `merchant.knowledge.r2`: upload intent, upload finalisation and the settings upload-limit presentation use the SHOPIFY-001 validated six-field record. Every intent/finalisation obtains one fresh immutable snapshot; signing and HEAD operations use the endpoint, bucket, access credentials and limits from that same snapshot. No legacy R2 environment values are merged.
- `SCOPES`, `SHOPIFY_APP_URL`, `SHOP_CUSTOM_DOMAIN`, deployment identity, PostgreSQL connection and `MODA_CONFIG_UNSEAL_KEY` / `MODA_CONFIG_UNSEAL_ACTIVE_KEY_ID` remain external bootstrap/infrastructure settings. Shopify CLI deployment files and standalone diagnostic scripts are not modified in this task.

## Gateway environment-variable retirement handoff

The following variables are no longer read as Shopify application-runtime credentials/configuration after this cutover and are candidates for removal from the deployed Shopify service environment by `ARCH-043-GATEWAY-001`:

- OAuth: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`.
- Partner API: `SHOPIFY_PARTNER_ACCESS_TOKEN`, `SHOPIFY_PARTNER_API_TOKEN`, `SHOPIFY_PARTNER_ORG_ID`, `SHOPIFY_PARTNER_ORGANIZATION_ID`, `SHOPIFY_APP_ID`, `SHOPIFY_PARTNER_API_VERSION`.
- Merchant Knowledge R2: `MERCHANT_KNOWLEDGE_R2_ENDPOINT`, `MERCHANT_KNOWLEDGE_R2_BUCKET`, `MERCHANT_KNOWLEDGE_R2_ACCESS_KEY_ID`, `MERCHANT_KNOWLEDGE_R2_SECRET_ACCESS_KEY`, `MERCHANT_KNOWLEDGE_MAX_UPLOAD_BYTES`.

This list is limited to the Shopify application runtime. Do not remove same-named inputs from Shopify CLI configuration or standalone diagnostic scripts without reviewing those tools' independent requirements. Keep `SCOPES`, `SHOPIFY_APP_URL`, `SHOP_CUSTOM_DOMAIN`, database connectivity, deployment identity and the external unseal keyring as applicable.

## Startup / fail-closed behaviour

`app/shopify.server.js` is a Node ESM server module that uses top-level `await` for the authenticated database read **before** calling the synchronously exported `shopifyApp({...})` constructor. React Router's built server module imports must finish evaluation before importing routes can use `authenticate`, `sessionStorage`, `apiKey` or the webhook helpers. The module intentionally does not export a placeholder client or offer an environment-secret fallback. If the reader fails because configuration is absent, revoked, wrong-environment, malformed, tampered or unavailable, module evaluation rejects.

The safe deployment sequence is: migrate the canonical schema; provision and verify `shopify.oauth`, `shopify.partner` and `merchant.knowledge.r2` using the authorised Admin editor in the target deployment environment; configure the **external** platform unseal keyring; then start/restart the Shopify service. Do not remove the stored signing key material while old DB envelopes still depend on it.

**OAuth rotation:** The Shopify SDK snapshots `shopify.oauth` at construction. A new OAuth revision requires a coordinated service restart. Do not hot-swap an already running Shopify SDK or invent a second accepted HMAC key. Existing sessions and Shopify webhook signatures should be checked against the configured SDK after rotation. If the provider does not support overlapping keys, schedule an interruption/reauthorisation window and stop the deployment when sessions or HMAC checks fail. A rollback must restore the approved row/revision **and** restart all instances; do not revert to environment credentials.

**Runtime verification boundary:** Source-level OAuth bootstrap tests and the production SSR build are the required evidence for this task. Live `@react-router/serve` readiness, Shopify login/session, webhook delivery, and deployed rotation/rollback exercises are operational follow-up checks, not SHOPIFY-002 acceptance gates. Do not claim those live checks were performed based on unit tests or a build.

## R2 bucket/location changes

`MerchantKnowledgeUploadedAsset` persists only `objectKey`, not the original bucket. An R2 endpoint or bucket edit during a pending upload makes that upload **not safely portable**: finalisation uses the *current* bucket and, if the object is not present there, returns `UPLOAD_OBJECT_NOT_FOUND` without marking the asset available. Operators must avoid editing the R2 bucket/endpoint while uploads are pending, and must coordinate relocation/re-upload with the separately owned storage-relocation flow. Historical assets need that separate relocation flow too; SHOPIFY-002 never silently guesses a former bucket or copies objects. No write/network request occurs inside the upload finalisation database transaction to simulate location compatibility.

## Review commands and evidence

From the isolated `moda-interact` implementation worktree, with its project-compatible Node and dependencies:

```bash
npm test -- tests/unit/platform-configuration tests/unit/merchant-knowledge-upload.test.ts tests/unit/services/shopify-billing.provider.test.ts tests/unit/routes/reinstalling-route.test.ts
npm run typecheck
npm run lint
npm run build
# Optional when disposable Docker Postgres is configured:
MODA_DISPOSABLE_INTEGRATION=1 npm test -- tests/integration/merchant-knowledge-upload.integration.test.ts
git diff --check
```

Record positive and negative results from the automated OAuth bootstrap/fail-closed, webhook-route, Partner billing, R2 signing/finalisation, configuration-revocation and secret-redaction tests. Do not include decrypted secrets in assertions, browser output, error messages or logs. Live deployment checks remain operational follow-up and must be recorded separately if later performed.

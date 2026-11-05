# Runtime naming and canonical development billing identities

ARCH-057-SHOPIFY-012 — 5 November 2026. Implementation baseline: `cf0e8dfd314c92183b07a935dff68c933f445daf`, including the accepted server diagnostic correction. This document records local validation, not production billing execution or historical-data migration.

## Development baseline decision

The product has not gone live. The user explicitly authorized replacing development billing identities directly, without preserving old hashes or disposable development operation records. Fresh operation records use one canonical format. Old development state can be discarded/reseeded through the existing development reset/seed workflow; this task adds no startup deletion, reset framework, old-key reader, alias, fallback, compatibility flag, dual write, backfill or migration.

## Exact namespace map

| Previous runtime literal (removed) | Sole canonical literal | Builder |
|---|---|---|
| `arch027-shopify-operation-key-v1` | `shopify-billing-operation-key-v1` | Private `operationRequestKey` |
| `arch027-recurring-v1` | `shopify-billing-recurring-v1` | Exported `shopifyRecurringRequestFingerprint` |
| `arch027-topup-v1` | `shopify-billing-topup-v1` | Exported `shopifyOneTimeChargeRequestFingerprint` |

Only these three literals changed in the operation service. UTF-8 encoding, SHA-256, exact newline framing, field ordering, positive quote/control-character validation and public signatures are unchanged. There is no old-format runtime exception.

Request keys keep `shopify:<kind lowercased>:<hex>` for recurring operations. Their digest input is `[canonical key namespace, actual enum kind, ...fields]` joined with newline and followed by one final newline:

| Kind | Ordered request fields after kind |
|---|---|
| `SUBSCRIPTION_CREATE` | subscription ID, target catalogue plan ID |
| `PLAN_SWITCH` | subscription ID, previous plan handle, target catalogue plan ID, selected period boundary |
| `CANCEL` | subscription ID, previous plan handle, selected period boundary |

The request-key digest does not itself include Shop ID; the persisted uniqueness scope remains `(shopId, requestKey)`. Recurring fingerprints contain canonical recurring namespace, actual kind and Shop ID, followed for create/switch by catalogue plan ID, quoted minor amount, currency and billing period. Cancellation excludes irrelevant quote fields. One-time fingerprints contain canonical top-up namespace, `ONE_TIME_CHARGE`, Shop ID, usage-event ID, amount and currency. Each fingerprint input also ends with newline.

The descriptive `shopify:one-time-charge:<purchaseId>` key stays unchanged. Provider references and lifecycle observation IDs are not introduced into hashes. Existing provider-reference enrichment/conflict and period-boundary inclusion rules remain service policy.

## Fixed vectors

Expected constants were derived independently with Python `hashlib.sha256(("\n".join(fields) + "\n").encode("utf8"))`, then committed as hexadecimal constants in `tests/unit/billing-operation-identity-vectors.test.ts`. The tests do not invoke an implementation builder to compute expected values or expose the private builder.

Inputs: Shop `shop-雪`; subscription `subscription-été`; catalogue plan `plan-東京`; previous handle `growth`; boundary `2026-11-30T00:00:00.000Z`; recurring4900 USD EVERY_30_DAYS; usage event `usage-é`; one-time500 USD; purchase `purchase-é`.

| Vector | Fixed expected SHA-256 |
|---|---|
| `createKey` | `25d66ce262026a707985da0611ec9d7bbcd0b0538071325f0403d7da3f3bb84d` |
| `switchKey` | `3392a6dcd3f37aec9df7949b781a994b2f76c68ebfe8ab9b9fd932fdac676e63` |
| `cancelKey` | `523482f90f100498ca92f722de9ce65179b0752cb5acda8c3b95f1ad206a2788` |
| `createFingerprint` | `3e42a42f6c3c7af1b1ca68b166a3a236cb743c3829de99a50f5486b1b131b21c` |
| `switchFingerprint` | `0d3c7fcf3094462c85f4c38f88c259be6f044f768c948cceda4f7546b5ad40fa` |
| `cancelFingerprint` | `6bed48ddeb1183b800ab6c6a7bd126726789552587b679fc831690c1b7a2e859` |
| `chargeFingerprint` | `67a15774769aa0d1ae1f588195b234213a949f73c63fd61a2fa9fe178d7c5758` |

The service-observed recurring keys prepend the unchanged kind-specific prefix to these fixed request digests. The one-time service-observed key is `shopify:one-time-charge:purchase-é`. Coverage includes all four actual enum kinds, fresh canonical replay, non-ASCII fields, distinct Shop/plan/amount/currency/usage/subscription/boundary inputs, cancellation exclusions, provider-reference exclusion/conflict, and control characters LF/CR/NUL/unit-separator/DEL. The existing service suite also fixes its first fresh replay expectation to independently derived canonical constants.

## Naming inventory and gate

`scripts/check-runtime-names.mjs` scans application runtime source filenames/content, actual production entry/build/Shopify config/Docker surfaces, optional deployment/workflow directories, production package manifest values and literal local executable references in production commands. The root comes from the script location, not the caller's working directory. It never evaluates commands. `--list` prints only the selected relative paths and roles. Violations print path/line/classification without source text or matched values.

Recognized architecture forms include `ARCH-123`, `arch123`, `ARCH_123`; task forms include `SHOPIFY-001`, `DATABASE-001`, `ADMIN-002` (case-insensitive and underscore variants). Every matching selected runtime path/content fails. There is no literal allowlist.

Selection excludes documentation (including the recovery README), test/fixture/validation tooling, generated/vendor output, database migration history and non-production backup/test TOML or historical patch artifacts by role/path. Secret files (`.env*`, credential/key material files) are not opened. Symlinks, including parent components of literal command paths, are not followed. Production manifest scripts are selected separately from test/validation scripts so legitimate test traceability remains allowed.

The eight rewritten comment locations retain their domain/security/ordering explanation:

| File | Retained explanation |
|---|---|
| `app/services/webhooks/webhook-normalization-utils.ts` | Timestamp normalization shared by recovery webhook normalizers |
| `app/services/platform-configuration/contracts.server.ts` | Shopify-owned server-only configuration; never serialize secrets |
| `app/services/platform-configuration/seal.server.ts` | AAD JSON array namespace/environment/key/version/envelope-version ordering; encryption bytes unchanged |
| `app/services/recoveries/recovery-follow-up-catalogue.server.ts` | Immutable English SOURCE_SAVED draft provenance and separate provider/target approval |
| `app/services/platform-configuration/composition.server.ts` | Operation-scoped configuration/environment/keyring composition |
| `app/services/merchant-knowledge/r2-config.server.ts` | Immutable operation-scoped sealed R2 snapshot and enforced contract |
| `app/services/recoveries/recovery-follow-up-sender.server.ts` | Platform-owned configuration/AAD/keyring ownership |
| `app/services/recoveries/recovery-human-commands.server.ts` | Shop → Conversation → command/outreach-attempt lock ordering and trusted session ownership |

Final selected scope: **241 files plus production manifest values; zero violations; zero exceptions**. No undeclared runtime naming defect was found. Exact selected paths are listed below; there were no local executable production-command or deployment-directory files beyond these actual surfaces.

## Executed validation

- `npm run lint:runtime-names`: passed with zero exceptions.
- Sixteen disposable gate checks passed: rejection of three architecture forms, three task fragments, all three removed literals, a runtime filename and production config; successful exclusion of task-labelled tests/documents and an external symlink; final clean-scope success. All temporary fixtures removed. Production manifest rejection reported its actual source line, and task-labelled validation manifest scripts were excluded. Negative outputs contained classification and path/line, never the source sentinel.
- `npm run test:billing-identity`: **41 tests passed in2 files** (17 new fixed-vector/identity cases plus24 existing service cases).
- `MODA_DISPOSABLE_INTEGRATION=1 npm test -- tests/integration/billing-activation.postgres.integration.test.ts tests/integration/recovery-credit-purchases.postgres.integration.test.ts`: **8 tests passed in2 files**, no skipped cases in the successful run. The existing fixture starts a separate fresh `pgvector/pgvector:pg17` container for each suite, deploys the canonical forward migration sequence from the pinned nested Database, then uses real Prisma transactions/connections and controlled provider ports.
- Activation: fresh canonical intent, repeat preparation uses one operation ID, concurrent same-token finalization admits once, one confirmed operation, one period/included counter with25 credits, stale replay/counter repair does not create another operation or grant. Existing milestone lock ordering and failed-second-write rollback remain verified.
- Purchase: concurrent identical/distinct IDs admit one purchase/usage event/operation, canonical top-up fingerprint, same receipt replay without additional provider observation, tenant rejection and genuine changed-quote fingerprint conflict preserve state; cycle-race refusal and rollback after each real usage/purchase/operation write remain verified. Existing suite emitted **364 SQL statements** across fixture/assertion/business work; this is not a before/after optimization measurement. Provider calls are synthetic; no live charge occurred.
- `npm run typecheck`: passed. Focused ESLint and `git diff --check`: passed.

The first PostgreSQL invocation could not discover a runtime from the non-login test process and ran no cases. The successful invocation supplied `DOCKER_HOST` from the current Colima Docker context and `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`; no host configuration was changed. Both task PostgreSQL containers and the task Ryuk helper were removed by fixture cleanup; before/after running-container inventories match exactly, preserving all three pre-existing containers. No shared Docker pruning.

Local command artifacts: `/tmp/arch057-shopify012-{install,prisma,names,unit,postgres,typecheck,lint,shopify-docs}.log`; vector derivation `/tmp/arch057-shopify012-vectors.json`; gate cases `/tmp/arch057-shopify012-gate-fixtures.json`; source selection `/tmp/arch057-shopify012-runtime-inventory.txt`; before/after task-resource evidence `/tmp/arch057-shopify012-containers-{before,after}.txt`. No database URL, credentials, provider body or secret-bearing source line is included here.

## Final selected runtime paths

```text
app/components/billing-setup/BillingSetupStatus.css (application)
app/components/billing-setup/BillingSetupStatus.jsx (application)
app/components/dashboard/billing-purchase.mock.js (application)
app/components/dashboard/BillingPurchaseHub.css (application)
app/components/dashboard/BillingPurchaseHub.jsx (application)
app/components/dashboard/Breadcrumbs.jsx (application)
app/components/dashboard/LegacyBillingUnavailable.tsx (application)
app/components/dashboard/LifecycleRestrictionBanner.jsx (application)
app/components/dashboard/MerchantNavigation.tsx (application)
app/components/dashboard/PendingRecoveries.jsx (application)
app/components/dashboard/RecoveryCreditPurchaseManager.jsx (application)
app/components/dashboard/RecoveryOverview.css (application)
app/components/dashboard/RecoveryOverview.tsx (application)
app/components/dashboard/SubscriptionChangePanel.jsx (application)
app/components/dashboard/TopUpPurchasePanel.jsx (application)
app/components/dashboard/UsageEvents.css (application)
app/components/dashboard/UsageEvents.tsx (application)
app/components/merchant-pricing/MerchantPricingCatalogue.css (application)
app/components/merchant-pricing/MerchantPricingCatalogue.jsx (application)
app/components/onboarding/Onboarding.css (application)
app/components/onboarding/Onboarding.jsx (application)
app/components/settings/FeaturePreferences.tsx (application)
app/components/settings/MerchantKnowledgeSection.tsx (application)
app/components/settings/MerchantKnowledgeUploadForm.tsx (application)
app/components/settings/SettingsForm.tsx (application)
app/components/settings/StoreProfileSection.tsx (application)
app/components/settings/submission.ts (application)
app/components/store-profile/StoreCategoryMappingSelector.css (application)
app/components/store-profile/StoreCategoryMappingSelector.tsx (application)
app/db.server.js (application)
app/entry.server.jsx (application)
app/i18n/catalogues.js (application)
app/i18n/locales/cs.json (application)
app/i18n/locales/da.json (application)
app/i18n/locales/de.json (application)
app/i18n/locales/en.json (application)
app/i18n/locales/es.json (application)
app/i18n/locales/fi.json (application)
app/i18n/locales/fr.json (application)
app/i18n/locales/it.json (application)
app/i18n/locales/ja.json (application)
app/i18n/locales/ko.json (application)
app/i18n/locales/nb.json (application)
app/i18n/locales/nl.json (application)
app/i18n/locales/pl.json (application)
app/i18n/locales/pt-BR.json (application)
app/i18n/locales/pt-PT.json (application)
app/i18n/locales/sv.json (application)
app/i18n/locales/th.json (application)
app/i18n/locales/tr.json (application)
app/i18n/locales/zh-Hans.json (application)
app/i18n/locales/zh-Hant.json (application)
app/root.jsx (application)
app/routes.ts (application)
app/routes/app/billing/callback/route.tsx (application)
app/routes/app/billing/options/route.tsx (application)
app/routes/app/billing/recovery-credit-purchases/route.tsx (application)
app/routes/app/billing/select/route.jsx (application)
app/routes/app/billing/status/route.ts (application)
app/routes/app/features/route.tsx (application)
app/routes/app/home/overview.server.ts (application)
app/routes/app/home/route.jsx (application)
app/routes/app/merchant-knowledge/delete/route.ts (application)
app/routes/app/merchant-knowledge/refresh/route.ts (application)
app/routes/app/merchant-knowledge/reorder/route.ts (application)
app/routes/app/merchant-knowledge/reprocess/route.ts (application)
app/routes/app/merchant-knowledge/source/route.ts (application)
app/routes/app/merchant-knowledge/upload-failure/route.ts (application)
app/routes/app/merchant-knowledge/upload-finalize/route.ts (application)
app/routes/app/merchant-knowledge/upload-intent/route.ts (application)
app/routes/app/merchant-support/route.jsx (application)
app/routes/app/onboarding/resume/route.ts (application)
app/routes/app/pending-recoveries/route.jsx (application)
app/routes/app/promotions/PromotionsRoute.css (application)
app/routes/app/promotions/route.tsx (application)
app/routes/app/recoveries/access.server.ts (application)
app/routes/app/recoveries/loader.server.ts (application)
app/routes/app/recoveries/recovery-list-state.ts (application)
app/routes/app/recoveries/RecoveryList.css (application)
app/routes/app/recoveries/RecoveryList.tsx (application)
app/routes/app/recoveries/route.tsx (application)
app/routes/app/recovery-detail/checkout-basket.tsx (application)
app/routes/app/recovery-detail/command-http.server.ts (application)
app/routes/app/recovery-detail/command-status.ts (application)
app/routes/app/recovery-detail/commands.ts (application)
app/routes/app/recovery-detail/control.ts (application)
app/routes/app/recovery-detail/conversation-control-bar.tsx (application)
app/routes/app/recovery-detail/human-conversation-panel.tsx (application)
app/routes/app/recovery-detail/loader.server.ts (application)
app/routes/app/recovery-detail/merchant-command-status.tsx (application)
app/routes/app/recovery-detail/merchant-reply-composer.tsx (application)
app/routes/app/recovery-detail/messages.ts (application)
app/routes/app/recovery-detail/recovery-activity-timeline.tsx (application)
app/routes/app/recovery-detail/recovery-conversation-thread.tsx (application)
app/routes/app/recovery-detail/recovery-conversation.css (application)
app/routes/app/recovery-detail/recovery-message-guidance.tsx (application)
app/routes/app/recovery-detail/recovery-message-list.tsx (application)
app/routes/app/recovery-detail/recovery-outreach-status.tsx (application)
app/routes/app/recovery-detail/recovery-section-ui.tsx (application)
app/routes/app/recovery-detail/recovery-sidebar.css (application)
app/routes/app/recovery-detail/recovery-sidebar.tsx (application)
app/routes/app/recovery-detail/recovery-summary-header.tsx (application)
app/routes/app/recovery-detail/recovery-ui-types.ts (application)
app/routes/app/recovery-detail/RecoveryDetail.css (application)
app/routes/app/recovery-detail/RecoveryDetail.tsx (application)
app/routes/app/recovery-detail/related-recoveries.tsx (application)
app/routes/app/recovery-detail/related.ts (application)
app/routes/app/recovery-detail/route.tsx (application)
app/routes/app/recovery-detail/state.ts (application)
app/routes/app/recovery-detail/use-recovery-section.ts (application)
app/routes/app/recovery-settings/AiResponseDelaySettings.tsx (application)
app/routes/app/recovery-settings/RecoverySettingsRoute.css (application)
app/routes/app/recovery-settings/RecoverySettingsView.tsx (application)
app/routes/app/recovery-settings/route.tsx (application)
app/routes/app/recovery-settings/WhatsAppCustomerConsent.tsx (application)
app/routes/app/reinstalling/route.jsx (application)
app/routes/app/route.jsx (application)
app/routes/app/settings-save/route.ts (application)
app/routes/app/store-profile/category/route.ts (application)
app/routes/app/usage/route.jsx (application)
app/routes/auth/catchall/route.jsx (application)
app/routes/auth/login/error.server.jsx (application)
app/routes/auth/login/route.jsx (application)
app/routes/public/home/route.jsx (application)
app/routes/public/home/styles.module.css (application)
app/routes/public/privacy/route.tsx (application)
app/routes/system/health/route.ts (application)
app/routes/system/ready/route.ts (application)
app/routes/system/telemetry-probe/route.ts (application)
app/routes/webhooks/app/scopes-update/route.jsx (application)
app/routes/webhooks/app/uninstalled/route.jsx (application)
app/routes/webhooks/customers/data-request/route.jsx (application)
app/routes/webhooks/customers/redact/route.jsx (application)
app/routes/webhooks/root/route.jsx (application)
app/routes/webhooks/shop/redact/route.jsx (application)
app/services/ai-response-delay/ai-response-delay.server.ts (application)
app/services/billing/billing-period-projection.ts (application)
app/services/billing/billing-plan-resolution.service.ts (application)
app/services/billing/billing-reconciliation.service.ts (application)
app/services/billing/billing-retry-policy.ts (application)
app/services/billing/billing.service.ts (application)
app/services/billing/billing.types.ts (application)
app/services/billing/hosted-plan-change.service.ts (application)
app/services/billing/merchant-billing-presentation.server.ts (application)
app/services/billing/merchant-billing-read.service.ts (application)
app/services/billing/merchant-billing-setup-state.ts (application)
app/services/billing/merchant-recovery-capacity-read.service.ts (application)
app/services/billing/onboarding-milestone.server.ts (application)
app/services/billing/providers/shopify-billing-diagnostics.server.ts (application)
app/services/billing/providers/shopify-billing.provider.ts (application)
app/services/billing/recovery-credit-provider-context.server.ts (application)
app/services/billing/recovery-credit-purchase-management.service.ts (application)
app/services/billing/recovery-credit-purchase-request.service.ts (application)
app/services/billing/repositories/subscription.repository.ts (application)
app/services/billing/shopify-billing-operation.service.ts (application)
app/services/billing/subscription-activation.service.ts (application)
app/services/billing/subscription-ended-notification.service.ts (application)
app/services/billing/subscription-locks.ts (application)
app/services/billing/subscription-read.service.ts (application)
app/services/billing/subscription-sync.service.ts (application)
app/services/billing/types.ts (application)
app/services/billing/usage.service.ts (application)
app/services/discounts/shopify-discount-lifecycle.service.ts (application)
app/services/entitlement/entitlement.service.ts (application)
app/services/feature-preferences/access.server.ts (application)
app/services/feature-preferences/feature-preferences.server.ts (application)
app/services/feature-preferences/merchant-settings-observability.server.ts (application)
app/services/feature-preferences/settings-read-context.server.ts (application)
app/services/health/health-check.server.ts (application)
app/services/merchant-knowledge/merchant-knowledge-entitlement.server.ts (application)
app/services/merchant-knowledge/merchant-knowledge-error.server.ts (application)
app/services/merchant-knowledge/merchant-knowledge-http.server.ts (application)
app/services/merchant-knowledge/merchant-knowledge-observability.server.ts (application)
app/services/merchant-knowledge/merchant-knowledge-queue.server.ts (application)
app/services/merchant-knowledge/merchant-knowledge.server.ts (application)
app/services/merchant-knowledge/r2-client.server.ts (application)
app/services/merchant-knowledge/r2-config.server.ts (application)
app/services/merchant-knowledge/upload.server.ts (application)
app/services/merchant-pricing/merchant-pricing.server.js (application)
app/services/merchant-support/merchant-support-observability.server.ts (application)
app/services/merchant-support/merchant-support.service.ts (application)
app/services/merchant-support/system-message-actions.ts (application)
app/services/observability/shopify-runtime-observability.server.ts (application)
app/services/otel/otel.constants.ts (application)
app/services/otel/otel.runtime.ts (application)
app/services/otel/shopify-webhook-telemetry.server.ts (application)
app/services/pending-recovery/pending-recovery-reader.server.ts (application)
app/services/platform-configuration/composition.server.ts (application)
app/services/platform-configuration/contracts.server.ts (application)
app/services/platform-configuration/merchant-knowledge-r2.server.ts (application)
app/services/platform-configuration/repository.server.ts (application)
app/services/platform-configuration/seal.server.ts (application)
app/services/platform-configuration/service.server.ts (application)
app/services/platform-configuration/shopify-oauth-credentials.server.ts (application)
app/services/platform-configuration/shopify-partner-credentials.server.ts (application)
app/services/promotions/promotion.service.ts (application)
app/services/recoveries/detail-cursor.server.ts (application)
app/services/recoveries/detail-message.ts (application)
app/services/recoveries/recovery-basket.ts (application)
app/services/recoveries/recovery-detail.server.ts (application)
app/services/recoveries/recovery-follow-up-catalogue.server.ts (application)
app/services/recoveries/recovery-follow-up-sender.server.ts (application)
app/services/recoveries/recovery-human-commands.server.ts (application)
app/services/recoveries/recovery-observability.server.ts (application)
app/services/recoveries/recovery-query.server.ts (application)
app/services/recoveries/recovery-readers.server.ts (application)
app/services/recoveries/recovery-service-window.ts (application)
app/services/recovery-policy/recovery-policy.server.ts (application)
app/services/shop/merchant-request-context.server.ts (application)
app/services/shop/merchant-route-access-policy.ts (application)
app/services/shop/shop-access-policy.ts (application)
app/services/shop/shop.service.ts (application)
app/services/shopify-brand/shopify-brand-read-scope.ts (application)
app/services/store-profile/shopify-taxonomy-suggestion.server.ts (application)
app/services/store-profile/store-category-activation.server.ts (application)
app/services/store-profile/store-category-localization.ts (application)
app/services/store-profile/store-category-prompt-provenance.ts (application)
app/services/store-profile/store-category-selection.server.ts (application)
app/services/store-profile/store-category.server.ts (application)
app/services/usage/history.server.ts (application)
app/services/webhooks/cart-activity-normalization.ts (application)
app/services/webhooks/checkout-normalization.ts (application)
app/services/webhooks/international-context-normalization.ts (application)
app/services/webhooks/order-normalization.ts (application)
app/services/webhooks/shopify-webhook-ingress.service.ts (application)
app/services/webhooks/shopify-webhook-metadata.ts (application)
app/services/webhooks/shopify-webhook-observability.server.ts (application)
app/services/webhooks/shopify-webhook-observation.ts (application)
app/services/webhooks/shopify-webhook-queue.server.ts (application)
app/services/webhooks/shopify-whatsapp-consent-normalization.ts (application)
app/services/webhooks/webhook-normalization-utils.ts (application)
app/shopify.server.js (application)
app/tailwind.css (application)
app/utils/merchant-i18n.js (application)
Dockerfile (production-entry/configuration)
observability.mjs (production-entry/configuration)
react-router.config.ts (production-entry/configuration)
shopify.app.moda-interact.toml (production-entry/configuration)
shopify.app.toml (production-entry/configuration)
shopify.web.toml (production-entry/configuration)
vite.config.js (production-entry/configuration)
```

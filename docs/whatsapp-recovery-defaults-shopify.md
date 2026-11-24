# Shopify — automatic assignment from platform recovery defaults

## Deployment prerequisites

- Apply the earlier Shopify onboarding automatic-assignment patch first. This
  follow-up replaces its source lookup; callback and authenticated onboarding
  resume remain the existing entry points. It is not a replacement for that patch.
- Pin the `database` submodule to the accepted migration
  `20261124163000_whatsapp_recovery_template_defaults` (or a later descendant).
  Deploy the database migration before deploying Shopify and regenerate Prisma.
- In Admin, configure the intended default for each of the six recovery purposes
  against the configured sender WABA using **Set as default**. Existing approval,
  review and common-layout gates apply. No merchants or previous publication
  operations are required to configure the defaults. Admin and Shopify must read
  the same platform sender configuration.

## Assignment contract

For each purpose, the Shopify post-onboarding service keeps its existing bounded
serializable transaction, global common-activation advisory lock and shop/purpose
lock. It preserves complete shop-specific assignments with matching successful
publication targets; an incomplete/conflicting assignment requires Admin review.
It never silently replaces merchant assignments. Where there are no existing
variants, it reads only `WhatsAppRecoveryTemplateDefault(wabaId, purpose)`.
Historical all-shops publication records are not used, even as a fallback.

The Admin authoring compiler remains the owner of authored-content validation.
Shopify does not compile a new template or contact Meta. It locks the selected
source and registrations and verifies the exact 20 supported locales, provider
language mapping and WABA, definition lifecycle/purpose, immutable saved English
source and prepared-content digests, matching frozen TEXT/IMAGE registration
bytes, review and reconciliation evidence, current Meta approval, category and
absence of drift. The saved common-layout references must still match the active
SHARED wrapper and its exact immutable locale projections (if neither the
wrapper nor references exist, the legacy no-common-layout path is retained).
The sender is rechecked before assignment. This is a persistence/evidence check,
not a second authoring compiler or a fresh live Meta approval request.

Each successful purpose writes exactly 20 enabled/approved shop variants and
20 `SUCCEEDED` targets with a single `COMPLETE` shop-specific publication
operation. All these writes are atomic per purpose. The six purposes can succeed
or fail independently; complete onboarding is not reversed by provisioning
failure. The operation retains the existing shop-scoped progress snapshot
shape; `sourceFingerprint` records the deterministic onboarding evidence
fingerprint, not a claim of an Admin publication preview. `automatedOnboarding`
records `source=PLATFORM_RECOVERY_DEFAULT`, the default row ID, the definition ID,
selection timestamp, selection administrator and evidence fingerprint. There is
no fictional all-shops publication ID or administrator preview. The required
operation requester FK identifies the administrator who selected the default,
not a new manually initiated shop publication. Previously written operations and
variants remain unchanged. All 20 languages are assigned irrespective of the
shop's default locale; the existing runtime selects the appropriate language.
No changes to Background, billing, onboarding UI, Prisma schema or queue behavior.

## Retry for an already onboarded merchant

The earlier authenticated POST `/app/onboarding/resume` endpoint already retries
provisioning when the shop is active and `onboardingCompleted=true`, without
changing subscription state or requiring a new install. Invoke that existing
endpoint for the current authenticated shop after configuring defaults. It must
never accept a shop identifier from a browser to provision another merchant.
An HTTP success response means the onboarding milestone is complete, not that
all six assignments succeeded: check SQL or the server outcome logs. Do not
trigger retries by repeatedly loading pages or adding a new worker.

Use the existing Admin incident resolution workflow after verifying successful
provisioning. The previous six OPEN incidents remain historical, actionable
records until an administrator resolves them; do not attribute automatic
resolution to a fabricated admin actor. New failures retain the existing
operational incident category and reason codes, with instructions to configure
or repair a platform default instead of publishing to all shops.

## Read-only production verification

```sql
SELECT s."domain", o."scopeSnapshot"->>'purpose' AS purpose,
       o."scopeSnapshot"#>>'{automatedOnboarding,defaultId}' AS "defaultId",
       o."definitionId", o."status", o."succeededTargets", o."failedTargets"
FROM whatsapp."WhatsAppTemplatePublicationOperation" o
JOIN commerce."Shop" s ON s."id" = o."scopeSnapshot"#>>'{scope,shopId}'
WHERE o."scopeSnapshot"#>>'{automatedOnboarding,source}' = 'PLATFORM_RECOVERY_DEFAULT'
ORDER BY s."domain", purpose;
```

Expect six complete operations, each with 20 successful targets and zero failures,
for a newly onboarded shop when all six defaults were eligible and no existing
merchant overrides were present. No all-shops publication history is needed.

## Validation

```sh
npm run prisma:validate
npm run prisma:generate
npm run typecheck
npm run test:recovery-defaults:unit
npm run test:recovery-defaults:postgres
```

The PostgreSQL suite starts its own disposable pgvector/PG17 container, migrates
it using an overridden DATABASE_URL and constructs an explicit Prisma client
against that container. It seeds independent defaults without any shops, checks
all 120 assignments and targets, verifies real French follow-up catalogue
selection, confirms retry/default replacement behavior and verifies transactional
rollback after injected target-write failure. It stops its own container. Never
point a test runner at the production database. The unit suite exercises the
onboarding entry points and the focused source/assignment regression cases.

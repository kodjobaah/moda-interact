# Shopify — automatic assignment from platform recovery defaults

## Deployment prerequisites

- Apply the earlier Shopify onboarding automatic-assignment patch first. This
  follow-up replaces its source lookup; callback and authenticated onboarding
  resume remain the existing entry points. It is not a replacement for that patch.
- Pin the `database` submodule to the accepted migration
  `20261125010000_whatsapp_recovery_default_formats` (or a later descendant).
  Regenerate Prisma against that pin. Pause affected writers and coordinate the
  migration with the compatible Admin and Shopify releases; do not deploy this
  app against the old two-column default key.
- In Admin, configure the TEXT baseline and, optionally, the IMAGE default for each of the six recovery purposes
  against the configured sender WABA using **Set as default**. Existing approval,
  review and common-layout gates apply. No merchants or previous publication
  operations are required to configure the defaults. Admin and Shopify must read
  the same platform sender configuration.

## Assignment contract

For each purpose and format (TEXT first, IMAGE second), the Shopify post-onboarding service keeps its existing bounded
serializable transaction, global common-activation advisory lock and shop/purpose
lock. It preserves complete shop-specific assignments with matching successful
publication targets; an incomplete/conflicting assignment requires Admin review.
It never silently replaces merchant assignments. Classify the active variants
from their frozen registration headers, grouping NONE/TEXT together and IMAGE
separately. A complete set for one format does not block the other. Partial or
ambiguous sets, unlinked active rows, or historical identities for the same
format require Admin review; the provisioner never repairs or reactivates them.
A configured default is read only from
`WhatsAppRecoveryTemplateDefault(wabaId, purpose, format)`. Historical all-shops
publication records are not used, even as a fallback. A missing required TEXT
pointer reports `NO_APPROVED_DEFAULT`; an absent optional IMAGE pointer records
`OPTIONAL_IMAGE_NOT_CONFIGURED` without creating an incident. Invalid configured
pointers still report a failure. The other format continues independently.

The source verifier requires the compiled and registered header kinds to agree,
all 20 locales to use the requested format and consistent header kind, and IMAGE
roles to be supported and consistent. TEXT defaults must not bind any ShopBrand
variables or IMAGE media. No R2 readiness check is required during assignment.
Runtime readiness and send admission remain Background responsibilities.

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

Each successful purpose/format writes exactly 20 enabled/approved shop variants and
20 `SUCCEEDED` targets with a single `COMPLETE` shop-specific publication
operation. All these writes are atomic per purpose/format. The twelve slots can succeed
or fail independently; complete onboarding is not reversed by provisioning
failure. The operation retains the existing shop-scoped progress snapshot
shape; `sourceFingerprint` records the deterministic onboarding evidence
fingerprint, not a claim of an Admin publication preview. `automatedOnboarding`
records `source=PLATFORM_RECOVERY_DEFAULT`, the default row ID, the definition ID,
selection timestamp, selection administrator, format, commerce platform and evidence fingerprint. There is
no fictional all-shops publication ID or administrator preview. The required
operation requester FK identifies the administrator who selected the default,
not a new manually initiated shop publication. Previously written operations and
variants remain unchanged. All 20 languages are assigned irrespective of the
shop's default locale; the existing runtime selects the appropriate language.
The existing Shopify explicit human follow-up catalogue also distinguishes the
formats: it lists independently eligible TEXT and IMAGE no-offer choices for the
same selected language (TEXT first), requiring successful publication targets for
each. Unknown/malformed active rows remain unsafe; a duplicate or invalid known
format does not hide the other valid format. The final provider dispatch checks
are unchanged. No changes to Background, billing, onboarding UI, Prisma schema,
Shopify scopes or queue behavior.

The transaction takes an explicit trusted commerce platform, environment and
sender resolver rather than importing the Shopify runtime. This is the core
intended for reuse by the subsequent WooCommerce API integration; this patch
only wires Shopify. WooCommerce lifecycle/installation eligibility and the
actual shared deployment boundary must be validated in that integration.

## Retry for an already onboarded merchant

The earlier authenticated POST `/app/onboarding/resume` endpoint already retries
provisioning when the shop is active and `onboardingCompleted=true`, without
changing subscription state or requiring a new install. Invoke that existing
endpoint for the current authenticated shop after configuring defaults. It must
never accept a shop identifier from a browser to provision another merchant.
An HTTP success response means the onboarding milestone is complete, not that
all twelve slots succeeded: check SQL or the server outcome logs. Do not
trigger retries by repeatedly loading pages or adding a new worker.

Use the existing Admin incident resolution workflow after verifying successful
provisioning. The previous six OPEN incidents remain historical, actionable
records until an administrator resolves them; do not attribute automatic
resolution to a fabricated admin actor. New failures retain the existing
operational incident category and reason codes, but resource keys include the format, with instructions to configure
or repair a platform default instead of publishing to all shops.

## Read-only production verification

```sql
SELECT s."domain", o."scopeSnapshot"->>'purpose' AS purpose,
       o."scopeSnapshot"#>>'{automatedOnboarding,format}' AS "format",
       o."scopeSnapshot"#>>'{automatedOnboarding,defaultId}' AS "defaultId",
       o."definitionId", o."status", o."succeededTargets", o."failedTargets"
FROM whatsapp."WhatsAppTemplatePublicationOperation" o
JOIN commerce."Shop" s ON s."id" = o."scopeSnapshot"#>>'{scope,shopId}'
WHERE o."scopeSnapshot"#>>'{automatedOnboarding,source}' = 'PLATFORM_RECOVERY_DEFAULT'
ORDER BY s."domain", purpose, "format";
```

Expect twelve complete operations (240 targets), each with 20 successful targets
and zero failures, for a newly onboarded shop when both defaults for every purpose
were eligible and no existing merchant overrides were present. TEXT-only onboarding
has six operations and 120 targets. Historical operations without format metadata
remain unchanged. Existing shops with IMAGE assignments gain only missing TEXT
slots on authenticated retry or Admin publication. No all-shops publication history is needed.

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
all 240 assignments and targets, verifies both French follow-up catalogue choices,
confirms preservation of an existing 120-row IMAGE cohort, retry/default replacement behavior and verifies transactional
rollback after injected target-write failure. It stops its own container. Never
point a test runner at the production database. The unit suite exercises the
onboarding entry points and the focused source/assignment regression cases.

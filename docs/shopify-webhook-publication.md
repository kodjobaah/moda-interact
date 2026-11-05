# Shopify webhook publication

The generic `/webhooks` route authenticates through the installed Shopify SDK before ingress trusts metadata. Consent alone retains the authenticated raw body to preserve exact large numeric customer IDs. Existing normalizers, API-version restrictions and Shared 3.1.0 wire schemas remain unchanged.

## Repository and publication budgets

After metadata validation, unsupported topics return 200/IGNORED with zero Shop lookups and no queue operation. Each supported topic has one repository Shop lookup selecting only id/domain/status. SDK session-storage queries are separate; this is not a one-SQL-statement HTTP claim.

An unknown or inactive Shop returns 200 with IGNORED_UNKNOWN_SHOP or IGNORED_INACTIVE_SHOP. These deliveries are discarded. There is no durable quarantine or automatic replay.

Each of the six publishers performs one Queue.add and zero Queue.getJob calls. One 3,500 ms budget starts before lazy queue acquisition and includes add/connection readiness. Acquisition, add and deadline failures retain known queue/job identity, stage, Moda code and an available original cause. The timer is cleared on completion/failure. No timeout claims to cancel Redis work: a late add can still succeed, and a retry uses the same ID. `ackMs` measures local ingress handling, not authentication plus network delivery or an end-to-end SLA.

Successful add returns `{queue, jobId, outcome: "accepted"}` and ingress emits one QUEUE_ACCEPTED outcome, including discounts. It cannot tell a new job from retained-ID acceptance without additional observation. Dashboards must not interpret QUEUE_ACCEPTED as newly created job count. HTTP is 200 only after acceptance within budget; publication failures remain 503. Unexpected DB/internal errors propagate unchanged through the route failure owner.

## Identities and delivery guarantees

- Checkout created/updated and cart activity: `shopId--createShopifyWebhookJobId(shopId, deliveryId)`.
- Order completed: `shopId--createShopifyOrderJobId(shopId, orderId)`.
- Discount and consent: their installed Shared deterministic ID helpers.

Input framing and current ID bytes, queue/job names, business payloads, trace propagation and default options remain unchanged: three attempts, exponential 1,000 ms backoff, removeOnComplete true, removeOnFail false.

BullMQ suppresses another same-ID job while that ID is retained in its queue. Auto-removal permits a replay to create another job. This remains at-least-once delivery; existing consumer durable/monotonic business guards own repeat effects. There is no new receipt, exactly-once guarantee, cancellation or consumer idempotency claim.

## Legacy producer-probe release boundary

ARCH-004-SHOPIFY-001 explicitly retained legacy/new ingress-ID checks. ARCH-003-BACKGROUND-001 separately retained pending-candidate compatibility. This change retires only the producer's legacy-ID existence lookups; current IDs stay byte-for-byte the same, and Background pending-candidate behavior is untouched.

For an intended pre-production test/staging target:

1. Stop the old ingress producer so it cannot add more legacy-format jobs.
2. Allow relevant old ingress jobs to finish with existing consumers.
3. Inspect the affected checkout-events, order-events and shopify-discount-sync queues and verify no relevant legacy-format ingress job remains before enabling the simplified producer.
4. Preserve durable rows, pending candidates, retained failed jobs and unrelated service work. A remaining legacy failed job is a transition decision, not permission to delete it.

Do not enable the new producer on a real target with live legacy jobs or a rollback requirement relying on existence probes until moda_architect resolves that concrete transition. There is no permanent compatibility flag, dual probing, automatic migration or replay.

No deployment, old-producer stop, live queue inspection or drain was performed by this source task. Historical architecture documents are not evidence that a current target is empty. Live rollout facts remain a separate deployment responsibility.

## Diagnostic ownership

- The authentication adapter owns SDK exceptions/denials; callers rethrow them unchanged.
- Generic ingress owns typed publication failures converted to 503, then emits one semantic failure outcome. It retains the already-read trusted Shop ID and known queue/job context, without another lookup.
- The generic route owns unexpected DB/internal errors that it rethrows, with database origin for actual Prisma exceptions.
- Lifecycle/scopes and best-effort activation callers retain their SHOPIFY-009 ownership of propagated publication failures. The publisher wrapper does not log another full request failure.
- A producer queue listener owns idle/late connection error events. While a queue has an active publication, that caller owns its operational failure; an actual connection error observed during a hanging add is retained for its deadline diagnostic. A timeout without such an event has no invented cause. Timeout releases request ownership even if the Redis command is still pending.

The existing semantic adapter and Shared logger own bounded error/cause projection, redaction and sink isolation. Actual source codes remain distinct from Moda reason codes; internally generated configuration/deadline failures do not invent Redis messages, statuses or causes. No connection URLs, credentials, webhook bodies, consent IDs or customer content are supplied as structured diagnostic context. No new HTTP span/metric or logging transport is introduced.

## Validation evidence boundary

`npm run test:shopify-webhooks` covers source-level Shop/add/getJob budgets, unchanged IDs and queue options, exact consent handling, deadline/final-outcome behavior and real Shared JSON privacy/sink tests. Fake timers prove bounded control flow, not Redis cancellation or end-to-end delivery.

`npm run test:shopify-webhooks:redis` opts into two suites using only task-owned redis:7.4.2-alpine containers on random loopback ports. Neither suite consumes a caller-supplied REDIS_URL/TEST_REDIS_URL. Real stored jobs prove concurrent retained-ID acceptance, tenant separation, auto-removal/replay and late-add/retry behavior. CLIENT PAUSE WRITE/UNPAUSE uses an independent control connection; no arbitrary sleep is concurrency proof. The telemetry suite checks actual producer/Worker trace continuity and unchanged business payload with instrumentation enabled/disabled. Actual protocol commands/telemetry operations are not equated with Queue.add invocation counts.

The Completion Report records exact run results, starting/final provenance, fixtures, before/after call counts, real stored-job assertions and cleanup. Local evidence logs are not evidence of live Shopify delivery or deployed consumer business idempotency.

## 2026-11-05 source-task run

Final focused validation: 168 tests across 15 files; both mandatory real Redis suites: nine tests, none skipped; existing billing diagnostic regression: five tests. Changed-file lint, typecheck, production build and whitespace checks passed. The build retains its existing non-fatal client chunk-size warning. Installed BullMQ 6.3.1, ioredis 6.0.0 and Shared 3.1.0 were unchanged; both owned containers reported Redis 7.4.2.

Same fixtures executed against starting source `407cec23dd8a0f5af6e9ead99015a12b1e86b406` and final source showed:

| Branch | Before | After |
|---|---|---|
| Unsupported topic | Shop 1, add 0, getJob 0 | Shop 0, add 0, getJob 0 |
| Supported checkout | Shop 1, add 1, getJob 2 | Shop 1, add 1, getJob 0 |
| Discount | Shop 1, add 1, getJob 1, final outcome 0 | Shop 1, add 1, getJob 0, final outcome 1 |
| All six current-ID vectors | Existing deterministic bytes | Identical bytes |

These are mocked repository/Queue invocation counts, excluding SDK storage and Redis protocol activity. Separate real Redis evidence recorded 12 concurrent successful same-ID adds plus a retained-ID replay per publisher, exactly one retained job for that ID and a distinct second-tenant job. Auto-removal permitted another accepted job after completion. An independently paused Redis write caused PUBLICATION_TIMEOUT, then the original add settled after UNPAUSE; retry accepted the same ID and one job remained. Producer/Worker trace continuity passed with instrumentation enabled; the disabled path preserved the same business contract.

Logs: `/tmp/arch057-shopify010-unit-complete.log`, `redis-final.log`, `diagnostics-final.log`, `lint-complete.log`, `types-complete.log`, `build-complete.log`, and `baseline.log`, all with the same `/tmp/arch057-shopify010-` prefix. Temporary baseline probes were removed and their test edits restored. Only owned containers/resources were cleaned up. No live target inspection/drain/deployment or consumer business-idempotency proof is claimed.

References: [BullMQ job IDs](https://docs.bullmq.io/guide/jobs/job-ids), [auto-removal](https://docs.bullmq.io/guide/queues/auto-removal-of-jobs), [Shopify HTTPS delivery handling](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries). Installed locked code and disposable tests are the runtime proof.

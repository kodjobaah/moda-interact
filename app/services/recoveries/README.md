# Recovery cohort readers

These app-local server readers do not authenticate a request. Every consuming
loader must first authenticate, resolve the owned shop/lifecycle and enforce its
merchant surface guard. Never use a browser shop ID. No routes are added here.

```ts
const query = normalizeRecoveryQuery(new URL(request.url).searchParams, merchantUi);
const page = await readRecoveryPage(shop.id, query);
const summary = await readRecoveryCohortSummary(shop.id, query);
// Overview instead uses one repeatable-read snapshot and five newest cohort rows:
const overview = await readRecoveryOverview(shop.id, query);
```

`merchantUi` is the existing merchantUiContext result. The parser reuses that
helper's zone validation/UTC fallback. It accepts from/to as inclusive ISO
calendar dates, status=all|ongoing|COMPLETED|EXPIRED|CANCELLED, q, cursor and the
optional pageSize (1–50, default 25). Missing dates default to the last 30 dates
including today. Preset controls supply explicit from/to dates. Invalid input
throws RecoveryQueryError with a stable code for the UI to localize; catch it
before invoking any reader. No new user-visible text is introduced here.

The normalized query is a frozen server object; do not deserialize it from client
JSON. Its start/end UTC strings form the same half-open detectedAt cohort for all
readers. The summary ignores list search/status/page filters. Recovery rate is an
unrounded fraction, null when empty. Counts describe latest known outcomes.
Completed checkout values remain exact decimal strings grouped by currency;
unknownValueCount includes missing price or null/blank currency. There is no
cross-currency total, and an empty recoveredValues array is not a zero value.

Pages make one parameterized SQL query with pageSize+1 rows and a safe projection.
Search matches literal case-insensitive substrings of owned customer first/last
name, combined trimmed name, or email. A customer link to a different shop is
excluded by the join. No recovery/customer histories are hydrated.

Pass previousCursor/nextCursor back with the **same** normalized dates, time zone,
status, search and pageSize. Clear cursor when filters change. Refresh reuses the
current request. Cursors carry original (detectedAt,id) keys, version, direction
and a SHA-256 binding including the authenticated shop. They are bounded opaque
encodings, not signatures or authorization tokens: forged keys can only seek
within the independently enforced owned cohort and row limit. A deleted boundary
row requires no lookup. Previous pages query ASC then reverse the bounded result.
Membership can change between requests. If a page becomes empty, the opposite
cursor preserves a path back to its original boundary.

`displayLabel` is a safe descriptor for the consuming localized
“Checkout · {merchant-local date/time}” label. IDs are route keys, not labels.
Customer null means no owned customer; displayName may be null while email exists.
No messages, URLs/tokens, line items or accounting identifiers are returned.

The overview runs exactly two queries inside a repeatable-read transaction and
clears list filters/cursor for its preview. Separate summary/list invocations are
live reads; callers needing a shared snapshot can pass one Prisma transaction
client to both. Aggregates and substring search still scale with the bounded
cohort, not constant database work. Currency-group output scales with distinct
recorded currencies, never with recovery rows. No throughput claim is made.

## Validation

```sh
npm test -- tests/unit/recovery-cohort-readers.test.ts
RECOVERY_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/moda_interact npm test -- tests/unit/recovery-cohort-readers.test.ts
npm run typecheck
git diff --check
```

The opt-in PostgreSQL test refuses non-local hosts and databases other than
moda_interact. It uses an isolated fixture schema inside a rolled-back transaction,
with a five-second statement timeout, and never writes application commerce data.
It runs the generated SQL with fixture-schema substitution and UTC timestamp
conversion matching Prisma's timestamp semantics, checks decimal sums, bounds,
foreign customer links, literal search, tied/deleted key traversal, and optionally writes
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) plans for aggregate/page/keyset/search.
Set RECOVERY_TEST_PLAN_OUTPUT to an output JSON path to capture the plans.
The tiny fixture proves query results and shape, not representative capacity.

Recorded 2026-09-20 fixture evidence lives in
`tests/fixtures/recovery-cohort-query-plans.json`: aggregate used a tenant/date
index scan, sort and aggregate; initial/keyset/search pages used a Limit over
nested-loop index scans. Each page transferred at most the requested size plus
one. These tiny-fixture choices/timings are not production performance evidence.

The focused TypeScript check is:
`./node_modules/.bin/tsc --project tests/tsconfig.recovery-readers.json`.
It checks this task's TypeScript with JS diagnostics disabled; repository-wide
`npm run typecheck` remains separately required. On the starting commit it stops
at seven syntax errors in unrelated merchant-route-access-policy.test.ts, while
imported db.server.js also has existing untyped global Prisma declarations.

The recorded database Gitlink 9c6a4d8402a01840e2ea8dc18e89171f00564d29 already
contains the integrated ARCH-019 index dependency; its full tree is identical to
architect-accepted 54c0ec2. No downgrade or redundant Gitlink change is needed.

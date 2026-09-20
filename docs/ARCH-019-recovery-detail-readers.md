# Recovery detail readers — ARCH-019-SHOPIFY-002

`app/services/recoveries/recovery-detail.server.ts` exports `readRecoveryDetail`,
`readRecoveryMessages`, and `readRelatedRecoveries`. Each takes `shopId` and
`recoveryId`; optional second argument injects a query client for tests. Callers
must authenticate, resolve the internal shop ID, and enforce RECOVERY_HISTORY
before calling. Browser shop/conversation/customer IDs are never authorization.
Route wiring and UI are SHOPIFY-004 scope.

All readers independently resolve recovery ownership. Missing/foreign recoveries
return null. Missing conversations/guest-related groups return an empty page.
A malformed cursor/window throws InvalidRecoveryDetailQuery; translate that to
localized invalid-query handling. DTOs expose nullable customer names/email,
exact decimal strings, currency, persisted milestones, and safe message fields.
No raw statusHistory reasons are exposed in this release.

Messages use 50 rows plus lookahead, default initial exchange. Pass
`window: "latest"` for the last window, or the returned `nextCursor`/
`previousCursor` as `cursor` (without window) to traverse. Responses are always
chronological. Related recoveries use five rows plus lookahead, newest first,
and accept cursor only. Null cursor means no navigation link: omit the input
property for a fresh request. Cursors bind tenant/recovery/reader and preserve
original timestamp/id coordinates, even if the boundary record is deleted.
They are not signed credentials and cannot grant ownership.

Detail uses one query. Message/related pages use at most three queries regardless
of row count: owned recovery, bounded page, two indexed EXISTS edge probes in
one query. Message selection binds the resolved conversation ID directly, avoiding
the join/sort/repeated-ownership plan found in DATABASE-001's rehearsal. The
existing database gitlink already contains the accepted indexes at 9c6a4d8.
These are live reads, not a cross-request snapshot; refresh can show changed data.

Message sender/direction/delivery/content codes use persisted Prisma enums;
unknown values return null (unknown content uses UNSUPPORTED). UI maps CUSTOMER,
AGENT, AUTOMATION and HUMAN to localized Customer, Moda assistant, Automated
message and Team member labels. Null sender means Unknown sender. Inbound delivery
is null, not a receipt. Outbound timestamps are recorded values only. AUDIO text
is returned only for COMPLETED transcription; unsuccessful/unknown states retain
a state code and no body. Render strings as escaped text nodes, never raw HTML or
Markdown. If adding links, allow only http/https and safe external-link attributes.
The reader does not fetch media, return provider IDs, or mutate read receipts.

## Validation

Fast: `npm test -- tests/unit/recovery-detail-readers.test.ts --no-cache`.
Required repository check: `npm run typecheck`.

Developer-owned actual-plan rehearsal (Docker required):

```sh
TZ=Europe/London MODA_RECOVERY_DETAIL_POSTGRES=1 npm test -- tests/integration/recovery-detail-query-plans.test.ts --no-cache
```

The opt-in suite creates its own PostgreSQL 15 container, applies the committed
migration chain and DATABASE-001 synthetic seed (20,000 recoveries / 201,980
messages), exercises actual tenant/page queries, and prints JSON EXPLAIN ANALYZE
BUFFERS for the production query builder's first/next/previous/latest SQL. It
asserts the message index is used, no sort/join, and at most 51 scanned result rows.
No default/live DATABASE_URL or existing database is used. Supply command, tested
commit, full output and exit code for review. A skipped suite is not plan evidence.

Focused TypeScript check: `npx tsc --noEmit -p tests/tsconfig.recovery-detail.json`.
This checks new TS readers and tests under the repository's strict settings while
excluding unrelated source files and disabling checking of imported legacy JS.
It does not replace the required full typecheck. At task baseline c4fd514, full
`npm run typecheck` stops on pre-existing syntax errors at lines 201/219/220 of
`tests/unit/merchant-route-access-policy.test.ts`; these differ from the older
TYPECHECK-001 baseline of 48 type errors. The task does not edit that file.


Attempt 2 fixes the test-only pg adapter: a client-local OID 1114 parser interprets
persisted timestamps as UTC, and both reader and EXPLAIN Date bindings are sent
as UTC ISO strings so pg cannot shift them to host-local wall-clock time. This
matches the production Prisma timestamp convention. Global pg parsers and
production readers are unchanged. Cheap subprocess regressions cover London,
New York and Kolkata, asserting that legacy parsing shifts the timestamp while
the corrected parser and bound wire value preserve it exactly. The opt-in suite
also asserts exact persisted timestamps in the first message window. Run the
full suite under the non-UTC zone shown above; its plan assertions are unchanged.

# ARCH-019-SHOPIFY-002 Attempt 3 PostgreSQL rehearsal

Executed 2026-09-20 with explicit user authorization in a disposable PostgreSQL container.
Tested commit: `eb343405196047e18c0537da69dd87015b9f6b38`.
Database submodule: `9c6a4d8402a01840e2ea8dc18e89171f00564d29`.
Command exit: **0**; five tests passed. PostgreSQL **15.19**.

```sh
TZ=Europe/London MODA_RECOVERY_DETAIL_POSTGRES=1 npm test -- tests/integration/recovery-detail-query-plans.test.ts --no-cache
```

Each actual message query used `ConversationMessage_conversationId_createdAt_id_idx` and read exactly 51 rows, with no Sort or Join. Shared buffers: first 4 hits, next 6, previous 5, latest 7; no reads or temporary blocks. These are fixture-specific observations, not a production latency guarantee.

The first run at `39a30e4ed2d860b3da461a4f2f58d0c539b8e043` also passed all five tests (exit 0), but the runner omitted console output. The tested revision above changes evidence output to direct stdout; query assertions and fixtures are unchanged.

## Complete command output

```text
npm warn Unknown project config "shamefully-hoist". This will stop working in the next major version of npm. See `npm help npmrc` for supported config options.

> test
> vitest run tests/integration/recovery-detail-query-plans.test.ts --no-cache


 RUN  v4.1.11 /Users/kwadwoadomafriyie/project/moda-interact-workspace.worktrees/ARCH-019-SHOPIFY-002

POSTGRES_VERSION [{"version":"PostgreSQL 15.19 on x86_64-pc-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit"}]
RECOVERY_MESSAGE_PLAN first {"Plan":{"Node Type":"Limit","Parallel Aware":false,"Async Capable":false,"Startup Cost":0.42,"Total Cost":80.59,"Plan Rows":51,"Plan Width":98,"Actual Startup Time":0.057,"Actual Total Time":1.917,"Actual Rows":51,"Actual Loops":1,"Shared Hit Blocks":4,"Shared Read Blocks":0,"Shared Dirtied Blocks":0,"Shared Written Blocks":0,"Local Hit Blocks":0,"Local Read Blocks":0,"Local Dirtied Blocks":0,"Local Written Blocks":0,"Temp Read Blocks":0,"Temp Written Blocks":0,"Plans":[{"Node Type":"Index Scan","Parent Relationship":"Outer","Parallel Aware":false,"Async Capable":false,"Scan Direction":"Forward","Index Name":"ConversationMessage_conversationId_createdAt_id_idx","Relation Name":"ConversationMessage","Alias":"ConversationMessage","Startup Cost":0.42,"Total Cost":1693.33,"Plan Rows":1077,"Plan Width":98,"Actual Startup Time":0.04,"Actual Total Time":0.832,"Actual Rows":51,"Actual Loops":1,"Index Cond":"(\"conversationId\" = 'arch019-conv-1-00001'::text)","Rows Removed by Index Recheck":0,"Shared Hit Blocks":4,"Shared Read Blocks":0,"Shared Dirtied Blocks":0,"Shared Written Blocks":0,"Local Hit Blocks":0,"Local Read Blocks":0,"Local Dirtied Blocks":0,"Local Written Blocks":0,"Temp Read Blocks":0,"Temp Written Blocks":0}]},"Planning":{"Shared Hit Blocks":0,"Shared Read Blocks":0,"Shared Dirtied Blocks":0,"Shared Written Blocks":0,"Local Hit Blocks":0,"Local Read Blocks":0,"Local Dirtied Blocks":0,"Local Written Blocks":0,"Temp Read Blocks":0,"Temp Written Blocks":0},"Planning Time":0.235,"Triggers":[],"Execution Time":2.479}
RECOVERY_MESSAGE_PLAN next {"Plan":{"Node Type":"Limit","Parallel Aware":false,"Async Capable":false,"Startup Cost":0.42,"Total Cost":15.52,"Plan Rows":5,"Plan Width":98,"Actual Startup Time":0.086,"Actual Total Time":2.339,"Actual Rows":51,"Actual Loops":1,"Shared Hit Blocks":6,"Shared Read Blocks":0,"Shared Dirtied Blocks":0,"Shared Written Blocks":0,"Local Hit Blocks":0,"Local Read Blocks":0,"Local Dirtied Blocks":0,"Local Written Blocks":0,"Temp Read Blocks":0,"Temp Written Blocks":0,"Plans":[{"Node Type":"Index Scan","Parent Relationship":"Outer","Parallel Aware":false,"Async Capable":false,"Scan Direction":"Forward","Index Name":"ConversationMessage_conversationId_createdAt_id_idx","Relation Name":"ConversationMessage","Alias":"ConversationMessage","Startup Cost":0.42,"Total Cost":15.52,"Plan Rows":5,"Plan Width":98,"Actual Startup Time":0.066,"Actual Total Time":0.626,"Actual Rows":51,"Actual Loops":1,"Index Cond":"((\"conversationId\" = 'arch019-conv-1-00001'::text) AND (ROW(\"createdAt\", id) > ROW('2026-09-01 00:02:05'::timestamp without time zone, 'arch019-m-1-00001-0500'::text)))","Rows Removed by Index Recheck":0,"Shared Hit Blocks":6,"Shared Read Blocks":0,"Shared Dirtied Blocks":0,"Shared Written Blocks":0,"Local Hit Blocks":0,"Local Read Blocks":0,"Local Dirtied Blocks":0,"Local Written Blocks":0,"Temp Read Blocks":0,"Temp Written Blocks":0}]},"Planning":{"Shared Hit Blocks":0,"Shared Read Blocks":0,"Shared Dirtied Blocks":0,"Shared Written Blocks":0,"Local Hit Blocks":0,"Local Read Blocks":0,"Local Dirtied Blocks":0,"Local Written Blocks":0,"Temp Read Blocks":0,"Temp Written Blocks":0},"Planning Time":0.671,"Triggers":[],"Execution Time":3.723}
RECOVERY_MESSAGE_PLAN previous {"Plan":{"Node Type":"Limit","Parallel Aware":false,"Async Capable":false,"Startup Cost":0.42,"Total Cost":80.75,"Plan Rows":51,"Plan Width":98,"Actual Startup Time":0.058,"Actual Total Time":1.765,"Actual Rows":51,"Actual Loops":1,"Shared Hit Blocks":5,"Shared Read Blocks":0,"Shared Dirtied Blocks":0,"Shared Written Blocks":0,"Local Hit Blocks":0,"Local Read Blocks":0,"Local Dirtied Blocks":0,"Local Written Blocks":0,"Temp Read Blocks":0,"Temp Written Blocks":0,"Plans":[{"Node Type":"Index Scan","Parent Relationship":"Outer","Parallel Aware":false,"Async Capable":false,"Scan Direction":"Backward","Index Name":"ConversationMessage_conversationId_createdAt_id_idx","Relation Name":"ConversationMessage","Alias":"ConversationMessage","Startup Cost":0.42,"Total Cost":1688.92,"Plan Rows":1072,"Plan Width":98,"Actual Startup Time":0.041,"Actual Total Time":0.589,"Actual Rows":51,"Actual Loops":1,"Index Cond":"((\"conversationId\" = 'arch019-conv-1-00001'::text) AND (ROW(\"createdAt\", id) < ROW('2026-09-01 00:02:05'::timestamp without time zone, 'arch019-m-1-00001-0500'::text)))","Rows Removed by Index Recheck":0,"Shared Hit Blocks":5,"Shared Read Blocks":0,"Shared Dirtied Blocks":0,"Shared Written Blocks":0,"Local Hit Blocks":0,"Local Read Blocks":0,"Local Dirtied Blocks":0,"Local Written Blocks":0,"Temp Read Blocks":0,"Temp Written Blocks":0}]},"Planning":{"Shared Hit Blocks":0,"Shared Read Blocks":0,"Shared Dirtied Blocks":0,"Shared Written Blocks":0,"Local Hit Blocks":0,"Local Read Blocks":0,"Local Dirtied Blocks":0,"Local Written Blocks":0,"Temp Read Blocks":0,"Temp Written Blocks":0},"Planning Time":0.168,"Triggers":[],"Execution Time":2.349}
RECOVERY_MESSAGE_PLAN latest {"Plan":{"Node Type":"Limit","Parallel Aware":false,"Async Capable":false,"Startup Cost":0.42,"Total Cost":80.59,"Plan Rows":51,"Plan Width":98,"Actual Startup Time":0.069,"Actual Total Time":2.099,"Actual Rows":51,"Actual Loops":1,"Shared Hit Blocks":7,"Shared Read Blocks":0,"Shared Dirtied Blocks":0,"Shared Written Blocks":0,"Local Hit Blocks":0,"Local Read Blocks":0,"Local Dirtied Blocks":0,"Local Written Blocks":0,"Temp Read Blocks":0,"Temp Written Blocks":0,"Plans":[{"Node Type":"Index Scan","Parent Relationship":"Outer","Parallel Aware":false,"Async Capable":false,"Scan Direction":"Backward","Index Name":"ConversationMessage_conversationId_createdAt_id_idx","Relation Name":"ConversationMessage","Alias":"ConversationMessage","Startup Cost":0.42,"Total Cost":1693.33,"Plan Rows":1077,"Plan Width":98,"Actual Startup Time":0.049,"Actual Total Time":0.714,"Actual Rows":51,"Actual Loops":1,"Index Cond":"(\"conversationId\" = 'arch019-conv-1-00001'::text)","Rows Removed by Index Recheck":0,"Shared Hit Blocks":7,"Shared Read Blocks":0,"Shared Dirtied Blocks":0,"Shared Written Blocks":0,"Local Hit Blocks":0,"Local Read Blocks":0,"Local Dirtied Blocks":0,"Local Written Blocks":0,"Temp Read Blocks":0,"Temp Written Blocks":0}]},"Planning":{"Shared Hit Blocks":0,"Shared Read Blocks":0,"Shared Dirtied Blocks":0,"Shared Written Blocks":0,"Local Hit Blocks":0,"Local Read Blocks":0,"Local Dirtied Blocks":0,"Local Written Blocks":0,"Temp Read Blocks":0,"Temp Written Blocks":0},"Planning Time":0.17,"Triggers":[],"Execution Time":2.686}

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  14:02:51
   Duration  24.51s (transform 68ms, setup 0ms, import 769ms, tests 23.53s, environment 0ms)

```

## Full repository typecheck (exit 2)

The affected baseline file is unchanged from `c4fd514`. Focused strict TypeScript validation passes.

```text
npm warn Unknown project config "shamefully-hoist". This will stop working in the next major version of npm. See `npm help npmrc` for supported config options.

> typecheck
> react-router typegen && tsc --noEmit

tests/unit/merchant-route-access-policy.test.ts(201,3): error TS1109: Expression expected.
tests/unit/merchant-route-access-policy.test.ts(201,5): error TS1434: Unexpected keyword or identifier.
tests/unit/merchant-route-access-policy.test.ts(201,13): error TS1134: Variable declaration expected.
tests/unit/merchant-route-access-policy.test.ts(201,14): error TS1134: Variable declaration expected.
tests/unit/merchant-route-access-policy.test.ts(219,3): error TS1109: Expression expected.
tests/unit/merchant-route-access-policy.test.ts(220,1): error TS1128: Declaration or statement expected.
tests/unit/merchant-route-access-policy.test.ts(220,2): error TS1128: Declaration or statement expected.
```

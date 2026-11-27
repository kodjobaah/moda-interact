import { createHash } from "node:crypto";
import { loadRecoveryDetailSeed } from "../helpers/recovery-detail-seed.mjs";
import { readFile, readdir } from "node:fs/promises";
import {
  startDisposablePostgres,
  type DisposablePostgres,
} from "../helpers/disposable-postgres";
import { Client } from "pg";
import { Prisma } from "@prisma/client";
import {
  recoveryDetailPgTypes,
  recoveryDetailPgValues,
} from "../helpers/recovery-detail-pg-utc.mjs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("../../app/db.server", () => ({ default: {} }));
import {
  createRecoveryDetailReader,
  readRecoveryMessages,
  readRecoveryDetail,
  readRelatedRecoveries,
  recoveryMessagePageSql,
  type RecoveryDetailDatabase,
} from "../../app/services/recoveries/recovery-detail.server";

// Explicit opt-in: this command provisions its own disposable container only.
const enabled = process.env.MODA_RECOVERY_DETAIL_POSTGRES === "1";
let postgres: DisposablePostgres | undefined;
let client: Client | undefined;
let db: RecoveryDetailDatabase;
const emitted: Prisma.Sql[] = [];
const own = { shopId: "arch019-shop-1", recoveryId: "arch019-r-1-00001" };

describe.skipIf(!enabled)("recovery detail actual PostgreSQL queries", () => {
  beforeAll(async () => {
    postgres = await startDisposablePostgres();
    client = new Client({
      connectionString: postgres.databaseUrl,
      types: recoveryDetailPgTypes,
    });
    await client.connect();
    const migrations = new URL(
      "../../database/prisma/migrations/",
      import.meta.url,
    );
    for (const name of (await readdir(migrations)).sort()) {
      if (/^\d/.test(name))
        await client.query(
          await readFile(new URL(`${name}/migration.sql`, migrations), "utf8"),
        );
    }
    await loadRecoveryDetailSeed(
      client,
      await readFile(
        new URL(
          "../../database/scripts/fixtures/arch019-recovery-indexes-seed.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await client.query('ANALYZE "whatsapp"."Conversation"');
    db = {
      async $queryRaw<T>(query: Prisma.Sql): Promise<T> {
        emitted.push(query);
        return (
          await client!.query(query.text, recoveryDetailPgValues(query.values))
        ).rows as T;
      },
    };
    process.stdout.write(
      `POSTGRES_VERSION ${JSON.stringify((await client.query("SELECT version()")).rows)}\n`,
    );
  }, 180_000);
  afterAll(async () => {
    try {
      await client?.end();
    } finally {
      await postgres?.cleanup();
    }
  }, 60_000);

  it("composes identical detail/sections with five data SELECTs instead of seven independent-reader SELECTs", async () => {
    emitted.length = 0;
    const detail = await readRecoveryDetail(own, db);
    const messages = await readRecoveryMessages(own, db);
    const related = await readRelatedRecoveries(own, db);
    expect(emitted).toHaveLength(7);
    const compatibilityQueries = emitted.map((query) => query.text);
    emitted.length = 0;
    const reader = (await createRecoveryDetailReader(own, db))!;
    expect(reader.detail).toEqual(detail);
    expect(await reader.readMessages()).toEqual(messages);
    expect(await reader.readRelated()).toEqual(related);
    expect(emitted).toHaveLength(5);
    expect(
      emitted.filter((query) => query.text.includes('r."lineItems"')),
    ).toHaveLength(1);
    expect(
      emitted.every((query) => query.text.trimStart().startsWith("SELECT")),
    ).toBe(true);
    process.stdout.write(
      `RECOVERY_COMPOSITION ${JSON.stringify({
        independentReaderCalls: 3,
        composedOwnerCalls: 1,
        independentSql: compatibilityQueries.length,
        composedSql: emitted.length,
        transactionStatements: 0,
        providerCalls: 0,
        messages: messages!.items.length,
        related: related!.items.length,
      })}\n`,
    );
  });

  it("retains same-shop customer and same-shop/legacy-null recovery conversation guards", async () => {
    const conversation = "arch019-conv-1-00001";
    const original = (
      await client!.query(
        'SELECT "customerId" FROM "commerce"."CheckoutRecovery" WHERE "id"=$1',
        [own.recoveryId],
      )
    ).rows[0].customerId;
    const foreign = (
      await client!.query(
        'SELECT "id" FROM "commerce"."Customer" WHERE "shopId"=$1 LIMIT 1',
        ["arch019-shop-2"],
      )
    ).rows[0].id;
    try {
      await client!.query(
        'UPDATE "whatsapp"."Conversation" SET "shopId"=$1 WHERE "id"=$2',
        ["arch019-shop-2", conversation],
      );
      expect((await readRecoveryMessages(own, db))!.items).toEqual([]);
      expect(
        (await createRecoveryDetailReader(own, db))!.detail.conversation,
      ).toBeNull();
      await client!.query(
        'UPDATE "whatsapp"."Conversation" SET "shopId"=NULL WHERE "id"=$1',
        [conversation],
      );
      expect((await readRecoveryMessages(own, db))!.items).toHaveLength(50);
      await client!.query(
        'UPDATE "commerce"."CheckoutRecovery" SET "customerId"=$1 WHERE "id"=$2',
        [foreign, own.recoveryId],
      );
      expect((await readRelatedRecoveries(own, db))!.items).toEqual([]);
      expect(
        (await createRecoveryDetailReader(own, db))!.detail.customer,
      ).toBeNull();
      expect(
        await createRecoveryDetailReader(
          { ...own, shopId: "arch019-shop-2" },
          db,
        ),
      ).toBeNull();
    } finally {
      await client!.query(
        'UPDATE "whatsapp"."Conversation" SET "shopId"=$1 WHERE "id"=$2',
        [own.shopId, conversation],
      );
      await client!.query(
        'UPDATE "commerce"."CheckoutRecovery" SET "customerId"=$1 WHERE "id"=$2',
        [original, own.recoveryId],
      );
    }
  });

  it("pages actual owned conversations and denies foreign/missing IDs", async () => {
    expect(
      await readRecoveryDetail({ ...own, shopId: "arch019-shop-2" }, db),
    ).toBeNull();
    expect(
      await readRecoveryMessages({ ...own, recoveryId: "missing" }, db),
    ).toBeNull();
    const first = (await readRecoveryMessages(own, db))!;
    expect(first.items).toHaveLength(50);
    expect(first.previousCursor).toBeNull();
    expect(first.items[0].createdAt).toBe("2026-09-01T00:00:00.000Z");
    expect(first.items[49].createdAt).toBe("2026-09-01T00:00:12.000Z");
    const second = (await readRecoveryMessages(
      { ...own, cursor: first.nextCursor },
      db,
    ))!;
    const back = (await readRecoveryMessages(
      { ...own, cursor: second.previousCursor },
      db,
    ))!;
    expect(back.items).toEqual(first.items);
    expect(
      new Set([...first.items, ...second.items].map((m) => m.id)).size,
    ).toBe(100);
    const latest = (await readRecoveryMessages(
      { ...own, window: "latest" },
      db,
    ))!;
    expect(latest.items.at(-1)?.id).toBe("arch019-m-1-00001-1000");
    expect(latest.nextCursor).toBeNull();
    const related = (await readRelatedRecoveries(own, db))!;
    expect(related.items).toHaveLength(5);
    expect(
      related.items.every(
        (r) => r.id.startsWith("arch019-r-1-") && r.id !== own.recoveryId,
      ),
    ).toBe(true);
  });

  it("reads the confirmed initial retry from real bounded SQL history without reopening follow-up or losing the verified window", async () => {
    // The fixture owns a normal recovery and a separate, exact historical
    // compensation chain. Roll back the entire fixture after forcing deferred
    // constraints to run so none of the original paging counts are changed.
    const connection = client!;
    const conversation = "arch019-conv-1-00001";
    const earlier = new Date(Date.now() - 48 * 3600_000).toISOString();
    const failedAt = new Date(Date.parse(earlier) + 1000).toISOString();
    const retryAt = new Date(Date.now() - 3600_000).toISOString();
    const due = new Date(Date.now() - 1000).toISOString();
    const account = "1234567890123",
      phone = "1234567890124";
    const original = "shopify-retry-test-original",
      intent = "shopify-retry-test-intent",
      successor = `retry_${intent}`;
    const dispatchKey = `recovery-retry-${createHash("sha256").update(successor).digest("hex")}`;
    await connection.query("BEGIN");
    try {
      await connection.query(
        `INSERT INTO "billing"."ShopEntitlementCounter"
        ("id","shopId","counter","grantedQuantity","updatedAt") VALUES ('shopify-retry-counter',$1,'LIFETIME_FREE_RECOVERY_CREDITS',2,now())`,
        [own.shopId],
      );
      await connection.query(
        `INSERT INTO "billing"."UsageEvent"
        ("id","shopId","metric","quantity","idempotencyKey","sourceType","sourceId","occurredAt")
        VALUES ('shopify-retry-debit',$1,'RECOVERY_CONVERSATION',1,'shopify-retry-debit','FREE_RECOVERY_RESERVATION','shopify-retry-reservation',$2)`,
        [own.shopId, earlier],
      );
      await connection.query(
        `INSERT INTO "billing"."UsageEvent"
        ("id","shopId","metric","quantity","idempotencyKey","sourceType","sourceId","correctionOfUsageEventId","occurredAt")
        VALUES ('shopify-retry-correction',$1,'RECOVERY_CONVERSATION',-1,'shopify-retry-correction','RECOVERY_UNDELIVERABLE_COMPENSATION','shopify-retry-reservation','shopify-retry-debit',$2)`,
        [own.shopId, failedAt],
      );
      await connection.query(
        `INSERT INTO "billing"."UsageReservation"
        ("id","shopId","counterId","sourceKey","quantity","status","committedUsageEventId","compensationUsageEventId",
          "compensationReason","compensationDisposition","compensatedAt","updatedAt")
        VALUES ('shopify-retry-reservation',$1,'shopify-retry-counter','shopify-retry-source',1,'COMMITTED','shopify-retry-debit',
          'shopify-retry-correction','WHATSAPP_DELIVERY_FAILED','RESTORED_SPENDABLE',$2,now())`,
        [own.shopId, failedAt],
      );
      await connection.query(
        `INSERT INTO "whatsapp"."ConversationMessage"
        ("id","conversationId","direction","senderType","status","content","providerMessageId","sentAt","failedAt",
         "providerFailureCode","dispatchProviderAccountId","dispatchProviderPhoneNumberId")
        VALUES ('shopify-retry-original-message',$1,'OUTBOUND','AUTOMATION','FAILED','Original failed','wamid.shopify-retry-original',$2,$3,'131016',$4,$5)`,
        [conversation, earlier, failedAt, account, phone],
      );
      await connection.query(
        `INSERT INTO "commerce"."RecoveryOutreachAttempt"
        ("id","checkoutRecoveryId","recipient","sequence","trigger","status","configuredOfferMode","sentAt","outboundMessageId","followUpDueAt","updatedAt")
        VALUES ($1,$2,'447700900001',1,'INITIAL','FAILED','NONE',$3,'shopify-retry-original-message',$3,now())`,
        [original, own.recoveryId, earlier],
      );
      await connection.query(
        `INSERT INTO "commerce"."RecoveryOutreachRetryIntent"
        ("id","failedAttemptId","failedMessageId","fundingReservationId","policy","notBeforeAt","expectedGeneration","expectedLastExternalActivityAt","updatedAt")
        SELECT $1,$2,'shopify-retry-original-message','shopify-retry-reservation','AFTER_COOLDOWN',$3,r."generation",r."lastExternalActivityAt",now()
        FROM "commerce"."CheckoutRecovery" r WHERE r."id"=$4`,
        [intent, original, retryAt, own.recoveryId],
      );
      await connection.query(
        `INSERT INTO "whatsapp"."ConversationMessage"
        ("id","conversationId","direction","senderType","status","content","providerMessageId","sentAt","providerDispatchKey",
         "providerDispatchAdmittedAt","providerDispatchControlRevision","dispatchProviderAccountId","dispatchProviderPhoneNumberId")
        VALUES ('shopify-retry-successor-message',$1,'OUTBOUND','AUTOMATION','SENT','Retry accepted','wamid.shopify-retry-successor',
          ($2::timestamptz AT TIME ZONE 'UTC'),$3,$2::timestamptz,0,$4,$5)`,
        [conversation, retryAt, dispatchKey, account, phone],
      );
      await connection.query(
        `INSERT INTO "commerce"."RecoveryOutreachAttempt"
        ("id","checkoutRecoveryId","recipient","sequence","trigger","status","configuredOfferMode","sentAt","outboundMessageId","followUpDueAt","updatedAt")
        VALUES ($1,$2,'447700900001',3,'INITIAL','WAITING_FOR_RESPONSE','NONE',$3,'shopify-retry-successor-message',$4,now())`,
        [successor, own.recoveryId, retryAt, due],
      );
      await connection.query("SET CONSTRAINTS ALL IMMEDIATE");
      expect(
        (await readRecoveryDetail(own, db))!.conversation?.followUp.eligible,
      ).toBe(false);
      await connection.query(
        `UPDATE "whatsapp"."ConversationMessage" SET "status"='DELIVERED', "deliveredAt"=$1 WHERE "id"='shopify-retry-successor-message'`,
        [retryAt],
      );
      emitted.length = 0;
      const delivered = (await readRecoveryDetail(own, db))!;
      expect(emitted).toHaveLength(1);
      expect(delivered.initialOutreachSentAt).toBe(retryAt);
      expect(delivered.conversation?.followUp).toMatchObject({
        used: false,
        eligible: true,
      });
      await connection.query(
        `INSERT INTO "whatsapp"."ConversationMessage"
        ("id","conversationId","direction","senderType","status","content","providerMessageId","createdAt")
        VALUES ('shopify-retry-inbound',$1,'INBOUND','CUSTOMER','DELIVERED','Reply','wamid.shopify-retry-inbound',$2)`,
        [conversation, due],
      );
      const replied = (await readRecoveryDetail(own, db))!;
      expect(replied.conversation?.lastInboundAt).toBe(due);
      expect(replied.conversation?.followUp.eligible).toBe(false);
      await connection.query(
        `INSERT INTO "commerce"."RecoveryOutreachAttempt"
        ("id","checkoutRecoveryId","recipient","sequence","trigger","status","configuredOfferMode","initiatedBy","initiationKey","claimedAt","updatedAt")
        VALUES ('shopify-retry-follow-up',$1,'447700900001',2,'NO_RESPONSE_FOLLOW_UP','PENDING','NONE','AUTOMATION','shopify-retry-follow-up',$2,now())`,
        [own.recoveryId, due],
      );
      expect(
        (await readRecoveryDetail(own, db))!.conversation?.followUp,
      ).toMatchObject({
        used: true,
        initiatedBy: "AUTOMATION",
        eligible: false,
      });
      await connection.query(
        `UPDATE "whatsapp"."ConversationMessage" SET "status"='READ', "readAt"=$1 WHERE "id"='shopify-retry-original-message'`,
        [retryAt],
      );
      expect(
        (await readRecoveryDetail(own, db))!.conversation?.followUp.eligible,
      ).toBe(false);
      expect(
        await readRecoveryDetail({ ...own, shopId: "arch019-shop-2" }, db),
      ).toBeNull();
    } finally {
      await connection.query("ROLLBACK");
    }
  });

  it.each(["first", "next", "previous", "latest"] as const)(
    "%s event plan bounds each source to 51 rows",
    async (direction) => {
      const query = recoveryMessagePageSql(
        "arch019-shop-1",
        "arch019-conv-1-00001",
        {
          direction,
          boundary:
            direction === "next" || direction === "previous"
              ? { id: "arch019-m-1-00001-0500", at: "2026-09-01T00:02:05.000Z" }
              : null,
        },
      );
      const result = await client!.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.text}`,
        recoveryDetailPgValues(query.values),
      );
      const plan = result.rows[0]["QUERY PLAN"][0];
      process.stdout.write(
        `RECOVERY_MESSAGE_PLAN ${direction} ${JSON.stringify(plan)}\n`,
      );
      const nodes: Record<string, unknown>[] = [];
      function visit(node: Record<string, unknown>) {
        nodes.push(node);
        for (const child of (node.Plans ?? []) as Record<string, unknown>[])
          visit(child);
      }
      visit(plan.Plan);
      // A bounded sort/merge of at most 102 source rows is allowed. Both indexed
      // sources have their own LIMIT 51; there must not be a full-page cross join.
      expect(query.text).toContain("UNION ALL");
      expect(query.text.match(/LIMIT 51/gu) ?? []).toHaveLength(3);
      const scans = nodes.filter((n) =>
        String(n["Node Type"]).includes("Scan"),
      );
      const pageScans = scans.filter(
        (n) => n["Relation Name"] === "ConversationMessage",
      );
      expect(pageScans).toHaveLength(1);
      expect(pageScans[0]["Index Name"]).toBe(
        "ConversationMessage_conversationId_createdAt_id_idx",
      );
      expect(Number(pageScans[0]["Actual Rows"])).toBeLessThanOrEqual(51);
      expect(Number(pageScans[0]["Actual Rows"])).toBeGreaterThan(0);
      const commandScans = scans.filter(
        (n) =>
          n["Relation Name"] === "MerchantConversationSendCommand" &&
          n["Index Name"] === "MerchantSend_shop_conversation_idx",
      );
      expect(commandScans.length).toBeLessThanOrEqual(1);
      expect(commandScans.every((n) => Number(n["Actual Rows"]) <= 51)).toBe(
        true,
      );
    },
  );

  it("persists command-only attempts in the same ordered transcript without a fabricated provider message", async () => {
    const commandId = "arch040-command-only-fixture";
    await client!.query(
      `INSERT INTO "whatsapp"."MerchantConversationSendCommand"
      ("id", "shopId", "conversationId", "idempotencyKey", "payloadSha256", "expectedControlRevision",
       "kind", "recipientSnapshot", "textBody", "createdAt", "acceptedAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, 0, 'HUMAN_TEXT', $6, $7, $8, $8, $8)`,
      [
        commandId,
        own.shopId,
        "arch019-conv-1-00001",
        "fixture-command-only-1",
        "a".repeat(64),
        "+447700900000",
        "Reply rejected before WhatsApp dispatch",
        "2026-10-20T12:14:00.000Z",
      ],
    );
    try {
      const admitted = (await readRecoveryMessages(
        { ...own, window: "latest" },
        db,
      ))!;
      expect(admitted.items.at(-1)).toMatchObject({
        id: commandId,
        sender: "HUMAN",
        direction: "OUTBOUND",
        content: { text: "Reply rejected before WhatsApp dispatch" },
        delivery: { status: null, commandState: "ACCEPTED" },
      });
      await client!.query(
        `UPDATE "whatsapp"."MerchantConversationSendCommand"
        SET "state"='CANCELLED', "failureCode"='human_moderation_review_required',
          "completedAt"=now(), "updatedAt"=now() WHERE "id"=$1`,
        [commandId],
      );
      const rejected = (await readRecoveryMessages(
        { ...own, window: "latest" },
        db,
      ))!;
      expect(
        rejected.items.filter((message) => message.id === commandId),
      ).toHaveLength(1);
      expect(rejected.items.at(-1)?.delivery?.commandState).toBe("CANCELLED");
      expect(rejected.items.at(-1)?.delivery?.status).toBeNull();
    } finally {
      await client!.query(
        `DELETE FROM "whatsapp"."MerchantConversationSendCommand" WHERE "id"=$1`,
        [commandId],
      );
    }
  });
});

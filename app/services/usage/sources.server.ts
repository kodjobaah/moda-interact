import { Prisma, type PrismaClient } from "@prisma/client";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import prisma from "../../db.server";

export type SourceRecovery = {
  recoveryId: string;
  detectedAt: string;
  customerName: string | null;
};
/** Resolve only the current page, through the persisted original debit and its
 * committed reservation. A correction never supplies its own recovery identity.
 * Keep legacy direct checkout/conversation/message IDs as independent evidence.
 * The four indexed branches share one bounded database round trip. */
export async function readUsageSources(
  shopId: string,
  eventIds: string[],
  database: Pick<PrismaClient, "$queryRaw"> = prisma,
): Promise<Map<string, SourceRecovery>> {
  if (!eventIds.length) return new Map();
  if (eventIds.length > 100) throw new Error("Usage page exceeds source limit");
  const ids = Prisma.join([...new Set(eventIds)]);
  const prefix = `recovery:${shopId}:`;
  const rows = await database.$queryRaw<
    Array<{
      eventId: string;
      recoveryId: string;
      detectedAt: Date;
      firstName: string | null;
      lastName: string | null;
      email: string | null;
      logicalKey: string | null;
      logicalIdentity: string | null;
    }>
  >(Prisma.sql`
    WITH originals AS (
      SELECT e."id" AS "eventId", o."id" AS "debitId", o."sourceId", o."billingPeriodId"
      FROM billing."UsageEvent" e
      JOIN billing."UsageEvent" o ON o."id" = COALESCE(e."correctionOfUsageEventId", e."id")
        AND o."shopId" = ${shopId} AND o."provider" = 'SHOPIFY'
        AND o."metric" = 'RECOVERY_CONVERSATION' AND o."correctionOfUsageEventId" IS NULL
      WHERE e."id" IN (${ids}) AND e."shopId" = ${shopId}
        AND e."provider" = 'SHOPIFY' AND e."metric" = 'RECOVERY_CONVERSATION'
    ), reservation_keys AS (
      SELECT o."eventId", CASE
        WHEN u."billingPeriodEntitlementCounterId" IS NULL THEN u."sourceKey"
        WHEN p."shopId" = ${shopId} AND p."counter" = 'INCLUDED_RECOVERY_CREDITS'
          AND p."billingPeriodId" = o."billingPeriodId"
          AND left(u."sourceKey", length('paid-included:' || p."billingPeriodId" || ':'))
            = 'paid-included:' || p."billingPeriodId" || ':'
        THEN substr(u."sourceKey", length('paid-included:' || p."billingPeriodId" || ':') + 1)
        ELSE NULL END AS "logicalKey"
      FROM originals o JOIN billing."UsageReservation" u ON u."committedUsageEventId" = o."debitId"
        AND u."shopId" = ${shopId} AND u."status" = 'COMMITTED'
      LEFT JOIN billing."BillingPeriodEntitlementCounter" p ON p."id" = u."billingPeriodEntitlementCounterId"
    ), identities AS (
      -- Locate readable keys only; re-encode with the Shared codec before
      -- accepting the candidate. Hashed keys cannot be reversed safely.
      SELECT "eventId", "logicalKey", substr("logicalKey", length(${prefix}::text) + 1) AS "identity"
      FROM reservation_keys WHERE left("logicalKey", length(${prefix}::text)) = ${prefix}
        AND length("logicalKey") <= 255
    ), sources AS (
      SELECT o."eventId", r."id" AS "recoveryId", r."detectedAt", r."customerId",
        NULL::text AS "logicalKey", NULL::text AS "logicalIdentity"
      FROM originals o JOIN commerce."CheckoutRecovery" r ON r."id" = o."sourceId" AND r."shopId" = ${shopId}
      UNION ALL
      SELECT o."eventId", r."id", r."detectedAt", r."customerId", NULL::text, NULL::text
      FROM originals o JOIN whatsapp."Conversation" c ON c."id" = o."sourceId"
      JOIN commerce."CheckoutRecovery" r ON r."id" = c."checkoutRecoveryId" AND r."shopId" = ${shopId}
      WHERE (c."shopId" IS NULL OR c."shopId" = ${shopId})
      UNION ALL
      SELECT o."eventId", r."id", r."detectedAt", r."customerId", NULL::text, NULL::text
      FROM originals o JOIN whatsapp."ConversationMessage" m ON m."id" = o."sourceId"
      JOIN whatsapp."Conversation" c ON c."id" = m."conversationId"
      JOIN commerce."CheckoutRecovery" r ON r."id" = c."checkoutRecoveryId" AND r."shopId" = ${shopId}
      WHERE (c."shopId" IS NULL OR c."shopId" = ${shopId})
      UNION ALL
      SELECT i."eventId", r."id", r."detectedAt", r."customerId", i."logicalKey", i."identity"
      FROM identities i
      LEFT JOIN commerce."RecoveryOutreachAttempt" a ON i."identity" ~ '^recovery-outreach:[A-Za-z0-9_-]{1,191}$'
        AND a."id" = substr(i."identity", length('recovery-outreach:') + 1)
      JOIN commerce."CheckoutRecovery" r ON r."shopId" = ${shopId} AND r."id" = CASE
        WHEN i."identity" ~ '^recovery-outreach:[A-Za-z0-9_-]{1,191}$' THEN a."checkoutRecoveryId"
        WHEN i."identity" ~ '^[A-Za-z0-9_-]{1,191}$' AND i."identity" !~* '^h[0-9a-f]{16}$'
          THEN i."identity" ELSE NULL END
    )
    SELECT s."eventId", s."recoveryId", s."detectedAt", c."firstName", c."lastName", c."email",
      s."logicalKey", s."logicalIdentity"
    FROM sources s LEFT JOIN commerce."Customer" c ON c."id" = s."customerId" AND c."shopId" = ${shopId}
    WHERE (s."customerId" IS NULL OR c."id" IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM whatsapp."Conversation" foreign_conversation
        WHERE foreign_conversation."checkoutRecoveryId" = s."recoveryId"
          AND foreign_conversation."shopId" IS NOT NULL AND foreign_conversation."shopId" <> ${shopId})
    LIMIT 401`);
  if (rows.length > 400) throw new Error("Usage source result exceeds page limit");
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.logicalKey !== null && (!row.logicalIdentity ||
      createRecoveryIdempotencyKey(shopId, row.logicalIdentity) !== row.logicalKey)) continue;
    grouped.set(row.eventId, [...(grouped.get(row.eventId) ?? []), row]);
  }
  const result = new Map<string, SourceRecovery>();
  for (const [id, matches] of grouped) {
    if (new Set(matches.map((row) => row.recoveryId)).size !== 1) continue;
    const row = matches[0];
    result.set(id, {
      recoveryId: row.recoveryId,
      detectedAt: row.detectedAt.toISOString(),
      customerName:
        [row.firstName?.trim(), row.lastName?.trim()]
          .filter(Boolean)
          .join(" ") ||
        row.email ||
        null,
    });
  }
  return result;
}

import { Prisma } from "@prisma/client";
import { MAX_OUTREACH_HISTORY } from "./merchant-outreach.server";

/** A bounded, tenant-owned projection in the same SELECT as recovery detail.
 * No message bodies, provider responses, offer snapshots or credentials are
 * collected. Prisma's timestamp-without-zone fields represent UTC. Include an
 * explicit zone in the JSON so server/driver timezones cannot change deadlines. */
export const outreachHistorySql = Prisma.sql`COALESCE((SELECT jsonb_agg(history.payload ORDER BY history.sequence) FROM (
  SELECT a."sequence" AS sequence, jsonb_build_object(
    'id', a."id", 'checkoutRecoveryId', a."checkoutRecoveryId", 'sequence', a."sequence",
    'trigger', a."trigger", 'recipient', a."recipient", 'status', a."status",
    'initiatedBy', a."initiatedBy", 'initiationKey', a."initiationKey", 'claimedAt', a."claimedAt",
    'sentAt', a."sentAt" AT TIME ZONE 'UTC', 'followUpDueAt', a."followUpDueAt" AT TIME ZONE 'UTC',
    'customerRespondedAt', a."customerRespondedAt" AT TIME ZONE 'UTC', 'outboundMessageId', a."outboundMessageId",
    'outboundMessage', CASE WHEN m."id" IS NULL THEN NULL ELSE jsonb_build_object(
      'id', m."id", 'conversationId', m."conversationId", 'direction', m."direction",
      'senderType', m."senderType", 'status', m."status", 'providerMessageId', m."providerMessageId",
      'sentAt', m."sentAt" AT TIME ZONE 'UTC', 'deliveredAt', m."deliveredAt" AT TIME ZONE 'UTC',
      'readAt', m."readAt" AT TIME ZONE 'UTC', 'failedAt', m."failedAt" AT TIME ZONE 'UTC',
      'providerDispatchKey', m."providerDispatchKey", 'providerDispatchAdmittedAt', m."providerDispatchAdmittedAt",
      'providerDispatchControlRevision', m."providerDispatchControlRevision",
      'dispatchProviderAccountId', m."dispatchProviderAccountId", 'dispatchProviderPhoneNumberId', m."dispatchProviderPhoneNumberId"
    ) END,
    'deliveryRetryIntent', CASE WHEN intent."id" IS NULL THEN NULL ELSE jsonb_build_object(
      'id', intent."id", 'failedAttemptId', intent."failedAttemptId", 'failedMessageId', intent."failedMessageId",
      'cancelledAt', intent."cancelledAt"
    ) END
  ) AS payload FROM "commerce"."RecoveryOutreachAttempt" a
  LEFT JOIN "whatsapp"."ConversationMessage" m ON m."id"=a."outboundMessageId" AND m."conversationId"=v."id"
  LEFT JOIN "commerce"."RecoveryOutreachRetryIntent" intent ON intent."failedAttemptId"=a."id"
  WHERE a."checkoutRecoveryId"=r."id"
  ORDER BY a."sequence" ASC LIMIT ${Prisma.raw(String(MAX_OUTREACH_HISTORY + 1))}
) history), '[]'::jsonb)`;

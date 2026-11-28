import { Prisma } from "@prisma/client";
import {
  MAX_OUTREACH_HISTORY,
  type MerchantOutreachScope,
} from "./merchant-outreach.server";

const merchantAttemptSelect = {
  id: true,
  checkoutRecoveryId: true,
  sequence: true,
  trigger: true,
  recipient: true,
  initiatedBy: true,
  initiationKey: true,
  claimedAt: true,
  followUpDueAt: true,
  status: true,
  sentAt: true,
  customerRespondedAt: true,
  outboundMessageId: true,
  configuredOfferMode: true,
  fixedShopifyDiscountId: true,
  offerSnapshot: true,
  outboundMessage: {
    select: {
      id: true,
      conversationId: true,
      direction: true,
      senderType: true,
      status: true,
      providerMessageId: true,
      providerDispatchKey: true,
      providerDispatchAdmittedAt: true,
      providerDispatchControlRevision: true,
      dispatchProviderAccountId: true,
      dispatchProviderPhoneNumberId: true,
      sentAt: true,
      deliveredAt: true,
      readAt: true,
      failedAt: true,
    },
  },
  deliveryRetryIntent: {
    select: {
      id: true,
      failedAttemptId: true,
      failedMessageId: true,
      cancelledAt: true,
    },
  },
} as const satisfies Prisma.RecoveryOutreachAttemptSelect;

/** The command owner already holds the Shop and Conversation locks. Lock
 * physical history in the same sequence order as the Woo merchant API. */
export async function readLockedMerchantOutreach(
  tx: Prisma.TransactionClient,
  scope: MerchantOutreachScope,
) {
  await tx.$queryRaw(Prisma.sql`
    SELECT a."id" FROM "commerce"."RecoveryOutreachAttempt" a
    JOIN "commerce"."CheckoutRecovery" r ON r."id"=a."checkoutRecoveryId"
    WHERE a."checkoutRecoveryId"=${scope.recoveryId} AND r."shopId"=${scope.shopId}
    ORDER BY a."sequence" ASC LIMIT ${MAX_OUTREACH_HISTORY + 1} FOR UPDATE OF a`);
  return tx.recoveryOutreachAttempt.findMany({
    where: {
      checkoutRecoveryId: scope.recoveryId,
      checkoutRecovery: { shopId: scope.shopId },
    },
    orderBy: { sequence: "asc" },
    take: MAX_OUTREACH_HISTORY + 1,
    select: merchantAttemptSelect,
  });
}

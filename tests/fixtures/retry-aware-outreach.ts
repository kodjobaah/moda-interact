import { createHash } from "node:crypto";
import type {
  MerchantOutreachAttempt,
  MerchantOutreachScope,
} from "../../app/services/recoveries/merchant-outreach.server";
import type { OutreachHistoryRow } from "../../app/services/recoveries/outreach-history-wire";

export type AttemptFixture = MerchantOutreachAttempt & {
  configuredOfferMode: "NONE" | "FIXED" | "AI_BEST_APPLICABLE";
  fixedShopifyDiscountId: string | null;
  offerSnapshot: Record<string, string> | null;
};
export const scope: MerchantOutreachScope = {
  shopId: "shop-1",
  recoveryId: "recovery-1",
  conversationId: "conversation-1",
  platform: "SHOPIFY",
};
export function outreachAttempt(
  owner: MerchantOutreachScope,
  sequence: number,
  sentAt: Date | null,
  changes: Partial<AttemptFixture> = {},
): AttemptFixture {
  const id = sequence <= 2 ? `attempt-${sequence}` : `retry_intent-${sequence}`;
  const messageId = sentAt ? `message-${sequence}` : null;
  return {
    id,
    checkoutRecoveryId: owner.recoveryId,
    sequence,
    trigger: sequence === 2 ? "NO_RESPONSE_FOLLOW_UP" : "INITIAL",
    recipient: "+447700900001",
    status: sentAt ? "WAITING_FOR_RESPONSE" : "PENDING",
    sentAt,
    followUpDueAt: null,
    customerRespondedAt: null,
    initiatedBy: null,
    initiationKey: null,
    claimedAt: null,
    outboundMessageId: messageId,
    outboundMessage:
      sentAt && messageId
        ? {
            id: messageId,
            conversationId: owner.conversationId,
            direction: "OUTBOUND",
            senderType: "AUTOMATION",
            status: "SENT",
            providerMessageId: `provider-${sequence}`,
            sentAt,
            deliveredAt: null,
            readAt: null,
            failedAt: null,
            providerDispatchKey: `recovery-retry-${createHash("sha256").update(id).digest("hex")}`,
            providerDispatchAdmittedAt: sentAt,
            providerDispatchControlRevision: 0,
            dispatchProviderAccountId: "1234567890",
            dispatchProviderPhoneNumberId: "1234567891",
          }
        : null,
    deliveryRetryIntent: null,
    configuredOfferMode: "NONE",
    fixedShopifyDiscountId: null,
    offerSnapshot: null,
    ...changes,
  };
}
export function retryHistory(
  owner: MerchantOutreachScope,
  originalAt: Date,
  retryAt: Date,
  due: Date,
  slot: "INITIAL" | "FOLLOW_UP" = "INITIAL",
) {
  const sequence = slot === "INITIAL" ? 1 : 2;
  const trigger = slot === "INITIAL" ? "INITIAL" : "NO_RESPONSE_FOLLOW_UP";
  const claim =
    slot === "INITIAL"
      ? {}
      : {
          initiatedBy: "AUTOMATION" as const,
          initiationKey: "scheduled",
          claimedAt: originalAt,
        };
  const original = outreachAttempt(owner, sequence, originalAt, {
    trigger,
    ...claim,
  });
  const retry = outreachAttempt(owner, 3, retryAt, {
    trigger,
    followUpDueAt: due,
    ...claim,
    ...(slot === "FOLLOW_UP"
      ? { initiationKey: "retry", claimedAt: retryAt }
      : {}),
  });
  return {
    failed: {
      ...original,
      status: "FAILED",
      outboundMessage: {
        ...original.outboundMessage!,
        status: "FAILED",
        failedAt: originalAt,
      },
      deliveryRetryIntent: {
        id: "intent-3",
        failedAttemptId: original.id,
        failedMessageId: original.outboundMessageId!,
        cancelledAt: null,
      },
    },
    delivered: {
      ...retry,
      outboundMessage: {
        ...retry.outboundMessage!,
        status: "DELIVERED",
        deliveredAt: retryAt,
      },
    },
    accepted: retry,
  };
}
/** Model the exact JSON result returned by the SQL reader, not an alternate
 * pre-computed eligibility decision. JSON converts persisted Dates to UTC. */
export function wireHistory(
  attempts: readonly MerchantOutreachAttempt[],
): OutreachHistoryRow[] {
  return JSON.parse(JSON.stringify(attempts)) as OutreachHistoryRow[];
}

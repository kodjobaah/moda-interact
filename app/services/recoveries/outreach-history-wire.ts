import type { MerchantOutreachAttempt } from "./merchant-outreach.server";

type JsonDates<T> = {
  [K in keyof T]: T[K] extends Date | null ? string | null : T[K];
};
type Message = NonNullable<MerchantOutreachAttempt["outboundMessage"]>;
type Intent = NonNullable<MerchantOutreachAttempt["deliveryRetryIntent"]>;
export type OutreachHistoryRow = Omit<
  JsonDates<MerchantOutreachAttempt>,
  "outboundMessage" | "deliveryRetryIntent"
> & {
  outboundMessage: JsonDates<Message> | null;
  deliveryRetryIntent: JsonDates<Intent> | null;
};

function date(value: string | null): Date | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/(?:Z|[+-]\d\d:\d\d)$/.test(value))
    throw new Error("recovery_outreach_timestamp_invalid");
  const result = new Date(value);
  if (!Number.isFinite(result.getTime()))
    throw new Error("recovery_outreach_timestamp_invalid");
  return result;
}

export function decodeOutreachHistory(
  rows: readonly OutreachHistoryRow[],
): MerchantOutreachAttempt[] {
  if (!Array.isArray(rows))
    throw new Error("recovery_outreach_history_invalid");
  return rows.map((row) => ({
    ...row,
    sentAt: date(row.sentAt),
    claimedAt: date(row.claimedAt),
    customerRespondedAt: date(row.customerRespondedAt),
    followUpDueAt: date(row.followUpDueAt),
    outboundMessage: row.outboundMessage && {
      ...row.outboundMessage,
      sentAt: date(row.outboundMessage.sentAt),
      deliveredAt: date(row.outboundMessage.deliveredAt),
      readAt: date(row.outboundMessage.readAt),
      failedAt: date(row.outboundMessage.failedAt),
      providerDispatchAdmittedAt: date(
        row.outboundMessage.providerDispatchAdmittedAt,
      ),
    },
    deliveryRetryIntent: row.deliveryRetryIntent && {
      ...row.deliveryRetryIntent,
      cancelledAt: date(row.deliveryRetryIntent.cancelledAt),
    },
  }));
}

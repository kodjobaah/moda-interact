/** A verified customer reply opens a rolling WhatsApp free-text window. */
export const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The caller must select inbound evidence with a non-null provider message ID.
 * These additional bounds keep advisory and transactional admission consistent.
 */
export function customerServiceWindow(
  initialSentAt: Date | null | undefined,
  verifiedInboundAt: Date | null | undefined,
  now: Date,
) {
  const lastInboundAt = initialSentAt && verifiedInboundAt &&
    verifiedInboundAt >= initialSentAt && verifiedInboundAt <= now
    ? verifiedInboundAt : null;
  const expiresAt = lastInboundAt ? new Date(lastInboundAt.getTime() + CUSTOMER_SERVICE_WINDOW_MS) : null;
  return { lastInboundAt, expiresAt, open: Boolean(expiresAt && now < expiresAt) };
}

/** Sequence one's durable due time snapshots the effective configured follow-up.
 * Null means disabled or unscheduled; do not derive a new deadline from current settings.
 */
export function configuredFollowUpIsDue(
  initialSentAt: Date | null | undefined,
  followUpDueAt: Date | null | undefined,
  now: Date,
) {
  return Boolean(initialSentAt && initialSentAt <= now && followUpDueAt && followUpDueAt <= now);
}

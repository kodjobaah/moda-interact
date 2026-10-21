import { describe, expect, it } from "vitest";
import { configuredFollowUpIsDue, customerServiceWindow } from "../../app/services/recoveries/recovery-service-window";

const start = new Date("2026-10-20T10:00:00.000Z");
const hour = 3_600_000;
const day = 24 * hour;

describe("ARCH-040 verified customer service-window policy", () => {
  it("only verified in-range dates are admitted by the shared window rule", () => {
    const now = new Date(start.getTime() + hour);
    for (const invalid of [null, new Date(start.getTime() - 1), new Date(now.getTime() + 1)]) {
      expect(customerServiceWindow(start, invalid, now)).toEqual({ lastInboundAt: null, expiresAt: null, open: false });
    }
    expect(customerServiceWindow(null, now, now).open).toBe(false);
    expect(customerServiceWindow(start, start, now).open).toBe(true);
  });

  it("expires exactly at the boundary and renews on a newer verified customer reply", () => {
    const initialReply = new Date(start.getTime() + hour);
    const expiry = new Date(initialReply.getTime() + day);
    expect(customerServiceWindow(start, initialReply, new Date(expiry.getTime() - 1)).open).toBe(true);
    expect(customerServiceWindow(start, initialReply, expiry).open).toBe(false);
    expect(customerServiceWindow(start, initialReply, expiry).expiresAt).toEqual(expiry);
    const renewed = new Date(expiry.getTime() - 10_000);
    expect(customerServiceWindow(start, renewed, expiry).open).toBe(true);
  });

  it("uses only the saved due time, without inventing a follow-up deadline", () => {
    for (const minutes of [15, 60, 48 * 60]) {
      const due = new Date(start.getTime() + minutes * 60_000);
      expect(configuredFollowUpIsDue(start, due, new Date(due.getTime() - 1))).toBe(false);
      expect(configuredFollowUpIsDue(start, due, due)).toBe(true);
    }
    expect(configuredFollowUpIsDue(start, null, new Date(start.getTime() + 4 * day))).toBe(false);
    expect(configuredFollowUpIsDue(null, start, new Date(start.getTime() + 4 * day))).toBe(false);
    expect(configuredFollowUpIsDue(new Date(start.getTime() + day), start, start)).toBe(false);
  });
});

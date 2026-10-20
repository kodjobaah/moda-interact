import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MerchantCommandStatus, isTerminalMerchantCommandState } from "../../app/routes/app/recovery-detail/merchant-command-status";
import { RecoveryMessageList } from "../../app/routes/app/recovery-detail/recovery-message-list";
import { createMerchantI18n } from "../../app/utils/merchant-i18n";
import { recoveryMessageDto, type RecoveryMessageRow } from "../../app/services/recoveries/detail-message";
import type { Translate } from "../../app/routes/app/recovery-detail/recovery-ui-types";

// Translation keys make state precedence independently testable across all locales.
const t = ((key: string) => key) as Translate;
const render = (overrides: Partial<Parameters<typeof MerchantCommandStatus>[0]> = {}) =>
  renderToStaticMarkup(createElement(MerchantCommandStatus, {
    commandId: "command-1", moderation: "PENDING", deliveryState: "ACCEPTED",
    providerStatus: null, statusBusy: false, onRefresh: vi.fn(), t, ...overrides,
  }));

describe("ARCH-040 merchant reply status presentation", () => {
  it("displays checks while an accepted command awaits moderation", () => {
    const html = render();
    expect(html).toContain("recoveryDetail.moderationChecking");
    expect(html).toContain("recoveryDetail.queuedNotSent");
    expect(html).not.toContain("recoveryDetail.sendFailed");
  });

  it("does not describe a failed command as still checking", () => {
    const html = render({ deliveryState: "FAILED" });
    expect(html).toContain("recoveryDetail.sendStatus.FAILED");
    expect(html).toContain("recoveryDetail.sendFailed");
    expect(html).not.toContain("recoveryDetail.moderationChecking");
  });

  it("treats UNKNOWN as an uncertain outcome, not a failed send", () => {
    const html = render({ deliveryState: "UNKNOWN" });
    expect(html).toContain("recoveryDetail.sendStatus.UNKNOWN");
    expect(html).not.toContain("recoveryDetail.sendFailed");
    expect(html).not.toContain("recoveryDetail.moderationChecking");
  });

  it("uses the observed provider outcome over stale pending moderation", () => {
    const html = render({ deliveryState: "DISPATCH_ADMITTED", providerStatus: "DELIVERED" });
    expect(html).toContain("recoveryDetail.sendStatus.DELIVERED");
    expect(html).not.toContain("recoveryDetail.moderationChecking");
    expect(html).not.toContain("recoveryDetail.sendFailed");
  });
});

// A status code is rendered using the strict ICU catalogue at runtime.
// Keep all supported merchant locales complete, and do not trust unknown codes.
describe("ARCH-040 merchant reply status catalogue", () => {
  const locales = [
    "cs", "da", "de", "en", "es", "fi", "fr", "it", "ja", "ko",
    "nb", "nl", "pl", "pt-BR", "pt-PT", "sv", "th", "tr", "zh-Hans", "zh-Hant",
  ];

  it.each(locales)("defines the pending status in %s", (locale) => {
    const catalogue = JSON.parse(readFileSync(
      new URL(`../../app/i18n/locales/${locale}.json`, import.meta.url), "utf8",
    )) as Record<string, string>;
    expect(catalogue["recoveryDetail.sendStatus.PENDING"]?.trim()).toBeTruthy();
  });

  it("shows provider PENDING without accessing a missing ICU key", () => {
    const html = render({ deliveryState: "DISPATCH_ADMITTED", moderation: "ALLOW", providerStatus: "PENDING" });
    expect(html).toContain("recoveryDetail.sendStatus.PENDING");
    expect(html).toContain("recoveryDetail.queuedNotSent");
  });

  it("does not obscure command UNKNOWN with a stale provider PENDING", () => {
    const html = render({ deliveryState: "UNKNOWN", moderation: "ALLOW", providerStatus: "PENDING" });
    expect(html).toContain("recoveryDetail.sendStatus.UNKNOWN");
    expect(html).not.toContain("recoveryDetail.sendStatus.PENDING");
    expect(html).not.toContain("recoveryDetail.sendFailed");
  });

  it("uses a safe catalogue key for unknown provider states", () => {
    const html = render({ deliveryState: "DISPATCH_ADMITTED", moderation: "ALLOW", providerStatus: "NEW_UNEXPECTED_STATE" });
    expect(html).toContain("recoveryDetail.sendStatus.UNKNOWN");
    expect(html).not.toContain("recoveryDetail.sendStatus.NEW_UNEXPECTED_STATE");
  });

  it.each(locales)("already localises Delivery not confirmed in %s", (locale) => {
    const catalogue = JSON.parse(readFileSync(
      new URL(`../../app/i18n/locales/${locale}.json`, import.meta.url), "utf8",
    )) as Record<string, string>;
    expect(catalogue["recoveryDetail.sendStatus.UNKNOWN"]?.trim()).toBeTruthy();
  });
});

describe("ARCH-040 historical HUMAN message delivery evidence", () => {
  const i18n = createMerchantI18n({ locale: "en", fallbackLocale: "en", timeZone: "Europe/London" });
  const date = new Date("2026-10-19T10:25:00.000Z");
  const row: RecoveryMessageRow = {
    id: "message-1", createdAt: date, direction: "OUTBOUND", senderType: "HUMAN",
    status: "PENDING", humanCommandState: "UNKNOWN", contentType: "TEXT", content: "Merchant reply",
    transcriptionStatus: "NOT_REQUIRED", sentAt: null, deliveredAt: null, readAt: null,
  };
  const show = (message: RecoveryMessageRow) => renderToStaticMarkup(createElement(RecoveryMessageList, {
    items: [recoveryMessageDto(message)], i18n, t: i18n.t, stamp: (value: string) => createElement("time", {}, value),
  }));

  it("shows Delivery not confirmed rather than Pending for a linked UNKNOWN command", () => {
    const html = show(row);
    expect(html).toContain("Delivery not confirmed");
    expect(html).not.toContain(">Pending</span>");
    expect(html).toContain("Merchant reply");
  });

  it("preserves a later confirmed provider receipt even when the old command is UNKNOWN", () => {
    const html = show({ ...row, status: "DELIVERED", deliveredAt: date });
    expect(html).toContain("Delivered");
    expect(html).not.toContain("Delivery not confirmed");
  });

  it("keeps FAILED and CANCELLED pre-dispatch merchant attempts visible in the transcript", () => {
    const failed = show({ ...row, id: "command-only", commandOnly: true, status: null,
      commandKind: "HUMAN_TEXT", humanCommandState: "FAILED", content: "New attempt not sent" });
    expect(failed).toContain("New attempt not sent");
    expect(failed).toContain("Failed");
    expect(failed).not.toContain("Delivered");
    const cancelled = show({ ...row, commandOnly: true, status: null, humanCommandState: "CANCELLED" });
    expect(cancelled).toContain("Not sent");
  });

  it("shows the approved template name, not an invented template message body", () => {
    const html = show({ ...row, commandOnly: true, status: null,
      content: null, contentType: "UNSUPPORTED", commandKind: "RECOVERY_FOLLOW_UP_TEMPLATE",
      templateName: "recovery_reminder", humanCommandState: "UNKNOWN" });
    expect(html).toContain("Approved recovery follow-up");
    expect(html).toContain("recovery_reminder");
    expect(html).toContain("Delivery not confirmed");
  });

  it.each(["SENT", "DELIVERED", "READ", "FAILED", "CANCELLED", "UNKNOWN"])(
    "stops automatic status polling after terminal %s", (state) => {
      expect(isTerminalMerchantCommandState(state)).toBe(true);
    },
  );
  it.each(["ACCEPTED", "CLAIMED", "DISPATCH_ADMITTED", "PENDING", null])(
    "allows in-flight status polling for %s", (state) => {
      expect(isTerminalMerchantCommandState(state)).toBe(false);
    },
  );
});

import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DisabledMerchantComposer, RecoveryActionFeedback, recoveryActionMessageKey,
} from "../../app/routes/app/recovery-detail/recovery-message-guidance";
import type { Translate } from "../../app/routes/app/recovery-detail/recovery-ui-types";
import { MerchantReplyComposer } from "../../app/routes/app/recovery-detail/merchant-reply-composer";
import { ConversationControlBar, takeOverUnavailableReasonKey } from "../../app/routes/app/recovery-detail/conversation-control-bar";
import type { Detail } from "../../app/routes/app/recovery-detail/state";

const en = JSON.parse(readFileSync("app/i18n/locales/en.json", "utf8")) as Record<string, string>;
const t = ((key: string) => en[key] ?? key) as Translate;

describe("ARCH-040 merchant-friendly takeover/send explanations", () => {
  it("classifies the actionable control failures without exposing raw server details", () => {
    expect(recoveryActionMessageKey("control", "human_messaging_unavailable"))
      .toBe("recoveryDetail.controlEntitlementUnavailable");
    expect(recoveryActionMessageKey("control", "human_messaging_suspended"))
      .toBe("recoveryDetail.humanSuspended");
    expect(recoveryActionMessageKey("control", "forbidden"))
      .toBe("recoveryDetail.controlNotAuthorised");
    expect(recoveryActionMessageKey("control", "stale_control_revision"))
      .toBe("recoveryDetail.staleRevision");
    expect(recoveryActionMessageKey("control", "unexpected-secret=unsafe"))
      .toBe("recoveryDetail.controlFailed");
  });

  it("classifies send restrictions without displaying provider/recipient payloads", () => {
    expect(recoveryActionMessageKey("send", "recipient_unavailable"))
      .toBe("recoveryDetail.recipientUnavailable");
    expect(recoveryActionMessageKey("send", "service_window_closed"))
      .toBe("recoveryDetail.windowClosedHelp");
    expect(recoveryActionMessageKey("send", "template_not_allowed"))
      .toBe("recoveryDetail.templateRejected");
    expect(recoveryActionMessageKey("send", "not_human_controlled"))
      .toBe("recoveryDetail.sendNotHumanControlled");
    const html = renderToStaticMarkup(createElement(RecoveryActionFeedback, {
      action: "send", code: "error contains token:abc", t,
    }));
    expect(html).toContain("Message was not sent");
    expect(html).not.toContain("token:abc");
  });

  it("keeps the unavailable composer visible but non-interactive", () => {
    const html = renderToStaticMarkup(createElement(DisabledMerchantComposer, {
      reasonKey: "recoveryDetail.windowClosedHelp", t,
    }));
    expect(html).toContain('id="human-reply-disabled"');
    expect(html).toMatch(/<textarea[^>]*disabled/);
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toContain("24 hours");
    expect(html).not.toContain('id="human-reply"');
  });

  it("shows a disabled HUMAN composer for an expired window with no follow-up", () => {
    const conversation = {
      id: "test-conversation", controlMode: "HUMAN", controlRevision: 1,
      lastInboundAt: "2026-10-15T00:00:00.000Z", windowExpiresAt: "2026-10-16T00:00:00.000Z",
      humanMessagingStatus: "ACTIVE", latestCommand: null,
      followUp: { used: false, initiatedBy: null, eligible: false, hasApprovedTemplate: false },
    } as NonNullable<Detail["conversation"]>;
    const html = renderToStaticMarkup(createElement(MerchantReplyComposer, {
      conversation, terminal: false, suspended: false, open: false,
      templates: [], body: "", variant: "", busy: false,
      onBodyChange: () => {}, onVariantChange: () => {}, onReply: () => {}, t,
    }));
    expect(html).toContain('id="human-reply-disabled"');
    expect(html).toContain("24 hours");
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).not.toContain('id="human-reply"');
  });

  it("uses the recovery status as the specific takeover reason, before shop suspension", () => {
    expect(takeOverUnavailableReasonKey("COMPLETED", false)).toBe("recoveryDetail.takeOverCompleted");
    expect(takeOverUnavailableReasonKey("EXPIRED", false)).toBe("recoveryDetail.takeOverExpired");
    expect(takeOverUnavailableReasonKey("CANCELLED", true)).toBe("recoveryDetail.takeOverCancelled");
    expect(takeOverUnavailableReasonKey("ENGAGED", true)).toBe("recoveryDetail.takeOverSuspended");
    expect(takeOverUnavailableReasonKey("ENGAGED", false)).toBeNull();
  });

  it("explains a temporarily disabled takeover while control is updating", () => {
    const html = renderToStaticMarkup(createElement(ConversationControlBar, {
      mode: "AI", terminal: false, suspended: false, busy: true, onChange: () => {}, t,
    }));
    expect(html).toMatch(/<button[^>]*disabled[^>]*aria-describedby="recovery-control-updating"/);
    expect(html).toContain("Updating conversation control. Please wait.");
    expect(html).toContain('id="recovery-control-updating"');
  });

  it("provides the guidance strings for all supported merchant locales", () => {
    const keys = ["windowClosedHelp", "replyDisabledPlaceholder", "controlEntitlementUnavailable",
      "controlAlreadySelected", "controlNotAuthorised", "controlTemporarilyUnavailable",
      "recipientUnavailable", "templateRejected", "sendNotHumanControlled",
      "takeOverUnavailable", "takeOverCompleted", "takeOverExpired", "takeOverCancelled",
      "takeOverSuspended", "takeOverNoConversation", "controlUpdating"];
    const locales = ["en", "cs", "da", "de", "es", "fi", "fr", "it", "ja", "ko", "nb", "nl",
      "pl", "pt-BR", "pt-PT", "sv", "th", "tr", "zh-Hans", "zh-Hant"];
    for (const locale of locales) {
      const catalog = JSON.parse(readFileSync(`app/i18n/locales/${locale}.json`, "utf8")) as Record<string, unknown>;
      for (const key of keys) {
        expect(typeof catalog[`recoveryDetail.${key}`]).toBe("string");
        expect((catalog[`recoveryDetail.${key}`] as string).length).toBeGreaterThan(0);
      }
    }
  });
});

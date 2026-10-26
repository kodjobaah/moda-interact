// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import RecoveryDetail from "../../app/routes/app/recovery-detail/RecoveryDetail";
import { customerHeading } from "../../app/routes/app/recovery-detail/recovery-summary-header";
import { followUpDisplayState } from "../../app/routes/app/recovery-detail/recovery-outreach-status";
import type { DetailData } from "../../app/routes/app/recovery-detail/state";
import { projectRecoveryBasket } from "../../app/services/recoveries/recovery-basket";

type Detail = NonNullable<DetailData["detail"]>;
const recordedMessage = "RECORDED CUSTOMER MESSAGE — DO NOT REPLACE";
const now = "2026-10-19T00:00:00.000Z";

const base: Detail = {
  id: "owned-recovery",
  status: "ENGAGED",
  value: { amount: "124.99", currency: "GBP", incomplete: false },
  customer: { firstName: "Sarah", lastName: "Jones", email: "sarah@example.invalid" },
  hasConversation: true,
  initialOutreachSentAt: now,
  basket: projectRecoveryBasket([
    { title: "Product A", variantTitle: "Blue / Large", quantity: 2, price: "29.99" },
    { title: "Product B", variantTitle: "Black", quantity: 1, price: "65.01" },
  ], "GBP", "124.99"),
  milestones: { detectedAt: now, messageSentAt: now, engagedAt: now, completedAt: null, expiredAt: null },
  conversation: {
    id: "owned-conversation", controlMode: "AI", controlRevision: 1, languageTag: "en",
    lastInboundAt: now, windowExpiresAt: "2099-10-19T00:00:00.000Z",
    followUp: { used: false, initiatedBy: null, eligible: true, hasApprovedTemplate: true },
    humanMessagingStatus: "ACTIVE", latestCommand: null,
  },
};

function view(patch: Partial<Detail> = {}, templates = [{ id: "approved", name: "Recovery reminder", language: "en" }]) {
  const detail = { ...base, ...patch } as Detail;
  const data: DetailData = {
    state: "ready", detail, templates,
    merchantUi: { locale: "en-GB", fallbackLocale: "en", timeZone: "Europe/London" },
    filters: { from: "2026-10-01", to: "2026-10-31", q: "", status: "all", pageSize: 25, cursor: null },
    embed: { shop: "shop-a" },
    messages: { state: "ready", page: { items: [{
      id: "saved-message", createdAt: now, direction: "INBOUND", sender: "CUSTOMER", moderation: null,
      content: { type: "TEXT", text: recordedMessage, transcriptionStatus: null }, delivery: null,
    }], previousCursor: null, nextCursor: null } },
    related: { state: "ready", page: { items: [], previousCursor: null, nextCursor: null } },
  };
  const router = createMemoryRouter([{ path: "/", element: createElement(RecoveryDetail, { data, onRefresh: () => {} }) }]);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    // Exercise the interactive router in a DOM rather than server-rendering client-only effects.
    flushSync(() => root.render(createElement(RouterProvider, { router })));
    return host.innerHTML;
  } finally {
    flushSync(() => root.unmount());
    router.dispose();
  }
}

describe("ARCH-040 Shopify canonical Recovery Detail wireframes", () => {
  it("keeps the basket before Recovery Context, with recorded line items and collapsible sections", () => {
    const html = view();
    expect(html).toContain("Product A");
    expect(html).toContain("Blue / Large");
    expect(html).toContain("Product B");
    expect(html).toContain("£124.99");
    expect(html).toMatch(/<details[^>]*recovery-detail__basket[^>]*open/);
    expect(html.indexOf("Checkout basket")).toBeLessThan(html.indexOf("Checkout context"));
    expect(html.indexOf("Checkout context")).toBeLessThan(html.indexOf("Related recoveries"));
    expect(html).toContain("Recovery activity");
    expect(html).toContain("Initial outreach");
    expect(html).toContain("Follow-up");
    expect(html).toContain("One follow-up may be available when permitted");
  });

  it("puts a HUMAN open-window reply composer after transcript and pagination", () => {
    const html = view({ conversation: { ...base.conversation!, controlMode: "HUMAN" } });
    expect(html).toContain("Resume AI");
    const message = html.indexOf(recordedMessage);
    const paging = html.indexOf("Jump to latest");
    const composer = html.indexOf('id="human-reply"');
    expect(message).toBeGreaterThan(0);
    expect(paging).toBeGreaterThan(0);
    expect(composer).toBeGreaterThan(paging);
    expect(composer).toBeGreaterThan(message);
    expect(html).toContain("Queue reply");
  });

  it("puts the closed-window approved follow-up below transcript with an explicit conditional credit notice", () => {
    const html = view({ conversation: { ...base.conversation!, controlMode: "HUMAN", windowExpiresAt: "2000-10-19T00:00:00.000Z" } });
    expect(html.indexOf('id="recovery-follow-up-template"')).toBeGreaterThan(html.indexOf(recordedMessage));
    expect(html).toContain("One remaining follow-up");
    expect(html).toContain("Queue follow-up");
    expect(html).not.toContain('id="human-reply"');
  });

  it("distinguishes already-used from unavailable follow-up without offering another send", () => {
    const closed = { ...base.conversation!, controlMode: "HUMAN" as const, windowExpiresAt: "2000-10-19T00:00:00.000Z" };
    const used = view({ conversation: { ...closed, followUp: { ...closed.followUp, used: true, eligible: false } } });
    expect(used).toContain("Follow-up already used");
    expect(used).not.toContain('id="recovery-follow-up-template"');
    const unavailable = view({ conversation: { ...closed, followUp: { ...closed.followUp, eligible: false } } });
    expect(unavailable).toContain("No follow-up available");
    expect(unavailable).not.toContain("Queue follow-up");
  });

  it("does not invite a completed recovery to take over or render any composer", () => {
    const html = view({ status: "COMPLETED" });
    expect(html).toContain("Take over unavailable");
    expect(html).toContain("This checkout was completed");
    expect(html).toContain("You can review past messages");
    expect(html).toMatch(/<button[^>]*disabled[^>]*aria-describedby="recovery-takeover-unavailable"[^>]*>Take over<\/button>/);
    expect(html).toContain('id="recovery-takeover-unavailable"');
    expect(html).not.toContain("Take over the conversation to send a merchant reply.");
    expect(html).not.toContain("A queued reply is not a confirmed WhatsApp send.");
    expect(html).not.toContain("Customer reply window closed");
    expect(html).not.toContain("<textarea");
    expect(html).toContain(recordedMessage);
    expect(html).toContain("Checkout basket");
  });

  it("distinguishes completed, expired and cancelled takeover restrictions", () => {
    for (const [status, description] of [
      ["COMPLETED", "This checkout was completed"],
      ["EXPIRED", "This recovery has expired"],
      ["CANCELLED", "This recovery was cancelled"],
    ] as const) {
      const html = view({ status });
      expect(html).toContain(description);
      expect(html).toContain("Take over unavailable");
      expect(html).toContain('id="recovery-takeover-unavailable"');
      expect(html).toMatch(/<button[^>]*disabled[^>]*>Take over<\/button>/);
      expect(html).not.toContain('id="human-reply"');
    }
  });

  it("explains when messaging restrictions disable takeover", () => {
    const html = view({ conversation: { ...base.conversation!, humanMessagingStatus: "SUSPENDED" } });
    expect(html).toContain("Merchant messaging is suspended for this store");
    expect(html).toContain("Take over unavailable");
    expect(html).toMatch(/<button[^>]*disabled[^>]*aria-describedby="recovery-takeover-unavailable"[^>]*>Take over<\/button>/);
  });

  it("explains why an unlinked recovery has no takeover action", () => {
    const html = view({ conversation: null });
    expect(html).toContain("Take over unavailable");
    expect(html).toContain("no linked conversation");
    expect(html).not.toContain('>Take over</button>');
  });

  it("does not confuse a closed WhatsApp reply window with a takeover prohibition", () => {
    const html = view({ conversation: { ...base.conversation!, windowExpiresAt: "2000-10-19T00:00:00.000Z" } });
    expect(html).toMatch(/<button[^>]*>Take over<\/button>/);
    expect(html).not.toContain('id="recovery-takeover-unavailable"');
    expect(html).toContain("Customer reply window closed");
  });

  it("keeps suspension read-only and allows Resume AI when HUMAN already owns control", () => {
    const blocked = { ...base.conversation!, humanMessagingStatus: "SUSPENDED" as const };
    const ai = view({ conversation: blocked });
    expect(ai).toMatch(/<button[^>]*disabled[^>]*>Take over<\/button>/);
    expect(ai).not.toContain("Take over the conversation to send a merchant reply.");
    const human = view({ conversation: { ...blocked, controlMode: "HUMAN" } });
    expect(human).toContain("Resume AI");
    expect(human).toContain('id="human-reply-disabled"');
    expect(human).toContain("Human replies are currently disabled for this store.");
    expect(human).toMatch(/<button[^>]*disabled[^>]*>Queue reply<\/button>/);
  });

  it("does not fabricate a basket or a follow-up when persisted data is missing", () => {
    const html = view({
      initialOutreachSentAt: null,
      milestones: { ...base.milestones, messageSentAt: null },
      basket: projectRecoveryBasket(null, "GBP", "124.99"),
      conversation: null,
    });
    expect(html).toContain("The saved basket is unavailable.");
    expect(html).toContain("£124.99");
    expect(html).not.toContain("Product A");
    expect(html).toContain("No initial send recorded");
    expect(html).toContain("No follow-up available");
    expect(html).toContain(recordedMessage);
    expect(html).not.toContain("Queue reply");
  });

  it("never labels a used, terminal, suspended or unapproved follow-up available", () => {
    const cases: Detail[] = [
      { ...base, status: "COMPLETED" },
      { ...base, conversation: { ...base.conversation!, humanMessagingStatus: "SUSPENDED" } },
      { ...base, conversation: { ...base.conversation!, followUp: { ...base.conversation!.followUp, used: true } } },
      { ...base, conversation: { ...base.conversation!, followUp: { ...base.conversation!.followUp, hasApprovedTemplate: false } } },
    ];
    for (const detail of cases) expect(followUpDisplayState(detail)).not.toBe("eligible");
  });

  it("shows a clean customer name and places genuine shop domain in secondary metadata", () => {
    expect(customerHeading({ firstName: "Grace--demo-store.myshopify.com", lastName: "Hopper", email: "grace@example.invalid" }, "Guest"))
      .toEqual({ name: "Grace Hopper", shopDomain: "demo-store.myshopify.com" });
    const html = view({ customer: { firstName: "Grace--demo-store.myshopify.com", lastName: "Hopper", email: "grace@example.invalid" } });
    expect(html).toContain("<h1 dir=\"auto\">Grace Hopper</h1>");
    expect(html).toContain("demo-store.myshopify.com");
    expect(html).not.toContain("Grace--demo-store.myshopify.com");
  });

  it("renders a compact no-data basket and never repeats initial outreach in the activity timeline", () => {
    const html = view({ basket: projectRecoveryBasket(null, "GBP", "124.99") });
    expect(html).toContain("The saved basket is unavailable.");
    expect(html).toContain("£124.99");
    expect(html).not.toContain("Basket saved when this recovery was detected.");
    expect((html.match(/Initial outreach/g) ?? []).length).toBe(1);
    expect(html).toContain("Recovery activity");
  });

  it("keeps the timeline secondary, related history collapsible and the conversation the main panel", () => {
    const html = view();
    expect(html).toMatch(/recovery-detail__layout[\s\S]*?recovery-detail__conversation[\s\S]*?recovery-detail__sidebar/);
    expect(html).toContain("recovery-detail__timeline");
    expect(html).toContain("recovery-detail__related-card");
    expect(html).not.toContain("Target shop: Not selected");
  });

  it("does not expose a template selector without approved follow-up eligibility", () => {
    const html = view({ conversation: { ...base.conversation!, controlMode: "HUMAN",
      windowExpiresAt: "2000-01-01T00:00:00.000Z",
      followUp: { used: false, initiatedBy: null, eligible: true, hasApprovedTemplate: false } } });
    expect(html).toContain("No approved recovery follow-up template is available.");
    expect(html).not.toContain('id="recovery-follow-up-template"');
  });

  it("does not encourage takeover to reply when the window is closed and the follow-up is ineligible", () => {
    const html = view({ conversation: { ...base.conversation!, windowExpiresAt: "2000-01-01T00:00:00.000Z",
      followUp: { used: false, initiatedBy: null, eligible: false, hasApprovedTemplate: false } } });
    expect(html).toContain("Customer reply window closed");
    expect(html).toContain("No follow-up available");
    expect(html).not.toContain("Take over the conversation to send a merchant reply.");
    expect(html).not.toContain("<textarea");
  });

  it("provides the new wireframe labels in all 20 merchant locales", () => {
    const keys = [
      "recoveryDetail.activity", "recoveryDetail.outreachStatus", "recoveryDetail.initialOutreach", "recoveryDetail.initialNotRecorded",
      "recoveryDetail.followUpStatus", "recoveryDetail.followUpEligible", "recoveryDetail.followUpUnavailable",
      "recoveryDetail.followUpAlreadyUsed", "recoveryDetail.followUpCreditNotice",
    ];
    const locales = ["en", "cs", "da", "de", "es", "fi", "fr", "it", "ja", "ko", "nb", "nl", "pl", "pt-BR", "pt-PT", "sv", "th", "tr", "zh-Hans", "zh-Hant"];
    for (const locale of locales) {
      const catalog = JSON.parse(readFileSync(`app/i18n/locales/${locale}.json`, "utf8")) as Record<string, unknown>;
      for (const key of keys) expect(typeof catalog[key] === "string" && Boolean(catalog[key])).toBe(true);
    }
  });

  it("stacks basket/context above transcript at the observed 849px embedded width", () => {
    const layout = readFileSync("app/routes/app/recovery-detail/RecoveryDetail.css", "utf8");
    const sidebar = readFileSync("app/routes/app/recovery-detail/recovery-sidebar.css", "utf8");
    const conversation = readFileSync("app/routes/app/recovery-detail/recovery-conversation.css", "utf8");
    expect(849).toBeLessThan(960);
    expect(sidebar).toMatch(/@media\s*\(max-width:\s*960px\)[\s\S]*?recovery-detail__sidebar\s*\{\s*order:\s*-1/);
    expect(layout).toMatch(/@media\s*\(max-width:\s*960px\)[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(conversation).toContain("@media (max-width: 960px)");
  });
});

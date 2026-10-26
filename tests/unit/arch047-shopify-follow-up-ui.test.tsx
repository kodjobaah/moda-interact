import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MerchantReplyComposer } from "../../app/routes/app/recovery-detail/merchant-reply-composer";
import type { Detail } from "../../app/routes/app/recovery-detail/state";

const conversation = {
  id: "conversation-1", controlMode: "HUMAN" as const, controlRevision: 1,
  languageTag: "en", lastInboundAt: null, windowExpiresAt: "2000-01-01T00:00:00.000Z",
  followUp: { eligible: true, used: false, initiatedBy: null, hasApprovedTemplate: true },
  humanMessagingStatus: "ACTIVE" as const, latestCommand: null,
} satisfies NonNullable<Detail["conversation"]>;
const noOffer = { id: "variant-1", name: "Moda reminder", language: "en", purpose: "FOLLOW_UP_NO_OFFER" as const };
const codeOffer = { id: "variant-2", name: "Discount", language: "en", purpose: "FOLLOW_UP_CODE_OFFER" as const };

function render(input: {
  templates?: Array<typeof noOffer | typeof codeOffer>;
  variant?: string;
  eligible?: boolean;
  mode?: "AI" | "HUMAN";
  open?: boolean;
  used?: boolean;
} = {}) {
  const templates = input.templates ?? [noOffer];
  return renderToStaticMarkup(createElement(MerchantReplyComposer, {
    conversation: { ...conversation, controlMode: input.mode ?? "HUMAN",
      followUp: { ...conversation.followUp, eligible: input.eligible ?? true, used: input.used ?? false } },
    terminal: false, suspended: false, open: input.open ?? false,
    templates, variant: input.variant ?? "variant-1", body: "", busy: false,
    onBodyChange: vi.fn(), onVariantChange: vi.fn(), onReply: vi.fn(),
    t: ((key: string) => key === "recoverySettings.offer.NONE" ? "Do not offer a discount" : key) as never,
  }));
}

describe("ARCH-047 Shopify follow-up selector", () => {
  it("shows the published source language and honest no-offer purpose", () => {
    const html = render();
    expect(html).toContain("Moda reminder");
    expect(html).toContain("en · Do not offer a discount");
    expect(html).not.toContain("Discount</option>");
  });
  it("never exposes positive-offer candidates without provider evidence", () => {
    const html = render({ templates: [noOffer, codeOffer] });
    expect(html).not.toContain("Discount</option>");
    expect(render({ templates: [codeOffer], variant: "variant-2" })).not.toContain('id="recovery-follow-up-template"');
  });
  it("disables stale, forged or unselected template IDs", () => {
    expect(render({ variant: "foreign" })).toMatch(/<button[^>]*disabled[^>]*>recoveryDetail.sendTemplate<\/button>/);
    expect(render({ variant: "" })).toMatch(/<button[^>]*disabled[^>]*>recoveryDetail.sendTemplate<\/button>/);
  });
  it("preserves service-window, human-control and single-follow-up gates", () => {
    expect(render({ open: true })).not.toContain('id="recovery-follow-up-template"');
    expect(render({ eligible: false })).not.toContain('id="recovery-follow-up-template"');
    expect(render({ used: true })).not.toContain('id="recovery-follow-up-template"');
    expect(render({ mode: "AI" })).not.toContain('id="recovery-follow-up-template"');
  });
});

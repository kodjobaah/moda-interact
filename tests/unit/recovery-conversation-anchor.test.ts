import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { focusRecoveryConversationAnchor } from "../../app/routes/app/recovery-detail/recovery-conversation-thread";

const threadSource = readFileSync("app/routes/app/recovery-detail/recovery-conversation-thread.tsx", "utf8");

describe("recovery conversation anchor", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("focuses and scrolls to the transcript heading when the deep-link fragment is present", () => {
    const heading = { focus: vi.fn() };
    const section = {
      querySelector: vi.fn(() => heading),
      scrollIntoView: vi.fn(),
    };
    vi.stubGlobal("window", { location: { hash: "#recovery-conversation" } });
    vi.stubGlobal("document", { getElementById: vi.fn(() => section) });

    expect(focusRecoveryConversationAnchor()).toBe(true);
    expect(section.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(section.querySelector).toHaveBeenCalledWith("#transcript-heading");
    expect(heading.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("waits safely when the target has not mounted yet and ignores other fragments", () => {
    vi.stubGlobal("window", { location: { hash: "#other-section" } });
    vi.stubGlobal("document", { getElementById: vi.fn() });
    expect(focusRecoveryConversationAnchor()).toBe(false);

    vi.stubGlobal("window", { location: { hash: "#recovery-conversation" } });
    expect(focusRecoveryConversationAnchor()).toBe(false);
  });

  it("wires initial hash navigation to the stable transcript section and heading", () => {
    expect(threadSource).toContain('id="recovery-conversation"');
    expect(threadSource).toContain('id="transcript-heading" tabIndex={-1}');
    expect(threadSource).toContain("window.requestAnimationFrame(() => { focusRecoveryConversationAnchor(); })");
  });
});

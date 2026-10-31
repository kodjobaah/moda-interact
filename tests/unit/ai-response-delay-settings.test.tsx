import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import AiResponseDelaySettings from "@/routes/app/recovery-settings/AiResponseDelaySettings";

vi.mock("@/components/settings/SettingsForm", () => ({
  default: ({ children }: { children: React.ReactNode }) => <form>{children}</form>,
}));

describe("AI response delay settings control", () => {
  it("renders an associated, accessible integer control with its explanation", () => {
    const html = renderToStaticMarkup(
      <AiResponseDelaySettings
        revision="revision-1"
        value={7}
        t={(key) => key}
      />,
    );

    expect(html).toContain('aria-labelledby="ai-response-delay-heading"');
    expect(html).toContain('for="aiResponseDelayMinutes"');
    expect(html).toContain('id="aiResponseDelayMinutes"');
    expect(html).toContain('name="aiResponseDelayMinutes"');
    expect(html).toContain('type="number"');
    expect(html).toContain('min="0"');
    expect(html).toContain('max="30"');
    expect(html).toContain('step="1"');
    expect(html).toContain('value="7"');
    expect(html).toContain('aria-describedby="ai-response-delay-help"');
    expect(html).toContain("recoverySettings.aiResponseDelay.help");
  });
});

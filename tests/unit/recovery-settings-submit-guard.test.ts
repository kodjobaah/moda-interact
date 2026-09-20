import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(
  new URL("../../app/routes/app/recovery-settings/route.tsx", import.meta.url),
  "utf8",
);

const cssSource = readFileSync(
  new URL("../../app/routes/app/recovery-settings/RecoverySettingsRoute.css", import.meta.url),
  "utf8",
);

describe("recovery settings submit protection", () => {
  it("guards the form immediately and disables the save button while navigation is busy", () => {
    expect(routeSource).toContain("const submitGuardRef = useRef(false)");
    expect(routeSource).toContain("onSubmitCapture={handleSubmitCapture}");
    expect(routeSource).toContain("if (submitGuardRef.current)");
    expect(routeSource).toContain('const isSaving = navigation.state !== "idle"');
    expect(routeSource).toContain("disabled={isSaving}");
    expect(routeSource).toContain("aria-busy={isSaving}");
  });

  it("restores the immediate guard after navigation returns to idle", () => {
    expect(routeSource).toContain('if (navigation.state === "idle")');
    expect(routeSource).toContain("submitGuardRef.current = false");
  });

  it("visually distinguishes the disabled save state", () => {
    expect(cssSource).toContain(".moda-recovery-save-button:disabled");
    expect(cssSource).toContain("cursor: wait");
  });
});

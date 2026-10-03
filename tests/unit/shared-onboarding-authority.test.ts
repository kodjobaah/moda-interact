import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

describe("Shop onboarding authority", () => {
  it("does not read the compatibility milestone from ShopSettings in production app code", () => {
    const legacyRead = /settings\s*(?:\?\.)?\.\s*onboardingCompleted|settings\s*:\s*\{\s*select\s*:\s*\{\s*onboardingCompleted/s;

    for (const file of sourceFiles(join(process.cwd(), "app"))) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(legacyRead);
    }
  });
});
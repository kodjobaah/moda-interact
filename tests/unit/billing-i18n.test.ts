import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const localeDirectory = new URL("../../app/i18n/locales/", import.meta.url);

describe("ARCH-007 billing translations", () => {
  it("defines every billing key in every locale catalogue", async () => {
    const localeFiles = (await readdir(localeDirectory)).filter((file) => file.endsWith(".json"));
    const english = JSON.parse(await readFile(new URL("en.json", localeDirectory), "utf8"));
    const billingKeys = Object.keys(english).filter((key) => key.startsWith("billing."));

    expect(billingKeys.length).toBeGreaterThan(0);

    for (const localeFile of localeFiles) {
      const locale = JSON.parse(await readFile(new URL(localeFile, localeDirectory), "utf8"));
      expect(Object.keys(locale).filter((key) => key.startsWith("billing."))).toEqual(
        expect.arrayContaining(billingKeys),
      );
    }
  });
});
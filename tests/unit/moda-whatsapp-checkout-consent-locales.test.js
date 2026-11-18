import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const localeDirectory = resolve(
  fileURLToPath(new URL("../../extensions", import.meta.url)),
  "moda-whatsapp-checkout-consent/locales",
);
const expectedLocales = [
  "cs.json",
  "da.json",
  "de.json",
  "en.default.json",
  "es.json",
  "fi.json",
  "fr.json",
  "it.json",
  "ja.json",
  "ko.json",
  "nb.json",
  "nl.json",
  "pl.json",
  "pt-BR.json",
  "pt-PT.json",
  "sv.json",
  "th.json",
  "tr.json",
  "zh-CN.json",
  "zh-TW.json",
];

describe("Plus checkout consent translations", () => {
  it("provides the consent wording in exactly the 20 supported Shopify locales", () => {
    expect(readdirSync(localeDirectory).sort()).toEqual(expectedLocales);
    for (const filename of expectedLocales) {
      const messages = JSON.parse(
        readFileSync(resolve(localeDirectory, filename), "utf8"),
      );
      expect(Object.keys(messages)).toEqual(["consentDisclosure"]);
      expect(typeof messages.consentDisclosure).toBe("string");
      expect(messages.consentDisclosure.trim().length).toBeGreaterThan(0);
    }
  });

  it("keeps the approved English disclosure verbatim", () => {
    const english = JSON.parse(
      readFileSync(resolve(localeDirectory, "en.default.json"), "utf8"),
    );
    expect(english.consentDisclosure).toBe(
      "Send me WhatsApp shopping updates, reminders and offers.",
    );
  });
});

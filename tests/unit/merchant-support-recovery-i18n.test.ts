import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const locales = [
  "en", "cs", "da", "de", "es", "fi", "fr", "it", "ja", "ko",
  "nb", "nl", "pl", "pt-BR", "pt-PT", "sv", "th", "tr", "zh-Hans", "zh-Hant",
];

describe("merchant recovery Support action localization", () => {
  it.each(locales)("defines the View conversation action in %s", (locale) => {
    const catalogue = JSON.parse(readFileSync(`app/i18n/locales/${locale}.json`, "utf8")) as Record<string, unknown>;
    expect(catalogue["support.viewRecoveryConversation"]).toEqual(expect.any(String));
    expect((catalogue["support.viewRecoveryConversation"] as string).trim().length).toBeGreaterThan(0);
  });
});
